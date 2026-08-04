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
  SIGNIFICANCE_ALPHA,
  minDetectableRelativeLift,
  LOW_POWER_MDE_THRESHOLD,
  aggregateAbcByAudience,
  renderAbcAudienceSection,
  renderAbcAudienceTable,
  renderAbcClickAttributionNote,
  pickTopWeekdays,
  aggregateByWeekday,
  renderTopWeekdaysSection,
  type WeekdaySummary,
  type AbcAudienceTable,
  type CellSummaryV2,
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

/**
 * #4559: adiciona `statistics.campaignStats[0]` (atribuição por LISTA) a uma
 * campanha já construída por `makeCampaign` — por padrão espelha os mesmos
 * valores de `globalStats` (sem divergência, o caso comum), só `csOverrides`
 * diverge dos campos que o teste quer distorcer (tipicamente `uniqueClicks`,
 * pra simular o K de tráfego não atribuível achado na issue #4559).
 */
function withCampaignStats(
  campaign: ReturnType<typeof makeCampaign>,
  csOverrides: Partial<{
    listId: number; sent: number; delivered: number; hardBounces: number; softBounces: number;
    deferred: number; uniqueViews: number; viewed: number; trackableViews: number;
    uniqueClicks: number; clickers: number; unsubscriptions: number; complaints: number;
  }> = {},
) {
  const gs = campaign.statistics.globalStats;
  return {
    ...campaign,
    statistics: {
      ...campaign.statistics,
      campaignStats: [{
        listId: 1,
        sent: gs.sent, delivered: gs.delivered, hardBounces: gs.hardBounces, softBounces: gs.softBounces,
        deferred: 0, uniqueViews: gs.uniqueViews, viewed: gs.viewed, trackableViews: gs.trackableViews,
        uniqueClicks: gs.uniqueClicks, clickers: gs.clickers, unsubscriptions: gs.unsubscriptions,
        complaints: gs.complaints,
        ...csOverrides,
      }],
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

  // #4447: fluxo `--group` (clarice-schedule-group.ts) nomeia a CAMPANHA
  // "Clarice {yymm} grupo:{key}" — sem ciclo "AAMM-MM" nem célula
  // reconhecível. Nomes reais confirmados via KV dash:lastgood:campaigns
  // pro ciclo 2607-08 (issue #4447):
  //   id 102: nome "Clarice 2607 grupo:d1-sab01-A" → lista "Clarice 2607-08 d1-sab01-A — celula A"
  //   id 105: nome "Clarice 2607 grupo:d2-dom02-A" → lista "Clarice 2607-08 d2-dom02-A — celula A"
  test("#4447: naming '--group' (célula só na lista) é reconhecido via listName", () => {
    const parsed = parseAbcAudienceCampaign(
      "Clarice 2607 grupo:d1-sab01-A",
      "Clarice 2607-08 d1-sab01-A — celula A",
    );
    assert.deepEqual(parsed, { cycle: "2607-08", cell: "A", audience: "warm" });
  });

  test("#4447: naming '--group' funciona pras 3 células (B e C também)", () => {
    const b = parseAbcAudienceCampaign("Clarice 2607 grupo:d2-dom02-B", "Clarice 2607-08 d2-dom02-B — celula B");
    assert.deepEqual(b, { cycle: "2607-08", cell: "B", audience: "warm" });
    const c = parseAbcAudienceCampaign("Clarice 2607 grupo:d1-sab01-C", "Clarice 2607-08 d1-sab01-C — celula C");
    assert.deepEqual(c, { cycle: "2607-08", cell: "C", audience: "warm" });
  });

  test("#4447: naming '--group' com lista 'cold' → classificado como fria (mesmo racional do #3128)", () => {
    const parsed = parseAbcAudienceCampaign(
      "Clarice 2607 grupo:d1-sab01-A",
      "cold Clarice 2607-08 d1-sab01-A — celula A",
    );
    assert.deepEqual(parsed, { cycle: "2607-08", cell: "A", audience: "cold" });
  });

  test("#4447: naming '--group' sem 'celula' na lista (ex: envio interno) → null (não participa do A/B/C)", () => {
    assert.equal(
      parseAbcAudienceCampaign("Clarice 2607 grupo:d1-sab01-interno", "Clarice 2607-08 d1-sab01-interno"),
      null,
    );
  });

  test("#4447: naming '--group' sem listName (chamador legado) → null (sinal só existe na lista)", () => {
    assert.equal(parseAbcAudienceCampaign("Clarice 2607 grupo:d1-sab01-A"), null);
  });

  // Achado do /code-review (silent-failure-hunter + pr-test-analyzer, PR
  // #4448): não existe gerador desse formato de nome de lista no repo — foi
  // digitado à mão. "célula" (com acento) é a grafia CORRETA em PT-BR, usada
  // em todo o resto deste arquivo (ex: renderAbcAudienceSection); um retype
  // com acento reproduziria o mesmo bug do #4447 (3ª vez: #3081 → #3128 →
  // #4447).
  test("#4447 (review): naming '--group' com 'célula' acentuada na lista também é reconhecido", () => {
    const parsed = parseAbcAudienceCampaign(
      "Clarice 2607 grupo:d1-sab01-A",
      "Clarice 2607-08 d1-sab01-A — célula A",
    );
    assert.deepEqual(parsed, { cycle: "2607-08", cell: "A", audience: "warm" });
  });

  // Achado do /code-review (silent-failure-hunter, PR #4448): o `{key}` da
  // campanha já carrega a célula redundantemente ("grupo:d1-sab01-A"); uma
  // lista renomeada errada não deve poder sobrescrever esse sinal em
  // silêncio — o mismatch precisa virar `null` (não-parseável), nunca uma
  // célula errada aceita sem aviso.
  test("#4447 (review): célula da lista diverge do sufixo -A/-B/-C da campanha → null (não confia cegamente na lista)", () => {
    const parsed = parseAbcAudienceCampaign(
      "Clarice 2607 grupo:d1-sab01-A",
      "Clarice 2607-08 d1-sab01-A — celula B", // typo: campanha diz A, lista diz B
    );
    assert.equal(parsed, null);
  });

  test("#4447 (review): sufixo da campanha sem letra A/B/C (ex: 'interno') → sem sinal pra cruzar, segue confiando só na lista", () => {
    const parsed = parseAbcAudienceCampaign(
      "Clarice 2607 grupo:d1-sab01-extra",
      "Clarice 2607-08 d1-sab01-extra — celula B",
    );
    assert.deepEqual(parsed, { cycle: "2607-08", cell: "B", audience: "warm" });
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

  test("renderAbcAudienceSection: renderiza as 3 tabelas com CTOR/unsub e tags de LÍDER (#3675: Click rate e Bounce/Spam removidas)", () => {
    const result = aggregateAbcByAudience([...cold, ...warm], cycle);
    const html = renderAbcAudienceSection(cycle, result);
    assert.match(html, /Resumo A\/B\/C por Audiência/);
    assert.match(html, /Agregada \(Fria \+ Quente\)/);
    assert.match(html, /Fria \(nunca recebeu\)/);
    assert.match(html, /Quente \(já engajada\)/);
    assert.match(html, />CTOR</);
    // #3675: coluna Click rate removida a pedido do editor — a tag ▲CLIQUE
    // migrou pra célula de CTOR (não some, só muda de coluna).
    assert.doesNotMatch(html, />Click rate</, "coluna Click rate não deve mais existir (#3675)");
    assert.doesNotMatch(html, />Bounce \/ Spam</, "coluna Bounce / Spam não deve mais existir (#3675)");
    assert.match(html, /▲ ABERTURA/);
    assert.match(html, /▲ CLIQUE/);
  });

  test("renderAbcAudienceSection: tag ▲CLIQUE aparece na célula de CTOR, não numa coluna Click rate separada (#3675)", () => {
    const result = aggregateAbcByAudience([...cold, ...warm], cycle);
    const html = renderAbcAudienceSection(cycle, result);
    // A tag deve estar imediatamente após um valor de CTOR (%), não isolada
    // numa célula própria — confirma que migrou pra dentro do <td> de CTOR.
    assert.match(html, /class="metric">[\d.]+%\s*<strong[^>]*>▲ CLIQUE<\/strong><\/td>/);
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

// ─── aggregateAbcByAudience: naming '--group' (célula só na LISTA) — #4447 ────

describe("aggregateAbcByAudience — naming '--group' (célula só na LISTA), resolvido via listName (#4447)", () => {
  const cycle = "2607-08";
  // Nomes reais confirmados via KV dash:lastgood:campaigns pro ciclo 2607-08
  // (issue #4447) — mesma disciplina de fixture do bloco #3128 acima.
  const grupoAbc = [
    { ...makeCampaign(102, "Clarice 2607 grupo:d1-sab01-A", "2026-08-01T09:00:00Z", { sent: 3000, delivered: 2977, uniqueViews: 306, uniqueClicks: 101 }), listName: "Clarice 2607-08 d1-sab01-A — celula A" },
    { ...makeCampaign(103, "Clarice 2607 grupo:d1-sab01-B", "2026-08-01T09:01:00Z", { sent: 3001, delivered: 2980, uniqueViews: 402, uniqueClicks: 28 }), listName: "Clarice 2607-08 d1-sab01-B — celula B" },
    { ...makeCampaign(104, "Clarice 2607 grupo:d1-sab01-C", "2026-08-01T09:02:00Z", { sent: 3000, delivered: 2979, uniqueViews: 280, uniqueClicks: 65 }), listName: "Clarice 2607-08 d1-sab01-C — celula C" },
  ];

  test("agrega delivered/clicks corretamente por célula a partir do listName (não fica tudo em 1 bucket)", () => {
    const result = aggregateAbcByAudience(grupoAbc, cycle);
    const a = result.aggregate.cells.find((c) => c.cell === "A")!;
    const b = result.aggregate.cells.find((c) => c.cell === "B")!;
    const c = result.aggregate.cells.find((c) => c.cell === "C")!;
    assert.equal(a.delivered, 2977);
    assert.equal(a.clicks, 101);
    assert.equal(b.delivered, 2980);
    assert.equal(b.clicks, 28);
    assert.equal(c.delivered, 2979);
    assert.equal(c.clicks, 65);
  });

  test("LÍDER de abertura é B, mas LÍDER de clique é A (divergência real do ciclo 2607-08)", () => {
    const result = aggregateAbcByAudience(grupoAbc, cycle);
    assert.equal(result.aggregate.leaderOpenRate, "B");
    assert.equal(result.aggregate.leaderClickRate, "A");
  });

  // Achado do /code-review (silent-failure-hunter) do PR #4448: sem
  // cross-checar a célula da LISTA contra o sufixo -A/-B/-C já presente no
  // `{key}` da CAMPANHA, uma lista renomeada errada (cópia/cola, typo)
  // misturaria silenciosamente as métricas da campanha 103 (célula B de
  // verdade) dentro do bucket da célula A — inflando A e derrubando B sem
  // nenhum erro visível, o pior tipo de falha (conclusão estatística ERRADA,
  // não só ausente).
  test("lista com célula ERRADA (mismatch vs sufixo da campanha) é descartada, não corrompe o bucket de outra célula", () => {
    const corrupted = [
      grupoAbc[0],
      { ...grupoAbc[1], listName: "Clarice 2607-08 d1-sab01-B — celula A" }, // typo: devia ser "celula B"
      grupoAbc[2],
    ];
    const result = aggregateAbcByAudience(corrupted, cycle);
    const a = result.aggregate.cells.find((c) => c.cell === "A")!;
    const b = result.aggregate.cells.find((c) => c.cell === "B")!;
    assert.equal(a.campaignCount, 0, "célula A NÃO deve herdar os 2.980 delivered da campanha 103 (mismatch descartado)");
    assert.equal(b.campaignCount, 0, "célula B também fica sem dado (campanha 103 nunca chega lá)");
    // Com a campanha 103 descartada, só A e C sobram pro dia 01/08 — o guard
    // de consolidação pré-existente (#3404, `cellsPerDay < 3`) então zera
    // TAMBÉM A e C nesse dia (não distingue "typo descartado" de "consolidação
    // real com só 2 células"). Dado AUSENTE continua mais seguro que dado
    // ERRADO (comportamento inalterado), mas #4449 item 1 fecha o gap que
    // ficou como follow-up aqui: `suspectedDriftDays` agora sinaliza esse dia
    // como suspeito (as 3 células apareciam nos NOMES das campanhas — não é
    // consolidação real, é drift de naming) em vez de ficar indistinguível.
    const c = result.aggregate.cells.find((c) => c.cell === "C")!;
    assert.equal(c.campaignCount, 0, "efeito colateral do guard <3 pré-existente (#3404) — dado ausente, não corrompido");
    assert.deepEqual(
      result.aggregate.suspectedDriftDays,
      ["2026-08-01"],
      "#4449 item 1: dia com 3 células nos NOMES mas <3 parseadas → sinalizado como drift, não silenciado",
    );
  });
});

// ─── aggregateAbcByAudience: drift de naming vs consolidação real (#4449 item 1) ──

describe("aggregateAbcByAudience — distingue drift de naming de consolidação real (#4449 item 1)", () => {
  const cycle = "2607-08";

  test("3 campanhas do mesmo grupo, 1 falha o parse (naming da lista não reconhecido) → suspectedDriftDays aponta o dia, células ficam vazias (dado ausente, não corrompido)", () => {
    const campaigns = [
      { ...makeCampaign(200, "Clarice 2607 grupo:d1-sab01-A", "2026-08-01T09:00:00Z", { sent: 3000, delivered: 2977, uniqueViews: 306, uniqueClicks: 101 }), listName: "Clarice 2607-08 d1-sab01-A — célula A" },
      // #201: naming da lista com um typo NÃO reconhecido por parseAbcAudienceCampaign
      // (falta o "célula"/"celula") — mas o NOME da campanha ainda denuncia "-B".
      { ...makeCampaign(201, "Clarice 2607 grupo:d1-sab01-B", "2026-08-01T09:01:00Z", { sent: 3001, delivered: 2980, uniqueViews: 402, uniqueClicks: 28 }), listName: "Clarice 2607-08 d1-sab01-B (typo, sem célula reconhecível)" },
      { ...makeCampaign(202, "Clarice 2607 grupo:d1-sab01-C", "2026-08-01T09:02:00Z", { sent: 3000, delivered: 2979, uniqueViews: 280, uniqueClicks: 65 }), listName: "Clarice 2607-08 d1-sab01-C — célula C" },
    ];
    const result = aggregateAbcByAudience(campaigns, cycle);
    assert.ok(result.aggregate.cells.every((c) => c.campaignCount === 0), "dia excluído da agregação — dado ausente, nunca corrompido");
    assert.deepEqual(result.aggregate.suspectedDriftDays, ["2026-08-01"], "drift sinalizado — 3 células nos nomes, só 2 parsearam");
  });

  test("consolidação REAL (só 1-2 campanhas existiram de propósito, nenhuma falhou parse) → suspectedDriftDays vazio (comportamento pré-existente preservado)", () => {
    // Mesmo padrão do describe #3404 acima: só a Célula B foi enviada nesse
    // dia (pós-consolidação) — nenhuma campanha A/C jamais existiu, não é
    // uma falha de parse.
    const soloB = [
      { ...makeCampaign(210, "Clarice 2607 grupo:d5-ter05-B", "2026-08-05T10:00:00Z", { sent: 1200, delivered: 1200, uniqueViews: 400, uniqueClicks: 300 }), listName: "Clarice 2607-08 d5-ter05-B — célula B" },
    ];
    const result = aggregateAbcByAudience(soloB, cycle);
    assert.ok(result.aggregate.cells.every((c) => c.campaignCount === 0));
    assert.deepEqual(result.aggregate.suspectedDriftDays, [], "sem sinal de 3 células nos nomes — consolidação real, não alarmar");
  });

  test("renderAbcAudienceTable: sinaliza a nota de drift mesmo quando a tabela não tem dado suficiente pra renderizar (não mascara em silêncio)", () => {
    const campaigns = [
      { ...makeCampaign(220, "Clarice 2607 grupo:d1-sab01-A", "2026-08-01T09:00:00Z", { sent: 3000, delivered: 2977, uniqueViews: 306, uniqueClicks: 101 }), listName: "Clarice 2607-08 d1-sab01-A — célula A" },
      { ...makeCampaign(221, "Clarice 2607 grupo:d1-sab01-B", "2026-08-01T09:01:00Z", { sent: 3001, delivered: 2980, uniqueViews: 402, uniqueClicks: 28 }), listName: "naming quebrado" },
      { ...makeCampaign(222, "Clarice 2607 grupo:d1-sab01-C", "2026-08-01T09:02:00Z", { sent: 3000, delivered: 2979, uniqueViews: 280, uniqueClicks: 65 }), listName: "Clarice 2607-08 d1-sab01-C — célula C" },
    ];
    const result = aggregateAbcByAudience(campaigns, cycle);
    const html = renderAbcAudienceTable("Agregada (Fria + Quente)", result.aggregate);
    assert.match(html, /DRIFT DE NAMING/, "nota de drift aparece mesmo sem tabela renderizada (sampled < 2)");
    assert.match(html, /01\/08\/2026/, "data do dia suspeito aparece na nota");
  });

  test("renderAbcAudienceSection: quando TODAS as sub-tabelas ficam vazias mas há drift, a seção não desaparece — mostra a nota", () => {
    const campaigns = [
      { ...makeCampaign(230, "Clarice 2607 grupo:d1-sab01-A", "2026-08-01T09:00:00Z", { sent: 3000, delivered: 2977, uniqueViews: 306, uniqueClicks: 101 }), listName: "Clarice 2607-08 d1-sab01-A — célula A" },
      { ...makeCampaign(231, "Clarice 2607 grupo:d1-sab01-B", "2026-08-01T09:01:00Z", { sent: 3001, delivered: 2980, uniqueViews: 402, uniqueClicks: 28 }), listName: "naming quebrado" },
      { ...makeCampaign(232, "Clarice 2607 grupo:d1-sab01-C", "2026-08-01T09:02:00Z", { sent: 3000, delivered: 2979, uniqueViews: 280, uniqueClicks: 65 }), listName: "Clarice 2607-08 d1-sab01-C — célula C" },
    ];
    const result = aggregateAbcByAudience(campaigns, cycle);
    const html = renderAbcAudienceSection(cycle, result);
    assert.notEqual(html, "", "seção não pode voltar a ficar em branco quando há drift — era o próprio sintoma do item 1");
    assert.match(html, /DRIFT DE NAMING/);
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

// ─── renderAbcAudienceTable / renderAbcAudienceSection: <2 células amostradas (#3396) ──

describe("renderAbcAudienceTable / renderAbcAudienceSection — omite quando <2 células amostradas (#3396)", () => {
  const cycle = "2607-09";

  test("renderAbcAudienceTable: só 1 célula com campaignCount > 0 (B/C zeradas) → string vazia", () => {
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
      cells: [
        {
          cell: "A", campaignCount: 1, sent: 1000, delivered: 990, opens: 500, clicks: 80,
          unsubscriptions: 2, openRate: 50.5, ctor: 16, clickRate: 8.1, unsubRate: 0.2,
          bounceRate: 1, spamRate: 0.01,
        },
        zeroCell("B"),
        zeroCell("C"),
      ],
      leaderOpenRate: null,
      leaderClickRate: null,
      significantClick: false,
      pValue: null,
    };
    // Distinto do caso já coberto em #3127 (3 células === 0): aqui há 1 célula
    // com dado real, mas ainda não é comparação — mesmo critério de pickLeader
    // (sampled.length < 2 → null).
    assert.equal(renderAbcAudienceTable("Fria (nunca recebeu)", table), "");
  });

  test("renderAbcAudienceSection: só Célula A saiu no ciclo (B/C aguardando) → seção inteira omitida", () => {
    const aOnly = [
      makeCampaign(20, "Clarice News 2607-09 — A: subject A", "2026-07-13T06:00:00Z", {
        sent: 1000, delivered: 990, uniqueViews: 500, uniqueClicks: 80,
      }),
    ];
    const result = aggregateAbcByAudience(aOnly, cycle);
    // Pré-condição: nenhuma das 3 sub-tabelas tem 2+ células amostradas.
    assert.ok(result.aggregate.cells.filter((c) => c.campaignCount > 0).length < 2);
    assert.ok(result.cold.cells.filter((c) => c.campaignCount > 0).length < 2);
    assert.ok(result.warm.cells.filter((c) => c.campaignCount > 0).length < 2);

    // Antes do #3396: renderizava a seção inteira (título + nota de
    // metodologia + tabela com 1 linha real e 2 stubs "— sem envios —").
    assert.equal(renderAbcAudienceSection(cycle, result), "");
  });
});

// ─── aggregateAbcByAudience: exclui envio de CONSOLIDAÇÃO da comparação (#3404) ──

describe("aggregateAbcByAudience — exclui dia sem par completo A/B/C (consolidação, #3404)", () => {
  const cycle = "2606-07";

  // Reproduz o padrão real do ciclo 2606-07 (achado ao vivo, 260713): 2 dias
  // completos (sáb, dom) + 1 envio de CONSOLIDAÇÃO só pra Célula B (terça,
  // pós sinal de vencedor) — mesmo padrão do #87 real ("2606-07 cold d1").
  const coldTwoFullDays = [
    { ...makeCampaign(184, "Clarice News 2606-07 — A · sab", "2026-07-04T09:13:00Z", { sent: 900, delivered: 895, uniqueViews: 200, uniqueClicks: 20 }), listName: "cold 2606-07 sab-A" },
    { ...makeCampaign(185, "Clarice News 2606-07 — B · sab", "2026-07-04T09:13:00Z", { sent: 900, delivered: 895, uniqueViews: 250, uniqueClicks: 60 }), listName: "cold 2606-07 sab-B" },
    { ...makeCampaign(186, "Clarice News 2606-07 — C · sab", "2026-07-04T09:13:00Z", { sent: 900, delivered: 895, uniqueViews: 150, uniqueClicks: 15 }), listName: "cold 2606-07 sab-C" },
    { ...makeCampaign(181, "Clarice News 2606-07 — A · dom", "2026-07-05T09:58:00Z", { sent: 800, delivered: 800, uniqueViews: 180, uniqueClicks: 18 }), listName: "cold 2606-07 dom-A" },
    { ...makeCampaign(182, "Clarice News 2606-07 — B · dom", "2026-07-05T09:30:00Z", { sent: 800, delivered: 800, uniqueViews: 220, uniqueClicks: 55 }), listName: "cold 2606-07 dom-B" },
    { ...makeCampaign(183, "Clarice News 2606-07 — C · dom", "2026-07-05T09:31:00Z", { sent: 800, delivered: 800, uniqueViews: 140, uniqueClicks: 13 }), listName: "cold 2606-07 dom-C" },
  ];
  const coldConsolidacaoSoloB = {
    ...makeCampaign(187, "Clarice News 2606-07 — B · ter", "2026-07-07T10:12:00Z", { sent: 1200, delivered: 1200, uniqueViews: 400, uniqueClicks: 300 }),
    listName: "2606-07 cold d1",
  };

  test("célula com envio solo (sem par A/C no mesmo dia) não conta esse dia — campaignCount/delivered ficam simétricos", () => {
    const result = aggregateAbcByAudience([...coldTwoFullDays, coldConsolidacaoSoloB], cycle);
    const a = result.cold.cells.find((c) => c.cell === "A")!;
    const b = result.cold.cells.find((c) => c.cell === "B")!;
    const c = result.cold.cells.find((c) => c.cell === "C")!;
    // Sem o fix: B teria campaignCount=3, delivered=895+800+1200=2895 —
    // volume de consolidação inflando a comparação a favor de quem já venceu.
    assert.equal(b.campaignCount, 2, "envio de terça (consolidação solo) não deve contar");
    assert.equal(b.delivered, 895 + 800, "delivered de B não deve incluir o envio de consolidação (1200)");
    assert.equal(a.campaignCount, 2);
    assert.equal(c.campaignCount, 2);
    assert.equal(a.delivered, b.delivered, "A e B devem ficar simétricos — mesmo número de dias completos");
    assert.equal(c.delivered, b.delivered, "C e B devem ficar simétricos — mesmo número de dias completos");
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

  // #3396: o cenário "1 célula amostrada + 2 zeradas" (testado aqui antes como
  // 'Dados insuficientes' dentro da tabela) agora omite a tabela inteira via
  // guard em renderAbcAudienceTable (sampled.length < 2) — ver describe
  // "omite quando <2 células amostradas (#3396)" acima, que cobre o caso.
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

// ─── #4559: vencedor por CLIQUE usa cliques ATRIBUÍDOS (campaignStats), não globalStats ──

describe("aggregateAbcByAudience / renderAbcAudienceTable — cliques ATRIBUÍDOS decidem o vencedor, não globalStats (#4559)", () => {
  const cycle = "2607-08";

  // Reproduz a distorção real do ciclo 2607-08 (issue #4559): globalStats.uniqueClicks
  // inclui K cliques não atribuíveis a NENHUM contato da lista (scanner/encaminhamento/
  // espelho público) — concentrados numa única campanha fria (d3-seg03-C). Números da
  // issue: A totais=144/atribuídos=50, B totais=79/atribuídos=38, C totais=255/atribuídos=48.
  // Delivered ~2970 por célula (~8.910 entregues no ciclo ÷ 3, valor real reportado).
  const distorted = [
    withCampaignStats(
      makeCampaign(301, "Clarice News 2607-08 — A: subject A", "2026-08-01T09:00:00Z", { sent: 3000, delivered: 2970, uniqueViews: 713, uniqueClicks: 144 }),
      { uniqueClicks: 50 },
    ),
    withCampaignStats(
      makeCampaign(302, "Clarice News 2607-08 — B: subject B", "2026-08-01T09:01:00Z", { sent: 3000, delivered: 2970, uniqueViews: 713, uniqueClicks: 79 }),
      { uniqueClicks: 38 },
    ),
    withCampaignStats(
      makeCampaign(303, "Clarice News 2607-08 — C: subject C", "2026-08-01T09:02:00Z", { sent: 3000, delivered: 2970, uniqueViews: 713, uniqueClicks: 255 }),
      { uniqueClicks: 48 },
    ),
  ];

  test("agrega .clicks com o número ATRIBUÍDO (campaignStats), não o total (globalStats) — .clicksTotal preserva o total pra exibição", () => {
    const result = aggregateAbcByAudience(distorted, cycle);
    const a = result.aggregate.cells.find((c) => c.cell === "A")!;
    const b = result.aggregate.cells.find((c) => c.cell === "B")!;
    const c = result.aggregate.cells.find((c) => c.cell === "C")!;
    assert.equal(a.clicks, 50); assert.equal(a.clicksTotal, 144);
    assert.equal(b.clicks, 38); assert.equal(b.clicksTotal, 79);
    assert.equal(c.clicks, 48); assert.equal(c.clicksTotal, 255);
  });

  test("Célula C NÃO vence por clique mesmo tendo o maior total reportado (255) — vence quem tem mais clique ATRIBUÍDO (A, 50)", () => {
    const result = aggregateAbcByAudience(distorted, cycle);
    assert.equal(result.aggregate.leaderClickRate, "A", "com os números corretos, A lidera (50 > 48 > 38) — não C");
    assert.notEqual(result.aggregate.leaderClickRate, "C", "C só lidera nos totais brutos (255), dominados por tráfego não atribuível — o bug original");
  });

  test("com os números corretos a diferença NÃO é estatisticamente significativa — o 'vencedor' do bug original era só o K de ruído", () => {
    const result = aggregateAbcByAudience(distorted, cycle);
    assert.equal(result.aggregate.significantClick, false);
    assert.ok(result.aggregate.pValue !== null && result.aggregate.pValue > SIGNIFICANCE_ALPHA, `p-valor esperado > 0.05, obtido ${result.aggregate.pValue}`);
  });

  test("regressão de raiz: comparando pelos TOTAIS (globalStats) a diferença SERIA declarada altamente significativa — confirma que só a troca de fonte evita o falso positivo", () => {
    // Reproduz deliberadamente o cálculo do código ANTIGO (globalStats.uniqueClicks)
    // pra provar que o bug não era sutil: com os totais brutos, C (255) vs A (144)
    // dava p ≈ 8.8e-9 — o "Já dá pra concluir" da issue original.
    const oldBuggyTest = twoProportionZTest(255, 2970, 144, 2970);
    assert.ok(oldBuggyTest.pValue < SIGNIFICANCE_ALPHA, "confirma que o bug produzia falsa significância usando os totais");
  });

  test("renderAbcAudienceTable: não declara Célula C vencedora e mostra a divergência total vs atribuído pras 3 células", () => {
    const result = aggregateAbcByAudience(distorted, cycle);
    const html = renderAbcAudienceTable("Agregada (Fria + Quente)", result.aggregate);
    // A frase de conclusão usa <strong style="color:..."> (diferente do <strong>
    // Célula X</strong> plano de CADA linha da tabela, sempre presente) — checar
    // esse padrão específico evita falso-positivo com a linha da própria célula C.
    assert.doesNotMatch(html, /Vencedor[^<]*<strong style="color:[^"]*">Célula C<\/strong>/, "Célula C não pode ser declarada vencedora/líder na frase de conclusão");
    assert.match(html, /Vencedor provisório por clique:\s*<strong style="color:[^"]*">Célula A/, "com os números corretos, a diferença não é significativa — texto provisório, célula A (não C)");
    assert.match(html, /255 totais, 48 atribuídos à lista/, "nota de divergência deve expor os dois números pra Célula C");
    assert.match(html, /144 totais, 50 atribuídos à lista/, "nota de divergência também cobre Célula A");
    assert.match(html, /79 totais, 38 atribuídos à lista/, "nota de divergência também cobre Célula B");
  });

  test("campanha sem campaignStats (fixture legado/API antiga) → cai pro valor de globalStats, sem quebrar (mesmo comportamento pré-#4559)", () => {
    const noCampaignStats = [
      makeCampaign(310, "Clarice News 2607-09 — A: subject A", "2026-08-05T09:00:00Z", { sent: 1000, delivered: 990, uniqueViews: 500, uniqueClicks: 80 }),
      makeCampaign(311, "Clarice News 2607-09 — B: subject B", "2026-08-05T09:01:00Z", { sent: 1000, delivered: 990, uniqueViews: 450, uniqueClicks: 60 }),
      makeCampaign(312, "Clarice News 2607-09 — C: subject C", "2026-08-05T09:02:00Z", { sent: 1000, delivered: 990, uniqueViews: 400, uniqueClicks: 50 }),
    ];
    const result = aggregateAbcByAudience(noCampaignStats, "2607-09");
    const a = result.aggregate.cells.find((c) => c.cell === "A")!;
    assert.equal(a.clicks, 80, "sem campaignStats, .clicks cai pro valor de globalStats (comportamento preservado)");
    assert.equal(a.clicksTotal, 80, "clicksTotal também é 80 — sem divergência conhecida, não há nada pra sinalizar");
  });

  test("sem divergência entre total e atribuído (fixture padrão) → renderAbcClickAttributionNote não adiciona ruído", () => {
    const noCampaignStats = [
      makeCampaign(320, "Clarice News 2607-10 — A: subject A", "2026-08-06T09:00:00Z", { sent: 1000, delivered: 990, uniqueViews: 500, uniqueClicks: 80 }),
      makeCampaign(321, "Clarice News 2607-10 — B: subject B", "2026-08-06T09:01:00Z", { sent: 1000, delivered: 990, uniqueViews: 450, uniqueClicks: 60 }),
    ];
    const result = aggregateAbcByAudience(noCampaignStats, "2607-10");
    assert.equal(renderAbcClickAttributionNote(result.aggregate.cells), "");
  });
});

// ─── #4559: guard de poder estatístico — amostra ATRIBUÍDA pequena não vira "já dá pra concluir" ──

describe("renderAbcAudienceTable — guard de poder estatístico (#4559)", () => {
  function cellWithClicks(cellId: "A" | "B" | "C", clicks: number, delivered: number): CellSummaryV2 {
    return {
      cell: cellId,
      campaignCount: 1,
      sent: delivered,
      delivered,
      opens: Math.round(delivered * 0.3),
      clicks,
      clicksTotal: clicks,
      unsubscriptions: 0,
      openRate: 30,
      ctor: (clicks / (delivered * 0.3)) * 100,
      clickRate: (clicks / delivered) * 100,
      unsubRate: 0,
      bounceRate: 0,
      spamRate: 0,
    };
  }

  // Números confirmados via minDetectableRelativeLift/twoProportionZTest diretamente
  // (mesma fórmula usada pelo painel): 50/1000 vs 10/1000 → p≈1.58e-7 (bem
  // significativo), MDE≈71.2% (bem acima de LOW_POWER_MDE_THRESHOLD=30%) — o
  // cenário exato que o guard existe pra qualificar, mesmo com p tecnicamente
  // "significativo".
  test("p<0.05 mas amostra ATRIBUÍDA pequena (MDE > 30%) → texto qualificado, NÃO 'Já dá pra concluir' sem ressalva", () => {
    const zTest = twoProportionZTest(50, 1000, 10, 1000);
    const mde = minDetectableRelativeLift(50, 1000, 10, 1000);
    assert.ok(zTest.pValue < SIGNIFICANCE_ALPHA, "pré-condição: teste deve ser significativo");
    assert.ok(mde > LOW_POWER_MDE_THRESHOLD, "pré-condição: MDE deve estar acima do limiar de poder baixo");

    const table: AbcAudienceTable = {
      cells: [cellWithClicks("A", 50, 1000), cellWithClicks("B", 10, 1000), { ...cellWithClicks("C", 0, 1000), campaignCount: 0 }],
      leaderOpenRate: "A",
      leaderClickRate: "A",
      significantClick: true,
      pValue: zTest.pValue,
      minDetectableLiftRelative: mde,
    };
    const html = renderAbcAudienceTable("Agregada (Fria + Quente)", table);
    assert.doesNotMatch(html, /Já dá pra concluir\./, "não pode afirmar conclusão sem qualificar quando o poder é baixo");
    assert.match(html, /com ressalva/i, "deve sinalizar explicitamente que é uma conclusão com ressalva");
    assert.match(html, /Tratar como indicativo, não conclusivo/, "deve orientar o editor a não tratar como definitivo");
    assert.match(html, /71%/, "deve mostrar o MDE calculado (~71%) pro editor entender o motivo da ressalva");
  });

  test("p<0.05 e amostra bem-powered (MDE < 30%) → 'Já dá pra concluir' sem ressalva (comportamento original preservado)", () => {
    const zTest = twoProportionZTest(400, 2000, 100, 2000);
    const mde = minDetectableRelativeLift(400, 2000, 100, 2000);
    assert.ok(zTest.pValue < SIGNIFICANCE_ALPHA, "pré-condição: teste deve ser significativo");
    assert.ok(mde < LOW_POWER_MDE_THRESHOLD, "pré-condição: MDE deve estar abaixo do limiar (amostra grande o bastante)");

    const table: AbcAudienceTable = {
      cells: [cellWithClicks("A", 400, 2000), cellWithClicks("B", 100, 2000), { ...cellWithClicks("C", 0, 2000), campaignCount: 0 }],
      leaderOpenRate: "A",
      leaderClickRate: "A",
      significantClick: true,
      pValue: zTest.pValue,
      minDetectableLiftRelative: mde,
    };
    const html = renderAbcAudienceTable("Agregada (Fria + Quente)", table);
    assert.match(html, /Já dá pra concluir\./, "amostra grande o bastante não deve carregar a ressalva de poder baixo");
    assert.doesNotMatch(html, /com ressalva/i);
  });

  test("minDetectableLiftRelative ausente (fixture legado sem o campo) → trata como bem-powered, preserva comportamento anterior ao #4559", () => {
    const table: AbcAudienceTable = {
      cells: [cellWithClicks("A", 400, 2000), cellWithClicks("B", 100, 2000), { ...cellWithClicks("C", 0, 2000), campaignCount: 0 }],
      leaderOpenRate: "A",
      leaderClickRate: "A",
      significantClick: true,
      pValue: 0.0001,
      // minDetectableLiftRelative omitido de propósito
    };
    const html = renderAbcAudienceTable("Agregada (Fria + Quente)", table);
    assert.match(html, /Já dá pra concluir\./);
  });
});

describe("minDetectableRelativeLift (#4559)", () => {
  test("amostra maior → MDE menor (mais poder pra detectar lifts pequenos)", () => {
    const small = minDetectableRelativeLift(20, 200, 15, 200);
    const large = minDetectableRelativeLift(200, 2000, 150, 2000);
    assert.ok(large < small, `amostra 10x maior deveria ter MDE menor (${large} vs ${small})`);
  });

  test("n1 ou n2 = 0 → Infinity (indeterminado)", () => {
    assert.equal(minDetectableRelativeLift(10, 0, 5, 100), Infinity);
    assert.equal(minDetectableRelativeLift(10, 100, 5, 0), Infinity);
  });

  test("taxa pooled degenerada (0 cliques nos 2 braços) → Infinity", () => {
    assert.equal(minDetectableRelativeLift(0, 100, 0, 100), Infinity);
  });
});
