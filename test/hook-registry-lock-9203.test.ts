/**
 * #9203: os hooks `session-beacon.mjs` e `consume-merge-grant-on-merge.mjs`
 * apagavam o `.lock` do session-registry só por mtime (>60s), ignorando o dono
 * registrado. Agora usam `.claude/hooks/lib/registry-lock.mjs`, espelho da
 * política de `scripts/lib/session-registry.ts`/`file-lock.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  breakStaleLock,
  isLockOrphan as isLockOrphanMjs,
  lockHostId as lockHostIdMjs,
  tryAcquireOwnedLock,
  STALE_LOCK_MS as STALE_MJS,
  FOREIGN_HOST_STALE_LOCK_MS as FOREIGN_MJS,
} from "../.claude/hooks/lib/registry-lock.mjs";
import { isLockOrphan, lockHostId } from "../scripts/lib/file-lock.ts";
import { STALE_LOCK_MS, FOREIGN_HOST_STALE_LOCK_MS } from "../scripts/lib/session-registry.ts";

const HOOKS_DIR = join(import.meta.dirname, "..", ".claude", "hooks");

function withTmp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "reglock-9203-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function age(path: string, ms: number) {
  const t = (Date.now() - ms) / 1000;
  utimesSync(path, t, t);
}

describe("registry-lock.mjs (#9203)", () => {
  it("constantes iguais às de session-registry.ts", () => {
    assert.equal(STALE_MJS, STALE_LOCK_MS);
    assert.equal(FOREIGN_MJS, FOREIGN_HOST_STALE_LOCK_MS);
    assert.equal(lockHostIdMjs(), lockHostId());
  });

  it("isLockOrphan em paridade com file-lock.ts", () => {
    const now = 10_000_000;
    const host = "h1";
    const owner = (pid: number, h: string) => JSON.stringify({ pid, host: h, ts: 1, token: "t" });
    const cases: Array<[string, number, (p: number) => boolean]> = [
      ["", now - 2 * 60_000, () => true],
      ["", now - 10_000, () => true],
      ["lixo", now - 2 * 60_000, () => true],
      [owner(5, host), now - 60 * 60_000, () => true],
      [owner(5, host), now - 1000, () => false],
      [owner(5, "outro"), now - 2 * 60_000, () => false],
      [owner(5, "outro"), now - 31 * 60_000, () => false],
    ];
    for (const [raw, mtime, alive] of cases) {
      assert.equal(
        isLockOrphanMjs(raw, mtime, now, host, alive),
        isLockOrphan(raw, mtime, now, host, alive, STALE_LOCK_MS, FOREIGN_HOST_STALE_LOCK_MS),
        `raw=${raw} mtime=${now - mtime}`,
      );
    }
  });

  it("regressão: lock de dono VIVO com mtime > 60s NÃO é quebrado", () => {
    withTmp((dir) => {
      const lock = join(dir, "s.json.lock");
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: lockHostIdMjs(), ts: 1, token: "x" }));
      age(lock, 5 * 60_000);
      assert.equal(breakStaleLock(lock), false);
      assert.ok(existsSync(lock));
    });
  });

  it("lock de outro host: respeitado até o teto de 30 min (#9220)", () => {
    withTmp((dir) => {
      const lock = join(dir, "s.json.lock");
      writeFileSync(lock, JSON.stringify({ pid: 1, host: "maquina-remota", ts: 1, token: "x" }));
      age(lock, 5 * 60_000);
      assert.equal(breakStaleLock(lock), false);
      age(lock, 31 * 60_000);
      assert.equal(breakStaleLock(lock), true);
      assert.ok(!existsSync(lock));
    });
  });

  it("lock legado/vazio é quebrado só após 60s", () => {
    withTmp((dir) => {
      const lock = join(dir, "s.json.lock");
      writeFileSync(lock, "");
      age(lock, 10_000);
      assert.equal(breakStaleLock(lock), false);
      age(lock, 2 * 60_000);
      assert.equal(breakStaleLock(lock), true);
      assert.ok(!existsSync(lock) && !existsSync(`${lock}.steal`));
    });
  });

  it("tryAcquireOwnedLock grava dono e respeita EEXIST", () => {
    withTmp((dir) => {
      const lock = join(dir, "s.json.lock");
      assert.equal(tryAcquireOwnedLock(lock), true);
      const o = JSON.parse(readFileSync(lock, "utf8"));
      assert.equal(o.pid, process.pid);
      assert.equal(o.host, lockHostIdMjs());
      assert.equal(typeof o.token, "string");
      assert.equal(tryAcquireOwnedLock(lock), false);
    });
  });

  it("os 2 hooks não mantêm mais cópia própria de breakStaleLock", () => {
    for (const f of ["session-beacon.mjs", "consume-merge-grant-on-merge.mjs"]) {
      const src = readFileSync(join(HOOKS_DIR, f), "utf8");
      assert.doesNotMatch(src, /function breakStaleLock/, f);
      assert.match(src, /from "\.\/lib\/registry-lock\.mjs"/, f);
      assert.doesNotMatch(src, /openSync\(lockPath, "wx"\)/, f);
    }
  });
});
