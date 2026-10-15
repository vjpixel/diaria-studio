/**
 * test/site-page-republish-retry-10198-10199-10196.test.ts
 *
 * #10198 (REGRESSÃO): republicação com slug novo roda o supersede, `publish`
 * lança (push/lock/worktree) e sai `code: 3`. O state era sobrescrito sem
 * slug, `readPreviousSitePage` devolvia `null` na rodada seguinte, o supersede
 * não rodava e `p/{slug-velho}` (PR velho já mergeado) ficava no master.
 *
 * #10199 (REGRESSÃO): página A → B (close do PR #A falhou, #A no marcador) → A
 * de novo. A publicação reusa o PR #A ainda aberto e o waiter dele lia o
 * marcador e desistia em silêncio.
 *
 * #10196: bypass de `stale`/`no-pr` é irrecuperável (nenhum waiter publica a
 * página certa) — grava `unrecoverable`, loga `error` e notifica urgente;
 * `pending`/`blocked` seguem como antes.
 *
 * Nenhum teste toca `gh` real: `GhRunner` é sempre fake.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishEditionSitePage,
  productionDeps,
  readPreviousSitePage,
  readSupersededPrNumbers,
  unmarkSitePagePrSuperseded,
  writeSitePageState,
  runMergeWaiter,
  type PublishPageDeps,
  type GitRunner,
  type GhRunner,
  type LockRunner,
  type SleepFn,
} from "../scripts/publish-edition-site-page.ts";
import {
  alertUnrecoverableBypass,
  runSitePagePrGate,
  exitCodeForVerdict,
} from "../scripts/check-site-page-pr-gate.ts";
import type { EditionPageInputs } from "../scripts/lib/edition-site-page.ts";
import type { NotifyEditorFinding } from "../scripts/lib/editor-notify.ts";
import { buildSitemapXml, archiveUrlForSlug } from "../scripts/lib/site-archive-pages.ts";

const SITEMAP_REL = "workers/site/public/sitemap.xml";
const SLUG_A = "titulo-velho-do-d1";
const SLUG_B = "titulo-novo-do-d1";
const PR_A = 100;
const PR_B = 200;
const url = (n: number) => `https://github.com/vjpixel/diaria-studio/pull/${n}`;

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
const statePath = (ed: string) => join(ed, "_internal", "site-page-published.json");
const readState = (ed: string) => JSON.parse(readFileSync(statePath(ed), "utf8")) as Record<string, unknown>;

function makeInputs(slug: string): EditionPageInputs {
  return {
    html: "<p>corpo</p>",
    postUrl: `https://diar.ia.br/p/${slug}`,
    title: "Título",
    subtitle: "Sub",
    publishedAtIso: "2026-10-14T09:00:00Z",
  };
}

function writePublication(rootDir: string, slug: string): void {
  mkdirSync(join(rootDir, "workers", "site", "public", "p", slug), { recursive: true });
  writeFileSync(join(rootDir, "workers", "site", "public", "p", slug, "index.html"), "<html>velha</html>", "utf8");
  writeFileSync(join(rootDir, ...SITEMAP_REL.split("/")), buildSitemapXml([{ loc: archiveUrlForSlug(slug) }]), "utf8");
}

/** git fake: página velha está tracked (PR velho já mergeado). */
function makeGit(trackedSlug: string) {
  const calls: string[][] = [];
  const staged: string[] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
    if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
    if (args[0] === "add" || args[0] === "rm") {
      staged.push(args[args.length - 1]);
      return "";
    }
    if (args[0] === "ls-files") return String(args[2]).endsWith(`/p/${trackedSlug}`) ? `${args[2]}/index.html\n` : "";
    if (args[0] === "status") return " M x\n";
    if (args[0] === "diff") return staged.join("\n");
    return "";
  };
  return { git, calls };
}

describe("#10198 last_published sobrevive a tentativa falha", () => {
  it("publicado A → code:3 → readPreviousSitePage ainda devolve A; publicado B substitui", () => {
    const ed = tmp("diaria-10198-ed-");
    writeSitePageState(ed, { code: 0, slug: SLUG_A, bytes: 1, published: true, prUrl: url(PR_A), merged: true });
    assert.deepEqual(readPreviousSitePage(ed), { slug: SLUG_A, prNumber: PR_A });
    writeSitePageState(ed, { code: 3, reason: "commit/push falhou" });
    assert.equal(readState(ed).published, false);
    assert.deepEqual(readPreviousSitePage(ed), { slug: SLUG_A, prNumber: PR_A }, "falha não apaga a memória do slug");
    writeSitePageState(ed, { code: 3, reason: "de novo" });
    assert.deepEqual(readPreviousSitePage(ed), { slug: SLUG_A, prNumber: PR_A }, "herança encadeia");
    writeSitePageState(ed, { code: 0, slug: SLUG_B, bytes: 1, published: true, prUrl: url(PR_B), merged: false });
    assert.deepEqual(readPreviousSitePage(ed), { slug: SLUG_B, prNumber: PR_B });
    assert.deepEqual(readState(ed).last_published, { slug: SLUG_B, prNumber: PR_B });
  });

  it("REGRESSÃO: supersede → publish lança → retry refaz o supersede e tira p/{slug-velho} do master", () => {
    const rootDir = tmp("diaria-10198-root-");
    const ed = tmp("diaria-10198-ed-");
    writePublication(rootDir, SLUG_A);
    writeSitePageState(ed, { code: 0, slug: SLUG_A, bytes: 1, published: true, prUrl: url(PR_A), merged: true });
    const gh: GhRunner = (args) => {
      const cmd = args.slice(0, 2).join(" ");
      if (cmd === "pr view" && args[2] === String(PR_A)) return JSON.stringify({ state: "MERGED" });
      if (cmd === "pr list") return "[]";
      if (cmd === "pr create") return `${url(PR_B)}\n`;
      if (cmd === "pr view") return JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable: "MERGEABLE" });
      return "";
    };

    // 1ª tentativa: supersede roda, o publish lança (push falhou).
    const g1 = makeGit(SLUG_A);
    const deps1: PublishPageDeps = {
      ...productionDeps(rootDir, g1.git, gh, noopLock, noopSleep, undefined, () => ({ pid: 1 }), 0),
      readEditionInputs: () => makeInputs(SLUG_B),
      publish: () => {
        throw new Error("push recusado (simulado)");
      },
      log: () => {},
    };
    const r1 = publishEditionSitePage(ed, deps1, { sitemap: SITEMAP_REL, previous: readPreviousSitePage(ed) });
    assert.equal(r1.code, 3);
    writeSitePageState(ed, r1);

    // 2ª tentativa (o playbook manda rodar de novo): previous ainda é A.
    assert.deepEqual(readPreviousSitePage(ed), { slug: SLUG_A, prNumber: PR_A });
    const g2 = makeGit(SLUG_A);
    const deps2: PublishPageDeps = {
      ...productionDeps(rootDir, g2.git, gh, noopLock, noopSleep, undefined, () => ({ pid: 1 }), 0),
      readEditionInputs: () => makeInputs(SLUG_B),
      log: () => {},
    };
    const r2 = publishEditionSitePage(ed, deps2, { sitemap: SITEMAP_REL, previous: readPreviousSitePage(ed) });
    assert.equal(r2.code, 0);
    const rm = g2.calls.find((c) => c[0] === "rm");
    assert.deepEqual(rm, ["rm", "-r", "-q", "--", `workers/site/public/p/${SLUG_A}`], "página velha sai no commit do retry");
    const commit = g2.calls.find((c) => c[0] === "commit");
    assert.ok(commit!.includes(`workers/site/public/p/${SLUG_A}`));
  });
});

describe("#10199 PR que volta a ser o corrente sai do marcador", () => {
  it("unmarkSitePagePrSuperseded tira só o número pedido; ausente é no-op", () => {
    const ed = tmp("diaria-10199-ed-");
    mkdirSync(join(ed, "_internal"), { recursive: true });
    writeFileSync(join(ed, "_internal", "site-page-superseded.json"), JSON.stringify({ prNumbers: [PR_A, PR_B] }));
    assert.equal(unmarkSitePagePrSuperseded(ed, 999), undefined);
    assert.deepEqual(readSupersededPrNumbers(ed), [PR_A, PR_B]);
    assert.equal(unmarkSitePagePrSuperseded(ed, PR_A), undefined);
    assert.deepEqual(readSupersededPrNumbers(ed), [PR_B]);
  });

  it("REGRESSÃO: A → B → A reusa o PR #A — marcador limpo antes do waiter, e o waiter mergeia", async () => {
    const rootDir = tmp("diaria-10199-root-");
    const ed = tmp("diaria-10199-ed-");
    mkdirSync(join(rootDir, "workers", "site", "public"), { recursive: true });
    writeFileSync(join(rootDir, ...SITEMAP_REL.split("/")), buildSitemapXml([]), "utf8");
    // A → B rodou com o close do #A falhando: #A ficou no marcador e aberto.
    mkdirSync(join(ed, "_internal"), { recursive: true });
    writeFileSync(join(ed, "_internal", "site-page-superseded.json"), JSON.stringify({ prNumbers: [PR_A] }));
    writeSitePageState(ed, { code: 0, slug: SLUG_B, bytes: 1, published: true, prUrl: url(PR_B), merged: false });

    const pending = JSON.stringify({
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }],
    });
    const gh: GhRunner = (args) => {
      const cmd = args.slice(0, 2).join(" ");
      if (cmd === "pr list") return JSON.stringify([{ number: PR_A, url: url(PR_A) }]); // branch site-publish/A reusada
      if (cmd === "pr view" && args[2] === String(PR_B)) return JSON.stringify({ state: "OPEN" });
      if (cmd === "pr view") return pending;
      return "";
    };
    let markerAtSpawn: number[] | undefined;
    const { git } = makeGit("nenhum");
    const deps: PublishPageDeps = {
      ...productionDeps(rootDir, git, gh, noopLock, noopSleep, undefined, () => {
        markerAtSpawn = readSupersededPrNumbers(ed);
        return { pid: 1 };
      }, 0),
      readEditionInputs: () => makeInputs(SLUG_A),
      log: () => {},
    };
    const r = publishEditionSitePage(ed, deps, { sitemap: SITEMAP_REL, previous: readPreviousSitePage(ed) });
    assert.equal(r.code, 0);
    assert.ok("prUrl" in r && r.prUrl === url(PR_A));
    assert.ok(markerAtSpawn !== undefined, "waiter deveria ter sido disparado (CI pendente)");
    assert.ok(!markerAtSpawn!.includes(PR_A), "PR #A ainda estava no marcador quando o waiter nasceu");
    // A volta pra A supersede o B: B entra no marcador, A não.
    assert.deepEqual(readSupersededPrNumbers(ed), [PR_B]);
    writeSitePageState(ed, r);

    // O waiter de #A, com CI verde, mergeia em vez de desistir.
    const merges: string[][] = [];
    const ghWaiter: GhRunner = (args) => {
      if (args[1] === "merge") {
        merges.push(args);
        return "";
      }
      return JSON.stringify({
        state: "OPEN",
        mergeable: "MERGEABLE",
        headRefOid: "a".repeat(40),
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      });
    };
    const res = await runMergeWaiter(rootDir, PR_A, ed, ghWaiter, noopSleep, 1_000, 1, async () => {
      throw new Error("não deveria alertar");
    });
    assert.equal(res.merged, true, res.reason);
    assert.equal(merges.length, 1);
  });
});

describe("#10196 bypass irrecuperável (stale/no-pr) alerta à parte", () => {
  const never: GhRunner = (args) => {
    throw new Error(`gh não deveria ser consultado: ${args.join(" ")}`);
  };

  function edition(): string {
    const root = tmp("diaria-10196-");
    const dir = join(root, "261015");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<html>v1</html>");
    return dir;
  }

  it("stale + bypass → unrecoverable gravado, log error + notifyEditor urgente com o slug do e-mail", async () => {
    const dir = edition();
    writeFileSync(
      statePath(dir),
      JSON.stringify({ code: 0, slug: "slug-velho", published: true, prUrl: url(PR_A), merged: true }),
    );
    const verdict = runSitePagePrGate("/repo", dir, {
      gh: never,
      expectedSlug: "slug-do-email",
      bypassReason: "--no-gates: stale",
    });
    assert.equal(verdict.kind, "bypassed");
    assert.equal(exitCodeForVerdict(verdict), 0, "newsletter segue saindo");
    assert.equal((verdict as { unrecoverable?: boolean }).unrecoverable, true);
    assert.equal((readState(dir).prGateBypass as { unrecoverable?: boolean }).unrecoverable, true);

    const logs: Array<{ level: string; message: string }> = [];
    const findings: NotifyEditorFinding[] = [];
    const alerted = await alertUnrecoverableBypass("/repo", dir, verdict, {
      log: (e) => logs.push({ level: e.level, message: e.message }),
      notify: async (f) => {
        findings.push(f);
      },
    });
    assert.equal(alerted, true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "error");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "urgente");
    assert.match(findings[0].subject, /\/p\/slug-do-email/);
    assert.match(findings[0].subject, /261015/);
    assert.match(findings[0].body, /waiter/);
  });

  it("no-pr + bypass também é irrecuperável", async () => {
    const dir = edition();
    const verdict = runSitePagePrGate("/repo", dir, { gh: never, bypassReason: "--no-gates: sem PR" });
    assert.equal((verdict as { unrecoverable?: boolean }).unrecoverable, true);
    let notified = 0;
    await alertUnrecoverableBypass("/repo", dir, verdict, { log: () => {}, notify: async () => void notified++ });
    assert.equal(notified, 1);
  });

  it("blocked + bypass segue recuperável: sem unrecoverable, sem alerta", async () => {
    const dir = edition();
    writeFileSync(
      statePath(dir),
      JSON.stringify({ code: 0, slug: "slug-x", published: true, prUrl: url(PR_A), merged: false }),
    );
    const gh: GhRunner = (args) => {
      if (args[1] === "view") {
        return JSON.stringify({
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "a".repeat(40),
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
        });
      }
      throw new Error("não pode mergear");
    };
    const verdict = runSitePagePrGate("/repo", dir, { gh, sleep: noopSleep, expectedSlug: "slug-x", bypassReason: "flake" });
    assert.equal(verdict.kind, "bypassed");
    assert.equal((verdict as { unrecoverable?: boolean }).unrecoverable, undefined);
    assert.equal((readState(dir).prGateBypass as { unrecoverable?: boolean }).unrecoverable, undefined);
    const alerted = await alertUnrecoverableBypass("/repo", dir, verdict, {
      log: () => assert.fail("não deveria logar"),
      notify: async () => assert.fail("não deveria notificar"),
    });
    assert.equal(alerted, false);
  });

  it("notify que lança não derruba o alerta (fail-soft)", async () => {
    const dir = edition();
    const verdict = runSitePagePrGate("/repo", dir, { gh: never, bypassReason: "x" });
    const ok = await alertUnrecoverableBypass("/repo", dir, verdict, {
      log: () => {},
      notify: async () => {
        throw new Error("gh fora");
      },
    });
    assert.equal(ok, true);
  });
});
