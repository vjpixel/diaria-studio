import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRedeemer,
  buildClariceClasses,
  clariceClassKey,
  normalizeClariceClassPayload,
} from "../scripts/lib/coupon-clarice-class.ts";
import type { CouponUsageReport } from "../scripts/lib/stripe-coupons.ts";

const DAY = 86400;
const redeemed = Math.floor(Date.parse("2026-10-01T12:00:00Z") / 1000);
const iso = (daysBefore: number) => new Date((redeemed - daysBefore * DAY) * 1000).toISOString();

describe("classifyRedeemer (#9571)", () => {
  it("no store há 30d → antigo", () => {
    assert.equal(classifyRedeemer({ created: iso(30), brevo_created_at: null }, redeemed).cls, "antigo");
  });
  it("no store há 3d → novo (folga de 7d)", () => {
    assert.equal(classifyRedeemer({ created: iso(3), brevo_created_at: null }, redeemed).cls, "novo");
  });
  it("exatamente 7d → novo (só >7d é antigo)", () => {
    assert.equal(classifyRedeemer({ created: iso(7), brevo_created_at: null }, redeemed).cls, "novo");
  });
  it("ausente do store → novo", () => {
    assert.equal(classifyRedeemer(null, redeemed).cls, "novo");
  });
  it("lead só com brevo_created_at há 60d → antigo", () => {
    assert.equal(classifyRedeemer({ created: null, brevo_created_at: iso(60) }, redeemed).cls, "antigo");
  });
  it("usa o min das duas datas", () => {
    assert.equal(classifyRedeemer({ created: iso(1), brevo_created_at: iso(40) }, redeemed).cls, "antigo");
  });
  it("sem nenhuma data → antigo, sinalizado como undated", () => {
    assert.deepEqual(classifyRedeemer({ created: null, brevo_created_at: null }, redeemed), { cls: "antigo", undated: true });
  });
});

describe("buildClariceClasses — data do resgate, não da assinatura (#9617)", () => {
  // Assinante de março (sub.created) aplica cupom hoje (discount.start) e entrou
  // no store em agosto: medido contra março daria "novo" (store depois da
  // assinatura); medido contra o resgate é "antigo".
  const subCreated = Math.floor(Date.parse("2026-03-01T12:00:00Z") / 1000);
  const usage = {
    NEWS50: {
      couponIds: ["c"], timesRedeemed: 1, rowCount: 1, totalProjectedDiscountCents: 0,
      redemptions: [{ customer_email: "x@example.com", created: subCreated, redeemed_at: redeemed }],
    },
  } as unknown as CouponUsageReport;
  const lookup = () => ({ created: "2026-08-01T00:00:00Z", brevo_created_at: null });

  it("classifica e indexa pela data do resgate", () => {
    const { classes } = buildClariceClasses(usage, lookup);
    assert.deepEqual(classes, { [clariceClassKey("x@example.com", redeemed)]: "antigo" });
  });

  it("KV legado sem redeemed_at cai em created", () => {
    const legacy = { NEWS50: { ...usage.NEWS50, redemptions: [{ customer_email: "x@example.com", created: subCreated }] } } as unknown as CouponUsageReport;
    assert.deepEqual(buildClariceClasses(legacy, lookup).classes, { [clariceClassKey("x@example.com", subCreated)]: "novo" });
  });
});

describe("normalizeClariceClassPayload (#9617)", () => {
  it("aceita payload válido e descarta valores fora de novo/antigo", () => {
    const p = normalizeClariceClassPayload({ generated_at: "2026-10-01T00:00:00Z", classes: { a: "novo", b: "talvez" } });
    assert.deepEqual(p, { generated_at: "2026-10-01T00:00:00Z", classes: { a: "novo" } });
  });
  it("formato inesperado → null", () => {
    for (const raw of [null, "x", {}, { generated_at: "nao-data", classes: {} }, { generated_at: "2026-10-01T00:00:00Z", classes: [] }]) {
      assert.equal(normalizeClariceClassPayload(raw), null);
    }
  });
});
