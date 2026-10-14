/**
 * test/site-page-pr-first-10160.test.ts (#10160)
 *
 * O PR da página do site passou a ser aberto no INÍCIO da Etapa 5 (§5b-site,
 * `publish-edition-site-page.ts --no-wait-merge`), sem esperar o merge, e o
 * fim da Etapa 6 passou a travar no merge (`check-site-page-pr-gate.ts` antes
 * do Schedule + invariante `site-page-pr-merged`, coberto em
 * test/check-invariants-stage-6.test.ts).
 *
 * Critérios de pronto travados aqui:
 *   1. o dispatch registra o PR (prNumber/prUrl/status:"open") ANTES de
 *      qualquer publisher — ordem no playbook + o publish que não espera;
 *   2. o Stage 6 recusa terminar com o PR OPEN — a trava devolve exit != 0
 *      pra CI pendente/vermelho/desconhecido e só segue com MERGED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  applyMergeWaiterResult,
  deriveSlugFromD1,
  EditionInputsInvalid,
  productionDeps,
  sitePagePrStatus,
  writeSitePageState,
  type GhRunner,
  type GitRunner,
  type MergeWaiterSpawner,
} from "../scripts/publish-edition-site-page.ts";
import {
  classifyMergeAttempt,
  exitCodeForVerdict,
  runSitePagePrGate,
} from "../scripts/check-site-page-pr-gate.ts";
import { seoSlug } from "../scripts/lib/slug.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASSING = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const RUNNING = { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null };
const FAILING = { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" };
const HEAD = "a".repeat(40);
const PR_URL = "https://github.com/vjpixel/diaria-studio/pull/10200";

function view(entries: unknown[], state = "OPEN", mergeable = "MERGEABLE"): string {
  return JSON.stringify({ statusCheckRollup: entries, mergeable, state, headRefOid: HEAD });
}

const git: GitRunner = (args) => {
  if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
  if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
  if (args[0] === "status") return " M workers/site/public/p/meu-slug/index.html\n";
  if (args[0] === "diff") return "workers/site/public/p/meu-slug/index.html\n";
  return "";
};
const lock = () => ({ ok: true, stdout: "", stderr: "" });

function edition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-10160-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}
const statePath = (dir: string) => join(dir, "_internal", "site-page-published.json");
const readState = (dir: string) => JSON.parse(readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;

describe("Stage 5 (--no-wait-merge): abre o PR e NÃO espera o merge (#10160)", () => {
  it("syncWaitMs=0 com CI pendente: 1 único gh pr view, nenhum sleep, waiter disparado na hora", () => {
    const views: string[][] = [];
    let sleeps = 0;
    const spawned: number[] = [];
    const spawnWaiter: MergeWaiterSpawner = ({ prNumber }) => {
      spawned.push(prNumber);
      return { pid: 1 };
    };
    const gh: GhRunner = (args) => {
      if (args[1] === "list") return "[]";
      if (args[1] === "create") return `${PR_URL}\n`;
      if (args[1] === "view") {
        views.push(args);
        return view([RUNNING]);
      }
      throw new Error(`gh inesperado com CI pendente: ${args.join(" ")}`);
    };
    const result = productionDeps("/repo", git, gh, lock, () => sleeps++, undefined, spawnWaiter, 0).publish(
      "meu-slug",
      undefined,
      "/repo/data/editions/2610/261015",
    );
    assert.equal(views.length, 1, "Stage 5 não pode ficar em poll esperando o CI");
    assert.equal(sleeps, 0, "Stage 5 não pode dormir esperando o CI");
    assert.deepEqual(spawned, [10200]);
    assert.equal(result.merged, false);
    assert.equal(result.prNumber, 10200);
  });

  it("grava prNumber/prUrl/status:'open' no state file — é o registro que a trava do Stage 6 lê", () => {
    const dir = edition();
    writeSitePageState(dir, { code: 0, slug: "meu-slug", bytes: 10, published: true, prUrl: PR_URL, merged: false, mergeReason: "CI não convergiu em 0ms" });
    const s = readState(dir);
    assert.equal(s.prNumber, 10200);
    assert.equal(s.prUrl, PR_URL);
    assert.equal(s.status, "open");
    assert.ok(typeof s.mergeBlocker === "string");
    rmSync(dir, { recursive: true, force: true });
  });

  it("--slug-from-d1: seoSlug do título do D1 (o mesmo slug do link de WhatsApp do e-mail); sem D1 → EditionInputsInvalid", () => {
    const dir = edition();
    writeFileSync(
      join(dir, "02-reviewed.md"),
      [
        "**DESTAQUE 1 | BRASIL**",
        "",
        "**[Governo lança plano de IA: o que muda](https://example.com/a)**",
        "",
        "Corpo do destaque.",
        "",
        "Por que isso importa:",
        "",
        "Porque sim.",
        "",
        "---",
        "",
      ].join("\n"),
    );
    const slug = deriveSlugFromD1(dir);
    assert.equal(slug, seoSlug("Governo lança plano de IA: o que muda"));
    writeFileSync(join(dir, "02-reviewed.md"), "sem destaque nenhum\n");
    assert.throws(() => deriveSlugFromD1(dir), EditionInputsInvalid);
    rmSync(join(dir, "02-reviewed.md"));
    assert.throws(() => deriveSlugFromD1(dir), EditionInputsInvalid);
    rmSync(dir, { recursive: true, force: true });
  });

  it("sitePagePrStatus: merged > open (PR identificado) > none", () => {
    assert.equal(sitePagePrStatus({ merged: true, prUrl: PR_URL }), "merged");
    assert.equal(sitePagePrStatus({ merged: false, prUrl: PR_URL }), "open");
    assert.equal(sitePagePrStatus({ prUrl: PR_URL }), "open");
    assert.equal(sitePagePrStatus({ merged: false }), "none");
    assert.equal(sitePagePrStatus({ prUrl: "https://example.com/x" }), "none");
  });

  it("applyMergeWaiterResult atualiza status e aceita o rótulo de quem mergeou", () => {
    const next = applyMergeWaiterResult(
      { published: true, prUrl: PR_URL, merged: false, status: "open", slug: "s", mergeBlocker: "x" },
      10200,
      { merged: true, reason: "CI verde" },
      new Date("2026-10-14T20:00:00Z"),
      "trava do Stage 6 (#10160)",
    );
    assert.ok(next);
    assert.equal(next!.status, "merged");
    assert.equal(next!.mergeReason, "trava do Stage 6 (#10160): CI verde");
    assert.equal(next!.mergeBlocker, undefined);
  });
});

describe("trava do Stage 6 — check-site-page-pr-gate.ts (#10160)", () => {
  const openState = { code: 0, slug: "meu-slug", published: true, prUrl: PR_URL, prNumber: 10200, status: "open", merged: false };

  function run(state: Record<string, unknown> | null, gh: GhRunner, waitMs = 0) {
    const dir = edition();
    if (state) writeFileSync(statePath(dir), JSON.stringify(state));
    const verdict = runSitePagePrGate("/repo", dir, { gh, sleep: () => {}, waitMs, pollMs: 1 });
    const after = state ? readState(dir) : null;
    rmSync(dir, { recursive: true, force: true });
    return { verdict, after };
  }

  it("REGRESSÃO #10160: PR OPEN com CI pendente → 'pending' (exit 3), nunca segue pro Schedule", () => {
    const { verdict } = run(openState, (args) => {
      if (args[1] === "view") return view([PASSING, RUNNING]);
      throw new Error(`não pode mergear com CI pendente: ${args.join(" ")}`);
    });
    assert.equal(verdict.kind, "pending");
    assert.equal(exitCodeForVerdict(verdict), 3);
  });

  it("PR OPEN com CI verde → mergeia (squash + match-head-commit), grava merged no state, exit 0", () => {
    const merges: string[][] = [];
    const { verdict, after } = run(openState, (args) => {
      if (args[1] === "view") return view([PASSING]);
      if (args[1] === "merge") {
        merges.push(args);
        return "";
      }
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    });
    assert.equal(verdict.kind, "merged");
    assert.equal(exitCodeForVerdict(verdict), 0);
    assert.equal(merges.length, 1);
    assert.ok(merges[0].includes("--squash"));
    assert.equal(merges[0][merges[0].indexOf("--match-head-commit") + 1], HEAD);
    assert.equal(after!.merged, true);
    assert.equal(after!.status, "merged");
    assert.equal(after!.mergeBlocker, undefined);
  });

  it("PR já MERGED → exit 0 sem chamar gh pr merge", () => {
    const { verdict } = run(openState, (args) => {
      if (args[1] === "view") return view([PASSING], "MERGED");
      throw new Error("não deveria mergear de novo");
    });
    assert.equal(verdict.kind, "merged");
  });

  it("merged:true gravado → exit 0 sem consultar o gh", () => {
    const { verdict } = run({ ...openState, merged: true, status: "merged" }, () => {
      throw new Error("não deveria consultar");
    });
    assert.equal(verdict.kind, "merged");
  });

  it("CI vermelho, conflito ou PR fechado → 'blocked' (exit 1, halt banner)", () => {
    for (const payload of [view([FAILING]), view([], "OPEN", "CONFLICTING"), view([RUNNING], "CLOSED")]) {
      const { verdict } = run(openState, (args) => {
        if (args[1] === "view") return payload;
        throw new Error("não pode mergear");
      });
      assert.equal(verdict.kind, "blocked", payload);
      assert.equal(exitCodeForVerdict(verdict), 1);
    }
  });

  it("gh pr view falha → 'cannot-verify' (exit 2) — estado desconhecido nunca vira mergeado (#573)", () => {
    const { verdict } = run(openState, () => {
      throw new Error("gh: not authenticated");
    });
    assert.equal(verdict.kind, "cannot-verify");
    assert.equal(exitCodeForVerdict(verdict), 2);
  });

  it("sem PR registrado (state ausente, published:false, sem prUrl) → 'no-pr' (exit 4, fallback de publicação)", () => {
    const never: GhRunner = () => {
      throw new Error("não deveria consultar");
    };
    for (const state of [null, { code: 3, published: false, reason: "push falhou" }, { code: 0, published: true, slug: "s", merged: false }]) {
      const { verdict } = run(state, never);
      assert.equal(verdict.kind, "no-pr", JSON.stringify(state));
      assert.equal(exitCodeForVerdict(verdict), 4);
    }
  });

  it("classifyMergeAttempt: ghError e timedOut não são bloqueio definitivo", () => {
    assert.equal(classifyMergeAttempt(1, { merged: true, reason: "" }).kind, "merged");
    assert.equal(classifyMergeAttempt(1, { merged: false, ghError: true, reason: "" }).kind, "cannot-verify");
    assert.equal(classifyMergeAttempt(1, { merged: false, timedOut: true, reason: "" }).kind, "pending");
    assert.equal(classifyMergeAttempt(1, { merged: false, reason: "CI fail" }).kind, "blocked");
  });
});

describe("playbooks: PR do site é a 1ª ação do dispatch e o merge trava o fim da Etapa 6 (#10160)", () => {
  const stage5 = readFileSync(join(ROOT, ".claude/agents/orchestrator-stage-5.md"), "utf8");
  const stage6 = readFileSync(join(ROOT, ".claude/agents/orchestrator-stage-6.md"), "utf8");

  it("§5b-site vem ANTES de qualquer publisher (§5c-pre, §5c) e abre o PR sem esperar o merge", () => {
    const site = stage5.indexOf("### 5b-site.");
    const pre = stage5.indexOf("### 5c-pre.");
    const dispatch = stage5.indexOf("### 5c.");
    assert.ok(site !== -1, "§5b-site ausente");
    assert.ok(site < pre && site < dispatch, "§5b-site precisa vir antes de §5c-pre/§5c");
    const section = stage5.slice(site, pre);
    assert.match(section, /publish-edition-site-page\.ts/);
    assert.match(section, /--no-wait-merge/);
    assert.match(section, /--sitemap workers\/site\/public\/sitemap\.xml/);
    // Nenhum publisher antes do PR do site.
    const before = stage5.slice(0, site);
    for (const pub of ["publish-newsletter-kit.ts", "publish-linkedin.ts", "publish-facebook.ts", "brevo-diaria-stage5-dispatch.ts"]) {
      assert.ok(!before.includes(pub), `${pub} citado antes de §5b-site`);
    }
  });

  it("§6b-site checa o PR (sem republicar quando o Stage 5 já abriu) e §6c-site trava antes do Schedule", () => {
    const sixBSite = stage6.indexOf("### 6b-site.");
    const sixC = stage6.indexOf("### 6c.");
    const lockIdx = stage6.indexOf("### 6c-site.");
    const sixD = stage6.indexOf("### 6d.");
    assert.ok(sixBSite !== -1 && sixC !== -1 && lockIdx !== -1 && sixD !== -1);
    assert.ok(sixBSite < sixC && sixC < lockIdx && lockIdx < sixD, "ordem esperada: 6b-site < 6c < 6c-site < 6d");
    assert.match(stage6.slice(sixBSite, sixC), /check-site-page-pr-gate\.ts/);
    const lockSection = stage6.slice(lockIdx, sixD);
    assert.match(lockSection, /check-site-page-pr-gate\.ts[^\n]*--wait-ms 540000/);
    assert.match(lockSection, /render-halt-banner\.ts/);
    assert.match(lockSection, /site-page-pr-merged/);
  });
});
