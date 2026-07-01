/**
 * test/dashboard-coupons-tab.test.ts (#2718)
 *
 * Cobre:
 *  (a) Com `couponUsage` sintético: output contém `panel-cupons` e o email de teste.
 *  (b) Com `null`: output NÃO contém `panel-cupons` NEM nenhum email — garantia PII-off.
 *  (c) As 4 abas existentes estão presentes em ambos os casos.
 *
 * Usa fixtures 100% sintéticas: nenhum id real nem email real commitado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderDashboardHtml,
  renderCouponTabPanel,
  getCouponUsage,
} from "../workers/brevo-dashboard/src/index.ts";
import type { CouponUsageReport, RedemptionRow } from "../scripts/lib/stripe-coupons.ts";

// ---------------------------------------------------------------------------
// Fixture sintética — IDs e emails exclusivamente @example.com
// ---------------------------------------------------------------------------

const syntheticUsage: CouponUsageReport = {
  NEWS50: {
    couponIds: ["cpnSYNTH50"],
    timesRedeemed: 2,
    rowCount: 2,
    totalProjectedDiscountCents: 44900,
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
      {
        coupon_code: "NEWS50",
        coupon_id: "cpnSYNTH50",
        percent_off: 50,
        duration: "once",
        customer: "cus_TEST2",
        customer_email: "test2@example.com",
        subscription: "sub_SYNTH2",
        status: "trialing",
        created: 1782400000,
        plan_amount_cents: 44900,
        currency: "brl",
        interval: "year",
        discount_value_cents: 22450,
      },
    ],
  },
  NEWS25: {
    couponIds: ["cpnSYNTH25"],
    timesRedeemed: 1,
    rowCount: 1,
    totalProjectedDiscountCents: 7493,
    redemptions: [
      {
        coupon_code: "NEWS25",
        coupon_id: "cpnSYNTH25",
        percent_off: 25,
        duration: "repeating",
        customer: "cus_TEST3",
        customer_email: "test3@example.com",
        subscription: "sub_SYNTH3",
        status: "active",
        created: 1782450000,
        plan_amount_cents: 9990,
        currency: "brl",
        interval: "month",
        discount_value_cents: 7493,
      },
    ],
  },
};

// Campanhas mínimas para renderDashboardHtml não explodir
const emptyCampaigns: [] = [];

// ---------------------------------------------------------------------------
// Tests: getCouponUsage — PII guard + KV-first behavior (#2718, #2726)
// ---------------------------------------------------------------------------

describe("getCouponUsage — PII guard (/api/coupons)", () => {
  // Env sem STATS_CACHE: testa o guard de flag e o fallback "sem Stripe + sem KV → null"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeEnv = (opts: { tabEnabled?: string; apiKey?: string }) =>
    ({
      COUPONS_TAB_ENABLED: opts.tabEnabled,
      STRIPE_API_KEY: opts.apiKey,
      STATS_CACHE: undefined as any, // KVNamespace só disponível no runtime do Worker
    }) as any;

  it("retorna null quando COUPONS_TAB_ENABLED está ausente", async () => {
    const result = await getCouponUsage(makeEnv({}), false);
    assert.equal(result, null, "deve retornar null → rota retornaria 404");
  });

  it("retorna null quando COUPONS_TAB_ENABLED='false'", async () => {
    const result = await getCouponUsage(makeEnv({ tabEnabled: "false" }), false);
    assert.equal(result, null, "deve retornar null → rota retornaria 404");
  });

  it("retorna null quando KV e STRIPE_API_KEY estão ausentes (flag ON)", async () => {
    // Cobre o path: STATS_CACHE undefined → sem KV → sem Stripe key → null
    const result = await getCouponUsage(makeEnv({ tabEnabled: "true" }), false);
    assert.equal(result, null, "KV vazio + sem Stripe key → deve retornar null → rota retornaria 404");
  });

  // Regressão #2726: o comportamento KV-first (cobre o path principal do PR)
  it("retorna dados do KV mesmo sem STRIPE_API_KEY quando KV tem dados (isFresh=false)", async () => {
    const mockKv = { get: async () => syntheticUsage, put: async () => {} };
    const result = await getCouponUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: undefined, STATS_CACHE: mockKv as any },
      false,
    );
    assert.notEqual(result, null, "KV hit deve retornar dados mesmo sem STRIPE_API_KEY");
    assert.deepEqual(result, syntheticUsage);
  });

  it("retorna dados do KV quando isFresh=true mas STRIPE_API_KEY ausente (KV-only deployment)", async () => {
    // Em KV-only, isFresh=true não tem fonte mais fresca que o KV — deve servir KV.
    const mockKv = { get: async () => syntheticUsage, put: async () => {} };
    const result = await getCouponUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: undefined, STATS_CACHE: mockKv as any },
      true, // isFresh=true
    );
    assert.notEqual(result, null, "KV-only + isFresh=true: sem Stripe disponível → retorna KV como melhor disponível");
    assert.deepEqual(result, syntheticUsage);
  });

  it("retorna null quando isFresh=true, KV vazio e STRIPE_API_KEY ausente", async () => {
    const mockKv = { get: async () => null, put: async () => {} };
    const result = await getCouponUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: undefined, STATS_CACHE: mockKv as any },
      true,
    );
    assert.equal(result, null, "isFresh=true + KV vazio + sem Stripe → null");
  });
});

// ---------------------------------------------------------------------------
// Tests: renderCouponTabPanel (unitário, sem deps do dashboard)
// ---------------------------------------------------------------------------

describe("renderCouponTabPanel", () => {
  const html = renderCouponTabPanel(syntheticUsage);

  it("contém coupon-monthly e coupon-detail (#2758: 'Resumo por cupom' removido)", () => {
    assert.ok(html.includes("coupon-monthly"), "deve ter seção coupon-monthly (total por mês)");
    assert.ok(html.includes("coupon-detail"), "deve ter seção coupon-detail");
    assert.ok(!html.includes("coupon-summary"), "seção coupon-summary (Resumo por cupom) foi removida");
    assert.ok(!html.includes("Resumo por cupom"), "título 'Resumo por cupom' não aparece mais");
  });

  it("contém o email sintético test1@example.com", () => {
    assert.ok(html.includes("test1@example.com"), "deve listar test1@example.com");
  });

  it("escapa HTML no email (XSS-safe)", () => {
    const malicious: CouponUsageReport = {
      XSS: {
        couponIds: ["cpn_xss"],
        timesRedeemed: 1,
        rowCount: 1,
        totalProjectedDiscountCents: 0,
        redemptions: [
          {
            coupon_code: "XSS",
            coupon_id: "cpn_xss",
            percent_off: null,
            duration: "once",
            customer: "cus_xss",
            customer_email: '<script>alert("xss")</script>@example.com',
            subscription: "sub_xss",
            status: "active",
            created: 1782383062,
            plan_amount_cents: 0,
            currency: "brl",
            interval: "month",
            discount_value_cents: 0,
          },
        ],
      },
    };
    const h = renderCouponTabPanel(malicious);
    assert.ok(!h.includes("<script>"), "email malicioso deve ser escapado");
    assert.ok(h.includes("&lt;script&gt;"), "email escapado deve conter &lt;script&gt;");
  });

  // #2743: colunas de PAGO + COMISSÃO (40%), não desconto projetado.
  describe("comissão (#2743)", () => {
    const usage: CouponUsageReport = {
      NEWS50: {
        couponIds: ["cpnSYNTH50"],
        timesRedeemed: 1,
        rowCount: 1,
        totalProjectedDiscountCents: 22450,
        totalPaidCents: 84900,
        totalCommissionCents: 33960,
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
            paid_cents: 84900,
            commission_cents: 33960,
          },
        ],
      },
    };
    const h = renderCouponTabPanel(usage);

    it("cabeçalhos de Pago + Comissão presentes no detalhe", () => {
      assert.ok(h.includes("Pago (12m)"), "coluna Pago no detalhe");
      assert.ok(h.includes("Comissão (40%)"), "coluna Comissão no detalhe");
    });

    it("mostra o valor pago e a comissão formatados (R$849,00 / R$339,60)", () => {
      assert.ok(h.includes("R$849,00"), "pago formatado");
      assert.ok(h.includes("R$339,60"), "comissão formatada");
    });

    it("KV legado sem os campos → render usa 0 (backward-compat, sem crash)", () => {
      // Simula coupons:usage populado antes do #2743 (sem paid/commission).
      const legacy = {
        NEWS50: {
          couponIds: ["cpnSYNTH50"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
          redemptions: [{
            coupon_code: "NEWS50", coupon_id: "cpnSYNTH50", percent_off: 50, duration: "once",
            customer: "cus_X", customer_email: "x@example.com", subscription: "sub_X", status: "active",
            created: 1782383062, plan_amount_cents: 44900, currency: "brl", interval: "year", discount_value_cents: 0,
          }],
        },
      } as unknown as CouponUsageReport;
      const hLegacy = renderCouponTabPanel(legacy);
      assert.ok(hLegacy.includes("R$0,00"), "campos ausentes renderizam R$0,00");
      assert.ok(hLegacy.includes("coupon-monthly"), "seção mensal ainda renderiza (vazia)");
    });
  });

  describe("Pagamentos — fallback pra 1º pagamento/previsão sem lista (#2749, KV legado do #2758)", () => {
    const mkUsage = (over: Partial<RedemptionRow>): CouponUsageReport => ({
      NEWS50: {
        couponIds: ["cpnSYNTH50"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
        totalPaidCents: 0, totalCommissionCents: 0,
        redemptions: [{
          coupon_code: "NEWS50", coupon_id: "cpnSYNTH50", percent_off: 50, duration: "once",
          customer: "cus_F", customer_email: "f@example.com", subscription: "sub_F", status: "trialing",
          created: 1782383062, plan_amount_cents: 44900, currency: "brl", interval: "year",
          discount_value_cents: 0, paid_cents: 0, commission_cents: 0, ...over,
        }],
      },
    });

    it("cabeçalho 'Pagamentos' substitui 'Criada' e '1º pagamento' (#2758)", () => {
      const h = renderCouponTabPanel(mkUsage({ first_payment_epoch: 1783442446, first_payment_is_forecast: true }));
      assert.ok(h.includes("<th>Pagamentos</th>"), "novo cabeçalho presente");
      assert.ok(!h.includes("<th>Criada</th>"), "cabeçalho antigo (#2743) removido");
      assert.ok(!h.includes("<th>1º pagamento</th>"), "cabeçalho intermediário (#2749) removido");
    });

    it("previsão (trial) → data com '*' + legenda", () => {
      const h = renderCouponTabPanel(mkUsage({ first_payment_epoch: 1783442446, first_payment_is_forecast: true }));
      assert.match(h, /\d{2}\/\d{2}\/\d{4}\*/, "data seguida de asterisco");
      assert.ok(h.includes("previsão do 1º pagamento"), "legenda do asterisco presente");
    });

    it("pagamento real → data (sem '*') e sem legenda", () => {
      const h = renderCouponTabPanel(mkUsage({ first_payment_epoch: 1783442446, first_payment_is_forecast: false }));
      // positivo: a linha renderizou de fato (não vacuamente vazia).
      assert.ok(h.includes("f@example.com"), "linha renderizada");
      assert.match(h, /\d{2}\/\d{2}\/\d{4}/, "há uma data na célula");
      assert.ok(!/\d{2}\/\d{2}\/\d{4}\*/.test(h), "data sem asterisco");
      assert.ok(!h.includes("previsão do 1º pagamento"), "sem legenda quando não há previsão");
    });

    it("multi-linha: só a linha de previsão tem '*' e a legenda aparece 1×", () => {
      const usage: CouponUsageReport = {
        NEWS50: {
          couponIds: ["cpnSYNTH50"], timesRedeemed: 2, rowCount: 2, totalProjectedDiscountCents: 0,
          totalPaidCents: 44900, totalCommissionCents: 17960,
          redemptions: [
            {
              coupon_code: "NEWS50", coupon_id: "cpnSYNTH50", percent_off: 50, duration: "once",
              customer: "cus_R", customer_email: "real@example.com", subscription: "sub_R", status: "active",
              created: 1782383062, plan_amount_cents: 44900, currency: "brl", interval: "year",
              discount_value_cents: 0, paid_cents: 44900, commission_cents: 17960,
              first_payment_epoch: 1783442446, first_payment_is_forecast: false,
            },
            {
              coupon_code: "NEWS50", coupon_id: "cpnSYNTH50", percent_off: 50, duration: "once",
              customer: "cus_F", customer_email: "trial@example.com", subscription: "sub_F", status: "trialing",
              created: 1782673121, plan_amount_cents: 44900, currency: "brl", interval: "year",
              discount_value_cents: 0, paid_cents: 0, commission_cents: 0,
              first_payment_epoch: 1784000000, first_payment_is_forecast: true,
            },
          ],
        },
      };
      const h = renderCouponTabPanel(usage);
      const asterisks = h.match(/\d{2}\/\d{2}\/\d{4}\*/g) ?? [];
      assert.equal(asterisks.length, 1, "só a linha de previsão tem asterisco");
      const legendCount = (h.match(/previsão do 1º pagamento/g) ?? []).length;
      assert.equal(legendCount, 1, "legenda única");
      assert.ok(h.includes("real@example.com") && h.includes("trial@example.com"), "as duas linhas renderizam");
    });

    it("data formatada em BRT (America/Sao_Paulo), não UTC", () => {
      // epoch 2026-07-01T01:30:00Z = 2026-06-30 22:30 BRT (UTC-3) → dia BRT = 30/06.
      const epoch = Math.floor(Date.UTC(2026, 6, 1, 1, 30, 0) / 1000);
      const h = renderCouponTabPanel(mkUsage({ first_payment_epoch: epoch, first_payment_is_forecast: true }));
      assert.ok(h.includes("30/06/2026*"), "dia BRT (30/06), não UTC (01/07)");
    });

    it("KV legado sem first_payment_* → usa created, sem '*' nem legenda", () => {
      const h = renderCouponTabPanel(mkUsage({}));
      assert.ok(!/\d{2}\/\d{2}\/\d{4}\*/.test(h), "sem asterisco no legado");
      assert.ok(!h.includes("previsão do 1º pagamento"), "sem legenda no legado");
    });
  });

  describe("Pagamentos — lista completa + total por mês (#2758)", () => {
    const mkUsageWithPayments = (payments: { epoch: number; amount_cents: number }[]): CouponUsageReport => ({
      NEWS25: {
        couponIds: ["cpnSYNTH25"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
        totalPaidCents: payments.reduce((s, p) => s + p.amount_cents, 0),
        totalCommissionCents: 0,
        redemptions: [{
          coupon_code: "NEWS25", coupon_id: "cpnSYNTH25", percent_off: 25, duration: "repeating",
          customer: "cus_M", customer_email: "monthly@example.com", subscription: "sub_M", status: "active",
          created: 1782383062, plan_amount_cents: 9990, currency: "brl", interval: "month",
          discount_value_cents: 0,
          paid_cents: payments.reduce((s, p) => s + p.amount_cents, 0),
          commission_cents: 0,
          payments,
        }],
      },
    });

    it("plano mensal com 3 pagamentos: célula mostra contagem + total, expande as 3 datas", () => {
      const h = renderCouponTabPanel(mkUsageWithPayments([
        { epoch: 1782383062, amount_cents: 9990 },
        { epoch: 1785061462, amount_cents: 9990 },
        { epoch: 1787739862, amount_cents: 9990 },
      ]));
      assert.ok(h.includes("3 pagamentos"), "contagem plural");
      assert.ok(h.includes("R$299,70"), "total dos 3 pagamentos (3×R$99,90)");
      assert.ok(h.includes("payments-list"), "lista expansível presente");
      // 3 itens individuais na lista expandida (cada um R$99,90)
      const occurrences = (h.match(/R\$99,90/g) ?? []).length;
      assert.ok(occurrences >= 3, "cada pagamento individual (R$99,90) aparece na lista expandida");
    });

    it("1 pagamento: singular ('1 pagamento', não '1 pagamentos')", () => {
      const h = renderCouponTabPanel(mkUsageWithPayments([{ epoch: 1782383062, amount_cents: 9990 }]));
      assert.ok(h.includes("1 pagamento"), "singular presente");
      assert.ok(!h.includes("1 pagamentos"), "sem plural incorreto");
    });

    it("payments=[] (trial, sem cobrança) → cai pro fallback de previsão, não pra lista vazia", () => {
      const usage: CouponUsageReport = {
        NEWS25: {
          couponIds: ["cpnSYNTH25"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
          totalPaidCents: 0, totalCommissionCents: 0,
          redemptions: [{
            coupon_code: "NEWS25", coupon_id: "cpnSYNTH25", percent_off: 25, duration: "repeating",
            customer: "cus_T", customer_email: "trial2@example.com", subscription: "sub_T", status: "trialing",
            created: 1782383062, plan_amount_cents: 9990, currency: "brl", interval: "month",
            discount_value_cents: 0, paid_cents: 0, commission_cents: 0,
            first_payment_epoch: 1783000000, first_payment_is_forecast: true,
            payments: [],
          }],
        },
      };
      const h = renderCouponTabPanel(usage);
      assert.ok(!h.includes("0 pagamentos"), "não mostra '0 pagamentos' — usa a previsão");
      assert.match(h, /\d{2}\/\d{2}\/\d{4}\*/, "mostra a data prevista com asterisco");
    });

    describe("tabela mensal (coupon-monthly)", () => {
      it("sem nenhum pagamento em lugar nenhum → mensagem vazia graciosa", () => {
        const h = renderCouponTabPanel(syntheticUsage); // fixture sem `payments` em nenhuma redemption
        assert.ok(h.includes("coupon-monthly"), "seção presente");
        assert.ok(h.includes("Nenhum pagamento registrado"), "mensagem vazia");
      });

      it("agrupa pagamentos de meses diferentes em buckets separados, ordenados desc", () => {
        // jan/2026 e mar/2026 (BRT) — meses bem distantes, sem ambiguidade de fuso.
        const jan = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
        const mar = Math.floor(Date.UTC(2026, 2, 15, 12, 0, 0) / 1000);
        const h = renderCouponTabPanel(mkUsageWithPayments([
          { epoch: jan, amount_cents: 9990 },
          { epoch: mar, amount_cents: 9990 },
        ]));
        const idxMar = h.indexOf("03/2026");
        const idxJan = h.indexOf("01/2026");
        assert.ok(idxMar !== -1 && idxJan !== -1, "os dois meses aparecem");
        assert.ok(idxMar < idxJan, "mês mais recente (03/2026) vem ANTES do mais antigo (01/2026) — ordem desc");
      });

      it("drill-down do mês mostra cupom/email/plano/valor/comissão/data de cada pagamento", () => {
        const h = renderCouponTabPanel(mkUsageWithPayments([{ epoch: 1782383062, amount_cents: 9990 }]));
        assert.ok(h.includes("monthly@example.com"), "email do pagamento no drill-down");
        assert.ok(h.includes("NEWS25"), "cupom no drill-down");
        assert.ok(h.includes(fmtBRLTest(3996)), "comissão de 40% sobre R$99,90 (R$39,96) calculada por pagamento");
      });

      it("total do mês soma pago + comissão corretamente (2 pagamentos no mesmo mês)", () => {
        const epochA = 1782383062;
        const epochB = epochA + 86400; // dia seguinte, mesmo mês BRT
        const h = renderCouponTabPanel(mkUsageWithPayments([
          { epoch: epochA, amount_cents: 9990 },
          { epoch: epochB, amount_cents: 9990 },
        ]));
        assert.ok(h.includes("R$199,80"), "pago total do mês (2×R$99,90)");
        assert.ok(h.includes(fmtBRLTest(Math.round(19980 * 0.4))), "comissão total do mês (40% de R$199,80)");
      });

      it("KV legado (sem `payments` em nenhuma redemption) → seção mensal vazia, não crasha", () => {
        const h = renderCouponTabPanel(syntheticUsage);
        assert.ok(h.includes("coupon-monthly"));
        assert.doesNotThrow(() => renderCouponTabPanel(syntheticUsage));
      });
    });
  });
});

function fmtBRLTest(cents: number): string {
  const abs = Math.abs(cents);
  return `R$${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Tests: renderDashboardHtml — tab habilitada vs. desabilitada
// ---------------------------------------------------------------------------

describe("renderDashboardHtml — couponUsage", () => {
  describe("(a) com fixture sintética (couponUsage != null)", () => {
    const html = renderDashboardHtml(emptyCampaigns, [], null, null, null, syntheticUsage);

    it("contém o painel de cupons (div id=panel-cupons)", () => {
      // #2741: checa o DIV do painel, não a string crua — o seletor CSS
      // `#panel-cupons` é estático (sempre no <style>), então `includes("panel-cupons")`
      // passaria mesmo sem o painel. Simétrico com o teste PII-off do bloco (b).
      assert.ok(html.includes('id="panel-cupons"'), "deve conter o div do painel de cupons");
    });

    it("contém tab-cupons (radio input)", () => {
      assert.ok(html.includes('id="tab-cupons"'), "deve conter o radio da aba");
    });

    it("contém tablabel-cupons (label)", () => {
      assert.ok(html.includes("tablabel-cupons"), "deve conter o label da aba");
    });

    it("contém o email sintético test1@example.com", () => {
      assert.ok(html.includes("test1@example.com"), "deve listar test1@example.com no painel");
    });

    // Regressão #2741: a aba de Cupons foi adicionada (#2718) mas as regras CSS
    // `:checked` esqueceram os cupons — o label aparecia mas clicar não exibia o
    // painel (ficava display:none). Sintoma: "a aba não tem conteúdo".
    it("CSS exibe o painel quando a aba Cupons é selecionada (regra :checked)", () => {
      assert.ok(
        html.includes("#tab-cupons:checked ~ .tab-panels #panel-cupons"),
        "sem esta regra, clicar na aba Cupons não mostra o painel (fica display:none)",
      );
    });

    it("CSS destaca o label da aba Cupons quando selecionada", () => {
      assert.ok(
        html.includes('#tab-cupons:checked ~ .tab-bar label[for="tab-cupons"]'),
        "aba Cupons deve receber o estilo de aba ativa quando selecionada",
      );
    });
  });

  describe("(b) com null (PII-off guarantee)", () => {
    const html = renderDashboardHtml(emptyCampaigns, [], null, null, null, null);

    it("NÃO contém o painel de cupons (div id=panel-cupons)", () => {
      // #2741: a regra CSS `#panel-cupons` é estática (sempre no <style>), então
      // checamos o DIV do painel — não a string crua — pra não confundir seletor
      // com conteúdo. O painel/PII só é renderizado quando couponUsage != null.
      assert.ok(!html.includes('id="panel-cupons"'), "div do painel de cupons não deve aparecer quando desabilitado");
    });

    it("NÃO contém tab-cupons (radio input)", () => {
      assert.ok(!html.includes('id="tab-cupons"'), "radio da aba não deve aparecer quando desabilitado");
    });

    it("NÃO contém tablabel-cupons", () => {
      assert.ok(!html.includes("tablabel-cupons"), "label da aba não deve aparecer quando desabilitado");
    });

    it("NÃO contém nenhum email @example.com (prova de PII-off)", () => {
      // Nenhum email de fixture pode vazar quando couponUsage é null
      assert.ok(!html.includes("test1@example.com"), "test1@example.com não deve aparecer");
      assert.ok(!html.includes("test2@example.com"), "test2@example.com não deve aparecer");
      assert.ok(!html.includes("test3@example.com"), "test3@example.com não deve aparecer");
      assert.ok(!html.includes("@example.com"), "nenhum @example.com deve aparecer");
    });
  });

  describe("(c) as 4 abas existentes estão presentes em ambos os casos", () => {
    const withCoupons = renderDashboardHtml(emptyCampaigns, [], null, null, null, syntheticUsage);
    const withoutCoupons = renderDashboardHtml(emptyCampaigns, [], null, null, null, null);

    for (const [label, html] of [
      ["com couponUsage", withCoupons],
      ["sem couponUsage (null)", withoutCoupons],
    ] as [string, string][]) {
      it(`panel-visaogeral presente [${label}]`, () => {
        assert.ok(html.includes("panel-visaogeral"), `panel-visaogeral deve estar presente [${label}]`);
      });
      it(`panel-engajamento presente [${label}]`, () => {
        assert.ok(html.includes("panel-engajamento"), `panel-engajamento deve estar presente [${label}]`);
      });
      it(`panel-links presente [${label}]`, () => {
        assert.ok(html.includes("panel-links"), `panel-links deve estar presente [${label}]`);
      });
      it(`panel-contatos presente [${label}]`, () => {
        assert.ok(html.includes("panel-contatos"), `panel-contatos deve estar presente [${label}]`);
      });
    }
  });
});
