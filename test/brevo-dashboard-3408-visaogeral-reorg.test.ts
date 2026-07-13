/**
 * test/brevo-dashboard-3408-visaogeral-reorg.test.ts (#3408, reorg #3415)
 *
 * Regressão (#633) para a reorganização da aba "Visão GERAL" pedida pelo
 * editor:
 *  1. Resumo A/B/C na Visão Geral mostra só a tabela Agregada (Fria + Quente
 *     combinadas) — sem os headers "Fria (nunca recebeu)"/"Quente (já
 *     engajada)". A aba Engajamento continua com as 3 sub-tabelas, sem
 *     nenhuma regressão. (#3408, sem mudança)
 *  2. #3415: 3 blocos narrativos (Passado/Presente/Futuro), cada um com as
 *     seções na ordem certa — a aba Agendamento não é mais reaproveitada
 *     inteira (id="weekly-plan"); "Saúde"/"Recomendação"/"Envios agendados"/
 *     "Melhores dias" são peças extraídas, uma por bloco.
 *  3. Renames scoped só nesta aba ("Saúde", "Cupons") não vazam pras abas
 *     de origem (Agendamento, Cupons).
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

describe("#3415: Visão Geral — reorg Passado/Presente/Futuro", () => {
  test("ordem posicional dentro de panel-visaogeral: totais < saúde < volume < cupons < abc < recomendação", () => {
    const html = renderDashboardHtml(monthlyAbcWarm, [], null, null, null, syntheticCouponUsage);
    const panel = extractPanel(html, "panel-visaogeral", "panel-envios");
    assert.ok(panel.length > 0, "panel-visaogeral deve existir");

    const monthlyIdx = panel.indexOf('id="monthly-totals"');
    const healthIdx = panel.indexOf('id="weekly-plan-health"');
    const volumeIdx = panel.indexOf('id="volume-ciclo"');
    const couponsIdx = panel.indexOf('id="coupon-monthly"');
    const abcIdx = panel.indexOf('id="abc-audience-aggregate-2607-08"');
    const recommendationIdx = panel.indexOf('id="weekly-plan-recommendation"');

    assert.ok(monthlyIdx > -1, "monthly-totals deve existir");
    assert.ok(healthIdx > -1, "weekly-plan-health (Saúde) deve existir");
    assert.ok(volumeIdx > -1, "volume-ciclo deve existir");
    assert.ok(couponsIdx > -1, "coupon-monthly deve existir");
    assert.ok(abcIdx > -1, "abc-audience-aggregate-2607-08 deve existir");
    assert.ok(recommendationIdx > -1, "weekly-plan-recommendation deve existir");

    assert.ok(monthlyIdx < healthIdx, "totais por mês vem antes de Saúde (Passado)");
    assert.ok(healthIdx < volumeIdx, "Saúde (Passado) vem antes de volume (Presente)");
    assert.ok(volumeIdx < couponsIdx, "volume vem antes de cupons (Presente)");
    assert.ok(couponsIdx < abcIdx, "cupons vem antes do resumo A/B/C (Presente)");
    assert.ok(abcIdx < recommendationIdx, "resumo A/B/C (Presente) vem antes da recomendação (Futuro)");

    // "Melhores dias" (weekly-plan-weekdays) é condicional — só renderiza com
    // ≥2 dias de envio maduros (>48h) relativo ao `now` real (renderDashboardHtml
    // usa `new Date()`, não injetável aqui). Quando presente, checa só a posição
    // relativa (dentro do Presente, antes da Futuro) sem exigir que exista.
    const weekdaysIdx = panel.indexOf('id="weekly-plan-weekdays"');
    if (weekdaysIdx > -1) {
      assert.ok(abcIdx < weekdaysIdx, "melhores dias, quando presente, vem depois do resumo A/B/C (Presente)");
      assert.ok(weekdaysIdx < recommendationIdx, "melhores dias, quando presente, vem antes da recomendação (Futuro)");
    }
  });

  test("divisores narrativos 'Passado'/'Presente'/'Futuro' presentes, na ordem certa, cada seção no bloco certo", () => {
    const html = renderDashboardHtml(monthlyAbcWarm, [], null, null, null, syntheticCouponUsage);
    const panel = extractPanel(html, "panel-visaogeral", "panel-envios");
    const passadoIdx = panel.indexOf("Passado");
    const presenteIdx = panel.indexOf("Presente");
    const futuroIdx = panel.indexOf("Futuro");
    assert.ok(passadoIdx > -1 && presenteIdx > -1 && futuroIdx > -1, "os 3 headers narrativos devem existir");
    assert.ok(passadoIdx < presenteIdx && presenteIdx < futuroIdx, "ordem: Passado < Presente < Futuro");

    const healthIdx = panel.indexOf('id="weekly-plan-health"');
    const volumeIdx = panel.indexOf('id="volume-ciclo"');
    const recommendationIdx = panel.indexOf('id="weekly-plan-recommendation"');

    assert.ok(passadoIdx < healthIdx && healthIdx < presenteIdx, "Saúde deve estar dentro do bloco Passado");
    assert.ok(presenteIdx < volumeIdx && volumeIdx < futuroIdx, "Volume deve estar dentro do bloco Presente");
    assert.ok(futuroIdx < recommendationIdx, "Recomendação deve estar dentro do bloco Futuro");
  });

  test("bundle completo da aba Agendamento (id=weekly-plan) não vaza pra Visão Geral — só as peças extraídas", () => {
    const html = renderDashboardHtml(monthlyAbcWarm, [], null, null, null, syntheticCouponUsage);
    const panel = extractPanel(html, "panel-visaogeral", "panel-envios");
    assert.doesNotMatch(panel, /id="weekly-plan"/, "id exato 'weekly-plan' (bundle) não deve aparecer, só as variantes -health/-recommendation/-weekdays");
    // "Dias de envio incluídos"/accordions de detalhe só existem no bundle completo (aba Agendamento).
    assert.doesNotMatch(panel, /Dias de envio incluídos no agregado/, "accordions de detalhe do bundle completo não devem vazar pra Visão Geral");
  });
});

describe("#3415: Visão Geral — renames scoped (Saúde/Cupons) não vazam pras abas de origem", () => {
  test("aba Agendamento mantém o título original 'Agendamento — plano de envio semanal' (rename 'Saúde' é só na Visão Geral)", () => {
    const html = renderDashboardHtml(monthlyAbcWarm, [], null, null, null, syntheticCouponUsage);
    const panelRampa = extractPanel(html, "panel-rampa", "panel-engajamento");
    assert.ok(panelRampa.length > 0, "panel-rampa deve existir");
    assert.match(panelRampa, /Agendamento — plano de envio semanal/, "título original preservado na aba Agendamento");

    const panelVisaoGeral = extractPanel(html, "panel-visaogeral", "panel-envios");
    assert.match(panelVisaoGeral, />Saúde<\/h2>/, "Visão Geral mostra o rename 'Saúde'");
  });

  test("aba Cupons mantém o título original 'Total por mês' (rename 'Cupons' é só na Visão Geral)", () => {
    const html = renderDashboardHtml(monthlyAbcWarm, [], null, null, null, syntheticCouponUsage);
    assert.ok(html.includes('id="panel-cupons"'), "panel-cupons deve existir");
    // panel-cupons é o último painel do template — sem próximo marcador pra
    // delimitar via lookahead, então corta do início dele até o fim do HTML.
    const cuponsPanelRaw = html.slice(html.indexOf('id="panel-cupons"'));
    assert.match(cuponsPanelRaw, /Total por mês/, "título original preservado na aba Cupons");

    const panelVisaoGeral = extractPanel(html, "panel-visaogeral", "panel-envios");
    assert.match(panelVisaoGeral, />Cupons<\/h2>/, "Visão Geral mostra o rename 'Cupons'");
  });
});
