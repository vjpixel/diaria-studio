import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
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

test("diaria-subscribers-resolve-identity main(): funde no store real (arquivo em disco) e imprime resolução + relatório com a nota de PISO", () => {
  const dataRoot = tmp("dsri-data-");
  const dbDir = resolve(dataRoot, "diaria-subscribers");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = resolve(dbDir, "diaria-subscribers.db");

  // Simula o que os builders Kit/Brevo já teriam escrito antes desta CLI rodar.
  const seed = openDiariaSubscribersDb(dbPath);
  ensureSubscriber(seed, "beehiiv", "bh-1", "leitor@example.com", "2026-09-01T00:00:00.000Z");
  ensureSubscriber(seed, "kit", null, "leitor@example.com", "2026-09-01T00:00:00.000Z");
  ensureSubscriber(seed, "kit", null, "so-kit@example.com", "2026-09-01T00:00:00.000Z");
  seed.close();

  const output = captureStdout(() => resolveIdentityMain(["--db", dbPath]));
  const payload = JSON.parse(output);

  assert.equal(payload.resolution.subscribers_merged, 1);
  assert.equal(payload.report.matched_subscribers, 1);
  assert.equal(payload.report.unmatched_subscribers, 1);
  assert.match(payload.report.note, /PISO/);

  // Confirma que o merge realmente persistiu no arquivo (não só no summary).
  const verify = openDiariaSubscribersDb(dbPath);
  assert.equal(getStoreCounts(verify).subscribers, 2); // 1 fundido + 1 não-casado
  verify.close();
});

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
