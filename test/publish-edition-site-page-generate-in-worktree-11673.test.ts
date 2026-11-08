/**
 * test/publish-edition-site-page-generate-in-worktree-11673.test.ts (#11673)
 *
 * REGRESSÃO: no caminho de produção (worktree de publicação, #8636) a página
 * `p/{slug}/index.html`, o `sitemap.xml` e a home `index.html` eram GERADOS no
 * checkout compartilhado e só depois copiados pro worktree que commitava. O
 * checkout ficava com `p/{slug}/` untracked e `sitemap.xml`/`index.html`
 * modificados depois de toda publicação; quando essas cópias não batiam com o
 * master (home regerada pelo cron das 06:00, sitemap podado só no worktree
 * pelo índice do acervo, #11126), o `sync-code` da edição seguinte as
 * empurrava pro autostash — um stash por edição.
 *
 * Agora `productionDeps` cria o worktree antes do `writePage` e todos os
 * geradores escrevem nele. O contrato testado aqui, sobre git REAL (origin
 * bare + worktree), com `gh` fake:
 *
 *   1. depois de publicar, `git status --porcelain` do checkout compartilhado
 *      é vazio — e o commit da branch tem página, sitemap e home;
 *   2. o sitemap publicado nasce do origin/master buscado na hora, não da cópia
 *      (defasada) do checkout: uma entrada que só existe no origin sobrevive;
 *   3. republicação com troca de slug (A mergeado → B) também não suja nada;
 *   4. `--skip-publish` (sem worktree) segue escrevendo no checkout.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  productionDeps,
  publishEditionSitePage,
  readPreviousSitePage,
  readSitePageSlugHistory,
  writeSitePageState,
  type GhRunner,
  type LockRunner,
  type PublishPageDeps,
  type SleepFn,
} from "../scripts/publish-edition-site-page.ts";
import type { EditionPageInputs } from "../scripts/lib/edition-site-page.ts";
import { archiveUrlForSlug, buildSitemapXml } from "../scripts/lib/site-archive-pages.ts";

const SITEMAP_REL = "workers/site/public/sitemap.xml";
const HOME_REL = "workers/site/public/index.html";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const noopLock: LockRunner = () => ({ ok: true, stdout: "ok\n", stderr: "" });
const noopSleep: SleepFn = () => {};
const prUrl = (n: number) => `https://github.com/vjpixel/diaria-studio/pull/${n}`;

function realGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

/** gh fake: PR por branch, CI sempre pendente (o merge nunca acontece sozinho). */
function makeGh() {
  const prByBranch = new Map<string, number>();
  const states = new Map<number, string>();
  let next = 1;
  const gh: GhRunner = (args) => {
    const cmd = args.slice(0, 2).join(" ");
    if (cmd === "pr list") {
      const n = prByBranch.get(args[args.indexOf("--head") + 1]);
      return n !== undefined && states.get(n) === "OPEN" ? JSON.stringify([{ number: n, url: prUrl(n) }]) : "[]";
    }
    if (cmd === "pr create") {
      const n = next++;
      prByBranch.set(args[args.indexOf("--head") + 1], n);
      states.set(n, "OPEN");
      return `${prUrl(n)}\n`;
    }
    if (cmd === "pr view") {
      return JSON.stringify({
        state: states.get(Number(args[2])) ?? "OPEN",
        mergeable: "MERGEABLE",
        headRefOid: "a".repeat(40),
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }],
      });
    }
    if (cmd === "pr close") {
      states.set(Number(args[2]), "CLOSED");
      return "";
    }
    return "";
  };
  return { gh, states, prByBranch };
}

function inputs(slug: string): EditionPageInputs {
  return {
    html: "<p>corpo da edição</p>",
    postUrl: `https://diar.ia.br/p/${slug}`,
    title: `Título ${slug}`,
    subtitle: "Sub",
    publishedAtIso: "2026-10-14T09:00:00Z",
  };
}

/** Checkout compartilhado com sitemap + home commitados e origin bare em dia. */
function makeRepo(entries: string[]): string {
  const rootDir = tmp("diaria-11673-root-");
  const bare = tmp("diaria-11673-origin-");
  realGit(["init", "-b", "master"], rootDir);
  realGit(["config", "user.email", "t@example.com"], rootDir);
  realGit(["config", "user.name", "T"], rootDir);
  mkdirSync(join(rootDir, "workers", "site", "public"), { recursive: true });
  writeFileSync(join(rootDir, SITEMAP_REL), buildSitemapXml(entries.map((s) => ({ loc: archiveUrlForSlug(s) }))), "utf8");
  writeFileSync(join(rootDir, HOME_REL), "<html>home velha</html>\n", "utf8");
  realGit(["add", "-A"], rootDir);
  realGit(["commit", "-m", "init"], rootDir);
  rmSync(bare, { recursive: true, force: true });
  realGit(["clone", "--bare", rootDir, bare], rootDir);
  realGit(["remote", "add", "origin", bare], rootDir);
  realGit(["fetch", "origin"], rootDir);
  return rootDir;
}

/** Uma chamada do `main` (sem `--skip-publish`): worktree temporário novo. */
function publishOnce(rootDir: string, ed: string, gh: GhRunner, slug: string, skipPublish = false) {
  const wt = join(tmp("diaria-11673-wt-"), "wt");
  const logs: string[] = [];
  const deps: PublishPageDeps = {
    ...productionDeps(rootDir, realGit, gh, noopLock, noopSleep, skipPublish ? undefined : wt, () => ({ pid: 1 }), 0),
    readEditionInputs: () => inputs(slug),
    log: (l) => logs.push(l),
  };
  const result = publishEditionSitePage(ed, deps, {
    sitemap: SITEMAP_REL,
    skipPublish,
    previous: readPreviousSitePage(ed),
    priorSlugs: readSitePageSlugHistory(ed),
  });
  writeSitePageState(ed, result);
  assert.equal(result.code, 0, logs.join("\n"));
  assert.equal(existsSync(wt), false, "worktree temporário removido");
  return result;
}

function show(rootDir: string, ref: string, path: string): string {
  return realGit(["show", `${ref}:${path}`], rootDir);
}

describe("#11673 a geração da página acontece no worktree de publicação, nunca no checkout compartilhado", () => {
  it("publicar deixa o checkout limpo e o commit da branch leva página, sitemap e home", () => {
    const rootDir = makeRepo(["edicao-de-ontem"]);
    const ed = tmp("diaria-11673-ed-");
    const slug = "edicao-de-hoje";

    const result = publishOnce(rootDir, ed, makeGh().gh, slug);
    assert.equal("published" in result && result.published, true);

    assert.equal(realGit(["status", "--porcelain", "--untracked-files=all"], rootDir), "", "checkout compartilhado sujo");
    assert.equal(existsSync(join(rootDir, "workers", "site", "public", "p", slug)), false);

    realGit(["fetch", "origin"], rootDir);
    const ref = `origin/site-publish/${slug}`;
    assert.match(show(rootDir, ref, `workers/site/public/p/${slug}/index.html`), /corpo da edição/);
    const sitemap = show(rootDir, ref, SITEMAP_REL);
    assert.ok(sitemap.includes(`<loc>${archiveUrlForSlug(slug)}</loc>`));
    assert.ok(sitemap.includes(`<loc>${archiveUrlForSlug("edicao-de-ontem")}</loc>`));
    assert.notEqual(show(rootDir, ref, HOME_REL), "<html>home velha</html>\n", "home regenerada no commit");
  });

  it("o sitemap publicado parte do origin/master atual, não da cópia defasada do checkout", () => {
    const rootDir = makeRepo(["edicao-antiga"]);
    // Outra máquina mergeou uma edição depois do último sync deste checkout.
    const other = tmp("diaria-11673-other-");
    realGit(["clone", realGit(["remote", "get-url", "origin"], rootDir).trim(), other], rootDir);
    realGit(["config", "user.email", "t@example.com"], other);
    realGit(["config", "user.name", "T"], other);
    writeFileSync(
      join(other, SITEMAP_REL),
      buildSitemapXml([{ loc: archiveUrlForSlug("edicao-antiga") }, { loc: archiveUrlForSlug("edicao-de-outra-maquina") }]),
      "utf8",
    );
    realGit(["commit", "-am", "edição de outra máquina"], other);
    realGit(["push", "origin", "master"], other);

    const slug = "edicao-nova";
    publishOnce(rootDir, tmp("diaria-11673-ed-"), makeGh().gh, slug);

    realGit(["fetch", "origin"], rootDir);
    const sitemap = show(rootDir, `origin/site-publish/${slug}`, SITEMAP_REL);
    assert.ok(
      sitemap.includes(`<loc>${archiveUrlForSlug("edicao-de-outra-maquina")}</loc>`),
      `a entrada mergeada por outra máquina sumiria do master:\n${sitemap}`,
    );
    assert.ok(sitemap.includes(`<loc>${archiveUrlForSlug(slug)}</loc>`));
    assert.equal(realGit(["status", "--porcelain", "--untracked-files=all"], rootDir), "");
  });

  it("republicação com slug novo (A mergeado → B) também não suja o checkout", () => {
    const rootDir = makeRepo(["edicao-de-ontem"]);
    const ed = tmp("diaria-11673-ed-");
    const { gh, states, prByBranch } = makeGh();
    const A = "titulo-a";
    const B = "titulo-b";

    publishOnce(rootDir, ed, gh, A);
    realGit(["fetch", "origin"], rootDir);
    realGit(["push", "origin", `refs/remotes/origin/site-publish/${A}:refs/heads/master`], rootDir);
    states.set(prByBranch.get(`site-publish/${A}`)!, "MERGED");
    realGit(["fetch", "origin"], rootDir);
    realGit(["merge", "--ff-only", "origin/master"], rootDir); // sync-code da sessão seguinte

    publishOnce(rootDir, ed, gh, B);

    assert.equal(realGit(["status", "--porcelain", "--untracked-files=all"], rootDir), "");
    // p/A segue no checkout (veio do merge, é do master até o PR B mergear).
    assert.ok(existsSync(join(rootDir, "workers", "site", "public", "p", A, "index.html")));
    realGit(["fetch", "origin"], rootDir);
    const tree = realGit(["ls-tree", "-r", "--name-only", `origin/site-publish/${B}`], rootDir);
    assert.ok(tree.includes(`workers/site/public/p/${B}/index.html`));
    assert.ok(!tree.includes(`workers/site/public/p/${A}/`), "p/A sai no commit do PR B");
    const sitemap = show(rootDir, `origin/site-publish/${B}`, SITEMAP_REL);
    assert.ok(!sitemap.includes(`<loc>${archiveUrlForSlug(A)}</loc>`));
    assert.ok(sitemap.includes(`<loc>${archiveUrlForSlug(B)}</loc>`));
  });

  it("--skip-publish (sem worktree) segue escrevendo a página no checkout", () => {
    const rootDir = makeRepo(["edicao-de-ontem"]);
    const slug = "so-local";
    publishOnce(rootDir, tmp("diaria-11673-ed-"), makeGh().gh, slug, true);
    const page = join(rootDir, "workers", "site", "public", "p", slug, "index.html");
    assert.match(readFileSync(page, "utf8"), /corpo da edição/);
    assert.ok(readFileSync(join(rootDir, SITEMAP_REL), "utf8").includes(`<loc>${archiveUrlForSlug(slug)}</loc>`));
  });
});
