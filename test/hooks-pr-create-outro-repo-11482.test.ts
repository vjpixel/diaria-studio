/**
 * #11482 — os hooks de `gh pr create` que só fazem sentido no diaria-studio
 * (snapshot do orchestrator, tsc, test-runner, conserto de `Closes #N`) saem
 * cedo quando o alvo é QUALQUER outro repo, não só os de `issue_repos`.
 *
 * Incidente: na #11467 (261028) um `gh pr create -R vjpixel/fluxo-criativo`
 * foi bloqueado pelo guard do snapshot (procurou
 * `test/orchestrator-prompt.test.ts`, que não existe lá) porque o
 * fluxo-criativo não está em `issue_repos` e a allowlist o tratava como
 * diaria-studio. O subagente passou pelo escape hatch, que ficou logado como
 * bypass.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as hookRepo from "../.claude/hooks/lib/gh-target-repo.mjs";

const FLUXO = "vjpixel/fluxo-criativo";
const STUDIO = "vjpixel/diaria-studio";
const originOf = (repo: string | null) => () => {
  if (repo === null) throw new Error("sem origin");
  return `https://github.com/${repo}.git\n`;
};

const tmpRoots: string[] = [];
after(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

function makeRepo(origin: string): string {
  const root = mkdtempSync(join(tmpdir(), "hooks-11482-"));
  tmpRoots.push(root);
  spawnSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  spawnSync("git", ["remote", "add", "origin", origin], { cwd: root, windowsHide: true });
  return root;
}

function runHook(file: string, root: string, command: string): string {
  const hook = fileURLToPath(new URL(`../.claude/hooks/${file}`, import.meta.url));
  // Sem os escape hatches no ambiente: o teste prova que o pulo vem do alvo.
  const env = { ...process.env };
  delete env.DIARIA_ALLOW_PR_WITH_STALE_ORCHESTRATOR_SNAPSHOT;
  delete env.DIARIA_ALLOW_PR_WITH_TSC_ERRORS;
  const r = spawnSync(process.execPath, [hook], {
    cwd: root,
    input: JSON.stringify({ tool_name: "Bash", cwd: root, tool_input: { command } }),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env,
  });
  return r.stdout ?? "";
}

describe("#11482 — isForeignRepoGhCommand: qualquer repo que não o studio", () => {
  it("-R/--repo vjpixel/fluxo-criativo (fora de issue_repos) é de fora, mesmo de um checkout do studio", () => {
    assert.ok(!hookRepo.loadAllowedForeignRepos().has(FLUXO), "premissa: fluxo-criativo não está em issue_repos");
    assert.equal(
      hookRepo.isForeignRepoGhCommand(`gh pr create -R ${FLUXO} --title t --body b`, "/x", { execFn: originOf(STUDIO) }),
      true,
    );
    assert.equal(
      hookRepo.isForeignRepoGhCommand(`gh pr create --repo ${FLUXO} --title t --body b`, "/x", { execFn: originOf(STUDIO) }),
      true,
    );
  });

  it("cwd num checkout do fluxo-criativo, sem -R, também é de fora (inclusive com corpo em heredoc)", () => {
    const exec = originOf(FLUXO);
    assert.equal(hookRepo.isForeignRepoGhCommand("gh pr create --title t --body b", "/fluxo", { execFn: exec }), true);
    const heredoc = "gh pr create --title t --body \"$(cat <<'EOF'\nCorpo citando vjpixel/diaria-studio#11482\nEOF\n)\"";
    assert.equal(hookRepo.isForeignRepoGhCommand(heredoc, "/fluxo", { execFn: exec }), true);
  });

  it("studio, alvo indeterminado ou ilegível seguem com as regras do studio", () => {
    assert.equal(hookRepo.isForeignRepoGhCommand("gh pr create --title t", "/x", { execFn: originOf(STUDIO) }), false);
    assert.equal(hookRepo.isForeignRepoGhCommand(`gh pr create -R ${STUDIO} --title t`, "/x", { execFn: originOf(FLUXO) }), false);
    assert.equal(hookRepo.isForeignRepoGhCommand("gh pr create --title t", "/x", { execFn: originOf(null) }), false);
    assert.equal(hookRepo.isForeignRepoGhCommand("gh pr create -R $REPO --title t", "/x", { execFn: originOf(FLUXO) }), false);
    // Comando misto (um segmento mira o studio): regras do studio.
    assert.equal(
      hookRepo.isForeignRepoGhCommand(`gh pr create -R ${FLUXO} --title a; gh pr create --title b`, "/x", {
        execFn: originOf(STUDIO),
      }),
      false,
    );
  });

  it("allowlist explícita em opts continua restringindo", () => {
    assert.equal(
      hookRepo.isForeignRepoGhCommand(`gh pr create -R ${FLUXO} --title t`, "/x", { execFn: originOf(STUDIO), allowed: new Set() }),
      false,
    );
  });

  it("o merge não muda: repo fora de issue_repos segue com o lock do studio", () => {
    assert.deepEqual(hookRepo.resolveGhTargets(`gh pr merge 1 -R ${FLUXO}`, "/x", { execFn: originOf(STUDIO) }), [
      { repo: STUDIO, source: "flag:fora-da-allowlist" },
    ]);
  });
});

describe("#11482 — e2e: hooks de regra do studio não bloqueiam gh pr create -R fluxo-criativo", () => {
  it("guard do snapshot do orchestrator: no-op (o alvo não tem test/orchestrator-prompt.test.ts)", () => {
    const root = makeRepo(`https://github.com/${STUDIO}.git`);
    assert.equal(
      runHook("block-pr-create-orchestrator-snapshot-stale.mjs", root, `gh pr create -R ${FLUXO} --title t --body b`),
      "",
    );
  });

  it("guards de tsc e do test-runner: no-op no checkout do fluxo-criativo", () => {
    const root = makeRepo(`git@github.com:${FLUXO}.git`);
    assert.equal(runHook("block-pr-create-tsc-failure.mjs", root, "gh pr create --title t --body b"), "");
    assert.equal(runHook("block-pr-create-test-runner-import.mjs", root, `gh pr create -R ${FLUXO} --title t --body b`), "");
  });
});
