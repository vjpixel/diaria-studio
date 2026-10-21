/**
 * #10716 item 2 — `gh pr merge N --squash --subject "…" --body "…"` (a forma
 * que `.claude/skills/diaria-overnight/SKILL.md` manda usar) caía no modo
 * ESTRITO de `resolveMergeTargets` (`grantRepo: null`): uma sessão com
 * `merge_grant` válido era bloqueada pelo guard do #5716. A whitelist passa a
 * aceitar `--subject`/`--body` (e `-t`/`-b`) com argumento entre aspas, sem
 * afrouxar o guard: merge sem concessão continua bloqueado, e o texto do
 * subject/body não muda o repo-alvo nem esconde comando.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as hookRepo from "../.claude/hooks/lib/gh-target-repo.mjs";
import { machineTag } from "../scripts/lib/session-registry.ts";

const DESIGN = "vjpixel/diaria-design";
const STUDIO = "vjpixel/diaria-studio";
const studioOrigin = () => `https://github.com/${STUDIO}.git`;

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tmpRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `merge-subject-10716-${tag}-`));
  roots.push(r);
  return r;
}

describe("parseStrictMerge aceita --subject/--body com argumento entre aspas (#10716)", () => {
  it("forma do SKILL.md do overnight passa", () => {
    const cmd = 'gh pr merge 123 --squash --subject "fix: x (#10716)" --body "Corpo.\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>"';
    assert.deepEqual(hookRepo.parseStrictMerge(cmd), { repo: null, pr: 123, cd: null });
  });

  it("formas curtas, aspas simples, ordem livre, com -R e | tail", () => {
    for (const [cmd, repo] of [
      [`gh pr merge 5 -t 'a "b" c' -b 'x' --squash`, null],
      [`gh pr merge 5 --squash --subject "x" -R ${STUDIO}`, STUDIO],
      [`gh pr merge 5 --body "x" --squash -R ${DESIGN} 2>&1 | tail -5`, DESIGN],
      [`gh pr merge 5 --squash --subject ""`, null],
    ] as const) {
      assert.deepEqual(hookRepo.parseStrictMerge(cmd), { repo, pr: 5, cd: null }, cmd);
    }
  });

  it("subject/body citando outro repo não muda o alvo (é só texto da mensagem)", () => {
    const cmd = `gh pr merge 5 --squash --subject "ver ${DESIGN}" --body "https://github.com/${DESIGN}/pull/23 -R ${DESIGN}"`;
    assert.deepEqual(hookRepo.parseStrictMerge(cmd), { repo: null, pr: 5, cd: null });
  });

  it("qualquer forma de quoting ambíguo ou expansão segue fora da whitelist", () => {
    for (const bad of [
      'gh pr merge 1 --body "$(cat x)"',
      'gh pr merge 1 --body "a $HOME"',
      "gh pr merge 1 --body \"a `id`\"",
      'gh pr merge 1 --body "a \\" ; gh pr merge 2 -R vjpixel/diaria-design ; echo \\""',
      'gh pr merge 1 --body "a\\$(id)"',
      "gh pr merge 1 --subject 'a'b' -R vjpixel/diaria-design'",
      'gh pr merge 1 --subject "a"b',
      'gh pr merge 1 --subject="x"',
      "gh pr merge 1 --subject x",
      'gh pr merge 1 --subject "x',
      'gh pr merge 1 --body "x" ; gh pr merge 2 -R vjpixel/diaria-design',
      'gh pr merge 1 --body "x" && rm -rf y',
      'gh pr merge 1 "--subject" "x"',
      "gh pr merge 1 'x --subject \"y\" z'",
      'gh pr merge 1 --body "linha1\nlinha2"',
      'gh pr merge --subject "1"',
      // Defesa em profundidade: valor que parece encadear comando segue estrito.
      `gh pr merge 6 -R ${DESIGN} --subject 'a && gh pr merge 7'`,
      'gh pr merge 6 --body "a; gh pr merge 7"',
      'gh pr merge 6 --body "a | b"',
    ]) {
      assert.equal(hookRepo.parseStrictMerge(bad), null, JSON.stringify(bad));
    }
  });

  it("cd com \\ antes do espaço não engole o flag (remoção só depois do cd)", () => {
    assert.equal(hookRepo.parseStrictMerge('cd /x\\ --subject "y" && gh pr merge 1'), null);
  });
});

describe("resolveMergeTargets com --subject/--body (#10716)", () => {
  it("checkout do studio → studio-plain, concessão conta", () => {
    const r = hookRepo.resolveMergeTargets('gh pr merge 123 --squash --subject "t (#1)" --body "b"', "/x", {
      execFn: studioOrigin,
      env: {},
    });
    assert.equal(r.mode, "studio-plain");
    assert.equal(r.grantRepo, STUDIO);
    assert.deepEqual(r.targets, [STUDIO]);
  });

  it("forma com expansão continua estrita (sem concessão)", () => {
    const r = hookRepo.resolveMergeTargets('gh pr merge 123 --squash --body "$(cat x)"', "/x", {
      execFn: studioOrigin,
      env: {},
    });
    assert.equal(r.mode, "strict");
    assert.equal(r.grantRepo, null);
  });
});

describe("e2e: guard do #5716 com --subject/--body (#10716)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
  const DENY = /"permissionDecision":"deny"/;
  const tag = machineTag();

  function setup(opts: { lock: string; grant?: { pr: number } }): string {
    const root = tmpRoot("e2e");
    const dir = join(root, "data", "sessions");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", studioOrigin()], { cwd: root });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `overnight-${tag}-coord-A.json`),
      JSON.stringify({
        kind: "overnight",
        sessionId: "coord-A",
        machineTag: tag,
        startedAt: now,
        lastHeartbeat: now,
        ...(opts.grant ? { merge_grant: { grantedTo: "benef", grantedBy: "coord-A", grantedAt: now, ...opts.grant } } : {}),
      }),
    );
    writeFileSync(join(dir, ".merge-lock.json"), JSON.stringify({ heldBy: opts.lock, acquiredAt: now }));
    return root;
  }

  function run(root: string, command: string, sessionId: string): string {
    const env = { ...process.env };
    delete env.GH_REPO;
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: JSON.stringify({ session_id: sessionId, cwd: root, tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env,
    });
    return r.stdout ?? "";
  }

  const SKILL_FORM = 'gh pr merge 123 --squash --subject "fix: x (#10716)" --body "Corpo.\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>"';

  it("beneficiária com merge_grant válido não é bloqueada na forma do SKILL.md", () => {
    const g = setup({ lock: "benef", grant: { pr: 123 } });
    assert.equal(run(g, SKILL_FORM, "benef"), "");
  });

  it("sem concessão continua bloqueado", () => {
    const g = setup({ lock: "benef" });
    assert.match(run(g, SKILL_FORM, "benef"), DENY);
  });

  it("concessão de OUTRO PR não cobre", () => {
    const g = setup({ lock: "benef", grant: { pr: 999 } });
    assert.match(run(g, SKILL_FORM, "benef"), DENY);
  });

  it("concessão + body com expansão continua bloqueado", () => {
    const g = setup({ lock: "benef", grant: { pr: 123 } });
    assert.match(run(g, 'gh pr merge 123 --squash --body "$(cat x)"', "benef"), DENY);
  });

  it("coordenadora com o lock passa na forma do SKILL.md", () => {
    const g = setup({ lock: "coord-A" });
    assert.equal(run(g, SKILL_FORM, "coord-A"), "");
  });
});
