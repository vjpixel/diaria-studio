/**
 * #9276 — regressão: sync-code no início do /diaria-5-publicacao stashou o
 * platform.config.json editado no gate 4 (outcome synced_stash_preserved) e a
 * publicação seguiria com a config do master. Agora: config protegida suja +
 * ff direto recusado → NÃO stasha, tree intocada, fail-soft.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  syncCode,
  findDirtyProtectedConfig,
  type SpawnFn,
  type SpawnResult,
  type SyncLock,
} from "../scripts/lib/git-sync.ts";

const ok = (stdout = ""): SpawnResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = ""): SpawnResult => ({ status: 1, stdout: "", stderr });
const NOOP_LOCK: SyncLock = { path: "(noop)", acquire: () => true, release: () => {} };
const MAIN_CHECKOUT = "/home/editor/diaria-studio";

function spawnWith(status: string, calls: string[]): SpawnFn {
  return (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    if (key === "git rev-parse --abbrev-ref HEAD") return ok("master");
    if (key === "git fetch origin") return ok("");
    if (key === "git status --porcelain") return ok(status);
    if (key === "git merge --ff-only origin/master") return fail("error: Your local changes would be overwritten");
    if (key === "git stash list") return ok("");
    if (key.startsWith("git rev-list")) return ok("3");
    return ok("");
  };
}

describe("#9276 — config protegida nunca vai pro autostash", () => {
  it("platform.config.json sujo + ff direto recusa → protected_config_dirty, sem stash push", () => {
    const calls: string[] = [];
    const r = syncCode(spawnWith(" M platform.config.json\n M scripts/foo.ts", calls), NOOP_LOCK, MAIN_CHECKOUT);
    assert.equal(r.outcome, "protected_config_dirty");
    assert.equal(r.proceed, true, "fail-soft");
    assert.equal(r.preserved_stash, null);
    assert.match(r.message, /platform\.config\.json/);
    assert.deepEqual(r.dirty_config, ["platform.config.json"]);
    assert.ok(!calls.some((c) => c.startsWith("git stash push")), "não pode stashar");
    assert.ok(!calls.includes("git stash pop"), "nunca pop (#8719)");
  });

  it("sem config protegida suja → segue o caminho de stash normal", () => {
    const calls: string[] = [];
    const r = syncCode(spawnWith(" M scripts/foo.ts", calls), NOOP_LOCK, MAIN_CHECKOUT);
    assert.notEqual(r.outcome, "protected_config_dirty");
    assert.ok(calls.some((c) => c.startsWith("git stash push")));
  });

  it("findDirtyProtectedConfig: ignora untracked, pega staged/rename", () => {
    assert.deepEqual(findDirtyProtectedConfig("?? platform.config.json"), []);
    assert.deepEqual(findDirtyProtectedConfig("M  platform.config.json"), ["platform.config.json"]);
    assert.deepEqual(findDirtyProtectedConfig("R  old.json -> platform.config.json"), ["platform.config.json"]);
    assert.deepEqual(findDirtyProtectedConfig(" M context/platform.config.json"), []);
  });
});
