/**
 * test/memory-sync.test.ts (#7533 item 5)
 *
 * Trava a sequência de decisão de runMemorySync via spawner mock — nunca
 * toca um repo git real (o repo de `memory/` fica fora deste checkout e
 * exige setup manual do editor, ver docstring de scripts/lib/memory-sync.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runMemorySync, type GitCommandResult, type Spawner } from "../scripts/lib/memory-sync.ts";

function mockSpawner(script: Record<string, GitCommandResult>): { spawner: Spawner; calls: string[] } {
  const calls: string[] = [];
  const spawner: Spawner = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    return script[key] ?? { status: 0, stdout: "", stderr: "" };
  };
  return { spawner, calls };
}

const ok = (stdout = ""): GitCommandResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "erro"): GitCommandResult => ({ status: 1, stdout: "", stderr });

describe("runMemorySync (#7533)", () => {
  it("para cedo quando o diretório não é um repo git", () => {
    const { spawner, calls } = mockSpawner({
      "git rev-parse --is-inside-work-tree": fail("not a git repository"),
    });
    const outcomes = runMemorySync("/fake/memory", spawner);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].step, "not-a-git-repo");
    assert.equal(calls.length, 1);
  });

  it("reporta no-changes quando não há mudanças pendentes e sem remote configura para aqui", () => {
    const { spawner } = mockSpawner({
      "git rev-parse --is-inside-work-tree": ok("true"),
      "git status --porcelain": ok(""),
      "git remote": ok(""),
    });
    const outcomes = runMemorySync("/fake/memory", spawner);
    const steps = outcomes.map((o) => o.step);
    assert.deepEqual(steps, ["no-changes", "no-remote"]);
  });

  it("commita, pull --rebase e push quando há mudanças e remote configurado", () => {
    const { spawner } = mockSpawner({
      "git rev-parse --is-inside-work-tree": ok("true"),
      "git status --porcelain": ok(" M foo.md"),
      "git commit -m memory: auto-sync 2026-09-06T00:00:00.000Z": ok(),
      "git remote": ok("origin"),
      "git pull --rebase": ok(),
      "git push": ok(),
    });
    const outcomes = runMemorySync("/fake/memory", spawner, () => new Date("2026-09-06T00:00:00.000Z"));
    const steps = outcomes.map((o) => o.step);
    assert.deepEqual(steps, ["committed", "pushed"]);
  });

  it("para em pull-rebase-failed sem tentar push", () => {
    const { spawner, calls } = mockSpawner({
      "git rev-parse --is-inside-work-tree": ok("true"),
      "git status --porcelain": ok(""),
      "git remote": ok("origin"),
      "git pull --rebase": fail("conflict"),
    });
    const outcomes = runMemorySync("/fake/memory", spawner);
    assert.equal(outcomes[outcomes.length - 1].step, "pull-rebase-failed");
    assert.ok(!calls.some((c) => c === "git push"));
  });
});
