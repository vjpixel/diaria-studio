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
import { withFetchSpy } from "./_helpers/with-fetch-spy.ts";

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
    const result = await getCouponUsage(makeEnv({}), "cached");
    assert.equal(result, null, "deve retornar null → rota retornaria 404");
  });

  it("retorna null quando COUPONS_TAB_ENABLED='false'", async () => {
    const result = await getCouponUsage(makeEnv({ tabEnabled: "false" }), "cached");
    assert.equal(result, null, "deve retornar null → rota retornaria 404");
  });

  it("retorna null quando KV e STRIPE_API_KEY estão ausentes (flag ON)", async () => {
    // Cobre o path: STATS_CACHE undefined → sem KV → sem Stripe key → null
    const result = await getCouponUsage(makeEnv({ tabEnabled: "true" }), "cached");
    assert.equal(result, null, "KV vazio + sem Stripe key → deve retornar null → rota retornaria 404");
  });

  // Regressão #2726: o comportamento KV-first (cobre o path principal do PR)
  it("retorna dados do KV mesmo sem STRIPE_API_KEY quando KV tem dados (mode=cached)", async () => {
    const mockKv = { get: async () => syntheticUsage, put: async () => {} };
    const result = await getCouponUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: undefined, STATS_CACHE: mockKv as any },
      "cached",
    );
    assert.notEqual(result, null, "KV hit deve retornar dados mesmo sem STRIPE_API_KEY");
    assert.deepEqual(result, syntheticUsage);
  });

  it("retorna dados do KV quando mode=fresh mas STRIPE_API_KEY ausente (KV-only deployment)", async () => {
    // Em KV-only, mode=fresh não tem fonte mais fresca que o KV — deve servir KV.
    const mockKv = { get: async () => syntheticUsage, put: async () => {} };
    const result = await getCouponUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: undefined, STATS_CACHE: mockKv as any },
      "fresh",
    );
    assert.notEqual(result, null, "KV-only + mode=fresh: sem Stripe disponível → retorna KV como melhor disponível");
    assert.deepEqual(result, syntheticUsage);
  });

  it("retorna null quando mode=fresh, KV vazio e STRIPE_API_KEY ausente", async () => {
    const mockKv = { get: async () => null, put: async () => {} };
    const result = await getCouponUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: undefined, STATS_CACHE: mockKv as any },
      "fresh",
    );
    assert.equal(result, null, "mode=fresh + KV vazio + sem Stripe → null");
  });
});

// ---------------------------------------------------------------------------
// Regressão #2779: kvOnly — o caminho de erro (fallback de rate-limit) NUNCA
// pode fazer chamada Stripe ao vivo, nem em KV miss. Antes do fix, um miss em
// `coupons:usage` com STRIPE_API_KEY configurada caía no fetchCouponUsage
// mesmo com isFresh=false — contradizendo o contrato do buildRateLimitFallback.
// ---------------------------------------------------------------------------

describe("getCouponUsage — mode=kv-only (#2779: KV é a única fonte no caminho de erro)", () => {
  it("mode=kv-only + KV miss + STRIPE_API_KEY presente → null, SEM fetch (o bug do #2779)", async () => {
    await withFetchSpy(async (calls) => {
      const mockKv = { get: async () => null, put: async () => {} };
      const result = await getCouponUsage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: "sk_test_synthetic", STATS_CACHE: mockKv as any },
        "kv-only",
      );
      assert.equal(result, null, "KV miss em kv-only → null (tab oculta), nunca Stripe");
      assert.deepEqual(calls, [], "NENHUMA chamada externa pode acontecer com mode=kv-only");
    });
  });

  it("mode=kv-only + KV hit → serve o cache sem fetch", async () => {
    await withFetchSpy(async (calls) => {
      const mockKv = { get: async () => syntheticUsage, put: async () => {} };
      const result = await getCouponUsage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: "sk_test_synthetic", STATS_CACHE: mockKv as any },
        "kv-only",
      );
      assert.deepEqual(result, syntheticUsage, "KV hit em kv-only → serve o cache");
      assert.deepEqual(calls, [], "sem chamada externa");
    });
  });

  it("mode=kv-only sem STATS_CACHE → null, SEM fetch", async () => {
    await withFetchSpy(async (calls) => {
      const result = await getCouponUsage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: "sk_test_synthetic", STATS_CACHE: undefined as any },
        "kv-only",
      );
      assert.equal(result, null);
      assert.deepEqual(calls, [], "sem KV binding + kv-only → null direto, nunca Stripe");
    });
  });

  it("contraste: mode=cached (default) + KV miss + STRIPE_API_KEY → o fallback Stripe do caminho saudável segue vivo", async () => {
    // Garante que o fix do #2779 NÃO desligou o fallback Stripe do render
    // normal (KV com TTL 300s expira e é repopulado por esse caminho).
    await withFetchSpy(async (calls) => {
      const mockKv = { get: async () => null, put: async () => {} };
      const result = await getCouponUsage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: "sk_test_synthetic", STATS_CACHE: mockKv as any },
        "cached",
      );
      // o fetch espião lança → getCouponUsage degrada pra null; o que importa
      // é que a tentativa Stripe ACONTECEU no caminho saudável.
      assert.equal(result, null);
      assert.ok(calls.length > 0, "caminho saudável deve tentar a Stripe API em KV miss");
      assert.match(calls[0], /api\.stripe\.com/);
    });
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
      assert.ok(h.includes('<th scope="col">Pagamentos</th>'), "novo cabeçalho presente");
      assert.ok(!h.includes("<th>Criada</th>") && !h.includes('<th scope="col">Criada</th>'), "cabeçalho antigo (#2743) removido");
      assert.ok(!h.includes("<th>1º pagamento</th>") && !h.includes('<th scope="col">1º pagamento</th>'), "cabeçalho intermediário (#2749) removido");
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

    // #3053: cancelada ANTES do 1º pagamento (trial cancelado) — a previsão
    // nunca vai se realizar, mostrar um indicador neutro em vez da data com "*".
    describe("cancelada sem pagamento real (#3053)", () => {
      it("status='canceled' + payments=[] → mostra '—', NÃO a data prevista com '*'", () => {
        const h = renderCouponTabPanel(mkUsage({
          status: "canceled",
          first_payment_epoch: 1783442446,
          first_payment_is_forecast: true,
          payments: [],
        }));
        assert.ok(h.includes("—"), "mostra o indicador neutro");
        assert.ok(!/\d{2}\/\d{2}\/\d{4}\*/.test(h), "NÃO mostra data prevista com asterisco");
        assert.ok(!h.includes("previsão do 1º pagamento"), "sem legenda de previsão (nenhuma linha usa '*')");
      });

      it("status='canceled' + payments=undefined (KV legado) → mesmo comportamento neutro", () => {
        const h = renderCouponTabPanel(mkUsage({
          status: "canceled",
          first_payment_epoch: 1783442446,
          first_payment_is_forecast: true,
          payments: undefined,
        }));
        assert.ok(h.includes("—"), "mostra o indicador neutro mesmo sem `payments` explícito");
        assert.ok(!/\d{2}\/\d{2}\/\d{4}\*/.test(h), "NÃO mostra data prevista com asterisco");
      });

      it("contraste: status='trialing' nas mesmas condições CONTINUA mostrando a previsão normalmente", () => {
        const h = renderCouponTabPanel(mkUsage({
          status: "trialing",
          first_payment_epoch: 1783442446,
          first_payment_is_forecast: true,
          payments: [],
        }));
        assert.match(h, /\d{2}\/\d{2}\/\d{4}\*/, "trial ainda ativo deve mostrar a data prevista com asterisco");
        assert.ok(h.includes("previsão do 1º pagamento"), "legenda deve aparecer para o caso trial");
      });

      it("status='canceled' MAS payments TEM itens (cancelou depois de já ter pago) → mantém a lista real, sem '—'", () => {
        const h = renderCouponTabPanel(mkUsage({
          status: "canceled",
          first_payment_epoch: 1783442446,
          first_payment_is_forecast: true,
          payments: [{ id: "ch_paid_before_cancel", epoch: 1782383062, amount_cents: 44900 }],
        }));
        assert.ok(h.includes("1 pagamento"), "lista real de pagamentos continua aparecendo");
        assert.ok(!/\d{2}\/\d{2}\/\d{4}\*/.test(h), "sem previsão (já tem pagamento real)");
      });

      it("status='canceled' + payments=[] MAS SEM first_payment_is_forecast (KV pré-#2749, sem sinal de previsão) → escopo cirúrgico: mantém o fallback antigo pra `created`, sem '*' e sem '—'", () => {
        // Não há asterisco enganoso pra corrigir aqui — o dado legado já não
        // promete nada (sem marcador de previsão). O fix é escopado só pro
        // caso que de fato mostra "previsão*" pra uma assinatura cancelada.
        const h = renderCouponTabPanel(mkUsage({
          status: "canceled",
          payments: [],
          // first_payment_epoch/first_payment_is_forecast ausentes (undefined)
        }));
        assert.ok(!/\d{2}\/\d{2}\/\d{4}\*/.test(h), "sem asterisco (nenhuma previsão foi feita)");
        assert.ok(!h.includes("previsão do 1º pagamento"), "sem legenda de previsão");
        assert.ok(!h.includes(">—<"), "não usa o indicador neutro aqui — não há nada enganoso a esconder");
      });
    });
  });

  describe("generatedAt — última atualização (#2766)", () => {
    const mkUsage = (generatedAt?: string): CouponUsageReport => ({
      NEWS50: {
        couponIds: ["cpnSYNTH50"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
        totalPaidCents: 0, totalCommissionCents: 0, generatedAt,
        redemptions: [{
          coupon_code: "NEWS50", coupon_id: "cpnSYNTH50", percent_off: 50, duration: "once",
          customer: "cus_G", customer_email: "g@example.com", subscription: "sub_G", status: "active",
          created: 1782383062, plan_amount_cents: 44900, currency: "brl", interval: "year",
          discount_value_cents: 0, paid_cents: 0, commission_cents: 0,
        }],
      },
    });

    it("com generatedAt: mostra 'Atualizado ... BRT'", () => {
      const h = renderCouponTabPanel(mkUsage("2026-07-01T09:00:00.000Z"));
      assert.ok(h.includes("Atualizado"), "texto de atualização presente");
      assert.ok(h.includes("BRT"), "formatado em BRT");
      assert.ok(!h.includes("indisponível"), "não deve mostrar o fallback quando o dado existe");
    });

    it("sem generatedAt (KV pré-#2766): fallback gracioso, sem crash", () => {
      const h = renderCouponTabPanel(mkUsage(undefined));
      assert.ok(h.includes("indisponível"), "mensagem de fallback presente");
      // #3092: nota não deve mais expor número de issue interna (#2750) pro
      // editor — o texto aponta pro refresh sem o jargão de tracking.
      assert.ok(h.includes("próximo refresh"), "aponta pro refresh que vai popular o campo");
      assert.ok(!/#2750/.test(h), "não deve mais vazar número de issue interna pro leitor");
    });
  });

  describe("Pagamentos — lista completa + total por mês (#2758)", () => {
    // `id` opcional — auto-gerado por índice quando o teste não precisa controlar
    // charge ids explicitamente (só o teste de dedup abaixo precisa).
    const mkUsageWithPayments = (
      paymentsIn: { epoch: number; amount_cents: number; id?: string }[],
    ): CouponUsageReport => {
      const payments = paymentsIn.map((p, i) => ({ id: p.id ?? `ch_auto_${i}`, epoch: p.epoch, amount_cents: p.amount_cents }));
      return {
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
      };
    };

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
        const epochA = 1782383062; // 25/06/2026 07:24 BRT
        const epochB = epochA + 86400; // 26/06/2026 07:24 BRT — mesmo mês, longe do limite (dia 25→26)
        const h = renderCouponTabPanel(mkUsageWithPayments([
          { epoch: epochA, amount_cents: 9990 },
          { epoch: epochB, amount_cents: 9990 },
        ]));
        assert.ok(h.includes("R$199,80"), "pago total do mês (2×R$99,90)");
        assert.ok(h.includes(fmtBRLTest(Math.round(19980 * 0.4))), "comissão total do mês (40% de R$199,80)");
      });

      it("3+ meses distintos ordenam desc corretamente (não só o caso trivial de 2)", () => {
        const jan = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
        const abr = Math.floor(Date.UTC(2026, 3, 15, 12, 0, 0) / 1000);
        const jul = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000);
        const h = renderCouponTabPanel(mkUsageWithPayments([
          { epoch: jan, amount_cents: 9990 },
          { epoch: jul, amount_cents: 9990 },
          { epoch: abr, amount_cents: 9990 },
        ]));
        const idx = (label: string) => h.indexOf(label);
        assert.ok(idx("07/2026") < idx("04/2026"), "07 antes de 04");
        assert.ok(idx("04/2026") < idx("01/2026"), "04 antes de 01");
      });

      it("payment na virada BRT: epoch 01:30 UTC (22:30 BRT do dia anterior) cai no mês anterior", () => {
        // 2026-07-01T01:30Z = 2026-06-30 22:30 BRT — deve agrupar em 06/2026, não 07/2026
        // (bug distinto do fmtDate/#2749 — brtMonthKey é função própria pro #2758).
        const epoch = Math.floor(Date.UTC(2026, 6, 1, 1, 30, 0) / 1000);
        const h = renderCouponTabPanel(mkUsageWithPayments([{ epoch, amount_cents: 9990 }]));
        assert.ok(h.includes("06/2026"), "agrupado no mês BRT (06/2026)");
        assert.ok(!h.includes("07/2026"), "NÃO agrupado no mês UTC (07/2026)");
      });

      it("dedup por charge id: 2 redemptions do MESMO cliente com o MESMO charge (janelas sobrepostas) não conta 2×", () => {
        // Simula 2 assinaturas com cupom pro mesmo cliente cujas janelas se
        // sobrepõem — o mesmo charge Stripe aparece na lista `payments` de
        // AMBAS as redemptions (#2743: atribuição é por-cliente, não por-sub).
        // Sem o dedup por id, "Total por mês" contaria o pagamento 2×.
        const sharedEpoch = 1782383062;
        const usage: CouponUsageReport = {
          NEWS50: {
            couponIds: ["cpnA"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
            totalPaidCents: 9990, totalCommissionCents: 3996,
            redemptions: [{
              coupon_code: "NEWS50", coupon_id: "cpnA", percent_off: 50, duration: "once",
              customer: "cus_DUP", customer_email: "dup@example.com", subscription: "sub_A", status: "active",
              created: sharedEpoch, plan_amount_cents: 9990, currency: "brl", interval: "month",
              discount_value_cents: 0, paid_cents: 9990, commission_cents: 3996,
              payments: [{ id: "ch_SHARED", epoch: sharedEpoch, amount_cents: 9990 }],
            }],
          },
          NEWS25: {
            couponIds: ["cpnB"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
            totalPaidCents: 9990, totalCommissionCents: 3996,
            redemptions: [{
              coupon_code: "NEWS25", coupon_id: "cpnB", percent_off: 25, duration: "repeating",
              customer: "cus_DUP", customer_email: "dup@example.com", subscription: "sub_B", status: "active",
              created: sharedEpoch, plan_amount_cents: 9990, currency: "brl", interval: "month",
              discount_value_cents: 0, paid_cents: 9990, commission_cents: 3996,
              // MESMO charge id (ch_SHARED) que a redemption acima — mesmo cliente,
              // janelas sobrepostas, mesmo charge Stripe subjacente.
              payments: [{ id: "ch_SHARED", epoch: sharedEpoch, amount_cents: 9990 }],
            }],
          },
        };
        const h = renderCouponTabPanel(usage);
        assert.ok(h.includes("R$99,90"), "valor do pagamento único presente");
        assert.ok(!h.includes("R$199,80"), "NÃO soma 2× (deduplicado por charge id)");
      });

      it("2 clientes diferentes com pagamento no MESMO mês: agrega os dois no mesmo bucket (não substitui)", () => {
        const epochA = 1782383062;
        const epochB = epochA + 100;
        const usage: CouponUsageReport = {
          NEWS50: {
            couponIds: ["cpnA"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
            totalPaidCents: 44900, totalCommissionCents: 17960,
            redemptions: [{
              coupon_code: "NEWS50", coupon_id: "cpnA", percent_off: 50, duration: "once",
              customer: "cus_X", customer_email: "x@example.com", subscription: "sub_X", status: "active",
              created: epochA, plan_amount_cents: 44900, currency: "brl", interval: "year",
              discount_value_cents: 0, paid_cents: 44900, commission_cents: 17960,
              payments: [{ id: "ch_X", epoch: epochA, amount_cents: 44900 }],
            }],
          },
          NEWS25: {
            couponIds: ["cpnB"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
            totalPaidCents: 9990, totalCommissionCents: 3996,
            redemptions: [{
              coupon_code: "NEWS25", coupon_id: "cpnB", percent_off: 25, duration: "repeating",
              customer: "cus_Y", customer_email: "y@example.com", subscription: "sub_Y", status: "active",
              created: epochB, plan_amount_cents: 9990, currency: "brl", interval: "month",
              discount_value_cents: 0, paid_cents: 9990, commission_cents: 3996,
              payments: [{ id: "ch_Y", epoch: epochB, amount_cents: 9990 }],
            }],
          },
        };
        const h = renderCouponTabPanel(usage);
        assert.ok(h.includes("x@example.com") && h.includes("y@example.com"), "os 2 clientes aparecem no drill-down");
        assert.ok(h.includes("R$548,90"), "total do mês soma os 2 clientes (R$449,00 + R$99,90)");
      });

      it("nota de dado legado: paid_cents real sem `payments` mostra aviso (não parece R$0 de receita)", () => {
        const legacy: CouponUsageReport = {
          NEWS50: {
            couponIds: ["cpnL"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
            totalPaidCents: 44900, totalCommissionCents: 17960,
            redemptions: [{
              coupon_code: "NEWS50", coupon_id: "cpnL", percent_off: 50, duration: "once",
              customer: "cus_L", customer_email: "legacy@example.com", subscription: "sub_L", status: "active",
              created: 1782383062, plan_amount_cents: 44900, currency: "brl", interval: "year",
              discount_value_cents: 0, paid_cents: 44900, commission_cents: 17960,
              // SEM `payments` — formato pré-#2758, dinheiro real mas sem quebra mensal.
            }],
          },
        };
        const h = renderCouponTabPanel(legacy);
        assert.ok(h.includes("Nenhum pagamento registrado"), "seção mensal vazia (sem dados pra agregar)");
        assert.ok(h.includes("R$449,00"), "aviso menciona o valor real (não fica em silêncio parecendo R$0)");
        assert.ok(h.includes("formato antigo"), "aviso explica que é dado legado, não falta de receita");
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

  describe("(c) as 5 abas existentes estão presentes em ambos os casos (#3406: + Envios)", () => {
    const withCoupons = renderDashboardHtml(emptyCampaigns, [], null, null, null, syntheticUsage);
    const withoutCoupons = renderDashboardHtml(emptyCampaigns, [], null, null, null, null);

    for (const [label, html] of [
      ["com couponUsage", withCoupons],
      ["sem couponUsage (null)", withoutCoupons],
    ] as [string, string][]) {
      it(`panel-visaogeral presente [${label}]`, () => {
        assert.ok(html.includes("panel-visaogeral"), `panel-visaogeral deve estar presente [${label}]`);
      });
      it(`panel-envios presente [${label}] (#3406)`, () => {
        assert.ok(html.includes("panel-envios"), `panel-envios deve estar presente [${label}]`);
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
