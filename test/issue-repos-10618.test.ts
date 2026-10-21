/**
 * #10618 — issues do vjpixel/diaria-design entram nas rodadas. Esta 1ª fatia:
 *   1. identidade `owner/repo#N` (parse/format/normalização) com o número
 *      "pelado" legado continuando a significar vjpixel/diaria-studio#N;
 *   2. merge lock POR REPO (dois repos nunca se serializam; o do diaria-studio
 *      segue no `.merge-lock.json` de sempre);
 *   3. guard do #5716 lendo o lock/concessão do repo do PR sendo mergeado;
 *   4. hooks de `gh pr create` aplicando regras do diaria-studio só a PRs do
 *      diaria-studio (o snapshot do orchestrator bloqueou o
 *      vjpixel/diaria-design#23).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ISSUE_REPO,
  canonicalIssueKey,
  formatIssueRef,
  legacyIssueNumber,
  loadIssueRepos,
  mergeLockFileName,
  normalizeRepoSlug,
  parseIssueRef,
  readIssueRepos,
  sameIssue,
} from "../scripts/lib/issue-repos.ts";
import * as hookRepo from "../.claude/hooks/lib/gh-target-repo.mjs";
import {
  acquireMergeLock,
  mergeLockPath,
  releaseMergeLock,
  renewMergeLock,
  requireLegacyClaimIssue,
  requireRepoFlag,
  machineTag,
} from "../scripts/lib/session-registry.ts";
import {
  grantMatchesRepo,
  readMergeLockHolder,
} from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";
import { isForeignRepoPrUrl } from "../.claude/hooks/pr-create-review.mjs";
import {
  grantMatchesRepo as consumeGrantMatchesRepo,
  resolveMergeState,
} from "../.claude/hooks/consume-merge-grant-on-merge.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DESIGN = "vjpixel/diaria-design";

const tmpRoots: string[] = [];
after(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});
function tmpRoot(prefix: string): string {
  const r = mkdtempSync(join(tmpdir(), `issue-repos-10618-${prefix}-`));
  tmpRoots.push(r);
  return r;
}

describe("identidade owner/repo#N (#10618)", () => {
  it("número pelado (legado) significa vjpixel/diaria-studio#N", () => {
    assert.equal(DEFAULT_ISSUE_REPO, "vjpixel/diaria-studio");
    assert.deepEqual(parseIssueRef(21), { repo: "vjpixel/diaria-studio", number: 21 });
    assert.deepEqual(parseIssueRef("21"), { repo: "vjpixel/diaria-studio", number: 21 });
    assert.deepEqual(parseIssueRef("#21"), { repo: "vjpixel/diaria-studio", number: 21 });
    assert.equal(canonicalIssueKey(21), "vjpixel/diaria-studio#21");
  });

  it("forma qualificada e URL de issue/PR", () => {
    assert.deepEqual(parseIssueRef("vjpixel/diaria-design#21"), { repo: DESIGN, number: 21 });
    assert.deepEqual(parseIssueRef("VJPixel/Diaria-Design#21"), { repo: DESIGN, number: 21 });
    assert.deepEqual(parseIssueRef("https://github.com/vjpixel/diaria-design/issues/21"), { repo: DESIGN, number: 21 });
    assert.deepEqual(parseIssueRef("https://github.com/vjpixel/diaria-design/pull/23#issuecomment-1"), {
      repo: DESIGN,
      number: 23,
    });
    assert.equal(formatIssueRef({ repo: DESIGN, number: 21 }), "vjpixel/diaria-design#21");
  });

  it("o #21 dos dois repos NÃO é a mesma issue (a colisão que motivou a #10618)", () => {
    assert.equal(sameIssue(21, "vjpixel/diaria-design#21"), false);
    assert.equal(sameIssue(21, "vjpixel/diaria-studio#21"), true);
    assert.equal(sameIssue("#21", "https://github.com/vjpixel/diaria-studio/issues/21"), true);
  });

  it("defaultRepo só vale pra forma sem repo", () => {
    assert.deepEqual(parseIssueRef("21", DESIGN), { repo: DESIGN, number: 21 });
    assert.deepEqual(parseIssueRef("vjpixel/diaria-studio#21", DESIGN), { repo: DEFAULT_ISSUE_REPO, number: 21 });
  });

  it("entrada ambígua/inválida devolve null — nunca chuta", () => {
    for (const bad of ["", "abc", "#0", "-3", "1.5", "owner#3", "a/b/c#3", "vjpixel/diaria-design#", 0, -1, 1.5, null, undefined]) {
      assert.equal(parseIssueRef(bad as string | number | null | undefined), null, String(bad));
    }
  });

  it("legacyIssueNumber só devolve número pro repo default", () => {
    assert.equal(legacyIssueNumber({ repo: DEFAULT_ISSUE_REPO, number: 7 }), 7);
    assert.equal(legacyIssueNumber({ repo: DESIGN, number: 7 }), null);
  });

  it("normalizeRepoSlug aceita URL/.git e recusa lixo", () => {
    assert.equal(normalizeRepoSlug("https://github.com/VJPixel/diaria-design.git"), DESIGN);
    assert.equal(normalizeRepoSlug("github.com/vjpixel/diaria-design/"), DESIGN);
    assert.equal(normalizeRepoSlug("diaria-design"), null);
    assert.equal(normalizeRepoSlug("a/b/c"), null);
  });

  it("issue_repos: default sempre 1º, dedup, inválido descartado; config real inclui o diaria-design", () => {
    assert.deepEqual(readIssueRepos(null), [DEFAULT_ISSUE_REPO]);
    assert.deepEqual(readIssueRepos({ issue_repos: [DESIGN, "VJPIXEL/diaria-studio", DESIGN, "lixo", 3] }), [
      DEFAULT_ISSUE_REPO,
      DESIGN,
    ]);
    assert.deepEqual(loadIssueRepos(ROOT), [DEFAULT_ISSUE_REPO, DESIGN]);
    assert.deepEqual(loadIssueRepos(tmpRoot("noconfig")), [DEFAULT_ISSUE_REPO]);
  });
});

describe("paridade TS ↔ hooks/lib/gh-target-repo.mjs (#10618)", () => {
  it("repo default e nome do arquivo de lock batem", () => {
    assert.equal(hookRepo.DIARIA_STUDIO_REPO, DEFAULT_ISSUE_REPO);
    for (const repo of [undefined, DEFAULT_ISSUE_REPO, "VJPixel/Diaria-Studio", DESIGN, "outro/repo.x"]) {
      assert.equal(hookRepo.mergeLockFileName(repo), mergeLockFileName(repo), String(repo));
    }
    assert.equal(mergeLockFileName(DEFAULT_ISSUE_REPO), ".merge-lock.json");
    assert.equal(mergeLockFileName(DESIGN), ".merge-lock--vjpixel--diaria-design.json");
    for (const s of ["https://github.com/a/b.git", "a/b", "x", ""]) {
      assert.equal(hookRepo.normalizeRepoSlug(s), normalizeRepoSlug(s), s);
    }
  });
});

describe("repo alvo de gh pr create/merge (#10618)", () => {
  it("-R/--repo/--repo= vence; URL de PR; GH_REPO=; senão null", () => {
    assert.deepEqual(hookRepo.repoFromGhCommand(`gh pr merge 23 --squash -R ${DESIGN}`), { repo: DESIGN, source: "flag" });
    assert.deepEqual(hookRepo.repoFromGhCommand(`gh pr merge --repo=${DESIGN} 23`), { repo: DESIGN, source: "flag" });
    assert.deepEqual(hookRepo.repoFromGhCommand(`gh pr create --repo "${DESIGN}" --title t`), {
      repo: DESIGN,
      source: "flag",
    });
    assert.deepEqual(hookRepo.repoFromGhCommand(`gh pr merge https://github.com/${DESIGN}/pull/23 --squash`), {
      repo: DESIGN,
      source: "pr-url",
    });
    assert.deepEqual(hookRepo.repoFromGhCommand(`GH_REPO=${DESIGN} gh pr merge 23`), { repo: DESIGN, source: "gh-repo-env" });
    assert.equal(hookRepo.repoFromGhCommand("gh pr merge 23 --squash"), null);
  });

  it("menção dentro de --body não conta como repo alvo", () => {
    assert.equal(hookRepo.repoFromGhCommand(`gh pr create --title t --body "use -R ${DESIGN} lá"`), null);
  });

  it("vale o ÚLTIMO gh pr <sub> do comando composto", () => {
    assert.deepEqual(hookRepo.repoFromGhCommand(`gh pr merge 1 -R ${DESIGN} && gh pr merge 2 -R vjpixel/diaria-studio`), {
      repo: DEFAULT_ISSUE_REPO,
      source: "flag",
    });
  });

  it("remote ssh/https do origin", () => {
    assert.equal(hookRepo.repoFromRemoteUrl("git@github.com:vjpixel/diaria-design.git"), DESIGN);
    assert.equal(hookRepo.repoFromRemoteUrl("https://github.com/vjpixel/diaria-studio.git\n"), DEFAULT_ISSUE_REPO);
    assert.equal(hookRepo.repoFromRemoteUrl("/srv/git/bare.git"), null);
  });

  it("cai no origin do cwd quando o comando não diz; indeterminado não é estrangeiro", () => {
    const fakeOrigin = (url: string) => () => url;
    assert.deepEqual(hookRepo.resolveGhTargetRepo("gh pr create --title t", "/x", { execFn: fakeOrigin(`https://github.com/${DESIGN}.git`) }), {
      repo: DESIGN,
      source: "cwd-origin",
    });
    const boom = () => {
      throw new Error("not a git repo");
    };
    assert.deepEqual(hookRepo.resolveGhTargetRepo("gh pr create", "/x", { execFn: boom }), { repo: null, source: null });
    assert.equal(hookRepo.isForeignRepo(null), false);
    assert.equal(hookRepo.isForeignRepo(DEFAULT_ISSUE_REPO), false);
    assert.equal(hookRepo.isForeignRepo(DESIGN), true);
    // -R explícito vence o origin do cwd (merge do design a partir do checkout do studio).
    assert.equal(
      hookRepo.isForeignRepoGhCommand(`gh pr merge 23 -R ${DESIGN}`, "/x", {
        execFn: fakeOrigin("https://github.com/vjpixel/diaria-studio.git"),
      }),
      true,
    );
  });

  it("pr-create-review: URL do PR criado decide", () => {
    assert.equal(isForeignRepoPrUrl(`https://github.com/${DESIGN}/pull/23`), true);
    assert.equal(isForeignRepoPrUrl("https://github.com/vjpixel/diaria-studio/pull/10650"), false);
    assert.equal(isForeignRepoPrUrl("não é url"), false);
  });
});

describe("merge lock POR REPO (#10618)", () => {
  it("dois repos não se serializam; o do studio segue em .merge-lock.json", () => {
    const root = tmpRoot("lock");
    assert.equal(mergeLockPath(root), join(root, "data", "sessions", ".merge-lock.json"));
    assert.ok(acquireMergeLock(root, "coord-A"), "studio livre");
    assert.ok(existsSync(join(root, "data", "sessions", ".merge-lock.json")));
    // Outra sessão no design: o lock do studio preso NÃO a impede.
    assert.ok(acquireMergeLock(root, "coord-B", Date.now(), undefined, undefined, DESIGN), "design livre mesmo com studio preso");
    assert.ok(existsSync(join(root, "data", "sessions", ".merge-lock--vjpixel--diaria-design.json")));
    // Dentro do MESMO repo continua exclusivo.
    assert.equal(acquireMergeLock(root, "coord-C"), false);
    assert.equal(acquireMergeLock(root, "coord-C", Date.now(), undefined, undefined, DESIGN), false);
    // Renovar/liberar mira o repo certo.
    assert.equal(renewMergeLock(root, "coord-B"), false, "B não segura o do studio");
    assert.ok(renewMergeLock(root, "coord-B", Date.now(), undefined, DESIGN));
    assert.equal(releaseMergeLock(root, "coord-B"), false, "release sem repo mira o studio, que é do A");
    assert.ok(releaseMergeLock(root, "coord-B", DESIGN));
    assert.ok(existsSync(join(root, "data", "sessions", ".merge-lock.json")), "studio intacto");
    assert.ok(releaseMergeLock(root, "coord-A"));
  });

  it("CLI: --repo ausente = studio; --repo inválido falha alto", () => {
    assert.equal(requireRepoFlag({}), DEFAULT_ISSUE_REPO);
    assert.equal(requireRepoFlag({ repo: "VJPixel/Diaria-Design" }), DESIGN);
    assert.throws(() => requireRepoFlag({ repo: "diaria-design" }), /--repo inválido/);
  });

  it("CLI de claim: --issue N segue funcionando; owner/repo#N do studio vira N; de outro repo é recusado", () => {
    assert.equal(requireLegacyClaimIssue({ issue: "10618" }), 10618);
    assert.equal(requireLegacyClaimIssue({ issue: "#10618" }), 10618);
    assert.equal(requireLegacyClaimIssue({ issue: "vjpixel/diaria-studio#10618" }), 10618);
    assert.throws(() => requireLegacyClaimIssue({ issue: "vjpixel/diaria-design#21" }), /outro repo/);
    assert.throws(() => requireLegacyClaimIssue({ issue: "21", repo: DESIGN }), /outro repo/);
    assert.throws(() => requireLegacyClaimIssue({ issue: "abc" }), /--issue/);
  });

  it("guard lê o lock do repo alvo", () => {
    const root = tmpRoot("guardlock");
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(root, "data", "sessions", ".merge-lock.json"),
      JSON.stringify({ heldBy: "outra", acquiredAt: new Date(now).toISOString() }),
    );
    assert.equal(readMergeLockHolder(root, now), "outra");
    assert.equal(readMergeLockHolder(root, now, DEFAULT_ISSUE_REPO), "outra");
    assert.equal(readMergeLockHolder(root, now, DESIGN), null);
  });

  it("concessão só vale pro repo em que foi emitida (sem repo = studio)", () => {
    for (const fn of [grantMatchesRepo, consumeGrantMatchesRepo]) {
      assert.equal(fn({ pr: 23 }, DEFAULT_ISSUE_REPO), true);
      assert.equal(fn({ pr: 23 }, DESIGN), false);
      assert.equal(fn({ pr: 23, repo: DESIGN }, DESIGN), true);
      assert.equal(fn({ pr: 23, repo: DESIGN }, DEFAULT_ISSUE_REPO), false);
      assert.equal(fn(null, DESIGN), false);
    }
  });

  it("consume: estado do merge de outro repo é consultado naquele repo", () => {
    const calls: string[][] = [];
    const exec = (_cmd: string, args: string[]) => {
      calls.push(args);
      return JSON.stringify({ state: "MERGED" });
    };
    assert.equal(resolveMergeState(23, exec as never, () => {}, DESIGN).state, "merged");
    assert.ok(calls[0].includes("owner=vjpixel") && calls[0].includes("name=diaria-design"), calls[0].join(" "));
    resolveMergeState(23, exec as never, () => {});
    assert.ok(calls[1].includes("owner={owner}") && calls[1].includes("name={repo}"), "sem repo = repo do cwd, como antes");
  });
});

function sh(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true });
}

describe("e2e: guard do #5716 com lock por repo (#10618)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));

  function setup(lockFile: string): string {
    const root = tmpRoot("guard-e2e");
    const dir = join(root, "data", "sessions");
    mkdirSync(dir, { recursive: true });
    sh("git", ["init", "-q"], root);
    const tag = machineTag();
    const nowIso = new Date().toISOString();
    writeFileSync(
      join(dir, `overnight-${tag}-coord-A.json`),
      JSON.stringify({ kind: "overnight", sessionId: "coord-A", machineTag: tag, startedAt: nowIso, lastHeartbeat: nowIso }),
    );
    writeFileSync(join(dir, lockFile), JSON.stringify({ heldBy: "outra-sessao", acquiredAt: nowIso }));
    return root;
  }

  function run(root: string, command: string): string {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: JSON.stringify({ session_id: "coord-A", tool_name: "Bash", cwd: root, tool_input: { command } }),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    return r.stdout ?? "";
  }

  it("lock do studio preso por outra sessão bloqueia o merge do studio, NÃO o do design", () => {
    const root = setup(".merge-lock.json");
    assert.match(run(root, "gh pr merge 23 --squash"), /"permissionDecision":"deny"/);
    assert.equal(run(root, `gh pr merge 23 --squash -R ${DESIGN}`), "");
  });

  it("lock do design preso bloqueia o merge do design, NÃO o do studio", () => {
    const root = setup(".merge-lock--vjpixel--diaria-design.json");
    assert.match(run(root, `gh pr merge 23 --squash --repo ${DESIGN}`), /"permissionDecision":"deny"/);
    assert.equal(run(root, "gh pr merge 23 --squash"), "");
  });
});

describe("e2e: hook de gh pr create pula PR de outro repo (#10618)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-pr-create-pii-runtime-artifacts.mjs", import.meta.url));

  function makeRepo(origin: string): string {
    const root = tmpRoot("pii-e2e");
    sh("git", ["init", "-q", "-b", "master"], root);
    sh("git", ["config", "user.email", "t@example.com"], root);
    sh("git", ["config", "user.name", "t"], root);
    writeFileSync(join(root, "README.md"), "x\n");
    sh("git", ["add", "README.md"], root);
    sh("git", ["commit", "-q", "-m", "base"], root);
    sh("git", ["checkout", "-q", "-b", "feat"], root);
    // Artefato de rascunho de sessão — a regra do diaria-studio recusa.
    writeFileSync(join(root, "_prbody.md"), "corpo\n");
    sh("git", ["add", "_prbody.md"], root);
    sh("git", ["commit", "-q", "-m", "artefato"], root);
    sh("git", ["remote", "add", "origin", origin], root);
    return root;
  }

  function run(root: string, command: string): string {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: JSON.stringify({ tool_name: "Bash", cwd: root, tool_input: { command } }),
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    return r.stdout ?? "";
  }

  it("PR do diaria-studio continua bloqueado (controle)", () => {
    const root = makeRepo("https://github.com/vjpixel/diaria-studio.git");
    assert.match(run(root, "gh pr create --title t --body b"), /"permissionDecision":"deny"/);
  });

  it("checkout do diaria-design: regra do diaria-studio não se aplica", () => {
    const root = makeRepo(`git@github.com:${DESIGN}.git`);
    assert.equal(run(root, "gh pr create --title t --body b"), "");
  });

  it("-R explícito pro design também pula, mesmo com origin do studio", () => {
    const root = makeRepo("https://github.com/vjpixel/diaria-studio.git");
    assert.equal(run(root, `gh pr create -R ${DESIGN} --title t --body b`), "");
  });

  it("os hooks de PR do diaria-studio importam o mesmo helper", () => {
    for (const f of [
      "block-pr-create-orchestrator-snapshot-stale.mjs",
      "block-pr-create-tsc-failure.mjs",
      "block-pr-create-test-runner-import.mjs",
      "block-pr-create-pii-runtime-artifacts.mjs",
    ]) {
      const src = readFileSync(join(ROOT, ".claude", "hooks", f), "utf8");
      assert.match(src, /if \(isForeignRepoGhCommand\(command, cwd\)\) return;/, f);
    }
  });
});
