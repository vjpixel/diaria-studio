/**
 * #10461 — dois achados do review 1.5c sobre a PR #10459 (#10457):
 *
 * 1. Com orçamento esgotado, o `git rev-parse` do log de effort recebia
 *    timeout 0 e era pulado; a raiz caía na pasta do próprio hook (o worktree,
 *    numa PR de subagente) e o evento `orcamento_esgotado` sumia com ele.
 *    Agora o log usa `logRootTimeoutMs` = max(callTimeoutMs, 500ms).
 * 2. A fiação default dos timeouts (`checkRoundActive` → `resolveMainRepoRoot`)
 *    não tinha teste. Agora vive em `defaultCheckRoundActive`, testada com
 *    execFn espião, e o wiring do entrypoint/`resolveEffort` é travado no texto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_OUTPUT_RESERVE_MS,
  LOG_ROOT_MIN_TIMEOUT_MS,
  defaultCheckRoundActive,
  logRootTimeoutMs,
  resolveMainRepoRoot,
  // @ts-expect-error -- hook .mjs sem .d.mts (mesma situação, já na baseline, de pr-create-review-hook.test.ts)
} from "../.claude/hooks/pr-create-review.mjs";

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude", "hooks", "pr-create-review.mjs");
const HOOK_DIR_ROOT = resolve(dirname(HOOK_PATH), "..", "..");

type Call = { cmd: string; args: string[]; timeout: number };

function spy(gitCommonDir = "/srv/main/.git") {
  const calls: Call[] = [];
  const execFn = (cmd: string, args: string[], o: { timeout: number }) => {
    calls.push({ cmd, args, timeout: o.timeout });
    return `${gitCommonDir}\n`;
  };
  return { execFn, calls };
}

describe("resolveMainRepoRoot respeita o timeout (#10461 item 2)", () => {
  it("timeoutMs 0 → nenhuma chamada git, fallback na pasta do hook", () => {
    const { execFn, calls } = spy();
    const root = resolveMainRepoRoot(execFn, 0);
    assert.equal(calls.length, 0);
    assert.equal(resolve(root), HOOK_DIR_ROOT);
  });

  it("timeoutMs 1234 → git rev-parse com timeout: 1234", () => {
    const { execFn, calls } = spy("/srv/main/.git");
    const root = resolveMainRepoRoot(execFn, 1234);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["rev-parse", "--git-common-dir"]);
    assert.equal(calls[0].timeout, 1234);
    assert.equal(resolve(root), resolve("/srv/main"));
  });
});

describe("defaultCheckRoundActive repassa o timeout do orçamento (#10461 item 2)", () => {
  it("timeoutMs 1234 chega ao git rev-parse", () => {
    const { execFn, calls } = spy("/nonexistent-10461/.git");
    defaultCheckRoundActive("sess", { timeoutMs: 1234 }, execFn);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].timeout, 1234);
  });

  it("timeoutMs 0 → zero chamadas git", () => {
    const { execFn, calls } = spy("/nonexistent-10461/.git");
    defaultCheckRoundActive("sess", { timeoutMs: 0 }, execFn);
    assert.equal(calls.length, 0);
  });

  it("resolveEffort usa defaultCheckRoundActive como default (não o 10s fixo)", () => {
    const src = readFileSync(HOOK_PATH, "utf8");
    assert.match(src, /checkRoundActive = defaultCheckRoundActive,/);
  });
});

describe("raiz do log de effort tem piso de timeout (#10461 item 1)", () => {
  it("orçamento esgotado → piso de 500ms, dentro da reserva de saída", () => {
    assert.equal(LOG_ROOT_MIN_TIMEOUT_MS, 500);
    assert.ok(LOG_ROOT_MIN_TIMEOUT_MS < HOOK_OUTPUT_RESERVE_MS);
    assert.equal(logRootTimeoutMs(13_000, 13_000), 500);
    assert.equal(logRootTimeoutMs(13_000, 99_000), 500);
  });

  it("com folga, segue callTimeoutMs (min 10s, restante)", () => {
    assert.equal(logRootTimeoutMs(Infinity, 0), 10_000);
    assert.equal(logRootTimeoutMs(13_000, 9_000), 4_000);
  });

  it("orçamento esgotado ainda chama o git (log não cai no worktree)", () => {
    const { execFn, calls } = spy("/srv/main/.git");
    const root = resolveMainRepoRoot(execFn, logRootTimeoutMs(13_000, 13_000));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].timeout, 500);
    assert.equal(resolve(root), resolve("/srv/main"));
  });

  it("entrypoint usa logRootTimeoutMs pro repoRoot do log", () => {
    const src = readFileSync(HOOK_PATH, "utf8");
    assert.match(src, /repoRoot: resolveMainRepoRoot\(execFileSync, logRootTimeoutMs\(deadlineAt\)\)/);
  });
});
