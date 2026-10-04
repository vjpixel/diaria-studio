import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRedeemer } from "../scripts/lib/coupon-clarice-class.ts";

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
