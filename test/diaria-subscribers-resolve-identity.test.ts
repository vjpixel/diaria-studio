import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main as resolveIdentityMain } from "../scripts/diaria-subscribers-resolve-identity.ts";
import {
  openDiariaSubscribersDb,
  ensureSubscriber,
  getStoreCounts,
} from "../scripts/lib/diaria-subscribers-db.ts";

function tmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

/** Captura stdout de uma chamada síncrona a `main()` — mesmo padrão usado
 *  pelos outros testes de CLI do repo que verificam o JSON impresso. */
function captureStdout(fn: () => void): string {
  const orig = console.log;
  let out = "";
  console.log = (msg?: unknown) => {
    out += String(msg);
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

function seedTwoPlatformsSameEmail(dbPath: string): void {
  const seed = openDiariaSubscribersDb(dbPath);
  ensureSubscriber(seed, "beehiiv", "bh-1", "leitor@example.com", "2026-09-01T00:00:00.000Z");
  ensureSubscriber(seed, "kit", null, "leitor@example.com", "2026-09-01T00:00:00.000Z");
  ensureSubscriber(seed, "kit", null, "so-kit@example.com", "2026-09-01T00:00:00.000Z");
  seed.close();
}

// ---------------------------------------------------------------------------
// Default (sem --apply): dry-run, NUNCA escreve (#7205)
// ---------------------------------------------------------------------------

test("diaria-subscribers-resolve-identity main(): default é dry-run — imprime o plano, NÃO funde o store real", () => {
  const dataRoot = tmp("dsri-dryrun-");
  const dbDir = resolve(dataRoot, "diaria-subscribers");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = resolve(dbDir, "diaria-subscribers.db");
  seedTwoPlatformsSameEmail(dbPath);

  const output = captureStdout(() => resolveIdentityMain(["--db", dbPath]));
  const payload = JSON.parse(output);

  assert.equal(payload.mode, "dry-run");
  assert.equal(payload.plan.subscribers_would_merge, 1);
  assert.equal(payload.plan.email_groups_would_merge, 1);
  assert.match(payload.note, /Nenhuma escrita/);
  assert.match(payload.report_before_merge.note, /PISO/);

  // O store real NÃO foi tocado — ainda 3 subscribers separados.
  const verify = openDiariaSubscribersDb(dbPath);
  assert.equal(getStoreCounts(verify).subscribers, 3);
  verify.close();

  // Nenhum arquivo de backup foi criado em modo dry-run.
  const files = readdirSync(dbDir);
  assert.equal(files.some((f) => f.includes(".backup-")), false);
});

test("diaria-subscribers-resolve-identity main(): dry-run repetido é idempotente (não muda nada entre chamadas)", () => {
  const dataRoot = tmp("dsri-dryrun-idem-");
  const dbDir = resolve(dataRoot, "diaria-subscribers");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = resolve(dbDir, "diaria-subscribers.db");
  seedTwoPlatformsSameEmail(dbPath);

  const first = JSON.parse(captureStdout(() => resolveIdentityMain(["--db", dbPath])));
  const second = JSON.parse(captureStdout(() => resolveIdentityMain(["--db", dbPath])));

  // generated_at varia por chamada (timestamp real) — compara o resto do plano.
  const { generated_at: _a, ...firstRest } = first.plan;
  const { generated_at: _b, ...secondRest } = second.plan;
  assert.deepEqual(firstRest, secondRest);
});

// ---------------------------------------------------------------------------
// --apply: escreve de verdade, faz backup, roda o guard de conservação
// ---------------------------------------------------------------------------

test("diaria-subscribers-resolve-identity main(): --apply funde no store real, cria backup, e o guard de conservação passa", () => {
  const dataRoot = tmp("dsri-apply-");
  const dbDir = resolve(dataRoot, "diaria-subscribers");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = resolve(dbDir, "diaria-subscribers.db");
  seedTwoPlatformsSameEmail(dbPath);

  const output = captureStdout(() => resolveIdentityMain(["--db", dbPath, "--apply"]));
  const payload = JSON.parse(output);

  assert.equal(payload.mode, "apply");
  assert.equal(payload.resolution.subscribers_merged, 1);
  assert.equal(payload.report.matched_subscribers, 1);
  assert.equal(payload.report.unmatched_subscribers, 1);
  assert.match(payload.report.note, /PISO/);

  assert.equal(payload.conservation.ok, true);
  assert.equal(
    payload.conservation.identity_aliases_before,
    payload.conservation.identity_aliases_after,
  );
  assert.equal(payload.conservation.events_before, payload.conservation.events_after);

  // Backup existe de verdade em disco, ao lado do original.
  assert.equal(typeof payload.backup, "string");
  assert.equal(existsSync(payload.backup), true);
  assert.equal(payload.backup.startsWith(dbPath), true);

  // O merge realmente persistiu no arquivo (não só no summary).
  const verify = openDiariaSubscribersDb(dbPath);
  assert.equal(getStoreCounts(verify).subscribers, 2); // 1 fundido + 1 não-casado
  verify.close();
});

test("diaria-subscribers-resolve-identity main(): --apply sem merge nenhum (nada casa) ainda faz backup e reporta conservação ok", () => {
  const dataRoot = tmp("dsri-apply-nomerge-");
  const dbDir = resolve(dataRoot, "diaria-subscribers");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = resolve(dbDir, "diaria-subscribers.db");
  const seed = openDiariaSubscribersDb(dbPath);
  ensureSubscriber(seed, "beehiiv", "bh-1", "a@example.com", "2026-09-01T00:00:00.000Z");
  ensureSubscriber(seed, "kit", null, "b@example.com", "2026-09-01T00:00:00.000Z");
  seed.close();

  const payload = JSON.parse(captureStdout(() => resolveIdentityMain(["--db", dbPath, "--apply"])));

  assert.equal(payload.resolution.subscribers_merged, 0);
  assert.equal(payload.conservation.ok, true);
  assert.equal(existsSync(payload.backup), true);
});

// ---------------------------------------------------------------------------
// Ausência de store/data — inalterado pelo #7205
// ---------------------------------------------------------------------------

test("diaria-subscribers-resolve-identity main(): store ainda não existe → exit 1 com mensagem clara, nunca lança", () => {
  const dataRoot = tmp("dsri-empty-");
  const dbPath = resolve(dataRoot, "diaria-subscribers", "diaria-subscribers.db");

  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    assert.doesNotThrow(() => resolveIdentityMain(["--db", dbPath]));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("diaria-subscribers-resolve-identity main(): data/ (raiz) ausente → exit 1 com mensagem clara, nunca lança", () => {
  const bogusDataRoot = resolve(tmpdir(), `dsri-no-data-root-${Date.now()}`);
  const dbPath = resolve(bogusDataRoot, "diaria-subscribers", "diaria-subscribers.db");

  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    assert.doesNotThrow(() => resolveIdentityMain(["--db", dbPath]));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = savedExitCode;
  }
});
