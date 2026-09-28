/**
 * test/hubs-weekly-regen-script.test.ts (#8948, #8949)
 *
 * Cobre as partes de I/O de `scripts/hubs-weekly-regen.ts` que não exigem
 * `data/beehiiv-cache/` real nem `gh`/rede reais (guard de #573/CLAUDE.md —
 * mesmo padrão de `test/hub-staleness-check-script.test.ts`):
 *
 *   - #8948: `HUBS_GIT_ADD_PATHS` inclui os dois diretórios que o passo de
 *     build reescreve (`scripts/lib/hubs/` + `workers/arquivo/src/hubs/`) —
 *     sem o segundo, o job "Hub page drift" nunca vê os `.generated.ts`
 *     commitados batendo com o dataset novo.
 *   - #8949 item 2: (comportamento coberto indiretamente — ver nota no
 *     próprio `hubs-weekly-regen.ts`; a ordem de `saveProseReviewState`
 *     agora vem depois do early-return de `--dry-run`).
 *   - #8949 item 3: `loadProseReviewState` com JSON corrompido emite aviso
 *     (via callback injetável) antes de resetar pra vazio, e nunca lança.
 *   - #8949 item 4: `createWorktree` faz `git fetch origin master` antes do
 *     `git worktree add`, e o worktree nasce de `origin/master` (nunca do
 *     `master` local sem fetch).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  HUBS_GIT_ADD_PATHS,
  loadProseReviewState,
  saveProseReviewState,
  createWorktree,
} from "../scripts/hubs-weekly-regen.ts";
import type { ProseReviewState } from "../scripts/lib/hubs-weekly-regen.ts";

describe("HUBS_GIT_ADD_PATHS (#8948)", () => {
  it("inclui scripts/lib/hubs/ e workers/arquivo/src/hubs/ — os dois diretórios que build-hub-page.ts --all reescreve", () => {
    assert.deepEqual([...HUBS_GIT_ADD_PATHS], ["scripts/lib/hubs/", "workers/arquivo/src/hubs/"]);
  });
});

describe("loadProseReviewState / saveProseReviewState (#8949 item 3, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hubs-weekly-regen-prose-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio, sem avisar (fail-soft normal, não é corrupção)", () => {
    const warnings: string[] = [];
    const state = loadProseReviewState(resolve(tmpDir, "nao-existe.json"), (m) => warnings.push(m));
    assert.deepEqual(state, {});
    assert.deepEqual(warnings, []);
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state: ProseReviewState = { "anthropic-claude": { proseReviewedDate: "2026-09-01" } };
    saveProseReviewState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadProseReviewState(path), state);
  });

  it("JSON corrompido -> avisa via callback e reseta para vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    const warnings: string[] = [];
    const state = loadProseReviewState(path, (m) => warnings.push(m));
    assert.deepEqual(state, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /corrompido/);
    assert.match(warnings[0], new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("createWorktree (#8949 item 4)", () => {
  const branches: string[] = [];
  afterEach(() => {
    for (const b of branches.splice(0)) {
      const workRoot = join(tmpdir(), `diaria-hubs-weekly-regen-${b.replace(/\//g, "-")}`);
      if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("faz fetch de origin/master ANTES do worktree add, e o worktree nasce de origin/master (não master local)", () => {
    const branch = `hubs/weekly-regen-test-${Date.now()}`;
    branches.push(branch);
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeGitRun = (cmd: string, args: string[]): string => {
      calls.push({ cmd, args });
      if (args[0] === "worktree" && args[1] === "add") {
        // args: ["worktree", "add", "-b", branch, workRoot, "origin/master"]
        const workRoot = args[4];
        mkdirSync(workRoot, { recursive: true });
      }
      return "";
    };
    createWorktree(branch, fakeGitRun);

    const fetchCallIdx = calls.findIndex((c) => c.args[0] === "fetch");
    const worktreeAddIdx = calls.findIndex((c) => c.args[0] === "worktree" && c.args[1] === "add");
    assert.notEqual(fetchCallIdx, -1, "esperava uma chamada git fetch");
    assert.notEqual(worktreeAddIdx, -1, "esperava uma chamada git worktree add");
    assert.ok(fetchCallIdx < worktreeAddIdx, "fetch precisa vir ANTES do worktree add");
    assert.deepEqual(calls[fetchCallIdx].args, ["fetch", "origin", "master"]);
    // Último arg do worktree add é o start-point — precisa ser origin/master, nunca "master".
    const worktreeAddArgs = calls[worktreeAddIdx].args;
    assert.equal(worktreeAddArgs[worktreeAddArgs.length - 1], "origin/master");
  });
});
