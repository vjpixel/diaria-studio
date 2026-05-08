import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recencyWeight,
  computeScore,
  isLowQualityEmail,
  mergeRecord,
  verifyRisk,
  openProbability,
  hasClariceAudienceTag,
  tierOf,
  tierLabel,
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

// ---------------------------------------------------------------------------
// hasClariceAudienceTag
// ---------------------------------------------------------------------------

describe("hasClariceAudienceTag", () => {
  it("description = clrc-pt → true", () => {
    assert.equal(hasClariceAudienceTag(merged({ description: "clrc-pt" })), true);
  });

  it("tag = clrc-pt → true", () => {
    assert.equal(hasClariceAudienceTag(merged({ tag: "clrc-pt" })), true);
  });

  it("description = clrc-en, tag = null → false (só clrc-pt qualifica)", () => {
    assert.equal(hasClariceAudienceTag(merged({ description: "clrc-en" })), false);
  });

  it("ambos null → false", () => {
    assert.equal(hasClariceAudienceTag(merged({ description: null, tag: null })), false);
  });
});

// ---------------------------------------------------------------------------
// verifyRisk — sem tag clrc-pt no critério (níveis 6–10 puramente recência)
// ---------------------------------------------------------------------------

describe("verifyRisk", () => {
  it("nível 1: status active", () => {
    assert.equal(verifyRisk(merged({ status: "active" }), NOW), 1);
  });

  it("nível 2: 10+ pagamentos, conta < 24mo", () => {
    const c = merged({
      status: "canceled",
      payment_count: 12,
      created: new Date("2025-01-01T00:00:00Z"), // ~16mo antes de NOW
    });
    assert.equal(verifyRisk(c, NOW), 2);
  });

  it("nível 3: 3+ pagamentos, conta < 24mo", () => {
    const c = merged({
      status: "canceled",
      payment_count: 5,
      created: new Date("2025-06-01T00:00:00Z"),
    });
    assert.equal(verifyRisk(c, NOW), 3);
  });

  it("nível 4: 1+ pagamento, conta < 36mo", () => {
    const c = merged({
      status: "canceled",
      payment_count: 1,
      created: new Date("2024-01-01T00:00:00Z"),
    });
    assert.equal(verifyRisk(c, NOW), 4);
  });

  it("nível 5: 1+ pagamento, conta 36–60mo", () => {
    const c = merged({
      status: "canceled",
      payment_count: 1,
      created: new Date("2022-01-01T00:00:00Z"), // ~52mo
    });
    assert.equal(verifyRisk(c, NOW), 5);
  });

  it("nível 5: pagante antigo 60+mo (#1017 fix — antes caía em 10)", () => {
    // Bug pré-existente: `payment_count >= 1 && months < 60` deixava
    // pagantes muito antigos (60+mo) caírem em níveis 6-10 (never-paid).
    // Fix #1017: collapse em level 5 = "qualquer paid >=36mo".
    const c = merged({
      status: "canceled",
      payment_count: 1,
      total_spend: 100,
      created: new Date("2020-01-01T00:00:00Z"), // ~75mo (6+ anos)
    });
    assert.equal(
      verifyRisk(c, NOW),
      5,
      "Pagante antigo (60+mo) deve ficar em nível 5, não em level 10 (never-paid).",
    );
  });

  it("nível 5: pagante muito antigo, várias compras", () => {
    // Edge case: alguém que pagou muitas vezes mas conta já está velha.
    const c = merged({
      status: "canceled",
      payment_count: 30,
      total_spend: 1500,
      created: new Date("2019-06-01T00:00:00Z"), // ~83mo (~7 anos)
    });
    assert.equal(verifyRisk(c, NOW), 5);
  });

  it("nível 6: nunca pagou, conta < 12mo", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2025-12-01T00:00:00Z"),
    });
    assert.equal(verifyRisk(c, NOW), 6);
  });

  it("nível 7: nunca pagou, conta 12–24mo", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2024-11-01T00:00:00Z"),
    });
    assert.equal(verifyRisk(c, NOW), 7);
  });

  it("nível 8: nunca pagou, conta 24–36mo", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2023-11-01T00:00:00Z"),
    });
    assert.equal(verifyRisk(c, NOW), 8);
  });

  it("nível 9: nunca pagou, conta 36–48mo", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2022-11-01T00:00:00Z"),
    });
    assert.equal(verifyRisk(c, NOW), 9);
  });

  it("nível 10: nunca pagou, conta 48+mo (fóssil)", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2021-01-01T00:00:00Z"),
    });
    assert.equal(verifyRisk(c, NOW), 10);
  });

  it("tag clrc-pt NÃO afeta risk: dois contatos idênticos com/sem tag dão mesmo nível", () => {
    const base = {
      status: "",
      payment_count: 0,
      created: new Date("2024-11-01T00:00:00Z"), // 12–24mo
    };
    const withTag = merged({ ...base, tag: "clrc-pt" });
    const withoutTag = merged({ ...base, tag: null });
    assert.equal(verifyRisk(withTag, NOW), verifyRisk(withoutTag, NOW));
    assert.equal(verifyRisk(withTag, NOW), 7);
  });
});

// ---------------------------------------------------------------------------
// openProbability — sem tag clrc-pt; não-pagantes começam em 12
// ---------------------------------------------------------------------------

describe("openProbability", () => {
  it("active recente (< 12mo): 62 base + 12 recência = 74", () => {
    const c = merged({
      status: "active",
      created: new Date("2025-12-01T00:00:00Z"),
    });
    assert.equal(openProbability(c, NOW), 74);
  });

  it("spend ≥ 1000 + recente: 50 + 12 = 62", () => {
    const c = merged({
      status: "canceled",
      total_spend: 1500,
      created: new Date("2025-12-01T00:00:00Z"),
    });
    // status canceled aplica -3 negativo
    assert.equal(openProbability(c, NOW), 50 + 12 - 3);
  });

  it("nunca pagou + recente: base 12 + 12 recência = 24", () => {
    const c = merged({
      status: "",
      total_spend: 0,
      payment_count: 0,
      created: new Date("2025-12-01T00:00:00Z"),
    });
    assert.equal(openProbability(c, NOW), 12 + 12);
  });

  it("nunca pagou + antigo (36+mo): 12 base − 6 recência = clamped a 4 (mín)", () => {
    const c = merged({
      status: "",
      total_spend: 0,
      payment_count: 0,
      created: new Date("2022-01-01T00:00:00Z"),
    });
    // 12 - 6 = 6, mas modificadores adicionais não aplicam → resultado 6
    assert.equal(openProbability(c, NOW), 6);
  });

  it("tag clrc-pt NÃO afeta probability: dois contatos idênticos com/sem tag dão mesmo valor", () => {
    const base = {
      status: "",
      total_spend: 0,
      payment_count: 0,
      created: new Date("2024-11-01T00:00:00Z"),
    };
    const withTag = merged({ ...base, tag: "clrc-pt" });
    const withoutTag = merged({ ...base, tag: null });
    assert.equal(openProbability(withTag, NOW), openProbability(withoutTag, NOW));
  });

  it("clamp inferior em 4", () => {
    const c = merged({
      status: "canceled",
      total_spend: 0,
      payment_count: 0,
      delinquent: true,
      created: new Date("2021-01-01T00:00:00Z"),
    });
    // 12 base - 6 recência - 5 delinquent - 3 canceled = -2 → clamp 4
    assert.equal(openProbability(c, NOW), 4);
  });

  it("clamp superior em 80", () => {
    const c = merged({
      status: "active",
      total_spend: 5000,
      payment_count: 30,
      created: new Date("2025-12-01T00:00:00Z"),
    });
    // 62 + 12 + 10 = 84 → clamp 80
    assert.equal(openProbability(c, NOW), 80);
  });
});

// ---------------------------------------------------------------------------
// tierOf — taxonomia 10 tiers (#1018)
// ---------------------------------------------------------------------------

describe("tierOf", () => {
  it("T1: status active", () => {
    assert.equal(tierOf(merged({ status: "active" }), NOW), 1);
  });

  it("T1: status past_due", () => {
    assert.equal(tierOf(merged({ status: "past_due" }), NOW), 1);
  });

  it("T1: status paused", () => {
    assert.equal(tierOf(merged({ status: "paused" }), NOW), 1);
  });

  it("T1: status trialing", () => {
    assert.equal(tierOf(merged({ status: "trialing" }), NOW), 1);
  });

  it("T2: pagou alguma vez (payment_count>0), não está em T1", () => {
    const c = merged({
      status: "canceled",
      payment_count: 1,
      total_spend: 100,
    });
    assert.equal(tierOf(c, NOW), 2);
  });

  it("T2: paid via total_spend>0 mesmo com payment_count=0", () => {
    const c = merged({
      status: "canceled",
      payment_count: 0,
      total_spend: 50,
    });
    assert.equal(tierOf(c, NOW), 2);
  });

  it("T1 tem precedência sobre T2 (active + paid)", () => {
    const c = merged({
      status: "active",
      payment_count: 5,
      total_spend: 500,
    });
    assert.equal(tierOf(c, NOW), 1);
  });

  it("T3: lead nunca-pagou criado em 2026", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      total_spend: 0,
      created: new Date("2026-03-15T00:00:00Z"),
    });
    assert.equal(tierOf(c, NOW), 3);
  });

  it("T4: lead 2025-H2 (jul–dez)", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2025-09-01T00:00:00Z"),
    });
    assert.equal(tierOf(c, NOW), 4);
  });

  it("T5: lead 2025-H1 (jan–jun)", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2025-03-01T00:00:00Z"),
    });
    assert.equal(tierOf(c, NOW), 5);
  });

  it("T6: lead 2024-H2", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2024-09-01T00:00:00Z"),
    });
    assert.equal(tierOf(c, NOW), 6);
  });

  it("T7: lead 2024-H1", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2024-02-01T00:00:00Z"),
    });
    assert.equal(tierOf(c, NOW), 7);
  });

  it("T8: lead 2023-H2", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2023-08-01T00:00:00Z"),
    });
    assert.equal(tierOf(c, NOW), 8);
  });

  it("T9: lead 2023-H1", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2023-01-15T00:00:00Z"),
    });
    assert.equal(tierOf(c, NOW), 9);
  });

  it("T10: lead 2022 (todo H1+H2 → T10)", () => {
    const cH1 = merged({
      status: "",
      payment_count: 0,
      created: new Date("2022-03-01T00:00:00Z"),
    });
    const cH2 = merged({
      status: "",
      payment_count: 0,
      created: new Date("2022-09-01T00:00:00Z"),
    });
    assert.equal(tierOf(cH1), 10);
    assert.equal(tierOf(cH2), 10);
  });

  it("T10: lead 2021 (todo H1+H2 → T10)", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2021-06-01T00:00:00Z"),
    });
    assert.equal(tierOf(c, NOW), 10);
  });

  it("T10: lead com created muito antigo (2018)", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2018-01-01T00:00:00Z"),
    });
    assert.equal(tierOf(c, NOW), 10);
  });

  it("T10 fallback: lead sem created date (sem data → fóssil)", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: null,
    });
    assert.equal(tierOf(c, NOW), 10);
  });

  it("Tag clrc-pt NÃO afeta tier — dois contatos idênticos com/sem tag dão mesmo tier", () => {
    const base = {
      status: "",
      payment_count: 0,
      total_spend: 0,
      created: new Date("2025-03-01T00:00:00Z"),
    };
    const withTag = merged({ ...base, tag: "clrc-pt", description: "clrc-pt" });
    const withoutTag = merged({ ...base, tag: null, description: null });
    assert.equal(tierOf(withTag, NOW), tierOf(withoutTag, NOW));
    assert.equal(tierOf(withTag, NOW), 5);
  });
});

// ---------------------------------------------------------------------------
// tierOf com semestres deslizantes (#1020)
// ---------------------------------------------------------------------------

describe("tierOf — semestres deslizantes (#1020)", () => {
  it("self-adjusting: contato Mar/2026 é T3 quando now=Mai/2026, mas T4 quando now=Ago/2026", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2026-03-15T00:00:00Z"),
    });
    // Mai/2026 — Mar/2026 = mesmo semestre (H1) → T3
    assert.equal(tierOf(c, new Date("2026-05-08T00:00:00Z")), 3);
    // Ago/2026 — Mar/2026 = 1 semestre atrás → T4
    assert.equal(tierOf(c, new Date("2026-08-08T00:00:00Z")), 4);
    // Mar/2027 — Mar/2026 = 2 semestres atrás → T5
    assert.equal(tierOf(c, new Date("2027-03-15T00:00:00Z")), 5);
  });

  it("contato no futuro (raro) cai em T3 (mais quente)", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2026-12-01T00:00:00Z"),
    });
    // now = Mai/2026, contato no futuro
    assert.equal(tierOf(c, new Date("2026-05-08T00:00:00Z")), 3);
  });

  it("T10 absorve qualquer coisa ≥ 7 semestres atrás", () => {
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2022-06-01T00:00:00Z"),
    });
    // 2022-H2 → 2026-H1 = ~7 semestres atrás → T10
    assert.equal(tierOf(c, new Date("2026-05-08T00:00:00Z")), 10);
  });

  it("não muda no MEIO de um semestre (jul → dez 2026 todos no mesmo bucket)", () => {
    // Lead criado jan/2026
    const c = merged({
      status: "",
      payment_count: 0,
      created: new Date("2026-01-15T00:00:00Z"),
    });
    // now ao longo do 2026-H2 (jul, set, dez): todos devem dar T4
    assert.equal(tierOf(c, new Date("2026-07-01T00:00:00Z")), 4);
    assert.equal(tierOf(c, new Date("2026-09-15T00:00:00Z")), 4);
    assert.equal(tierOf(c, new Date("2026-12-31T00:00:00Z")), 4);
  });

  it("T1 e T2 não dependem de now (status/spend são sinais permanentes)", () => {
    const t1 = merged({ status: "active", payment_count: 0 });
    const t2 = merged({ status: "canceled", payment_count: 5, total_spend: 100 });
    const dates = [
      new Date("2024-01-01T00:00:00Z"),
      new Date("2026-05-08T00:00:00Z"),
      new Date("2030-12-31T00:00:00Z"),
    ];
    for (const d of dates) {
      assert.equal(tierOf(t1, d), 1, `T1 deve ser sempre 1 (now=${d.toISOString()})`);
      assert.equal(tierOf(t2, d), 2, `T2 deve ser sempre 2 (now=${d.toISOString()})`);
    }
  });
});

describe("tierLabel — labels dinâmicos (#1020)", () => {
  it("T1 e T2 têm labels fixos", () => {
    const NOW = new Date("2026-05-08T00:00:00Z");
    assert.match(tierLabel(1, NOW), /Assinante atual/);
    assert.match(tierLabel(2, NOW), /Ex-assinante/);
  });

  it("T3 = semestre corrente (varia com now)", () => {
    assert.match(tierLabel(3, new Date("2026-05-08T00:00:00Z")), /2026-H1/);
    assert.match(tierLabel(3, new Date("2026-08-08T00:00:00Z")), /2026-H2/);
    assert.match(tierLabel(3, new Date("2027-02-01T00:00:00Z")), /2027-H1/);
  });

  it("T4 = semestre anterior", () => {
    // Mai/2026 → corrente é 2026-H1; T4 = 2025-H2
    assert.match(tierLabel(4, new Date("2026-05-08T00:00:00Z")), /2025-H2/);
  });

  it("T9 = 6 semestres atrás", () => {
    // Mai/2026 (2026-H1) — 6 = 2023-H1
    assert.match(tierLabel(9, new Date("2026-05-08T00:00:00Z")), /2023-H1/);
  });
});
