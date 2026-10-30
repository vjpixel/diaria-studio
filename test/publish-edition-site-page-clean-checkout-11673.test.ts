/**
 * test/publish-edition-site-page-clean-checkout-11673.test.ts
 *
 * Regressão #11673 (30/10/2026): o `sync-code.ts` recusou o ff por colisão
 * com `seed/lancamentos-tool-allowlist.txt` (edição local real),
 * `workers/site/public/sitemap.xml` e `workers/site/public/p/{slug}/index.html`
 * (artefatos da página da edição, idênticos ao que o PR do site mergeou).
 * O descarte de cópias idênticas do #11562 é tudo-ou-nada (#11654), então a
 * allowlist arrastava página e sitemap pro autostash — um por edição.
 *
 * Agora, sem config protegida suja, os idênticos saem sem perda e só a
 * edição local real vai pro stash direcionado.
 *
 * Ponta a ponta com git real: publica pelo caminho do worktree (#8636) com
 * `commitAndPushSitePage`, simula o merge do PR da página e roda `syncCode`
 * no checkout. `gh`/lock mockados.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndPushSitePage, homePageRelPathFromSitemap } from "../scripts/publish-edition-site-page.ts";
import type { GhRunner, LockRunner, SleepFn } from "../scripts/publish-edition-site-page.ts";
import { syncCode, discardCollisionsIdenticalToUpstream, classifyFfRefusal, type SpawnFn, type SyncLock } from "../scripts/lib/git-sync.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}
function realSpawn(cwd: string): SpawnFn {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

const gh: GhRunner = (args) => {
  if (args[0] === "pr" && args[1] === "list") return "[]\n";
  if (args[0] === "pr" && args[1] === "create") return "https://github.com/vjpixel/diaria-studio/pull/1\n";
  return "";
};
const noopLock: LockRunner = () => ({ ok: true, stdout: "ok\n", stderr: "" });
const noopSleep: SleepFn = () => {};
const NOOP_SYNC_LOCK: SyncLock = { path: "(noop)", acquire: () => true, release: () => {} };

const cleanupDirs: string[] = [];
after(() => {
  for (const d of cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const SITEMAP = "workers/site/public/sitemap.xml";
const HOME = homePageRelPathFromSitemap(SITEMAP);
const ALLOWLIST = "seed/lancamentos-tool-allowlist.txt";
const SLUG = "lula-promete-uma-ia-brasileira";
const PAGE = `workers/site/public/p/${SLUG}/index.html`;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}
function write(root: string, rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content, "utf8");
}

function setupRepo(): string {
  const rootDir = tmp("diaria-11673-root-");
  const bare = tmp("diaria-11673-origin-");
  git(["init", "-b", "master"], rootDir);
  git(["config", "user.email", "t@example.com"], rootDir);
  git(["config", "user.name", "T"], rootDir);
  write(rootDir, SITEMAP, "OLD_SITEMAP\n");
  write(rootDir, HOME, "OLD_HOME\n");
  write(rootDir, ALLOWLIST, "# allowlist\n");
  git(["add", "-A"], rootDir);
  git(["commit", "-m", "init"], rootDir);
  rmSync(bare, { recursive: true, force: true });
  git(["clone", "--bare", rootDir, bare], rootDir);
  git(["remote", "add", "origin", bare], rootDir);
  git(["fetch", "origin"], rootDir);
  git(["branch", "--set-upstream-to=origin/master", "master"], rootDir);
  return rootDir;
}

/** Publica pelo caminho do worktree e mergeia o PR da página no master do remoto. */
function publishAndMerge(rootDir: string): void {
  // O que `writePage` + `updateSitemapAndHome` deixam no checkout.
  write(rootDir, PAGE, `PAGE ${SLUG}\n`);
  write(rootDir, SITEMAP, `NEW_SITEMAP ${SLUG}\n`);
  write(rootDir, HOME, `NEW_HOME ${SLUG}\n`);
  const wt = tmp("diaria-11673-wt-");
  rmSync(wt, { recursive: true, force: true });
  const r = commitAndPushSitePage(rootDir, SLUG, git, SITEMAP, gh, noopLock, noopSleep, wt);
  assert.equal(r.pushed, true);
  git(["fetch", "origin"], rootDir);
  git(["push", "origin", `refs/remotes/origin/site-publish/${SLUG}:refs/heads/master`], rootDir);
}

/** Outra PR mergeada depois mexe na allowlist (a colisão "real" do incidente). */
function upstreamTouchesAllowlist(rootDir: string): void {
  const other = tmp("diaria-11673-other-");
  rmSync(other, { recursive: true, force: true });
  const bare = git(["remote", "get-url", "origin"], rootDir).trim();
  git(["clone", "-q", bare, other], rootDir);
  git(["config", "user.email", "t@example.com"], other);
  git(["config", "user.name", "T"], other);
  write(other, ALLOWLIST, "# allowlist\nexemplo.com/upstream/\n");
  write(other, "scripts/codigo-novo.ts", "export const X = 1;\n");
  git(["add", "-A"], other);
  git(["commit", "-qm", "upstream"], other);
  git(["push", "-q", "origin", "master"], other);
  git(["fetch", "origin"], rootDir);
}

describe("#11673 — artefatos da página da edição não vão mais pro autostash", () => {
  it("colisão mista (página/sitemap/home idênticos + allowlist editada): stash só com a allowlist, ff passa", () => {
    const rootDir = setupRepo();
    publishAndMerge(rootDir);
    upstreamTouchesAllowlist(rootDir);
    write(rootDir, ALLOWLIST, "# allowlist\nexemplo.com/local/\n"); // edição local real

    const r = syncCode(realSpawn(rootDir), NOOP_SYNC_LOCK, rootDir);
    assert.equal(r.outcome, "synced_stash_preserved", r.message);
    assert.deepEqual([...(r.discarded_identical_paths ?? [])].sort(), [HOME, PAGE, SITEMAP].sort());

    // Código do master chegou, artefatos vieram pelo ff.
    assert.ok(existsSync(join(rootDir, "scripts/codigo-novo.ts")));
    assert.equal(readFileSync(join(rootDir, PAGE), "utf8"), `PAGE ${SLUG}\n`);
    assert.equal(readFileSync(join(rootDir, SITEMAP), "utf8"), `NEW_SITEMAP ${SLUG}\n`);

    // O autostash carrega só a edição local real.
    const stashed = git(["stash", "show", "--include-untracked", "--name-only", "stash@{0}"], rootDir)
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(stashed, [ALLOWLIST], `stash deveria ter só a allowlist, veio: ${stashed.join(", ")}`);
    assert.equal(git(["stash", "list"], rootDir).trim().split("\n").length, 1);
  });

  it("só artefatos idênticos (sem edição local): ff sem stash nenhum", () => {
    const rootDir = setupRepo();
    publishAndMerge(rootDir);
    const r = syncCode(realSpawn(rootDir), NOOP_SYNC_LOCK, rootDir);
    assert.equal(r.outcome, "synced", r.message);
    assert.equal(r.preserved_stash, null);
    assert.equal(git(["stash", "list"], rootDir), "");
    assert.equal(git(["status", "--porcelain", "--untracked-files=all"], rootDir), "");
  });

  it("allowPartial descarta só os idênticos; sem a flag segue tudo-ou-nada (#11654)", () => {
    const stderr =
      `error: Your local changes to the following files would be overwritten by merge:\n\t${SITEMAP}\n\t${ALLOWLIST}\n` +
      `Please commit your changes or stash them before you merge.\nAborting\n`;
    const porcelain = ` M ${SITEMAP}\n M ${ALLOWLIST}\n`;
    const mk = (calls: string[]): SpawnFn => (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      if (key === `git hash-object -- ${SITEMAP} ${ALLOWLIST}`) return { status: 0, stdout: "s1\na-local\n", stderr: "" };
      if (key.startsWith("git ls-tree"))
        return { status: 0, stdout: `100644 blob s1\t${SITEMAP}\x00100644 blob a-master\t${ALLOWLIST}\x00`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const partialCalls: string[] = [];
    const partial = discardCollisionsIdenticalToUpstream(mk(partialCalls), classifyFfRefusal(stderr), porcelain, true);
    assert.deepEqual(partial.discarded, [SITEMAP]);
    assert.ok(partialCalls.includes(`git checkout -- :(literal)${SITEMAP}`));
    assert.ok(!partialCalls.some((c) => c.includes(`:(literal)${ALLOWLIST}`)), "a edição local real nunca é descartada");

    const strictCalls: string[] = [];
    const strict = discardCollisionsIdenticalToUpstream(mk(strictCalls), classifyFfRefusal(stderr), porcelain);
    assert.deepEqual(strict.discarded, []);
    assert.ok(!strictCalls.some((c) => c.startsWith("git checkout") || c.startsWith("git clean")));
  });
});
