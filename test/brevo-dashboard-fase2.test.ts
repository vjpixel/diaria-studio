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
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { validateSendPlan } from "../scripts/lib/send-plan.ts";
import { computeMvStatus } from "../scripts/clarice-mv-status.ts";
import {
  parseClariceCampaignKey,
  aggregateAbcSummary,
  isPostAbcReset,
  ABC_RESET_AT,
  calcCumulativeSent,
  detectActiveCycle,
  detectActiveMonthlyCycle,
  renderAbcSection,
  renderVolumeSection,
  renderDashboardHtml,
  renderScheduledSection,
  pickStats,
  aggregateLinksAcrossCampaigns,
  renderAggregatedLinksSection,
  deriveLinksSectionTitle,
  aggregateByMonth,
  renderMonthlyTotalsSection,
  CLARICE_PLAN_TOTAL,
  CLARICE_PLAN_S1,
  weekdayKeyBRT,
  aggregateByWeekday,
  renderWeekdaySection,
  WEEKDAY_LABELS,
  monthKeyBRT,
  ENVIOS_TOOLTIP,
  aggregateDaySummary,
  renderDaySummarySection,
  WEEKDAY_MIN_AGE_HOURS,
  renderMvStatusSection,
  MV_STATUS_KV_KEY,
  renderEiaEngagementSection,
  EIA_ENGAGEMENT_KV_KEY,
  aggregateEiaEngagementByMonth,
} from "../workers/brevo-dashboard/src/index.ts";
import type { MvStatus, EiaEngagementSummary, EiaEngagementEdition } from "../workers/brevo-dashboard/src/index.ts";

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
    assert.deepEqual(r, { cycle: "2605", dayNum: 1, cell: "A", monthly: false });
  });

  test("parseia d02-C corretamente", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d02-C (qui)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 2, cell: "C", monthly: false });
  });

  test("parseia d07-B — último dia S1", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d07-B (ter)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 7, cell: "B", monthly: false });
  });

  test("parseia d08-A — dia S2 (dayNum > 7, fora do S1)", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d08-A (qua)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 8, cell: "A", monthly: false });
  });

  test("retorna null para campanha T1", () => {
    assert.equal(parseClariceCampaignKey("Diar.ia Mensal 2604 [list 9 W1] — 2026-05-08"), null);
  });

  // Regressões #2124 — item 1: sufixo pós-célula opcional + normalização uppercase
  test("parseia nome SEM sufixo de dia-da-semana (sufixo opcional #2124)", () => {
    // Nome sem espaço+sufixo após [ABC] — antes do fix: retornava null silenciosamente
    const r = parseClariceCampaignKey("Clarice News 2605 d03-B");
    assert.deepEqual(r, { cycle: "2605", dayNum: 3, cell: "B", monthly: false });
  });

  test("parseia nome com célula em minúscula (flag /i + toUpperCase #2124)", () => {
    // Flag /i aceita lowercase, mas o cast precisava de normalização
    const r = parseClariceCampaignKey("Clarice News 2605 d04-a (sex)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 4, cell: "A", monthly: false });
  });

  test("parseia nome com célula lowercase sem sufixo (#2124)", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d05-c");
    assert.deepEqual(r, { cycle: "2605", dayNum: 5, cell: "C", monthly: false });
  });
});

// ─── #2889: teste ABC MENSAL ──────────────────────────────────────────────────

describe("#2889: teste ABC mensal (naming 'Clarice News AAMM-MM — X')", () => {
  // 3 campanhas do digest mensal (1 por célula, sem dNN), com stats reais.
  const mensal = [
    makeCampaign(75, "Clarice News 2606-07 — A: Brasil, Anthropic e a corrida", "2026-07-03T06:00:00Z", { sent: 1487, delivered: 1482, uniqueViews: 702 }),
    makeCampaign(76, "Clarice News 2606-07 — B: O mês em que o modelo virou agente", "2026-07-03T06:00:00Z", { sent: 1489, delivered: 1484, uniqueViews: 719 }),
    makeCampaign(77, "Clarice News 2606-07 — C: Soberania, segurança e agentes", "2026-07-03T06:00:00Z", { sent: 1487, delivered: 1484, uniqueViews: 691 }),
  ];

  test("parseClariceCampaignKey reconhece o naming mensal (monthly:true, cell, sem dayNum)", () => {
    assert.deepEqual(parseClariceCampaignKey("Clarice News 2606-07 — A: Notícias do mês"), {
      cycle: "2606-07", dayNum: 0, cell: "A", monthly: true,
    });
    assert.deepEqual(parseClariceCampaignKey("Clarice News 2606-07 — C: outro subject"), {
      cycle: "2606-07", dayNum: 0, cell: "C", monthly: true,
    });
  });

  test("detectActiveCycle IGNORA o mensal (só ciclos diários)", () => {
    // mistura diário (2605) + mensal (2606-07): o mensal seria lexicograficamente
    // "maior", mas detectActiveCycle deve devolver o diário.
    const mix = [...allCampaigns, ...mensal];
    assert.equal(detectActiveCycle(mix), "2605");
  });

  test("detectActiveMonthlyCycle devolve o ciclo mensal (independente do diário)", () => {
    const mix = [...allCampaigns, ...mensal];
    assert.equal(detectActiveMonthlyCycle(mix), "2606-07");
    assert.equal(detectActiveMonthlyCycle(allCampaigns), null); // sem mensal
  });

  test("aggregateAbcSummary agrega as 3 campanhas mensais (pula o corte de dia S1)", () => {
    const rows = aggregateAbcSummary(mensal, "2606-07");
    const a = rows.find((r) => r.cell === "A")!;
    const b = rows.find((r) => r.cell === "B")!;
    const c = rows.find((r) => r.cell === "C")!;
    assert.equal(a.campaignCount, 1);
    assert.equal(b.campaignCount, 1);
    assert.equal(c.campaignCount, 1);
    // B tem a maior taxa de abertura (719/1484 > 702/1482 > 691/1484).
    assert.ok(b.openRate > a.openRate && a.openRate > c.openRate);
  });

  test("renderDashboardHtml inclui a seção 'Resumo A/B/C — Mensal' quando há teste ABC mensal", () => {
    const html = renderDashboardHtml([...allCampaigns, ...mensal]);
    assert.match(html, /id="abc-summary-monthly"/);
    assert.match(html, /Resumo A\/B\/C — Mensal \(2606-07\)/);
    assert.match(html, /Célula B/); // as células do mensal aparecem
  });

  test("sem teste ABC mensal → seção mensal não renderiza", () => {
    const html = renderDashboardHtml(allCampaigns);
    assert.doesNotMatch(html, /id="abc-summary-monthly"/);
  });
});

// ─── aggregateAbcSummary ──────────────────────────────────────────────────────

describe("aggregateAbcSummary", () => {
  test("agrega open rate MPP-inclusivo por célula (fixtures reais d01+d02) (#2258)", () => {
    const result = aggregateAbcSummary(allCampaigns, "2605");
    const a = result.find((r) => r.cell === "A")!;
    const b = result.find((r) => r.cell === "B")!;
    const c = result.find((r) => r.cell === "C")!;

    // #2258: base canônica = uniqueViews (MPP-INCLUSIVO, igual à UI da Brevo).
    // A: d01-A (20 / 115 del) + d02-A (35 / 182 del) = 55/297
    assert.equal(a.totalViews, 20 + 35);
    assert.equal(a.totalDelivered, 115 + 182);
    assert.ok(Math.abs(a.openRate - (55 / 297) * 100) < 0.01, `A openRate deve ser ~18.5% mas foi ${a.openRate}`);
    assert.equal(a.campaignCount, 2);

    // B: d01-B (32 / 117 del) + d02-B (39 / 182 del) = 71/299
    assert.equal(b.totalViews, 32 + 39);
    assert.equal(b.totalDelivered, 117 + 182);
    assert.ok(Math.abs(b.openRate - (71 / 299) * 100) < 0.01);
    assert.equal(b.campaignCount, 2);

    // C: d01-C (30 / 115 del) + d02-C (30 / 183 del) = 60/298
    assert.equal(c.totalViews, 30 + 30);
    assert.equal(c.totalDelivered, 115 + 183);
    assert.equal(c.campaignCount, 2);

    // #2257: organicOpenRate (secundário) computado quando TODOS os dias têm
    // globalStats (todos os fixtures têm) = (uniqueViews − appleMppOpens) ÷ delivered.
    // A orgânico = (20−8)+(35−7) = 40 / 297
    assert.ok(a.organicOpenRate !== null && Math.abs(a.organicOpenRate - (40 / 297) * 100) < 0.01,
      `A organicOpenRate deve ser ~13.5% mas foi ${a.organicOpenRate}`);
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
    assert.equal(a.totalViews, 20 + 35); // apenas d01-A + d02-A (uniqueViews MPP-incl)
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
    assert.equal(b.totalViews, 50, "deve usar campaignStats.uniqueViews (MPP-incl)");
    assert.equal(b.totalDelivered, 198, "deve usar campaignStats.delivered");
    assert.ok(Math.abs(b.openRate - (50 / 198) * 100) < 0.01, `openRate esperado ~25.3% mas foi ${b.openRate}`);
    // #2257/#2258: campaignStats não expõe appleMppOpens → orgânico não computável → null.
    assert.equal(b.organicOpenRate, null, "fallback campaignStats não tem organicOpenRate (null)");
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

  // #2258: base canônica é uniqueViews MPP-INCLUSIVO (NÃO subtrai MPP). Documenta
  // a correção do bug do #2253: subtrair MPP só do globalStats (e não do
  // campaignStats, que não expõe o campo) gerava número "orgânico" impossível no
  // fallback. uniqueViews é a base homogênea entre as duas fontes (ambas incl).
  test("totalViews = uniqueViews MPP-inclusivo, sem subtrair appleMppOpens (#2258)", () => {
    const mppCampaign = {
      ...makeCampaign(62, "Clarice News 2605 d04-A (sab)", "2026-06-13T09:00:00Z"),
      statistics: {
        globalStats: makeGlobalStats({ sent: 100, delivered: 100, uniqueViews: 100, appleMppOpens: 30 }),
      },
    };
    const result = aggregateAbcSummary([mppCampaign], "2605");
    const a = result.find((r) => r.cell === "A")!;
    assert.equal(a.totalViews, 100, "totalViews = uniqueViews (100), NÃO 100−30");
    assert.ok(Math.abs(a.openRate - 100) < 0.01, `openRate incl = 100/100 = 100% mas foi ${a.openRate}`);
    // orgânico secundário = 100−30 = 70 / 100 = 70%
    assert.ok(a.organicOpenRate !== null && Math.abs(a.organicOpenRate - 70) < 0.01,
      `organicOpenRate = 70% mas foi ${a.organicOpenRate}`);
  });

  // #2257: organicOpenRate = null quando a célula MISTURA dias com globalStats e
  // dias em fallback (orgânico não-comparável entre as células). Evita o viés do
  // #2253 (uns dias com MPP, outros sem) — só mostra orgânico quando homogêneo.
  test("organicOpenRate é null quando a célula mistura globalStats e fallback (#2257)", () => {
    const dayGlobal = {
      ...makeCampaign(70, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z",
        { sent: 100, delivered: 100, uniqueViews: 40, appleMppOpens: 10 }),
    };
    const dayFallback = {
      ...makeCampaign(71, "Clarice News 2605 d02-A (qui)", "2026-06-11T09:00:00Z"),
      statistics: {
        campaignStats: [{
          listId: 171, sent: 100, delivered: 100,
          hardBounces: 0, softBounces: 0, deferred: 0,
          uniqueViews: 30, viewed: 35, trackableViews: 20,
          uniqueClicks: 2, clickers: 2, unsubscriptions: 0, complaints: 0,
        }],
        globalStats: undefined,
      },
    };
    const result = aggregateAbcSummary([dayGlobal, dayFallback], "2605");
    const a = result.find((r) => r.cell === "A")!;
    assert.equal(a.campaignCount, 2, "ambos os dias contam (incl)");
    assert.equal(a.totalViews, 70, "uniqueViews incl: 40 + 30");
    assert.equal(a.organicOpenRate, null, "1 dia em fallback → orgânico não-comparável → null");
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

  // #2125 / #2775: drift test — CLARICE_PLAN_TOTAL e CLARICE_PLAN_S1 não devem
  // driftar do plano de envio do ciclo 2605-06. Pré-#2775 comparava contra o
  // array `SENDS` hardcoded em clarice-build-edition-sends.ts; o cutover (#2775)
  // moveu o plano pra input externo por-ciclo (`{ciclo}/send-plan.json`, em
  // `data/` — não versionado). `scripts/send-plan.example.json` é o exemplo
  // documentado E, não por acaso, o plano REAL do ciclo 2605-06 (mesmos números
  // que geraram CLARICE_PLAN_TOTAL/CLARICE_PLAN_S1) — segue git-tracked, então
  // continua servindo de guard de drift determinístico em CI.
  const examplePlan = validateSendPlan(
    JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "send-plan.example.json"), "utf8")),
  );

  test("CLARICE_PLAN_TOTAL não drifta do volume total de send-plan.example.json (#2125/#2775)", () => {
    const totalFromPlan = examplePlan.reduce((acc, s) => acc + s.volume, 0);
    assert.equal(
      CLARICE_PLAN_TOTAL,
      totalFromPlan,
      `CLARICE_PLAN_TOTAL (${CLARICE_PLAN_TOTAL}) driftou do total de scripts/send-plan.example.json (${totalFromPlan}) — ` +
      "atualize a constante em workers/brevo-dashboard/src/index.ts",
    );
  });

  test("CLARICE_PLAN_S1 não drifta do total do bloco 1 de send-plan.example.json (#2125/#2775)", () => {
    const s1FromPlan = examplePlan.filter((s) => s.block === 1).reduce((acc, s) => acc + s.volume, 0);
    assert.equal(
      CLARICE_PLAN_S1,
      s1FromPlan,
      `CLARICE_PLAN_S1 (${CLARICE_PLAN_S1}) driftou do total do bloco 1 de scripts/send-plan.example.json (${s1FromPlan}) — ` +
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

// ─── #2359: seção wave-trend removida ────────────────────────────────────────

describe("#2359 renderTrendSection removida", () => {
  test("HTML do dashboard NÃO contém id='wave-trend' (seção removida)", () => {
    const html = renderDashboardHtml(allCampaigns);
    assert.doesNotMatch(html, /id="wave-trend"/, "seção wave-trend não deve existir no HTML (#2359)");
  });

  test("HTML do dashboard NÃO contém 'Tendência entre waves'", () => {
    const html = renderDashboardHtml(allCampaigns);
    assert.doesNotMatch(html, /Tend.ncia entre waves/, "título da seção removida não deve aparecer (#2359)");
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

// ─── #2360: parseClariceCampaignKey — sufixo de célula opcional ──────────────

describe("#2360 parseClariceCampaignKey — sufixo opcional", () => {
  test("campanha sem sufixo de célula retorna cell: null", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d08 (qua)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 8, cell: null, monthly: false });
  });

  test("campanha sem sufixo e sem parênteses retorna cell: null", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d08");
    assert.deepEqual(r, { cycle: "2605", dayNum: 8, cell: null, monthly: false });
  });

  test("campanha com sufixo de célula ainda retorna cell correto", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d01-A (qua)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 1, cell: "A", monthly: false });
  });

  test("calcCumulativeSent soma campanha sem sufixo de célula (#2360)", () => {
    // d08 sem sufixo tem sent=1449 → total deve incluí-la
    const d08 = makeCampaign(99, "Clarice News 2605 d08 (qua)", "2026-06-18T09:00:00Z",
      { sent: 1449, delivered: 1400, uniqueViews: 350 });
    const total = calcCumulativeSent([...cycle2605Campaigns, d08], "2605");
    // cycle2605Campaigns: 117+117+116+184+183+183 = 900
    assert.equal(total, 900 + 1449, "campanha d08 sem sufixo deve ser incluída no cumulativo");
  });

  test("aggregateAbcSummary NÃO quebra com cell: null presente (ignora silenciosamente)", () => {
    const d08 = makeCampaign(99, "Clarice News 2605 d08 (qua)", "2026-06-18T09:00:00Z",
      { sent: 1449, delivered: 1400, uniqueViews: 350 });
    // Não deve lançar exceção; não deve duplicar células
    const result = aggregateAbcSummary([...cycle2605Campaigns, d08], "2605");
    assert.equal(result.length, 3, "deve ter exatamente 3 células A/B/C");
    // d08 sem célula NÃO deve ter entrado em nenhuma célula A/B/C
    const totalCampaignCount = result.reduce((s, r) => s + r.campaignCount, 0);
    // cycle2605Campaigns tem 2 campanhas por célula (d01+d02) = 6 total
    assert.equal(totalCampaignCount, 6, "d08 sem célula não deve entrar no ABC (cell: null ignorado)");
  });

  test("detectActiveCycle detecta ciclo com campanha sem sufixo (#2360)", () => {
    const d08 = makeCampaign(99, "Clarice News 2605 d08 (qua)", "2026-06-18T09:00:00Z");
    assert.equal(detectActiveCycle([d08]), "2605", "campanha sem sufixo de célula deve ser detectada");
  });
});

// ─── #2369: aggregateByMonth / renderMonthlyTotalsSection ────────────────────

describe("#2369 aggregateByMonth", () => {
  test("agrega 2 campanhas no mesmo mês em 1 linha", () => {
    // d01 e d02 da célula A — ambas em junho/2026
    const junioCampaigns = [
      makeCampaign(1, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z",
        { sent: 100, delivered: 98, uniqueViews: 25, uniqueClicks: 3 }),
      makeCampaign(2, "Clarice News 2605 d02-A (qui)", "2026-06-11T09:00:00Z",
        { sent: 200, delivered: 196, uniqueViews: 50, uniqueClicks: 6 }),
    ];
    const rows = aggregateByMonth(junioCampaigns);
    assert.equal(rows.length, 1, "deve ter 1 linha para junho");
    const jun = rows[0];
    assert.equal(jun.month, "2026-06");
    assert.equal(jun.label, "Jun/2026");
    assert.equal(jun.campaignCount, 2);
    assert.equal(jun.totalSent, 300);
    assert.equal(jun.totalDelivered, 294);
    assert.equal(jun.totalViews, 75);
    assert.equal(jun.totalClicks, 9);
    assert.ok(Math.abs(jun.openRate - (75 / 294) * 100) < 0.01, `openRate deve ser ~25.5% mas foi ${jun.openRate}`);
    assert.ok(Math.abs(jun.ctr - (9 / 294) * 100) < 0.01, `ctr deve ser ~3.06% mas foi ${jun.ctr}`);
  });

  test("campanhas em meses diferentes geram linhas separadas", () => {
    const rows = aggregateByMonth(allCampaigns);
    // allCampaigns: cycle2605 (jun/2026) + t1Campaigns (mai/2026)
    const meses = rows.map((r) => r.month);
    assert.ok(meses.includes("2026-06"), "deve ter junho");
    assert.ok(meses.includes("2026-05"), "deve ter maio");
    assert.equal(rows.length, 2, "deve ter 2 meses distintos");
  });

  test("ordena do mês mais recente para o mais antigo", () => {
    const rows = aggregateByMonth(allCampaigns);
    assert.equal(rows[0].month, "2026-06", "mês mais recente primeiro");
    assert.equal(rows[1].month, "2026-05", "mês mais antigo segundo");
  });

  test("retorna [] quando não há campanhas com stats reais", () => {
    const zeroStats = {
      ...makeCampaign(99, "Clarice News 2605 d01-A", "2026-06-10T09:00:00Z"),
      statistics: { globalStats: makeGlobalStats({ sent: 0 }) },
    };
    assert.deepEqual(aggregateByMonth([zeroStats]), []);
  });

  test("retorna [] quando lista vazia", () => {
    assert.deepEqual(aggregateByMonth([]), []);
  });

  test("exclui campanhas sem sentDate", () => {
    const noDate = { ...makeCampaign(1, "Clarice News 2605 d01-A", ""), sentDate: null };
    assert.deepEqual(aggregateByMonth([noDate]), []);
  });

  test("fixture allCampaigns: junho tem 6 campanhas e maio tem 2", () => {
    const rows = aggregateByMonth(allCampaigns);
    const jun = rows.find((r) => r.month === "2026-06")!;
    const mai = rows.find((r) => r.month === "2026-05")!;
    assert.equal(jun.campaignCount, 6, "junho: 6 campanhas Clarice d01/d02 A/B/C");
    assert.equal(mai.campaignCount, 2, "maio: 2 campanhas T1");
  });
});

describe("#2369 renderMonthlyTotalsSection", () => {
  test("retorna string vazia quando rows está vazio", () => {
    assert.equal(renderMonthlyTotalsSection([]), "");
  });

  test("contém id='monthly-totals' para âncora", () => {
    const rows = aggregateByMonth(allCampaigns);
    const html = renderMonthlyTotalsSection(rows);
    assert.match(html, /id="monthly-totals"/, "deve ter âncora monthly-totals");
  });

  test("contém 1 linha por mês (2 linhas para allCampaigns)", () => {
    const rows = aggregateByMonth(allCampaigns);
    const html = renderMonthlyTotalsSection(rows);
    // 2 linhas de dados = 2 <tr> no tbody (excluindo o <tr> do thead)
    const trCount = (html.match(/<tr>/g) ?? []).length;
    // 1 <tr> no thead + 2 no tbody = 3 total (ou pode ser tbody sem <tr> extra)
    assert.ok(trCount >= 2, `deve ter ao menos 2 <tr> (1/mês) mas encontrou ${trCount}`);
    assert.match(html, /Jun\/2026/, "deve ter linha Jun/2026");
    assert.match(html, /Mai\/2026/, "deve ter linha Mai/2026");
  });

  test("lista detalhada de campanhas NÃO é substituída (ambas presentes no dashboard)", () => {
    const html = renderDashboardHtml(allCampaigns);
    assert.match(html, /id="monthly-totals"/, "tabela mensal deve existir");
    assert.match(html, /id="campaigns-table"/, "lista detalhada deve existir");
    // A lista detalhada vem DEPOIS da tabela mensal
    const posMonthly = html.indexOf('id="monthly-totals"');
    const posCampaigns = html.indexOf('id="campaigns-table"');
    assert.ok(posMonthly < posCampaigns, "tabela mensal deve vir antes da lista detalhada");
  });

  test("exibe open rate e CTR agregados corretos para fixture de 1 mês", () => {
    const rows = aggregateByMonth([
      makeCampaign(1, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z",
        { sent: 200, delivered: 196, uniqueViews: 60, uniqueClicks: 8 }),
    ]);
    const html = renderMonthlyTotalsSection(rows);
    // openRate = 60/196*100 ≈ 30.6%
    assert.match(html, /30\.[0-9]%/, "deve exibir open rate ~30.6%");
    // ctr = 8/196*100 ≈ 4.1%
    assert.match(html, /4\.[0-9]%/, "deve exibir CTR ~4.1%");
  });

  // #2429: rótulo "E-mails (eventos)" na coluna Sent da tabela mensal (#2491: renomeado de "Envios (eventos)")
  test("#2429 coluna Sent da tabela mensal tem rótulo 'E-mails (eventos)' com tooltip", () => {
    const rows = aggregateByMonth(allCampaigns);
    const html = renderMonthlyTotalsSection(rows);
    // Coluna deve ser rotulada como "E-mails (eventos)" (#2491: renomeado de "Envios (eventos)")
    assert.match(html, /E-mails \(eventos\)/, "coluna deve ter rótulo 'E-mails (eventos)'");
    // Tooltip usa "N vezes" (PT-BR legível), não "N×" (#2429 self-review finding 3)
    assert.match(html, /title="[^"]*uma pessoa em N campanhas conta N vezes[^"]*"/, "tooltip deve usar 'N vezes', não 'N×'");
    // Tooltip compartilhado via ENVIOS_TOOLTIP — verifica que a constante está em uso
    assert.ok(html.includes(ENVIOS_TOOLTIP), "deve usar a constante ENVIOS_TOOLTIP compartilhada");
  });

  // #2429 self-review: testes negativos — rótulos antigos sumiram
  test("#2429 rótulo antigo 'Sent' crú não aparece em nenhuma tabela do dashboard", () => {
    const html = renderDashboardHtml(allCampaigns);
    // Nenhum <th> ou cabeçalho de coluna deve mostrar "Sent" como rótulo ambíguo
    assert.doesNotMatch(html, /<th[^>]*>Sent<\/th>/, "nenhum <th> deve conter 'Sent' cru como rótulo");
  });

  test("#2429 'contatos no universo' não aparece mais na seção de coortes", () => {
    // Regressão: garantir que o rótulo antigo foi substituído por 'pessoas únicas alcançadas'
    assert.doesNotMatch(
      renderDashboardHtml(allCampaigns),
      /contatos no universo/,
      "rótulo antigo 'contatos no universo' não deve aparecer no dashboard",
    );
  });
});

// ─── #2442: aggregateByMonth novos campos + renderMonthlyTotalsSection ────────

describe("#2442 aggregateByMonth novos campos (bounces/unsub/spam/datas)", () => {
  const bounceUnsub = makeCampaign(100, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z", {
    sent: 200, delivered: 194,
    hardBounces: 3, softBounces: 2, // totalBounces = 5
    unsubscriptions: 1,
    complaints: 0,
    uniqueViews: 50, uniqueClicks: 5,
  });
  const spamLater = makeCampaign(101, "Clarice News 2605 d02-A (qui)", "2026-06-15T09:00:00Z", {
    sent: 100, delivered: 98,
    hardBounces: 0, softBounces: 0,
    unsubscriptions: 0,
    complaints: 1,
    uniqueViews: 30, uniqueClicks: 3,
  });

  test("totalBounces, totalUnsub, totalSpam acumulados corretamente", () => {
    const rows = aggregateByMonth([bounceUnsub, spamLater]);
    assert.equal(rows.length, 1, "ambas em junho → 1 linha");
    const jun = rows[0];
    assert.equal(jun.totalBounces, 5, "totalBounces = 3+2");
    assert.equal(jun.totalUnsub, 1, "totalUnsub = 1");
    assert.equal(jun.totalSpam, 1, "totalSpam = 1");
  });

  test("bounceRate, unsubRate, spamRate calculados sobre totalSent", () => {
    const rows = aggregateByMonth([bounceUnsub, spamLater]);
    const jun = rows[0];
    // bounceRate = 5 / 300 = 1.667%
    assert.ok(Math.abs(jun.bounceRate - (5 / 300) * 100) < 0.01, `bounceRate esperado ~1.67% mas foi ${jun.bounceRate}`);
    // unsubRate = 1 / 300 = 0.333%
    assert.ok(Math.abs(jun.unsubRate - (1 / 300) * 100) < 0.01, `unsubRate esperado ~0.33% mas foi ${jun.unsubRate}`);
    // spamRate = 1 / 300 = 0.333%
    assert.ok(Math.abs(jun.spamRate - (1 / 300) * 100) < 0.01, `spamRate esperado ~0.33% mas foi ${jun.spamRate}`);
  });

  test("firstSentDate = min(sentDate) e lastSentDate = max(sentDate) do mês", () => {
    const rows = aggregateByMonth([bounceUnsub, spamLater]);
    const jun = rows[0];
    assert.equal(jun.firstSentDate, "2026-06-10T09:00:00Z", "firstSentDate = data mais antiga");
    assert.equal(jun.lastSentDate, "2026-06-15T09:00:00Z", "lastSentDate = data mais recente");
  });

  test("campanha única: firstSentDate == lastSentDate", () => {
    const rows = aggregateByMonth([bounceUnsub]);
    const jun = rows[0];
    assert.equal(jun.firstSentDate, jun.lastSentDate, "1 campanha: first == last");
  });
});

describe("#2442 renderMonthlyTotalsSection novo formato", () => {
  test("colunas Bounces, Unsub, Spam presentes no header", () => {
    const rows = aggregateByMonth(allCampaigns);
    const html = renderMonthlyTotalsSection(rows);
    assert.match(html, /Bounces/, "coluna Bounces deve existir");
    assert.match(html, /Unsub/, "coluna Unsub deve existir");
    assert.match(html, /Spam/, "coluna Spam deve existir");
  });

  test("coluna 'Trackable' ausente na tabela mensal (dispensada explicitamente)", () => {
    const rows = aggregateByMonth(allCampaigns);
    const html = renderMonthlyTotalsSection(rows);
    // Trackable deve estar ausente APENAS da tabela mensal
    assert.doesNotMatch(html, /Trackable/, "coluna Trackable não deve aparecer na tabela mensal");
  });

  test("coluna Enviado com range '1º – último' presente no header", () => {
    const rows = aggregateByMonth(allCampaigns);
    const html = renderMonthlyTotalsSection(rows);
    assert.match(html, /Enviado.*1º.*último/s, "header deve ter coluna Enviado com range");
  });

  test("alerta de bounce (≥3%) renderiza class alert na célula mensal", () => {
    // Criar campanha com bounceRate alto (≥3%)
    const highBounce = makeCampaign(200, "High Bounce", "2026-06-20T09:00:00Z", {
      sent: 100, delivered: 90,
      hardBounces: 4, softBounces: 0, // bounceRate = 4% ≥ 3 → alert
      unsubscriptions: 0, complaints: 0,
      uniqueViews: 20, uniqueClicks: 2,
    });
    const rows = aggregateByMonth([highBounce]);
    const html = renderMonthlyTotalsSection(rows);
    // bounceRate = 4% ≥ 3 → class alert na célula de bounces
    assert.match(html, /class="alert"/, "célula de bounces deve ter class alert quando bounceRate≥3%");
  });

  test("coluna Trackable ainda presente na tabela Envios (não removida desta)", () => {
    const html = renderDashboardHtml(allCampaigns);
    // Trackable na tabela Envios (id=campaigns-table) — NÃO deve sumir de lá
    const campaignSection = html.match(/id="campaigns-table"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(campaignSection, /Trackable/, "Trackable deve permanecer na tabela Envios");
  });

  test("formato de célula: taxa em cima + count absoluto em <small> (espelha Envios)", () => {
    const rows = aggregateByMonth([
      makeCampaign(300, "Test", "2026-06-10T09:00:00Z", {
        sent: 200, delivered: 196, uniqueViews: 50, uniqueClicks: 8,
        hardBounces: 2, softBounces: 0, unsubscriptions: 1, complaints: 0,
      }),
    ]);
    const html = renderMonthlyTotalsSection(rows);
    // Células de Opens e Clicks devem ter <br><small>count</small> (mesmo formato Envios)
    assert.match(html, /<small>50<\/small>/, "totalViews (50) deve aparecer em <small>");
    assert.match(html, /<small>8<\/small>/, "totalClicks (8) deve aparecer em <small>");
  });

  test("tabela mensal tem 10 colunas no header (#2442: +Bounces/Unsub/Spam)", () => {
    // #2442 expandiu a tabela monthly-totals de 8 para 10 colunas (adicionou Bounces,
    // Unsub, Spam). Testar contagem explícita para evitar regressão silenciosa.
    // Colunas: Mês | Envios | Enviado (1º–último) | Envios (eventos) | Delivered
    //          | Opens | Clicks | Bounces | Unsub | Spam = 10 th
    const rows = aggregateByMonth(allCampaigns);
    const html = renderMonthlyTotalsSection(rows);
    const thCount = (html.match(/<th /g) || []).length;
    assert.equal(thCount, 10, `tabela mensal deve ter 10 <th> mas encontrou ${thCount}`);
  });
});

// ─── #2402: monthKeyBRT + aggregateByMonth usa BRT, não UTC ─────────────────

describe("#2402 monthKeyBRT", () => {
  test("campanha 2026-07-01T00:00:00Z (= 30/jun 21:00 BRT) → '2026-06'", () => {
    // Virada de mês: UTC avançou para julho, mas BRT ainda é junho.
    assert.equal(monthKeyBRT("2026-07-01T00:00:00Z"), "2026-06");
  });

  test("campanha claramente em julho BRT → '2026-07'", () => {
    // 2026-07-10T12:00:00Z = 10/jul 09:00 BRT — inequivocamente julho
    assert.equal(monthKeyBRT("2026-07-10T12:00:00Z"), "2026-07");
  });

  test("campanha no meio do mês não é afetada pela conversão BRT", () => {
    // 2026-06-10T09:00:00Z = 10/jun 06:00 BRT — claramente junho em ambos fusos
    assert.equal(monthKeyBRT("2026-06-10T09:00:00Z"), "2026-06");
  });

  test("virada de mês: 2026-05-31T03:00:00Z (= 31/mai 00:00 BRT) → '2026-05'", () => {
    // BRT é UTC-3; meia-noite BRT = 03:00 UTC — ainda maio BRT
    assert.equal(monthKeyBRT("2026-05-31T03:00:00Z"), "2026-05");
  });

  test("segundo após meia-noite UTC no 1º do mês mas BRT ainda no mês anterior", () => {
    // 2026-08-01T01:00:00Z = 31/jul 22:00 BRT — julho BRT
    assert.equal(monthKeyBRT("2026-08-01T01:00:00Z"), "2026-07");
  });
});

describe("#2402 aggregateByMonth usa BRT para bucketizar", () => {
  test("campanha 2026-07-01T00:00:00Z (UTC) cai em '2026-06' (BRT)", () => {
    // Regressão: bug original bucketizava como '2026-07' via slice(0,7)
    const campaign = makeCampaign(
      99,
      "Clarice News virada",
      "2026-07-01T00:00:00Z",
      { sent: 150, delivered: 145, uniqueViews: 40, uniqueClicks: 5 },
    );
    const rows = aggregateByMonth([campaign]);
    assert.equal(rows.length, 1, "deve ter 1 linha");
    assert.equal(rows[0].month, "2026-06", "bucket deve ser '2026-06' (BRT), não '2026-07' (UTC)");
    assert.equal(rows[0].label, "Jun/2026");
  });

  test("campanha claramente em julho BRT fica em '2026-07'", () => {
    const campaign = makeCampaign(
      100,
      "Clarice News julho",
      "2026-07-10T12:00:00Z",
      { sent: 150, delivered: 145, uniqueViews: 40, uniqueClicks: 5 },
    );
    const rows = aggregateByMonth([campaign]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].month, "2026-07");
  });

  test("virada + campanha normal em julho ficam em meses separados", () => {
    const virada = makeCampaign(
      101,
      "Clarice News virada jun",
      "2026-07-01T00:00:00Z", // 30/jun 21:00 BRT
      { sent: 100, delivered: 97, uniqueViews: 30, uniqueClicks: 4 },
    );
    const julho = makeCampaign(
      102,
      "Clarice News julho normal",
      "2026-07-10T12:00:00Z", // 10/jul 09:00 BRT
      { sent: 150, delivered: 145, uniqueViews: 40, uniqueClicks: 5 },
    );
    const rows = aggregateByMonth([virada, julho]);
    assert.equal(rows.length, 2, "deve ter 2 meses: jun e jul");
    const meses = rows.map((r) => r.month).sort();
    assert.deepEqual(meses, ["2026-06", "2026-07"]);
  });
});

// ─── #2407: monthKeyBRT NaN guard + aggregateByMonth pula data malformada ─────

describe("#2407 monthKeyBRT NaN guard", () => {
  test("string vazia → null (não lança)", () => {
    assert.equal(monthKeyBRT(""), null);
  });

  test("string inválida → null (não lança)", () => {
    assert.equal(monthKeyBRT("not-a-date"), null);
  });

  test("data válida ainda funciona", () => {
    assert.equal(monthKeyBRT("2026-07-01T00:00:00Z"), "2026-06");
  });
});

describe("#2407 aggregateByMonth pula sentDate malformado", () => {
  test("campanha com sentDate malformado é pulada — não crasha, não aparece no resultado", () => {
    const malformed = makeCampaign(
      200,
      "Campanha malformada",
      "invalid-date",
      { sent: 100, delivered: 95, uniqueViews: 30, uniqueClicks: 5 },
    );
    // Não deve lançar
    assert.doesNotThrow(() => aggregateByMonth([malformed]));
    // monthKeyBRT retorna null para date inválida → campanha pulada, resultado vazio
    const rows = aggregateByMonth([malformed]);
    assert.equal(rows.length, 0, "campanha malformada deve ser pulada");
  });

  test("campanha malformada + campanha válida: agrega só a válida", () => {
    const malformed = makeCampaign(
      201,
      "Campanha malformada",
      "not-a-date",
      { sent: 100, delivered: 95, uniqueViews: 30, uniqueClicks: 5 },
    );
    const valid = makeCampaign(
      202,
      "Campanha válida",
      "2026-06-15T12:00:00Z",
      { sent: 150, delivered: 145, uniqueViews: 40, uniqueClicks: 8 },
    );
    const rows = aggregateByMonth([malformed, valid]);
    assert.equal(rows.length, 1, "só 1 mês (da campanha válida)");
    assert.equal(rows[0].month, "2026-06");
    assert.equal(rows[0].campaignCount, 1, "só 1 campanha agregada");
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

  test("seção day-summary foi REMOVIDA da aba Engajamento (#2736, supersede #2523)", () => {
    const html = renderDashboardHtml(cycle2605Campaigns);
    // #2736: "Resumo D1–D5 — S1" removida da aba (ruído, decisão do editor).
    // renderDaySummarySection/aggregateDaySummary permanecem exportadas e
    // testadas isoladamente (ver describe "renderDaySummarySection (#2492)")
    // — só não são mais chamadas no render completo do dashboard.
    assert.doesNotMatch(html, /id="day-summary"/, "seção day-summary não deve mais aparecer (#2736)");
    assert.doesNotMatch(html, /Resumo D1–D5/, "título 'Resumo D1–D5' não deve mais aparecer (#2736)");
    // #2600: renderAbcSection segue presente — só D1-D5 saiu, não A/B/C.
    assert.match(html, /id="abc-summary"/, "seção abc-summary segue presente (não removida)");
  });

  test("volume-ciclo segue presente (day-summary removida, #2736)", () => {
    const html = renderDashboardHtml(cycle2605Campaigns);
    assert.match(html, /id="volume-ciclo"/, "deve conter a seção de volume");
    assert.doesNotMatch(html, /id="day-summary"/, "day-summary não existe mais pra comparar posição (#2736)");
  });

  test("seção wave-trend NÃO aparece no dashboard (removida em #2359)", () => {
    const html = renderDashboardHtml(allCampaigns);
    assert.doesNotMatch(html, /id="wave-trend"/, "seção wave-trend foi removida (#2359)");
    assert.doesNotMatch(html, /Tend.ncia entre waves/, "título da seção removida não deve aparecer");
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

  test("seção weekday-openrate posicionada DEPOIS de campaigns-table (#2134, #2472; day-summary removida em #2736)", () => {
    const html = renderDashboardHtml(cycle2605Campaigns);
    // #2472: nova ordem: campaigns-table → weekday-openrate. day-summary (era
    // o 3º elemento da ordem) foi removida da aba em #2736.
    // #2208 (item 4): ancorando em id= para não casar substring de nav/href.
    const idxCampaigns = html.indexOf('id="campaigns-table"');
    const idxWeekday = html.indexOf('id="weekday-openrate"');
    assert.ok(idxCampaigns > -1, 'deve encontrar id="campaigns-table"');
    assert.ok(idxWeekday > -1, 'deve encontrar id="weekday-openrate"');
    assert.ok(idxCampaigns < idxWeekday, "weekday-openrate deve vir depois de campaigns-table");
    assert.doesNotMatch(html, /id="day-summary"/, "day-summary não existe mais (#2736)");
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
    const { rows } = aggregateByWeekday(cycle2605Campaigns, "2605");
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
    const { rows } = aggregateByWeekday(cycle2605Campaigns, "2605");
    const qua = rows.find((r) => r.weekday === 2)!;
    const expectedRate = (82 / 347) * 100;
    assert.ok(Math.abs(qua.openRate - expectedRate) < 0.01,
      `openRate qua deve ser ~${expectedRate.toFixed(2)}% mas foi ${qua.openRate.toFixed(2)}%`);
  });

  test("smallSample=false quando count >= 2", () => {
    const { rows } = aggregateByWeekday(cycle2605Campaigns, "2605");
    // count=3 pra qua e qui
    for (const r of rows) {
      assert.equal(r.smallSample, false, `weekday ${r.label} com count=${r.count} não deve ser smallSample`);
    }
  });

  test("smallSample=true quando count = 1", () => {
    // Apenas 1 campanha na qua
    const single = [cycle2605Campaigns[0]]; // d01-A (qua)
    const { rows } = aggregateByWeekday(single, "2605");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].smallSample, true, "count=1 deve ser smallSample");
  });

  test("retorna [] quando ciclo não tem campanhas", () => {
    const { rows } = aggregateByWeekday(cycle2605Campaigns, "9999");
    assert.equal(rows.length, 0);
  });

  test("filtra ciclo correto (exclui campanhas de outro ciclo)", () => {
    const mixed = [
      ...cycle2605Campaigns,
      makeCampaign(99, "Clarice News 2604 d01-A (qui)", "2026-05-02T09:00:00Z",
        { sent: 500, delivered: 495, uniqueViews: 200 }),
    ];
    const { rows } = aggregateByWeekday(mixed, "2605");
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
    const { rows } = aggregateByWeekday([csOnly], "2605");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivered, 97, "deve usar campaignStats.delivered quando globalStats ausente");
    assert.equal(rows[0].opens, 40, "deve usar campaignStats.uniqueViews quando globalStats ausente");
  });

  test("omite campanhas sem sentDate", () => {
    const noDate = { ...makeCampaign(88, "Clarice News 2605 d01-A (qua)", ""), sentDate: null };
    const { rows } = aggregateByWeekday([noDate], "2605");
    assert.equal(rows.length, 0, "campanha sem sentDate não deve gerar linha");
  });

  test("omite campanhas com stats zeradas (sent=0)", () => {
    const zeroStats = {
      ...makeCampaign(89, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z"),
      statistics: { globalStats: makeGlobalStats({ sent: 0, delivered: 0, uniqueViews: 0 }) },
    };
    const { rows } = aggregateByWeekday([zeroStats], "2605");
    assert.equal(rows.length, 0, "campanha com sent=0 não deve gerar linha");
  });

  test("ordena seg→dom mesmo com sentDates fora de ordem", () => {
    // Campanhas: qui (3) antes de seg (0) na lista
    const outOfOrder = [
      makeCampaign(1, "Clarice News 2605 d02-A (qui)", "2026-06-11T09:00:00Z"),
      makeCampaign(2, "Clarice News 2605 d04-A (seg)", "2026-06-15T09:00:00Z"),
    ];
    const { rows } = aggregateByWeekday(outOfOrder, "2605");
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
    const { rows } = aggregateByWeekday(allCampaigns, null);
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

  // #2429: rótulo "Envios (eventos)" deixa claro que o número são eventos de envio,
  // não pessoas únicas (≠ universo de coortes).
  test("#2429 exibe rótulo 'envios (eventos)' com tooltip explicativo", () => {
    const html = renderVolumeSection(10499);
    // Rótulo deve incluir "envios (eventos)" (case-insensitive para robustez)
    assert.match(html, /envios \(eventos\)/i, "deve rotular como 'envios (eventos)'");
    // Tooltip deve mencionar que inclui bounces e conta por evento
    assert.match(html, /title="[^"]*inclui bounces[^"]*"/, "tooltip deve mencionar bounces");
  });
});

describe("renderWeekdaySection (#2134)", () => {
  // #2201.4: removido param `overrides` inutilizado — nunca era passado e
  // aggregateByWeekday não aceita overrides por campanha individual.
  function makeRows() {
    return aggregateByWeekday(cycle2605Campaigns, "2605").rows;
  }

  test("retorna string vazia quando rows está vazio e sem excluídos", () => {
    assert.equal(renderWeekdaySection([], "ciclo 2605", []), "");
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
    const { rows } = aggregateByWeekday(cycle2605Campaigns, "2605");
    const html = renderWeekdaySection(rows, "ciclo 2605");
    // #2201.2: regex apertada — verifica valor 82/104 em célula <td>, não substring solta.
    assert.match(html, /<td[^>]*>82<\/td>/, "deve mostrar 82 opens para Qua em célula <td>");
    assert.match(html, /<td[^>]*>104<\/td>/, "deve mostrar 104 opens para Qui em célula <td>");
  });

  test("#2185 Open rate permanece inalterado (denominador preserved = delivered)", () => {
    // Open rate = opens / delivered, NÃO usa sent como denominador
    // Qua: 82 opens / 347 delivered ≈ 23.6%
    const { rows } = aggregateByWeekday(cycle2605Campaigns, "2605");
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

    const { rows } = aggregateByWeekday(campaigns, "2605");

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

    const { rows } = aggregateByWeekday(campaigns, "2605");

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
    const { rows } = aggregateByWeekday(campaigns, "2605");

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

// ─── #2492: aggregateDaySummary / renderDaySummarySection ────────────────────

describe("aggregateDaySummary (#2492)", () => {
  test("retorna 5 rows (D1–D5) para ciclo 2605 com campanhas d01–d04", () => {
    const result = aggregateDaySummary(cycle2605Campaigns, "2605");
    assert.equal(result.length, 5, "deve retornar exatamente 5 rows (D1–D5)");
    assert.deepEqual(result.map((r) => r.label), ["D1", "D2", "D3", "D4", "D5"]);
  });

  test("agrega todas as células (A/B/C) do mesmo dia em um único row", () => {
    // cycle2605Campaigns: d01-A + d01-B + d01-C → D1 deve ter campaignCount=3
    const result = aggregateDaySummary(cycle2605Campaigns, "2605");
    const d1 = result.find((r) => r.dayNum === 1)!;
    assert.ok(d1, "deve ter row para D1");
    assert.equal(d1.campaignCount, 3, "D1 deve ter 3 campanhas (células A+B+C do d01)");
  });

  test("totalViews de D1 = soma das 3 células A+B+C do d01", () => {
    // d01-A uniqueViews=20, d01-B uniqueViews=32, d01-C uniqueViews=30 (de cycle2605Campaigns)
    const result = aggregateDaySummary(cycle2605Campaigns, "2605");
    const d1 = result.find((r) => r.dayNum === 1)!;
    assert.equal(d1.totalViews, 20 + 32 + 30, "totalViews D1 = 82 (soma A+B+C)");
  });

  test("dias sem campanhas têm campaignCount=0 e openRate=0", () => {
    const result = aggregateDaySummary(cycle2605Campaigns, "2605");
    const d5 = result.find((r) => r.dayNum === 5)!;
    assert.equal(d5.campaignCount, 0, "D5 sem campanhas deve ter count=0");
    assert.equal(d5.openRate, 0, "D5 sem campanhas deve ter openRate=0");
  });

  test("retorna 5 rows vazios para ciclo sem campanhas", () => {
    const result = aggregateDaySummary(cycle2605Campaigns, "9999");
    assert.equal(result.length, 5);
    assert.ok(result.every((r) => r.campaignCount === 0), "todos os rows devem ter count=0");
  });

  test("exclui campanhas de S2+ (dayNum > 5 ignorado)", () => {
    const s2Campaign = {
      id: 99,
      name: "Clarice News 2605 d06-A (seg)",
      subject: "s2",
      status: "sent",
      sentDate: "2026-06-17T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-06-17T09:00:00Z",
      recipients: { lists: [199] },
      statistics: { globalStats: makeGlobalStats({ sent: 150, delivered: 148, uniqueViews: 50 }) },
    };
    const result = aggregateDaySummary([...cycle2605Campaigns, s2Campaign], "2605");
    assert.ok(!result.some((r) => r.dayNum > 5), "não deve haver row para dayNum>5");
    // D1 não deve ser afetado pelo d06
    const d1 = result.find((r) => r.dayNum === 1)!;
    assert.equal(d1.campaignCount, 3, "D1 não deve ser afetado pela campanha d06");
  });
});

describe("renderDaySummarySection (#2492)", () => {
  test("retorna string vazia quando todos os dias sem campanhas", () => {
    const rows = aggregateDaySummary(cycle2605Campaigns, "9999");
    assert.equal(renderDaySummarySection(rows), "");
  });

  test("contém id='day-summary' (id único, distinto de renderAbcSection) (#2523)", () => {
    // #2523: renderDaySummarySection agora usa id="day-summary" para evitar colisão
    // com renderAbcSection que mantém id="abc-summary".
    const rows = aggregateDaySummary(cycle2605Campaigns, "2605");
    const html = renderDaySummarySection(rows);
    assert.match(html, /id="day-summary"/, "renderDaySummarySection deve usar id=day-summary (#2523)");
    assert.doesNotMatch(html, /id="abc-summary"/, "renderDaySummarySection não deve colidir com id de renderAbcSection");
  });

  test("título é 'Resumo D1–D5 — S1' (#2492)", () => {
    const rows = aggregateDaySummary(cycle2605Campaigns, "2605");
    const html = renderDaySummarySection(rows);
    assert.match(html, /Resumo D1–D5/, "título deve conter 'Resumo D1–D5'");
  });

  test("exibe rótulo D1, D2, etc. nas células", () => {
    const rows = aggregateDaySummary(cycle2605Campaigns, "2605");
    const html = renderDaySummarySection(rows);
    assert.match(html, />D1</, "deve ter célula D1");
    assert.match(html, />D2</, "deve ter célula D2");
  });

  test("identifica vencedor quando há 2+ dias com dados e taxas distintas", () => {
    const rows = aggregateDaySummary(cycle2605Campaigns, "2605");
    const html = renderDaySummarySection(rows);
    // cycle2605Campaigns tem dados para D1, D2, D3 — um deve ser LÍDER
    assert.match(html, /▲ LÍDER/, "deve identificar o dia vencedor");
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
    // totalViews MPP-incl (#2258): d01-A (20) + d02-A (35) = 55
    // (a campanha inválida com gs.sent=undefined não entra)
    assert.equal(cellA.totalViews, 20 + 35,
      "totalViews de A deve ser 55 (d01-A+d02-A, excluindo gs.sent=undefined)");
  });
});

// ─── #2254 pickStats ──────────────────────────────────────────────────────────

describe("pickStats (#2254)", () => {
  test("escolhe globalStats quando sent>0 (isGlobal=true)", () => {
    const c = makeCampaign(80, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z", { sent: 100, uniqueViews: 30 });
    const r = pickStats(c)!;
    assert.equal(r.isGlobal, true);
    assert.equal(r.stats.uniqueViews, 30);
  });

  test("cai pra campaignStats quando globalStats ausente (isGlobal=false)", () => {
    const c = {
      ...makeCampaign(81, "Clarice News 2605 d01-B (qua)", "2026-06-10T09:00:00Z"),
      statistics: { campaignStats: [{ listId: 1, sent: 100, delivered: 99, hardBounces: 0, softBounces: 0, deferred: 0, uniqueViews: 25, viewed: 30, trackableViews: 18, uniqueClicks: 2, clickers: 2, unsubscriptions: 0, complaints: 0 }], globalStats: undefined },
    };
    const r = pickStats(c)!;
    assert.equal(r.isGlobal, false);
    assert.equal(r.stats.uniqueViews, 25);
  });

  test("cai pra campaignStats quando globalStats.sent=0 (zeroed)", () => {
    const c = {
      ...makeCampaign(82, "Clarice News 2605 d01-C (qua)", "2026-06-10T09:00:00Z"),
      statistics: {
        globalStats: makeGlobalStats({ sent: 0, delivered: 0, uniqueViews: 0 }),
        campaignStats: [{ listId: 1, sent: 100, delivered: 99, hardBounces: 0, softBounces: 0, deferred: 0, uniqueViews: 22, viewed: 26, trackableViews: 15, uniqueClicks: 1, clickers: 1, unsubscriptions: 0, complaints: 0 }],
      },
    };
    const r = pickStats(c)!;
    assert.equal(r.isGlobal, false);
    assert.equal(r.stats.uniqueViews, 22);
  });

  test("retorna null quando nenhuma fonte tem sent>0", () => {
    assert.equal(pickStats({ ...makeCampaign(83, "x", "2026-06-10T09:00:00Z"), statistics: {} }), null);
    assert.equal(pickStats({ ...makeCampaign(84, "x", "2026-06-10T09:00:00Z"), statistics: { globalStats: makeGlobalStats({ sent: 0 }) } }), null);
  });
});

// ─── #2249 aggregateLinksAcrossCampaigns (repro: função está correta) ──────────

describe("aggregateLinksAcrossCampaigns (#2249)", () => {
  const withLinks = (id: number, day: number, links: Record<string, number>) => ({
    ...makeCampaign(id, `Clarice News 2605 d0${day}-A (x)`, `2026-06-1${day}T09:00:00Z`),
    statistics: { globalStats: makeGlobalStats({ sent: 100 }), linksStats: links },
  });

  test("agrega por ORIGIN, soma paths/UTM do mesmo domínio (#2263) + filtra sistema (#2249)", () => {
    // #2263: paths/query diferentes do MESMO domínio colapsam num origin só.
    // #2249: a função funciona com linksStats populado (a seção vazia em produção
    // era o GET de linksStats no param combinado retornando zerado — corrigido #2260).
    const rows = aggregateLinksAcrossCampaigns([
      withLinks(90, 1, { "https://diaria.com.br/a?utm=x": 12, "https://diaria.com.br/b": 5 }),
      withLinks(91, 2, { "https://diaria.com.br/a": 8, "https://unsubscribe.brevo.com/x": 99 }),
    ]);
    assert.ok(rows.length > 0, "deve retornar links agregados, não vazio");
    const d = rows.find((r) => r.url === "https://diaria.com.br")!;
    assert.ok(d, "agrupa por origin https://diaria.com.br");
    assert.equal(d.totalClicks, 12 + 5 + 8, "soma a(12)+b(5)+a(8) do mesmo origin = 25");
    assert.equal(d.campaignCount, 2, "2 campanhas (cada conta 1× por origin)");
    assert.equal(d.displayUrl, "https://diaria.com.br", "exibe só o origin");
    assert.ok(!rows.some((r) => /unsubscribe/.test(r.url)), "links de sistema filtrados");
    assert.ok(!rows.some((r) => r.url.includes("/a") || r.url.includes("/b") || r.url.includes("utm")), "sem path/query no resultado");
  });

  test("seção de links agregados aparece após as seções principais (#2249, #2472)", () => {
    // #2472: nova ordem — links-agregados vem por último (após cohorts), não no topo.
    const campaigns = [withLinks(92, 1, { "https://diaria.com.br/a": 7 })];
    const html = renderDashboardHtml(campaigns);
    const posLinks = html.indexOf('id="links-agregados"');
    const posCampaigns = html.indexOf('id="campaigns-table"');
    assert.ok(posLinks > 0, "seção de links agregados deve existir");
    assert.ok(posLinks > posCampaigns, "links agregados vem depois da tabela de campanhas (#2472)");
  });
});

// ─── #2251 renderScheduledSection ─────────────────────────────────────────────

describe("renderScheduledSection (#2251)", () => {
  const queued = (id: number, name: string, scheduledAt: string, listName: string, listSize: number) => ({
    id, name, subject: "s", status: "queued", sentDate: null, scheduledAt,
    createdAt: "2026-06-12T00:00:00Z", recipients: { lists: [id] }, listName, listSize,
  });

  test("lista agendadas ordenadas por horário (próximo primeiro) com lista/tamanho", () => {
    const html = renderScheduledSection([
      queued(57, "Clarice News 2605 d07-B (ter)", "2026-06-16T09:05:00Z", "lista-B", 575),
      queued(48, "Clarice News 2605 d04-B (sab)", "2026-06-13T09:05:00Z", "lista-B", 426),
    ]);
    assert.match(html, /id="scheduled-campaigns"/);
    assert.match(html, /Envios agendados/);
    assert.match(html, /d04-B/);
    assert.match(html, /d07-B/);
    assert.match(html, /575/);
    // ordem cronológica: d04 (13/jun) antes de d07 (16/jun)
    assert.ok(html.indexOf("d04-B") < html.indexOf("d07-B"), "próximo envio primeiro");
    // #2249 follow-up: colunas Dia e Lista removidas (editor 2026-06-14)
    assert.ok(!/>Dia<\/th>/.test(html), "coluna Dia removida");
    assert.ok(!/Lista de destino/.test(html), "coluna Lista removida");
    // header tem 3 colunas: Campanha, Agendado (BRT), Tamanho
    // (`<th[ >]` evita casar `<thead>`)
    const ths = (html.match(/<th[ >]/g) ?? []).length;
    assert.equal(ths, 3, "tabela de agendadas tem 3 colunas");
  });

  test("oculta (string vazia) quando não há agendadas", () => {
    assert.equal(renderScheduledSection([]), "");
  });

  test("ignora agendadas sem scheduledAt (oculta se todas sem data)", () => {
    const noDate = { id: 1, name: "x", subject: "s", status: "queued", sentDate: null, scheduledAt: null, createdAt: "x", recipients: { lists: [1] } };
    assert.equal(renderScheduledSection([noDate as any]), "");
  });

  test("renderDashboardHtml inclui a seção de agendadas quando passada", () => {
    const sent = [{ ...makeCampaign(40, "Clarice News 2605 d01-C (qua)", "2026-06-10T09:00:00Z"), statistics: { globalStats: makeGlobalStats({ sent: 100 }) } }];
    const html = renderDashboardHtml(sent, [queued(48, "Clarice News 2605 d04-B (sab)", "2026-06-13T09:05:00Z", "lista-B", 426)]);
    assert.match(html, /id="scheduled-campaigns"/);
    assert.match(html, /d04-B/);
  });

  test("renderDashboardHtml sem agendadas (default []) não mostra a seção", () => {
    const sent = [{ ...makeCampaign(40, "Clarice News 2605 d01-C (qua)", "2026-06-10T09:00:00Z"), statistics: { globalStats: makeGlobalStats({ sent: 100 }) } }];
    const html = renderDashboardHtml(sent);
    assert.ok(!/id="scheduled-campaigns"/.test(html), "sem agendadas → seção ausente");
  });
});

// ─── #2421: deriveLinksSectionTitle ─────────────────────────────────────────

describe("deriveLinksSectionTitle (#2421)", () => {
  function makeSentCampaign(name: string, sentDate: string) {
    return { name, sentDate };
  }

  test("retorna cycle-sendMonthBRT da campanha mais recente", () => {
    const campaigns = [
      makeSentCampaign("Clarice News 2605 d03-A (sex)", "2026-06-13T09:00:00Z"),
      makeSentCampaign("Clarice News 2605 d01-B (qua)", "2026-06-10T09:00:00Z"),
    ];
    assert.equal(deriveLinksSectionTitle(campaigns), "2605-06");
  });

  test("usa a campanha de maior sentDate (mais recente)", () => {
    const campaigns = [
      makeSentCampaign("Clarice News 2604 d07-C (seg)", "2026-05-31T09:00:00Z"), // mais antiga
      makeSentCampaign("Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z"), // mais recente
    ];
    assert.equal(deriveLinksSectionTitle(campaigns), "2605-06");
  });

  test("virada de mês BRT: sentDate 2026-07-01T00:00:00Z = 30/jun BRT → mês 06", () => {
    // 2026-07-01T00:00:00Z = 2026-06-30T21:00:00 BRT (UTC-3)
    const campaigns = [
      makeSentCampaign("Clarice News 2605 d07-B (ter)", "2026-07-01T00:00:00Z"),
    ];
    assert.equal(deriveLinksSectionTitle(campaigns), "2605-06", "mês deve ser 06 (BRT), não 07 (UTC)");
  });

  test("lista vazia → null (fallback 'do período')", () => {
    assert.equal(deriveLinksSectionTitle([]), null);
  });

  test("campanha sem sentDate → null", () => {
    const campaigns = [{ name: "Clarice News 2605 d01-A (qua)", sentDate: null }];
    assert.equal(deriveLinksSectionTitle(campaigns as any), null);
  });

  test("nome não parseável → null (fallback 'do período')", () => {
    const campaigns = [makeSentCampaign("T1-W1 digest", "2026-06-10T09:00:00Z")];
    assert.equal(deriveLinksSectionTitle(campaigns), null);
  });

  test("campanha não-Clarice mais recente não obscurece Clarice mais antiga (#2421 bug3)", () => {
    // Bug: sem o filtro de parseClariceCampaignKey, "T1-W1 digest" (enviado depois)
    // tornava-se o top-1 e retornava null mesmo com Clarice disponível.
    const campaigns = [
      makeSentCampaign("T1-W1 digest", "2026-06-15T09:00:00Z"), // mais recente, não-Clarice
      makeSentCampaign("Clarice News 2605 d05-A (seg)", "2026-06-12T09:00:00Z"), // Clarice
    ];
    assert.equal(deriveLinksSectionTitle(campaigns), "2605-06", "Clarice mais antiga deve ganhar sobre não-Clarice mais recente");
  });

  test("renderAggregatedLinksSection com edicaoLabel mostra edição no título", () => {
    const html = renderAggregatedLinksSection([], "2605-06");
    assert.match(html, /Links mais clicados da edição 2605-06/);
  });

  test("renderAggregatedLinksSection sem edicaoLabel usa fallback 'do período'", () => {
    const html = renderAggregatedLinksSection([]);
    assert.match(html, /Links mais clicados do período/);
  });
});

// ─── #2422: rótulos 'Campanhas' → 'Envios' ──────────────────────────────────

describe("rótulos Campanhas→Envios (#2422)", () => {
  test("renderScheduledSection usa 'Envios agendados'", () => {
    const queued = [{
      id: 1, name: "Clarice News 2605 d04-A (sab)", status: "queued" as const,
      sentDate: null, scheduledAt: "2026-06-13T09:05:00Z",
      createdAt: "2026-06-12T00:00:00Z", recipients: { lists: [1] },
      subject: "s", listName: "lista-A", listSize: 400,
    }];
    const html = renderScheduledSection(queued);
    assert.match(html, /Envios agendados/, "seção deve usar 'Envios agendados'");
    assert.doesNotMatch(html, /Campanhas agendadas/, "não deve conter 'Campanhas agendadas'");
  });

  test("renderDashboardHtml não contém 'Campanhas enviadas' como título de seção", () => {
    const sent = [{ ...makeCampaign(1, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z"), statistics: { globalStats: makeGlobalStats({ sent: 100 }) } }];
    const html = renderDashboardHtml(sent);
    assert.doesNotMatch(html, /Campanhas enviadas/, "título 'Campanhas enviadas' deve ter sido renomeado para 'Envios'");
    assert.match(html, /<h2[^>]*>Envios<\/h2>/, "seção deve ter título 'Envios'");
  });
});

// ─── #2424: ordem Delivered antes de Opens no Resumo A/B/C ─────────────────

describe("ordem colunas ABC (#2424)", () => {
  test("Delivered (total) aparece antes de Opens (total) no header", () => {
    const rows = [
      { cell: "A" as const, totalViews: 60, totalDelivered: 200, openRate: 30.0, campaignCount: 2, organicOpenRate: null },
      { cell: "B" as const, totalViews: 100, totalDelivered: 200, openRate: 50.0, campaignCount: 2, organicOpenRate: null },
      { cell: "C" as const, totalViews: 80, totalDelivered: 200, openRate: 40.0, campaignCount: 2, organicOpenRate: null },
    ];
    const html = renderAbcSection(rows);
    const posDelivered = html.indexOf("Delivered (total)");
    const posOpens = html.indexOf("Opens (total)");
    assert.ok(posDelivered > -1, "deve ter 'Delivered (total)'");
    assert.ok(posOpens > -1, "deve ter 'Opens (total)'");
    assert.ok(posDelivered < posOpens, "Delivered deve aparecer antes de Opens no header");
  });

  test("células: totalDelivered aparece antes de totalViews na linha de dados", () => {
    const rows = [
      { cell: "A" as const, totalViews: 55, totalDelivered: 200, openRate: 27.5, campaignCount: 1, organicOpenRate: null },
    ];
    const html = renderAbcSection(rows);
    const pos200 = html.indexOf(">200<"); // totalDelivered
    const pos55 = html.indexOf(">55<");   // totalViews
    assert.ok(pos200 > -1, "deve ter valor 200 (totalDelivered)");
    assert.ok(pos55 > -1, "deve ter valor 55 (totalViews)");
    assert.ok(pos200 < pos55, "totalDelivered (200) deve aparecer antes de totalViews (55) na linha");
  });
});

// ─── #2542: tab navigation ────────────────────────────────────────────────────

describe("#2542: tab navigation — estrutura HTML das abas", () => {
  // Usa allCampaigns (definido no início do arquivo) que contém campanhas variadas.
  // Precisamos de uma fixture mínima que aciona as seções condicionais (Clarice News).
  const baseCampaignForTabs = {
    id: 99,
    name: "Clarice News 2605 d01-A (qua)", // 2026-06-10 é quarta-feira em BRT
    subject: "Test",
    status: "sent",
    sentDate: "2026-06-10T09:05:00Z",
    scheduledAt: null,
    createdAt: "2026-06-10T00:00:00Z",
    recipients: { lists: [1] },
    statistics: {
      globalStats: {
        sent: 500, delivered: 490, uniqueViews: 200, viewed: 200,
        trackableViews: 180, uniqueClicks: 30, clickers: 30,
        hardBounces: 2, softBounces: 3, deferred: 0,
        unsubscriptions: 1, complaints: 0, appleMppOpens: 50,
      },
    },
    listName: "T1-W1",
    listSize: 500,
  };

  test("HTML contém 4 inputs radio para as abas (tab state)", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    // Cada aba precisa de 1 radio input (#2653: + aba Contatos; #2880: aba Cohorts
    // eliminada — a tabela Cohorts foi consolidada dentro da aba Contatos).
    const radioMatches = html.match(/type="radio"[^>]*name="dash-tab"/g) ?? [];
    assert.equal(radioMatches.length, 4, "deve ter exatamente 4 radio inputs para as 4 abas");
  });

  test("HTML contém 4 labels de aba com textos corretos", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    assert.match(html, /Visão geral/, "deve ter label 'Visão geral'");
    assert.match(html, /Engajamento/, "deve ter label 'Engajamento'");
    assert.match(html, /Links \/ CTR/, "deve ter label 'Links / CTR'");
    assert.match(html, />Contatos</, "deve ter label 'Contatos' (#2653)");
    // #2880: aba Cohorts eliminada — não deve mais existir label/radio pra ela.
    assert.doesNotMatch(html, /for="tab-cohorts"/, "não deve ter mais label 'Cohorts' como aba própria");
  });

  test("1ª aba tem checked por default (#2542: default = Visão geral)", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    // O input da aba 1 deve ter o atributo checked
    assert.match(html, /id="tab-visaogeral"[^>]*checked/, "aba Visão geral deve estar checked por default");
  });

  test("cada label aponta para o radio correto via for= (associação funcional)", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    assert.match(html, /for="tab-visaogeral"/, "label Visão geral deve ter for=tab-visaogeral");
    assert.match(html, /for="tab-engajamento"/, "label Engajamento deve ter for=tab-engajamento");
    assert.match(html, /for="tab-links"/, "label Links deve ter for=tab-links");
  });

  test("panel-visaogeral contém id=campaigns-table, monthly-totals, volume-ciclo", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    // Extrair o panel visaogeral
    const panel = html.match(/id="panel-visaogeral"[\s\S]*?(?=id="panel-engajamento")/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-visaogeral deve existir no HTML");
    assert.match(panel, /id="campaigns-table"/, "Envios deve estar no panel Visão geral");
    assert.match(panel, /id="monthly-totals"/, "Totais mensais deve estar no panel Visão geral");
    assert.match(panel, /id="volume-ciclo"/, "Volume do ciclo deve estar no panel Visão geral");
  });

  test("panel-engajamento contém id=engagement-cohorts e weekday-openrate (day-summary removida, #2736)", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    const panel = html.match(/id="panel-engajamento"[\s\S]*?(?=id="panel-links")/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-engajamento deve existir no HTML");
    assert.match(panel, /id="engagement-cohorts"/, "Coortes deve estar no panel Engajamento");
    assert.match(panel, /id="weekday-openrate"/, "Weekday deve estar no panel Engajamento");
    assert.doesNotMatch(panel, /id="day-summary"/, "Day summary foi removida do panel Engajamento (#2736)");
    assert.doesNotMatch(panel, /id="mv-status"/, "Status MillionVerifier foi removido do panel Engajamento (#2736)");
  });

  test("panel-engajamento: ordem das seções é weekday → abc → cohorts → eia-engagement (#2773)", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    const panel = html.match(/id="panel-engajamento"[\s\S]*?(?=id="panel-links")/)?.[0] ?? "";
    const idxWeekday = panel.indexOf('id="weekday-openrate"');
    const idxCohorts = panel.indexOf('id="engagement-cohorts"');
    const idxEia = panel.indexOf('id="eia-engagement"');
    assert.ok(idxWeekday >= 0 && idxCohorts >= 0 && idxEia >= 0, "todas as seções devem estar presentes");
    assert.ok(idxWeekday < idxCohorts, "weekday deve vir antes de cohorts (#2773 — coortes movida pra depois do resumo A/B/C)");
    assert.ok(idxCohorts < idxEia, "cohorts deve vir antes de eia-engagement (ordem final)");
  });

  test("panel-links contém id=links-agregados", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    const panel = html.match(/id="panel-links"[\s\S]*?<\/div><!-- \/tab-panels -->/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-links deve existir no HTML");
    assert.match(panel, /id="links-agregados"/, "Links agregados deve estar no panel Links/CTR");
  });

  test("todas as seções principais estão presentes no HTML (nenhuma perdida pela reorganização)", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    // scheduled-campaigns omitido: só aparece quando há agendados (fixture sem agendados → ausente,
    // comportamento correto — testado nos testes de renderScheduledSection).
    const sectionIds = [
      "monthly-totals",
      "volume-ciclo",
      "campaigns-table",
      "engagement-cohorts",
      "weekday-openrate",
      "links-agregados",
    ];
    for (const id of sectionIds) {
      assert.match(html, new RegExp(`id="${id}"`), `seção id="${id}" deve estar presente no HTML`);
    }
    // #2736: day-summary e mv-status foram removidas da aba Engajamento.
    assert.doesNotMatch(html, /id="day-summary"/, 'seção id="day-summary" foi removida (#2736)');
    assert.doesNotMatch(html, /id="mv-status"/, 'seção id="mv-status" foi removida (#2736)');
  });

  test("scheduled-campaigns aparece dentro de panel-visaogeral quando há agendados", () => {
    const scheduled = [{
      id: 200,
      name: "Clarice News 2605 d02-A (qua)",
      subject: "Test",
      status: "queued",
      sentDate: null,
      scheduledAt: "2026-06-25T09:00:00Z",
      createdAt: "2026-06-24T00:00:00Z",
      recipients: { lists: [1] },
      listName: "T1-W2",
      listSize: 500,
    }];
    const html = renderDashboardHtml([baseCampaignForTabs], scheduled);
    const panel = html.match(/id="panel-visaogeral"[\s\S]*?(?=id="panel-engajamento")/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-visaogeral deve existir");
    assert.match(panel, /id="scheduled-campaigns"/, "scheduled-campaigns deve estar no panel Visão geral");
  });

  test("CSS das abas usa :checked (sem JS externo para tab switching)", () => {
    const html = renderDashboardHtml([baseCampaignForTabs]);
    // O CSS deve conter :checked para o mecanismo de tab toggle
    assert.match(html, /:checked/, "CSS deve conter :checked para tab switching sem JS");
    // Confirma presença do radio+label pattern (não un script external para tabs)
    assert.match(html, /type="radio"/, "deve usar radio inputs para tab state");
  });
});

// ─── #2600: Resumo A/B/C restaurado como seção principal ─────────────────────

describe("reset A/B/C 260702 (#2871): isPostAbcReset + placeholder condicional", () => {
  test("isPostAbcReset: pós-corte → true; exatamente no corte → true; pré-corte → false", () => {
    assert.equal(isPostAbcReset({ scheduledAt: "2026-07-10T06:00:00.000-03:00" }), true);
    assert.equal(isPostAbcReset({ scheduledAt: ABC_RESET_AT }), true);
    assert.equal(isPostAbcReset({ scheduledAt: "2026-06-15T06:00:00.000-03:00" }), false);
  });

  test("isPostAbcReset: scheduledAt ausente/não-parseável → false (conservador)", () => {
    assert.equal(isPostAbcReset({ scheduledAt: null }), false);
    assert.equal(isPostAbcReset({ scheduledAt: "não-é-data" }), false);
  });

  test("all-zero SEM resetNote → oculta (neutro, comportamento pré-reset preservado)", () => {
    const emptyRows = [
      { cell: "A" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0, organicOpenRate: null },
      { cell: "B" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0, organicOpenRate: null },
      { cell: "C" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0, organicOpenRate: null },
    ];
    assert.equal(renderAbcSection(emptyRows), "");
  });

  test("all-zero COM resetNote → placeholder com data derivada de ABC_RESET_AT", () => {
    const emptyRows = [
      { cell: "A" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0, organicOpenRate: null },
      { cell: "B" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0, organicOpenRate: null },
      { cell: "C" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0, organicOpenRate: null },
    ];
    const html = renderAbcSection(emptyRows, true);
    assert.match(html, /aguardando novo teste/);
    assert.match(html, /variante B venceu/);
    // Data exibida DERIVA do const (achado A2 do review #2870 — sem drift):
    assert.match(html, /03\/07\/2026/);
    assert.match(html, /#2871/);
    assert.doesNotMatch(html, /Célula A/, "tabela de células não renderiza zerada");
  });

  test("integração renderDashboardHtml: ciclo com células só pré-reset → placeholder (o corte causou o zero)", () => {
    // allCampaigns têm scheduledAt null (fixtures legadas) → isPostAbcReset false
    // → abcRows zerado; abcRowsAll (sem filtro) tem células → resetNote=true.
    const html = renderDashboardHtml(allCampaigns);
    assert.match(html, /aguardando novo teste/);
    assert.doesNotMatch(html, /Célula A/);
  });

  test("integração renderDashboardHtml: ciclo SEM células A/B/C (S2/S3 puro) → nada renderiza (neutro)", () => {
    // Campanha sem sufixo -A/-B/-C: participa do ciclo (detectActiveCycle) mas
    // não do A/B/C → abcRowsAll TAMBÉM zerado → sem placeholder (achado A1/B1).
    const s2Only = [{ ...allCampaigns[0], id: 950, name: "Clarice News 2605 d08 (qua)" }];
    const html = renderDashboardHtml(s2Only);
    assert.doesNotMatch(html, /aguardando novo teste/);
    assert.doesNotMatch(html, /Resumo A\/B\/C — S1/);
  });
});

describe("regressão #2600: abcSection usa A/B/C (não D1-D5)", () => {
  // Reset #2871: scheduledAt pós-corte pra exercitar a TABELA REAL no caminho
  // renderDashboardHtml (com as fixtures default pré-reset, o filtro do call
  // site derruba tudo e só o placeholder renderiza — o assert /Resumo A\/B\/C/
  // casaria com ambos os branches e a regressão #2600 ficaria sem cobertura;
  // achado C2 do review #2870).
  const postResetCampaigns = allCampaigns.map((c) => ({
    ...c,
    scheduledAt: "2026-07-10T06:00:00.000-03:00",
  }));

  test("renderDashboardHtml inclui seção 'Resumo A/B/C' (não apenas D1-D5)", () => {
    const html = renderDashboardHtml(postResetCampaigns);
    assert.match(html, /Resumo A\/B\/C/i, "deve conter seção Resumo A/B/C");
    assert.match(html, /Célula A/i, "tabela REAL renderizada (não o placeholder do reset #2871)");
  });

  test("renderDashboardHtml NÃO inclui mais a seção D1-D5 (removida em #2736)", () => {
    const html = renderDashboardHtml(postResetCampaigns);
    assert.doesNotMatch(html, /Resumo D1.D5/i, "seção D1-D5 foi removida da aba Engajamento (#2736)");
  });

  test("seção A/B/C tem células A, B, C (não rótulos D1, D2)", () => {
    const rows = aggregateAbcSummary(cycle2605Campaigns, "2605");
    const html = renderAbcSection(rows);
    assert.match(html, /Célula A/i, "deve mostrar Célula A");
    assert.match(html, /Célula B/i, "deve mostrar Célula B");
    assert.match(html, /Célula C/i, "deve mostrar Célula C");
    assert.doesNotMatch(html, />D1</, "seção A/B/C não deve ter rótulo D1");
    assert.doesNotMatch(html, />D2</, "seção A/B/C não deve ter rótulo D2");
  });

  test("seção A/B/C preserva ordem de colunas Delivered/Opens (#2424)", () => {
    const rows = aggregateAbcSummary(cycle2605Campaigns, "2605");
    const html = renderAbcSection(rows);
    const idxDel = html.indexOf("Delivered");
    const idxOp = html.indexOf("Opens");
    assert.ok(idxDel < idxOp, "Delivered deve aparecer antes de Opens no header (#2424)");
  });
});

// ─── #2609: Status MillionVerifier ────────────────────────────────────────────

describe("regressão #2609: renderMvStatusSection", () => {
  test("MV_STATUS_KV_KEY é 'mv:status'", () => {
    assert.equal(MV_STATUS_KV_KEY, "mv:status");
  });

  test("stub gracioso quando mvStatus é null", () => {
    const html = renderMvStatusSection(null);
    assert.match(html, /id="mv-status"/, "deve ter âncora mv-status");
    assert.match(html, /clarice-mv-status\.ts/, "deve indicar o script para gerar dados");
    assert.doesNotMatch(html, /undefined/, "não deve ter 'undefined' no HTML");
  });

  test("regressão #2619: stub gracioso também quando groups está vazio (não tabela vazia)", () => {
    const html = renderMvStatusSection({ generatedAt: "2026-06-25T10:00:00Z", groups: [] });
    assert.match(html, /clarice-mv-status\.ts/, "groups vazio deve mostrar orientação, não tbody vazia");
    assert.doesNotMatch(html, /<tbody>/, "não deve renderizar tabela com tbody vazia");
  });

  test("renderiza badge 'N/A — validado por pagamento Stripe' para T01", () => {
    const mvStatus: MvStatus = {
      generatedAt: "2026-06-25T10:00:00Z",
      groups: [
        { group: "t01-assinantes-ativos", cycle: "2605-06", status: "t01", verifiedAt: null, verified: 0, rejected: 0, unknown: 0 },
      ],
    };
    const html = renderMvStatusSection(mvStatus);
    assert.match(html, /validado por pagamento Stripe/, "T01 deve ter nota de validação Stripe");
    assert.doesNotMatch(html, /MV pendente/, "T01 não deve mostrar 'MV pendente'");
  });

  test("renderiza badge '✓ MV {data}' para grupo verificado (T02+)", () => {
    const mvStatus: MvStatus = {
      generatedAt: "2026-06-25T10:00:00Z",
      groups: [
        {
          group: "t02-ex-assinantes",
          cycle: "2605-06",
          status: "verified",
          verifiedAt: "2026-06-20T08:00:00Z",
          verified: 950,
          rejected: 30,
          unknown: 20,
        },
      ],
    };
    const html = renderMvStatusSection(mvStatus);
    assert.match(html, /✓ MV/, "deve ter badge ✓ MV para grupo verificado");
    assert.match(html, /950/, "deve mostrar contagem de verificados");
    assert.match(html, /30/, "deve mostrar contagem de rejeitados");
    assert.match(html, /excluídos/, "deve usar rótulo 'excluídos'");
  });

  test("renderiza 'MV pendente' para grupo T02+ sem verificação", () => {
    const mvStatus: MvStatus = {
      generatedAt: "2026-06-25T10:00:00Z",
      groups: [
        { group: "t02-ex-assinantes", cycle: "2605-06", status: "pending", verifiedAt: null, verified: 0, rejected: 0, unknown: 0 },
      ],
    };
    const html = renderMvStatusSection(mvStatus);
    assert.match(html, /MV pendente/, "deve mostrar 'MV pendente' quando não verificado");
  });
});

// ─── #2611: aggregateByWeekday exclui envios <48h ─────────────────────────────

describe("regressão #2611: aggregateByWeekday filtra envios <48h", () => {
  test("WEEKDAY_MIN_AGE_HOURS é 48", () => {
    assert.equal(WEEKDAY_MIN_AGE_HOURS, 48);
  });

  function makeCampaignHoursAgo(id: number, hoursAgo: number, now: Date): typeof cycle2605Campaigns[0] {
    const sentDate = new Date(now.getTime() - hoursAgo * 3600 * 1000).toISOString();
    return makeCampaign(id, `Clarice News 2605 d0${id}-A (seg)`, sentDate, { sent: 100, delivered: 90, uniqueViews: 20 });
  }

  test("envio de 50h atrás é incluído no agregado", () => {
    const now = new Date("2026-06-26T12:00:00Z");
    const c50h = makeCampaignHoursAgo(1, 50, now);
    const { rows, excluded } = aggregateByWeekday([c50h], null, now);
    assert.equal(excluded.length, 0, "50h não deve estar no excluded");
    assert.equal(rows.length, 1, "50h deve gerar linha no agregado");
  });

  test("envio de 10h atrás é excluído (open rate instável)", () => {
    const now = new Date("2026-06-26T12:00:00Z");
    const c10h = makeCampaignHoursAgo(2, 10, now);
    const { rows, excluded } = aggregateByWeekday([c10h], null, now);
    assert.equal(rows.length, 0, "10h não deve gerar linha no agregado");
    assert.equal(excluded.length, 1, "10h deve estar no excluded");
  });

  test("envio de 47h atrás (borda) é excluído (<48h)", () => {
    const now = new Date("2026-06-26T12:00:00Z");
    const c47h = makeCampaignHoursAgo(3, 47, now);
    const { rows, excluded } = aggregateByWeekday([c47h], null, now);
    assert.equal(rows.length, 0, "47h (borda) não deve gerar linha no agregado");
    assert.equal(excluded.length, 1, "47h deve estar no excluded");
  });

  test("mix: 50h incluído, 10h excluído — agregado contém só o de 50h", () => {
    const now = new Date("2026-06-26T12:00:00Z");
    const c50h = makeCampaignHoursAgo(1, 50, now);
    const c10h = makeCampaignHoursAgo(2, 10, now);
    const { rows, excluded } = aggregateByWeekday([c50h, c10h], null, now);
    assert.equal(excluded.length, 1, "apenas 10h deve estar no excluded");
    assert.equal(rows.length, 1, "apenas 50h deve gerar linha");
    assert.equal(rows[0].count, 1, "agregado deve ter 1 campanha (a de 50h)");
  });

  test("renderWeekdaySection inclui nota com nome do excluído quando há <48h", () => {
    const now = new Date("2026-06-26T12:00:00Z");
    const c10h = makeCampaignHoursAgo(2, 10, now);
    const { rows, excluded } = aggregateByWeekday([c10h], null, now);
    const html = renderWeekdaySection(rows, "todos os envios", excluded);
    assert.match(html, /48h/, "nota deve mencionar o threshold de 48h");
    assert.match(html, /Clarice News 2605 d02-A \(seg\)/, "nota deve citar o nome do envio excluído");
  });

  test("renderWeekdaySection sem excluídos não mostra nota de <48h", () => {
    const now = new Date("2026-06-01T12:00:00Z"); // passado — todas as campanhas são ≥48h
    const { rows } = aggregateByWeekday(cycle2605Campaigns, "2605", now);
    const html = renderWeekdaySection(rows, "todos os envios", []);
    assert.doesNotMatch(html, /estabilizando/, "sem excluídos não deve ter nota de estabilizando");
  });

  // Regressão #2619 bug B: seção de weekday aparecia em branco quando todos envios eram <48h.
  // O caller (renderDashboardHtml) passava a guardar `renderWeekdaySection` atrás de
  // `weekdayRows.length > 0`, nunca chamando a função quando rows=[] mas excluded não-vazio.
  // A função em si renderiza o stub corretamente — o teste abaixo garante isso.
  test("regressão #2619: renderWeekdaySection com rows=[] e excluded não-vazio retorna HTML com stub", () => {
    const now = new Date("2026-06-26T12:00:00Z");
    const recent = makeCampaignHoursAgo(1, 5, now); // 5h atrás → excluído
    const { rows, excluded } = aggregateByWeekday([recent], null, now);
    assert.equal(rows.length, 0);
    assert.equal(excluded.length, 1);
    const html = renderWeekdaySection(rows, "todos os envios", excluded);
    assert.ok(html.length > 0, "deve retornar HTML mesmo com rows=[]");
    assert.match(html, /estabilizando/, "stub deve mencionar 'estabilizando'");
    assert.match(html, /48h/, "stub deve mencionar o threshold 48h");
  });
});

// ─── #2619: renderMvStatusSection — formato de data no badge ─────────────────

describe("regressão #2619 bug C: renderMvStatusSection — data no badge em DD/MM/YYYY", () => {
  test("badge '✓ MV' mostra data em DD/MM/YYYY sem abreviação de dia da semana", () => {
    const mvStatus: MvStatus = {
      generatedAt: "2026-06-25T10:00:00Z",
      groups: [
        {
          group: "t02-ex-assinantes",
          cycle: "2605-06",
          status: "verified",
          verifiedAt: "2026-06-20T08:00:00Z",
          verified: 950,
          rejected: 30,
          unknown: 20,
        },
      ],
    };
    const html = renderMvStatusSection(mvStatus);
    // Deve aparecer como "20/06/2026" (toLocaleDateString pt-BR com year)
    assert.match(html, /20\/06\/2026/, "data deve ser DD/MM/YYYY completo");
    // Não deve ter abreviação de dia da semana como "sex.," (bug anterior: fmtTimeBRT.slice(0,10))
    assert.doesNotMatch(html, /sex\.,/, "não deve incluir abreviação do dia da semana");
    assert.doesNotMatch(html, /\/0"/, "não deve ter string truncada como '26/0'");
  });
});

// ─── #2619: computeMvStatus — emissão de status "pending" ────────────────────

describe("regressão #2619 bug D: computeMvStatus emite 'pending' quando ciclo existe sem arquivo verificado", () => {
  let testBase: string;

  function setup() {
    testBase = join(tmpdir(), `mv-status-test-${Date.now()}`);
    mkdirSync(testBase, { recursive: true });
  }

  function teardown() {
    rmSync(testBase, { recursive: true, force: true });
  }

  test("ciclo sem mv-export-*-verified.csv gera entrada 'pending' para grupos T02+ conhecidos", () => {
    setup();
    try {
      // Base files: T01 (pula) + T02 (deve gerar pending)
      writeFileSync(join(testBase, "stripe-export-t01-assinantes-ativos.csv"), "email\na@b.com\n");
      writeFileSync(join(testBase, "stripe-export-t02-ex-assinantes.csv"), "email\nc@d.com\n");
      // Ciclo válido sem arquivos verificados
      mkdirSync(join(testBase, "2605-06"), { recursive: true });

      const result = computeMvStatus(testBase, new Date("2026-06-26T12:00:00Z"));

      const pending = result.groups.filter((g) => g.status === "pending");
      assert.equal(pending.length, 1, "deve ter 1 entrada pending para t02-ex-assinantes");
      assert.equal(pending[0].group, "t02-ex-assinantes");
      assert.equal(pending[0].cycle, "2605-06");
      assert.equal(pending[0].verifiedAt, null);
    } finally {
      teardown();
    }
  });

  test("T01 da base aparece com status 't01', nunca 'pending'", () => {
    setup();
    try {
      writeFileSync(join(testBase, "stripe-export-t01-assinantes-ativos.csv"), "email\na@b.com\n");
      mkdirSync(join(testBase, "2605-06"), { recursive: true });

      const result = computeMvStatus(testBase, new Date("2026-06-26T12:00:00Z"));

      const t01 = result.groups.filter((g) => g.status === "t01");
      assert.ok(t01.length > 0, "deve ter entrada t01");
      assert.equal(t01[0].group, "t01-assinantes-ativos");
      const pending = result.groups.filter((g) => g.status === "pending");
      assert.equal(pending.length, 0, "T01 nunca deve ser pending");
    } finally {
      teardown();
    }
  });

  test("ciclo com mv-export verificado gera status 'verified', não 'pending'", () => {
    setup();
    try {
      writeFileSync(join(testBase, "stripe-export-t02-ex-assinantes.csv"), "email\nc@d.com\n");
      mkdirSync(join(testBase, "2605-06"), { recursive: true });
      writeFileSync(
        join(testBase, "2605-06", "mv-export-t02-ex-assinantes-verified.csv"),
        "email\ne@f.com\ng@h.com\n",
      );

      const result = computeMvStatus(testBase, new Date("2026-06-26T12:00:00Z"));

      const verified = result.groups.filter((g) => g.status === "verified");
      assert.equal(verified.length, 1, "deve ter 1 entrada verified");
      assert.equal(verified[0].group, "t02-ex-assinantes");
      assert.equal(verified[0].verified, 2, "2 linhas de dados = 2 verificados");
      const pending = result.groups.filter((g) => g.status === "pending");
      assert.equal(pending.length, 0, "não deve ter pending quando arquivo verificado existe");
    } finally {
      teardown();
    }
  });

  test("verificação PARCIAL: grupo T02+ sem arquivo verificado vira 'pending' mesmo com outro grupo verificado no mesmo ciclo", () => {
    setup();
    try {
      // Dois grupos T02+ na base; só um deles verificado no ciclo.
      writeFileSync(join(testBase, "stripe-export-t02-ex-assinantes.csv"), "email\na@b.com\n");
      writeFileSync(join(testBase, "stripe-export-t03-leads.csv"), "email\nc@d.com\n");
      mkdirSync(join(testBase, "2605-06"), { recursive: true });
      writeFileSync(
        join(testBase, "2605-06", "mv-export-t02-ex-assinantes-verified.csv"),
        "email\ne@f.com\n",
      );

      const result = computeMvStatus(testBase, new Date("2026-06-26T12:00:00Z"));

      const t02 = result.groups.find((g) => g.group === "t02-ex-assinantes");
      assert.equal(t02?.status, "verified", "t02 verificado");
      const t03 = result.groups.find((g) => g.group === "t03-leads");
      assert.equal(t03?.status, "pending", "t03 não-verificado deve aparecer como pending, não sumir");
      assert.equal(t03?.cycle, "2605-06");
    } finally {
      teardown();
    }
  });
});

// ─── #2738: renderEiaEngagementSection ────────────────────────────────────────

describe("regressão #2738: renderEiaEngagementSection", () => {
  test("EIA_ENGAGEMENT_KV_KEY é 'eia:engagement'", () => {
    assert.equal(EIA_ENGAGEMENT_KV_KEY, "eia:engagement");
  });

  test("stub gracioso quando eiaEngagement é null", () => {
    const html = renderEiaEngagementSection(null);
    assert.match(html, /id="eia-engagement"/, "deve ter âncora eia-engagement");
    assert.match(html, /build-poll-eia-data\.ts/, "deve indicar o script para gerar dados");
    assert.doesNotMatch(html, /undefined/, "não deve ter 'undefined' no HTML");
  });

  test("stub gracioso também quando editions está vazio (não tabela vazia)", () => {
    const html = renderEiaEngagementSection({ editions: [], updated_at: "2026-07-01T09:00:00.000Z" });
    assert.match(html, /build-poll-eia-data\.ts/, "editions vazio deve mostrar orientação, não tbody vazia");
    assert.doesNotMatch(html, /<tbody>/, "não deve renderizar tabela com tbody vazia");
  });

  test("entrada de KV parcial sem total_votes NÃO derruba o render (degrade '—'; review #2872)", () => {
    const data = {
      editions: [
        { edition: "260701" }, // escrita parcial de KV — só o campo edition
        { edition: "260630", total_votes: 25, voted_a: 15, voted_b: 10, pct_correct: 60, correct_choice: "A", correct_count: 15 },
      ],
      updated_at: "2026-07-02T09:00:00.000Z",
    } as unknown as EiaEngagementSummary;
    const html = renderEiaEngagementSection(data); // pré-fix: TypeError → 502 na dashboard inteira
    assert.match(html, /260701/);
    // célula específica (não /—/ solto — o título da seção contém em-dash e
    // tornaria o assert tautológico; achado D2 do review deste PR):
    assert.match(html, /<td>—<\/td>/);
    assert.match(html, /<td>25<\/td>/, "linha completa segue normal");
    assert.doesNotMatch(html, /NaN|undefined/);
  });

  test("#2860: renderiza 1 linha por EDIÇÃO (reverte a agregação mensal do #2773), header 'Edição', mais recente primeiro", () => {
    const data: EiaEngagementSummary = {
      editions: [
        // fora de ordem de propósito — o render deve reordenar desc por edição.
        // 260415+260418 = mesmo mês (abril), mas devem virar 2 LINHAS (não 1).
        { edition: "260415", total_votes: 30, voted_a: 20, voted_b: 10, pct_correct: 66.7, correct_choice: "A", correct_count: 20 },
        { edition: "260418", total_votes: 47, voted_a: 30, voted_b: 17, pct_correct: 63.8, correct_choice: "A", correct_count: 30 },
        { edition: "260510", total_votes: 10, voted_a: 6, voted_b: 4, pct_correct: 60, correct_choice: "A", correct_count: 6 },
      ],
      updated_at: "2026-07-01T09:00:00.000Z",
    };
    const html = renderEiaEngagementSection(data);
    // 2 edições do mesmo mês (abril) → 2 linhas, não 1 agregada.
    assert.match(html, /260415/);
    assert.match(html, /260418/);
    assert.match(html, /260510/);
    assert.match(html, /66\.7%/, "% acerto por edição, não agregado");
    assert.match(html, /63\.8%/);
    assert.match(html, /60\.0%/);
    // header "Edição" (não mais "Mês").
    assert.match(html, /<th[^>]*>Edição<\/th>/);
    assert.doesNotMatch(html, /<th[^>]*>Mês<\/th>/, "header 'Mês' não deve aparecer nesta tabela (#2860)");
    // mais recente (260510) vem ANTES das demais, mesmo com o input fora de ordem.
    assert.ok(html.indexOf("260510") < html.indexOf("260418"), "260510 (mais recente) deve vir antes de 260418");
    assert.ok(html.indexOf("260418") < html.indexOf("260415"), "260418 deve vir antes de 260415");
    // colunas A/B removidas — só Edição/Votos/% acerto.
    assert.doesNotMatch(html, /<th[^>]*>A<\/th>/);
    assert.doesNotMatch(html, /<th[^>]*>B<\/th>/);
  });

  test("#2860: lista com mais de 30 edições limita às 30 mais recentes, com nota de corte", () => {
    const editions: EiaEngagementEdition[] = Array.from({ length: 35 }, (_, i) => ({
      edition: `2604${String(i + 1).padStart(2, "0")}`, // 260401..260435 (datas inválidas tudo bem — só string p/ ordenação)
      total_votes: 1,
      voted_a: 1,
      voted_b: 0,
      pct_correct: 100,
      correct_choice: "A",
      correct_count: 1,
    }));
    const html = renderEiaEngagementSection({ editions, updated_at: null });
    assert.match(html, /mostrando as 30 mais recentes de 35/i);
    // a mais recente (260435) deve aparecer; a mais antiga (260401) deve ter sido cortada.
    assert.match(html, /260435/);
    assert.doesNotMatch(html, /260401/);
  });

  test("#2860: exatamente 30 edições NÃO mostra nota de corte", () => {
    const editions: EiaEngagementEdition[] = Array.from({ length: 30 }, (_, i) => ({
      edition: `2604${String(i + 1).padStart(2, "0")}`,
      total_votes: 1,
      voted_a: 1,
      voted_b: 0,
      pct_correct: 100,
      correct_choice: "A",
      correct_count: 1,
    }));
    const html = renderEiaEngagementSection({ editions, updated_at: null });
    assert.doesNotMatch(html, /mostrando as/i);
  });

  test("pct_correct null → '—' (não 'null' nem 'NaN%'); votos ainda contam pro total do mês", () => {
    const data: EiaEngagementSummary = {
      editions: [
        { edition: "260418", total_votes: 3, voted_a: 2, voted_b: 1, pct_correct: null, correct_choice: null, correct_count: 0 },
      ],
      updated_at: null,
    };
    const html = renderEiaEngagementSection(data);
    assert.match(html, />—</, "deve mostrar travessão quando pct_correct é null");
    assert.match(html, />3</, "total_votes ainda soma no mês mesmo sem gabarito");
    assert.doesNotMatch(html, /null/i);
    assert.doesNotMatch(html, /NaN/);
  });

  test("sem updated_at: não mostra o texto 'Atualizado às'", () => {
    const data: EiaEngagementSummary = {
      editions: [{ edition: "260418", total_votes: 1, voted_a: 1, voted_b: 0, pct_correct: 100, correct_choice: "A", correct_count: 1 }],
      updated_at: null,
    };
    const html = renderEiaEngagementSection(data);
    assert.doesNotMatch(html, /Atualizado às/);
  });

  test("panel-engajamento inclui a seção eia-engagement (renderDashboardHtml)", () => {
    const eiaEngagement: EiaEngagementSummary = {
      editions: [{ edition: "260418", total_votes: 1, voted_a: 1, voted_b: 0, pct_correct: 100, correct_choice: "A", correct_count: 1 }],
      updated_at: "2026-07-01T09:00:00.000Z",
    };
    const html = renderDashboardHtml([], [], null, null, null, null, eiaEngagement);
    const panel = html.match(/id="panel-engajamento"[\s\S]*?(?=id="panel-links")/)?.[0] ?? "";
    assert.match(panel, /id="eia-engagement"/, "seção eia-engagement deve estar dentro do panel Engajamento");
  });
});

describe("aggregateEiaEngagementByMonth (#2773)", () => {
  test("agrega múltiplas edições do mesmo mês numa linha só (soma exata via correct_count)", () => {
    const rows = aggregateEiaEngagementByMonth([
      { edition: "260415", total_votes: 30, voted_a: 20, voted_b: 10, pct_correct: 66.7, correct_choice: "A", correct_count: 20 },
      { edition: "260418", total_votes: 47, voted_a: 30, voted_b: 17, pct_correct: 63.8, correct_choice: "A", correct_count: 30 },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].month, "2604");
    assert.equal(rows[0].label, "Abr/2026");
    assert.equal(rows[0].total_votes, 77);
    assert.ok(Math.abs((rows[0].pct_correct ?? 0) - (50 / 77) * 100) < 0.01);
  });

  test("edições sem gabarito (pct_correct null) excluídas do numerador/denominador, mas contam pro total de votos", () => {
    const rows = aggregateEiaEngagementByMonth([
      { edition: "260401", total_votes: 10, voted_a: 6, voted_b: 4, pct_correct: 60, correct_choice: "A", correct_count: 6 },
      { edition: "260402", total_votes: 5, voted_a: 3, voted_b: 2, pct_correct: null, correct_choice: null, correct_count: 0 },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_votes, 15); // 10 + 5, inclui a sem-gabarito
    assert.equal(rows[0].pct_correct, 60); // só a 260401 conta: 6/10 = 60%
  });

  test("mês inteiro sem nenhuma edição com gabarito → pct_correct null (não 0)", () => {
    const rows = aggregateEiaEngagementByMonth([
      { edition: "260401", total_votes: 3, voted_a: 2, voted_b: 1, pct_correct: null, correct_choice: null, correct_count: 0 },
    ]);
    assert.equal(rows[0].pct_correct, null);
  });

  test("meses ordenados desc (mais recente primeiro)", () => {
    const rows = aggregateEiaEngagementByMonth([
      { edition: "260401", total_votes: 1, voted_a: 1, voted_b: 0, pct_correct: 100, correct_choice: "A", correct_count: 1 },
      { edition: "260601", total_votes: 1, voted_a: 1, voted_b: 0, pct_correct: 100, correct_choice: "A", correct_count: 1 },
      { edition: "260501", total_votes: 1, voted_a: 1, voted_b: 0, pct_correct: 100, correct_choice: "A", correct_count: 1 },
    ]);
    assert.deepEqual(rows.map((r) => r.month), ["2606", "2605", "2604"]);
  });

  test("KV pré-#2773 sem correct_count (dado real já em produção) → NÃO produz NaN, trata como sem gabarito", () => {
    // Simula exatamente o shape do KV eia:engagement gravado ANTES desta PR
    // (achado do code-review: produção já tem ~15 edições nesse shape antigo).
    // correct_count é opcional (mesmo padrão de priority_points_histogram, #2731)
    // justamente pra esse literal, sem o campo, ser um EiaEngagementEdition válido.
    const staleEdition: EiaEngagementEdition = {
      edition: "260415",
      total_votes: 30,
      voted_a: 20,
      voted_b: 10,
      pct_correct: 66.7,
      correct_choice: "A",
    };
    const rows = aggregateEiaEngagementByMonth([staleEdition]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_votes, 30, "votos ainda contam mesmo sem correct_count");
    assert.equal(rows[0].pct_correct, null, "sem correct_count confiável → null, nunca NaN");
    assert.ok(!Number.isNaN(rows[0].pct_correct as any));
  });

  test("edition malformado (KV corrompido) não produz label/mês 'NaN' — entrada é ignorada", () => {
    const rows = aggregateEiaEngagementByMonth([
      { edition: "", total_votes: 5, voted_a: 3, voted_b: 2, pct_correct: 60, correct_choice: "A", correct_count: 3 },
      { edition: "26", total_votes: 2, voted_a: 1, voted_b: 1, pct_correct: 50, correct_choice: "A", correct_count: 1 },
      { edition: "260415", total_votes: 30, voted_a: 20, voted_b: 10, pct_correct: 66.7, correct_choice: "A", correct_count: 20 },
    ]);
    assert.equal(rows.length, 1, "só a edição bem-formada (260415) vira linha");
    assert.ok(!rows.some((r) => r.label.includes("NaN")), "nenhum label deve conter 'NaN'");
  });
});
