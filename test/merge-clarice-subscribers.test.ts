import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recencyWeight,
  computeScore,
  isLowQualityEmail,
  mergeRecord,
  type Merged,
} from "../scripts/merge-clarice-subscribers.ts";

// Helper pra criar fixture Merged mínima
function merged(overrides: Partial<Merged> = {}): Merged {
  return {
    id: null,
    email: "test@example.com",
    name: null,
    created: null,
    description: null,
    tag: null,
    delinquent: false,
    plan: null,
    status: "active",
    total_spend: 0,
    payment_count: 0,
    refunded_volume: 0,
    dispute_losses: 0,
    stripe_ids: [],
    source_files: [],
    ...overrides,
  };
}

const NOW = new Date("2026-05-04T12:00:00Z");

// ---------------------------------------------------------------------------
// recencyWeight
// ---------------------------------------------------------------------------

describe("recencyWeight", () => {
  it("null → 0.1 (pior caso)", () => {
    assert.equal(recencyWeight(null, NOW), 0.1);
  });

  it("< 12 meses → 1.0 (melhor caso)", () => {
    const recent = new Date("2025-12-01T00:00:00Z");
    assert.equal(recencyWeight(recent, NOW), 1.0);
  });

  it("12–24 meses → 0.6", () => {
    const d = new Date("2024-11-01T00:00:00Z"); // ~18 meses
    assert.equal(recencyWeight(d, NOW), 0.6);
  });

  it("24–36 meses → 0.3", () => {
    const d = new Date("2023-11-01T00:00:00Z"); // ~30 meses
    assert.equal(recencyWeight(d, NOW), 0.3);
  });

  it("> 36 meses → 0.1", () => {
    const old = new Date("2021-01-01T00:00:00Z"); // 64 meses
    assert.equal(recencyWeight(old, NOW), 0.1);
  });
});

// ---------------------------------------------------------------------------
// computeScore
// ---------------------------------------------------------------------------

describe("computeScore", () => {
  it("sem spend nem payments → só peso de recência", () => {
    const m = merged({ created: new Date("2025-12-01T00:00:00Z") });
    const s = computeScore(m, NOW);
    assert.ok(s > 0, "score deve ser positivo");
    assert.ok(s < 5, "score sem spend deve ser baixo");
  });

  it("alto spend + recente → score alto", () => {
    const m = merged({
      total_spend: 1000,
      payment_count: 20,
      created: new Date("2025-12-01T00:00:00Z"),
    });
    const s = computeScore(m, NOW);
    assert.ok(s > 5, `score deve ser alto, got ${s}`);
  });

  it("dispute_losses > 0 → penalidade −5 aplicada", () => {
    const clean = merged({ total_spend: 100, payment_count: 5, created: new Date("2025-12-01T00:00:00Z") });
    const dirty = merged({ total_spend: 100, payment_count: 5, created: new Date("2025-12-01T00:00:00Z"), dispute_losses: 1 });
    const diff = computeScore(clean, NOW) - computeScore(dirty, NOW);
    assert.ok(Math.abs(diff - 5) < 0.01, `penalidade deve ser 5, got diff=${diff}`);
  });

  it("refund_abuse (>50% do spend) → penalidade −2 aplicada", () => {
    const clean = merged({ total_spend: 100, refunded_volume: 0, payment_count: 5, created: new Date("2025-12-01T00:00:00Z") });
    const abusive = merged({ total_spend: 100, refunded_volume: 60, payment_count: 5, created: new Date("2025-12-01T00:00:00Z") });
    const diff = computeScore(clean, NOW) - computeScore(abusive, NOW);
    assert.ok(Math.abs(diff - 2) < 0.01, `penalidade deve ser 2, got diff=${diff}`);
  });

  it("leads com mais spend sempre superam leads sem spend (mesmo recência igual)", () => {
    const low = merged({ total_spend: 0, payment_count: 0, created: new Date("2025-12-01T00:00:00Z") });
    const high = merged({ total_spend: 500, payment_count: 10, created: new Date("2025-12-01T00:00:00Z") });
    assert.ok(computeScore(high, NOW) > computeScore(low, NOW));
  });
});

// ---------------------------------------------------------------------------
// isLowQualityEmail
// ---------------------------------------------------------------------------

describe("isLowQualityEmail", () => {
  it("email normal → bom", () => {
    const r = isLowQualityEmail("joao.silva@gmail.com");
    assert.equal(r.bad, false);
  });

  it("domínio descartável (mailinator) → bad", () => {
    const r = isLowQualityEmail("test@mailinator.com");
    assert.equal(r.bad, true);
    assert.equal(r.reason, "disposable_domain");
  });

  it("role account (contato@) → bad", () => {
    const r = isLowQualityEmail("contato@empresa.com.br");
    assert.equal(r.bad, true);
    assert.equal(r.reason, "role_account");
  });

  it("noreply@ → bad", () => {
    const r = isLowQualityEmail("noreply@empresa.com");
    assert.equal(r.bad, true);
    assert.equal(r.reason, "role_account");
  });

  it("local muito curto (2 chars) → bad", () => {
    const r = isLowQualityEmail("ab@empresa.com");
    assert.equal(r.bad, true);
    assert.equal(r.reason, "local_too_short");
  });

  it("placeholder (seuemail) → bad", () => {
    const r = isLowQualityEmail("seuemail@gmail.com");
    assert.equal(r.bad, true);
    assert.equal(r.reason, "placeholder");
  });

  it("email de teste (test@) → bad", () => {
    const r = isLowQualityEmail("test@gmail.com");
    assert.equal(r.bad, true);
    assert.equal(r.reason, "fake_pattern");
  });
});

// ---------------------------------------------------------------------------
// mergeRecord (mutation test)
// ---------------------------------------------------------------------------

describe("mergeRecord", () => {
  it("soma total_spend de dois registros", () => {
    const existing = merged({ total_spend: 100, payment_count: 3, stripe_ids: ["cus_1"] });
    const rec = {
      id: "cus_2",
      email: "test@example.com",
      name: null,
      created: null,
      description: null,
      tag: null,
      delinquent: false,
      plan: null,
      status: "canceled" as const,
      total_spend: 50,
      payment_count: 2,
      refunded_volume: 0,
      dispute_losses: 0,
    };
    mergeRecord(existing, rec as Parameters<typeof mergeRecord>[1], "file2.csv");
    assert.equal(existing.total_spend, 150);
    assert.equal(existing.payment_count, 5);
    assert.ok(existing.stripe_ids.includes("cus_2"), "deve incluir o novo stripe_id");
  });

  it("delinquent = OR (qualquer true vira true)", () => {
    const existing = merged({ delinquent: false });
    const rec = { ...merged(), delinquent: true };
    mergeRecord(existing, rec, "f.csv");
    assert.equal(existing.delinquent, true);
  });

  it("created fica com o mais recente", () => {
    const older = new Date("2022-01-01T00:00:00Z");
    const newer = new Date("2024-01-01T00:00:00Z");
    const existing = merged({ created: older });
    const rec = { ...merged(), created: newer };
    mergeRecord(existing, rec, "f.csv");
    assert.deepEqual(existing.created, newer);
  });

  it("status fica com o mais ativo (active > canceled)", () => {
    const existing = merged({ status: "canceled" });
    const rec = { ...merged(), status: "active" };
    mergeRecord(existing, rec, "f.csv");
    assert.equal(existing.status, "active");
  });
});
