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
  pickTopWeekdays,
  aggregateByWeekday,
  renderTopWeekdaysSection,
  type WeekdaySummary,
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

function makeCampaign(
  id: number,
  name: string,
  sentDate: string,
  gsOverrides: Parameters<typeof makeGlobalStats>[0] = {},
  listName: string = `List ${id}`,
) {
  return {
    id,
    name,
    subject: "Test",
    status: "sent",
    sentDate,
    scheduledAt: sentDate,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    listName,
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
    assert.equal(classifyClariceAudience("Diar.ia Mensal 2604 — 2026-05-14 19:26"), null);
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
});

// ─── #3128: classificação por listName quando o nome da CAMPANHA não basta ───
//
// Regressão do bug real do ciclo 2606-07: 3 dos 4 envios reais foram pra
// audiência FRIA, mas a campanha em si foi nomeada IDÊNTICO ao padrão quente
// ("Clarice News 2606-07 — X · dia"), sem nenhum "cold" no nome da campanha.
// Só o nome da LISTA de destinatários sinalizava frio. Nomes/listas abaixo
// são os REAIS do ciclo (não inventados), confirmados via Brevo API.
describe("parseAbcAudienceCampaign — classificação por listName (#3128)", () => {
  test("campanha com naming quente + lista fria 'cold {ciclo} {dia}-{cell}' → audience cold", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — A · sab", "cold 2606-07 sab-A");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "A", audience: "cold" });
  });

  test("campanha com naming quente + lista fria '{ciclo} cold {dN}' (sem célula na lista) → audience cold", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — B · ter", "2606-07 cold d1");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "B", audience: "cold" });
  });

  test("campanha com naming quente + lista genuinamente quente → audience warm (inalterado)", () => {
    const parsed = parseAbcAudienceCampaign(
      "Clarice News 2606-07 — C: Notícias do mês sobre IA: Soberania, seg…",
      "Clarice News 2606-07 C (A/B/C assunto)",
    );
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "C", audience: "warm" });
  });

  test("listName omitido → warm (comportamento antigo preservado, backward-compatible)", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — A · sab");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "A", audience: "warm" });
  });

  test("listName undefined explícito → mesmo resultado que omitido (warm)", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — A · sab", undefined);
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "A", audience: "warm" });
  });

  test("listName string vazia → warm (falsy, não quebra)", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — A · sab", "");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "A", audience: "warm" });
  });

  test("'cold' como substring de outra palavra na lista NÃO deve disparar falso positivo (word-boundary safe)", () => {
    const parsed = parseAbcAudienceCampaign("Clarice News 2606-07 — A · sab", "Recoldar 2606-07 sab-A");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "A", audience: "warm" });
  });

  test("naming cold-por-campanha (branch legado) continua funcionando mesmo passando listName", () => {
    const parsed = parseAbcAudienceCampaign("cold 2606-07 — B: subject B", "qualquer lista");
    assert.deepEqual(parsed, { cycle: "2606-07", cell: "B", audience: "cold" });
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
});

// ─── #3128: aggregateAbcByAudience com o naming REAL do ciclo 2606-07 ────────
//
// Diferente do describe acima (que usa o naming "cold {ciclo} — {cell}: ..."
// — cold sinalizado no NOME DA CAMPANHA), este bloco reproduz o naming que
// REALMENTE causou o bug: campanha nomeada IGUAL ao padrão quente pras 2
// audiências — só a lista de destinatários distingue. Antes do fix (#3128),
// TODOS esses envios (cold e warm) caíam no branch "warm" de
// `parseAbcAudienceCampaign`, e a tabela "Fria" ficava com `campaignCount: 0`
// em todas as células enquanto "Quente" replicava os números da "Agregada".
describe("aggregateAbcByAudience — naming real do ciclo 2606-07, cold só na lista (#3128)", () => {
  const cycle = "2606-07";
  // 3 dos 4 envios reais do ciclo foram frios — campanha "Clarice News
  // 2606-07 — X · dia", lista "cold 2606-07 {dia}-{X}" (nomes reais, via API).
  const coldRealNaming = [
    makeCampaign(21, "Clarice News 2606-07 — A · sab", "2026-07-05T09:00:00Z", {
      sent: 2000, delivered: 1980, uniqueViews: 300, uniqueClicks: 20,
    }, "cold 2606-07 sab-A"),
    makeCampaign(22, "Clarice News 2606-07 — B · sab", "2026-07-05T09:01:00Z", {
      sent: 2000, delivered: 1980, uniqueViews: 250, uniqueClicks: 60,
    }, "cold 2606-07 sab-B"),
    makeCampaign(23, "Clarice News 2606-07 — C · sab", "2026-07-05T09:02:00Z", {
      sent: 2000, delivered: 1980, uniqueViews: 200, uniqueClicks: 15,
    }, "cold 2606-07 sab-C"),
  ];
  // O 4º envio real (o teste A/B/C de assunto) foi genuinamente quente —
  // campanha E lista seguem "Clarice News 2606-07 ... (A/B/C assunto)".
  const warmRealNaming = [
    makeCampaign(24, "Clarice News 2606-07 — A: Notícias do mês sobre IA: Brasil, Anthro…", "2026-07-03T06:00:00Z", {
      sent: 1500, delivered: 1490, uniqueViews: 900, uniqueClicks: 150,
    }, "Clarice News 2606-07 A (A/B/C assunto)"),
    makeCampaign(25, "Clarice News 2606-07 — B: Notícias do mês sobre IA: O mês em que o…", "2026-07-03T06:01:00Z", {
      sent: 1500, delivered: 1490, uniqueViews: 850, uniqueClicks: 100,
    }, "Clarice News 2606-07 B (A/B/C assunto)"),
    makeCampaign(26, "Clarice News 2606-07 — C: Notícias do mês sobre IA: Soberania, seg…", "2026-07-03T06:02:00Z", {
      sent: 1500, delivered: 1490, uniqueViews: 800, uniqueClicks: 90,
    }, "Clarice News 2606-07 C (A/B/C assunto)"),
  ];

  test("Fria captura os 3 envios reais frios (antes do fix: ficava vazia)", () => {
    const result = aggregateAbcByAudience([...coldRealNaming, ...warmRealNaming], cycle);
    assert.ok(result.cold.cells.some((c) => c.campaignCount > 0), "Fria não deveria estar vazia");
    const coldA = result.cold.cells.find((c) => c.cell === "A")!;
    const coldB = result.cold.cells.find((c) => c.cell === "B")!;
    const coldC = result.cold.cells.find((c) => c.cell === "C")!;
    assert.equal(coldA.delivered, 1980);
    assert.equal(coldA.clicks, 20);
    assert.equal(coldB.delivered, 1980);
    assert.equal(coldB.clicks, 60);
    assert.equal(coldC.delivered, 1980);
    assert.equal(coldC.clicks, 15);
  });

  test("Quente contém só os envios genuinamente quentes (antes do fix: igual à Agregada)", () => {
    const result = aggregateAbcByAudience([...coldRealNaming, ...warmRealNaming], cycle);
    const warmA = result.warm.cells.find((c) => c.cell === "A")!;
    assert.equal(warmA.delivered, 1490);
    assert.equal(warmA.clicks, 150);
    // Quente NUNCA deve somar os 2000/1980 dos envios frios reais.
    const warmTotalDelivered = result.warm.cells.reduce((sum, c) => sum + c.delivered, 0);
    assert.equal(warmTotalDelivered, 1490 * 3);
  });

  test("Fria e Quente não têm os mesmos números — o sintoma central do bug (#3128)", () => {
    const result = aggregateAbcByAudience([...coldRealNaming, ...warmRealNaming], cycle);
    const coldDelivered = result.cold.cells.map((c) => c.delivered);
    const warmDelivered = result.warm.cells.map((c) => c.delivered);
    assert.notDeepEqual(coldDelivered, warmDelivered);
    // Quente não pode ser igual à Agregada quando existem envios frios reais.
    const aggDelivered = result.aggregate.cells.map((c) => c.delivered);
    assert.notDeepEqual(warmDelivered, aggDelivered);
  });

  test("Agregada soma fria + quente corretamente", () => {
    const result = aggregateAbcByAudience([...coldRealNaming, ...warmRealNaming], cycle);
    const aggA = result.aggregate.cells.find((c) => c.cell === "A")!;
    assert.equal(aggA.delivered, 1980 + 1490);
    assert.equal(aggA.clicks, 20 + 150);
  });
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
