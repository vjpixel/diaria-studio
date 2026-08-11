import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireEnvioLock,
  releaseEnvioLock,
  isLockStale,
  lockPathForCycle,
  LockHeldError,
  STALE_LOCK_MS,
} from "../scripts/lib/clarice-envio-lock.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarice-envio-lock-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("acquireEnvioLock / releaseEnvioLock", () => {
  it("adquire quando não há lock, e o arquivo carrega pid/host/startedAt/label", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    const lockPath = acquireEnvioLock(root, "2607-08", "run-19h", now);
    assert.ok(existsSync(lockPath));
    const info = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(info.pid, process.pid);
    assert.equal(info.label, "run-19h");
    assert.equal(info.startedAt, now.toISOString());
  });

  it("2ª aquisição com lock FRESCO lança LockHeldError, sem tocar o lock existente", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    acquireEnvioLock(root, "2607-08", "run-19h", now);
    assert.throws(
      () => acquireEnvioLock(root, "2607-08", "guard-05h", new Date(now.getTime() + 60_000)),
      LockHeldError,
    );
    // o lock original continua intacto (não foi sobrescrito pela 2ª tentativa)
    const info = JSON.parse(readFileSync(lockPathForCycle(root, "2607-08"), "utf8"));
    assert.equal(info.label, "run-19h");
  });

  it("lock STALE (mais velho que STALE_LOCK_MS) é removido e a nova aquisição funciona", () => {
    const started = new Date("2026-08-11T00:00:00Z");
    acquireEnvioLock(root, "2607-08", "run-abandonado", started);
    const later = new Date(started.getTime() + STALE_LOCK_MS + 1);
    const lockPath = acquireEnvioLock(root, "2607-08", "run-novo", later);
    const info = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(info.label, "run-novo", "o lock stale devia ter sido substituído");
  });

  it("release + reacquire no mesmo instante funciona (fluxo normal fim-de-rodada)", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    const lockPath = acquireEnvioLock(root, "2607-08", "run-19h", now);
    releaseEnvioLock(lockPath);
    assert.ok(!existsSync(lockPath));
    const lockPath2 = acquireEnvioLock(root, "2607-08", "run-19h-retry", now);
    assert.ok(existsSync(lockPath2));
  });

  it("release em lock já ausente é fail-soft (nunca lança)", () => {
    const lockPath = lockPathForCycle(root, "2607-08");
    assert.doesNotThrow(() => releaseEnvioLock(lockPath));
  });

  it("locks são por CICLO — ciclos diferentes nunca colidem", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    acquireEnvioLock(root, "2607-08", "run-ciclo-A", now);
    assert.doesNotThrow(() => acquireEnvioLock(root, "2608-09", "run-ciclo-B", now));
  });
});

describe("isLockStale", () => {
  it("lock inexistente é tratado como stale (abandonado)", () => {
    assert.equal(isLockStale(join(root, "nao-existe.lock"), new Date()), true);
  });

  it("lock corrompido (JSON inválido) é tratado como stale", () => {
    const p = join(root, "corrompido.lock");
    mkdirSync(root, { recursive: true });
    writeFileSync(p, "{ isto nao e json valido", "utf8");
    assert.equal(isLockStale(p, new Date()), true);
  });

  it("lock com startedAt inválido é tratado como stale", () => {
    const p = join(root, "data-invalida.lock");
    writeFileSync(p, JSON.stringify({ pid: 1, host: "x", startedAt: "não é data", label: "x" }), "utf8");
    assert.equal(isLockStale(p, new Date()), true);
  });

  it("lock recém-criado NÃO é stale", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    const p = join(root, "fresco.lock");
    writeFileSync(p, JSON.stringify({ pid: 1, host: "x", startedAt: now.toISOString(), label: "x" }), "utf8");
    assert.equal(isLockStale(p, new Date(now.getTime() + 1000)), false);
  });

  it("boundary: exatamente STALE_LOCK_MS ainda não é stale; STALE_LOCK_MS+1 já é", () => {
    const started = new Date("2026-08-11T00:00:00Z");
    const p = join(root, "boundary.lock");
    writeFileSync(p, JSON.stringify({ pid: 1, host: "x", startedAt: started.toISOString(), label: "x" }), "utf8");
    assert.equal(isLockStale(p, new Date(started.getTime() + STALE_LOCK_MS)), false);
    assert.equal(isLockStale(p, new Date(started.getTime() + STALE_LOCK_MS + 1)), true);
  });
});
