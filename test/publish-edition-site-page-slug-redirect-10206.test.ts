/**
 * #10206: republicar a página com slug novo grava `/p/{velho} /p/{novo} 301`
 * em `_redirects` — posts sociais já agendados com o slug velho não dão 404.
 *
 * #10233: a escrita é só do `commitAndPushSitePage` (sobre a cópia do
 * `gitCwd`). Antes, `supersedePreviousSitePage` gravava também em `rootDir`:
 * no caminho legado (`gitCwd === rootDir`) o commit achava a linha já
 * presente e deixava o `_redirects` FORA do commit; no caminho do worktree o
 * checkout compartilhado ficava sujo. Os testes de git real abaixo cobrem o
 * staging nos dois caminhos.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSlugRedirect,
  redirectsRelPathFromSitemap,
  supersedePreviousSitePage,
  commitAndPushSitePage,
  type GhRunner,
  type LockRunner,
  type SleepFn,
} from "../scripts/publish-edition-site-page.ts";

const SITEMAP_REL = "workers/site/public/sitemap.xml";
const REDIRECTS_REL = "workers/site/public/_redirects";
const OLD_SLUG = "titulo-velho";
const NEW_SLUG = "titulo-novo";
const LINE = `/p/${OLD_SLUG} /p/${NEW_SLUG} 301`;

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const noopLock: LockRunner = () => ({ ok: true, stdout: "ok\n", stderr: "" });
const noopSleep: SleepFn = () => {};
const gh: GhRunner = (args) => {
  const cmd = args.slice(0, 2).join(" ");
  if (cmd === "pr list") return "[]";
  if (cmd === "pr create") return "https://github.com/vjpixel/diaria-studio/pull/1\n";
  if (cmd === "pr view") return JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "MERGEABLE" });
  return "";
};

function realGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

/** Repo com `_redirects` commitado + origin bare sincronizado (HEAD == origin/master). */
function makeRepo(): string {
  const rootDir = tmp("diaria-10233-root-");
  const bare = tmp("diaria-10233-origin-");
  realGit(["init", "-b", "master"], rootDir);
  realGit(["config", "user.email", "t@example.com"], rootDir);
  realGit(["config", "user.name", "T"], rootDir);
  mkdirSync(join(rootDir, "workers", "site", "public"), { recursive: true });
  writeFileSync(join(rootDir, REDIRECTS_REL), "/p/x /p/y 301\n", "utf8");
  realGit(["add", "-A"], rootDir);
  realGit(["commit", "-m", "init"], rootDir);
  rmSync(bare, { recursive: true, force: true });
  realGit(["clone", "--bare", rootDir, bare], rootDir);
  realGit(["remote", "add", "origin", bare], rootDir);
  realGit(["fetch", "origin"], rootDir);
  return rootDir;
}

function writeNewPage(rootDir: string): void {
  mkdirSync(join(rootDir, "workers", "site", "public", "p", NEW_SLUG), { recursive: true });
  writeFileSync(join(rootDir, "workers", "site", "public", "p", NEW_SLUG, "index.html"), "<html>nova</html>", "utf8");
}

function publishedRedirects(rootDir: string): string {
  realGit(["fetch", "origin"], rootDir);
  return realGit(["show", `origin/site-publish/${NEW_SLUG}:${REDIRECTS_REL}`], rootDir);
}

describe("#10206 addSlugRedirect", () => {
  it("acrescenta a linha, é idempotente e ignora slug igual", () => {
    const out = addSlugRedirect("/p/a /p/b 301\n", "velho", "novo");
    assert.equal(out, "/p/a /p/b 301\n/p/velho /p/novo 301\n");
    assert.equal(addSlugRedirect(out, "velho", "novo"), out);
    assert.equal(addSlugRedirect("x\n", "a", "a"), "x\n");
    assert.equal(addSlugRedirect("", "velho", "novo"), "/p/velho /p/novo 301\n");
  });
  it("voltar ao slug anterior remove a regra inversa (sem loop)", () => {
    const out = addSlugRedirect("/p/a /p/b 301\n", "b", "a");
    assert.equal(out, "/p/b /p/a 301\n");
  });
  it("#10353: regra existente com a mesma origem tem o destino reescrito", () => {
    assert.equal(addSlugRedirect("/p/x /p/y 301\n/p/a /p/b 301\n", "a", "c"), "/p/x /p/y 301\n/p/a /p/c 301\n");
  });
  it("#10353: republicação A→B→C pela ordem real do caller vira A→C e B→C (sem cadeia)", () => {
    // slugRedirectSources({ oldSlug: "b", newSlug: "c", priorSlugs: ["a"] }) = ["b", "a"]
    let content = "/p/x /p/y 301\n/p/a /p/b 301\n";
    for (const old of ["b", "a"]) content = addSlugRedirect(content, old, "c");
    assert.equal(content, "/p/x /p/y 301\n/p/a /p/c 301\n/p/b /p/c 301\n");
  });
  it("#10353: só o slug imediato como fonte ainda colapsa a cadeia (X→velho passa a X→novo)", () => {
    const out = addSlugRedirect("/p/a /p/b 301\n", "b", "c");
    assert.equal(out, "/p/a /p/c 301\n/p/b /p/c 301\n");
  });
  it("caminho do _redirects é irmão do sitemap", () => {
    assert.equal(redirectsRelPathFromSitemap(SITEMAP_REL), REDIRECTS_REL);
  });
});

describe("#10233 supersedePreviousSitePage não grava _redirects no checkout compartilhado", () => {
  it("_redirects de rootDir fica intacto", () => {
    const root = tmp("diaria-10233-sup-");
    mkdirSync(join(root, "workers", "site", "public"), { recursive: true });
    writeFileSync(join(root, REDIRECTS_REL), "/p/x /p/y 301\n");
    supersedePreviousSitePage(root, gh, { oldSlug: OLD_SLUG, newSlug: NEW_SLUG, sitemapRelPath: SITEMAP_REL });
    assert.equal(readFileSync(join(root, REDIRECTS_REL), "utf8"), "/p/x /p/y 301\n");
  });
  it("sem --sitemap: avisa que o redirect não será gravado", () => {
    const root = tmp("diaria-10233-sup-nositemap-");
    const out = supersedePreviousSitePage(root, gh, { oldSlug: OLD_SLUG, newSlug: NEW_SLUG });
    assert.ok(out.notes.some((n) => n.includes("#10206")));
    assert.equal(existsSync(join(root, REDIRECTS_REL)), false);
  });
});

describe("#10233 commitAndPushSitePage leva o _redirects no commit (git real)", () => {
  it("caminho legado (gitCwd === rootDir): o redirect entra no commit da branch nova", () => {
    const rootDir = makeRepo();
    const out = supersedePreviousSitePage(rootDir, gh, { oldSlug: OLD_SLUG, newSlug: NEW_SLUG, sitemapRelPath: SITEMAP_REL });
    writeNewPage(rootDir);
    const res = commitAndPushSitePage(rootDir, NEW_SLUG, realGit, SITEMAP_REL, gh, noopLock, noopSleep, undefined, out.removedPaths, {
      oldSlug: OLD_SLUG,
      newSlug: NEW_SLUG,
    });
    assert.equal(res.committed, true);
    assert.equal(res.pushed, true);
    assert.equal(publishedRedirects(rootDir), `/p/x /p/y 301\n${LINE}\n`);
  });

  it("caminho legado com a linha já no disco sem commit (rodada anterior): ainda entra no commit", () => {
    const rootDir = makeRepo();
    writeFileSync(join(rootDir, REDIRECTS_REL), `/p/x /p/y 301\n${LINE}\n`, "utf8");
    writeNewPage(rootDir);
    const res = commitAndPushSitePage(rootDir, NEW_SLUG, realGit, SITEMAP_REL, gh, noopLock, noopSleep, undefined, [], {
      oldSlug: OLD_SLUG,
      newSlug: NEW_SLUG,
    });
    assert.equal(res.pushed, true);
    assert.equal(publishedRedirects(rootDir), `/p/x /p/y 301\n${LINE}\n`);
  });

  it("caminho do worktree: redirect no commit e checkout compartilhado sem _redirects modificado", () => {
    const rootDir = makeRepo();
    const out = supersedePreviousSitePage(rootDir, gh, { oldSlug: OLD_SLUG, newSlug: NEW_SLUG, sitemapRelPath: SITEMAP_REL });
    writeNewPage(rootDir);
    const wt = tmp("diaria-10233-wt-");
    rmSync(wt, { recursive: true, force: true });
    const res = commitAndPushSitePage(rootDir, NEW_SLUG, realGit, SITEMAP_REL, gh, noopLock, noopSleep, wt, out.removedPaths, {
      oldSlug: OLD_SLUG,
      newSlug: NEW_SLUG,
    });
    assert.equal(res.pushed, true);
    assert.equal(publishedRedirects(rootDir), `/p/x /p/y 301\n${LINE}\n`);
    assert.equal(realGit(["status", "--porcelain", "--", REDIRECTS_REL], rootDir).trim(), "");
  });
});
