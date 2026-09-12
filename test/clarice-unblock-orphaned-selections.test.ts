import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { collectCurrentlyReferencedEmails, main } from "../scripts/clarice-unblock-orphaned-selections.ts";
import { appendSentOrQueuedEmails, sentOrQueuedFilePath, type SentOrQueuedFile } from "../scripts/clarice-build-segment.ts";
import { acquireEnvioLock, lockPathForCycle } from "../scripts/lib/clarice-envio-lock.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";

const CYCLE = "2608-09";

// #8038 — collectCurrentlyReferencedEmails: universo de "quem ainda está em
// alguma onda viva do ciclo" (todo *.csv do diretório de segments).

test("collectCurrentlyReferencedEmails: une o email (1ª coluna) de todos os CSVs do diretório", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-"));
  writeFileSync(resolve(dir, "daily.csv"), "email,NOME\na@x.com,A\nb@x.com,B\n", "utf8");
  writeFileSync(resolve(dir, "novos.csv"), "email,NOME\nc@x.com,C\n", "utf8");
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out].sort(), ["a@x.com", "b@x.com", "c@x.com"]);
});

test("collectCurrentlyReferencedEmails: normaliza pra lowercase, ignora colunas além do email", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-norm-"));
  writeFileSync(resolve(dir, "engajados-priority-snapshot.csv"), "email,priority_points,cohort,priority_optin\nA@X.com,20,ex-assinantes,0\n", "utf8");
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out], ["a@x.com"]);
});

test("collectCurrentlyReferencedEmails: diretório ausente -> Set vazio, não lança", () => {
  const dir = resolve(tmpdir(), "unblock-collect-does-not-exist-" + Date.now());
  assert.deepEqual(collectCurrentlyReferencedEmails(dir), new Set());
});

test("collectCurrentlyReferencedEmails: arquivos não-CSV no diretório são ignorados", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-noncsv-"));
  writeFileSync(resolve(dir, "daily.csv"), "email\na@x.com\n", "utf8");
  writeFileSync(resolve(dir, "sent-or-queued.json"), '{"cycle":"x","emails":[],"history":[]}', "utf8");
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out], ["a@x.com"]);
});

test("collectCurrentlyReferencedEmails: subdiretório aninhado (ex: .mv-cache) não quebra a varredura — só lê arquivos, não recursa", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-subdir-"));
  writeFileSync(resolve(dir, "daily.csv"), "email\na@x.com\n", "utf8");
  mkdirSync(resolve(dir, "subpasta"));
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out], ["a@x.com"]);
});

// ---------------------------------------------------------------------------
// main() — CLI fim-a-fim (dry-run, --apply, lock), mesma técnica de
// withMockedExit de test/clarice-build-segment.test.ts.
// ---------------------------------------------------------------------------

async function withMockedExit<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T | undefined; exitCode: number | undefined; errors: string[] }> {
  const origExit = process.exit;
  const origErr = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  let exitCode: number | undefined;
  process.exit = (code?: number) => {
    exitCode = code;
    throw Object.assign(new Error(`__mock_exit__:${code}`), { __mockExit: true });
  };
  let result: T | undefined;
  try {
    result = await fn();
  } catch (e) {
    if (!(e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit)) throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
  return { result, exitCode, errors };
}

test("main: --cycle ausente -> aborta (exit 1), não lança", async () => {
  const { exitCode } = await withMockedExit(() => main([]));
  assert.equal(exitCode, 1);
});

test("main --apply: desbloqueia órfãos de verdade e adquire/libera o lock (isolado via --lock-root-dir)", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-main-seg-"));
  const segDir = clariceSegmentsDir(CYCLE, baseDir);
  mkdirSync(segDir, { recursive: true });
  const lockRoot = mkdtempSync(resolve(tmpdir(), "unblock-main-lock-"));
  appendSentOrQueuedEmails(segDir, CYCLE, "engajados", ["orfao@x.com", "vivo@x.com"]);
  writeFileSync(resolve(segDir, "daily.csv"), "email\nvivo@x.com\n", "utf8"); // vivo@x.com ainda numa onda real

  await main(["--cycle", CYCLE, "--base-dir", baseDir, "--lock-root-dir", lockRoot, "--apply"]);

  const parsed = JSON.parse(readFileSync(sentOrQueuedFilePath(segDir), "utf8")) as SentOrQueuedFile;
  assert.deepEqual(parsed.emails, ["vivo@x.com"], "só o órfão sai; quem ainda está numa onda real permanece");

  // Lock foi liberado ao final — uma 2ª chamada consegue adquirir de novo.
  const lockPath = lockPathForCycle(lockRoot, CYCLE);
  assert.ok(!existsSync(lockPath), "lock liberado após a operação");
});

test("main --apply: lock JÁ SEGURO por outro processo -> aborta sem tocar sent-or-queued.json (exit 1)", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-main-heldlock-seg-"));
  const segDir = clariceSegmentsDir(CYCLE, baseDir);
  mkdirSync(segDir, { recursive: true });
  const lockRoot = mkdtempSync(resolve(tmpdir(), "unblock-main-heldlock-lock-"));
  appendSentOrQueuedEmails(segDir, CYCLE, "engajados", ["orfao@x.com"]);
  const before = readFileSync(sentOrQueuedFilePath(segDir), "utf8");

  acquireEnvioLock(lockRoot, CYCLE, "outra-sessao-simulada", new Date());

  const { exitCode, errors } = await withMockedExit(() =>
    main(["--cycle", CYCLE, "--base-dir", baseDir, "--lock-root-dir", lockRoot, "--apply"]),
  );
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes("outra-sessao-simulada")), "mensagem nomeia quem segura o lock");
  assert.equal(readFileSync(sentOrQueuedFilePath(segDir), "utf8"), before, "sent-or-queued.json intocado — lock bloqueou ANTES da escrita");
});

test("main --dry-run: NÃO adquire lock (só leitura) — não interfere com uma rodada real em curso", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-main-dryrun-seg-"));
  const segDir = clariceSegmentsDir(CYCLE, baseDir);
  mkdirSync(segDir, { recursive: true });
  const lockRoot = mkdtempSync(resolve(tmpdir(), "unblock-main-dryrun-lock-"));
  appendSentOrQueuedEmails(segDir, CYCLE, "engajados", ["orfao@x.com"]);
  acquireEnvioLock(lockRoot, CYCLE, "rodada-real-em-curso", new Date()); // lock JÁ seguro

  // dry-run (sem --apply) não deve tentar adquirir o lock, então não deve lançar/abortar.
  await main(["--cycle", CYCLE, "--base-dir", baseDir, "--lock-root-dir", lockRoot]);

  const parsed = JSON.parse(readFileSync(sentOrQueuedFilePath(segDir), "utf8")) as SentOrQueuedFile;
  assert.deepEqual(parsed.emails, ["orfao@x.com"], "dry-run não escreve, mesmo com lock livre/seguro");
});
