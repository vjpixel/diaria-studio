/**
 * #8991: o alarme de pileup do sync-code voltou (10 autostashes) mesmo depois
 * do #8719. Causa: `git stash push --include-untracked` que sai não-zero por
 * untracked travados (Permission denied) já criou o stash mas NÃO limpa o
 * working tree (nem o rastreado) — o tree fica igual e a rodada seguinte cria
 * outro stash com o mesmo conteúdo. `dedupeFreshAutostash()` descarta o
 * recém-criado quando ele é cópia exata do autostash anterior.
 *
 * Duas camadas: mocks (lógica e corrida) e git REAL num repo temporário
 * (formato de `git stash list --format`, `%P`, `git stash drop` — o que um
 * mock não prova).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dedupeFreshAutostash,
  syncCode,
  GIT_SYNC_STASH_MESSAGE,
  type SpawnFn,
  type SpawnResult,
  type SyncLock,
} from "../scripts/lib/git-sync.ts";

const ok = (stdout = ""): SpawnResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "", status = 1): SpawnResult => ({ status, stdout: "", stderr });
const MSG = `On master: ${GIT_SYNC_STASH_MESSAGE}`;
const LIST_KEY = "git stash list -n 2 --format=%H|%T|%P|%gs";
const NOOP_LOCK: SyncLock = { path: "(noop)", acquire: () => true, release: () => {} };
const MAIN_CHECKOUT = "/home/editor/diaria-studio";

function mockSpawn(responses: Record<string, SpawnResult>, calls: string[] = []): SpawnFn {
  return (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    return responses[key] ?? ok("");
  };
}

describe("#8991 dedupeFreshAutostash — lógica (mock)", () => {
  const dupList = ok(`fa11e51|T|base i1 u1|${MSG}\nbee7001|T|base i2 u2|${MSG}\n`);
  const trees = ok("i1 TI\nu1 TU\ni2 TI\nu2 TU\n");

  it("duplicata exata (tree, base, índice, untracked) → descarta o recém-criado, mantém o anterior", () => {
    const calls: string[] = [];
    const r = dedupeFreshAutostash(
      mockSpawn(
        {
          [LIST_KEY]: dupList,
          "git log --no-walk=unsorted --format=%H %T i1 u1 i2 u2": trees,
          "git stash drop stash@{0}": ok("Dropped stash@{0} (fa11e51)\n"),
        },
        calls,
      ),
      "fa11e51",
    );
    assert.deepEqual(r, { keptRef: "bee7001", droppedDuplicate: true, warnings: [] });
    assert.ok(calls.includes("git stash drop stash@{0}"));
  });

  for (const [label, list, treeOut] of [
    ["tree do working tree difere", `fa11e51|T1|base i1 u1|${MSG}\nbee7001|T2|base i2 u2|${MSG}\n`, "i1 TI\nu1 TU\ni2 TI\nu2 TU\n"],
    ["base (1º pai) difere", `fa11e51|T|b1 i1 u1|${MSG}\nbee7001|T|b2 i2 u2|${MSG}\n`, "i1 TI\nu1 TU\ni2 TI\nu2 TU\n"],
    ["tree de untracked difere", `fa11e51|T|base i1 u1|${MSG}\nbee7001|T|base i2 u2|${MSG}\n`, "i1 TI\nu1 TU1\ni2 TI\nu2 TU2\n"],
    ["um com untracked, outro sem", `fa11e51|T|base i1 u1|${MSG}\nbee7001|T|base i2|${MSG}\n`, "i1 TI\nu1 TU\ni2 TI\n"],
    ["anterior não é autostash do módulo", `fa11e51|T|base i1 u1|${MSG}\nbee7001|T|base i2 u2|On master: WIP manual\n`, "i1 TI\nu1 TU\ni2 TI\nu2 TU\n"],
    ["stash@{0} não é o recém-criado (outro processo empilhou)", `other|T|base i1 u1|${MSG}\nfa11e51|T|base i2 u2|${MSG}\n`, "i1 TI\nu1 TU\ni2 TI\nu2 TU\n"],
    ["só existe 1 stash", `fa11e51|T|base i1 u1|${MSG}\n`, ""],
  ] as const) {
    it(`${label} → não descarta nada`, () => {
      const calls: string[] = [];
      const logKey = (() => {
        const lines = list.trim().split("\n").map((l) => l.split("|")[2].split(" ").slice(1));
        return lines.length === 2 ? `git log --no-walk=unsorted --format=%H %T ${[...lines[0], ...lines[1]].join(" ")}` : "";
      })();
      const r = dedupeFreshAutostash(mockSpawn({ [LIST_KEY]: ok(list), [logKey]: ok(treeOut) }, calls), "fa11e51");
      assert.equal(r.droppedDuplicate, false);
      assert.equal(r.keptRef, "fa11e51");
      assert.ok(!calls.some((c) => c.startsWith("git stash drop")), `não deveria dropar: ${calls.join(" | ")}`);
    });
  }

  it("stash list falha → não descarta (fail-soft)", () => {
    const calls: string[] = [];
    const r = dedupeFreshAutostash(mockSpawn({ [LIST_KEY]: fail("boom") }, calls), "fa11e51");
    assert.equal(r.droppedDuplicate, false);
    assert.ok(!calls.some((c) => c.startsWith("git stash drop")));
  });

  it("corrida: o drop pegou o stash de outro processo → re-armazena via git stash store e avisa", () => {
    const calls: string[] = [];
    const r = dedupeFreshAutostash(
      mockSpawn(
        {
          [LIST_KEY]: dupList,
          "git log --no-walk=unsorted --format=%H %T i1 u1 i2 u2": trees,
          "git stash drop stash@{0}": ok("Dropped stash@{0} (0ee1e5f)\n"),
          "git log -1 --format=%s 0ee1e5f": ok("On master: minha-tag-unica\n"),
        },
        calls,
      ),
      "fa11e51",
    );
    assert.equal(r.droppedDuplicate, false);
    assert.equal(r.keptRef, "fa11e51");
    assert.ok(
      calls.includes("git stash store -m On master: minha-tag-unica 0ee1e5f"),
      `deve re-armazenar com a mensagem ORIGINAL: ${calls.join(" | ")}`,
    );
    assert.match(r.warnings.join("\n"), /corrida/);
  });

  it("corrida + git stash store falha → ERROR com instrução de recuperação manual", () => {
    const r = dedupeFreshAutostash(
      mockSpawn({
        [LIST_KEY]: dupList,
        "git log --no-walk=unsorted --format=%H %T i1 u1 i2 u2": trees,
        "git stash drop stash@{0}": ok("Dropped stash@{0} (0ee1e5f)\n"),
        "git log -1 --format=%s 0ee1e5f": ok("On master: x\n"),
        "git stash store -m On master: x 0ee1e5f": fail("fatal: boom"),
      }),
      "fa11e51",
    );
    assert.equal(r.droppedDuplicate, false);
    const w = r.warnings.join("\n");
    assert.match(w, /ERROR/);
    assert.match(w, /git stash store -m <mensagem> 0ee1e5f/);
  });

  it("git stash drop falha → mantém os dois, avisa", () => {
    const r = dedupeFreshAutostash(
      mockSpawn({
        [LIST_KEY]: dupList,
        "git log --no-walk=unsorted --format=%H %T i1 u1 i2 u2": trees,
        "git stash drop stash@{0}": fail("error: lock"),
      }),
      "fa11e51",
    );
    assert.equal(r.droppedDuplicate, false);
    assert.equal(r.keptRef, "fa11e51");
    assert.match(r.warnings.join("\n"), /drop falhou/);
  });

  it("tree do índice (2º pai) difere → não descarta", () => {
    const calls: string[] = [];
    const r = dedupeFreshAutostash(
      mockSpawn(
        { [LIST_KEY]: dupList, "git log --no-walk=unsorted --format=%H %T i1 u1 i2 u2": ok("i1 TI1\nu1 TU\ni2 TI2\nu2 TU\n") },
        calls,
      ),
      "fa11e51",
    );
    assert.equal(r.droppedDuplicate, false);
    assert.ok(!calls.some((c) => c.startsWith("git stash drop")));
  });

  it("log --no-walk falha → não descarta", () => {
    const calls: string[] = [];
    const r = dedupeFreshAutostash(
      mockSpawn({ [LIST_KEY]: dupList, "git log --no-walk=unsorted --format=%H %T i1 u1 i2 u2": fail("bad") }, calls),
      "fa11e51",
    );
    assert.equal(r.droppedDuplicate, false);
    assert.ok(!calls.some((c) => c.startsWith("git stash drop")));
  });
});

describe("#8991 syncCode — stash bem-sucedido duplicado", () => {
  it("ff sob stash sucede e o autostash é duplicata → preserved_stash aponta pro anterior", () => {
    const calls: string[] = [];
    let merges = 0;
    const base = mockSpawn(
      {
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(" M scripts/x.ts\n"),
        "git rev-parse --verify refs/stash": ok("bee7001\n"),
        [`git stash push --include-untracked -m ${GIT_SYNC_STASH_MESSAGE}`]: ok("Saved working directory"),
        "git rev-parse refs/stash": ok("fa11e51\n"),
        [LIST_KEY]: ok(`fa11e51|T|base i1|${MSG}\nbee7001|T|base i2|${MSG}\n`),
        "git log --no-walk=unsorted --format=%H %T i1 i2": ok("i1 TI\ni2 TI\n"),
        "git stash drop stash@{0}": ok("Dropped stash@{0} (fa11e51)\n"),
      },
      calls,
    );
    const spawn: SpawnFn = (cmd, args) => {
      if ([cmd, ...args].join(" ") === "git merge --ff-only origin/master") {
        return merges++ === 0 ? fail("error: would be overwritten") : ok("Fast-forward\n");
      }
      return base(cmd, args);
    };
    const r = syncCode(spawn, NOOP_LOCK, MAIN_CHECKOUT);
    assert.equal(r.outcome, "synced_stash_preserved");
    assert.deepEqual(r.preserved_stash, { ref: "bee7001", message: GIT_SYNC_STASH_MESSAGE });
    assert.match(r.message, /git stash apply bee7001/);
    assert.match(r.warnings.join("\n"), /INFO: autostash recém-criado era cópia exata/);
  });
});

describe("#8991 syncCode — falha parcial repetida não empilha autostash", () => {
  it("stash parcial idêntico ao anterior → drop da duplicata, preserved_stash aponta pro anterior", () => {
    const calls: string[] = [];
    let revParseVerify = 0;
    const base = mockSpawn(
      {
        "git rev-parse --abbrev-ref HEAD": ok("master"),
        "git fetch origin": ok(""),
        "git status --porcelain": ok(" M scripts/x.ts\n?? travado/\n"),
        "git merge --ff-only origin/master": fail("error: would be overwritten by merge"),
        "git diff --name-only -z --no-renames HEAD origin/master": ok("travado/a.md\0"),
        [`git stash push --include-untracked -m ${GIT_SYNC_STASH_MESSAGE}`]: fail("warning: failed to remove travado/a: Permission denied"),
        [LIST_KEY]: ok(`a2e2a2e|T|base i1 u1|${MSG}\n0d10d10|T|base i2 u2|${MSG}\n`),
        "git log --no-walk=unsorted --format=%H %T i1 u1 i2 u2": ok("i1 TI\nu1 TU\ni2 TI\nu2 TU\n"),
        "git stash drop stash@{0}": ok("Dropped stash@{0} (a2e2a2e)\n"),
      },
      calls,
    );
    const spawn: SpawnFn = (cmd, args) => {
      if ([cmd, ...args].join(" ") === "git rev-parse --verify refs/stash") {
        calls.push("git rev-parse --verify refs/stash");
        return ok(revParseVerify++ === 0 ? "0d10d10\n" : "a2e2a2e\n");
      }
      return base(cmd, args);
    };
    const r = syncCode(spawn, NOOP_LOCK, MAIN_CHECKOUT);
    assert.equal(r.outcome, "stash_partial_failure_unrecovered");
    assert.deepEqual(r.preserved_stash, { ref: "0d10d10", message: GIT_SYNC_STASH_MESSAGE });
    assert.ok(calls.includes("git stash drop stash@{0}"));
    assert.match(r.message, /duplicata foi descartada/);
    assert.equal(r.proceed, true);
  });
});

// ── git REAL ───────────────────────────────────────────────────────────────
function realRepo(): { dir: string; spawn: SpawnFn; git: (...a: string[]) => SpawnResult } {
  const dir = mkdtempSync(join(tmpdir(), "git-sync-8991-"));
  let clock = 1_700_000_000;
  const git = (...args: string[]): SpawnResult => {
    // Datas distintas por comando: dois stashes do mesmo conteúdo no mesmo
    // segundo teriam o MESMO sha (e o reflog não registraria o 2º).
    clock += 10;
    const date = `${clock} +0000`;
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_NOSYSTEM: "1", HOME: dir },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "t.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, spawn: (cmd, args) => (cmd === "git" ? git(...args) : fail("só git")), git };
}

function stashList(git: (...a: string[]) => SpawnResult): string[] {
  return git("stash", "list", "--format=%H").stdout.split("\n").filter(Boolean);
}

describe("#8991 dedupeFreshAutostash — git real", () => {
  it("2º autostash com o mesmo conteúdo (tracked + untracked) é descartado; conteúdo segue no anterior", () => {
    const { dir, spawn, git } = realRepo();
    try {
      appendFileSync(join(dir, "t.txt"), "mod\n");
      mkdirSync(join(dir, "solto"));
      writeFileSync(join(dir, "solto", "f.txt"), "x\n");
      assert.equal(git("stash", "push", "--include-untracked", "-m", GIT_SYNC_STASH_MESSAGE).status, 0);
      const first = stashList(git)[0];
      // Simula a falha parcial: o tree volta ao MESMO estado sujo.
      assert.equal(git("stash", "apply", first).status, 0);
      assert.equal(git("stash", "push", "--include-untracked", "-m", GIT_SYNC_STASH_MESSAGE).status, 0);
      const [second] = stashList(git);
      assert.notEqual(second, first, "pré-condição: 2 stashes distintos (datas diferentes)");
      assert.equal(stashList(git).length, 2);

      const r = dedupeFreshAutostash(spawn, second);
      assert.deepEqual(r, { keptRef: first, droppedDuplicate: true, warnings: [] });
      assert.deepEqual(stashList(git), [first]);
      assert.match(git("stash", "show", "-p", "--include-untracked", first).stdout, /solto\/f\.txt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("conteúdo diferente (untracked mudou) → os dois ficam", () => {
    const { dir, spawn, git } = realRepo();
    try {
      appendFileSync(join(dir, "t.txt"), "mod\n");
      writeFileSync(join(dir, "solto.txt"), "v1\n");
      git("stash", "push", "--include-untracked", "-m", GIT_SYNC_STASH_MESSAGE);
      const first = stashList(git)[0];
      git("stash", "apply", first);
      writeFileSync(join(dir, "solto.txt"), "v2\n");
      git("stash", "push", "--include-untracked", "-m", GIT_SYNC_STASH_MESSAGE);
      const [second] = stashList(git);

      const r = dedupeFreshAutostash(spawn, second);
      assert.equal(r.droppedDuplicate, false);
      assert.deepEqual(stashList(git), [second, first]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("anterior é stash manual (outra mensagem) com o mesmo conteúdo → os dois ficam", () => {
    const { dir, spawn, git } = realRepo();
    try {
      appendFileSync(join(dir, "t.txt"), "mod\n");
      git("stash", "push", "-m", "WIP manual da sessao");
      const first = stashList(git)[0];
      git("stash", "apply", first);
      git("stash", "push", "-m", GIT_SYNC_STASH_MESSAGE);
      const [second] = stashList(git);

      const r = dedupeFreshAutostash(spawn, second);
      assert.equal(r.droppedDuplicate, false);
      assert.equal(stashList(git).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
