/**
 * test/commit-audience-snapshot-11733.test.ts (#11733 item 2)
 *
 * Regressão: o snapshot de audiência do Stage 0 (0i) ficava parado como
 * modificado/untracked no checkout porque ninguém o commitava. Agora o
 * `commit-audience-snapshot.ts` leva os arquivos para uma PR a partir de um
 * worktree temporário, sem tocar o checkout. O teste de integração usa git
 * de verdade (remoto bare local) e um `gh` falso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildSnapshotCommitTitle,
  buildSnapshotPrBody,
  isAudienceSnapshotPath,
  newSnapshotBranchName,
  pickOpenSnapshotPr,
  selectSnapshotPaths,
} from "../scripts/lib/audience-snapshot-pr.ts";
import { hasRemovalDeclaration } from "../scripts/lib/pr-removal-declaration.ts";
import { commitAudienceSnapshot, type CmdRunner, type SnapshotPrDeps } from "../scripts/commit-audience-snapshot.ts";

describe("audience-snapshot-pr: parte pura", () => {
  it("o corpo da PR rolante nasce com removal-declaration válida para o gate #7115 (#11971)", () => {
    const body = buildSnapshotPrBody([{ code: "A", path: "docs/audience-history/2026-11-03.md" }]);
    assert.equal(hasRemovalDeclaration(body), true);
  });

  it("só os caminhos do 0i contam como snapshot", () => {
    assert.ok(isAudienceSnapshotPath("context/audience-profile.md"));
    assert.ok(isAudienceSnapshotPath("docs/audience-history/2026-10-22.md"));
    assert.ok(isAudienceSnapshotPath("docs/audience-history/_consolidated.md"));
    assert.ok(!isAudienceSnapshotPath("docs/audience-history/sub/2026-10-22.md"));
    assert.ok(!isAudienceSnapshotPath("context/editorial-rules.md"));
    assert.ok(!isAudienceSnapshotPath("scripts/_tmp_dl.ts"));
  });

  it("selectSnapshotPaths pega modificado, untracked e removido; ignora o resto", () => {
    const porcelain = [
      " M context/audience-profile.md",
      "?? docs/audience-history/2026-10-22.md",
      " D docs/audience-history/2026-07-01.md",
      "?? scripts/_tmp_dl.ts",
      " M scripts/lib/foo.ts",
      "?? \"docs/audience-history/com espa\\303\\247o.md\"",
      "UU docs/audience-history/2026-10-23.md",
      "R  docs/audience-history/velho.md -> docs/audience-history/2026-10-24.md",
      "",
    ].join("\n");
    assert.deepEqual(selectSnapshotPaths(porcelain).map((e) => e.path), [
      "context/audience-profile.md",
      "docs/audience-history/2026-07-01.md",
      "docs/audience-history/2026-10-22.md",
      "docs/audience-history/2026-10-24.md",
    ]);
  });

  it("pickOpenSnapshotPr reaproveita a PR de snapshot mais antiga e ignora as outras", () => {
    const pick = pickOpenSnapshotPr([
      { number: 50, headRefName: "overnight/fix-1-x" },
      { number: 42, headRefName: "chore/audience-snapshot-20261101-000000" },
      { number: 40, headRefName: "chore/audience-snapshot-20261030-000000" },
    ]);
    assert.equal(pick?.number, 40);
    assert.equal(pickOpenSnapshotPr([{ number: 1, headRefName: "site-publish/x" }]), undefined);
  });

  it("branch nova e título seguem o padrão", () => {
    assert.equal(newSnapshotBranchName(new Date("2026-11-02T03:04:05Z")), "chore/audience-snapshot-20261102-030405");
    assert.equal(buildSnapshotCommitTitle(["context/audience-profile.md"]), "chore: snapshot de audiência profile");
    assert.equal(
      buildSnapshotCommitTitle(["docs/audience-history/2026-10-29.md", "context/audience-profile.md", "docs/audience-history/2026-10-22.md"]),
      "chore: snapshot de audiência 2026-10-22 a 2026-10-29",
    );
  });
});

const realGit: CmdRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** Remoto bare + checkout "compartilhado" com o histórico de audiência já versionado. */
function setupRepo(): { base: string; root: string; origin: string } {
  const base = mkdtempSync(join(tmpdir(), "audience-snapshot-test-"));
  const origin = join(base, "origin.git");
  const root = join(base, "root");
  realGit(["init", "-q", "--bare", "-b", "master", origin], base);
  realGit(["init", "-q", "-b", "master", root], base);
  realGit(["config", "user.email", "t@t"], root);
  realGit(["config", "user.name", "t"], root);
  realGit(["config", "commit.gpgsign", "false"], root);
  write(root, "context/audience-profile.md", "profile v1\n");
  write(root, "docs/audience-history/2026-10-01.md", "snap 01\n");
  write(root, "docs/audience-history/2026-07-01.md", "snap antigo\n");
  write(root, "scripts/foo.ts", "export {};\n");
  realGit(["add", "-A"], root);
  realGit(["commit", "-q", "-m", "init"], root);
  realGit(["remote", "add", "origin", origin], root);
  realGit(["push", "-q", "origin", "master"], root);
  realGit(["fetch", "-q", "origin"], root);
  return { base, root, origin };
}

function fakeGh(openPrs: () => unknown[], created: string[][]): CmdRunner {
  return (args) => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(openPrs());
    if (args[0] === "pr" && args[1] === "create") {
      created.push(args);
      return "https://github.com/x/y/pull/77\n";
    }
    throw new Error(`gh inesperado: ${args.join(" ")}`);
  };
}

function deps(base: string, gh: CmdRunner): SnapshotPrDeps {
  let n = 0;
  return {
    git: realGit,
    gh,
    now: () => new Date("2026-11-02T03:04:05Z"),
    makeTempDir: () => {
      const d = join(base, `wt-${n++}`);
      mkdirSync(d);
      return d;
    },
  };
}

const show = (root: string, ref: string, path: string): string => realGit(["show", `${ref}:${path}`], root);

describe("commit-audience-snapshot: integração com git real", () => {
  it("abre a PR com só os arquivos do 0i, sem tocar o checkout, e empilha na PR aberta depois", () => {
    const { base, root } = setupRepo();
    try {
      write(root, "context/audience-profile.md", "profile v2\n");
      write(root, "docs/audience-history/2026-10-22.md", "snap 22\n");
      unlinkSync(join(root, "docs/audience-history/2026-07-01.md"));
      write(root, "scripts/foo.ts", "export const sujeira = 1;\n");
      write(root, "scripts/_tmp_dl.ts", "// solto\n");
      const statusBefore = realGit(["status", "--porcelain=v1", "--untracked-files=all"], root);
      const headBefore = realGit(["rev-parse", "HEAD"], root);

      const created: string[][] = [];
      let open: unknown[] = [];
      const r1 = commitAudienceSnapshot(root, deps(base, fakeGh(() => open, created)));
      assert.equal(r1.outcome, "pr-opened", r1.error);
      assert.equal(r1.branch, "chore/audience-snapshot-20261102-030405");
      assert.equal(created.length, 1);
      assert.ok(created[0].includes("--base") && created[0].includes("master"));

      realGit(["fetch", "-q", "origin", `+refs/heads/${r1.branch}:refs/remotes/origin/${r1.branch}`], root);
      const ref = `origin/${r1.branch}`;
      assert.equal(show(root, ref, "context/audience-profile.md"), "profile v2\n");
      assert.equal(show(root, ref, "docs/audience-history/2026-10-22.md"), "snap 22\n");
      const changed = realGit(["diff", "--name-status", "origin/master", ref], root).trim().split("\n").sort();
      assert.deepEqual(changed, [
        "A\tdocs/audience-history/2026-10-22.md",
        "D\tdocs/audience-history/2026-07-01.md",
        "M\tcontext/audience-profile.md",
      ]);

      // O checkout compartilhado ficou exatamente como estava.
      assert.equal(realGit(["status", "--porcelain=v1", "--untracked-files=all"], root), statusBefore);
      assert.equal(realGit(["rev-parse", "HEAD"], root), headBefore);
      assert.equal(realGit(["branch", "--show-current"], root).trim(), "master");
      assert.equal(realGit(["worktree", "list", "--porcelain"], root).match(/^worktree /gm)?.length, 1);
      assert.ok(!existsSync(join(base, "wt-0")), "worktree temporário removido");

      // 2º Stage 0 com a PR ainda aberta: commit em cima dela, sem PR nova.
      open = [{ number: 77, headRefName: r1.branch, url: "https://github.com/x/y/pull/77" }];
      write(root, "docs/audience-history/2026-10-23.md", "snap 23\n");
      const firstCommit = realGit(["rev-parse", ref], root).trim();
      const r2 = commitAudienceSnapshot(root, deps(base, fakeGh(() => open, created)));
      assert.equal(r2.outcome, "pr-updated", r2.error);
      assert.equal(created.length, 1);
      realGit(["fetch", "-q", "origin", `+refs/heads/${r1.branch}:refs/remotes/origin/${r1.branch}`], root);
      assert.equal(realGit(["rev-parse", `${ref}~1`], root).trim(), firstCommit);
      assert.equal(show(root, ref, "docs/audience-history/2026-10-23.md"), "snap 23\n");

      // 3º sem nada novo: nada a commitar.
      const secondCommit = realGit(["rev-parse", ref], root).trim();
      const r3 = commitAudienceSnapshot(root, deps(base, fakeGh(() => open, created)));
      assert.equal(r3.outcome, "up-to-date", r3.error);
      realGit(["fetch", "-q", "origin", `+refs/heads/${r1.branch}:refs/remotes/origin/${r1.branch}`], root);
      assert.equal(realGit(["rev-parse", ref], root).trim(), secondCommit);
      assert.equal(realGit(["worktree", "list", "--porcelain"], root).match(/^worktree /gm)?.length, 1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("checkout sem snapshot sujo não faz nada (nem fetch nem gh)", () => {
    const { base, root } = setupRepo();
    try {
      write(root, "scripts/foo.ts", "export const outra = 1;\n");
      const gh: CmdRunner = () => { throw new Error("gh não deveria ser chamado"); };
      const r = commitAudienceSnapshot(root, deps(base, gh));
      assert.equal(r.outcome, "clean");
      assert.deepEqual(r.paths, []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("falha do gh vira outcome failed, sem worktree sobrando e sem push", () => {
    const { base, root, origin } = setupRepo();
    try {
      write(root, "docs/audience-history/2026-10-22.md", "snap 22\n");
      const gh: CmdRunner = () => { throw new Error("gh: not authenticated"); };
      const r = commitAudienceSnapshot(root, deps(base, gh));
      assert.equal(r.outcome, "failed");
      assert.match(r.error ?? "", /not authenticated/);
      assert.equal(realGit(["worktree", "list", "--porcelain"], root).match(/^worktree /gm)?.length, 1);
      assert.equal(realGit(["ls-remote", "--heads", origin, "chore/*"], base).trim(), "");
      assert.equal(readFileSync(join(root, "docs/audience-history/2026-10-22.md"), "utf8"), "snap 22\n");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
