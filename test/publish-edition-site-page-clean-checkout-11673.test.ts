/**
 * test/publish-edition-site-page-clean-checkout-11673.test.ts
 *
 * Regressão #11673: no caminho do worktree (#8636), a página `p/{slug}/`
 * (untracked) e `sitemap.xml`/`index.html` (modificados) ficavam sujos no
 * checkout compartilhado depois do push. Quando o PR da página mergeava, o
 * `sync-code.ts` da edição seguinte recusava o `merge --ff-only` por colisão
 * com esses mesmos arquivos e criava um autostash — um por edição.
 *
 * Git real (subprocessos), `gh`/lock mockados — mesmo arranjo do
 * `publish-edition-site-page-8636-worktree-real-git.test.ts`.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanSharedCheckoutAfterPush,
  commitAndPushSitePage,
  homePageRelPathFromSitemap,
} from "../scripts/publish-edition-site-page.ts";
import type { GhRunner, GitRunner, LockRunner, SleepFn } from "../scripts/publish-edition-site-page.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

const gh: GhRunner = (args) => {
  if (args[0] === "pr" && args[1] === "list") return "[]\n";
  if (args[0] === "pr" && args[1] === "create") return "https://github.com/vjpixel/diaria-studio/pull/1\n";
  return "";
};
const noopLock: LockRunner = () => ({ ok: true, stdout: "ok\n", stderr: "" });
const noopSleep: SleepFn = () => {};

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

function setupRepo(): { rootDir: string; originBare: string } {
  const rootDir = mkdtempSync(join(tmpdir(), "diaria-11673-root-"));
  const originBare = mkdtempSync(join(tmpdir(), "diaria-11673-origin-"));
  cleanupDirs.push(rootDir, originBare);
  git(["init", "-b", "master"], rootDir);
  git(["config", "user.email", "test@example.com"], rootDir);
  git(["config", "user.name", "Test"], rootDir);
  mkdirSync(join(rootDir, "workers", "site", "public", "p", "edicao-velha"), { recursive: true });
  writeFileSync(join(rootDir, SITEMAP), "OLD_SITEMAP\n", "utf8");
  writeFileSync(join(rootDir, HOME), "OLD_HOME\n", "utf8");
  writeFileSync(join(rootDir, "workers/site/public/p/edicao-velha/index.html"), "VELHA\n", "utf8");
  writeFileSync(join(rootDir, "README.md"), "readme\n", "utf8");
  git(["add", "-A"], rootDir);
  git(["commit", "-m", "init"], rootDir);
  rmSync(originBare, { recursive: true, force: true });
  git(["clone", "--bare", rootDir, originBare], rootDir);
  git(["remote", "add", "origin", originBare], rootDir);
  git(["fetch", "origin"], rootDir);
  git(["branch", "--set-upstream-to=origin/master", "master"], rootDir);
  return { rootDir, originBare };
}

/** O que `writePage` + `updateSitemapAndHome` deixam em `rootDir`. */
function writeArtifacts(rootDir: string, slug: string): void {
  mkdirSync(join(rootDir, "workers/site/public/p", slug), { recursive: true });
  writeFileSync(join(rootDir, "workers/site/public/p", slug, "index.html"), `PAGE ${slug}\n`, "utf8");
  writeFileSync(join(rootDir, SITEMAP), `NEW_SITEMAP ${slug}\n`, "utf8");
  writeFileSync(join(rootDir, HOME), `NEW_HOME ${slug}\n`, "utf8");
}

function freshWorktreeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "diaria-11673-wt-"));
  cleanupDirs.push(d);
  rmSync(d, { recursive: true, force: true });
  return d;
}

/** Simula o merge do PR da página: a branch vira o master do remoto. */
function mergePageBranch(rootDir: string, slug: string): void {
  git(["fetch", "origin"], rootDir);
  git(["push", "origin", `origin/site-publish/${slug}:refs/heads/master`], rootDir);
  git(["fetch", "origin"], rootDir);
}

describe("#11673 — publicar via worktree deixa o checkout compartilhado limpo", () => {
  it("depois do push, página/sitemap/home somem do status e o ff do PR mergeado passa sem stash", () => {
    const { rootDir } = setupRepo();
    const slug = "lula-promete-uma-ia-brasileira";
    writeArtifacts(rootDir, slug);
    // Sujeira alheia fora do pathspec da publicação: não pode ser tocada.
    writeFileSync(join(rootDir, "README.md"), "edição local de outra sessão\n", "utf8");

    const r = commitAndPushSitePage(rootDir, slug, git, SITEMAP, gh, noopLock, noopSleep, freshWorktreeDir());
    assert.equal(r.pushed, true);

    const status = git(["status", "--porcelain", "--untracked-files=all"], rootDir);
    assert.equal(status, " M README.md\n", `só a sujeira alheia deveria restar, veio:\n${status}`);
    assert.equal(existsSync(join(rootDir, "workers/site/public/p", slug)), false, "diretório da página esvaziado sai");
    assert.equal(existsSync(join(rootDir, "workers/site/public/p")), true, "p/ em si fica");
    assert.equal(readFileSync(join(rootDir, "README.md"), "utf8"), "edição local de outra sessão\n");

    // O conteúdo publicado está no commit da branch, não perdido.
    git(["fetch", "origin"], rootDir);
    assert.equal(
      git(["show", `origin/site-publish/${slug}:workers/site/public/p/${slug}/index.html`], rootDir),
      `PAGE ${slug}\n`,
    );

    // O sync-code da próxima edição: ff direto, sem colisão.
    mergePageBranch(rootDir, slug);
    git(["merge", "--ff-only", "origin/master"], rootDir);
    assert.equal(readFileSync(join(rootDir, SITEMAP), "utf8"), `NEW_SITEMAP ${slug}\n`);
    assert.equal(readFileSync(join(rootDir, "workers/site/public/p", slug, "index.html"), "utf8"), `PAGE ${slug}\n`);
  });

  it("arquivo alterado por outra sessão depois da cópia fica intacto (e é reportado)", () => {
    const { rootDir } = setupRepo();
    const slug = "edicao-concorrente";
    writeArtifacts(rootDir, slug);
    // Mexe no sitemap de rootDir no instante do push — depois da cópia pro worktree.
    const racingGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") writeFileSync(join(rootDir, SITEMAP), "OUTRA SESSÃO\n", "utf8");
      return git(args, cwd);
    };
    const r = commitAndPushSitePage(rootDir, slug, racingGit, SITEMAP, gh, noopLock, noopSleep, freshWorktreeDir());
    assert.equal(r.pushed, true);
    assert.equal(readFileSync(join(rootDir, SITEMAP), "utf8"), "OUTRA SESSÃO\n", "nunca sobrescreve trabalho alheio");
    const status = git(["status", "--porcelain", "--untracked-files=all"], rootDir);
    assert.equal(status, ` M ${SITEMAP}\n`, `página e home limpas, sitemap alheio fica:\n${status}`);
  });

  it("cleanSharedCheckoutAfterPush: só apaga/restaura o que bate byte a byte com a cópia commitada", () => {
    const { rootDir } = setupRepo();
    const wt = mkdtempSync(join(tmpdir(), "diaria-11673-copy-"));
    cleanupDirs.push(wt);
    const page = "workers/site/public/p/x";
    mkdirSync(join(rootDir, page), { recursive: true });
    mkdirSync(join(wt, page), { recursive: true });
    writeFileSync(join(rootDir, page, "index.html"), "A\n");
    writeFileSync(join(wt, page, "index.html"), "A\n");
    writeFileSync(join(rootDir, page, "extra.txt"), "só local\n"); // sem cópia: fica
    writeFileSync(join(rootDir, HOME), "H\n");
    mkdirSync(join(wt, "workers/site/public"), { recursive: true });
    writeFileSync(join(wt, HOME), "H\n");

    const res = cleanSharedCheckoutAfterPush(rootDir, wt, [page, HOME, SITEMAP], git);
    assert.deepEqual(res.removed, [`${page}/index.html`]);
    assert.deepEqual(res.restored, [HOME]);
    assert.deepEqual(res.kept, [`${page}/extra.txt`]);
    assert.equal(readFileSync(join(rootDir, HOME), "utf8"), "OLD_HOME\n");
    assert.equal(existsSync(join(rootDir, page, "extra.txt")), true, "diretório não vazio fica");
  });
});
