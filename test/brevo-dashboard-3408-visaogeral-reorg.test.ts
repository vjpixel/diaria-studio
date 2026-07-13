/**
 * test/brevo-dashboard-3408-visaogeral-reorg.test.ts (#3408)
 *
 * Regressão (#633) para a reorganização da aba "Visão geral" pedida pelo
 * editor em #3408 (refinamento pós #3406/#3407):
 *  1. Resumo A/B/C na Visão Geral mostra só a tabela Agregada (Fria + Quente
 *     combinadas) — sem os headers "Fria (nunca recebeu)"/"Quente (já
 *     engajada)". A aba Engajamento continua com as 3 sub-tabelas, sem
 *     nenhuma regressão.
 *  2. Ordem posicional das 4 seções dentro de panel-visaogeral:
 *     volume < abc < cupons < weekly-plan.
 *  3. Divisores narrativos "Passado"/"Presente" presentes, na ordem certa.
 *
 * Todas as funções testadas são puras, exportadas de
 * workers/brevo-dashboard/src/index.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../workers/brevo-dashboard/src/index.ts";
import type { CouponUsageReport } from "../scripts/lib/stripe-coupons.ts";

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

// Mesmo padrão de test/brevo-dashboard-fase2.test.ts (mensalSexta) — naming
// "Clarice News {ciclo} — {cell}: ..." classifica como audiência QUENTE, 3
// células com campaignCount=1 cada → satisfaz o corte de >=2 amostradas.
// "cold {ciclo} — {cell}: ..." (parseAbcAudienceCampaign) classifica como
// FRIA — precisamos das 2 audiências populadas pra exercitar a Fria/Quente
// na aba Engajamento (regressão) além da Agregada na Visão Geral.
const monthlyAbcWarm = [
  { ...makeCampaign(701, "Clarice News 2607-08 — A: subject A", "2026-08-01T06:00:00.000-03:00", { sent: 1487, delivered: 1482, uniqueViews: 702 }) },
  { ...makeCampaign(702, "Clarice News 2607-08 — B: subject B", "2026-08-01T06:00:00.000-03:00", { sent: 1489, delivered: 1484, uniqueViews: 719 }) },
  { ...makeCampaign(703, "Clarice News 2607-08 — C: subject C", "2026-08-01T06:00:00.000-03:00", { sent: 1487, delivered: 1484, uniqueViews: 691 }) },
  { ...makeCampaign(704, "cold 2607-08 — A: subject A", "2026-08-02T06:00:00.000-03:00", { sent: 1800, delivered: 1790, uniqueViews: 400 }) },
  { ...makeCampaign(705, "cold 2607-08 — B: subject B", "2026-08-02T06:00:00.000-03:00", { sent: 1800, delivered: 1791, uniqueViews: 430 }) },
  { ...makeCampaign(706, "cold 2607-08 — C: subject C", "2026-08-02T06:00:00.000-03:00", { sent: 1800, delivered: 1790, uniqueViews: 410 }) },
];

const syntheticCouponUsage: CouponUsageReport = {
  NEWS50: {
    couponIds: ["cpnSYNTH50"],
    timesRedeemed: 1,
    rowCount: 1,
    totalProjectedDiscountCents: 22450,
    redemptions: [
      {
        coupon_code: "NEWS50",
        coupon_id: "cpnSYNTH50",
        percent_off: 50,
        duration: "once",
        customer: "cus_TEST1",
        customer_email: "test1@example.com",
        subscription: "sub_SYNTH1",
        status: "active",
        created: 1782383062,
        plan_amount_cents: 44900,
        currency: "brl",
        interval: "year",
        discount_value_cents: 22450,
      },
    ],
  },
};

function extractPanel(html: string, panelId: string, nextPanelId: string): string {
  const re = new RegExp(`id="${panelId}"[\\s\\S]*?(?=id="${nextPanelId}")`);
  return html.match(re)?.[0] ?? "";
}

describe("#3408: Visão Geral — resumo A/B/C só Agregada", () => {
  test("panel-visaogeral contém 'Agregada (Fria + Quente)' mas NÃO os headers Fria/Quente", () => {
    const html = renderDashboardHtml(monthlyAbcWarm, [], null, null, null, syntheticCouponUsage);
    const panel = extractPanel(html, "panel-visaogeral", "panel-envios");
    assert.ok(panel.length > 0, "panel-visaogeral deve existir");
    assert.match(panel, /Agregada \(Fria \+ Quente\)/, "tabela Agregada deve aparecer na Visão Geral");
    assert.doesNotMatch(panel, /Fria \(nunca recebeu\)/, "sub-tabela Fria NÃO deve aparecer na Visão Geral (#3408)");
    assert.doesNotMatch(panel, /Quente \(já engajada\)/, "sub-tabela Quente NÃO deve aparecer na Visão Geral (#3408)");
  });

  test("panel-engajamento continua com as 3 sub-tabelas (Agregada/Fria/Quente) — sem regressão", () => {
    const html = renderDashboardHtml(monthlyAbcWarm, [], null, null, null, syntheticCouponUsage);
    const panel = extractPanel(html, "panel-engajamento", "panel-links");
    assert.ok(panel.length > 0, "panel-engajamento deve existir");
    assert.match(panel, /Agregada \(Fria \+ Quente\)/, "tabela Agregada deve continuar na aba Engajamento");
    assert.match(panel, /Fria \(nunca recebeu\)/, "sub-tabela Fria deve continuar na aba Engajamento");
    assert.match(panel, /Quente \(já engajada\)/, "sub-tabela Quente deve continuar na aba Engajamento");
  });
});

describe("#3408: Visão Geral — ordem passado → presente", () => {
  test("ordem posicional dentro de panel-visaogeral: volume < abc < cupons < weekly-plan", () => {
    const html = renderDashboardHtml(monthlyAbcWarm, [], null, null, null, syntheticCouponUsage);
    const panel = extractPanel(html, "panel-visaogeral", "panel-envios");
    assert.ok(panel.length > 0, "panel-visaogeral deve existir");

    const volumeIdx = panel.indexOf('id="volume-ciclo"');
    const abcIdx = panel.indexOf('id="abc-audience-aggregate-2607-08"');
    const couponsIdx = panel.indexOf('id="coupon-monthly"');
    const weeklyPlanIdx = panel.indexOf('id="weekly-plan"');

    assert.ok(volumeIdx > -1, "volume-ciclo deve existir");
    assert.ok(abcIdx > -1, "abc-audience-aggregate-2607-08 deve existir");
    assert.ok(couponsIdx > -1, "coupon-monthly deve existir");
    assert.ok(weeklyPlanIdx > -1, "weekly-plan deve existir");

    assert.ok(volumeIdx < abcIdx, "volume deve vir antes do resumo A/B/C (Passado)");
    assert.ok(abcIdx < couponsIdx, "resumo A/B/C deve vir antes de cupons (Passado → Presente)");
    assert.ok(couponsIdx < weeklyPlanIdx, "cupons deve vir antes de saúde/ramp-up (weekly-plan é a ponte pro futuro, último item)");
  });

  test("divisores narrativos 'Passado'/'Presente' presentes e na ordem certa", () => {
    const html = renderDashboardHtml(monthlyAbcWarm, [], null, null, null, syntheticCouponUsage);
    const panel = extractPanel(html, "panel-visaogeral", "panel-envios");
    const passadoIdx = panel.indexOf("Passado");
    const presenteIdx = panel.indexOf("Presente");
    assert.ok(passadoIdx > -1, "header 'Passado' deve existir");
    assert.ok(presenteIdx > -1, "header 'Presente' deve existir");
    assert.ok(passadoIdx < presenteIdx, "'Passado' deve vir antes de 'Presente'");

    const weeklyPlanIdx = panel.indexOf('id="weekly-plan"');
    assert.ok(presenteIdx < weeklyPlanIdx, "weekly-plan (saúde/ramp-up) deve estar dentro do bloco Presente");
  });
});
