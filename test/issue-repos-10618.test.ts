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
  registerSession,
  grantMergeWindow,
  grantRepoOf,
  mergeLocksHeldBy,
} from "../scripts/lib/session-registry.ts";
// Hooks sem `.d.mts`: import dinâmico tipado à mão (evita TS7016 no ratchet).
type Grant = { pr?: number; repo?: string } | null;
const hookPath = (f: string) => new URL(`../.claude/hooks/${f}`, import.meta.url).href;
const {
  grantMatchesRepo,
  readMergeLockHolder,
  readLiveMergeGrantFor,
  readLiveSelfAuthorizationFor,
  resolveMainRepoRoot: guardResolveMainRepoRoot,
} = (await import(hookPath("block-gh-pr-merge-subagent.mjs"))) as {
  grantMatchesRepo: (g: Grant, repo: string) => boolean;
  readMergeLockHolder: (root: string, now?: number, repo?: string) => string | null | undefined;
  readLiveMergeGrantFor: (root: string, sid: string, now?: number, repo?: string) => { grantedBy: string } | null;
  readLiveSelfAuthorizationFor: (root: string, sid: string, now?: number, repo?: string) => { repo?: string } | null;
  resolveMainRepoRoot: (execFn: () => string, looks?: unknown, hookDir?: string) => string | null;
};
const { isForeignRepoPrUrl } = (await import(hookPath("pr-create-review.mjs"))) as {
  isForeignRepoPrUrl: (url: string) => boolean;
};
const {
  grantMatchesRepo: consumeGrantMatchesRepo,
  resolveMergeState,
  stateQueryRepo,
  findLiveMergeGrantFile,
  consumeGrantUnderLock,
  resolveMainRepoRoot: consumeResolveMainRepoRoot,
} = (await import(hookPath("consume-merge-grant-on-merge.mjs"))) as {
  grantMatchesRepo: (g: Grant, repo: string) => boolean;
  findLiveMergeGrantFile: (
    root: string,
    sid: string,
    now: number,
    includeBackups: boolean,
    pr?: number,
    repo?: string,
  ) => { grant: { grantedBy: string } } | null;
  consumeGrantUnderLock: (
    root: string,
    sid: string,
    nowIso: string,
    attempts: number,
    lockTimeoutMs: number,
    pr?: number,
    opts?: { repo?: string },
  ) => boolean;
  resolveMainRepoRoot: (execFn: () => string, looks?: unknown, hookDir?: string) => string | null;
  stateQueryRepo: (r: { grantRepo: string | null; explicitRepo: string | null }) => string | undefined;
  resolveMergeState: (
    pr: number,
    exec: unknown,
    log: (...a: unknown[]) => void,
    repo?: string,
  ) => { state: string; raw: unknown };
};

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
  const seg = (command: string) => hookRepo.ghPrSegments(command).map((s) => ({ repo: s.repo, source: s.source }));
  const fakeOrigin = (url: string) => () => url;
  const boom = () => {
    throw new Error("not a git repo");
  };

  it("-R/--repo/--repo=; URL de PR; GH_REPO=; senão nada explícito", () => {
    assert.deepEqual(seg(`gh pr merge 23 --squash -R ${DESIGN}`), [{ repo: DESIGN, source: "flag" }]);
    assert.deepEqual(seg(`gh pr merge --repo=${DESIGN} 23`), [{ repo: DESIGN, source: "flag" }]);
    assert.deepEqual(seg(`gh pr create --repo "${DESIGN}" --title t`), [{ repo: DESIGN, source: "flag" }]);
    assert.deepEqual(seg(`gh pr merge https://github.com/${DESIGN}/pull/23 --squash`), [{ repo: DESIGN, source: "pr-url" }]);
    assert.deepEqual(seg(`GH_REPO=${DESIGN} gh pr merge 23`), [{ repo: DESIGN, source: "gh-repo-env" }]);
    assert.deepEqual(seg("gh pr merge 23 --squash"), [{ repo: null, source: null }]);
  });

  it("valor de flag que consome argumento nunca é lido como -R/URL", () => {
    assert.deepEqual(seg(`gh pr create --title t --body "use -R ${DESIGN} lá"`), [{ repo: null, source: null }]);
    assert.deepEqual(seg(`gh pr create --title -R --body x`), [{ repo: null, source: null }]);
    assert.deepEqual(seg(`gh pr merge 23 --subject https://github.com/${DESIGN}/pull/9`), [{ repo: null, source: null }]);
    assert.deepEqual(seg(`gh pr merge 23 -b https://github.com/${DESIGN}/pull/9 -A x`), [{ repo: null, source: null }]);
  });

  it("valor explícito ilegível ou contraditório é ESTRITO (nunca cai pro cwd)", () => {
    for (const cmd of [
      "gh pr merge 23 -R $REPO",
      'gh pr merge 23 --repo "$REPO"',
      "gh pr merge 23 -R ghe.host/o/r",
      `gh pr merge https://github.com/${DESIGN}/pull/23 -R vjpixel/diaria-studio`,
      "gh pr merge 23 -R a--b/c",
    ]) {
      assert.deepEqual(seg(cmd), [{ repo: null, source: "unparseable" }], cmd);
      // Mesmo com o cwd sendo um checkout do design, o alvo vira o diaria-studio.
      assert.deepEqual(
        hookRepo.resolveGhTargets(cmd, "/x", { execFn: fakeOrigin(`https://github.com/${DESIGN}.git`) }),
        [{ repo: DEFAULT_ISSUE_REPO, source: "unparseable" }],
        cmd,
      );
    }
  });

  it("GH_REPO=$X antes do gh: segmento ilegível e comando complexo (studio + tudo que pode tocar)", () => {
    assert.deepEqual(seg("GH_REPO=$X gh pr merge 23"), [{ repo: null, source: "unparseable" }]);
    const t = hookRepo.resolveGhTargets("GH_REPO=$X gh pr merge 23", "/x", { execFn: fakeOrigin(`https://github.com/${DESIGN}.git`) });
    assert.ok(hookRepo.isComplexTarget(t));
    assert.deepEqual(t.map((x) => x.repo).sort(), [DEFAULT_ISSUE_REPO, DESIGN].sort());
  });

  it("TODOS os segmentos contam (não só o último)", () => {
    assert.deepEqual(
      hookRepo.resolveGhTargets(`gh pr merge 1 && gh pr merge 2 -R ${DESIGN}`, "/x", { execFn: boom }).map((t) => t.repo),
      [DEFAULT_ISSUE_REPO, DESIGN],
    );
    assert.deepEqual(hookRepo.resolveGhTargetRepo(`gh pr merge 1 && gh pr merge 2 -R ${DESIGN}`, "/x", { execFn: boom }), {
      repo: null,
      source: "mixed",
    });
  });

  it("cd X antes do gh: origin de X; com cdStrict o diaria-studio também entra", () => {
    const calls: Array<string | undefined> = [];
    const exec = (_c: string, _a: string[], o: { cwd?: string }) => {
      calls.push(o.cwd);
      return `https://github.com/${DESIGN}.git`;
    };
    const cmd = "cd ../design-wt && gh pr merge 23";
    const plain = hookRepo.resolveGhTargets(cmd, "/repo/studio", { execFn: exec });
    assert.deepEqual(plain, [{ repo: DESIGN, source: "cd-origin" }]);
    assert.ok(String(calls[0]).replaceAll("\\", "/").endsWith("/repo/design-wt"), String(calls[0]));
    assert.deepEqual(
      hookRepo.resolveGhTargets(cmd, "/repo/studio", { execFn: exec, cdStrict: true }).map((t) => t.repo),
      [DESIGN, DEFAULT_ISSUE_REPO],
    );
    // Hooks de gh pr create já passam a raiz do alvo do cd: não reaplica.
    assert.equal(hookRepo.isForeignRepoGhCommand(cmd, "/repo/design-wt", { execFn: exec }), true);
  });

  it("allowlist: só repo de issue_repos é de fora; typo/fork/outro → regras do diaria-studio", () => {
    assert.equal(hookRepo.isForeignRepo(null), false);
    assert.equal(hookRepo.isForeignRepo(DEFAULT_ISSUE_REPO), false);
    assert.equal(hookRepo.isForeignRepo(DESIGN), true);
    assert.equal(hookRepo.isForeignRepo("vjpixel/diaria-desing"), false);
    assert.equal(hookRepo.isForeignRepo("alguem/diaria-design"), false);
    assert.equal(hookRepo.isForeignRepo(DESIGN, new Set()), false, "allowlist vazia");
    assert.deepEqual(hookRepo.resolveGhTargets("gh pr merge 1 -R alguem/fork", "/x", { execFn: boom }), [
      { repo: DEFAULT_ISSUE_REPO, source: "flag:fora-da-allowlist" },
    ]);
    assert.ok(hookRepo.loadAllowedForeignRepos().has(DESIGN), "config real permite o diaria-design");
  });

  it("remote ssh/https do origin; owner com -- recusado", () => {
    assert.equal(hookRepo.repoFromRemoteUrl("git@github.com:vjpixel/diaria-design.git"), DESIGN);
    assert.equal(hookRepo.repoFromRemoteUrl("https://github.com/vjpixel/diaria-studio.git\n"), DEFAULT_ISSUE_REPO);
    assert.equal(hookRepo.repoFromRemoteUrl("/srv/git/bare.git"), null);
    assert.equal(hookRepo.normalizeRepoSlug("a--b/c"), null);
    assert.equal(normalizeRepoSlug("a--b/c"), null);
  });

  it("origin do cwd quando o comando não diz; indeterminado = diaria-studio", () => {
    assert.deepEqual(
      hookRepo.resolveGhTargetRepo("gh pr create --title t", "/x", { execFn: fakeOrigin(`https://github.com/${DESIGN}.git`) }),
      { repo: DESIGN, source: "cwd-origin" },
    );
    assert.deepEqual(hookRepo.resolveGhTargets("gh pr create", "/x", { execFn: boom }), [
      { repo: DEFAULT_ISSUE_REPO, source: null },
    ]);
    assert.equal(
      hookRepo.isForeignRepoGhCommand(`gh pr merge 23 -R ${DESIGN}`, "/x", {
        execFn: fakeOrigin("https://github.com/vjpixel/diaria-studio.git"),
      }),
      true,
    );
  });

  it("pr-create-review: URL do PR criado decide (com allowlist)", () => {
    assert.equal(isForeignRepoPrUrl(`https://github.com/${DESIGN}/pull/23`), true);
    assert.equal(isForeignRepoPrUrl("https://github.com/vjpixel/diaria-studio/pull/10650"), false);
    assert.equal(isForeignRepoPrUrl("https://github.com/alguem/fork/pull/1"), false);
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
    assert.throws(() => requireRepoFlag({}, new Set(["repo"])), /--repo sem valor/);
    assert.throws(() => requireRepoFlag({ repo: "" }), /--repo sem valor/);
  });

  it("CLI de claim: --issue N segue funcionando; owner/repo#N do studio vira N; de outro repo é recusado", () => {
    assert.equal(requireLegacyClaimIssue({ issue: "10618" }), 10618);
    assert.equal(requireLegacyClaimIssue({ issue: "#10618" }), 10618);
    assert.equal(requireLegacyClaimIssue({ issue: "vjpixel/diaria-studio#10618" }), 10618);
    assert.throws(() => requireLegacyClaimIssue({ issue: "vjpixel/diaria-design#21" }), /outro repo/);
    assert.throws(() => requireLegacyClaimIssue({ issue: "21", repo: DESIGN }), /outro repo/);
    assert.throws(() => requireLegacyClaimIssue({ issue: "abc" }), /--issue/);
    assert.throws(() => requireLegacyClaimIssue({ issue: "" }), /--issue/);
    assert.throws(
      () => requireLegacyClaimIssue({ issue: "vjpixel/diaria-studio#5", repo: DESIGN }),
      /repos diferentes/,
    );
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

  /** Checkout git vazio com `origin` apontando pra `repo` (o hook lê o origin). */
  function checkout(repo: string): string {
    const dir = tmpRoot("checkout");
    sh("git", ["init", "-q"], dir);
    sh("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], dir);
    return dir;
  }

  function run(root: string, command: string, cwd: string = root): string {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: JSON.stringify({ session_id: "coord-A", tool_name: "Bash", cwd, tool_input: { command } }),
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
    const out = run(root, `gh pr merge 23 --squash --repo ${DESIGN}`);
    assert.match(out, /"permissionDecision":"deny"/);
    assert.match(out, /--repo vjpixel\/diaria-design/, "a mensagem pede o --repo");
    assert.equal(run(root, "gh pr merge 23 --squash"), "");
  });

  it("A: merge do studio + merge do design no MESMO comando confere o lock do studio também", () => {
    const root = setup(".merge-lock.json");
    const out = run(root, `gh pr merge 23 --squash && gh pr merge 23 --squash -R ${DESIGN}`);
    assert.match(out, /"permissionDecision":"deny"/);
    assert.match(out, /forma que o guard consegue provar/);
  });

  it("B: cd pro checkout do design com o lock do design preso → bloqueia (o cwd do payload é o studio)", () => {
    const root = setup(".merge-lock--vjpixel--diaria-design.json");
    const design = checkout(DESIGN);
    assert.match(run(root, `cd "${design}" && gh pr merge 23 --squash`), /"permissionDecision":"deny"/);
  });

  it("B: cd pro checkout do design com o lock do STUDIO preso → bloqueia também (cd sem -R é estrito)", () => {
    const root = setup(".merge-lock.json");
    const design = checkout(DESIGN);
    assert.match(run(root, `cd "${design}" && gh pr merge 23 --squash`), /"permissionDecision":"deny"/);
  });

  it("B: cwd no checkout do design, cd pro checkout do studio com o lock do studio preso → bloqueia", () => {
    const root = setup(".merge-lock.json");
    const design = checkout(DESIGN);
    const studio = checkout(DEFAULT_ISSUE_REPO);
    assert.match(run(root, `cd "${studio}" && gh pr merge 23 --squash`, design), /"permissionDecision":"deny"/);
  });

  it("C: -R com variável não expandida cai no lock do studio (nunca no origin do cwd)", () => {
    const root = setup(".merge-lock.json");
    const design = checkout(DESIGN);
    assert.match(run(root, "gh pr merge 23 --squash -R $REPO", design), /"permissionDecision":"deny"/);
    assert.match(run(root, "gh pr merge 23 --squash -R ghe.host/o/r", design), /"permissionDecision":"deny"/);
  });

  it("D: repo fora da allowlist (fork/typo) recebe o lock do studio", () => {
    const root = setup(".merge-lock.json");
    assert.match(run(root, "gh pr merge 23 --squash -R vjpixel/diaria-desing"), /"permissionDecision":"deny"/);
  });

  it("E: URL e -R discordando → estrito (lock do studio)", () => {
    const root = setup(".merge-lock.json");
    assert.match(
      run(root, `gh pr merge https://github.com/${DESIGN}/pull/23 -R vjpixel/diaria-studio`),
      /"permissionDecision":"deny"/,
    );
  });

  it("loga o repo alvo e a origem no run-log", () => {
    const root = setup(".merge-lock--vjpixel--diaria-design.json");
    run(root, `gh pr merge 23 --squash -R ${DESIGN}`);
    const log = readFileSync(join(root, "data", "run-log.jsonl"), "utf8");
    assert.match(log, /"message":"merge_target_repo"/);
    assert.match(log, /"mode":"foreign-whitelist","targets":\["vjpixel\/diaria-design"\]/);
  });
});

describe("escritores de concessão por repo (#10618 F)", () => {
  const tag = machineTag();
  function root(): string {
    const r = tmpRoot("grant-writers");
    mkdirSync(join(r, "data", "sessions"), { recursive: true });
    return r;
  }

  it("repo ilegível é recusado na escrita; repo default não é gravado", () => {
    const r = root();
    registerSession(r, "develop", "A", { tag });
    assert.throws(() => grantMergeWindow(r, "develop", "A", "benef", { pr: 1, repo: "ghe.host/o/r", tag }), /repo inválido/);
    assert.equal(grantMergeWindow(r, "develop", "A", "benef", { pr: 1, repo: DEFAULT_ISSUE_REPO, tag }).ok, true);
    const rec = JSON.parse(readFileSync(join(r, "data", "sessions", `develop-${tag}-A.json`), "utf8"));
    assert.equal(rec.merge_grant.repo, undefined);
  });

  it("mesma concedente: o MESMO PR em outro repo não sobrescreve a concessão viva em silêncio", () => {
    const r = root();
    registerSession(r, "develop", "A", { tag });
    assert.equal(grantMergeWindow(r, "develop", "A", "benef", { pr: 23, tag }).ok, true);
    const second = grantMergeWindow(r, "develop", "A", "benef", { pr: 23, repo: DESIGN, tag });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "live-grant-would-be-overwritten");
  });

  it("choque entre coordenadoras só no MESMO repo", () => {
    const r = root();
    registerSession(r, "develop", "A", { tag });
    registerSession(r, "overnight", "B", { tag });
    assert.equal(grantMergeWindow(r, "develop", "A", "benef", { pr: 23, tag }).ok, true);
    assert.equal(grantMergeWindow(r, "overnight", "B", "benef2", { pr: 23, repo: DESIGN, tag }).ok, true, "outro repo: sem choque");
    const r2 = root();
    registerSession(r2, "develop", "A", { tag });
    registerSession(r2, "overnight", "B", { tag });
    assert.equal(grantMergeWindow(r2, "develop", "A", "benef", { pr: 23, tag }).ok, true);
    const clash = grantMergeWindow(r2, "overnight", "B", "benef2", { pr: 23, tag });
    assert.equal(clash.reason, "pr-already-granted-elsewhere");
  });

  it("leitores: repo presente mas ilegível não casa com nada; auto-autorização filtra por repo no leitor", () => {
    assert.equal(grantMatchesRepo({ pr: 1, repo: "lixo" }, DEFAULT_ISSUE_REPO), false);
    assert.equal(consumeGrantMatchesRepo({ pr: 1, repo: "lixo" }, DEFAULT_ISSUE_REPO), false);
    assert.equal(grantRepoOf({ repo: "lixo" }), null);
    assert.equal(grantRepoOf({}), DEFAULT_ISSUE_REPO);
    const r = root();
    const now = new Date().toISOString();
    writeFileSync(
      join(r, "data", "sessions", `interactive-${tag}-me.json`),
      JSON.stringify({
        kind: "interactive",
        sessionId: "me",
        machineTag: tag,
        lastHeartbeat: now,
        self_authorized_merge: { reason: "x", pr: 23, repo: DESIGN, authorizedAt: now },
      }),
    );
    assert.equal(readLiveSelfAuthorizationFor(r, "me", Date.now(), DESIGN)?.repo, DESIGN);
    assert.equal(readLiveSelfAuthorizationFor(r, "me", Date.now(), DEFAULT_ISSUE_REPO), null);
  });

  it("CLI grant-merge --repo grava o repo no record; release sem --repo avisa do lock do outro repo", () => {
    const r = root();
    sh("git", ["init", "-q"], r);
    writeFileSync(join(r, "package.json"), JSON.stringify({ name: "diaria-studio" }));
    const cli = (...args: string[]) =>
      // `--import` com a URL resolvida daqui: o cwd do CLI é um diretório
      // temporário sem node_modules, onde `--import tsx` não resolveria.
      spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(ROOT, "scripts", "lib", "session-registry.ts"), ...args], {
        cwd: r,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      });
    const reg = cli("register", "--kind", "develop", "--session-id", "A");
    assert.equal(reg.status, 0, reg.stderr + reg.stdout);
    const g = cli("grant-merge", "--kind", "develop", "--session-id", "A", "--granted-to", "benef", "--pr", "23", "--repo", DESIGN);
    assert.equal(g.status, 0, g.stderr + g.stdout);
    const rec = JSON.parse(readFileSync(join(r, "data", "sessions", `develop-${tag}-A.json`), "utf8"));
    assert.equal(rec.merge_grant.repo, DESIGN);
    const acq = cli("merge-lock-acquire", "--session-id", "A", "--pr", "23", "--repo", DESIGN);
    assert.match(acq.stdout, /merge-lock-acquire ok \[repo=vjpixel\/diaria-design\]/);
    const rel = cli("merge-lock-release", "--session-id", "A", "--pr", "23");
    assert.match(rel.stdout, /merge-lock-release ok \[repo=vjpixel\/diaria-studio\]/);
    assert.match(rel.stderr, /--repo vjpixel\/diaria-design/);
    const ren = cli("merge-lock-renew", "--session-id", "A");
    assert.match(ren.stdout, /\[repo=vjpixel\/diaria-studio\]/);
    assert.match(ren.stderr, /--repo vjpixel\/diaria-design/);
    const bare = cli("merge-lock-release", "--session-id", "A", "--repo");
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr + bare.stdout, /--repo sem valor/);
    assert.deepEqual(mergeLocksHeldBy(r, "A"), [DESIGN]);
  });
});

describe("resolveMainRepoRoot sem checkout do diaria-studio → indeterminado (#10618 G)", () => {
  it("nenhum candidato com data/sessions nem package.json do studio → null", () => {
    const foreign = tmpRoot("foreign-hook");
    for (const fn of [guardResolveMainRepoRoot, consumeResolveMainRepoRoot]) {
      assert.equal(fn(() => join(foreign, ".git"), undefined, join(foreign, ".claude", "hooks")), null);
    }
  });
});

describe("consume: repo explícito na consulta de estado sempre que determinado (#10618 H)", () => {
  it("explícito (inclusive o studio via -R) vai explícito; sem repo explícito ou estrito não", () => {
    const boom = () => {
      throw new Error("sem git");
    };
    const res = (c: string) => hookRepo.resolveMergeTargets(c, "/x", { execFn: boom });
    assert.equal(stateQueryRepo(res(`gh pr merge 23 -R ${DESIGN}`)), DESIGN);
    assert.equal(stateQueryRepo(res("gh pr merge 23 -R vjpixel/diaria-studio")), DEFAULT_ISSUE_REPO);
    assert.equal(stateQueryRepo(res("gh pr merge 23 --squash")), undefined);
    assert.equal(stateQueryRepo(res("gh pr merge 23 --squash # x")), undefined);
  });
});

describe("e2e: guard de PII/artefato vale pra PR de QUALQUER repo (#10618)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-pr-create-pii-runtime-artifacts.mjs", import.meta.url));

  function makeRepo(origin: string, branch = "master"): string {
    const root = tmpRoot("pii-e2e");
    sh("git", ["init", "-q", "-b", branch], root);
    sh("git", ["config", "user.email", "t@example.com"], root);
    sh("git", ["config", "user.name", "t"], root);
    writeFileSync(join(root, "README.md"), "x\n");
    sh("git", ["add", "README.md"], root);
    sh("git", ["commit", "-q", "-m", "base"], root);
    sh("git", ["checkout", "-q", "-b", "feat"], root);
    // Artefato de rascunho de sessão — o guard de segurança recusa.
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

  it("PR do diaria-studio bloqueado", () => {
    const root = makeRepo("https://github.com/vjpixel/diaria-studio.git");
    assert.match(run(root, "gh pr create --title t --body b"), /"permissionDecision":"deny"/);
  });

  it("checkout do diaria-design TAMBÉM bloqueado (guard de segurança, não regra editorial)", () => {
    const root = makeRepo(`git@github.com:${DESIGN}.git`);
    assert.match(run(root, "gh pr create --title t --body b"), /"permissionDecision":"deny"/);
  });

  it("J: branch default `main` (como o diaria-design) é a base — antes passava sem auditoria", () => {
    const root = makeRepo(`git@github.com:${DESIGN}.git`, "main");
    const out = run(root, "gh pr create --title t --body b");
    assert.match(out, /"permissionDecision":"deny"/);
    assert.match(out, /_prbody/, "recusado pelo artefato, não por falta de base");
  });

  it("J: sem branch base nenhuma → fail-closed com mensagem clara", () => {
    const root = makeRepo(`git@github.com:${DESIGN}.git`, "trunk");
    const out = run(root, "gh pr create --title t --body b");
    assert.match(out, /"permissionDecision":"deny"/);
    assert.match(out, /não achei a branch base/);
  });

  it("J: -R pra OUTRO repo que não o checkout auditado → recusa (diffaria a branch errada)", () => {
    const root = makeRepo("https://github.com/vjpixel/diaria-studio.git");
    const out = run(root, `gh pr create -R ${DESIGN} --title t --body b`);
    assert.match(out, /"permissionDecision":"deny"/);
    assert.match(out, /checkout auditado/);
  });

  it("J: -R ilegível → recusa; -R igual ao origin segue o fluxo normal", () => {
    const root = makeRepo("https://github.com/vjpixel/diaria-studio.git");
    assert.match(run(root, "gh pr create -R $REPO --title t --body b"), /ilegível ou contraditório/);
    assert.match(run(root, "gh pr create -R vjpixel/diaria-studio --title t --body b"), /_prbody/);
  });

  it("o hook de PII não usa o helper de repo (nunca pula por repo)", () => {
    const src = readFileSync(join(ROOT, ".claude", "hooks", "block-pr-create-pii-runtime-artifacts.mjs"), "utf8");
    assert.doesNotMatch(src, /isForeignRepoGhCommand\(/);
  });
});

describe("e2e: hooks de regra do diaria-studio pulam PR de outro repo (#10618)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-pr-create-test-runner-import.mjs", import.meta.url));

  function makeRepo(origin: string): string {
    const root = tmpRoot("runner-e2e");
    sh("git", ["init", "-q"], root);
    mkdirSync(join(root, "test"), { recursive: true });
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "lib", "test-runner-import-guard.ts"),
      readFileSync(join(ROOT, "scripts", "lib", "test-runner-import-guard.ts"), "utf8"),
    );
    writeFileSync(join(root, "test", "bad.test.ts"), 'import { describe } from "vitest";\ndescribe("x", () => {});\n');
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

  it("diaria-studio: runner proibido bloqueia (controle)", () => {
    const root = makeRepo("https://github.com/vjpixel/diaria-studio.git");
    assert.match(run(root, "gh pr create --title t --body b"), /"permissionDecision":"deny"/);
  });

  it("checkout do diaria-design: regra do diaria-studio não se aplica", () => {
    const root = makeRepo(`git@github.com:${DESIGN}.git`);
    assert.equal(run(root, "gh pr create --title t --body b"), "");
  });

  it("-R explícito pro design pula, mesmo com origin do studio", () => {
    const root = makeRepo("https://github.com/vjpixel/diaria-studio.git");
    assert.equal(run(root, `gh pr create -R ${DESIGN} --title t --body b`), "");
  });

  it("hook de tsc também pula o checkout do diaria-design (antes de procurar o tsc)", () => {
    const tscHook = fileURLToPath(new URL("../.claude/hooks/block-pr-create-tsc-failure.mjs", import.meta.url));
    const root = makeRepo(`git@github.com:${DESIGN}.git`);
    const r = spawnSync(process.execPath, [tscHook], {
      cwd: root,
      input: JSON.stringify({ tool_name: "Bash", cwd: root, tool_input: { command: "gh pr create --title t --body b" } }),
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(r.stdout ?? "", "");
  });

  it("snapshot/tsc/test-runner usam o helper; o review dispara em qualquer repo e só pula o Closes", () => {
    for (const f of [
      "block-pr-create-orchestrator-snapshot-stale.mjs",
      "block-pr-create-tsc-failure.mjs",
      "block-pr-create-test-runner-import.mjs",
    ]) {
      const src = readFileSync(join(ROOT, ".claude", "hooks", f), "utf8");
      assert.match(src, /if \(isForeignRepoGhCommand\(command, cwd\)\) return;/, f);
    }
    const review = readFileSync(join(ROOT, ".claude", "hooks", "pr-create-review.mjs"), "utf8");
    assert.doesNotMatch(review, /reason: "foreign_repo"/, "review não é mais suprimido por repo");
    assert.match(review, /isForeignRepoPrUrl\(prUrl\)\s*\?\s*null\s*:\s*closeKeywordWarning\(ensureCloseKeywords/);
  });
});

describe("concessão filtrada por repo ANTES de escolher (#10618)", () => {
  function grantRoot(): string {
    const root = tmpRoot("grants");
    const dir = join(root, "data", "sessions");
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const tag = machineTag();
    // Duas coordenadoras concederam janela pro MESMO PR #23, cada uma num repo.
    writeFileSync(
      join(dir, `develop-${tag}-a-studio.json`),
      JSON.stringify({
        kind: "develop",
        sessionId: "a-studio",
        machineTag: tag,
        lastHeartbeat: now,
        merge_grant: { grantedTo: "benef", grantedBy: "a-studio", pr: 23, grantedAt: now },
      }),
    );
    writeFileSync(
      join(dir, `overnight-${tag}-b-design.json`),
      JSON.stringify({
        kind: "overnight",
        sessionId: "b-design",
        machineTag: tag,
        lastHeartbeat: now,
        merge_grant: { grantedTo: "benef", grantedBy: "b-design", pr: 23, repo: DESIGN, grantedAt: now },
      }),
    );
    return root;
  }

  it("guard: readLiveMergeGrantFor devolve a do repo pedido (nos dois sentidos)", () => {
    const root = grantRoot();
    assert.equal(readLiveMergeGrantFor(root, "benef", Date.now(), DESIGN)?.grantedBy, "b-design");
    assert.equal(readLiveMergeGrantFor(root, "benef", Date.now(), DEFAULT_ISSUE_REPO)?.grantedBy, "a-studio");
  });

  it("consume: findLiveMergeGrantFile devolve a do repo pedido (nos dois sentidos)", () => {
    const root = grantRoot();
    assert.equal(findLiveMergeGrantFile(root, "benef", Date.now(), true, 23, DESIGN)?.grant.grantedBy, "b-design");
    assert.equal(
      findLiveMergeGrantFile(root, "benef", Date.now(), true, 23, DEFAULT_ISSUE_REPO)?.grant.grantedBy,
      "a-studio",
    );
  });

  it("consume: consumeGrantUnderLock só carimba a concessão do repo do merge", () => {
    const root = grantRoot();
    const dir = join(root, "data", "sessions");
    const tag = machineTag();
    assert.equal(consumeGrantUnderLock(root, "benef", new Date().toISOString(), 1, 500, 23, { repo: DESIGN }), true);
    const design = JSON.parse(readFileSync(join(dir, `overnight-${tag}-b-design.json`), "utf8"));
    const studio = JSON.parse(readFileSync(join(dir, `develop-${tag}-a-studio.json`), "utf8"));
    assert.ok(design.merge_grant.consumedAt);
    assert.equal(studio.merge_grant.consumedAt, undefined);
  });
});

describe("resolveMainRepoRoot com cwd em checkout de outro repo (#10618)", () => {
  it("guard e consume voltam pra raiz do hook quando o git aponta pra repo sem data/sessions", () => {
    const foreign = tmpRoot("foreign");
    for (const fn of [guardResolveMainRepoRoot, consumeResolveMainRepoRoot]) {
      const got = fn(() => join(foreign, ".git"));
      assert.notEqual(got, foreign);
      assert.ok(got !== null && existsSync(join(got, "package.json")), String(got));
    }
    const studioLike = tmpRoot("studiolike");
    mkdirSync(join(studioLike, "data", "sessions"), { recursive: true });
    for (const fn of [guardResolveMainRepoRoot, consumeResolveMainRepoRoot]) {
      assert.equal(fn(() => join(studioLike, ".git")), studioLike);
    }
  });
});

describe("fail-closed: comando fora da forma simples (verificação da PR #10668)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
  const tag = machineTag();

  /**
   * Coordenadora `coord-A` ativa; `lockHolder` segura o lock do diaria-studio;
   * opcionalmente uma concessão viva de coord-A pra `benef` no PR `grantPr`
   * (`grantRepo` ausente = diaria-studio).
   */
  function setup(opts: { lockHolder: string; grantPr?: number; grantRepo?: string }): string {
    const root = tmpRoot("failclosed");
    const dir = join(root, "data", "sessions");
    mkdirSync(dir, { recursive: true });
    sh("git", ["init", "-q"], root);
    sh("git", ["remote", "add", "origin", "https://github.com/vjpixel/diaria-studio.git"], root);
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `overnight-${tag}-coord-A.json`),
      JSON.stringify({
        kind: "overnight",
        sessionId: "coord-A",
        machineTag: tag,
        startedAt: now,
        lastHeartbeat: now,
        ...(opts.grantPr !== undefined
          ? {
              merge_grant: {
                grantedTo: "benef",
                grantedBy: "coord-A",
                pr: opts.grantPr,
                grantedAt: now,
                ...(opts.grantRepo ? { repo: opts.grantRepo } : {}),
              },
            }
          : {}),
      }),
    );
    writeFileSync(join(dir, ".merge-lock.json"), JSON.stringify({ heldBy: opts.lockHolder, acquiredAt: now }));
    return root;
  }

  function checkout(repo: string): string {
    const dir = tmpRoot("co");
    sh("git", ["init", "-q"], dir);
    sh("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], dir);
    return dir;
  }

  function run(root: string, command: string, sessionId = "coord-A", cwd = root): string {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: JSON.stringify({ session_id: sessionId, tool_name: "Bash", cwd, tool_input: { command } }),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    return r.stdout ?? "";
  }

  const DENY = /"permissionDecision":"deny"/;

  // Cada comando da sonda, com o lock do STUDIO na mão de outra sessão: tem
  // que bloquear (antes, todos resolviam pro design e passavam).
  const probeStudio: Array<[string, string]> = [
    ["& solto, studio primeiro", `gh pr merge 6 --squash & gh pr merge 23 -R ${DESIGN} --squash`],
    ["& solto, design primeiro", `gh pr merge 23 -R ${DESIGN} --squash & gh pr merge 6 --squash`],
    ["comentário #", `gh pr merge 6 --squash # -R ${DESIGN}`],
    ["-m booleano + URL do studio + -R design", `gh pr merge -m https://github.com/vjpixel/diaria-studio/pull/6 -R ${DESIGN}`],
    ["; cd . & ...", `gh pr merge 23 -R ${DESIGN}; cd . & gh pr merge 6`],
    ["|&", `gh pr merge 23 -R ${DESIGN} |& gh pr merge 6`],
    ["herestring <<<", `gh pr merge 23 -R ${DESIGN} --body-file=- <<< x`],
  ];
  for (const [name, command] of probeStudio) {
    it(`bloqueia com o lock do studio preso: ${name}`, () => {
      const root = setup({ lockHolder: "outra-sessao" });
      const out = run(root, command);
      assert.match(out, DENY, command);
    });
  }

  it("prefixo/flag global antes do merge: o resolver já é estrito (detecção do merge é a #10688)", () => {
    // `isGhPrMergeCommand` ainda não reconhece estas formas (#10681, PR #10688):
    // até lá o guard nem roda pra elas. O lado deste PR — o alvo — já é estrito.
    for (const command of [`GH_REPO=${DESIGN} gh pr merge 6`, `gh pr -R ${DESIGN} merge 6`, `env gh pr merge 6 -R ${DESIGN}`]) {
      const t = hookRepo.resolveGhTargets(command, "/x", { subcommands: ["merge"], cdStrict: true, execFn: () => { throw new Error("x"); } });
      assert.ok(hookRepo.isComplexTarget(t), command);
      assert.ok(t.some((x) => x.repo === DEFAULT_ISSUE_REPO), command);
    }
  });

  it("subshell/pushd a partir do checkout do design também conferem o lock do studio", () => {
    const root = setup({ lockHolder: "outra-sessao" });
    const design = checkout(DESIGN);
    const studio = checkout(DEFAULT_ISSUE_REPO);
    for (const command of [
      `(cd "${studio}" && gh pr merge 6)`,
      `( cd "${studio}" && gh pr merge 6 )`,
      `pushd "${studio}" && gh pr merge 6`,
    ]) {
      assert.match(run(root, command, "coord-A", design), DENY, command);
    }
  });

  it("-r é booleano no merge: `gh pr merge 6 -r -R design` mira o design (lock do design livre → passa)", () => {
    const root = setup({ lockHolder: "outra-sessao" });
    assert.equal(run(root, `gh pr merge 6 -r -R ${DESIGN}`), "");
    assert.deepEqual(
      hookRepo.ghPrSegments(`gh pr merge 6 -r -R ${DESIGN}`).map((s) => s.repo),
      [DESIGN],
    );
  });

  it("concessão do OUTRO repo nunca vale; comando complexo ignora até a concessão certa", () => {
    // Concessão pro design#23; quem chama é a beneficiária, segurando o lock do studio.
    const rootA = setup({ lockHolder: "benef", grantPr: 23, grantRepo: DESIGN });
    assert.match(run(rootA, "gh pr merge 23 --squash", "benef"), DENY, "concessão é do design, merge é do studio");
    // Concessão certa (studio#123), mas comando complexo: estrito.
    const rootB = setup({ lockHolder: "benef", grantPr: 123 });
    assert.match(run(rootB, "gh pr merge 123 --squash # comentário", "benef"), DENY);
    assert.match(run(rootB, "gh pr merge 123 --squash & true", "benef"), DENY);
  });

  it("casos comuns seguem passando", () => {
    // Coordenadora com o próprio lock.
    const root = setup({ lockHolder: "coord-A" });
    assert.equal(run(root, "gh pr merge 123 --squash"), "");
    assert.equal(run(root, "gh pr merge 123 --squash 2>&1 | tail -5"), "", "2>&1 é redirecionamento, não background");
    // `cd` pro checkout do studio.
    const studio = checkout(DEFAULT_ISSUE_REPO);
    assert.equal(run(root, `cd "${studio}" && gh pr merge 123 --squash`), "");
    // Beneficiária com concessão pro PR, segurando o lock.
    const g = setup({ lockHolder: "benef", grantPr: 123 });
    assert.equal(run(g, "gh pr merge 123 --squash", "benef"), "");
  });

  it("unit: commandComplexity e redirecionamentos", () => {
    assert.deepEqual(hookRepo.commandComplexity("gh pr merge 6 --squash 2>&1 | tail -5"), []);
    assert.deepEqual(hookRepo.commandComplexity("cd x && gh pr merge 6"), []);
    for (const c of [
      "gh pr merge 6 & x",
      "gh pr merge 6 # y",
      "(gh pr merge 6)",
      "{ gh pr merge 6; }",
      "gh pr merge $(echo 6)",
      "gh pr merge `echo 6`",
      "bash -c 'gh pr merge 6'",
      "eval gh pr merge 6",
      "echo 6 | xargs gh pr merge",
      "env gh pr merge 6",
      "command gh pr merge 6",
      "/usr/bin/gh pr merge 6",
      "gh -R x/y pr merge 6",
      "gh pr merge 6 <<EOF\nx\nEOF",
    ]) {
      assert.ok(hookRepo.commandComplexity(c).length > 0, c);
    }
  });
});

describe("hooks de gh pr create com comando complexo (#10618)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-pr-create-test-runner-import.mjs", import.meta.url));
  function makeRepo(origin: string): string {
    const root = tmpRoot("cx-create");
    sh("git", ["init", "-q"], root);
    mkdirSync(join(root, "test"), { recursive: true });
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "lib", "test-runner-import-guard.ts"),
      readFileSync(join(ROOT, "scripts", "lib", "test-runner-import-guard.ts"), "utf8"),
    );
    writeFileSync(join(root, "test", "bad.test.ts"), 'import { describe } from "vitest";\ndescribe("x", () => {});\n');
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

  it("body via $(cat <<EOF) no checkout do design: segue pulando (não reabre o #23)", () => {
    const root = makeRepo(`https://github.com/${DESIGN}.git`);
    assert.equal(run(root, 'gh pr create --title t --body "$(cat <<\'EOF\'\ncorpo\nEOF\n)"'), "");
  });

  it("complexo citando o diaria-studio, ou no checkout do studio: aplica a regra", () => {
    const design = makeRepo(`https://github.com/${DESIGN}.git`);
    assert.match(run(design, 'gh pr create -R vjpixel/diaria-studio --body "$(cat x)"'), /"permissionDecision":"deny"/);
    const studio = makeRepo("https://github.com/vjpixel/diaria-studio.git");
    assert.match(run(studio, 'gh pr create --body "$(cat x)"'), /"permissionDecision":"deny"/);
  });
});

describe("ônus da prova invertido: whitelist estrita de merge de fora (re-verificação da PR #10668)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
  const tag = machineTag();
  const BS = "\\";
  const DENY = /"permissionDecision":"deny"/;

  /** coord-A ativa; `studioLock`/`designLock` = dono de cada lock (ausente = livre);
   * concessão opcional de coord-A pra `benef`. */
  function setup(opts: { studioLock?: string; designLock?: string; grant?: { pr: number; repo?: string } }): string {
    const root = tmpRoot("wl");
    const dir = join(root, "data", "sessions");
    mkdirSync(dir, { recursive: true });
    sh("git", ["init", "-q"], root);
    sh("git", ["remote", "add", "origin", "https://github.com/vjpixel/diaria-studio.git"], root);
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `overnight-${tag}-coord-A.json`),
      JSON.stringify({
        kind: "overnight",
        sessionId: "coord-A",
        machineTag: tag,
        startedAt: now,
        lastHeartbeat: now,
        ...(opts.grant
          ? { merge_grant: { grantedTo: "benef", grantedBy: "coord-A", grantedAt: now, ...opts.grant } }
          : {}),
      }),
    );
    if (opts.studioLock) writeFileSync(join(dir, ".merge-lock.json"), JSON.stringify({ heldBy: opts.studioLock, acquiredAt: now }));
    if (opts.designLock) {
      writeFileSync(join(dir, ".merge-lock--vjpixel--diaria-design.json"), JSON.stringify({ heldBy: opts.designLock, acquiredAt: now }));
    }
    return root;
  }

  function checkout(repo: string): string {
    const dir = tmpRoot("wl-co");
    sh("git", ["init", "-q"], dir);
    sh("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], dir);
    return dir;
  }

  function run(root: string, command: string, sessionId = "coord-A", cwd = root): string {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: JSON.stringify({ session_id: sessionId, tool_name: "Bash", cwd, tool_input: { command } }),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    return r.stdout ?? "";
  }

  // Linhas da sonda rv3 (todas as que não são whitelist legítima). Cada uma tem
  // que bloquear com o lock do STUDIO na mão de outra sessão.
  const fromStudioCwd: Array<[string, string]> = [
    ["A cluster -db -R colado", `gh pr merge 6 --squash -db -R${DESIGN}`],
    ["A2 cluster -st", `gh pr merge 6 -st -R${DESIGN}`],
    ["A3 -dF", `gh pr merge 6 --squash -dF -R ${DESIGN}`],
    ["A4 -sb --repo=", `gh pr merge 6 -sb --repo=${DESIGN}`],
    ["B \\r", `gh pr merge 6 --squash --subject=a\r-R${DESIGN}`],
    ["C ANSI-C", `gh pr merge 5 --squash -R ${DESIGN}; echo $'${BS}''; gh pr merge 6 --squash`],
    ["C2 ANSI-C único", `gh pr merge 6 --squash -R ${DESIGN} $'${BS}'' ; gh pr merge 7 --squash`],
    ["D URL com porta", `gh pr merge https://github.com:443/vjpixel/diaria-studio/pull/6 --squash -R ${DESIGN}`],
    ["D2 URL com userinfo", `gh pr merge https://x@github.com/vjpixel/diaria-studio/pull/6 --squash -R ${DESIGN}`],
    ["D3 URL subdomínio", `gh pr merge https://api.github.com/vjpixel/diaria-studio/pull/6 --squash -R ${DESIGN}`],
    ["G -R duas vezes", `gh pr merge 6 -R ${DESIGN} -R vjpixel/diaria-studio`],
    ["G2 --repo= não canônico", "gh pr merge 6 --repo=VJPIXEL/Diaria-Design.git"],
    ["H -- fim de opções", `gh pr merge --squash -- -R${DESIGN}`],
    ["J && entre aspas", `gh pr merge 6 -R ${DESIGN} --subject 'a && gh pr merge 7'`],
    ["K \\;", `gh pr merge 6 -R ${DESIGN} ${BS}; gh pr merge 7`],
    ["L $'\\n'", `gh pr merge 6 -R ${DESIGN} $'${BS}n' gh pr merge 7`],
    ["M comando longo", `gh pr merge 6 -R ${DESIGN} ` + "x ".repeat(5000)],
    ["R redirecionamento + ;", `gh pr merge 6 -R ${DESIGN} >&2; gh pr merge 7`],
    ["espaço duplo", `gh pr merge 6  -R ${DESIGN}`],
    ["aspas no slug", `gh pr merge 6 -R "${DESIGN}"`],
  ];
  for (const [name, command] of fromStudioCwd) {
    it(`bloqueia (lock do studio com outra sessão): ${name}`, () => {
      assert.match(run(setup({ studioLock: "outra-sessao" }), command), DENY, command);
    });
  }

  // Do checkout do DESIGN: comandos que acabam mergeando no studio por um
  // caminho que o resolver não prova (classe E/F/I/O/P/Q/S/T + D4).
  const fromDesignCwd: Array<[string, string]> = [
    ["D4 URL não canônica sem -R", "gh pr merge https://github.com:443/vjpixel/diaria-studio/pull/6 --squash"],
    ["E builtin cd", "builtin cd STUDIO && gh pr merge 6 --squash"],
    ["E2 if cd", "if cd STUDIO; then :; fi; gh pr merge 6 --squash"],
    ["E3 ! cd", "! cd STUDIO; gh pr merge 6 --squash"],
    ["F export GH_REPO", "export GH_REPO=vjpixel/diaria-studio; gh pr merge 6 --squash"],
    ["F2 declare -x", "declare -x GH_REPO=vjpixel/diaria-studio; gh pr merge 6 --squash"],
    ["I cd sem argumento", "cd && gh pr merge 6"],
    ["I2 cd -", "cd - && gh pr merge 6"],
    ["I3 cd ~", "cd ~/x && gh pr merge 6"],
    ["O case", "case 1 in 1) cd STUDIO;; esac; gh pr merge 6"],
    ["P while", "while cd STUDIO; do break; done; gh pr merge 6"],
    ["Q for", "for d in STUDIO; do cd $d; done; gh pr merge 6"],
    ["S then cd", "true; then cd STUDIO; gh pr merge 6"],
    ["T função", "f() { cd STUDIO; }; f; gh pr merge 6"],
    ["merge simples a partir do design", "gh pr merge 6 --squash"],
  ];
  for (const [name, template] of fromDesignCwd) {
    it(`bloqueia a partir do checkout do design (lock do studio com outra sessão): ${name}`, () => {
      const root = setup({ studioLock: "outra-sessao" });
      const design = checkout(DESIGN);
      const studio = checkout(DEFAULT_ISSUE_REPO).replaceAll("\\", "/");
      const command = template.replaceAll("STUDIO", studio);
      assert.match(run(root, command, "coord-A", design), DENY, command);
    });
  }

  it("concessão do design só vale na whitelist: forma fora dela é recusada mesmo com o lock do design", () => {
    const root = setup({ designLock: "benef", grant: { pr: 23, repo: DESIGN } });
    for (const command of [
      `gh pr merge 23 -sd -R ${DESIGN}`,
      `gh pr merge 23 --squash -R ${DESIGN} # ok`,
      `gh pr merge 23 --squash --repo ${DESIGN} --subject x`,
    ]) {
      assert.match(run(root, command, "benef"), DENY, command);
    }
  });

  it("whitelist positiva do design: -R, URL canônica, os dois concordando, cd pro checkout dele e | tail", () => {
    // Lock do studio com OUTRA sessão: se o studio entrasse no conjunto, bloquearia.
    const root = setup({ studioLock: "outra-sessao" });
    const design = checkout(DESIGN).replaceAll("\\", "/");
    for (const command of [
      `gh pr merge 23 --squash -R ${DESIGN}`,
      `gh pr merge 23 --repo=${DESIGN} -d --squash`,
      `gh pr merge https://github.com/${DESIGN}/pull/23 --squash`,
      `gh pr merge https://github.com/${DESIGN}/pull/23 --squash -R ${DESIGN}`,
      `gh pr merge 23 -m -R ${DESIGN} 2>&1 | tail -5`,
      `cd ${design} && gh pr merge 23 --squash -R ${DESIGN}`,
    ]) {
      assert.equal(run(root, command), "", command);
    }
    // Beneficiária com concessão do design#23 e o lock do design.
    const g = setup({ studioLock: "outra-sessao", designLock: "benef", grant: { pr: 23, repo: DESIGN } });
    assert.equal(run(g, `gh pr merge 23 --squash -R ${DESIGN}`, "benef"), "");
    assert.equal(run(g, `gh pr merge https://github.com/${DESIGN}/pull/23 --squash`, "benef"), "");
  });

  it("casos comuns do studio seguem passando", () => {
    const root = setup({ studioLock: "coord-A" });
    const studio = checkout(DEFAULT_ISSUE_REPO).replaceAll("\\", "/");
    for (const command of [
      "gh pr merge 123 --squash",
      "gh pr merge 123 --squash 2>&1 | tail -5",
      "gh pr merge 123 --squash --delete-branch 2>&1 | tail -20",
      `cd ${studio} && gh pr merge 123 --squash`,
      "gh pr merge 123 --squash --repo vjpixel/diaria-studio",
    ]) {
      assert.equal(run(root, command), "", command);
    }
    const g = setup({ studioLock: "benef", grant: { pr: 123 } });
    assert.equal(run(g, "gh pr merge 123 --squash", "benef"), "");
    assert.equal(run(g, "gh pr merge 123 --squash 2>&1 | tail -5", "benef"), "");
    // Concessão do studio + forma fora da whitelist: recusado (aceitável, a mensagem explica).
    assert.match(run(g, 'gh pr merge 123 --squash --body "$(cat x)"', "benef"), DENY);
  });

  it("unit: parseStrictMerge só aceita a forma exata", () => {
    assert.deepEqual(hookRepo.parseStrictMerge(`gh pr merge 23 --squash -R ${DESIGN}`), { repo: DESIGN, pr: 23, cd: null });
    assert.deepEqual(hookRepo.parseStrictMerge("gh pr merge 23 --squash 2>&1 | tail -5"), { repo: null, pr: 23, cd: null });
    for (const bad of [
      "gh pr merge --squash",
      "gh pr merge 1 2",
      `gh pr merge 1 -R ${DESIGN} -R ${DESIGN}`,
      `gh pr merge https://github.com/${DESIGN}/pull/1 -R vjpixel/diaria-studio`,
      "gh pr merge 1 -sd",
      "gh pr merge 1 --",
      "gh pr merge 1 --subject=x",
      "gh pr merge 1\t--squash",
      "gh pr merge 1 --squash\r",
      "cd ~/x && gh pr merge 1",
      'cd "/x y" && gh pr merge 1',
    ]) {
      assert.equal(hookRepo.parseStrictMerge(bad), null, JSON.stringify(bad));
    }
  });
});

describe("studio-plain só com prova positiva do origin (ataque final à PR #10668)", () => {
  const HOOK = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
  const tag = machineTag();
  const DENY = /"permissionDecision":"deny"/;
  const AT = "@";

  /** `C:\x\y` → `/c/x/y` (forma do Git Bash); em POSIX devolve o próprio caminho. */
  const msys = (p: string) => (/^[A-Za-z]:[\\/]/.test(p) ? `/${p[0].toLowerCase()}/${p.slice(3).replaceAll("\\", "/")}` : p);

  function setup(opts: { studioLock: string; grant?: { pr: number; repo?: string }; origin?: string | null }): string {
    const root = tmpRoot("pos");
    const dir = join(root, "data", "sessions");
    mkdirSync(dir, { recursive: true });
    sh("git", ["init", "-q"], root);
    const origin = opts.origin === undefined ? "https://github.com/vjpixel/diaria-studio.git" : opts.origin;
    if (origin) sh("git", ["remote", "add", "origin", origin], root);
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
    writeFileSync(join(dir, ".merge-lock.json"), JSON.stringify({ heldBy: opts.studioLock, acquiredAt: now }));
    return root;
  }

  function checkout(repo: string): string {
    const dir = tmpRoot("pos-co");
    sh("git", ["init", "-q"], dir);
    sh("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], dir);
    return dir;
  }

  function run(
    root: string,
    command: string,
    o: { sessionId?: string; cwd?: string | null; env?: Record<string, string> } = {},
  ): string {
    const payload: Record<string, unknown> = { session_id: o.sessionId ?? "coord-A", tool_name: "Bash", tool_input: { command } };
    if (o.cwd !== null) payload.cwd = o.cwd ?? root;
    const env = { ...process.env, ...(o.env ?? {}) };
    if (!o.env?.GH_REPO) delete env.GH_REPO;
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env,
    });
    return r.stdout ?? "";
  }

  it("Git Bash: cd /c/... pro checkout do design a partir do studio → estrito (bloqueia com o lock do studio preso)", () => {
    const root = setup({ studioLock: "outra-sessao" });
    const design = msys(checkout(DESIGN));
    assert.match(run(root, `cd ${design} && gh pr merge 5 --squash`), DENY);
  });

  it("Git Bash: cd /c/... pro checkout do studio a partir do design → bloqueia com o lock do studio preso", () => {
    const root = setup({ studioLock: "outra-sessao" });
    const design = checkout(DESIGN);
    const studio = msys(checkout(DEFAULT_ISSUE_REPO));
    assert.match(run(root, `cd ${studio} && gh pr merge 5 --squash`, { cwd: design }), DENY);
  });

  it("origin indeterminado não prova nada: sem payload.cwd, sem origin, alias de host → concessão do studio não conta", () => {
    const g = setup({ studioLock: "benef", grant: { pr: 123 } });
    assert.match(run(g, "gh pr merge 123 --squash", { sessionId: "benef", cwd: null }), DENY, "sem payload.cwd");
    const noOrigin = setup({ studioLock: "benef", grant: { pr: 123 }, origin: null });
    assert.match(run(noOrigin, "gh pr merge 123 --squash", { sessionId: "benef" }), DENY, "sem origin");
    const alias = setup({ studioLock: "benef", grant: { pr: 123 }, origin: "github-work:vjpixel/diaria-studio.git" });
    assert.match(run(alias, "gh pr merge 123 --squash", { sessionId: "benef" }), DENY, "alias de host ssh");
  });

  it("GH_REPO herdado do ambiente sem -R/URL → estrito", () => {
    const g = setup({ studioLock: "benef", grant: { pr: 123 } });
    assert.match(run(g, "gh pr merge 123 --squash", { sessionId: "benef", env: { GH_REPO: DESIGN } }), DENY);
    // Com -R explícito do studio, o -R vence o GH_REPO no gh: forma simples do studio.
    assert.equal(
      run(g, "gh pr merge 123 --squash -R vjpixel/diaria-studio", { sessionId: "benef", env: { GH_REPO: DESIGN } }),
      "",
    );
    const boom = () => {
      throw new Error("x");
    };
    assert.equal(
      hookRepo.resolveMergeTargets("gh pr merge 1", "/x", {
        execFn: () => "https://github.com/vjpixel/diaria-studio.git",
        env: { GH_REPO: DESIGN },
      }).mode,
      "strict",
    );
    assert.equal(hookRepo.resolveMergeTargets("gh pr merge 1", undefined, { execFn: boom, env: {} }).mode, "strict");
  });

  it("caso comum: worktree/checkout do studio, gh pr merge 123 --squash → studio-plain, concessão conta", () => {
    const g = setup({ studioLock: "benef", grant: { pr: 123 } });
    assert.equal(run(g, "gh pr merge 123 --squash", { sessionId: "benef" }), "");
    assert.equal(
      hookRepo.resolveMergeTargets("gh pr merge 123 --squash", "/x", {
        execFn: () => "https://github.com/vjpixel/diaria-studio.git",
        env: {},
      }).mode,
      "studio-plain",
    );
  });

  it("unit: remotes ssh com porta / ssh.github.com; alias de host fica indeterminado", () => {
    assert.equal(hookRepo.repoFromRemoteUrl(`ssh://git${AT}github.com:22/vjpixel/diaria-design.git`), DESIGN);
    assert.equal(hookRepo.repoFromRemoteUrl(`ssh://git${AT}ssh.github.com:443/vjpixel/diaria-design`), DESIGN);
    assert.equal(hookRepo.repoFromRemoteUrl(`git${AT}ssh.github.com:vjpixel/diaria-design.git`), DESIGN);
    assert.equal(hookRepo.repoFromRemoteUrl(`git${AT}github.com:vjpixel/diaria-studio.git`), DEFAULT_ISSUE_REPO);
    assert.equal(hookRepo.repoFromRemoteUrl("https://github.com:443/vjpixel/diaria-studio.git"), DEFAULT_ISSUE_REPO);
    assert.equal(hookRepo.repoFromRemoteUrl("github-work:vjpixel/diaria-studio.git"), null);
  });

  it("unit: caminho MSYS vira nativo só no win32", () => {
    assert.equal(hookRepo.toNativePath("/c/Users/vjpix/x", "win32"), "C:\\Users\\vjpix\\x");
    assert.equal(hookRepo.toNativePath("/D/a/b", "win32"), "D:\\a\\b");
    assert.equal(hookRepo.toNativePath("/c", "win32"), "C:\\");
    assert.equal(hookRepo.toNativePath("/srv/x", "win32"), "/srv/x");
    assert.equal(hookRepo.toNativePath("/c/x", "linux"), "/c/x");
  });
});
