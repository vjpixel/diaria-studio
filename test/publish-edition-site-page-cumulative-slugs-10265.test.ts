/**
 * test/publish-edition-site-page-cumulative-slugs-10265.test.ts (#10265)
 *
 * REGRESSÃO: o redirect `/p/{velho} /p/{novo} 301` e o `git rm` da página
 * velha só viviam no commit do PR da republicação que TROCOU o slug. Toda
 * republicação reconstrói `site-publish/{slug}` a partir de master
 * (`checkout -B` + `push --force-with-lease`), então:
 *
 *   1. A→B→B: o Stage 5 publica A (mergeado), a republicação gera B (redirect
 *      A→B + `git rm p/A` no PR B), e a trava do Stage 6 republica B com o
 *      MESMO slug. Como `previous.slug === B`, nada era reaplicado: o PR B
 *      perdia o redirect e a remoção, e o sitemap do checkout (re-sincronizado
 *      com master) voltava a listar A.
 *   2. A→B→C com o PR B fechado antes do merge: o PR C só levava B→C; o A→B
 *      sumia e `/p/A` dava 404 nos posts sociais já agendados.
 *
 * Os dois cenários rodam ponta a ponta sobre git REAL (origin bare + worktree
 * de publicação), com o state file gravado por `writeSitePageState` entre as
 * chamadas, exatamente como o `main` faz. `gh` é sempre um fake.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishEditionSitePage,
  productionDeps,
  writeSitePageState,
  readPreviousSitePage,
  readSitePageSlugHistory,
  publishedSlugHistory,
  slugRedirectSources,
  type PublishPageDeps,
  type GhRunner,
  type LockRunner,
  type SleepFn,
} from "../scripts/publish-edition-site-page.ts";
import type { EditionPageInputs } from "../scripts/lib/edition-site-page.ts";
import { buildSitemapXml, archiveUrlForSlug } from "../scripts/lib/site-archive-pages.ts";

const SITEMAP_REL = "workers/site/public/sitemap.xml";
const REDIRECTS_REL = "workers/site/public/_redirects";
const A = "titulo-a-do-d1";
const B = "titulo-b-do-d1";
const C = "titulo-c-do-d1";

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

/** gh fake com PRs numerados por branch; estado de cada PR controlado pelo teste. */
function makeGh() {
  const prByBranch = new Map<string, number>();
  const states = new Map<number, string>();
  let next = 1;
  const gh: GhRunner = (args) => {
    const cmd = args.slice(0, 2).join(" ");
    if (cmd === "pr list") {
      const head = args[args.indexOf("--head") + 1];
      const n = prByBranch.get(head);
      return n !== undefined && states.get(n) === "OPEN" ? JSON.stringify([{ number: n, url: prUrl(n) }]) : "[]";
    }
    if (cmd === "pr create") {
      const head = args[args.indexOf("--head") + 1];
      const n = next++;
      prByBranch.set(head, n);
      states.set(n, "OPEN");
      return `${prUrl(n)}\n`;
    }
    if (cmd === "pr view") {
      const n = Number(args[2]);
      // CI pendente: o publish delega ao waiter (fake) e não mergeia sozinho.
      return JSON.stringify({
        state: states.get(n) ?? "OPEN",
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

function makeInputs(slug: string): EditionPageInputs {
  return {
    html: "<p>corpo</p>",
    postUrl: `https://diar.ia.br/p/${slug}`,
    title: "Título",
    subtitle: "Sub",
    publishedAtIso: "2026-10-14T09:00:00Z",
  };
}

/** Repo com sitemap + `_redirects` commitados e origin bare sincronizado. */
function makeRepo(): string {
  const rootDir = tmp("diaria-10265-root-");
  const bare = tmp("diaria-10265-origin-");
  realGit(["init", "-b", "master"], rootDir);
  realGit(["config", "user.email", "t@example.com"], rootDir);
  realGit(["config", "user.name", "T"], rootDir);
  mkdirSync(join(rootDir, "workers", "site", "public"), { recursive: true });
  writeFileSync(join(rootDir, SITEMAP_REL), buildSitemapXml([{ loc: archiveUrlForSlug("edicao-de-ontem") }]), "utf8");
  writeFileSync(join(rootDir, REDIRECTS_REL), "/p/x /p/y 301\n", "utf8");
  realGit(["add", "-A"], rootDir);
  realGit(["commit", "-m", "init"], rootDir);
  rmSync(bare, { recursive: true, force: true });
  realGit(["clone", "--bare", rootDir, bare], rootDir);
  realGit(["remote", "add", "origin", bare], rootDir);
  realGit(["fetch", "origin"], rootDir);
  return rootDir;
}

/** Uma chamada do `main`: lê o state, publica (worktree novo) e grava o state. */
function publishOnce(rootDir: string, ed: string, gh: GhRunner, slug: string) {
  const wt = tmp("diaria-10265-wt-");
  rmSync(wt, { recursive: true, force: true });
  const logs: string[] = [];
  const deps: PublishPageDeps = {
    ...productionDeps(rootDir, realGit, gh, noopLock, noopSleep, wt, () => ({ pid: 1 }), 0),
    readEditionInputs: () => makeInputs(slug),
    log: (l) => logs.push(l),
  };
  const result = publishEditionSitePage(ed, deps, {
    sitemap: SITEMAP_REL,
    previous: readPreviousSitePage(ed),
    priorSlugs: readSitePageSlugHistory(ed),
  });
  writeSitePageState(ed, result);
  assert.equal(result.code, 0, logs.join("\n"));
  return result;
}

/** Simula o merge do PR da branch `site-publish/{slug}` em master. */
function mergeBranch(rootDir: string, slug: string, states: Map<number, string>, prByBranch: Map<string, number>): void {
  realGit(["fetch", "origin"], rootDir);
  realGit(["push", "origin", `refs/remotes/origin/site-publish/${slug}:refs/heads/master`], rootDir);
  realGit(["fetch", "origin"], rootDir);
  states.set(prByBranch.get(`site-publish/${slug}`)!, "MERGED");
}

/** O `sync-code` do checkout compartilhado: arquivos rastreados voltam ao master. */
function syncCheckout(rootDir: string): void {
  realGit(["reset", "--hard", "origin/master"], rootDir);
}

function branchTree(rootDir: string, slug: string) {
  realGit(["fetch", "origin"], rootDir);
  const ref = `origin/site-publish/${slug}`;
  return {
    files: realGit(["ls-tree", "-r", "--name-only", ref], rootDir),
    redirects: realGit(["show", `${ref}:${REDIRECTS_REL}`], rootDir),
    sitemap: realGit(["show", `${ref}:${SITEMAP_REL}`], rootDir),
  };
}

describe("#10265 helpers", () => {
  it("publishedSlugHistory: lê o campo, deduplica e semeia com o last_published de state antigo", () => {
    assert.deepEqual(publishedSlugHistory(null), []);
    assert.deepEqual(publishedSlugHistory({ published: true, slug: A }), [A]);
    assert.deepEqual(publishedSlugHistory({ published: false, last_published: { slug: A } }), [A]);
    assert.deepEqual(publishedSlugHistory({ published_slugs: [A, B, A, 3, ""], published: true, slug: B }), [A, B]);
  });

  it("writeSitePageState acumula slugs confirmados e herda o histórico em tentativa falha", () => {
    const ed = tmp("diaria-10265-ed-");
    writeSitePageState(ed, { code: 0, slug: A, bytes: 1, published: true, prUrl: prUrl(1), merged: true });
    writeSitePageState(ed, { code: 3, reason: "push falhou" });
    writeSitePageState(ed, { code: 0, slug: B, bytes: 1, published: true, prUrl: prUrl(2), merged: false });
    writeSitePageState(ed, { code: 0, slug: B, bytes: 1, published: true, prUrl: prUrl(2), merged: false });
    assert.deepEqual(readSitePageSlugHistory(ed), [A, B]);
  });

  it("slugRedirectSources: sem repetição e sem o próprio destino", () => {
    assert.deepEqual(slugRedirectSources({ oldSlug: B, newSlug: C, priorSlugs: [A, B, C] }), [B, A]);
  });
});

describe("#10265 republicação reaplica redirect/remoção de TODOS os slugs anteriores (git real)", () => {
  it("cenário 1 — A→B→B: a republicação com o mesmo slug mantém o redirect A→B e a remoção de p/A", () => {
    const rootDir = makeRepo();
    const ed = tmp("diaria-10265-ed-");
    const { gh, states, prByBranch } = makeGh();

    publishOnce(rootDir, ed, gh, A);
    mergeBranch(rootDir, A, states, prByBranch); // PR A mergeado: p/A está em master
    publishOnce(rootDir, ed, gh, B); // D1 retitulado
    syncCheckout(rootDir); // checkout re-sincronizado: sitemap de master volta a listar A
    publishOnce(rootDir, ed, gh, B); // gate do Stage 6 deu stale: mesmo slug

    const t = branchTree(rootDir, B);
    assert.ok(t.files.includes(`workers/site/public/p/${B}/index.html`));
    assert.ok(!t.files.includes(`workers/site/public/p/${A}/`), "p/A saiu do commit da republicação");
    assert.ok(t.redirects.includes(`/p/${A} /p/${B} 301\n`), `redirect A→B perdido:\n${t.redirects}`);
    assert.ok(t.redirects.startsWith("/p/x /p/y 301\n"), "regras de outras edições preservadas");
    assert.ok(!t.sitemap.includes(`<loc>${archiveUrlForSlug(A)}</loc>`), "sitemap não pode voltar a listar A");
    assert.ok(t.sitemap.includes(`<loc>${archiveUrlForSlug(B)}</loc>`));
  });

  it("cenário 2 — A→B→C com o PR B fechado antes do merge: o PR C leva A→C e B→C", () => {
    const rootDir = makeRepo();
    const ed = tmp("diaria-10265-ed-");
    const { gh, states, prByBranch } = makeGh();

    publishOnce(rootDir, ed, gh, A);
    mergeBranch(rootDir, A, states, prByBranch);
    publishOnce(rootDir, ed, gh, B); // PR B aberto, não mergeado
    publishOnce(rootDir, ed, gh, C); // fecha o PR B

    assert.equal(states.get(prByBranch.get(`site-publish/${B}`)!), "CLOSED");
    const t = branchTree(rootDir, C);
    assert.ok(t.redirects.includes(`/p/${A} /p/${C} 301\n`), `redirect de A perdido:\n${t.redirects}`);
    assert.ok(t.redirects.includes(`/p/${B} /p/${C} 301\n`));
    assert.ok(!t.redirects.split("\n").some((l) => l.startsWith(`/p/${C} `)), "o slug atual nunca é origem de regra (sem loop)");
    assert.ok(!t.files.includes(`workers/site/public/p/${A}/`), "p/A (mergeada) sai no commit do PR C");
    assert.ok(t.files.includes(`workers/site/public/p/${C}/index.html`));
    assert.ok(!t.sitemap.includes(`<loc>${archiveUrlForSlug(A)}</loc>`));
    assert.ok(!t.sitemap.includes(`<loc>${archiveUrlForSlug(B)}</loc>`));
    assert.deepEqual(readSitePageSlugHistory(ed), [A, B, C]);
  });

  it("A→B→A: voltar ao slug original nunca remove a página atual nem cria regra com origem nela", () => {
    const rootDir = makeRepo();
    const ed = tmp("diaria-10265-ed-");
    const { gh, states, prByBranch } = makeGh();

    publishOnce(rootDir, ed, gh, A);
    mergeBranch(rootDir, A, states, prByBranch);
    publishOnce(rootDir, ed, gh, B);
    publishOnce(rootDir, ed, gh, A);

    const t = branchTree(rootDir, A);
    assert.ok(t.files.includes(`workers/site/public/p/${A}/index.html`), "página atual tem que ficar");
    assert.ok(t.redirects.includes(`/p/${B} /p/${A} 301\n`));
    assert.ok(!t.redirects.split("\n").some((l) => l.startsWith(`/p/${A} `)), `regra com origem no slug atual:\n${t.redirects}`);
    const current = readFileSync(join(rootDir, "workers", "site", "public", "p", A, "index.html"), "utf8");
    assert.ok(current.length > 0);
  });
});
