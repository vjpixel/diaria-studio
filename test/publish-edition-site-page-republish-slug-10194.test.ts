/**
 * test/publish-edition-site-page-republish-slug-10194.test.ts (#10194)
 *
 * REGRESSÃO: o §5b-site abre o PR #A em `site-publish/{slug-velho}`; o loop do
 * §5f muda o título do D1; a trava do Stage 6 devolve `stale` e a republicação
 * abre o PR #B em `site-publish/{slug-novo}`. Antes do fix nada fechava o #A
 * nem parava o waiter dele, e com os dois mergeados sitemap/home mostravam a
 * mesma edição duas vezes (`addSitemapEntry` só deduplica por `<loc>` exato) e
 * `/p/{slug-velho}` ficava no ar órfã.
 *
 * Cenários cobertos (pedidos na issue):
 *   1. slug muda com o PR antigo ainda ABERTO → `gh pr close` + marcador pro
 *      waiter + entrada velha fora do sitemap/home, nada removido do git.
 *   2. slug muda com o PR antigo já MERGEADO → entrada velha fora do sitemap/
 *      home e a página velha sai (`git rm`) no MESMO commit do PR novo — com
 *      git real.
 * Nenhum teste toca `gh` real: `GhRunner` é sempre um fake.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishEditionSitePage,
  productionDeps,
  commitAndPushSitePage,
  supersedePreviousSitePage,
  readPreviousSitePage,
  readSupersededPrNumbers,
  waitAndMergeSitePagePr,
  homePageRelPathFromSitemap,
  type PublishPageDeps,
  type GitRunner,
  type GhRunner,
  type LockRunner,
  type SleepFn,
} from "../scripts/publish-edition-site-page.ts";
import type { EditionPageInputs } from "../scripts/lib/edition-site-page.ts";
import { buildSitemapXml, removeSitemapEntry, archiveUrlForSlug } from "../scripts/lib/site-archive-pages.ts";

const SITEMAP_REL = "workers/site/public/sitemap.xml";
const OLD_SLUG = "titulo-velho-do-d1";
const NEW_SLUG = "titulo-novo-do-d1";
const OLD_PR = 100;

const cleanupDirs: string[] = [];
after(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

const noopLock: LockRunner = () => ({ ok: true, stdout: "ok\n", stderr: "" });
const noopSleep: SleepFn = () => {};

/** gh fake: registra chamadas; estado do PR velho controlado pelo teste. */
function makeGh(oldState: "OPEN" | "MERGED" | "CLOSED", opts: { closeThrows?: boolean; afterClose?: string } = {}) {
  const calls: string[][] = [];
  let state: string = oldState;
  const gh: GhRunner = (args) => {
    calls.push(args);
    const cmd = args.slice(0, 2).join(" ");
    if (cmd === "pr view" && args[2] === String(OLD_PR)) return JSON.stringify({ state });
    if (cmd === "pr close") {
      if (opts.closeThrows) {
        if (opts.afterClose) state = opts.afterClose;
        throw new Error("gh: falha simulada");
      }
      state = "CLOSED";
      return "";
    }
    if (cmd === "pr list") return "[]";
    if (cmd === "pr create") return "https://github.com/vjpixel/diaria-studio/pull/1\n";
    if (cmd === "pr view") return JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "MERGEABLE" });
    return "";
  };
  return { gh, calls };
}

function writeOldPublication(rootDir: string): void {
  const sitemapAbs = join(rootDir, ...SITEMAP_REL.split("/"));
  mkdirSync(join(rootDir, "workers", "site", "public", "p", OLD_SLUG), { recursive: true });
  writeFileSync(join(rootDir, "workers", "site", "public", "p", OLD_SLUG, "index.html"), "<html>velha</html>", "utf8");
  writeFileSync(
    sitemapAbs,
    buildSitemapXml([
      { loc: archiveUrlForSlug("edicao-de-ontem") },
      { loc: archiveUrlForSlug(OLD_SLUG) },
      // prefixo do slug velho — página DIFERENTE, não pode sair junto (#7280)
      { loc: archiveUrlForSlug(`${OLD_SLUG}-ec15971b`) },
    ]),
    "utf8",
  );
}

describe("#10194 removeSitemapEntry", () => {
  it("remove só a <url> com a <loc> exata, preservando prefixos e o resto", () => {
    const xml = buildSitemapXml([
      { loc: archiveUrlForSlug("a") },
      { loc: archiveUrlForSlug(OLD_SLUG), lastmod: "2026-10-14" },
      { loc: archiveUrlForSlug(`${OLD_SLUG}-x`) },
    ]);
    const out = removeSitemapEntry(xml, archiveUrlForSlug(OLD_SLUG));
    assert.ok(!out.includes(`<loc>${archiveUrlForSlug(OLD_SLUG)}</loc>`));
    assert.ok(out.includes(`<loc>${archiveUrlForSlug(`${OLD_SLUG}-x`)}</loc>`));
    assert.ok(out.includes(`<loc>${archiveUrlForSlug("a")}</loc>`));
    assert.ok(!out.includes("2026-10-14"), "lastmod da entrada removida sai junto");
    assert.equal(out, buildSitemapXml([{ loc: archiveUrlForSlug("a") }, { loc: archiveUrlForSlug(`${OLD_SLUG}-x`) }]));
  });

  it("sem a entrada, devolve o XML intacto", () => {
    const xml = buildSitemapXml([{ loc: archiveUrlForSlug("a") }]);
    assert.equal(removeSitemapEntry(xml, archiveUrlForSlug("b")), xml);
  });
});

describe("#10194 readPreviousSitePage", () => {
  it("lê slug + prNumber de uma publicação confirmada; ignora tentativa falha", () => {
    const ed = tmp("diaria-10194-ed-");
    mkdirSync(join(ed, "_internal"), { recursive: true });
    const p = join(ed, "_internal", "site-page-published.json");
    assert.equal(readPreviousSitePage(ed), null);
    writeFileSync(p, JSON.stringify({ published: true, slug: OLD_SLUG, prUrl: `https://github.com/x/y/pull/${OLD_PR}` }));
    assert.deepEqual(readPreviousSitePage(ed), { slug: OLD_SLUG, prNumber: OLD_PR });
    writeFileSync(p, JSON.stringify({ code: 3, published: false, reason: "falhou" }));
    assert.equal(readPreviousSitePage(ed), null);
  });
});

describe("#10194 supersedePreviousSitePage", () => {
  it("PR velho ABERTO: fecha, marca pro waiter, tira a entrada do sitemap e não remove nada do git", () => {
    const rootDir = tmp("diaria-10194-root-");
    const ed = tmp("diaria-10194-ed-");
    writeOldPublication(rootDir);
    const { gh, calls } = makeGh("OPEN");
    const out = supersedePreviousSitePage(rootDir, gh, {
      oldSlug: OLD_SLUG,
      newSlug: NEW_SLUG,
      oldPrNumber: OLD_PR,
      sitemapRelPath: SITEMAP_REL,
      editionDirAbs: ed,
    });
    assert.equal(out.oldPrState, "closed");
    assert.deepEqual(out.removedPaths, []);
    assert.equal(out.sitemapEntryRemoved, true);
    const close = calls.find((c) => c[0] === "pr" && c[1] === "close");
    assert.ok(close, "gh pr close deveria ter sido chamado");
    assert.equal(close![2], String(OLD_PR));
    assert.ok(close!.includes("--delete-branch"));
    assert.deepEqual(readSupersededPrNumbers(ed), [OLD_PR]);
    const xml = readFileSync(join(rootDir, ...SITEMAP_REL.split("/")), "utf8");
    assert.ok(!xml.includes(`<loc>${archiveUrlForSlug(OLD_SLUG)}</loc>`));
    assert.ok(xml.includes(`<loc>${archiveUrlForSlug(`${OLD_SLUG}-ec15971b`)}</loc>`));
    assert.equal(existsSync(join(rootDir, "workers", "site", "public", "p", OLD_SLUG)), false);
  });

  it("PR velho MERGEADO: não fecha nada e devolve a página velha pra remoção no commit novo", () => {
    const rootDir = tmp("diaria-10194-root-");
    writeOldPublication(rootDir);
    const { gh, calls } = makeGh("MERGED");
    const out = supersedePreviousSitePage(rootDir, gh, {
      oldSlug: OLD_SLUG,
      newSlug: NEW_SLUG,
      oldPrNumber: OLD_PR,
      sitemapRelPath: SITEMAP_REL,
    });
    assert.equal(out.oldPrState, "merged");
    assert.deepEqual(out.removedPaths, [`workers/site/public/p/${OLD_SLUG}`]);
    assert.ok(!calls.some((c) => c[1] === "close"));
  });

  it("close falha porque o waiter mergeou no intervalo: trata como mergeado", () => {
    const rootDir = tmp("diaria-10194-root-");
    writeOldPublication(rootDir);
    const { gh } = makeGh("OPEN", { closeThrows: true, afterClose: "MERGED" });
    const out = supersedePreviousSitePage(rootDir, gh, {
      oldSlug: OLD_SLUG,
      newSlug: NEW_SLUG,
      oldPrNumber: OLD_PR,
      sitemapRelPath: SITEMAP_REL,
    });
    assert.equal(out.oldPrState, "merged");
    assert.deepEqual(out.removedPaths, [`workers/site/public/p/${OLD_SLUG}`]);
  });
});

describe("#10194 waiter desiste quando o PR foi substituído", () => {
  it("shouldAbort true → não chama gh pr merge mesmo com CI verde", () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      return JSON.stringify({
        state: "OPEN",
        mergeable: "MERGEABLE",
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      });
    };
    const r = waitAndMergeSitePagePr("/nao-usado", OLD_PR, gh, noopSleep, 1_000, 1, undefined, () => true);
    assert.equal(r.merged, false);
    assert.match(r.reason, /substituído/);
    assert.ok(!calls.some((c) => c[1] === "merge"));
  });
});

function makeInputs(slug: string): EditionPageInputs {
  return {
    html: "<p>corpo</p>",
    postUrl: `https://diar.ia.br/p/${slug}`,
    title: "Título",
    subtitle: "Sub",
    publishedAtIso: "2026-10-14T09:00:00Z",
  };
}

describe("#10194 publishEditionSitePage — republicação com slug novo (deps de produção, git/gh fakes)", () => {
  function run(oldState: "OPEN" | "MERGED", opts: { skipPublish?: boolean; previousSlug?: string } = {}) {
    const rootDir = tmp("diaria-10194-root-");
    const ed = tmp("diaria-10194-ed-");
    writeOldPublication(rootDir);
    const gitCalls: string[][] = [];
    const staged: string[] = [];
    const git: GitRunner = (args) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
      if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
      if (args[0] === "add" || args[0] === "rm") {
        staged.push(args[args.length - 1]);
        return "";
      }
      // página velha só está tracked quando o PR velho foi mergeado
      if (args[0] === "ls-files") return oldState === "MERGED" ? `${args[2]}/index.html\n` : "";
      if (args[0] === "status") return " M x\n";
      if (args[0] === "diff") return staged.join("\n");
      return "";
    };
    const { gh, calls } = makeGh(oldState);
    const deps: PublishPageDeps = {
      ...productionDeps(rootDir, git, gh, noopLock, noopSleep, undefined, () => ({ pid: 1 }), 0),
      readEditionInputs: () => makeInputs(NEW_SLUG),
      log: () => {},
    };
    const result = publishEditionSitePage(ed, deps, {
      sitemap: SITEMAP_REL,
      skipPublish: opts.skipPublish,
      previous: { slug: opts.previousSlug ?? OLD_SLUG, prNumber: OLD_PR },
    });
    const sitemap = readFileSync(join(rootDir, ...SITEMAP_REL.split("/")), "utf8");
    const home = readFileSync(join(rootDir, ...homePageRelPathFromSitemap(SITEMAP_REL).split("/")), "utf8");
    return { result, sitemap, home, gitCalls, ghCalls: calls, ed };
  }

  it("PR antigo ABERTO: fecha o #A, sitemap só com o slug novo, nenhum git rm", () => {
    const { result, sitemap, home, gitCalls, ghCalls, ed } = run("OPEN");
    assert.equal(result.code, 0);
    assert.ok(ghCalls.some((c) => c[1] === "close" && c[2] === String(OLD_PR)));
    assert.ok(!sitemap.includes(`<loc>${archiveUrlForSlug(OLD_SLUG)}</loc>`), "entrada velha não pode ficar");
    assert.ok(sitemap.includes(`<loc>${archiveUrlForSlug(NEW_SLUG)}</loc>`));
    assert.ok(!home.includes(`/p/${OLD_SLUG}"`), "home não pode linkar o slug velho");
    assert.ok(!gitCalls.some((c) => c[0] === "rm"));
    assert.deepEqual(readSupersededPrNumbers(ed), [OLD_PR]);
  });

  it("PR antigo MERGEADO: git rm da página velha no mesmo commit do PR novo", () => {
    const { result, sitemap, gitCalls } = run("MERGED");
    assert.equal(result.code, 0);
    const rm = gitCalls.find((c) => c[0] === "rm");
    assert.deepEqual(rm, ["rm", "-r", "-q", "--", `workers/site/public/p/${OLD_SLUG}`]);
    const commit = gitCalls.find((c) => c[0] === "commit");
    assert.ok(commit!.includes(`workers/site/public/p/${OLD_SLUG}`), "remoção entra no pathspec do commit");
    assert.ok(commit!.includes(`workers/site/public/p/${NEW_SLUG}`));
    assert.ok(!sitemap.includes(`<loc>${archiveUrlForSlug(OLD_SLUG)}</loc>`));
  });

  it("mesmo slug: não toca no PR anterior", () => {
    const { ghCalls } = run("OPEN", { previousSlug: NEW_SLUG });
    assert.ok(!ghCalls.some((c) => c[1] === "close"));
  });

  it("--skip-publish: nunca fecha PR", () => {
    const { ghCalls } = run("OPEN", { skipPublish: true });
    assert.ok(!ghCalls.some((c) => c[1] === "close"));
  });
});

function realGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

describe("#10194 commitAndPushSitePage remove a página velha já mergeada (git real, worktree)", () => {
  it("página velha tracked em origin/master sai no commit da branch nova", () => {
    const rootDir = tmp("diaria-10194-git-root-");
    const bare = tmp("diaria-10194-git-origin-");
    realGit(["init", "-b", "master"], rootDir);
    realGit(["config", "user.email", "t@example.com"], rootDir);
    realGit(["config", "user.name", "T"], rootDir);
    writeOldPublication(rootDir);
    realGit(["add", "-A"], rootDir);
    realGit(["commit", "-m", "init com a página velha mergeada"], rootDir);
    rmSync(bare, { recursive: true, force: true });
    realGit(["clone", "--bare", rootDir, bare], rootDir);
    realGit(["remote", "add", "origin", bare], rootDir);
    realGit(["fetch", "origin"], rootDir);

    // o que a republicação faz antes do commit: supersede + página nova escrita
    const { gh } = makeGh("MERGED");
    const out = supersedePreviousSitePage(rootDir, gh, {
      oldSlug: OLD_SLUG,
      newSlug: NEW_SLUG,
      oldPrNumber: OLD_PR,
      sitemapRelPath: SITEMAP_REL,
    });
    mkdirSync(join(rootDir, "workers", "site", "public", "p", NEW_SLUG), { recursive: true });
    writeFileSync(join(rootDir, "workers", "site", "public", "p", NEW_SLUG, "index.html"), "<html>nova</html>", "utf8");

    const wt = tmp("diaria-10194-git-wt-");
    rmSync(wt, { recursive: true, force: true });
    const res = commitAndPushSitePage(rootDir, NEW_SLUG, realGit, SITEMAP_REL, gh, noopLock, noopSleep, wt, out.removedPaths);
    assert.equal(res.pushed, true);

    realGit(["fetch", "origin"], rootDir);
    const files = realGit(["ls-tree", "-r", "--name-only", `origin/site-publish/${NEW_SLUG}`], rootDir);
    assert.ok(files.includes(`workers/site/public/p/${NEW_SLUG}/index.html`));
    assert.ok(!files.includes(`workers/site/public/p/${OLD_SLUG}/`), "página velha deveria ter saído no commit");
    const sitemap = realGit(["show", `origin/site-publish/${NEW_SLUG}:${SITEMAP_REL}`], rootDir);
    assert.ok(!sitemap.includes(`<loc>${archiveUrlForSlug(OLD_SLUG)}</loc>`));
  });

  it("página velha NÃO tracked (PR velho nunca mergeou): removedPaths não lança nem remove nada", () => {
    const rootDir = tmp("diaria-10194-git-root-");
    const bare = tmp("diaria-10194-git-origin-");
    realGit(["init", "-b", "master"], rootDir);
    realGit(["config", "user.email", "t@example.com"], rootDir);
    realGit(["config", "user.name", "T"], rootDir);
    mkdirSync(join(rootDir, "workers", "site", "public"), { recursive: true });
    writeFileSync(join(rootDir, SITEMAP_REL), buildSitemapXml([]), "utf8");
    realGit(["add", "-A"], rootDir);
    realGit(["commit", "-m", "init"], rootDir);
    rmSync(bare, { recursive: true, force: true });
    realGit(["clone", "--bare", rootDir, bare], rootDir);
    realGit(["remote", "add", "origin", bare], rootDir);
    realGit(["fetch", "origin"], rootDir);
    mkdirSync(join(rootDir, "workers", "site", "public", "p", NEW_SLUG), { recursive: true });
    writeFileSync(join(rootDir, "workers", "site", "public", "p", NEW_SLUG, "index.html"), "<html>nova</html>", "utf8");
    const wt = tmp("diaria-10194-git-wt-");
    rmSync(wt, { recursive: true, force: true });
    const { gh } = makeGh("OPEN");
    const res = commitAndPushSitePage(rootDir, NEW_SLUG, realGit, SITEMAP_REL, gh, noopLock, noopSleep, wt, [
      `workers/site/public/p/${OLD_SLUG}`,
    ]);
    assert.equal(res.pushed, true);
  });
});
