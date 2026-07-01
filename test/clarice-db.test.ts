import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePriorityPoints,
  classifyEligibility,
  recomputeDerived,
  openClariceDb,
  SOFT_BOUNCE_LIMIT,
} from "../scripts/lib/clarice-db.ts";

// ---------------------------------------------------------------------------
// computePriorityPoints (#2647)
//   +40 optin · +20 por aberto · -10 por recebido-e-não-aberto · 0 sem envio
// ---------------------------------------------------------------------------

test("priority_points: sem envios e sem optin → 0 (ponto de partida)", () => {
  assert.equal(
    computePriorityPoints({ priority_optin: false, opens_count: 0, sends_count: 0 }),
    0,
  );
});

test("priority_points: optin sem envios → 40", () => {
  assert.equal(
    computePriorityPoints({ priority_optin: true, opens_count: 0, sends_count: 0 }),
    40,
  );
});

test("priority_points: optin que ignora 4 emails decai pra 0 (40 − 10×4)", () => {
  assert.equal(
    computePriorityPoints({ priority_optin: true, opens_count: 0, sends_count: 4 }),
    0,
  );
});

test("priority_points: optin que ignora 5 emails fica negativo (−10)", () => {
  assert.equal(
    computePriorityPoints({ priority_optin: true, opens_count: 0, sends_count: 5 }),
    -10,
  );
});

test("priority_points: recebeu 1 e não abriu → −10", () => {
  assert.equal(
    computePriorityPoints({ priority_optin: false, opens_count: 0, sends_count: 1 }),
    -10,
  );
});

test("priority_points: 3 abertos de 3 enviados → 60", () => {
  assert.equal(
    computePriorityPoints({ priority_optin: false, opens_count: 3, sends_count: 3 }),
    60,
  );
});

test("priority_points: 1 aberto de 3 enviados (2 não abertos) → 0", () => {
  assert.equal(
    computePriorityPoints({ priority_optin: false, opens_count: 1, sends_count: 3 }),
    0,
  );
});

test("priority_points: optin + engajamento somam (40 + 20×2 − 10×1) → 70", () => {
  assert.equal(
    computePriorityPoints({ priority_optin: true, opens_count: 2, sends_count: 3 }),
    70,
  );
});

test("priority_points: opens > sends não gera penalidade negativa espúria", () => {
  // defensivo: dados inconsistentes (opens>sends) não viram -10 por clamp
  assert.equal(
    computePriorityPoints({ priority_optin: false, opens_count: 5, sends_count: 3 }),
    100,
  );
});

// ---------------------------------------------------------------------------
// classifyEligibility (#2647) — ordem de prioridade das razões
// ---------------------------------------------------------------------------

const CLEAN = {
  email_blacklisted: false,
  unsubscribed: false,
  hard_bounced: false,
  complained: false,
  mv_bucket: "verified",
  dispute_losses: 0,
  soft_bounce_count: 0,
  tier: 2,
};

test("eligibility: tudo limpo → elegível, sem razão", () => {
  assert.deepEqual(classifyEligibility(CLEAN), {
    send_eligible: true,
    ineligible_reason: null,
  });
});

test("eligibility: unsubscribed → inelegível", () => {
  const r = classifyEligibility({ ...CLEAN, unsubscribed: true });
  assert.equal(r.send_eligible, false);
  assert.equal(r.ineligible_reason, "unsubscribed");
});

test("eligibility: emailBlacklisted reporta razão 'unsubscribed'", () => {
  const r = classifyEligibility({ ...CLEAN, email_blacklisted: true });
  assert.equal(r.ineligible_reason, "unsubscribed");
});

test("eligibility: hard_bounce", () => {
  assert.equal(
    classifyEligibility({ ...CLEAN, hard_bounced: true }).ineligible_reason,
    "hard_bounce",
  );
});

test("eligibility: complaint", () => {
  assert.equal(
    classifyEligibility({ ...CLEAN, complained: true }).ineligible_reason,
    "complaint",
  );
});

test("eligibility: mv_bucket rejected → mv_rejected", () => {
  assert.equal(
    classifyEligibility({ ...CLEAN, mv_bucket: "rejected" }).ineligible_reason,
    "mv_rejected",
  );
});

test("eligibility: mv_bucket unknown → inelegível com razão mv_unknown (#2735, checado antes de mv_unverified)", () => {
  const r = classifyEligibility({ ...CLEAN, mv_bucket: "unknown" });
  assert.equal(r.send_eligible, false);
  assert.equal(r.ineligible_reason, "mv_unknown");
});

test("eligibility: mv_bucket verified (mv_result=ok) continua elegível (#2735, sem regressão)", () => {
  const r = classifyEligibility({ ...CLEAN, mv_bucket: "verified" });
  assert.equal(r.send_eligible, true);
  assert.equal(r.ineligible_reason, null);
});

test("eligibility: tier=1 + mv_bucket null (nunca submetido ao MV) continua elegível — isento de mv_unverified", () => {
  const r = classifyEligibility({ ...CLEAN, tier: 1, mv_bucket: null });
  assert.equal(r.send_eligible, true);
  assert.equal(r.ineligible_reason, null);
});

test("eligibility: tier != 1 com mv_bucket null (nunca verificado) → mv_unverified (#2656)", () => {
  const r = classifyEligibility({ ...CLEAN, mv_bucket: null });
  assert.equal(r.send_eligible, false);
  assert.equal(r.ineligible_reason, "mv_unverified");
});

test("eligibility: tier null (sem tier) também exige MV verified", () => {
  const r = classifyEligibility({ ...CLEAN, tier: null, mv_bucket: null });
  assert.equal(r.send_eligible, false);
  assert.equal(r.ineligible_reason, "mv_unverified");
});

test("eligibility: tier=1 NÃO é isento de mv_bucket='rejected' (só de mv_unverified) — vida anterior como lead rejeitado no MV", () => {
  const r = classifyEligibility({ ...CLEAN, tier: 1, mv_bucket: "rejected" });
  assert.equal(r.send_eligible, false);
  assert.equal(r.ineligible_reason, "mv_rejected");
});

test("eligibility: dispute_losses > 0 → dispute", () => {
  assert.equal(
    classifyEligibility({ ...CLEAN, dispute_losses: 12.5 }).ineligible_reason,
    "dispute",
  );
});

test(`eligibility: soft bounce < ${SOFT_BOUNCE_LIMIT} ainda elegível`, () => {
  const r = classifyEligibility({
    ...CLEAN,
    soft_bounce_count: SOFT_BOUNCE_LIMIT - 1,
  });
  assert.equal(r.send_eligible, true);
});

test(`eligibility: soft bounce == ${SOFT_BOUNCE_LIMIT} → soft_bounce`, () => {
  const r = classifyEligibility({
    ...CLEAN,
    soft_bounce_count: SOFT_BOUNCE_LIMIT,
  });
  assert.equal(r.send_eligible, false);
  assert.equal(r.ineligible_reason, "soft_bounce");
});

test("eligibility: ordem — unsubscribed vence hard_bounce quando ambos batem", () => {
  const r = classifyEligibility({
    ...CLEAN,
    unsubscribed: true,
    hard_bounced: true,
  });
  assert.equal(r.ineligible_reason, "unsubscribed");
});

// ---------------------------------------------------------------------------
// recomputeDerived — integração com SQLite in-memory
// ---------------------------------------------------------------------------

test("recomputeDerived: aplica optin + pontos + elegibilidade nas linhas", () => {
  const db = openClariceDb(":memory:");

  // engajado, sem optin: 2 abertos de 2 → 40, elegível
  db.prepare(
    "INSERT INTO clarice_users (email, opens_count, sends_count, mv_bucket) VALUES (?, ?, ?, ?)",
  ).run("ana@x.com", 2, 2, "verified");
  // optante, sem envios → 40
  db.prepare(
    "INSERT INTO clarice_users (email, opens_count, sends_count) VALUES (?, ?, ?)",
  ).run("bea@x.com", 0, 0);
  // descadastrado → inelegível
  db.prepare(
    "INSERT INTO clarice_users (email, unsubscribed, opens_count, sends_count) VALUES (?, 1, ?, ?)",
  ).run("caio@x.com", 0, 1);

  db.prepare("INSERT INTO priority_optin (email, added_at) VALUES (?, ?)").run(
    "bea@x.com",
    "2026-06-27T00:00:00.000Z",
  );

  const n = recomputeDerived(db);
  assert.equal(n, 3);

  const ana = db
    .prepare("SELECT priority_points, send_eligible, priority_optin FROM clarice_users WHERE email = ?")
    .get("ana@x.com") as any;
  assert.equal(ana.priority_points, 40);
  assert.equal(ana.send_eligible, 1);
  assert.equal(ana.priority_optin, 0);

  const bea = db
    .prepare("SELECT priority_points, priority_optin FROM clarice_users WHERE email = ?")
    .get("bea@x.com") as any;
  assert.equal(bea.priority_points, 40);
  assert.equal(bea.priority_optin, 1);

  const caio = db
    .prepare("SELECT send_eligible, ineligible_reason, priority_points FROM clarice_users WHERE email = ?")
    .get("caio@x.com") as any;
  assert.equal(caio.send_eligible, 0);
  assert.equal(caio.ineligible_reason, "unsubscribed");
  // pontos são computados mesmo pra inelegíveis (auditoria): recebeu 1, não abriu → −10
  assert.equal(caio.priority_points, -10);

  db.close();
});

test("recomputeDerived: mv_bucket=unknown vira send_eligible=0 + ineligible_reason=mv_unknown (#2735)", () => {
  const db = openClariceDb(":memory:");

  db.prepare(
    "INSERT INTO clarice_users (email, opens_count, sends_count, mv_bucket) VALUES (?, ?, ?, ?)",
  ).run("duda@x.com", 0, 0, "unknown");

  recomputeDerived(db);

  const duda = db
    .prepare(
      "SELECT send_eligible, ineligible_reason FROM clarice_users WHERE email = ?",
    )
    .get("duda@x.com") as any;
  assert.equal(duda.send_eligible, 0);
  assert.equal(duda.ineligible_reason, "mv_unknown");

  // registro fica no store (não é apagado) — só o flag muda, pra permitir
  // reabilitação numa re-verificação futura (decisão da issue #2735).
  const total = db.prepare("SELECT COUNT(*) n FROM clarice_users").get() as {
    n: number;
  };
  assert.equal(total.n, 1);

  db.close();
});

test("recomputeDerived: mv_unverified via round-trip SQL real (#2656) — tier passa pela SELECT/UPDATE, não só a função pura", () => {
  const db = openClariceDb(":memory:");

  // tier 3, nunca verificado (mv_bucket NULL) → mv_unverified
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES (?, 3)").run("nv@x.com");
  // tier 3, verificado → elegível
  db.prepare("INSERT INTO clarice_users (email, tier, mv_bucket) VALUES (?, 3, 'verified')").run("v@x.com");
  // tier 1 (T1), nunca verificado → elegível mesmo assim (isento)
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES (?, 1)").run("t1@x.com");
  // sem tier (NULL), nunca verificado → mv_unverified também
  db.prepare("INSERT INTO clarice_users (email) VALUES (?)").run("semtier@x.com");

  recomputeDerived(db);

  const get = (email: string) =>
    db.prepare("SELECT send_eligible, ineligible_reason FROM clarice_users WHERE email = ?").get(email) as any;

  const nv = get("nv@x.com");
  assert.equal(nv.send_eligible, 0);
  assert.equal(nv.ineligible_reason, "mv_unverified");

  const v = get("v@x.com");
  assert.equal(v.send_eligible, 1);
  assert.equal(v.ineligible_reason, null);

  const t1 = get("t1@x.com");
  assert.equal(t1.send_eligible, 1);
  assert.equal(t1.ineligible_reason, null);

  const semtier = get("semtier@x.com");
  assert.equal(semtier.send_eligible, 0);
  assert.equal(semtier.ineligible_reason, "mv_unverified");

  db.close();
});
