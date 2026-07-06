/**
 * test/clarice-build-segment.test.ts (#2885)
 *
 * Regressão pro CLI `clarice-build-segment.ts` — grupos de envio NOMEADOS
 * derivados do store (engajados/reativacao/ramp-warm). Os predicados/ordem em
 * si (entra/sai por condição, ordenação, internos) são testados em
 * `test/clarice-segment.test.ts` — aqui cobrimos a MONTAGEM do artefato
 * (CSV+manifest, corte por --budget) e a integração ponta-a-ponta com o store
 * SQLite via `main()`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Papa from "papaparse";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildSegmentArtifact, main, type SegmentRow } from "../scripts/clarice-build-segment.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";
import { cohortFromTier, INTERNAL_EMAILS } from "../scripts/lib/cohorts.ts";

function row(p: Partial<SegmentRow> & { email: string }): SegmentRow {
  const tier = p.tier ?? null;
  return {
    name: "Fulano Sobrenome",
    tier,
    cohort: cohortFromTier(tier),
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    opens_count: 0,
    last_sent_at: null,
    mv_bucket: null,
    ...p,
  };
}

function emailsOf(csv: string): string[] {
  return (Papa.parse(csv, { header: true, skipEmptyLines: true }).data as any[]).map((r) => r.email);
}

// ---------------------------------------------------------------------------
// buildSegmentArtifact — puro
// ---------------------------------------------------------------------------

test("buildSegmentArtifact: grupo 'engajados' filtra+ordena+monta CSV email,NOME", () => {
  const rows: SegmentRow[] = [
    row({ email: "b@x.com", sends_count: 2, priority_points: 20, name: "Beatriz Silva" }),
    row({ email: "a@x.com", sends_count: 3, priority_points: 60, name: "Ana Costa" }),
    row({ email: "fresh@x.com", sends_count: 0, priority_points: 999 }), // não é engajados
  ];
  const { csv, manifestEntry } = buildSegmentArtifact(rows, "engajados", 0);
  assert.equal(manifestEntry.key, "engajados");
  assert.equal(manifestEntry.file, "engajados.csv");
  assert.equal(manifestEntry.count, 2);
  assert.deepEqual(emailsOf(csv), ["a@x.com", "b@x.com"]); // priority_points DESC
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true }).data as any[];
  assert.equal(parsed[0].NOME, "Ana"); // 1º nome
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["NOME", "email"]); // shape email,NOME
});

test("buildSegmentArtifact: --budget corta o TOPO pós-ordenação (não fatia arbitrária)", () => {
  const rows: SegmentRow[] = [
    row({ email: "c@x.com", sends_count: 2, priority_points: 10 }),
    row({ email: "a@x.com", sends_count: 2, priority_points: 90 }),
    row({ email: "b@x.com", sends_count: 2, priority_points: 50 }),
  ];
  const { manifestEntry, csv } = buildSegmentArtifact(rows, "engajados", 2);
  assert.equal(manifestEntry.count, 2);
  assert.deepEqual(emailsOf(csv), ["a@x.com", "b@x.com"]); // topo: 90, 50 — nunca "c" (10, o mais frio)
});

test("buildSegmentArtifact: budget=0 (omitido) não corta — grupo inteiro", () => {
  const rows: SegmentRow[] = [
    row({ email: "a@x.com", sends_count: 2, priority_points: 10 }),
    row({ email: "b@x.com", sends_count: 2, priority_points: 20 }),
    row({ email: "c@x.com", sends_count: 2, priority_points: 30 }),
  ];
  const { manifestEntry } = buildSegmentArtifact(rows, "engajados", 0);
  assert.equal(manifestEntry.count, 3);
});

test("buildSegmentArtifact: grupo 'reativacao' — CSV reflete a ordem last_sent_at DESC", () => {
  const rows: SegmentRow[] = [
    row({ email: "old@x.com", sends_count: 1, opens_count: 0, last_sent_at: "2026-01-01T00:00:00Z" }),
    row({ email: "new@x.com", sends_count: 1, opens_count: 0, last_sent_at: "2026-06-01T00:00:00Z" }),
    row({ email: "abriu@x.com", sends_count: 1, opens_count: 2, last_sent_at: "2026-12-01T00:00:00Z" }), // fora
  ];
  const { csv, manifestEntry } = buildSegmentArtifact(rows, "reativacao", 0);
  assert.equal(manifestEntry.count, 2);
  assert.deepEqual(emailsOf(csv), ["new@x.com", "old@x.com"]);
});

test("buildSegmentArtifact: grupo 'ramp-warm' — só mv_bucket='verified' e nunca-enviado", () => {
  const rows: SegmentRow[] = [
    row({ email: "warm@x.com", sends_count: 0, tier: 1, mv_bucket: "verified" }),
    row({ email: "cold@x.com", sends_count: 0, tier: 8, mv_bucket: "verified" }),
    row({ email: "naoverificado@x.com", sends_count: 0, tier: 1, mv_bucket: "unknown" }), // fora
    row({ email: "jaenviado@x.com", sends_count: 5, tier: 1, mv_bucket: "verified" }), // fora
  ];
  const { csv, manifestEntry } = buildSegmentArtifact(rows, "ramp-warm", 0);
  assert.equal(manifestEntry.count, 2);
  assert.deepEqual(emailsOf(csv), ["warm@x.com", "cold@x.com"]); // morno (T01) antes de frio (T08)
});

test("buildSegmentArtifact: 1º nome tira vírgula (Azevedo, Ana → Azevedo)", () => {
  const rows: SegmentRow[] = [row({ email: "x@x.com", sends_count: 2, priority_points: 10, name: "Azevedo, Ana" })];
  const { csv } = buildSegmentArtifact(rows, "engajados", 0);
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true }).data as any[];
  assert.equal(parsed[0].NOME, "Azevedo");
});

test("buildSegmentArtifact: internos (#2809) nunca aparecem em 'engajados'/'reativacao'", () => {
  const rows: SegmentRow[] = INTERNAL_EMAILS.map((email) =>
    row({ email, sends_count: 5, priority_points: 999, opens_count: 0, last_sent_at: "2026-06-01T00:00:00Z" }),
  );
  assert.equal(buildSegmentArtifact(rows, "engajados", 0).manifestEntry.count, 0);
  assert.equal(buildSegmentArtifact(rows, "reativacao", 0).manifestEntry.count, 0);
});

test("buildSegmentArtifact: --min-score exclui priority_points abaixo do piso ANTES do budget (#2973)", () => {
  const rows: SegmentRow[] = [
    row({ email: "a@x.com", sends_count: 2, priority_points: 90 }),
    row({ email: "b@x.com", sends_count: 2, priority_points: 50 }),
    row({ email: "c@x.com", sends_count: 2, priority_points: 10 }), // abaixo do piso
  ];
  const { manifestEntry, csv } = buildSegmentArtifact(rows, "engajados", 0, 20);
  assert.equal(manifestEntry.count, 2);
  assert.deepEqual(emailsOf(csv), ["a@x.com", "b@x.com"]); // "c" (10) fica de fora do piso 20
});

test("buildSegmentArtifact: --min-score=0 (omitido) não corta nada — comportamento inalterado", () => {
  const rows: SegmentRow[] = [
    row({ email: "a@x.com", sends_count: 2, priority_points: 90 }),
    row({ email: "c@x.com", sends_count: 2, priority_points: 10 }),
  ];
  const { manifestEntry } = buildSegmentArtifact(rows, "engajados", 0, 0);
  assert.equal(manifestEntry.count, 2);
});

// ---------------------------------------------------------------------------
// main() — integração ponta-a-ponta com o store SQLite
// ---------------------------------------------------------------------------

function captureLogs(fn: () => void): string[] {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return logs;
}

test("main: --dry-run não escreve nada, imprime summary correto", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  // priority_points é recomputado por recomputeDerived (opens_count/sends_count) —
  // não precisa inseri-lo diretamente.
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('eng@x.com','Eng',2,3,3,'verified')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, status, tier, mv_bucket) VALUES ('fresh@x.com','Fresh','active',1,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs = captureLogs(() => {
    main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run"]);
  });
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.cycle, "2606-07");
  assert.equal(out.group, "engajados");
  assert.equal(out.selected, 1); // só eng@x.com (sends_count>0 e priority_points>0)

  const segDir = clariceSegmentsDir("2606-07");
  assert.equal(existsSync(resolve(segDir, "engajados.csv")), false, "dry-run não deve escrever CSV");
});

// NOTA (segue o padrão de test/clarice-build-waves-store.test.ts): os testes
// de `main()` abaixo usam sempre `--dry-run` — `clariceSegmentsDir`/
// `clariceCycleDir` resolvem a partir da raiz FIXA do repo (não injetável),
// então escrever de fato exercitaria o disco real do editor (`data/`, fora do
// tmpdir de teste). O branch `if (!dryRun)` (escrita real) e o SHAPE do
// CSV/manifest já são cobertos pelos testes puros de `buildSegmentArtifact`
// acima — aqui só validamos a integração main()+store+summary.

test("main: --budget corta o grupo antes de escrever", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-budget-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  // priority_points é RECOMPUTADO por recomputeDerived a partir de
  // opens_count/sends_count (computePriorityPoints, +20/abertura -10/não-aberto)
  // — não adianta inserir o literal direto, precisa dos counts corretos pra
  // obter 3 valores positivos e distintos (100 > 60 > 20).
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('a@x.com','A',2,5,5,'verified')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('b@x.com','B',2,3,3,'verified')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('c@x.com','C',2,1,1,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs = captureLogs(() => {
    main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--budget", "2", "--dry-run"]);
  });
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 2);
  assert.equal(out.budget, 2);
});

test("main: --score é alias de --min-score (#2973) — CLI aceita o vocabulário do editor", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-score-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('a@x.com','A',2,5,5,'verified')",
  ).run(); // priority_points alto
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('b@x.com','B',2,1,1,'verified')",
  ).run(); // priority_points baixo
  recomputeDerived(db);
  db.close();

  const logs = captureLogs(() => {
    main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--score", "50", "--dry-run"]);
  });
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.min_score, 50);
  assert.equal(out.selected, 1); // só quem bate o piso 50 (a@x.com)
});
