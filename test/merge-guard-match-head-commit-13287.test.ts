/**
 * #13287 — o guard do #5716 (`block-gh-pr-merge-subagent.mjs`) recusava a
 * forma que o SKILL do overnight manda usar no merge
 * (`gh pr merge N --squash --match-head-commit <sha> --subject "…" --body "…"`)
 * com a mensagem genérica "O comando não está na forma que o guard consegue
 * provar": `--match-head-commit` não estava na whitelist de `parseStrictMerge`,
 * então o comando caía no modo ESTRITO (lock de todo repo de `issue_repos`) e
 * a coordenadora acabava mergeando com `gh pr merge N --squash`, sem travar o
 * commit avaliado. Agora:
 *   - `--match-head-commit <SHA literal de 40 hex>` entra na whitelist;
 *   - `$H`, `"$H"`, SHA abreviado ou maiúsculo seguem fora;
 *   - a recusa nomeia o critério que falhou (`Critério que falhou: …`).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withIsolatedGhConfig } from "./_helpers/isolated-gh-config.ts";
import * as hookRepo from "../.claude/hooks/lib/gh-target-repo.mjs";
import { machineTag } from "../scripts/lib/session-registry.ts";

const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  buildRepoHint: (
    targets: string[],
    complex?: boolean,
    unlisted?: { repo: string; pr: number | null } | null,
    strictReason?: string | null,
  ) => string;
};

const STUDIO = "vjpixel/diaria-studio";
const DESIGN = "vjpixel/diaria-design";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const studioOrigin = () => `https://github.com/${STUDIO}.git`;
const SKILL_FORM =
  `gh pr merge 13272 --squash --match-head-commit ${SHA} --subject "fix: x (#13287)" ` +
  '--body "Closes #13287\\n\\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("parseStrictMerge aceita --match-head-commit com SHA literal (#13287)", () => {
  it("forma do SKILL do overnight (SHA literal + subject/body) passa", () => {
    assert.deepEqual(hookRepo.parseStrictMerge(SKILL_FORM), { repo: null, pr: 13272, cd: null });
    assert.equal(hookRepo.explainStrictMergeRejection(SKILL_FORM), null);
  });

  it("variantes aceitas: =, com -R, antes do número, com | tail", () => {
    for (const [cmd, repo] of [
      [`gh pr merge 5 --squash --match-head-commit=${SHA}`, null],
      [`gh pr merge --match-head-commit ${SHA} 5 --squash -R ${STUDIO}`, STUDIO],
      [`gh pr merge 5 --squash --match-head-commit ${SHA} -R ${DESIGN} 2>&1 | tail -5`, DESIGN],
    ] as const) {
      assert.deepEqual(hookRepo.parseStrictMerge(cmd), { repo, pr: 5, cd: null }, cmd);
    }
  });

  it("SHA por variável, abreviado, maiúsculo, ausente ou repetido segue fora, com o critério dito", () => {
    for (const bad of [
      "gh pr merge 5 --squash --match-head-commit $H",
      'gh pr merge 5 --squash --match-head-commit "$H"',
      "gh pr merge 5 --squash --match-head-commit 0123456",
      `gh pr merge 5 --squash --match-head-commit ${SHA.toUpperCase()}`,
      "gh pr merge 5 --squash --match-head-commit",
      "gh pr merge 5 --squash --match-head-commit=",
      `gh pr merge 5 --match-head-commit ${SHA} --match-head-commit ${SHA}`,
    ]) {
      assert.equal(hookRepo.parseStrictMerge(bad), null, bad);
      assert.match(hookRepo.explainStrictMergeRejection(bad) ?? "", /match-head-commit/, bad);
    }
  });

  it("o SHA não pode carregar o -R escondido nem encadear comando", () => {
    for (const bad of [
      `gh pr merge 5 --match-head-commit ${SHA};gh pr merge 6 -R ${DESIGN}`,
      `gh pr merge 5 --match-head-commit ${SHA}-R`,
    ]) {
      assert.equal(hookRepo.parseStrictMerge(bad), null, bad);
    }
  });

  it("explica outros critérios: quebra de linha real, $ no body, prefixo", () => {
    assert.match(
      hookRepo.explainStrictMergeRejection('gh pr merge 5 --body "a\nb"') ?? "",
      /caractere de controle/,
    );
    assert.match(hookRepo.explainStrictMergeRejection('gh pr merge 5 --body "a $X"') ?? "", /--body/);
    assert.match(hookRepo.explainStrictMergeRejection("GH_REPO=x gh pr merge 5") ?? "", /não começa por `gh pr merge`/);
  });
});

describe("resolveMergeTargets com --match-head-commit (#13287)", () => {
  it("SHA literal no checkout do studio → studio-plain", () => {
    const r = hookRepo.resolveMergeTargets(SKILL_FORM, "/x", { execFn: studioOrigin as never, env: {} });
    assert.equal(r.mode, "studio-plain");
    assert.deepEqual(r.targets, [STUDIO]);
  });

  it("SHA por variável → estrito, com strictReason", () => {
    const r = hookRepo.resolveMergeTargets("gh pr merge 5 --squash --match-head-commit $H", "/x", {
      execFn: studioOrigin as never,
      env: {},
    });
    assert.equal(r.mode, "strict");
    assert.ok(r.mode === "strict" && /match-head-commit/.test(r.strictReason ?? ""));
  });

  it("sem -R e origin indeterminado → strictReason pede -R", () => {
    const r = hookRepo.resolveMergeTargets(`gh pr merge 5 --squash --match-head-commit ${SHA}`, "/x", {
      execFn: (() => {
        throw new Error("sem git");
      }) as never,
      env: {},
    });
    assert.equal(r.mode, "strict");
    assert.ok(r.mode === "strict" && /-R vjpixel\/diaria-studio/.test(r.strictReason ?? ""));
  });

  it("buildRepoHint inclui o critério e a forma com --match-head-commit", () => {
    const hint = guard.buildRepoHint([STUDIO, DESIGN], true, null, "token `$H` usa `$`");
    assert.match(hint, /Critério que falhou: token `\$H` usa `\$`\./);
    assert.match(hint, /--match-head-commit <SHA literal de 40 hex>/);
    assert.doesNotMatch(guard.buildRepoHint([STUDIO, DESIGN], true), /Critério que falhou/);
  });
});

describe("e2e: guard do #5716 com --match-head-commit (#13287)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
  const DENY = /"permissionDecision":"deny"/;
  const tag = machineTag();

  // Coordenadora `coord-A` ativa; `benef` tem concessão escopada ao PR 13272
  // e segura o merge lock. A concessão só conta fora do modo estrito: antes
  // do fix, o `--match-head-commit` jogava a forma do SKILL no estrito.
  function setup(): string {
    const root = mkdtempSync(join(tmpdir(), "merge-mhc-13287-"));
    roots.push(root);
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
        merge_grant: { grantedTo: "benef", grantedBy: "coord-A", grantedAt: now, pr: 13272 },
      }),
    );
    writeFileSync(join(dir, ".merge-lock.json"), JSON.stringify({ heldBy: "benef", acquiredAt: now }));
    return root;
  }

  function run(root: string, command: string, sessionId: string): string {
    const env = withIsolatedGhConfig();
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

  it("concessão escopada vale na forma do SKILL com SHA literal", () => {
    assert.equal(run(setup(), SKILL_FORM, "benef"), "");
  });

  it("com $H a concessão não conta, e a recusa diz a causa e o critério", () => {
    const out = run(setup(), SKILL_FORM.replace(SHA, "$H"), "benef");
    assert.match(out, DENY);
    assert.match(out, /\[causa: not-authorized/);
    assert.match(out, /Critério que falhou: `--match-head-commit` sem SHA literal/);
  });

  it("sessão fora do registro na forma aceita: causa é identidade, sem aviso de forma", () => {
    // Cenário da rodada 261116 (run-log 12:32:21): a coordenadora não aparecia
    // no registro naquele instante, e a recusa culpava a forma do comando.
    const g = setup();
    rmSync(join(g, "data", "sessions", ".merge-lock.json")); // lock livre: sobra só a identidade
    const out = run(g, SKILL_FORM, "coord-sumida");
    assert.match(out, DENY);
    assert.match(out, /\[causa: not-authorized — esta sessão não aparece entre as coordenadoras ativas/);
    assert.doesNotMatch(out, /não está na forma que o guard consegue provar/);
  });
});
