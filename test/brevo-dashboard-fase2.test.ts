/**
 * test/brevo-dashboard-fase2.test.ts (#2086, #2134)
 *
 * Testes unitários para os helpers de agregação da Fase 2 mínima:
 *  - parseClariceCampaignKey
 *  - aggregateAbcSummary
 *  - calcCumulativeSent
 *  - detectActiveCycle
 *  - buildTrendRows
 *  - renderAbcSection / renderTrendSection (smoke de HTML)
 *  - weekdayKeyBRT / aggregateByWeekday / renderWeekdaySection (#2134)
 *
 * Todos os helpers são funções puras exportadas de workers/brevo-dashboard/src/index.ts.
 * Não requerem mock de rede — usam fixtures locais do shape real da Brevo API.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SENDS as EDITION_SENDS } from "../scripts/clarice-build-edition-sends.ts";
import {
  parseClariceCampaignKey,
  aggregateAbcSummary,
  calcCumulativeSent,
  detectActiveCycle,
  buildTrendRows,
  renderAbcSection,
  renderVolumeSection,
  renderTrendSection,
  renderDashboardHtml,
  CLARICE_PLAN_TOTAL,
  CLARICE_PLAN_S1,
  weekdayKeyBRT,
  aggregateByWeekday,
  renderWeekdaySection,
  WEEKDAY_LABELS,
} from "../workers/brevo-dashboard/src/index.ts";

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
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    listName: `List ${id}`,
    listSize: 100,
    statistics: {
      globalStats: makeGlobalStats(gsOverrides),
    },
  };
}

/** Campanhas representativas do ciclo 2605 (Clarice News) */
const cycle2605Campaigns = [
  makeCampaign(38, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:05:00Z", { sent: 117, delivered: 115, uniqueViews: 20, trackableViews: 11, appleMppOpens: 8 }),
  makeCampaign(39, "Clarice News 2605 d01-B (qua)", "2026-06-10T09:06:00Z", { sent: 117, delivered: 117, uniqueViews: 32, trackableViews: 21, appleMppOpens: 11 }),
  makeCampaign(40, "Clarice News 2605 d01-C (qua)", "2026-06-10T09:03:00Z", { sent: 116, delivered: 115, uniqueViews: 30, trackableViews: 21, appleMppOpens: 10 }),
  makeCampaign(41, "Clarice News 2605 d02-A (qui)", "2026-06-11T09:35:00Z", { sent: 184, delivered: 182, uniqueViews: 35, trackableViews: 26, appleMppOpens: 7 }),
  makeCampaign(42, "Clarice News 2605 d02-B (qui)", "2026-06-11T09:14:00Z", { sent: 183, delivered: 182, uniqueViews: 39, trackableViews: 30, appleMppOpens: 6 }),
  makeCampaign(43, "Clarice News 2605 d02-C (qui)", "2026-06-11T09:14:00Z", { sent: 183, delivered: 183, uniqueViews: 30, trackableViews: 19, appleMppOpens: 7 }),
];

/** Campanhas T1 (digest mensal) — não são Clarice News */
const t1Campaigns = [
  makeCampaign(29, "Diar.ia Mensal 2604 [list 9 W1] — 2026-05-08 19:24", "2026-05-08T22:24:00Z", { sent: 50, delivered: 48, uniqueViews: 26, trackableViews: 14, appleMppOpens: 7 }),
  makeCampaign(34, "Diar.ia Mensal 2604 — 2026-05-14 19:26", "2026-05-15T09:48:00Z", { sent: 300, delivered: 297, uniqueViews: 138, trackableViews: 93, appleMppOpens: 44 }),
];

const allCampaigns = [...cycle2605Campaigns, ...t1Campaigns];

// ─── parseClariceCampaignKey ──────────────────────────────────────────────────

describe("parseClariceCampaignKey", () => {
  test("parseia d01-A corretamente", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d01-A (qua)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 1, cell: "A" });
  });

  test("parseia d02-C corretamente", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d02-C (qui)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 2, cell: "C" });
  });

  test("parseia d07-B — último dia S1", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d07-B (ter)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 7, cell: "B" });
  });

  test("parseia d08-A — dia S2 (dayNum > 7, fora do S1)", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d08-A (qua)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 8, cell: "A" });
  });

  test("retorna null para campanha T1", () => {
    assert.equal(parseClariceCampaignKey("Diar.ia Mensal 2604 [list 9 W1] — 2026-05-08"), null);
  });

  // Regressões #2124 — item 1: sufixo pós-célula opcional + normalização uppercase
  test("parseia nome SEM sufixo de dia-da-semana (sufixo opcional #2124)", () => {
    // Nome sem espaço+sufixo após [ABC] — antes do fix: retornava null silenciosamente
    const r = parseClariceCampaignKey("Clarice News 2605 d03-B");
    assert.deepEqual(r, { cycle: "2605", dayNum: 3, cell: "B" });
  });

  test("parseia nome com célula em minúscula (flag /i + toUpperCase #2124)", () => {
    // Flag /i aceita lowercase, mas o cast precisava de normalização
    const r = parseClariceCampaignKey("Clarice News 2605 d04-a (sex)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 4, cell: "A" });
  });

  test("parseia nome com célula lowercase sem sufixo (#2124)", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d05-c");
    assert.deepEqual(r, { cycle: "2605", dayNum: 5, cell: "C" });
  });
});

// ─── aggregateAbcSummary ──────────────────────────────────────────────────────

describe("aggregateAbcSummary", () => {
  test("agrega open rate por célula corretamente (fixtures reais d01+d02)", () => {
    const result = aggregateAbcSummary(allCampaigns, "2605");
    const a = result.find((r) => r.cell === "A")!;
    const b = result.find((r) => r.cell === "B")!;
    const c = result.find((r) => r.cell === "C")!;

    // A: d01-A (20 views / 115 del) + d02-A (35 views / 182 del) = 55/297
    assert.equal(a.totalViews, 20 + 35);
    assert.equal(a.totalDelivered, 115 + 182);
    assert.ok(Math.abs(a.openRate - (55 / 297) * 100) < 0.01, `A openRate deve ser ~18.5% mas foi ${a.openRate}`);
    assert.equal(a.campaignCount, 2);

    // B: d01-B (32 views / 117 del) + d02-B (39 views / 182 del) = 71/299
    assert.equal(b.totalViews, 32 + 39);
    assert.equal(b.totalDelivered, 117 + 182);
    assert.ok(Math.abs(b.openRate - (71 / 299) * 100) < 0.01);
    assert.equal(b.campaignCount, 2);

    // C: d01-C (30 views / 115 del) + d02-C (30 views / 183 del) = 60/298
    assert.equal(c.totalViews, 30 + 30);
    assert.equal(c.totalDelivered, 115 + 183);
    assert.equal(c.campaignCount, 2);
  });

  test("retorna sempre as 3 células mesmo com ciclo sem dados", () => {
    const result = aggregateAbcSummary(allCampaigns, "9999");
    assert.equal(result.length, 3);
    for (const r of result) {
      assert.equal(r.totalViews, 0);
      assert.equal(r.totalDelivered, 0);
      assert.equal(r.openRate, 0);
      assert.equal(r.campaignCount, 0);
    }
  });

  test("exclui dias S2 (dayNum > 7) da agregação S1", () => {
    const s2Campaign = makeCampaign(50, "Clarice News 2605 d08-A (qui)", "2026-06-12T09:00:00Z",
      { sent: 200, delivered: 198, uniqueViews: 50 });
    const result = aggregateAbcSummary([...cycle2605Campaigns, s2Campaign], "2605");
    const a = result.find((r) => r.cell === "A")!;
    // d08-A NÃO deve entrar: só d01-A e d02-A (count=2, não 3)
    assert.equal(a.campaignCount, 2);
    assert.equal(a.totalViews, 20 + 35); // apenas d01-A + d02-A
  });

  test("exclui campanhas T1 (não Clarice News) da agregação", () => {
    const result = aggregateAbcSummary(t1Campaigns, "2604");
    // T1 campaigns não casam com parseClariceCampaignKey → count 0
    assert.ok(result.every((r) => r.campaignCount === 0));
  });

  test("exclui stats zeradas (gs.sent = 0)", () => {
    const zeroStatsCampaign = {
      ...makeCampaign(99, "Clarice News 2605 d03-A (sex)", "2026-06-13T09:00:00Z"),
      statistics: {
        globalStats: makeGlobalStats({ sent: 0, delivered: 0, uniqueViews: 0 }),
      },
    };
    const result = aggregateAbcSummary([...cycle2605Campaigns, zeroStatsCampaign], "2605");
    const a = result.find((r) => r.cell === "A")!;
    // d03-A com sent=0 não deve entrar
    assert.equal(a.campaignCount, 2); // só d01-A e d02-A
  });

  // Regressão #2252: a seção A/B/C inteira sumia quando o GET individual de
  // globalStats falhava (429 transiente) pras campanhas S1 — aggregateAbcSummary
  // era o único agregador de ciclo SEM fallback pra campaignStats[0]. Volume
  // continuava (tem fallback), A/B/C sumia → sintoma assimétrico.
  test("usa campaignStats[0] quando globalStats fetch falhou (fallback #2252)", () => {
    const csOnlyCampaign = {
      ...makeCampaign(60, "Clarice News 2605 d03-B (sex)", "2026-06-13T09:00:00Z"),
      statistics: {
        campaignStats: [{
          listId: 160, sent: 200, delivered: 198,
          hardBounces: 1, softBounces: 1, deferred: 0,
          uniqueViews: 50, viewed: 60, trackableViews: 30,
          uniqueClicks: 5, clickers: 5, unsubscriptions: 0, complaints: 0,
        }],
        globalStats: undefined,
      },
    };
    const result = aggregateAbcSummary([csOnlyCampaign], "2605");
    const b = result.find((r) => r.cell === "B")!;
    assert.equal(b.campaignCount, 1, "campanha com só campaignStats deve entrar no agregado");
    assert.equal(b.totalViews, 50, "deve usar campaignStats.uniqueViews");
    assert.equal(b.totalDelivered, 198, "deve usar campaignStats.delivered");
    assert.ok(Math.abs(b.openRate - (50 / 198) * 100) < 0.01, `openRate esperado ~25.3% mas foi ${b.openRate}`);
  });

  // Sanidade do fallback: globalStats real (sent>0) tem precedência sobre campaignStats.
  test("globalStats real tem precedência sobre campaignStats (#2252)", () => {
    const bothCampaign = {
      ...makeCampaign(61, "Clarice News 2605 d03-C (sex)", "2026-06-13T09:00:00Z", {
        sent: 100, delivered: 99, uniqueViews: 40,
      }),
      statistics: {
        campaignStats: [{
          listId: 161, sent: 100, delivered: 99,
          hardBounces: 0, softBounces: 0, deferred: 0,
          uniqueViews: 10, viewed: 12, trackableViews: 8, // ← valor "errado" do campaignStats
          uniqueClicks: 1, clickers: 1, unsubscriptions: 0, complaints: 0,
        }],
        globalStats: makeGlobalStats({ sent: 100, delivered: 99, uniqueViews: 40 }),
      },
    };
    const result = aggregateAbcSummary([bothCampaign], "2605");
    const c = result.find((r) => r.cell === "C")!;
    assert.equal(c.totalViews, 40, "deve preferir globalStats.uniqueViews (40), não campaignStats (10)");
  });
});

// ─── calcCumulativeSent ───────────────────────────────────────────────────────

describe("calcCumulativeSent", () => {
  test("soma sent de todas as campanhas Clarice News do ciclo", () => {
    const total = calcCumulativeSent(cycle2605Campaigns, "2605");
    // sent: 117 + 117 + 116 + 184 + 183 + 183 = 900
    assert.equal(total, 117 + 117 + 116 + 184 + 183 + 183);
  });

  test("ignora campanhas T1 (não são Clarice News do ciclo)", () => {
    const total = calcCumulativeSent(allCampaigns, "2605");
    assert.equal(total, 117 + 117 + 116 + 184 + 183 + 183);
  });

  test("retorna 0 para ciclo sem campanhas", () => {
    assert.equal(calcCumulativeSent(allCampaigns, "9999"), 0);
  });

  test("usa campaignStats[0].sent quando globalStats fetch falhou (fallback)", () => {
    // Campanha com campaignStats mas sem globalStats (ex: fetch individual falhou)
    const csOnlyCampaign = {
      ...makeCampaign(50, "Clarice News 2605 d03-A (sex)", "2026-06-13T09:00:00Z"),
      statistics: {
        campaignStats: [{
          listId: 150, sent: 200, delivered: 198,
          hardBounces: 1, softBounces: 1, deferred: 0,
          uniqueViews: 50, viewed: 60, trackableViews: 30,
          uniqueClicks: 5, clickers: 5, unsubscriptions: 0, complaints: 0,
        }],
        globalStats: undefined,
      },
    };
    const total = calcCumulativeSent([csOnlyCampaign], "2605");
    assert.equal(total, 200, "deve somar sent do campaignStats quando globalStats ausente");
  });

  test("CLARICE_PLAN_TOTAL é 40000", () => {
    assert.equal(CLARICE_PLAN_TOTAL, 40_000);
  });

  test("CLARICE_PLAN_S1 é 5600", () => {
    assert.equal(CLARICE_PLAN_S1, 5_600);
  });

  // #2125: drift test — CLARICE_PLAN_TOTAL e CLARICE_PLAN_S1 não devem driftar de SENDS.
  // Se o plano for ajustado (volumes no array SENDS), estas constantes hardcoded no
  // dashboard devem ser atualizadas na mesma mudança. Este teste fará o CI falhar caso
  // o editor atualize SENDS mas esqueça de sincronizar as constantes do dashboard.
  test("CLARICE_PLAN_TOTAL não drifta de SENDS.volume total (#2125)", () => {
    const totalFromSends = EDITION_SENDS.reduce((acc, s) => acc + s.volume, 0);
    assert.equal(
      CLARICE_PLAN_TOTAL,
      totalFromSends,
      `CLARICE_PLAN_TOTAL (${CLARICE_PLAN_TOTAL}) driftou de SENDS total (${totalFromSends}) — ` +
      "atualize a constante em workers/brevo-dashboard/src/index.ts",
    );
  });

  test("CLARICE_PLAN_S1 não drifta de SENDS semana 1 total (#2125)", () => {
    const s1FromSends = EDITION_SENDS.filter((s) => s.week === 1).reduce((acc, s) => acc + s.volume, 0);
    assert.equal(
      CLARICE_PLAN_S1,
      s1FromSends,
      `CLARICE_PLAN_S1 (${CLARICE_PLAN_S1}) driftou de SENDS S1 total (${s1FromSends}) — ` +
      "atualize a constante em workers/brevo-dashboard/src/index.ts",
    );
  });
});

// ─── detectActiveCycle ────────────────────────────────────────────────────────

describe("detectActiveCycle", () => {
  test("detecta 2605 como ciclo ativo (mais recente)", () => {
    assert.equal(detectActiveCycle(allCampaigns), "2605");
  });

  test("retorna null quando lista vazia", () => {
    assert.equal(detectActiveCycle([]), null);
  });

  test("retorna null quando só há campanhas T1", () => {
    assert.equal(detectActiveCycle(t1Campaigns), null);
  });

  test("prefere o ciclo lexicograficamente maior", () => {
    const mixed = [
      makeCampaign(1, "Clarice News 2604 d01-A (seg)", "2026-05-01T09:00:00Z"),
      makeCampaign(2, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z"),
    ];
    assert.equal(detectActiveCycle(mixed), "2605");
  });
});

// ─── buildTrendRows ───────────────────────────────────────────────────────────

describe("buildTrendRows", () => {
  test("ordena por sentDate DESC — mais recente no topo (editor 2026-06-11)", () => {
    const rows = buildTrendRows(allCampaigns);
    // Primeira linha = envio mais RECENTE; última = mais antiga (T1-W1).
    assert.ok(rows.length >= 2);
    const first = rows[0];
    const last = rows[rows.length - 1];
    const firstDate = first.sentDate ? Date.parse(first.sentDate) : 0;
    const lastDate = last.sentDate ? Date.parse(last.sentDate) : 0;
    assert.ok(firstDate >= lastDate, "primeira linha deve ser a mais recente");
  });

  test("label de Clarice News é compacto (ex: '2605 d01-A')", () => {
    const rows = buildTrendRows(cycle2605Campaigns);
    const clariceRows = rows.filter((r) => r.label.startsWith("2605"));
    assert.ok(clariceRows.length > 0, "deve ter rows com label 2605 dXX-Y");
    for (const r of clariceRows) {
      assert.match(r.label, /2605 d\d{2}-[ABC]/, `label '${r.label}' deve ter formato '2605 dNN-Y'`);
    }
  });

  test("label de Mensal inclui 'Mensal' e o ciclo", () => {
    const rows = buildTrendRows(t1Campaigns);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.match(r.label, /Mensal 2604/, `label '${r.label}' deve conter 'Mensal 2604'`);
    }
  });

  test("calcula openRate e bounceRate corretamente", () => {
    const campaign = makeCampaign(1, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z",
      { sent: 100, delivered: 98, uniqueViews: 30, hardBounces: 2, softBounces: 1 });
    const rows = buildTrendRows([campaign]);
    assert.equal(rows.length, 1);
    // openRate = 30/98 * 100 ≈ 30.61%
    assert.ok(Math.abs(rows[0].openRate - (30 / 98) * 100) < 0.01);
    // bounceRate = 3/100 * 100 = 3%
    assert.ok(Math.abs(rows[0].bounceRate - 3.0) < 0.01);
  });

  test("exclui campanhas sem sentDate", () => {
    const noDate = { ...makeCampaign(99, "Clarice News 2605 d05-A (seg)", ""), sentDate: null };
    const rows = buildTrendRows([...cycle2605Campaigns, noDate]);
    const noDateRow = rows.find((r) => r.label === "2605 d05-A");
    assert.equal(noDateRow, undefined, "campanha sem sentDate não deve aparecer na trend");
  });

  test("exclui campanhas sem stats reais (sent=0)", () => {
    const zeroStats = {
      ...makeCampaign(99, "Clarice News 2605 d05-A (seg)", "2026-06-15T09:00:00Z"),
      statistics: { globalStats: makeGlobalStats({ sent: 0, delivered: 0, uniqueViews: 0 }) },
    };
    const rows = buildTrendRows([...cycle2605Campaigns, zeroStats]);
    const zeroRow = rows.find((r) => r.label === "2605 d05-A");
    assert.equal(zeroRow, undefined, "campanha com sent=0 não deve aparecer na trend");
  });
});

// ─── renderAbcSection ─────────────────────────────────────────────────────────

describe("renderAbcSection", () => {
  test("retorna string vazia quando todos os campaignCounts são 0", () => {
    const emptyRows = [
      { cell: "A" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0 },
      { cell: "B" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0 },
      { cell: "C" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0 },
    ];
    assert.equal(renderAbcSection(emptyRows), "");
  });

  test("contém as 3 células no HTML", () => {
    const rows = aggregateAbcSummary(cycle2605Campaigns, "2605");
    const html = renderAbcSection(rows);
    assert.match(html, /Célula A/);
    assert.match(html, /Célula B/);
    assert.match(html, /Célula C/);
  });

  test("ordena células do melhor pro pior open rate", () => {
    const ordered = [
      { cell: "A" as const, totalViews: 60, totalDelivered: 200, openRate: 30.0, campaignCount: 2 },
      { cell: "B" as const, totalViews: 100, totalDelivered: 200, openRate: 50.0, campaignCount: 2 },
      { cell: "C" as const, totalViews: 80, totalDelivered: 200, openRate: 40.0, campaignCount: 2 },
    ];
    const html = renderAbcSection(ordered);
    const posB = html.indexOf("Célula B");
    const posC = html.indexOf("Célula C");
    const posA = html.indexOf("Célula A");
    assert.ok(posB < posC && posC < posA, "ordem B(50) > C(40) > A(30)");
  });

  test("marca vencedor provisório quando ≥2 células têm dados (e uma lidera)", () => {
    const rows = aggregateAbcSummary(cycle2605Campaigns, "2605");
    const html = renderAbcSection(rows);
    // Deve ter exatamente 1 LÍDER (a célula com maior open rate)
    const liderCount = (html.match(/LÍDER/g) ?? []).length;
    assert.equal(liderCount, 1, "deve mostrar exatamente 1 tag LÍDER");
  });

  test("empate: nenhuma célula recebe LÍDER quando duas têm open rate igual", () => {
    const tiedRows = [
      { cell: "A" as const, totalViews: 100, totalDelivered: 200, openRate: 50.0, campaignCount: 2 },
      { cell: "B" as const, totalViews: 100, totalDelivered: 200, openRate: 50.0, campaignCount: 2 },
      { cell: "C" as const, totalViews: 80, totalDelivered: 200, openRate: 40.0, campaignCount: 2 },
    ];
    const html = renderAbcSection(tiedRows);
    const liderCount = (html.match(/LÍDER/g) ?? []).length;
    assert.equal(liderCount, 0, "empate: nenhum LÍDER deve ser exibido");
    assert.match(html, /Empate/, "deve mostrar texto de empate");
  });

  test("3-way tie: nenhuma célula recebe LÍDER", () => {
    const tiedRows = [
      { cell: "A" as const, totalViews: 100, totalDelivered: 200, openRate: 50.0, campaignCount: 2 },
      { cell: "B" as const, totalViews: 100, totalDelivered: 200, openRate: 50.0, campaignCount: 2 },
      { cell: "C" as const, totalViews: 100, totalDelivered: 200, openRate: 50.0, campaignCount: 2 },
    ];
    const html = renderAbcSection(tiedRows);
    const liderCount = (html.match(/LÍDER/g) ?? []).length;
    assert.equal(liderCount, 0, "3-way tie: nenhum LÍDER deve ser exibido");
    assert.match(html, /Empate/, "deve mostrar texto de empate");
  });

  test("contém id='abc-summary' para âncora", () => {
    const rows = aggregateAbcSummary(cycle2605Campaigns, "2605");
    const html = renderAbcSection(rows);
    assert.match(html, /id="abc-summary"/);
  });

  // Regressão #2124 — item 3: todas as células com openRate 0 → "aguardando dados"
  test("all-zero openRate exibe 'aguardando dados' (não 'Empate...0.0%') (#2124)", () => {
    // Cenário: campanhas enviadas mas sem nenhuma abertura registrada ainda
    // (primeiras horas pós-envio — dados de abertura chegam com delay).
    const zeroRows = [
      { cell: "A" as const, totalViews: 0, totalDelivered: 100, openRate: 0, campaignCount: 1 },
      { cell: "B" as const, totalViews: 0, totalDelivered: 100, openRate: 0, campaignCount: 1 },
      { cell: "C" as const, totalViews: 0, totalDelivered: 100, openRate: 0, campaignCount: 1 },
    ];
    const html = renderAbcSection(zeroRows);
    // Não deve exibir "Empate...0.0%" — confuso e inútil antes de qualquer abertura
    assert.doesNotMatch(html, /Empate.*0\.0%/, "não deve mostrar 'Empate...0.0%' quando todos zero");
    // Deve exibir aviso de aguardando dados
    assert.match(html, /[Aa]guardando dados/, "deve mostrar 'aguardando dados' quando openRate todo zero");
    // Nenhuma célula deve receber LÍDER
    const liderCount = (html.match(/LÍDER/g) ?? []).length;
    assert.equal(liderCount, 0, "sem LÍDER quando openRate todo zero");
  });

  test("empate com openRate > 0 continua mostrando 'Empate' (não confunde com zero) (#2124)", () => {
    // Empate real (taxa igual mas > 0) — deve manter comportamento original
    const tiedNonZero = [
      { cell: "A" as const, totalViews: 50, totalDelivered: 100, openRate: 50.0, campaignCount: 2 },
      { cell: "B" as const, totalViews: 50, totalDelivered: 100, openRate: 50.0, campaignCount: 2 },
      { cell: "C" as const, totalViews: 30, totalDelivered: 100, openRate: 30.0, campaignCount: 2 },
    ];
    const html = renderAbcSection(tiedNonZero);
    assert.match(html, /Empate.*50\.0%/, "empate real deve continuar mostrando 'Empate...50.0%'");
    assert.doesNotMatch(html, /[Aa]guardando dados/, "não deve mostrar 'aguardando dados' em empate real");
  });
});

// ─── renderTrendSection ───────────────────────────────────────────────────────

describe("renderTrendSection", () => {
  test("retorna string vazia quando rows está vazio", () => {
    assert.equal(renderTrendSection([]), "");
  });

  test("contém id='wave-trend' para âncora", () => {
    const rows = buildTrendRows(allCampaigns);
    const html = renderTrendSection(rows);
    assert.match(html, /id="wave-trend"/);
  });

  test("usa class 'alert' para open rate < 15%", () => {
    const rows: Parameters<typeof renderTrendSection>[0] = [
      { label: "Test", sentDate: "2026-06-10T09:00:00Z", openRate: 8, bounceRate: 1, sent: 100, delivered: 98 },
    ];
    const html = renderTrendSection(rows);
    assert.match(html, /class="alert"/, "open 8% deve gerar class alert");
  });

  test("usa class 'alert' para bounce rate ≥ 3%", () => {
    const rows: Parameters<typeof renderTrendSection>[0] = [
      { label: "Test", sentDate: "2026-06-10T09:00:00Z", openRate: 25, bounceRate: 3.5, sent: 100, delivered: 96 },
    ];
    const html = renderTrendSection(rows);
    assert.match(html, /class="alert"/, "bounce 3.5% deve gerar class alert");
  });

  test("NÃO usa class alert quando métricas saudáveis", () => {
    const rows: Parameters<typeof renderTrendSection>[0] = [
      { label: "Test", sentDate: "2026-06-10T09:00:00Z", openRate: 25, bounceRate: 1, sent: 100, delivered: 99 },
    ];
    const html = renderTrendSection(rows);
    assert.doesNotMatch(html, /class="alert"/, "métricas saudáveis não devem gerar alerta");
  });
});

// ─── renderDashboardHtml: integração das novas seções ────────────────────────

describe("renderDashboardHtml: integração fase 2 (#2086)", () => {
  const baseCampaign = {
    id: 1,
    name: "Test",
    subject: "Subj",
    status: "sent",
    sentDate: "2026-06-11T09:00:00Z",
    scheduledAt: null,
    createdAt: "2026-06-11T09:00:00Z",
    recipients: { lists: [1] },
    listName: "T1-W1",
    listSize: 50,
    statistics: {
      globalStats: makeGlobalStats({ sent: 50, delivered: 48, uniqueViews: 20, trackableViews: 15 }),
    },
  };

  test("coluna Trackable aparece no header da tabela principal", () => {
    const html = renderDashboardHtml([baseCampaign]);
    assert.match(html, /Trackable/, "deve ter coluna Trackable no header");
  });

  test("coluna Trackable exibe taxa e count na linha de dados", () => {
    const html = renderDashboardHtml([baseCampaign]);
    // trackableRate = 15/48 = 31.25%
    assert.match(html, /31\.3%/, "deve exibir taxa trackable correta (15/48 ≈ 31.3%)");
    // count trackable como <small>
    assert.match(html, /<small>15<\/small>/, "deve exibir count trackableViews=15");
  });

  test("seção abc-summary aparece quando há campanhas Clarice News", () => {
    const html = renderDashboardHtml(cycle2605Campaigns);
    // #2208 (item 4): ancorando em id= para não casar href/nav que pudesse vir antes.
    assert.match(html, /id="abc-summary"/, "deve conter a seção abc-summary com id=");
    assert.match(html, /Resumo A\/B\/C/, "deve ter título 'Resumo A/B/C'");
  });

  test("volume-ciclo vem ANTES de abc-summary (editor 2026-06-11)", () => {
    const html = renderDashboardHtml(cycle2605Campaigns);
    const posVolume = html.indexOf('id="volume-ciclo"');
    const posAbc = html.indexOf('id="abc-summary"');
    assert.ok(posVolume > -1, "deve conter a seção de volume");
    assert.ok(posVolume < posAbc, "volume deve vir antes do resumo A/B/C");
  });

  test("seção wave-trend aparece com campanhas", () => {
    const html = renderDashboardHtml(allCampaigns);
    // #2208 (item 4): ancorando em id= para não casar substring em outro contexto.
    assert.match(html, /id="wave-trend"/, "deve conter a seção wave-trend com id=");
    assert.match(html, /Tend.ncia entre waves/, "deve ter título da seção");
  });

  test("sem campanhas Clarice News: seção abc-summary ausente", () => {
    const html = renderDashboardHtml(t1Campaigns);
    // #2208 (item 4): verificar ausência do id= específico, não de qualquer substring.
    assert.doesNotMatch(html, /id="abc-summary"/, "seção abc deve estar ausente sem Clarice News");
  });

  test("colspan da linha 'sem stats' atualizado para 7 (11 colunas - 4 fixas)", () => {
    // Após adicionar coluna Trackable, tabela tem 11 colunas. colspan deve ser 7 (era 6).
    // Colunas fixas: ID(1) + Lista(2) + Enviado(3) + "—"(4) = 4. Métricas = 7. Total = 11.
    const noStatsCampaign = {
      id: 99,
      name: "No stats",
      subject: "Subj",
      status: "sent",
      sentDate: "2026-06-11T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-06-11T09:00:00Z",
      recipients: { lists: [1] },
      listName: "T1-W2",
      listSize: 30,
    };
    const html = renderDashboardHtml([noStatsCampaign]);
    assert.match(html, /colspan="7"/, "linha 'sem stats' deve ter colspan=7 (tabela tem 11 colunas, 4 fixas + 7 de métricas)");
  });

  test("existentes: tabela de campanhas tem 11 colunas no header", () => {
    const html = renderDashboardHtml([baseCampaign]);
    // Extrair só a seção de campanhas (entre id="campaigns-table" e o próximo <section)
    const tableSection = html.match(/id="campaigns-table"[\s\S]*?<\/section>/)?.[0] ?? "";
    const thCount = (tableSection.match(/<th /g) || []).length;
    // 11 colunas: ID, Lista, Enviado, Sent, Delivered, Opens, Clicks, Trackable, Bounces, Unsub, Spam
    assert.equal(thCount, 11, `tabela de campanhas deve ter 11 <th> mas encontrou ${thCount}`);
  });

  test("seção weekday-openrate aparece quando há campanhas Clarice News (#2134)", () => {
    const html = renderDashboardHtml(cycle2605Campaigns);
    // #2208 (item 4): ancorando em id= para não casar substring em outro contexto.
    assert.match(html, /id="weekday-openrate"/, "deve conter a seção weekday-openrate com id=");
    assert.match(html, /Open rate por dia da semana/, "deve ter título da seção weekday");
  });

  test("seção weekday-openrate posicionada ENTRE abc-summary e campaigns-table (#2134)", () => {
    const html = renderDashboardHtml(cycle2605Campaigns);
    // #2208 (item 4): ancorando em id= para não casar substring de nav/href que
    // pudesse aparecer antes da section real (ex: href="#abc-summary").
    const idxAbc = html.indexOf('id="abc-summary"');
    const idxWeekday = html.indexOf('id="weekday-openrate"');
    const idxCampaigns = html.indexOf('id="campaigns-table"');
    assert.ok(idxAbc > -1, 'deve encontrar id="abc-summary"');
    assert.ok(idxWeekday > -1, 'deve encontrar id="weekday-openrate"');
    assert.ok(idxCampaigns > -1, 'deve encontrar id="campaigns-table"');
    assert.ok(idxAbc < idxWeekday, "weekday-openrate deve vir depois de abc-summary");
    assert.ok(idxWeekday < idxCampaigns, "weekday-openrate deve vir antes de campaigns-table");
  });
});

// ─── weekdayKeyBRT (#2134) ────────────────────────────────────────────────────

describe("weekdayKeyBRT (#2134)", () => {
  test("qua (2026-06-10, BRT) → 2", () => {
    // 2026-06-10T09:05:00Z = 06:05 BRT (quarta). Índice Qua = 2.
    assert.equal(weekdayKeyBRT("2026-06-10T09:05:00Z"), 2);
  });

  test("qui (2026-06-11, BRT) → 3", () => {
    // 2026-06-11T09:14:00Z = 06:14 BRT (quinta). Índice Qui = 3.
    assert.equal(weekdayKeyBRT("2026-06-11T09:14:00Z"), 3);
  });

  // Edge: envio às 23h BRT = 02h UTC do dia seguinte
  test("edge: envio 23h BRT não cai no dia UTC seguinte", () => {
    // 2026-06-10T02:00:00Z = 2026-06-09T23:00 BRT (terça = 1)
    // Em UTC seria 10/jun (quarta = 2). Deve retornar 1 (terça).
    assert.equal(weekdayKeyBRT("2026-06-10T02:00:00Z"), 1);
  });

  test("seg → 0", () => {
    // 2026-06-08 = segunda. 09:00 BRT = 12:00 UTC.
    assert.equal(weekdayKeyBRT("2026-06-08T12:00:00Z"), 0);
  });

  test("dom → 6", () => {
    // 2026-06-14 = domingo. 09:00 BRT = 12:00 UTC.
    assert.equal(weekdayKeyBRT("2026-06-14T12:00:00Z"), 6);
  });

  test("retorna null para ISO inválido", () => {
    assert.equal(weekdayKeyBRT("not-a-date"), null);
  });

  test("retorna null para string vazia", () => {
    assert.equal(weekdayKeyBRT(""), null);
  });
});

// ─── aggregateByWeekday (#2134) ───────────────────────────────────────────────

describe("aggregateByWeekday (#2134)", () => {
  // cycle2605Campaigns: d01 = 2026-06-10 (qua=2), d02 = 2026-06-11 (qui=3)
  // Células A/B/C por dia → por weekday: qua tem 3 campanhas (A+B+C), qui tem 3.

  test("agrega corretamente por weekday para ciclo ativo (qua e qui presentes)", () => {
    const rows = aggregateByWeekday(cycle2605Campaigns, "2605");
    const qua = rows.find((r) => r.weekday === 2); // Qua
    const qui = rows.find((r) => r.weekday === 3); // Qui
    assert.ok(qua, "deve ter linha para Qua");
    assert.ok(qui, "deve ter linha para Qui");
    // d01: A(del=115,views=20) + B(117,32) + C(115,30) = del=347, opens=82
    assert.equal(qua!.count, 3);
    assert.equal(qua!.delivered, 115 + 117 + 115);
    assert.equal(qua!.opens, 20 + 32 + 30);
    // d02: A(182,35) + B(182,39) + C(183,30) = del=547, opens=104
    assert.equal(qui!.count, 3);
    assert.equal(qui!.delivered, 182 + 182 + 183);
    assert.equal(qui!.opens, 35 + 39 + 30);
  });

  test("openRate calculado corretamente (opens / delivered)", () => {
    const rows = aggregateByWeekday(cycle2605Campaigns, "2605");
    const qua = rows.find((r) => r.weekday === 2)!;
    const expectedRate = (82 / 347) * 100;
    assert.ok(Math.abs(qua.openRate - expectedRate) < 0.01,
      `openRate qua deve ser ~${expectedRate.toFixed(2)}% mas foi ${qua.openRate.toFixed(2)}%`);
  });

  test("smallSample=false quando count >= 2", () => {
    const rows = aggregateByWeekday(cycle2605Campaigns, "2605");
    // count=3 pra qua e qui
    for (const r of rows) {
      assert.equal(r.smallSample, false, `weekday ${r.label} com count=${r.count} não deve ser smallSample`);
    }
  });

  test("smallSample=true quando count = 1", () => {
    // Apenas 1 campanha na qua
    const single = [cycle2605Campaigns[0]]; // d01-A (qua)
    const rows = aggregateByWeekday(single, "2605");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].smallSample, true, "count=1 deve ser smallSample");
  });

  test("retorna [] quando ciclo não tem campanhas", () => {
    const rows = aggregateByWeekday(cycle2605Campaigns, "9999");
    assert.equal(rows.length, 0);
  });

  test("filtra ciclo correto (exclui campanhas de outro ciclo)", () => {
    const mixed = [
      ...cycle2605Campaigns,
      makeCampaign(99, "Clarice News 2604 d01-A (qui)", "2026-05-02T09:00:00Z",
        { sent: 500, delivered: 495, uniqueViews: 200 }),
    ];
    const rows = aggregateByWeekday(mixed, "2605");
    // Campanha 2604 não deve entrar — verificar que delivered de Qui é só d02 (2605)
    const qui = rows.find((r) => r.weekday === 3)!;
    assert.equal(qui.delivered, 182 + 182 + 183, "campanha 2604 não deve entrar no ciclo 2605");
  });

  test("usa campaignStats fallback quando globalStats ausente (mesmo fallback do render)", () => {
    const csOnly = {
      ...makeCampaign(77, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z"),
      statistics: {
        campaignStats: [{
          listId: 177, sent: 99, delivered: 97,
          hardBounces: 1, softBounces: 1, deferred: 0,
          uniqueViews: 40, viewed: 45, trackableViews: 30,
          uniqueClicks: 4, clickers: 4, unsubscriptions: 0, complaints: 0,
        }],
        globalStats: undefined,
      },
    };
    const rows = aggregateByWeekday([csOnly], "2605");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivered, 97, "deve usar campaignStats.delivered quando globalStats ausente");
    assert.equal(rows[0].opens, 40, "deve usar campaignStats.uniqueViews quando globalStats ausente");
  });

  test("omite campanhas sem sentDate", () => {
    const noDate = { ...makeCampaign(88, "Clarice News 2605 d01-A (qua)", ""), sentDate: null };
    const rows = aggregateByWeekday([noDate], "2605");
    assert.equal(rows.length, 0, "campanha sem sentDate não deve gerar linha");
  });

  test("omite campanhas com stats zeradas (sent=0)", () => {
    const zeroStats = {
      ...makeCampaign(89, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z"),
      statistics: { globalStats: makeGlobalStats({ sent: 0, delivered: 0, uniqueViews: 0 }) },
    };
    const rows = aggregateByWeekday([zeroStats], "2605");
    assert.equal(rows.length, 0, "campanha com sent=0 não deve gerar linha");
  });

  test("ordena seg→dom mesmo com sentDates fora de ordem", () => {
    // Campanhas: qui (3) antes de seg (0) na lista
    const outOfOrder = [
      makeCampaign(1, "Clarice News 2605 d02-A (qui)", "2026-06-11T09:00:00Z"),
      makeCampaign(2, "Clarice News 2605 d04-A (seg)", "2026-06-15T09:00:00Z"),
    ];
    const rows = aggregateByWeekday(outOfOrder, "2605");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].weekday, 0, "Seg (0) deve vir antes de Qui (3)");
    assert.equal(rows[1].weekday, 3, "Qui (3) deve vir depois de Seg (0)");
  });

  test("labels WEEKDAY_LABELS corretos para todos os índices", () => {
    assert.equal(WEEKDAY_LABELS[0], "Seg");
    assert.equal(WEEKDAY_LABELS[1], "Ter");
    assert.equal(WEEKDAY_LABELS[2], "Qua");
    assert.equal(WEEKDAY_LABELS[3], "Qui");
    assert.equal(WEEKDAY_LABELS[4], "Sex");
    assert.equal(WEEKDAY_LABELS[5], "Sáb");
    assert.equal(WEEKDAY_LABELS[6], "Dom");
  });

  test("cycle=null agrega todas as campanhas (cross-ciclo)", () => {
    // allCampaigns inclui 2605 e T1 (T1 não é Clarice News — filtradas pelo ciclo null)
    // Mas T1 campaigns têm sentDate e stats → devem entrar quando cycle=null
    const rows = aggregateByWeekday(allCampaigns, null);
    assert.ok(rows.length > 0, "deve ter rows quando cycle=null");
    // T1 campaigns: 2026-05-08 (sex=4), 2026-05-15 (sex=4) → devem aparecer
    const sex = rows.find((r) => r.weekday === 4);
    assert.ok(sex, "T1 campaigns enviadas na sexta devem aparecer com cycle=null");
  });
});

// ─── renderWeekdaySection (#2134) ─────────────────────────────────────────────

describe("renderVolumeSection", () => {
  test("vazio nunca — sempre renderiza com barra e plano", () => {
    const html = renderVolumeSection(900);
    assert.match(html, /900/, "deve mostrar 900 enviados");
    assert.match(html, /40.000/, "deve mostrar meta 40.000");
    assert.match(html, /id="volume-ciclo"/, "âncora da seção de volume");
    assert.match(html, /Volume enviado no ciclo/);
  });
});

describe("renderWeekdaySection (#2134)", () => {
  // #2201.4: removido param `overrides` inutilizado — nunca era passado e
  // aggregateByWeekday não aceita overrides por campanha individual.
  function makeRows() {
    return aggregateByWeekday(cycle2605Campaigns, "2605");
  }

  test("retorna string vazia quando rows está vazio", () => {
    assert.equal(renderWeekdaySection([], "ciclo 2605"), "");
  });

  test("ordena dias do melhor pro pior open rate", () => {
    const rows = [
      { weekday: 0, label: "Seg", count: 2, delivered: 100, opens: 20, openRate: 20, smallSample: false },
      { weekday: 2, label: "Qua", count: 2, delivered: 100, opens: 40, openRate: 40, smallSample: false },
      { weekday: 3, label: "Qui", count: 2, delivered: 100, opens: 30, openRate: 30, smallSample: false },
    ];
    const html = renderWeekdaySection(rows, "todos os envios");
    const posQua = html.indexOf(">Qua<");
    const posQui = html.indexOf(">Qui<");
    const posSeg = html.indexOf(">Seg<");
    assert.ok(posQua < posQui && posQui < posSeg, "ordem Qua(40) > Qui(30) > Seg(20)");
  });

  test("contém id='weekday-openrate' para âncora", () => {
    const rows = makeRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");
    assert.match(html, /id="weekday-openrate"/);
  });

  test("contém labels Qua e Qui no HTML (dias das fixtures)", () => {
    const rows = makeRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");
    assert.match(html, /Qua/, "deve ter linha Qua");
    assert.match(html, /Qui/, "deve ter linha Qui");
  });

  test("marca melhor dia com ▲ MELHOR DIA (1 ocorrência quando não há empate)", () => {
    // Qua: openRate=82/347≈23.6%, Qui: openRate=104/547≈19.0% — Qua é melhor
    const rows = makeRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");
    const count = (html.match(/MELHOR DIA/g) ?? []).length;
    assert.equal(count, 1, "deve ter exatamente 1 tag MELHOR DIA");
    // Qua deve ser a linha com MELHOR DIA
    const quaIdx = html.indexOf("Qua");
    const tagIdx = html.indexOf("MELHOR DIA");
    // Tag deve estar na mesma <tr> que Qua (próximo MELHOR DIA depois de Qua)
    assert.ok(tagIdx > quaIdx, "MELHOR DIA deve aparecer depois do label Qua");
  });

  test("empate: nenhum dia recebe MELHOR DIA", () => {
    const tiedRows = [
      { weekday: 2, label: "Qua", count: 2, delivered: 200, opens: 50, openRate: 25.0, smallSample: false },
      { weekday: 3, label: "Qui", count: 2, delivered: 200, opens: 50, openRate: 25.0, smallSample: false },
    ];
    const html = renderWeekdaySection(tiedRows, "ciclo 2605");
    assert.doesNotMatch(html, /MELHOR DIA/, "empate não deve gerar MELHOR DIA");
    assert.match(html, /Empate/, "empate deve mostrar texto de empate");
  });

  test("apenas 1 dia: sem MELHOR DIA (dados insuficientes)", () => {
    // 1 único dia → validRows.length < 2 → nenhum winner
    const single = [
      { weekday: 2, label: "Qua", count: 3, delivered: 347, opens: 82, openRate: 23.6, smallSample: false },
    ];
    const html = renderWeekdaySection(single, "ciclo 2605");
    assert.doesNotMatch(html, /MELHOR DIA/, "1 único dia não deve ter MELHOR DIA");
    assert.match(html, /[Dd]ados insuficientes|insuficiente/,
      "deve mostrar nota de dados insuficientes com 1 dia");
  });

  test("amostra pequena: exibe nota '(amostra pequena)' na linha correta", () => {
    const rowsWithSmall = [
      { weekday: 2, label: "Qua", count: 1, delivered: 98, opens: 20, openRate: 20.4, smallSample: true },
      { weekday: 3, label: "Qui", count: 3, delivered: 295, opens: 70, openRate: 23.7, smallSample: false },
    ];
    const html = renderWeekdaySection(rowsWithSmall, "ciclo 2605");
    assert.match(html, /amostra pequena/, "deve mostrar nota amostra pequena na linha de count=1");
  });

  test("scopeLabel aparece no título da seção", () => {
    const rows = makeRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");
    assert.match(html, /ciclo 2605/, "scopeLabel deve aparecer no título");
  });

  test("usa class metric na coluna open rate (padrão visual do dashboard)", () => {
    const rows = makeRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");
    assert.match(html, /class="metric"/, "open rate deve usar class metric");
  });

  test("all-zero openRate exibe 'aguardando dados' (não 'Empate...0.0%')", () => {
    const zeroRows = [
      { weekday: 2, label: "Qua", count: 2, delivered: 200, opens: 0, openRate: 0, smallSample: false },
      { weekday: 3, label: "Qui", count: 2, delivered: 200, opens: 0, openRate: 0, smallSample: false },
    ];
    const html = renderWeekdaySection(zeroRows, "ciclo 2605");
    assert.doesNotMatch(html, /Empate.*0\.0%/, "não deve mostrar 'Empate 0.0%' quando todos zero");
    assert.match(html, /[Aa]guardando dados/, "deve mostrar 'aguardando dados' quando tudo zero");
  });

  // ─── #2185: coluna Opens + remoção de Sent ────────────────────────────────

  test("#2185 coluna Opens aparece no header", () => {
    const rows = makeRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");
    assert.match(html, /<th[^>]*>Opens<\/th>/, "header deve conter 'Opens'");
  });

  test("#2185 coluna Sent NÃO aparece no header", () => {
    const rows = makeRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");
    // Verifica que não há <th> com texto 'Sent' (pode aparecer em dados de campanha
    // fora desta seção, mas não deve aparecer como header nesta tabela)
    assert.doesNotMatch(html, /<th[^>]*>Sent<\/th>/, "header não deve ter coluna Sent");
  });

  test("#2185 Opens exibe soma correta de uniqueViews por dia (qua=82, qui=104)", () => {
    // cycle2605Campaigns:
    //   Qua d01: A(views=20)+B(32)+C(30) = 82
    //   Qui d02: A(35)+B(39)+C(30) = 104
    const rows = aggregateByWeekday(cycle2605Campaigns, "2605");
    const html = renderWeekdaySection(rows, "ciclo 2605");
    // #2201.2: regex apertada — verifica valor 82/104 em célula <td>, não substring solta.
    assert.match(html, /<td[^>]*>82<\/td>/, "deve mostrar 82 opens para Qua em célula <td>");
    assert.match(html, /<td[^>]*>104<\/td>/, "deve mostrar 104 opens para Qui em célula <td>");
  });

  test("#2185 Open rate permanece inalterado (denominador preserved = delivered)", () => {
    // Open rate = opens / delivered, NÃO usa sent como denominador
    // Qua: 82 opens / 347 delivered ≈ 23.6%
    const rows = aggregateByWeekday(cycle2605Campaigns, "2605");
    const qua = rows.find((r) => r.weekday === 2)!;
    const expectedRate = (82 / 347) * 100;
    assert.ok(Math.abs(qua.openRate - expectedRate) < 0.01,
      `open rate deve ser ${expectedRate.toFixed(2)}% (opens/delivered), foi ${qua.openRate.toFixed(2)}%`);
    // Confirma que a taxa aparece no HTML corretamente
    const html = renderWeekdaySection(rows, "ciclo 2605");
    assert.match(html, /23\.[0-9]%/, "deve exibir a taxa open rate (~23.6%) no HTML");
  });

  test("#2185 graceful: dia sem opens (opens=0) renderiza 0 sem crash", () => {
    const zeroOpens = [
      { weekday: 2, label: "Qua", count: 1, delivered: 98, opens: 0, openRate: 0, smallSample: true },
    ];
    const html = renderWeekdaySection(zeroOpens, "ciclo 2605");
    assert.match(html, /<td>0<\/td>/, "deve renderizar 0 sem crash");
    assert.doesNotMatch(html, /undefined/, "não deve exibir 'undefined'");
  });
});

// ─── Regressão #2198 Bug 2: sent undefined não deve produzir NaN em weekday ───

describe("regressão #2198 Bug 2: aggregateByWeekday exclui campanha com sent undefined", () => {
  test("campanha com sent=undefined é excluída do agregado (sem NaN no openRate)", () => {
    // Bug: guard `s.sent === 0` não cobria `s.sent === undefined`, então a campanha
    // entrava no agregado e openRate = opens/delivered gerava potencial divisão por
    // delivered=0 ou NaN propagado. Fix: `!(s.sent > 0)`.
    const campaignWithUndefinedSent = makeCampaign(99, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:05:00Z",
      { sent: undefined as unknown as number, delivered: 100, uniqueViews: 30 });
    const campaigns = [campaignWithUndefinedSent, ...cycle2605Campaigns];

    const rows = aggregateByWeekday(campaigns, "2605");

    // Nenhuma row deve ter openRate NaN
    for (const row of rows) {
      assert.ok(!isNaN(row.openRate),
        `openRate para ${row.label} não deve ser NaN (foi ${row.openRate})`);
      assert.ok(isFinite(row.openRate),
        `openRate para ${row.label} deve ser finito`);
    }

    // A campanha com sent=undefined deve ter sido excluída do agregado de Qua.
    // Qua sem a campanha inválida: 3 campanhas originais (ids 38,39,40) com delivered 115+117+115=347
    // Se a campanha inválida fosse incluída, delivered seria 347+100=447.
    const qua = rows.find((r) => r.weekday === 2);
    assert.ok(qua, "deve ter agregado para Qua");
    assert.equal(qua!.delivered, 347,
      "delivered de Qua deve ser 347 (campanha com sent=undefined excluída)");
  });

  test("campanha com sent=null é excluída do agregado (sem NaN)", () => {
    const campaignWithNullSent = makeCampaign(98, "Clarice News 2605 d01-B (qua)", "2026-06-10T09:06:00Z",
      { sent: null as unknown as number, delivered: 50, uniqueViews: 10 });
    const campaigns = [campaignWithNullSent, ...cycle2605Campaigns];

    const rows = aggregateByWeekday(campaigns, "2605");

    for (const row of rows) {
      assert.ok(!isNaN(row.openRate), `openRate para ${row.label} não deve ser NaN`);
    }

    // Qua sem a campanha null: delivered=347 (apenas as 3 originais)
    const qua = rows.find((r) => r.weekday === 2);
    assert.equal(qua!.delivered, 347,
      "campanha com sent=null deve ser excluída do agregado de Qua");
  });

  // #2199 Finding 2: test where `s` IS DEFINED but `s.sent` is undefined.
  // Previous tests used makeCampaign which sets globalStats.sent=undefined, making gsIsReal=false,
  // so s falls back to cs=undefined (the old `!s` guard caught it). This test uses campaignStats
  // with sent=undefined so that s=cs is DEFINED but s.sent is undefined — exercises the
  // `!(s.sent > 0)` branch directly (the old `s.sent === 0` guard would let it through).
  test("s IS defined (campaignStats) but s.sent=undefined → excluída do agregado (sem NaN) [Finding 2]", () => {
    // globalStats ausente → gsIsReal=false → s = cs = campaignStats[0] (defined).
    // campaignStats[0].sent = undefined → old guard (s.sent === 0) passed; new guard excludes.
    const campaignCsUndefinedSent = {
      id: 97,
      name: "Clarice News 2605 d01-A (qua)",
      subject: "Test",
      status: "sent",
      sentDate: "2026-06-10T09:05:00Z",
      scheduledAt: null,
      createdAt: "2026-06-10T09:05:00Z",
      recipients: { lists: [197] },
      listName: "List 97",
      listSize: 100,
      statistics: {
        campaignStats: [{
          listId: 197,
          sent: undefined as unknown as number, // s IS defined, s.sent IS undefined
          delivered: 120,
          hardBounces: 0,
          softBounces: 0,
          deferred: 0,
          uniqueViews: 50,
          viewed: 55,
          trackableViews: 35,
          uniqueClicks: 5,
          clickers: 5,
          unsubscriptions: 0,
          complaints: 0,
        }],
        // no globalStats → falls back to campaignStats[0]
      },
    };
    const campaigns = [campaignCsUndefinedSent, ...cycle2605Campaigns];
    const rows = aggregateByWeekday(campaigns, "2605");

    for (const row of rows) {
      assert.ok(!isNaN(row.openRate),
        `openRate para ${row.label} não deve ser NaN (foi ${row.openRate})`);
    }

    // campanha inválida (sent=undefined) excluída → Qua delivered = 347 (só as originais)
    const qua = rows.find((r) => r.weekday === 2);
    assert.ok(qua, "deve ter agregado para Qua");
    assert.equal(qua!.delivered, 347,
      "campanha com campaignStats.sent=undefined deve ser excluída (delivered=347, não 347+120)");
  });
});

// ─── Regressão #2199 Finding 1: aggregateAbcSummary sent undefined → sem NaN ───

describe("regressão #2199 Finding 1: aggregateAbcSummary exclui campanha com gs.sent undefined", () => {
  test("gs IS defined but gs.sent=undefined → excluída da agregação A/B/C (sem NaN) [Finding 1]", () => {
    // Before fix: guard was `!gs || gs.sent === 0` — undefined === 0 is false, so campaign
    // passed the guard and gs.uniqueViews/gs.delivered were accumulated (NaN risk if
    // those fields are also undefined). Fix: `!(gs.sent > 0)` covers undefined correctly.
    const campaignUndefinedSentGs = {
      id: 96,
      name: "Clarice News 2605 d03-A (sex)",
      subject: "Test",
      status: "sent",
      sentDate: "2026-06-13T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-06-13T09:00:00Z",
      recipients: { lists: [196] },
      listName: "List 96",
      listSize: 100,
      statistics: {
        globalStats: {
          // gs IS defined; gs.sent IS undefined — exercises the !(gs.sent > 0) branch
          sent: undefined as unknown as number,
          delivered: 150,
          hardBounces: 0,
          softBounces: 0,
          uniqueViews: 60,
          viewed: 65,
          trackableViews: 40,
          uniqueClicks: 6,
          clickers: 6,
          unsubscriptions: 0,
          complaints: 0,
          appleMppOpens: 10,
        },
      },
    };

    const campaigns = [campaignUndefinedSentGs, ...cycle2605Campaigns];
    const result = aggregateAbcSummary(campaigns, "2605");

    // No NaN in any openRate
    for (const row of result) {
      assert.ok(!isNaN(row.openRate),
        `openRate para célula ${row.cell} não deve ser NaN (foi ${row.openRate})`);
      assert.ok(isFinite(row.openRate),
        `openRate para célula ${row.cell} deve ser finito`);
    }

    // d03-A with gs.sent=undefined must be excluded → cell A count = 2 (only d01-A, d02-A)
    const cellA = result.find((r) => r.cell === "A")!;
    assert.equal(cellA.campaignCount, 2,
      "campanha com gs.sent=undefined deve ser excluída — count A deve ser 2, não 3");
    // totalViews must equal only d01-A (20) + d02-A (35) = 55 (not +60 from the invalid campaign)
    assert.equal(cellA.totalViews, 20 + 35,
      "totalViews de A deve ser 55 (apenas d01-A+d02-A, excluindo campanha com gs.sent=undefined)");
  });
});
