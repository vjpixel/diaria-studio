/**
 * test/stripe-coupon-usage.test.ts (#2717)
 *
 * Regressão para aggregateCouponUsage — usa fixtures sintéticas (sem rede, sem env).
 * Cobre: percent_off "once" (anual), percent_off "repeating" (mensal), multi-promo (ativo + inativo),
 * fallback legacy (discount.coupon string) e filtragem de assinaturas sem cupom alvo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  aggregateCouponUsage,
  fetchCouponUsage,
  csvField,
  toCSV,
  isMainModule,
  commissionWindowEnd,
  computePaidCents,
  commissionCents,
  firstPaymentInfo,
  redemptionWho,
  couponIdFrom,
  StripeApiError,
  COMMISSION_RATE,
  type PromoCodeRaw,
  type CouponRaw,
  type SubscriptionRaw,
  type CustomerRaw,
  type ChargeRaw,
  type RedemptionRow,
} from "../scripts/stripe-coupon-usage.ts";

// ---------------------------------------------------------------------------
// Fixtures sintéticas — IDs gerados: nenhum id real commitado
// ---------------------------------------------------------------------------

const promos: PromoCodeRaw[] = [
  // NEWS50 ativo
  {
    id: "promo_TEST50_active",
    object: "promotion_code",
    active: true,
    code: "NEWS50",
    created: 1779210106,
    promotion: { coupon: "cpnTEST50", type: "coupon" },
    max_redemptions: null,
    times_redeemed: 2,
    restrictions: { first_time_transaction: false, minimum_amount: null },
  },
  // NEWS50 inativo — mesmo code, mesmo coupon; testa multi-promo sem duplicar linhas
  {
    id: "promo_TEST50_inactive",
    object: "promotion_code",
    active: false,
    code: "NEWS50",
    created: 1700000000,
    promotion: { coupon: "cpnTEST50", type: "coupon" },
    max_redemptions: null,
    times_redeemed: 0,
    restrictions: { first_time_transaction: false, minimum_amount: null },
  },
  // NEWS25
  {
    id: "promo_TEST25",
    object: "promotion_code",
    active: true,
    code: "NEWS25",
    created: 1779210200,
    promotion: { coupon: "cpnTEST25", type: "coupon" },
    max_redemptions: null,
    times_redeemed: 1,
    restrictions: { first_time_transaction: false, minimum_amount: null },
  },
];

const coupons: CouponRaw[] = [
  {
    id: "cpnTEST50",
    object: "coupon",
    amount_off: null,
    percent_off: 50,
    currency: null,
    duration: "once",
    duration_in_months: null,
    name: "NEWS50 Diar.ia TEST",
    times_redeemed: 2,
    valid: true,
    max_redemptions: null,
  },
  {
    id: "cpnTEST25",
    object: "coupon",
    amount_off: null,
    percent_off: 25,
    currency: null,
    duration: "repeating",
    duration_in_months: 3,
    name: "NEWS25 Diar.ia TEST",
    times_redeemed: 1,
    valid: true,
    max_redemptions: null,
  },
];

const subscriptions: SubscriptionRaw[] = [
  // Matches NEWS50 via new API (source.coupon) — annual plan R$449,00
  {
    id: "sub_TEST1",
    object: "subscription",
    customer: "cus_TEST1",
    status: "active",
    created: 1782383062,
    start_date: 1782383062,
    items: {
      data: [
        {
          price: {
            unit_amount: 44900,
            currency: "brl",
            recurring: { interval: "year" },
          },
        },
      ],
    },
    discounts: [
      {
        id: "di_TEST1",
        object: "discount",
        customer: "cus_TEST1",
        promotion_code: "promo_TEST50_active",
        source: { coupon: "cpnTEST50", type: "coupon" },
        start: 1782673121,
        end: null,
        subscription: "sub_TEST1",
      },
    ],
  },
  // Matches NEWS50 via legacy fallback (discount.coupon string) — annual plan R$449,00
  {
    id: "sub_TEST2",
    object: "subscription",
    customer: "cus_TEST2",
    status: "trialing",
    created: 1782400000,
    start_date: 1782400000,
    items: {
      data: [
        {
          price: {
            unit_amount: 44900,
            currency: "brl",
            recurring: { interval: "year" },
          },
        },
      ],
    },
    discounts: [
      {
        id: "di_TEST2",
        object: "discount",
        customer: "cus_TEST2",
        promotion_code: "promo_TEST50_inactive",
        // No source field — legacy fallback
        coupon: "cpnTEST50",
        start: 1782500000,
        end: null,
        subscription: "sub_TEST2",
      },
    ],
  },
  // Matches NEWS25 — monthly plan R$99,90, repeating 3 months
  {
    id: "sub_TEST3",
    object: "subscription",
    customer: "cus_TEST3",
    status: "active",
    created: 1782450000,
    start_date: 1782450000,
    items: {
      data: [
        {
          price: {
            unit_amount: 9990,
            currency: "brl",
            recurring: { interval: "month" },
          },
        },
      ],
    },
    discounts: [
      {
        id: "di_TEST3",
        object: "discount",
        customer: "cus_TEST3",
        promotion_code: "promo_TEST25",
        source: { coupon: "cpnTEST25", type: "coupon" },
        start: 1782500000,
        end: null,
        subscription: "sub_TEST3",
      },
    ],
  },
  // Should NOT match — different coupon id entirely
  {
    id: "sub_TEST4",
    object: "subscription",
    customer: "cus_TEST4",
    status: "active",
    created: 1782460000,
    start_date: 1782460000,
    items: {
      data: [
        {
          price: {
            unit_amount: 29900,
            currency: "brl",
            recurring: { interval: "month" },
          },
        },
      ],
    },
    discounts: [
      {
        id: "di_TEST4",
        object: "discount",
        customer: "cus_TEST4",
        promotion_code: "promo_OTHER",
        source: { coupon: "cpnOTHER", type: "coupon" },
        start: 1782500000,
        end: null,
        subscription: "sub_TEST4",
      },
    ],
  },
];

const customers: CustomerRaw[] = [
  { id: "cus_TEST1", email: "test1@example.com" },
  { id: "cus_TEST2", email: "test2@example.com" },
  { id: "cus_TEST3", email: "test3@example.com" },
  { id: "cus_TEST4", email: "test4@example.com" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aggregateCouponUsage", () => {
  const report = aggregateCouponUsage({ codes: promos, coupons, subscriptions, customers });

  describe("NEWS50 (50% once, annual)", () => {
    const entry = report["NEWS50"];

    it("entry existe", () => {
      assert.ok(entry, "report deve ter entrada para NEWS50");
    });

    it("timesRedeemed vem de coupon.times_redeemed (somando ambas promo_codes que apontam pro mesmo coupon)", () => {
      // cpnTEST50 tem times_redeemed=2; as duas promos apontam pro mesmo coupon → dedupe
      assert.equal(entry.timesRedeemed, 2);
    });

    it("rowCount = 2 (sub_TEST1 via source.coupon + sub_TEST2 via legacy discount.coupon)", () => {
      assert.equal(entry.rowCount, 2);
    });

    it("discount_value_cents = 22450 para sub_TEST1 (44900 * 50% = 22450)", () => {
      const row = entry.redemptions.find((r) => r.subscription === "sub_TEST1");
      assert.ok(row, "redemption de sub_TEST1 deve existir");
      assert.equal(row!.discount_value_cents, 22450);
    });

    it("discount_value_cents = 22450 para sub_TEST2 (legacy fallback)", () => {
      const row = entry.redemptions.find((r) => r.subscription === "sub_TEST2");
      assert.ok(row, "redemption de sub_TEST2 deve existir");
      assert.equal(row!.discount_value_cents, 22450);
    });

    it("customer_email mapeado corretamente para sub_TEST1", () => {
      const row = entry.redemptions.find((r) => r.subscription === "sub_TEST1");
      assert.equal(row!.customer_email, "test1@example.com");
    });

    it("sub_TEST2 tem status trialing", () => {
      const row = entry.redemptions.find((r) => r.subscription === "sub_TEST2");
      assert.equal(row!.status, "trialing");
    });

    it("totalProjectedDiscountCents = 44900 (22450 × 2)", () => {
      assert.equal(entry.totalProjectedDiscountCents, 44900);
    });
  });

  describe("NEWS25 (25% repeating 3 meses, mensal)", () => {
    const entry = report["NEWS25"];

    it("entry existe", () => {
      assert.ok(entry, "report deve ter entrada para NEWS25");
    });

    it("rowCount = 1", () => {
      assert.equal(entry.rowCount, 1);
    });

    it("discount_value_cents = 7493 (Math.round(9990 * 25 * 3 / 100) = Math.round(7492.5))", () => {
      const row = entry.redemptions[0];
      assert.ok(row, "redemption de sub_TEST3 deve existir");
      // 9990 * 25 * 3 / 100 = 7492.5 → Math.round = 7493
      assert.equal(row.discount_value_cents, 7493);
    });

    it("customer_email mapeado corretamente", () => {
      assert.equal(entry.redemptions[0]!.customer_email, "test3@example.com");
    });
  });

  describe("filtragem", () => {
    it("sub_TEST4 (cupom diferente) está ausente do report inteiro", () => {
      for (const entry of Object.values(report)) {
        const found = entry.redemptions.some((r) => r.subscription === "sub_TEST4");
        assert.ok(!found, `sub_TEST4 não deve aparecer em nenhuma entrada do report`);
      }
    });
  });

  describe("multi-promo (duplicata inativa)", () => {
    it("promo_TEST50_inactive e promo_TEST50_active apontam pro mesmo coupon — timesRedeemed não é duplicado", () => {
      // Ambas promos referenciam cpnTEST50 que tem times_redeemed=2; sem duplicar = 2
      assert.equal(report["NEWS50"].timesRedeemed, 2);
    });

    it("sub_TEST2 (usou inactive promo via legacy fallback) aparece exatamente 1 vez", () => {
      const count = report["NEWS50"].redemptions.filter(
        (r) => r.subscription === "sub_TEST2",
      ).length;
      assert.equal(count, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// #2743 — comissão de 40% sobre o realizado (pago) na janela de 12 meses
// ---------------------------------------------------------------------------

describe("comissão (#2743)", () => {
  const created = 1782383062; // resgate

  const mkCharge = (over: Partial<ChargeRaw>): ChargeRaw => ({
    id: "ch_x",
    object: "charge",
    customer: "cus_TEST1",
    amount: 44900,
    amount_refunded: 0,
    created: created + 1000,
    status: "succeeded",
    paid: true,
    ...over,
  });

  describe("commissionWindowEnd", () => {
    it("adiciona 12 meses de calendário (não 12×30 dias)", () => {
      const end = commissionWindowEnd(created);
      const start = new Date(created * 1000);
      const expected = new Date(start.getTime());
      expected.setUTCMonth(expected.getUTCMonth() + 12);
      assert.equal(end, Math.floor(expected.getTime() / 1000));
      assert.ok(end > created, "fim > início");
    });
  });

  describe("computePaidCents", () => {
    it("soma charges succeeded+paid do cliente dentro da janela", () => {
      const charges = [
        mkCharge({ amount: 44900, created: created + 1 }),
        mkCharge({ amount: 44900, created: created + 100 }),
      ];
      assert.equal(computePaidCents(charges, "cus_TEST1", created), 89800);
    });

    it("net de refunds (amount_captured - amount_refunded)", () => {
      const charges = [mkCharge({ amount: 44900, amount_captured: 44900, amount_refunded: 10000 })];
      assert.equal(computePaidCents(charges, "cus_TEST1", created), 34900);
    });

    it("ignora charge fora da janela de 12 meses", () => {
      const after12m = commissionWindowEnd(created) + 1;
      const charges = [mkCharge({ created: after12m })];
      assert.equal(computePaidCents(charges, "cus_TEST1", created), 0);
    });

    it("ignora charge anterior ao resgate", () => {
      const charges = [mkCharge({ created: created - 1 })];
      assert.equal(computePaidCents(charges, "cus_TEST1", created), 0);
    });

    it("ignora charge de outro cliente", () => {
      const charges = [mkCharge({ customer: "cus_OTHER" })];
      assert.equal(computePaidCents(charges, "cus_TEST1", created), 0);
    });

    it("ignora charge não-succeeded ou não-paid", () => {
      const charges = [
        mkCharge({ status: "failed", paid: false }),
        mkCharge({ status: "pending", paid: false }),
      ];
      assert.equal(computePaidCents(charges, "cus_TEST1", created), 0);
    });

    it("refund maior que o captured não vira negativo", () => {
      const charges = [mkCharge({ amount: 1000, amount_refunded: 5000 })];
      assert.equal(computePaidCents(charges, "cus_TEST1", created), 0);
    });
  });

  describe("commissionCents", () => {
    it("40% do pago, arredondado", () => {
      assert.equal(commissionCents(89800), 35920);
      assert.equal(commissionCents(9990), Math.round(9990 * 0.4)); // 3996
      assert.equal(COMMISSION_RATE, 0.4);
    });
  });

  describe("aggregateCouponUsage com charges", () => {
    // Charges ancorados em discount.start (#2743): a janela começa no resgate do
    // cupom (discount.start), não na criação da assinatura. As fixtures usam
    // start+delta pra cair dentro da janela sob a âncora correta.
    const charges: ChargeRaw[] = [
      // cus_TEST1 (sub_TEST1, NEWS50): 2 pagamentos anuais na janela
      { id: "ch_1a", object: "charge", customer: "cus_TEST1", amount: 44900, amount_refunded: 0, created: subscriptions[0].discounts[0].start + 10, status: "succeeded", paid: true },
      { id: "ch_1b", object: "charge", customer: "cus_TEST1", amount: 44900, amount_refunded: 4900, created: subscriptions[0].discounts[0].start + 20, status: "succeeded", paid: true },
      // cus_TEST3 (sub_TEST3, NEWS25): 1 pagamento mensal
      { id: "ch_3a", object: "charge", customer: "cus_TEST3", amount: 9990, amount_refunded: 0, created: subscriptions[2].discounts[0].start + 10, status: "succeeded", paid: true },
    ];
    const report = aggregateCouponUsage({ codes: promos, coupons, subscriptions, customers, charges });

    it("paid_cents por redemption reflete os charges do cliente (net)", () => {
      const r1 = report["NEWS50"].redemptions.find((r) => r.subscription === "sub_TEST1");
      assert.equal(r1!.paid_cents, 44900 + (44900 - 4900)); // 84900
      assert.equal(r1!.commission_cents, Math.round(84900 * 0.4)); // 33960
    });

    it("sub_TEST2 (sem charges) → paid 0, comissão 0", () => {
      const r2 = report["NEWS50"].redemptions.find((r) => r.subscription === "sub_TEST2");
      assert.equal(r2!.paid_cents, 0);
      assert.equal(r2!.commission_cents, 0);
    });

    it("totais do cupom somam as redemptions", () => {
      assert.equal(report["NEWS50"].totalPaidCents, 84900);
      assert.equal(report["NEWS50"].totalCommissionCents, Math.round(84900 * 0.4));
      assert.equal(report["NEWS25"].totalPaidCents, 9990);
      assert.equal(report["NEWS25"].totalCommissionCents, Math.round(9990 * 0.4));
    });

    it("sem charges (input omitido) → paid/comissão 0, não quebra", () => {
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions, customers });
      assert.equal(r["NEWS50"].totalPaidCents, 0);
      assert.equal(r["NEWS50"].redemptions[0].paid_cents, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Regressões dos fixes de code-review (#2743)
  // -------------------------------------------------------------------------

  describe("commissionWindowEnd — overflow de mês (#2743 leap-year)", () => {
    it("29/fev + 12m recua pro último dia de fev do ano seguinte (não transborda pra mar)", () => {
      // 29/fev/2024 00:00 UTC. +12 meses = fev/2025 (não-bissexto): dia 29 não
      // existe → deve virar 28/fev/2025, NÃO 01/mar/2025.
      const feb29 = Math.floor(Date.UTC(2024, 1, 29, 0, 0, 0) / 1000);
      const end = commissionWindowEnd(feb29);
      const endDate = new Date(end * 1000);
      assert.equal(endDate.getUTCFullYear(), 2025);
      assert.equal(endDate.getUTCMonth(), 1, "mês = fevereiro (1), não março (2)");
      assert.equal(endDate.getUTCDate(), 28, "dia = 28 (clamp), não 1 de março");
    });

    it("data comum: 15/jun + 12m = 15/jun do ano seguinte", () => {
      const jun15 = Math.floor(Date.UTC(2025, 5, 15, 12, 0, 0) / 1000);
      const end = commissionWindowEnd(jun15);
      const endDate = new Date(end * 1000);
      assert.equal(endDate.getUTCFullYear(), 2026);
      assert.equal(endDate.getUTCMonth(), 5);
      assert.equal(endDate.getUTCDate(), 15);
    });
  });

  describe("computePaidCents — amount_captured explícito 0 (#2743)", () => {
    it("amount_captured: 0 num charge succeeded+paid cai pro amount (não zera)", () => {
      const charges = [mkCharge({ amount: 5000, amount_captured: 0, amount_refunded: 0 })];
      assert.equal(computePaidCents(charges, "cus_TEST1", created), 5000);
    });

    it("amount_captured parcial (< amount) é respeitado", () => {
      const charges = [mkCharge({ amount: 5000, amount_captured: 3000, amount_refunded: 0 })];
      assert.equal(computePaidCents(charges, "cus_TEST1", created), 3000);
    });
  });

  describe("aggregateCouponUsage — âncora em discount.start (#2743)", () => {
    it("charge entre sub.created e discount.start NÃO conta (pré-resgate)", () => {
      // sub_TEST1: created 1782383062, discount.start 1782673121.
      const preRedeem = subscriptions[0].created + 10; // antes do discount.start
      const charges: ChargeRaw[] = [
        { id: "ch_pre", object: "charge", customer: "cus_TEST1", amount: 44900, amount_refunded: 0, created: preRedeem, status: "succeeded", paid: true },
      ];
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions, customers, charges });
      const row = r["NEWS50"].redemptions.find((x) => x.subscription === "sub_TEST1");
      assert.equal(row!.paid_cents, 0, "pagamento pré-resgate não entra na janela");
    });

    it("charge em discount.start+delta conta", () => {
      const postRedeem = subscriptions[0].discounts[0].start + 10;
      const charges: ChargeRaw[] = [
        { id: "ch_post", object: "charge", customer: "cus_TEST1", amount: 44900, amount_refunded: 0, created: postRedeem, status: "succeeded", paid: true },
      ];
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions, customers, charges });
      const row = r["NEWS50"].redemptions.find((x) => x.subscription === "sub_TEST1");
      assert.equal(row!.paid_cents, 44900);
    });
  });

  describe("aggregateCouponUsage — dedup por cliente + arredondamento único (#2743)", () => {
    it("mesma pessoa com 2 assinaturas do mesmo cupom conta UMA vez no total", () => {
      // Duas subscriptions NEWS50 do MESMO cliente. computePaidCents soma todos
      // os charges da pessoa → cada linha traria o mesmo paid; o total dedup
      // conta a pessoa uma vez (não 2×).
      const start = subscriptions[0].discounts[0].start;
      const dupSubs: SubscriptionRaw[] = [
        subscriptions[0],
        {
          ...subscriptions[0],
          id: "sub_TEST1b",
          discounts: [{ ...subscriptions[0].discounts[0], id: "di_TEST1b", subscription: "sub_TEST1b" }],
        },
      ];
      const charges: ChargeRaw[] = [
        { id: "ch_d", object: "charge", customer: "cus_TEST1", amount: 44900, amount_refunded: 0, created: start + 10, status: "succeeded", paid: true },
      ];
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions: dupSubs, customers, charges });
      assert.equal(r["NEWS50"].redemptions.length, 2, "duas redemptions (display)");
      // ambas as linhas mostram o mesmo paid (44900), mas o total conta 1×.
      assert.equal(r["NEWS50"].totalPaidCents, 44900, "total dedup por cliente");
      assert.equal(r["NEWS50"].totalCommissionCents, Math.round(44900 * 0.4));
    });

    it("comissão total = round(pago_total * 0.4), não soma de linhas arredondadas", () => {
      // 3 clientes distintos, cada um com paid que arredonda a comissão .5 → a
      // soma de round(linha) diverge de round(total). Ex.: paid=1 cada.
      // round(1*.4)=0 por linha → soma 0; round(3*.4)=round(1.2)=1 no total.
      const start = subscriptions[0].discounts[0].start;
      const subs: SubscriptionRaw[] = ["A", "B", "C"].map((sfx) => ({
        ...subscriptions[0],
        id: `sub_R${sfx}`,
        customer: `cus_R${sfx}`,
        discounts: [{ ...subscriptions[0].discounts[0], id: `di_R${sfx}`, customer: `cus_R${sfx}`, subscription: `sub_R${sfx}` }],
      }));
      const custs: CustomerRaw[] = ["A", "B", "C"].map((sfx) => ({ id: `cus_R${sfx}`, email: `r${sfx}@example.com` }));
      const charges: ChargeRaw[] = ["A", "B", "C"].map((sfx) => ({
        id: `ch_R${sfx}`, object: "charge", customer: `cus_R${sfx}`, amount: 1, amount_refunded: 0, created: start + 10, status: "succeeded", paid: true,
      }));
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions: subs, customers: custs, charges });
      assert.equal(r["NEWS50"].totalPaidCents, 3);
      // soma de linhas arredondadas seria 0; round(3*0.4)=1 é o correto.
      assert.equal(r["NEWS50"].totalCommissionCents, 1);
    });
  });

  describe("firstPaymentInfo (#2749)", () => {
    const mkCh = (over: Partial<ChargeRaw>): ChargeRaw => ({
      id: "ch", object: "charge", customer: "cus_A", amount: 1000,
      amount_refunded: 0, created: 2000, status: "succeeded", paid: true, ...over,
    });

    it("com cobrança na janela → menor created, forecast=false", () => {
      const charges = [
        mkCh({ id: "ch_c", created: 2500 }),
        mkCh({ id: "ch_a", created: 2100 }),
        mkCh({ id: "ch_b", created: 2900 }),
      ];
      const r = firstPaymentInfo(charges, "cus_A", 2000, 3000, 9999);
      assert.equal(r.epoch, 2100);
      assert.equal(r.isForecast, false);
    });

    it("sem cobrança → forecastEpoch, forecast=true", () => {
      const r = firstPaymentInfo([], "cus_A", 2000, 3000, 9999);
      assert.equal(r.epoch, 9999);
      assert.equal(r.isForecast, true);
    });

    it("cobrança exatamente em windowStart conta (limite inferior inclusivo)", () => {
      const r = firstPaymentInfo([mkCh({ created: 2000 })], "cus_A", 2000, 3000, 9999);
      assert.equal(r.isForecast, false);
      assert.equal(r.epoch, 2000);
    });

    it("cobrança fora da janela (>= windowEnd) é ignorada → previsão", () => {
      const r = firstPaymentInfo([mkCh({ created: 3000 })], "cus_A", 2000, 3000, 9999);
      assert.equal(r.isForecast, true);
      assert.equal(r.epoch, 9999);
    });

    it("cobrança de outro cliente é ignorada → previsão", () => {
      const r = firstPaymentInfo([mkCh({ customer: "cus_B", created: 2100 })], "cus_A", 2000, 3000, 9999);
      assert.equal(r.isForecast, true);
    });

    it("cobrança não-succeeded é ignorada → previsão", () => {
      const r = firstPaymentInfo([mkCh({ status: "failed", paid: false, created: 2100 })], "cus_A", 2000, 3000, 9999);
      assert.equal(r.isForecast, true);
    });

    it("succeeded mas paid=false é ignorado → previsão", () => {
      const r = firstPaymentInfo([mkCh({ status: "succeeded", paid: false, created: 2100 })], "cus_A", 2000, 3000, 9999);
      assert.equal(r.isForecast, true);
    });

    it("charge 100% reembolsado (net 0) não conta como 1º pagamento → previsão", () => {
      // consistente com computePaidCents: sem dinheiro retido, não é pagamento.
      const r = firstPaymentInfo([mkCh({ created: 2100, amount: 1000, amount_refunded: 1000 })], "cus_A", 2000, 3000, 9999);
      assert.equal(r.isForecast, true);
      assert.equal(r.epoch, 9999);
    });
  });

  describe("aggregateCouponUsage — 1º pagamento (#2749)", () => {
    const start = subscriptions[0].discounts[0].start;

    it("trial (sem charge) → previsão = trial_end, forecast=true", () => {
      const trialEnd = start + 604800;
      const subs: SubscriptionRaw[] = [{
        ...subscriptions[0], id: "sub_TR", customer: "cus_TR", trial_end: trialEnd,
        discounts: [{ ...subscriptions[0].discounts[0], id: "di_TR", customer: "cus_TR", subscription: "sub_TR" }],
      }];
      const custs: CustomerRaw[] = [{ id: "cus_TR", email: "tr@example.com" }];
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions: subs, customers: custs, charges: [] });
      const row = r["NEWS50"].redemptions[0];
      assert.equal(row.first_payment_is_forecast, true);
      assert.equal(row.first_payment_epoch, trialEnd);
    });

    it("com charge → data real do 1º pagamento, forecast=false", () => {
      const subs: SubscriptionRaw[] = [{
        ...subscriptions[0], id: "sub_PD", customer: "cus_PD",
        discounts: [{ ...subscriptions[0].discounts[0], id: "di_PD", customer: "cus_PD", subscription: "sub_PD" }],
      }];
      const custs: CustomerRaw[] = [{ id: "cus_PD", email: "pd@example.com" }];
      const charges: ChargeRaw[] = [
        { id: "ch_PD2", object: "charge", customer: "cus_PD", amount: 44900, amount_refunded: 0, created: start + 200, status: "succeeded", paid: true },
        { id: "ch_PD1", object: "charge", customer: "cus_PD", amount: 44900, amount_refunded: 0, created: start + 50, status: "succeeded", paid: true },
      ];
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions: subs, customers: custs, charges });
      const row = r["NEWS50"].redemptions[0];
      assert.equal(row.first_payment_is_forecast, false);
      assert.equal(row.first_payment_epoch, start + 50, "menor created entre as cobranças");
    });

    it("trial_end null + sem charge → clamp em windowStart (discount.start), forecast=true", () => {
      // start_date (1782383062) < discount.start (1782673121) → o fallback
      // start_date seria anterior ao resgate; o clamp usa o anchor (discount.start).
      const subs: SubscriptionRaw[] = [{
        ...subscriptions[0], id: "sub_NF", customer: "cus_NF", trial_end: null,
        discounts: [{ ...subscriptions[0].discounts[0], id: "di_NF", customer: "cus_NF", subscription: "sub_NF" }],
      }];
      const custs: CustomerRaw[] = [{ id: "cus_NF", email: "nf@example.com" }];
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions: subs, customers: custs, charges: [] });
      const row = r["NEWS50"].redemptions[0];
      assert.equal(row.first_payment_is_forecast, true);
      assert.ok(subscriptions[0].start_date < start, "pré-condição: start_date < anchor");
      assert.equal(row.first_payment_epoch, start, "clamp pro windowStart (anchor)");
    });

    it("trial_end ausente (undefined, KV pré-#2749) → mesmo clamp, não quebra", () => {
      // subscriptions[0] não define trial_end → exercita o caminho undefined.
      const subs: SubscriptionRaw[] = [{
        ...subscriptions[0], id: "sub_UD", customer: "cus_UD",
        discounts: [{ ...subscriptions[0].discounts[0], id: "di_UD", customer: "cus_UD", subscription: "sub_UD" }],
      }];
      const custs: CustomerRaw[] = [{ id: "cus_UD", email: "ud@example.com" }];
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions: subs, customers: custs, charges: [] });
      const row = r["NEWS50"].redemptions[0];
      assert.equal(row.first_payment_is_forecast, true);
      assert.equal(row.first_payment_epoch, start);
    });

    it("trial_end anterior ao anchor é clampado (nunca previsão no passado)", () => {
      // trial_end < discount.start → clamp pro anchor (não mostra data passada com *).
      const subs: SubscriptionRaw[] = [{
        ...subscriptions[0], id: "sub_CL", customer: "cus_CL", trial_end: start - 1000,
        discounts: [{ ...subscriptions[0].discounts[0], id: "di_CL", customer: "cus_CL", subscription: "sub_CL" }],
      }];
      const custs: CustomerRaw[] = [{ id: "cus_CL", email: "cl@example.com" }];
      const r = aggregateCouponUsage({ codes: promos, coupons, subscriptions: subs, customers: custs, charges: [] });
      const row = r["NEWS50"].redemptions[0];
      assert.equal(row.first_payment_epoch, start, "clampado pro anchor");
    });
  });
});

// ---------------------------------------------------------------------------
// csvField — quoting RFC 4180 (#2719 finding #2)
// ---------------------------------------------------------------------------

describe("csvField", () => {
  it("passa campo limpo sem aspas", () => {
    assert.equal(csvField("cpnTEST50"), "cpnTEST50");
    assert.equal(csvField("active"), "active");
  });

  it("quota campo com vírgula (display-name email)", () => {
    assert.equal(
      csvField('"Sobrenome, Nome" <a@b.com>'),
      '"""Sobrenome, Nome"" <a@b.com>"',
    );
  });

  it("quota e escapa aspas internas dobrando-as", () => {
    assert.equal(csvField('a "b" c'), '"a ""b"" c"');
  });

  it("quota campo com quebra de linha", () => {
    assert.equal(csvField("linha1\nlinha2"), '"linha1\nlinha2"');
  });

  it("número vira string sem quoting", () => {
    assert.equal(csvField(44900), "44900");
  });

  it("null vira string vazia", () => {
    assert.equal(csvField(null), "");
  });
});

describe("toCSV — quoting de fim-a-fim", () => {
  const rowWithComma: RedemptionRow = {
    coupon_code: "NEWS50",
    coupon_id: "cpnTEST50",
    percent_off: 50,
    duration: "once",
    customer: "cus_TEST9",
    customer_email: '"Silva, João" <joao@example.com>',
    subscription: "sub_TEST9",
    status: "active",
    created: 1782383062,
    plan_amount_cents: 44900,
    currency: "brl",
    interval: "year",
    discount_value_cents: 22450,
    paid_cents: 89800,
    commission_cents: 35920, // 89800 * 0.40
    first_payment_epoch: 1783442446,
    first_payment_is_forecast: true,
  };

  it("o email com vírgula é quotado e NÃO desloca colunas", () => {
    const csv = toCSV([rowWithComma]);
    const lines = csv.split("\n");
    // header + 1 data row + trailing empty (devido ao \n final)
    assert.equal(lines.length, 3);
    assert.equal(lines[2], ""); // trailing newline

    const dataLine = lines[1];
    // O campo email quotado deve aparecer intacto
    assert.ok(
      dataLine.includes('"""Silva, João"" <joao@example.com>"'),
      `email quotado deve estar presente: ${dataLine}`,
    );

    // Parse robusto: o campo quotado conta como UMA coluna. Validamos que
    // a ÚLTIMA coluna (commission_cents, #2743) ainda é 35920 — prova de
    // não-deslocamento. Split simples por vírgula quebraria no email; usamos
    // regex que respeita aspas.
    const fields = dataLine.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!
      .map((f) => f.replace(/,$/, ""))
      .filter((_, i, arr) => i < arr.length); // mantém todos
    const nonEmpty = fields.filter((f) => f !== "");
    // Última coluna = first_payment_is_forecast (#2749); commission_cents (#2743)
    // segue presente na posição certa — prova de não-deslocamento.
    assert.equal(nonEmpty[nonEmpty.length - 1], "true");
    assert.ok(nonEmpty.includes("35920"), "commission_cents presente sem deslocamento");
    assert.ok(nonEmpty.includes("1783442446"), "first_payment_epoch presente");
  });

  it("header inclui paid/commission (#2743) + first_payment (#2749)", () => {
    const header = toCSV([rowWithComma]).split("\n")[0];
    assert.ok(
      header.endsWith("paid_cents,commission_cents,first_payment_epoch,first_payment_is_forecast"),
      header,
    );
  });

  it("CSV termina com newline (POSIX)", () => {
    const csv = toCSV([rowWithComma]);
    assert.ok(csv.endsWith("\n"), "CSV deve terminar com \\n");
  });
});

// ---------------------------------------------------------------------------
// StripeApiError — status estruturado, não regex na mensagem (#2750)
// ---------------------------------------------------------------------------

describe("StripeApiError (#2750)", () => {
  it("carrega o status HTTP estruturado (não só na mensagem)", () => {
    const err = new StripeApiError("/coupons/cpn_x", 404, '{"error":{"code":"resource_missing"}}');
    assert.equal(err.status, 404);
    assert.ok(err instanceof Error);
    assert.match(err.message, /404/);
  });
});

// ---------------------------------------------------------------------------
// couponIdFrom — normalização de shape do coupon id (#2750)
// ---------------------------------------------------------------------------

describe("couponIdFrom (#2750)", () => {
  it("id string direto", () => {
    assert.equal(couponIdFrom("cpn_123"), "cpn_123");
  });
  it("wrapper { coupon: 'id' } (promotion/source da API nova)", () => {
    assert.equal(couponIdFrom({ coupon: "cpn_123", type: "coupon" }), "cpn_123");
  });
  it("coupon aninhado como objeto { coupon: { id } }", () => {
    assert.equal(couponIdFrom({ coupon: { id: "cpn_123" } }), "cpn_123");
  });
  it("Coupon inline da API clássica { id, object: 'coupon' } (o bug do #2750)", () => {
    assert.equal(couponIdFrom({ id: "cpn_123", object: "coupon", percent_off: 50 }), "cpn_123");
  });
  it("null/undefined → undefined (não quebra)", () => {
    assert.equal(couponIdFrom(null), undefined);
    assert.equal(couponIdFrom(undefined), undefined);
  });
  it("objeto sem coupon nem id → undefined", () => {
    assert.equal(couponIdFrom({ type: "coupon" }), undefined);
  });
  it("coupon vazio ('') cai pro fallback id, não retorna string vazia", () => {
    assert.equal(couponIdFrom({ coupon: "", id: "cpn_fallback" }), "cpn_fallback");
  });
  it("coupon aninhado vazio ({id:''}) cai pro fallback id", () => {
    assert.equal(couponIdFrom({ coupon: { id: "" }, id: "cpn_fallback" }), "cpn_fallback");
  });
  it("tudo vazio ('', sem id) → undefined, nunca string vazia", () => {
    assert.equal(couponIdFrom({ coupon: "", id: "" }), undefined);
  });
});

// Regressão do #2750: o REST default da conta Stripe retorna promotion_code com
// o Coupon INLINE (`coupon` objeto) — não `promotion.coupon` string. O agregado
// tem que casar o cupom mesmo nessa forma (antes: TypeError / 0 matches).
describe("aggregateCouponUsage — shape clássico REST (#2750)", () => {
  const promosClassic = [
    {
      id: "promo_c1", object: "promotion_code", active: true, code: "NEWS50",
      created: 1779210106, max_redemptions: null, times_redeemed: 1,
      restrictions: { first_time_transaction: false, minimum_amount: null },
      // sem `promotion` — Coupon inline em `coupon` (API clássica)
      coupon: { id: "cpnTEST50", object: "coupon", percent_off: 50 },
    },
  ] as unknown as PromoCodeRaw[];

  const couponsClassic: CouponRaw[] = [
    { id: "cpnTEST50", object: "coupon", amount_off: null, percent_off: 50, currency: null,
      duration: "once", duration_in_months: null, name: "NEWS50", times_redeemed: 1, valid: true, max_redemptions: null },
  ];

  const subsClassic = [
    {
      id: "sub_c1", object: "subscription", customer: "cus_c1", status: "trialing",
      created: 1782383062, start_date: 1782383062, trial_end: 1782987862,
      items: { data: [{ price: { unit_amount: 44900, currency: "brl", recurring: { interval: "year" } } }] },
      // discount com Coupon inline como OBJETO (não string) — o outro shape do bug
      discounts: [{ id: "di_c1", object: "discount", customer: "cus_c1", promotion_code: null,
        coupon: { id: "cpnTEST50", object: "coupon" }, start: 1782383062, end: null, subscription: "sub_c1" }],
    },
  ] as unknown as SubscriptionRaw[];

  const custsClassic: CustomerRaw[] = [{ id: "cus_c1", email: "c1@example.com" }];

  it("casa o cupom e produz a redemption mesmo com Coupon inline (objeto)", () => {
    const r = aggregateCouponUsage({
      codes: promosClassic, coupons: couponsClassic, subscriptions: subsClassic, customers: custsClassic, charges: [],
    });
    assert.equal(r["NEWS50"].rowCount, 1, "assinatura casada apesar do shape clássico");
    assert.equal(r["NEWS50"].redemptions[0].coupon_id, "cpnTEST50");
    assert.equal(r["NEWS50"].redemptions[0].customer_email, "c1@example.com");
    assert.equal(r["NEWS50"].redemptions[0].first_payment_is_forecast, true, "trial → previsão");
  });
});

// Regressão do #2750: um promotion_code inativo aponta pra um coupon DELETADO
// (404). fetchCouponUsage tem que tolerar o 404 e seguir, sem quebrar o refresh.
describe("fetchCouponUsage — tolera coupon 404 (#2750)", () => {
  const mkRes = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  const mockFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/promotion_codes?code=NEWS50")) {
      return mkRes(200, {
        data: [{ id: "promo_50", object: "promotion_code", active: true, code: "NEWS50", created: 1779210106,
          coupon: { id: "cpnTEST50", object: "coupon" }, max_redemptions: null, times_redeemed: 1,
          restrictions: { first_time_transaction: false, minimum_amount: null } }],
        has_more: false,
      });
    }
    if (u.includes("/promotion_codes?code=NEWS25")) {
      return mkRes(200, {
        data: [
          { id: "promo_25a", object: "promotion_code", active: true, code: "NEWS25", created: 1779209686,
            coupon: { id: "cpnACTIVE25", object: "coupon" }, max_redemptions: null, times_redeemed: 0,
            restrictions: { first_time_transaction: false, minimum_amount: null } },
          { id: "promo_25i", object: "promotion_code", active: false, code: "NEWS25", created: 1779209465,
            coupon: { id: "cpnGONE", object: "coupon" }, max_redemptions: null, times_redeemed: 0,
            restrictions: { first_time_transaction: false, minimum_amount: null } },
        ],
        has_more: false,
      });
    }
    if (u.includes("/coupons/cpnGONE")) return mkRes(404, { error: { code: "resource_missing" } });
    if (u.includes("/coupons/cpnTEST50")) {
      return mkRes(200, { id: "cpnTEST50", object: "coupon", amount_off: null, percent_off: 50, currency: null,
        duration: "once", duration_in_months: null, name: "NEWS50", times_redeemed: 1, valid: true, max_redemptions: null });
    }
    if (u.includes("/coupons/cpnACTIVE25")) {
      return mkRes(200, { id: "cpnACTIVE25", object: "coupon", amount_off: null, percent_off: 25, currency: null,
        duration: "repeating", duration_in_months: 3, name: "NEWS25", times_redeemed: 0, valid: true, max_redemptions: null });
    }
    if (u.includes("/subscriptions")) {
      return mkRes(200, {
        data: [{ id: "sub_1", object: "subscription", customer: "cus_1", status: "trialing",
          created: 1782383062, start_date: 1782383062, trial_end: 1782987862,
          items: { data: [{ price: { unit_amount: 44900, currency: "brl", recurring: { interval: "year" } } }] },
          discounts: [{ id: "di_1", object: "discount", customer: "cus_1", promotion_code: null,
            coupon: { id: "cpnTEST50", object: "coupon" }, start: 1782383062, end: null, subscription: "sub_1" }] }],
        has_more: false,
      });
    }
    if (u.includes("/customers/")) return mkRes(200, { id: "cus_1", email: "c1@example.com" });
    if (u.includes("/charges")) return mkRes(200, { data: [], has_more: false });
    return mkRes(404, { error: { code: "unexpected" } });
  }) as unknown as typeof fetch;

  it("não quebra no coupon deletado e produz o report do cupom válido", async () => {
    const report = await fetchCouponUsage("rk_test_dummy", mockFetch);
    assert.equal(report["NEWS50"].rowCount, 1, "assinatura NEWS50 casada");
    assert.equal(report["NEWS50"].redemptions[0].customer_email, "c1@example.com");
    assert.equal(report["NEWS50"].redemptions[0].first_payment_is_forecast, true, "trial → previsão");
  });
});

// Regressão CRÍTICA do #2750: um coupon pode ser deletado na Stripe ENQUANTO
// uma assinatura ainda tem o discount ativo (Stripe permite). Antes do fix,
// `couponById.get(discCouponId)` vinha undefined e a linha inteira (com
// paid_cents/commission_cents) era descartada — perda SILENCIOSA de comissão
// de um cliente que ainda paga. O placeholder garante que a linha sobreviva.
describe("fetchCouponUsage — coupon deletado MAS ainda usado por assinatura ativa (#2750)", () => {
  const mkRes = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  const mockFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/promotion_codes?code=NEWS50")) {
      return mkRes(200, { data: [], has_more: false });
    }
    if (u.includes("/promotion_codes?code=NEWS25")) {
      return mkRes(200, {
        data: [{ id: "promo_25", object: "promotion_code", active: true, code: "NEWS25", created: 1779209686,
          coupon: { id: "cpnDELETED", object: "coupon" }, max_redemptions: null, times_redeemed: 1,
          restrictions: { first_time_transaction: false, minimum_amount: null } }],
        has_more: false,
      });
    }
    // O coupon foi deletado — 404 mesmo sendo referenciado por assinatura ativa.
    if (u.includes("/coupons/cpnDELETED")) return mkRes(404, { error: { code: "resource_missing" } });
    if (u.includes("/subscriptions")) {
      return mkRes(200, {
        data: [{ id: "sub_paying", object: "subscription", customer: "cus_paying", status: "active",
          created: 1782383062, start_date: 1782383062, trial_end: null,
          items: { data: [{ price: { unit_amount: 9990, currency: "brl", recurring: { interval: "month" } } }] },
          discounts: [{ id: "di_paying", object: "discount", customer: "cus_paying", promotion_code: null,
            coupon: { id: "cpnDELETED", object: "coupon" }, start: 1782383062, end: null, subscription: "sub_paying" }] }],
        has_more: false,
      });
    }
    if (u.includes("/customers/")) return mkRes(200, { id: "cus_paying", email: "paying@example.com" });
    if (u.includes("/charges")) {
      return mkRes(200, {
        data: [{ id: "ch_1", object: "charge", customer: "cus_paying", amount: 9990, amount_refunded: 0,
          created: 1782383062 + 10, status: "succeeded", paid: true }],
        has_more: false,
      });
    }
    return mkRes(404, { error: { code: "unexpected" } });
  }) as unknown as typeof fetch;

  it("a redemption SOBREVIVE com paid/comissão corretos, mesmo sem metadados do coupon", async () => {
    const report = await fetchCouponUsage("rk_test_dummy", mockFetch);
    assert.equal(report["NEWS25"].rowCount, 1, "assinatura NÃO foi descartada apesar do coupon 404");
    const row = report["NEWS25"].redemptions[0];
    assert.equal(row.customer_email, "paying@example.com");
    assert.equal(row.paid_cents, 9990, "comissão calculada a partir dos charges, não do coupon");
    assert.equal(row.commission_cents, Math.round(9990 * 0.4));
    assert.equal(row.percent_off, null, "metadados do coupon deletado são desconhecidos");
    assert.equal(row.duration, "desconhecido", "placeholder explícito, não confundido com um valor real");
  });
});

// Regressão do #2750: só 404 é tolerado. Erros de auth/infra (401/403/5xx) têm
// que continuar estourando — senão uma chave revogada vira silenciosamente
// "0 cupons" em vez de falha visível.
describe("fetchCouponUsage — NÃO tolera erro não-404 (#2750)", () => {
  const mkRes = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  const mockFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/promotion_codes?code=NEWS50")) {
      return mkRes(200, {
        data: [{ id: "promo_50", object: "promotion_code", active: true, code: "NEWS50", created: 1779210106,
          coupon: { id: "cpnX", object: "coupon" }, max_redemptions: null, times_redeemed: 1,
          restrictions: { first_time_transaction: false, minimum_amount: null } }],
        has_more: false,
      });
    }
    if (u.includes("/promotion_codes?code=NEWS25")) return mkRes(200, { data: [], has_more: false });
    // 401 — chave revogada/inválida. NÃO deve ser tolerado como o 404.
    if (u.includes("/coupons/cpnX")) return mkRes(401, { error: { code: "api_key_expired" } });
    return mkRes(404, { error: { code: "unexpected" } });
  }) as unknown as typeof fetch;

  it("propaga o erro (não mascara 401 como se fosse coupon deletado)", async () => {
    await assert.rejects(() => fetchCouponUsage("rk_test_dummy", mockFetch), /401/);
  });
});

// ---------------------------------------------------------------------------
// redemptionWho — mascaramento de PII no stdout p/ CI (#2750)
// ---------------------------------------------------------------------------

describe("redemptionWho (#2750)", () => {
  const row = {
    customer: "cus_ABC123",
    customer_email: "assinante@example.com",
  } as unknown as RedemptionRow;

  it("noPii=false → mostra o e-mail", () => {
    assert.equal(redemptionWho(row, false), "assinante@example.com");
  });

  it("noPii=true → mostra o cus_id, NUNCA o e-mail", () => {
    const who = redemptionWho(row, true);
    assert.equal(who, "cus_ABC123");
    assert.ok(!who.includes("@"), "sem e-mail no output de CI");
  });

  it("noPii=false sem e-mail → cai pro cus_id", () => {
    const noEmail = { customer: "cus_X", customer_email: "" } as unknown as RedemptionRow;
    assert.equal(redemptionWho(noEmail, false), "cus_X");
  });
});

// ---------------------------------------------------------------------------
// isMainModule — detecção case-insensitive (#2719 finding #1)
// ---------------------------------------------------------------------------

describe("isMainModule", () => {
  // Path absoluto real deste arquivo de teste → url file:// válida no SO atual.
  const thisPath = fileURLToPath(import.meta.url);
  const thisUrl = pathToFileURL(thisPath).href;

  it("retorna false quando argv1 é undefined (importado)", () => {
    assert.equal(isMainModule(undefined, thisUrl), false);
  });

  it("casa quando argv1 == módulo (mesmo casing)", () => {
    assert.equal(isMainModule(thisPath, thisUrl), true);
  });

  it("casa mesmo com casing divergente (regressão Windows drive-letter, #2719)", () => {
    // A função lowercases ambos os lados; argv1 em UPPER-CASE ainda deve casar.
    // Reproduz o cenário Windows onde argv1 vem com `c:` e import.meta.url com `C:`.
    assert.equal(isMainModule(thisPath.toUpperCase(), thisUrl), true);
    assert.equal(isMainModule(thisPath.toLowerCase(), thisUrl), true);
  });

  it("não casa módulos diferentes", () => {
    const otherPath = resolve(thisPath, "..", "outro-script-inexistente.ts");
    assert.equal(isMainModule(otherPath, thisUrl), false);
  });
});
