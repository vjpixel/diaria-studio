import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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

test("eligibility: mv_bucket unknown → inelegível com razão mv_unknown (#2735)", () => {
  const r = classifyEligibility({ ...CLEAN, mv_bucket: "unknown" });
  assert.equal(r.send_eligible, false);
  assert.equal(r.ineligible_reason, "mv_unknown");
});

test("eligibility: mv_bucket verified (mv_result=ok) continua elegível (#2735, sem regressão)", () => {
  const r = classifyEligibility({ ...CLEAN, mv_bucket: "verified" });
  assert.equal(r.send_eligible, true);
  assert.equal(r.ineligible_reason, null);
});

test("eligibility: mv_bucket null (nunca submetido ao MV) → elegível pra todos os tiers (#2804, reverte #2656)", () => {
  const r = classifyEligibility({ ...CLEAN, mv_bucket: null });
  assert.equal(r.send_eligible, true);
  assert.equal(r.ineligible_reason, null);
});

test("eligibility: mv_bucket undefined (nunca submetido ao MV) → elegível pra todos os tiers (#2804)", () => {
  const r = classifyEligibility({ ...CLEAN, mv_bucket: undefined });
  assert.equal(r.send_eligible, true);
  assert.equal(r.ineligible_reason, null);
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

test("recomputeDerived: mv_bucket NULL não corta mais nenhum tier via round-trip SQL real (#2804, reverte #2656)", () => {
  const db = openClariceDb(":memory:");

  // tier 3, nunca verificado (mv_bucket NULL) → elegível (era mv_unverified antes de #2804)
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES (?, 3)").run("nv@x.com");
  // tier 3, verificado → elegível (sem regressão)
  db.prepare("INSERT INTO clarice_users (email, tier, mv_bucket) VALUES (?, 3, 'verified')").run("v@x.com");
  // tier 1 (T1), nunca verificado → elegível (já era antes, isenção agora universal)
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES (?, 1)").run("t1@x.com");
  // sem tier (NULL), nunca verificado → elegível também (era mv_unverified antes de #2804)
  db.prepare("INSERT INTO clarice_users (email) VALUES (?)").run("semtier@x.com");
  // tier 1, mv_bucket='rejected' de vida anterior como lead → continua mv_rejected,
  // não isento (ordem de prioridade intacta — checado ANTES de qualquer isenção de tier)
  db.prepare("INSERT INTO clarice_users (email, tier, mv_bucket) VALUES (?, 1, 'rejected')").run("t1rej@x.com");
  // tier 3, mv_bucket='unknown' → continua mv_unknown, sem regressão (#2735)
  db.prepare("INSERT INTO clarice_users (email, tier, mv_bucket) VALUES (?, 3, 'unknown')").run("unk@x.com");

  recomputeDerived(db);

  const get = (email: string) =>
    db.prepare("SELECT send_eligible, ineligible_reason FROM clarice_users WHERE email = ?").get(email) as any;

  const nv = get("nv@x.com");
  assert.equal(nv.send_eligible, 1);
  assert.equal(nv.ineligible_reason, null);

  const v = get("v@x.com");
  assert.equal(v.send_eligible, 1);
  assert.equal(v.ineligible_reason, null);

  const t1 = get("t1@x.com");
  assert.equal(t1.send_eligible, 1);
  assert.equal(t1.ineligible_reason, null);

  const semtier = get("semtier@x.com");
  assert.equal(semtier.send_eligible, 1);
  assert.equal(semtier.ineligible_reason, null);

  const t1rej = get("t1rej@x.com");
  assert.equal(t1rej.send_eligible, 0);
  assert.equal(t1rej.ineligible_reason, "mv_rejected");

  const unk = get("unk@x.com");
  assert.equal(unk.send_eligible, 0);
  assert.equal(unk.ineligible_reason, "mv_unknown");

  db.close();
});

// ---------------------------------------------------------------------------
// cohort (#2817) — derivação em recomputeDerived + migração idempotente
// ---------------------------------------------------------------------------

test("recomputeDerived: deriva cohort a partir de created (maio/junho/julho/fora-do-range)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, created) VALUES (?, ?)").run("mai@x.com", "2026-05-10T00:00:00.000Z");
  db.prepare("INSERT INTO clarice_users (email, created) VALUES (?, ?)").run("jun@x.com", "2026-06-20T00:00:00.000Z");
  db.prepare("INSERT INTO clarice_users (email, created) VALUES (?, ?)").run("jul@x.com", "2026-07-01T00:00:00.000Z");
  db.prepare("INSERT INTO clarice_users (email, created) VALUES (?, ?)").run("velho@x.com", "2025-12-25T00:00:00.000Z");
  db.prepare("INSERT INTO clarice_users (email) VALUES (?)").run("semcreated@x.com");

  recomputeDerived(db);

  const cohortOf = (email: string) =>
    (db.prepare("SELECT cohort FROM clarice_users WHERE email = ?").get(email) as any).cohort;

  assert.equal(cohortOf("mai@x.com"), "2026-05");
  assert.equal(cohortOf("jun@x.com"), "2026-06");
  assert.equal(cohortOf("jul@x.com"), "2026-07");
  assert.equal(cohortOf("velho@x.com"), null, "anterior a 2026-05 → NULL (sem safra rotulada)");
  assert.equal(cohortOf("semcreated@x.com"), null, "created ausente → NULL");

  db.close();
});

test("recomputeDerived: cohort é recomputado (não fica stale) numa 2ª rodada após created mudar", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, created) VALUES (?, ?)").run("x@x.com", "2026-05-01T00:00:00.000Z");
  recomputeDerived(db);
  assert.equal(
    (db.prepare("SELECT cohort FROM clarice_users WHERE email='x@x.com'").get() as any).cohort,
    "2026-05",
  );

  db.prepare("UPDATE clarice_users SET created = ? WHERE email = 'x@x.com'").run("2026-06-01T00:00:00.000Z");
  recomputeDerived(db);
  assert.equal(
    (db.prepare("SELECT cohort FROM clarice_users WHERE email='x@x.com'").get() as any).cohort,
    "2026-06",
  );

  db.close();
});

test("openClariceDb: migração de cohort é idempotente pra store pré-existente (roda 2x sem perder dados)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "clarice-cohort-migration-"));
  const dbPath = resolve(dir, "legacy.db");

  // Simula um store LEGADO criado ANTES da coluna `cohort` existir: cria a
  // tabela manualmente sem a coluna (schema pré-#2817) e insere uma linha.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE clarice_users (
      email TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      created TEXT,
      tier INTEGER,
      priority_points INTEGER DEFAULT 0,
      send_eligible INTEGER DEFAULT 1,
      ineligible_reason TEXT,
      priority_optin INTEGER DEFAULT 0
    );
  `);
  legacy.prepare("INSERT INTO clarice_users (email, created) VALUES (?, ?)").run(
    "legado@x.com",
    "2026-06-10T00:00:00.000Z",
  );
  legacy.close();

  // 1ª abertura: openClariceDb roda a migração (ALTER TABLE ADD COLUMN cohort).
  const db1 = openClariceDb(dbPath);
  const before = db1.prepare("SELECT email, created FROM clarice_users WHERE email = ?").get("legado@x.com") as any;
  assert.equal(before.email, "legado@x.com", "dado pré-existente preservado após a migração");
  assert.equal(before.created, "2026-06-10T00:00:00.000Z");
  const colsAfter1 = (db1.prepare("PRAGMA table_info(clarice_users)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(colsAfter1.includes("cohort"), "coluna cohort adicionada na 1ª abertura");
  db1.close();

  // 2ª abertura sobre o MESMO arquivo: coluna já existe — migração deve ser
  // no-op (não lançar "duplicate column name") e os dados seguem intactos.
  const db2 = openClariceDb(dbPath);
  const after = db2.prepare("SELECT email, created FROM clarice_users WHERE email = ?").get("legado@x.com") as any;
  assert.equal(after.email, "legado@x.com", "dado sobrevive à 2ª migração (no-op)");
  const total = (db2.prepare("SELECT COUNT(*) n FROM clarice_users").get() as any).n;
  assert.equal(total, 1, "nenhuma linha duplicada/perdida entre as 2 aberturas");
  db2.close();
});
