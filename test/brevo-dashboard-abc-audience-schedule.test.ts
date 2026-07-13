/**
 * test/brevo-dashboard-abc-audience-schedule.test.ts (#2976, #2989)
 *
 * Regressão (#633) para:
 *  - #2976: Resumo A/B/C por Audiência (Agregada/Fria/Quente) — classificação
 *    fria/quente, agregação de métricas (CTOR, click rate, unsub rate, etc.),
 *    z-test de significância e render das 3 tabelas.
 *  - #2989: recomendação dos 3 melhores dias da semana por open rate na aba
 *    Agendamento (reusando `aggregateByWeekday` já existente).
 *
 * Todas as funções testadas são puras, exportadas de
 * workers/brevo-dashboard/src/index.ts (re-export de sections-core.ts /
 * weekly-plan.ts).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyClariceAudience,
  parseAbcAudienceCampaign,
  twoProportionZTest,
  aggregateAbcByAudience,
  renderAbcAudienceSection,
  renderAbcAudienceTable,
  pickTopWeekdays,
  aggregateByWeekday,
  renderTopWeekdaysSection,
  type WeekdaySummary,
  type AbcAudienceTable,
} from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeGlobalStats(overrides: Partial<{
  sent: number; delivered: number; hardBounces: number; softBounces: number;
  uniqueViews: number; viewed: number; trackableViews: number;
  uniqueClicks: number; clickers: number; unsubscriptions: number;
  complaints: number; appleMppOpens: number;
}> = {}) {
  return {
    sent: 100, delivered: 98, hardBounces: 1, softBounces: 1,
    uniqueViews: 25, viewed: 30, trackableViews: 18,
    uniqueClicks: 3, clickers: 3, unsubscriptions: 0, complaints: 0,
    appleMppOpens: 5,
    ...overrides,
  };
}

function makeCampaign(id: number, name: string, sentDate: string, gsOverrides: Parameters<typeof makeGlobalStats>[0] = {}) {
  return {
    id,
    name,
    subject: "Test",
    status: "sent",
    sentDate,
    scheduledAt: sentDate,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    listName: `List ${id}`,
    listSize: 100,
    statistics: {
      globalStats: makeGlobalStats(gsOverrides),
    },
  };
}

// ─── classifyClariceAudience / parseAbcAudienceCampaign (#2976) ──────────────

describe("classifyClariceAudience", () => {
  test("naming 'cold ...' → fria", () => {
    assert.equal(classifyClariceAudience("cold 2606-07 — A: subject"), "cold");
  });

  test("naming 'Clarice News ...' → quente", () => {
    assert.equal(classifyClariceAudience("Clarice News 2606-07 — A: subject"), "warm");
    assert.equal(classifyClariceAudience("Clarice News 2605 d02-B (qui)"), "warm");
  });

  test("naming desconhecido → null", () => {
    assert.equal(classifyClariceAudience("T1-W1 digest"), null);
  });

  // #3376: "Diar.ia Mensal {AAMM} — {timestamp}" passou a ser reconhecido
  // (era o exemplo canônico de "desconhecido" acima, antes do fix).
  test("#3376: naming do Digest Mensal 'Diar.ia Mensal AAMM — timestamp' → quente", () => {
    assert.equal(classifyClariceAudience("Diar.ia Mensal 2604 — 2026-05-14 19:26"), "warm");
  });
});

describe("parseAbcAudienceCampaign", () => {
  test("célula fria explícita", () => {
    const parsed = parseAbcAudienceCampaign("cold 2606-07 — B: subject B");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "B", audience: "cold" });
  });

  test("célula quente mensal explícita", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — C: subject C");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "C", audience: "warm" });
  });

  test("envio único sem célula → null (não participa do A/B/C)", () => {
    assert.equal(parseAbcAudienceCampaign("Clarice News 2605 d08 (qua)"), null);
  });

  test("naming não reconhecido → null", () => {
    assert.equal(parseAbcAudienceCampaign("Newsletter aleatória"), null);
  });

  // #3128: regressão — confirmado via GET /v3/emailCampaigns real (READ-ONLY,
  // nenhum envio disparado) contra a Brevo pro ciclo 2606-07. Achado: o editor
  // reenviou pra listas FRIAS reusando o MESMO padrão de nome de campanha
  // quente ("Clarice News 2606-07 — B · dom", sem prefixo "cold"); só o nome
  // da LISTA de destinatários ("cold 2606-07 dom-B") denuncia a audiência
  // fria. Nomes reais coletados (campaign id → nome / lista):
  //   id 76 (warm, 03/07): "Clarice News 2606-07 — B: Notícias do mês..." → lista "Clarice News 2606-07 B (A/B/C assunto)"
  //   id 82 (cold, 05/07): "Clarice News 2606-07 — B · dom"               → lista "cold 2606-07 dom-B"
  //   id 87 (cold, 07/07): "Clarice News 2606-07 — B · ter"               → lista "2606-07 cold d1"
  // Antes do fix, os 3 batiam o regex WARM de parseClariceCampaignKey e
  // SEMPRE voltavam audience:"warm" (sintoma do bug: tabela "Fria" vazia,
  // "Quente" == "Agregada", já que TODOS os envios eram contados como quente).
  test("#3128: nome de campanha warm-looking + lista 'cold ...' → classificado como fria (root cause confirmado via API real)", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — B · dom", "cold 2606-07 dom-B");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "B", audience: "cold" });
  });

  test("#3128: variante de nome de lista 'AAMM-MM cold dN' (cold no meio/fim) também é reconhecida", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — B · ter", "2606-07 cold d1");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "B", audience: "cold" });
  });

  test("#3128: mesmo nome de campanha, lista SEM 'cold' → continua quente (não-regressão do envio original 03/07)", () => {
    const parsed = parseAbcAudienceCampaign(
      "Clarice News 2606-07 — B: Notícias do mês sobre IA: O mês em que o…",
      "Clarice News 2606-07 B (A/B/C assunto)",
    );
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "B", audience: "warm" });
  });

  test("#3128: sem listName (chamador legado) → cai pro comportamento naming-only de antes (retrocompatível)", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — B · dom");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "B", audience: "warm" });
  });
});

// ─── twoProportionZTest (#2976) ───────────────────────────────────────────────

describe("twoProportionZTest", () => {
  test("proporções idênticas → z=0, p=1 (não significativo)", () => {
    const r = twoProportionZTest(50, 1000, 50, 1000);
    assert.equal(r.z, 0);
    assert.ok(Math.abs(r.pValue - 1) < 1e-6);
  });

  test("diferença grande + amostra grande → p < 0.05 (significativo)", () => {
    // 10% vs 4% click rate em 2000 delivered cada — diferença robusta.
    const r = twoProportionZTest(200, 2000, 80, 2000);
    assert.ok(r.pValue < 0.05, `esperado p<0.05, obtido ${r.pValue}`);
  });

  test("diferença pequena + amostra pequena → p >= 0.05 (não significativo)", () => {
    const r = twoProportionZTest(3, 100, 2, 100);
    assert.ok(r.pValue >= 0.05, `esperado p>=0.05, obtido ${r.pValue}`);
  });

  test("n1 ou n2 = 0 → indeterminado (p=1)", () => {
    assert.equal(twoProportionZTest(0, 0, 5, 100).pValue, 1);
  });
});

// ─── aggregateAbcByAudience (#2976) ───────────────────────────────────────────

describe("aggregateAbcByAudience", () => {
  const cycle = "2606-07";
  // Fria: A abre mais (abertura maior) mas B clica mais (o "fundo do poço" real).
  const cold = [
    makeCampaign(1, "cold 2606-07 — A: subject A", "2026-07-05T09:00:00Z", {
      sent: 2000, delivered: 1980, uniqueViews: 300, uniqueClicks: 20,
    }),
    makeCampaign(2, "cold 2606-07 — B: subject B", "2026-07-05T09:01:00Z", {
      sent: 2000, delivered: 1980, uniqueViews: 250, uniqueClicks: 60,
    }),
    makeCampaign(3, "cold 2606-07 — C: subject C", "2026-07-05T09:02:00Z", {
      sent: 2000, delivered: 1980, uniqueViews: 200, uniqueClicks: 15,
    }),
  ];
  // Quente: A lidera abertura E clique.
  const warm = [
    makeCampaign(4, "Clarice News 2606-07 — A: subject A", "2026-07-03T06:00:00Z", {
      sent: 1500, delivered: 1490, uniqueViews: 900, uniqueClicks: 150,
    }),
    makeCampaign(5, "Clarice News 2606-07 — B: subject B", "2026-07-03T06:01:00Z", {
      sent: 1500, delivered: 1490, uniqueViews: 850, uniqueClicks: 100,
    }),
    makeCampaign(6, "Clarice News 2606-07 — C: subject C", "2026-07-03T06:02:00Z", {
      sent: 1500, delivered: 1490, uniqueViews: 800, uniqueClicks: 90,
    }),
  ];

  test("separa fria/quente corretamente e agrega os totais na Agregada", () => {
    const result = aggregateAbcByAudience([...cold, ...warm], cycle);
    const coldA = result.cold.cells.find((c) => c.cell === "A")!;
    assert.equal(coldA.delivered, 1980);
    assert.equal(coldA.clicks, 20);

    const warmA = result.warm.cells.find((c) => c.cell === "A")!;
    assert.equal(warmA.delivered, 1490);
    assert.equal(warmA.clicks, 150);

    const aggA = result.aggregate.cells.find((c) => c.cell === "A")!;
    assert.equal(aggA.delivered, 1980 + 1490);
    assert.equal(aggA.clicks, 20 + 150);
  });

  test("fria: LÍDER de abertura é A, mas LÍDER de clique é B (diverge — o ponto central do #2976)", () => {
    const result = aggregateAbcByAudience([...cold, ...warm], cycle);
    assert.equal(result.cold.leaderOpenRate, "A");
    assert.equal(result.cold.leaderClickRate, "B");
  });

  test("CTOR e click rate calculados corretamente (fria, célula B)", () => {
    const result = aggregateAbcByAudience([...cold, ...warm], cycle);
    const coldB = result.cold.cells.find((c) => c.cell === "B")!;
    assert.ok(Math.abs(coldB.ctor - (60 / 250) * 100) < 0.01);
    assert.ok(Math.abs(coldB.clickRate - (60 / 1980) * 100) < 0.01);
  });

  test("quente: A lidera abertura e clique, com pValue calculado", () => {
    const result = aggregateAbcByAudience([...cold, ...warm], cycle);
    assert.equal(result.warm.leaderOpenRate, "A");
    assert.equal(result.warm.leaderClickRate, "A");
    assert.equal(typeof result.warm.pValue, "number");
  });

  test("ciclo sem campanhas → todas as tabelas vazias (campaignCount 0)", () => {
    const result = aggregateAbcByAudience([...cold, ...warm], "9999-99");
    assert.ok(result.aggregate.cells.every((c) => c.campaignCount === 0));
    assert.ok(result.cold.cells.every((c) => c.campaignCount === 0));
    assert.ok(result.warm.cells.every((c) => c.campaignCount === 0));
  });

  test("renderAbcAudienceSection: vazio → string vazia", () => {
    const empty = aggregateAbcByAudience([], "9999-99");
    assert.equal(renderAbcAudienceSection("9999-99", empty), "");
  });

  test("renderAbcAudienceSection: renderiza as 3 tabelas com CTOR/click rate/unsub e tags de LÍDER", () => {
    const result = aggregateAbcByAudience([...cold, ...warm], cycle);
    const html = renderAbcAudienceSection(cycle, result);
    assert.match(html, /Resumo A\/B\/C por Audiência/);
    assert.match(html, /Agregada \(Fria \+ Quente\)/);
    assert.match(html, /Fria \(nunca recebeu\)/);
    assert.match(html, /Quente \(já engajada\)/);
    assert.match(html, />CTOR</);
    assert.match(html, />Click rate</);
    assert.match(html, /▲ ABERTURA/);
    assert.match(html, /▲ CLIQUE/);
  });

  // #3398: uniqueClicks inclui clique em unsubscribe — não deveria decidir o
  // vencedor do teste A/B/C por Audiência.
  test("#3398: exclui clique em unsubscribe do clickRate/leaderClickRate da célula", () => {
    const coldWithUnsub = [
      ...cold.slice(0, 2), // A, B intactas
      {
        ...cold[2], // C: uniqueClicks=15, mas 12 são unsubscribe → 3 editoriais
        statistics: {
          globalStats: cold[2].statistics.globalStats,
          linksStats: { "https://diar.ia.br/artigo": 3, "https://x.brevo.com/unsubscribe/abc": 12 },
        },
      },
    ];
    const result = aggregateAbcByAudience([...coldWithUnsub, ...warm], cycle);
    const coldC = result.cold.cells.find((c) => c.cell === "C")!;
    assert.equal(coldC.clicks, 3, "15 uniqueClicks - 12 clicks em unsubscribe = 3 editoriais");
  });
});

// ─── aggregateAbcByAudience: naming ambíguo (mesmo padrão pra fria E quente) — #3128 ──

describe("aggregateAbcByAudience — naming ambíguo, resolvido via listName (#3128)", () => {
  const cycle = "2606-07";

  // Formato REAL das 10 campanhas do ciclo 2606-07 na Brevo (confirmado via
  // GET /v3/emailCampaigns + GET /v3/contacts/lists, READ-ONLY, 2026-07-10):
  // TODAS usam o prefixo "Clarice News 2606-07 — {cell}" — a diferença entre
  // fria e quente não está no nome da campanha, só no nome da LISTA de
  // destinatários. Antes do fix, `aggregateCellsV2` só olhava `c.name`, então
  // as 3 campanhas "· dom" (fria) entravam como "warm" — a tabela "Fria"
  // ficava com campaignCount 0 e a "Quente" ficava idêntica à "Agregada"
  // (sintoma relatado na issue #3128).
  const warmOriginal = [
    { ...makeCampaign(75, "Clarice News 2606-07 — A: Notícias do mês sobre IA: Brasil, Anthro…", "2026-07-03T09:07:57Z", { sent: 1500, delivered: 1490, uniqueViews: 900, uniqueClicks: 150 }), listName: "Clarice News 2606-07 A (A/B/C assunto)" },
    { ...makeCampaign(76, "Clarice News 2606-07 — B: Notícias do mês sobre IA: O mês em que o…", "2026-07-03T09:07:41Z", { sent: 1500, delivered: 1490, uniqueViews: 850, uniqueClicks: 100 }), listName: "Clarice News 2606-07 B (A/B/C assunto)" },
    { ...makeCampaign(77, "Clarice News 2606-07 — C: Notícias do mês sobre IA: Soberania, seg…", "2026-07-03T09:05:19Z", { sent: 1500, delivered: 1490, uniqueViews: 800, uniqueClicks: 90 }), listName: "Clarice News 2606-07 C (A/B/C assunto)" },
  ];
  const coldReenvioSabado = [
    { ...makeCampaign(84, "Clarice News 2606-07 — A · sab", "2026-07-04T09:13:27Z", { sent: 900, delivered: 895, uniqueViews: 200, uniqueClicks: 20 }), listName: "cold 2606-07 sab-A" },
    { ...makeCampaign(85, "Clarice News 2606-07 — B · sab", "2026-07-04T09:13:11Z", { sent: 900, delivered: 895, uniqueViews: 250, uniqueClicks: 60 }), listName: "cold 2606-07 sab-B" },
    { ...makeCampaign(86, "Clarice News 2606-07 — C · sab", "2026-07-04T09:13:08Z", { sent: 900, delivered: 895, uniqueViews: 150, uniqueClicks: 15 }), listName: "cold 2606-07 sab-C" },
  ];

  test("naming idêntico pra fria e quente — Fria e Quente NÃO ficam iguais à Agregada (bug #3128 corrigido)", () => {
    const result = aggregateAbcByAudience([...warmOriginal, ...coldReenvioSabado], cycle);
    // Antes do fix: result.cold.cells.every(campaignCount === 0) e
    // result.warm === result.aggregate (todos os 6 envios contados como warm).
    assert.ok(result.cold.cells.some((c) => c.campaignCount > 0), "Fria não pode ficar vazia — há 3 envios frios reais");
    const coldB = result.cold.cells.find((c) => c.cell === "B")!;
    const warmB = result.warm.cells.find((c) => c.cell === "B")!;
    assert.equal(coldB.delivered, 895, "célula B fria deve contar só o envio '· sab' (lista cold)");
    assert.equal(warmB.delivered, 1490, "célula B quente deve contar só o envio original (lista sem 'cold')");
    // Agregada = soma das duas, nunca igual a nenhuma das duas isoladamente.
    const aggB = result.aggregate.cells.find((c) => c.cell === "B")!;
    assert.equal(aggB.delivered, 895 + 1490);
    assert.notEqual(warmB.delivered, aggB.delivered, "Quente não pode ficar igual à Agregada — sintoma original do bug");
  });
});

// ─── renderAbcAudienceTable / renderAbcAudienceSection: omite audiência sem envios (#3127) ──

describe("renderAbcAudienceTable / renderAbcAudienceSection — omite audiência vazia (#3127)", () => {
  const cycle = "2607-08";
  // Só quente enviou neste ciclo — fria fica com as 3 células zeradas.
  const warmOnly = [
    makeCampaign(10, "Clarice News 2607-08 — A: subject A", "2026-07-10T06:00:00Z", {
      sent: 1000, delivered: 990, uniqueViews: 500, uniqueClicks: 80,
    }),
    makeCampaign(11, "Clarice News 2607-08 — B: subject B", "2026-07-10T06:01:00Z", {
      sent: 1000, delivered: 990, uniqueViews: 450, uniqueClicks: 60,
    }),
    makeCampaign(12, "Clarice News 2607-08 — C: subject C", "2026-07-10T06:02:00Z", {
      sent: 1000, delivered: 990, uniqueViews: 400, uniqueClicks: 50,
    }),
  ];

  test("renderAbcAudienceTable: as 3 células com campaignCount 0 → string vazia (não o stub 'Sem dados')", () => {
    const zeroCell = (cell: "A" | "B" | "C") => ({
      cell,
      campaignCount: 0,
      sent: 0,
      delivered: 0,
      opens: 0,
      clicks: 0,
      unsubscriptions: 0,
      openRate: 0,
      ctor: 0,
      clickRate: 0,
      unsubRate: 0,
      bounceRate: 0,
      spamRate: 0,
    });
    const table: AbcAudienceTable = {
      cells: [zeroCell("A"), zeroCell("B"), zeroCell("C")],
      leaderOpenRate: null,
      leaderClickRate: null,
      significantClick: false,
      pValue: null,
    };
    assert.equal(renderAbcAudienceTable("Fria (nunca recebeu)", table), "");
  });

  test("renderAbcAudienceSection: fria vazia é omitida por completo — agregada/quente com dado continuam renderizando", () => {
    const result = aggregateAbcByAudience(warmOnly, cycle);
    // Pré-condições do cenário: fria zerada, agregada/quente com dado real.
    assert.ok(result.cold.cells.every((c) => c.campaignCount === 0), "pré-condição: fria zerada");
    assert.ok(result.aggregate.cells.some((c) => c.campaignCount > 0), "pré-condição: agregada com dado");
    assert.ok(result.warm.cells.some((c) => c.campaignCount > 0), "pré-condição: quente com dado");

    const html = renderAbcAudienceSection(cycle, result);
    // O stub antigo (header + "Sem dados desta audiência") nunca deve aparecer.
    assert.doesNotMatch(html, /Sem dados desta audiência/);
    assert.doesNotMatch(html, /Fria \(nunca recebeu\)/);
    // As outras 2 subseções (com dado real) continuam presentes.
    assert.match(html, /Agregada \(Fria \+ Quente\)/);
    assert.match(html, /Quente \(já engajada\)/);
    assert.match(html, />CTOR</);
  });
});

// ─── renderAbcAudienceTable: guard de zero/aguardando (#3303) ────────────────

describe("renderAbcAudienceTable — guard opens>0/clicks=0 não é 'empate' (#3303)", () => {
  // Regressão #3303: mesma classe de bug já corrigida em renderAbcSection
  // (#3281) — reproduzida aqui pra renderAbcAudienceTable, que nunca teve o
  // guard. Fixture idêntica à do CONFIRMED da issue: opens>0, clicks=0 em
  // todas as 3 células amostradas (comum nas primeiras horas pós-envio,
  // clique atrasa em relação à abertura).
  function cell(cellId: "A" | "B" | "C", opens: number) {
    return {
      cell: cellId,
      campaignCount: 1,
      sent: 100,
      delivered: 100,
      opens,
      clicks: 0,
      unsubscriptions: 0,
      openRate: opens,
      ctor: 0,
      clickRate: 0,
      unsubRate: 0,
      bounceRate: 0,
      spamRate: 0,
    };
  }

  test("opens>0/clicks=0 em todas as células amostradas → 'Aguardando dados de clique', não 'Empate'", () => {
    const table: AbcAudienceTable = {
      cells: [cell("A", 40), cell("B", 35), cell("C", 38)],
      leaderOpenRate: "A",
      leaderClickRate: null,
      significantClick: false,
      pValue: null,
    };
    const html = renderAbcAudienceTable("Agregada (Fria + Quente)", table);
    assert.doesNotMatch(
      html,
      /Empate no clique/,
      "não deve implicar empate REAL no critério decisório (clique, #2976) quando na verdade é falta de dado",
    );
    assert.match(html, /Aguardando dados de clique/, "deve mostrar aviso de aguardando dados de clique");
  });

  test("empate REAL de clique (clicks>0, taxas iguais) continua mostrando 'Empate no clique'", () => {
    const tied = (cellId: "A" | "B" | "C") => ({
      ...cell(cellId, 50),
      clicks: 10,
      clickRate: 10,
    });
    const table: AbcAudienceTable = {
      cells: [tied("A"), tied("B"), tied("C")],
      leaderOpenRate: null,
      leaderClickRate: null,
      significantClick: false,
      pValue: null,
    };
    const html = renderAbcAudienceTable("Agregada (Fria + Quente)", table);
    assert.match(html, /Empate no clique/, "empate real de clique deve continuar mostrando o texto de empate");
    assert.doesNotMatch(html, /Aguardando dados de clique/, "não deve mostrar 'aguardando' quando há clique real empatado");
  });

  test("menos de 2 células amostradas → 'Dados insuficientes', não afetado pelo novo guard", () => {
    const table: AbcAudienceTable = {
      cells: [cell("A", 40), buildCellZero("B"), buildCellZero("C")],
      leaderOpenRate: null,
      leaderClickRate: null,
      significantClick: false,
      pValue: null,
    };
    const html = renderAbcAudienceTable("Fria (nunca recebeu)", table);
    assert.match(html, /Dados insuficientes para comparação/);
  });

  function buildCellZero(cellId: "A" | "B" | "C") {
    return {
      cell: cellId,
      campaignCount: 0,
      sent: 0,
      delivered: 0,
      opens: 0,
      clicks: 0,
      unsubscriptions: 0,
      openRate: 0,
      ctor: 0,
      clickRate: 0,
      unsubRate: 0,
      bounceRate: 0,
      spamRate: 0,
    };
  }
});

// ─── pickTopWeekdays / renderTopWeekdaysSection (#2989) ──────────────────────

describe("pickTopWeekdays", () => {
  function row(weekday: number, openRate: number, count = 2): WeekdaySummary {
    return {
      weekday,
      label: String(weekday),
      count,
      delivered: 1000,
      opens: Math.round(openRate * 10),
      openRate,
      smallSample: count < 2,
    };
  }

  test("seleciona os 3 melhores por open rate", () => {
    const rows = [row(0, 10), row(1, 50), row(2, 30), row(3, 20), row(4, 40), row(5, 5), row(6, 15)];
    const top = pickTopWeekdays(rows, 3);
    assert.equal(top.length, 3);
    assert.deepEqual(top.map((r) => r.weekday), [1, 4, 2]); // 50, 40, 30
  });

  test("empate na fronteira do corte inclui todos os empatados (não corta arbitrariamente)", () => {
    const rows = [row(0, 50), row(1, 30), row(2, 30), row(3, 30), row(4, 10)];
    const top = pickTopWeekdays(rows, 3);
    // top-3 seria [50,30,30] mas há 3 dias com 30% — todos entram (4 no total).
    assert.equal(top.length, 4);
  });

  test("menos dias com dados que N → retorna todos", () => {
    const rows = [row(0, 50), row(1, 30)];
    assert.equal(pickTopWeekdays(rows, 3).length, 2);
  });

  test("sem dados → array vazio", () => {
    assert.deepEqual(pickTopWeekdays([row(0, 0, 0)], 3), []);
  });
});

describe("renderTopWeekdaysSection", () => {
  test("com histórico suficiente, mostra os 3 melhores dias", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    const campaigns = [
      makeCampaign(1, "Clarice News 2605 d01-A (seg)", "2026-06-01T09:00:00Z", { delivered: 1000, uniqueViews: 600 }), // seg
      makeCampaign(2, "Clarice News 2605 d02-A (qui)", "2026-06-04T09:00:00Z", { delivered: 1000, uniqueViews: 200 }), // qui
      makeCampaign(3, "Clarice News 2605 d03-A (sab)", "2026-06-06T09:00:00Z", { delivered: 1000, uniqueViews: 700 }), // sab
      makeCampaign(4, "Clarice News 2605 d04-A (ter)", "2026-06-02T09:00:00Z", { delivered: 1000, uniqueViews: 100 }), // ter
    ];
    const html = renderTopWeekdaysSection(campaigns as unknown as BrevoCampaign[], now);
    assert.match(html, /Melhores dias da semana/);
    assert.match(html, /sugestão mensal/);
    // #3081: mesma nota de mistura fria/quente do renderWeekdaySection (Engajamento).
    assert.match(html, /Agrega audiência fria e quente/);
  });

  test("dados insuficientes (< 2 dias) → string vazia", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    const campaigns = [
      makeCampaign(1, "Clarice News 2605 d01-A (seg)", "2026-06-01T09:00:00Z"),
    ];
    assert.equal(renderTopWeekdaysSection(campaigns as unknown as BrevoCampaign[], now), "");
  });
});
