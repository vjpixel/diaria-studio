/**
 * Tests for `scripts/lib/env-loader.ts` (#923).
 *
 * Reproduz o cenário 2026-05-07: scripts standalone não carregavam .env.local
 * → process.env.DIARIA_LINKEDIN_CRON_TOKEN ficava undefined → publish-linkedin
 * fazia fallback silencioso pra fire-now em vez de agendar.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { loadProjectEnv } from "../scripts/lib/env-loader.ts";

describe("#923 loadProjectEnv", () => {
  let tmpRoot: string;
  // Salvar e restaurar process.env entre tests
  const SAVED_KEYS = [
    "TEST_ENV_LOADER_LOCAL",
    "TEST_ENV_LOADER_FALLBACK",
    "TEST_ENV_LOADER_PRECEDENCE",
    "TEST_ENV_LOADER_PROCESS_WIN",
  ];
  const saved: Record<string, string | undefined> = {};

  before(() => {
    for (const k of SAVED_KEYS) saved[k] = process.env[k];
  });

  after(() => {
    for (const k of SAVED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("carrega .env.local quando existe", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-1-"));
    writeFileSync(resolve(tmpRoot, ".env.local"), "TEST_ENV_LOADER_LOCAL=hello-local\n");
    delete process.env.TEST_ENV_LOADER_LOCAL;

    const loaded = loadProjectEnv(tmpRoot);
    assert.equal(process.env.TEST_ENV_LOADER_LOCAL, "hello-local");
    assert.ok(loaded.some((p) => p.endsWith(".env.local")));

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("cai para .env quando .env.local ausente", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-2-"));
    writeFileSync(resolve(tmpRoot, ".env"), "TEST_ENV_LOADER_FALLBACK=hello-env\n");
    delete process.env.TEST_ENV_LOADER_FALLBACK;

    const loaded = loadProjectEnv(tmpRoot);
    assert.equal(process.env.TEST_ENV_LOADER_FALLBACK, "hello-env");
    assert.ok(loaded.some((p) => p.endsWith(".env")));

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it(".env.local tem precedência sobre .env (precedência local-over-shared)", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-3-"));
    writeFileSync(resolve(tmpRoot, ".env"), "TEST_ENV_LOADER_PRECEDENCE=from-env\n");
    writeFileSync(resolve(tmpRoot, ".env.local"), "TEST_ENV_LOADER_PRECEDENCE=from-local\n");
    delete process.env.TEST_ENV_LOADER_PRECEDENCE;

    loadProjectEnv(tmpRoot);
    assert.equal(process.env.TEST_ENV_LOADER_PRECEDENCE, "from-local");

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("não sobrescreve var já presente em process.env (real env > .env.local)", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-4-"));
    writeFileSync(
      resolve(tmpRoot, ".env.local"),
      "TEST_ENV_LOADER_PROCESS_WIN=from-file\n",
    );
    process.env.TEST_ENV_LOADER_PROCESS_WIN = "from-process";

    loadProjectEnv(tmpRoot);
    assert.equal(process.env.TEST_ENV_LOADER_PROCESS_WIN, "from-process");

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("idempotente — chamar 2× não erra", () => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "env-loader-5-"));
    writeFileSync(resolve(tmpRoot, ".env"), "DUMMY=ok\n");

    loadProjectEnv(tmpRoot);
    loadProjectEnv(tmpRoot);
    // sucesso = não jogou
    assert.ok(true);

    rmSync(tmpRoot, { recursive: true, force: true });
  });
});
