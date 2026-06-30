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
  csvField,
  toCSV,
  isMainModule,
  type PromoCodeRaw,
  type CouponRaw,
  type SubscriptionRaw,
  type CustomerRaw,
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
    // a coluna 13 (discount_value_cents) ainda é 22450 — prova de não-deslocamento.
    // Split simples por vírgula quebraria no email; usamos regex que respeita aspas.
    const fields = dataLine.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!
      .map((f) => f.replace(/,$/, ""))
      .filter((_, i, arr) => i < arr.length); // mantém todos
    // Última coluna não-vazia = discount_value_cents
    const nonEmpty = fields.filter((f) => f !== "");
    assert.equal(nonEmpty[nonEmpty.length - 1], "22450");
  });

  it("CSV termina com newline (POSIX)", () => {
    const csv = toCSV([rowWithComma]);
    assert.ok(csv.endsWith("\n"), "CSV deve terminar com \\n");
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
