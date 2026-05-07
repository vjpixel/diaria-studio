/**
 * sorteio-process-batch.test.ts (#929)
 *
 * Testa o sub-comando `batch-add` do CLI `sorteio-process.ts`. Foca em:
 *   - approve aplica entry + retorna number + reply_text
 *   - reject/skip não escrevem entry mas retornam status
 *   - duplicate via thread_id já em entries não rejeita batch (status: duplicate)
 *   - validation: missing fields, invalid month, action desconhecida
 *   - idempotência: re-rodar a mesma decisions.json não duplica entries
 *
 * Test isolation: env var `CONTEST_ENTRIES_PATH` aponta pra arquivo tmp
 * por teste. CLI roda com cwd=ROOT (resolução de tsx) mas escreve em
 * `process.env.CONTEST_ENTRIES_PATH` (relativo a cwd via `resolve()` —
 * passamos absoluto pra evitar ambiguidade).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts/sorteio-process.ts");

interface BatchOutput {
  summary: {
    total: number;
    approved: number;
    rejected: number;
    skipped: number;
    duplicate: number;
    error: number;
  };
  results: Array<{
    thread_id: string;
    status: string;
    number?: number;
    reply_text?: string;
    reason?: string;
  }>;
}

let tmpDir: string;
let entriesPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sorteio-batch-test-"));
  entriesPath = join(tmpDir, "contest-entries.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runBatch(decisions: unknown[], extraArgs: string[] = []): BatchOutput {
  const decisionsPath = join(tmpDir, "decisions.json");
  writeFileSync(decisionsPath, JSON.stringify(decisions), "utf8");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      SCRIPT,
      "batch-add",
      "--decisions",
      decisionsPath,
      ...extraArgs,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, CONTEST_ENTRIES_PATH: entriesPath },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `batch-add exited ${result.status}: stderr=${result.stderr}, stdout=${result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as BatchOutput;
}

describe("sorteio-process batch-add (#929)", () => {
  it("approve grava entry + retorna number + reply_text", () => {
    const out = runBatch([
      {
        thread_id: "t1",
        action: "approve",
        month: "2026-06",
        email: "leitor@example.com",
        name: "Maria Silva",
        edition: "260505",
        error_type: "version_inconsistency",
        detail: "V4 vs V5",
      },
    ]);
    assert.equal(out.summary.approved, 1);
    assert.equal(out.results[0].status, "approved");
    assert.equal(out.results[0].number, 1);
    assert.match(out.results[0].reply_text!, /Maria/);
    assert.match(out.results[0].reply_text!, /é 1\b/);
    // Entry persistida
    const jsonl = readFileSync(entriesPath, "utf8");
    assert.match(jsonl, /Maria Silva/);
  });

  it("reject não escreve entry", () => {
    const out = runBatch([{ thread_id: "t-rejected", action: "reject" }]);
    assert.equal(out.summary.rejected, 1);
    assert.equal(out.results[0].status, "rejected");
    assert.equal(existsSync(entriesPath), false);
  });

  it("skip não escreve entry mas registra status", () => {
    const out = runBatch([{ thread_id: "t-skip", action: "skip" }]);
    assert.equal(out.summary.skipped, 1);
    assert.equal(out.results[0].status, "skipped");
  });

  it("duplicate detectado via thread_id existente", () => {
    runBatch([
      {
        thread_id: "t-dup",
        action: "approve",
        month: "2026-06",
        email: "x@example.com",
        name: "X",
        edition: "260505",
        error_type: "factual",
        detail: "...",
      },
    ]);
    const out = runBatch([
      {
        thread_id: "t-dup",
        action: "approve",
        month: "2026-06",
        email: "x@example.com",
        name: "X",
        edition: "260505",
        error_type: "factual",
        detail: "...",
      },
    ]);
    assert.equal(out.summary.duplicate, 1);
    assert.equal(out.results[0].status, "duplicate");
    assert.equal(out.results[0].number, 1);
  });

  it("missing fields → status: error com reason", () => {
    const out = runBatch([{ thread_id: "t-bad", action: "approve" }]);
    assert.equal(out.summary.error, 1);
    assert.equal(out.results[0].status, "error");
    assert.match(out.results[0].reason!, /flags faltando/);
  });

  it("month inválido → status: error", () => {
    const out = runBatch([
      {
        thread_id: "t-bad-month",
        action: "approve",
        month: "junho-2026",
        email: "x@x.com",
        name: "X",
        edition: "260505",
        error_type: "factual",
        detail: "...",
      },
    ]);
    assert.equal(out.summary.error, 1);
    assert.equal(out.results[0].status, "error");
    assert.match(out.results[0].reason!, /month inv[áa]lido/);
  });

  it("action desconhecida → status: error", () => {
    const out = runBatch([
      { thread_id: "t-action", action: "deny" } as unknown,
    ]);
    assert.equal(out.summary.error, 1);
    assert.match(out.results[0].reason!, /action desconhecida/);
  });

  it("processa batch misto (approve + reject + skip + duplicate)", () => {
    runBatch([
      {
        thread_id: "t-existing",
        action: "approve",
        month: "2026-06",
        email: "e@x.com",
        name: "E",
        edition: "260505",
        error_type: "factual",
        detail: "...",
      },
    ]);
    const out = runBatch([
      {
        thread_id: "t-existing",
        action: "approve",
        month: "2026-06",
        email: "e@x.com",
        name: "E",
        edition: "260505",
        error_type: "factual",
        detail: "...",
      },
      {
        thread_id: "t-new",
        action: "approve",
        month: "2026-06",
        email: "n@x.com",
        name: "Nova",
        edition: "260506",
        error_type: "math",
        detail: "...",
      },
      { thread_id: "t-rej", action: "reject" },
      { thread_id: "t-skip", action: "skip" },
    ]);
    assert.equal(out.summary.total, 4);
    assert.equal(out.summary.approved, 1);
    assert.equal(out.summary.rejected, 1);
    assert.equal(out.summary.skipped, 1);
    assert.equal(out.summary.duplicate, 1);
    const novo = out.results.find((r) => r.thread_id === "t-new");
    assert.equal(novo?.number, 2);
  });

  it("--output grava JSON em arquivo separado", () => {
    const outputPath = join(tmpDir, "results.json");
    runBatch([{ thread_id: "t-out", action: "skip" }], ["--output", outputPath]);
    assert.ok(existsSync(outputPath));
    const written = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(written.summary.skipped, 1);
  });
});
