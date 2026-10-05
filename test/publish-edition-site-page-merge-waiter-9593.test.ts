import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  waitAndMergeSitePagePr,
  applyMergeWaiterResult,
  runMergeWaiter,
  productionDeps,
  sitePageMergeBlocker,
  SITE_PAGE_CI_BACKGROUND_WAIT_MS,
  type GhRunner,
  type GitRunner,
  type MergeWaiterSpawner,
} from "../scripts/publish-edition-site-page.ts";

/**
 * #9593: na edição 261005 o PR da página do site (#9588) ficou aberto porque
 * a espera síncrona de 120s nunca vê o job `test` (~12min, medido: 11m45s)
 * fechar — `/p/{slug}` daria 404 no envio das 06:00 sem merge manual. O fix
 * delega o merge a um waiter destacado quando a espera síncrona estoura com
 * CI `pending`, e o waiter grava o desfecho no state file da edição.
 */

const PASSING = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const RUNNING = { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null };
const FAILING = { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" };

function view(entries: unknown[], state = "OPEN"): string {
  return JSON.stringify({ statusCheckRollup: entries, mergeable: "MERGEABLE", state });
}

/** Relógio falso: avança só quando `sleep` é chamado. */
function withFakeClock<T>(fn: (sleep: (ms: number) => void) => T): T {
  let now = 1_000_000;
  const realNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => now;
  try {
    return fn((ms) => {
      now += ms;
    });
  } finally {
    (Date as unknown as { now: () => number }).now = realNow;
  }
}

const git: GitRunner = (args) => {
  if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
  if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
  if (args[0] === "status") return " M workers/site/public/p/meu-slug/index.html\n";
  if (args[0] === "diff") return "workers/site/public/p/meu-slug/index.html\n";
  return "";
};
const lock = () => ({ ok: true, stdout: "", stderr: "" });

describe("waitAndMergeSitePagePr — estado do PR (#9593)", () => {
  it("PR já MERGED (waiter/editor chegou antes): merged:true SEM chamar gh pr merge", () => {
    const gh: GhRunner = (args) => {
      if (args[1] === "view") return view([PASSING], "MERGED");
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    const r = waitAndMergeSitePagePr("/repo", 9588, gh, () => {});
    assert.equal(r.merged, true);
    assert.match(r.reason, /já estava MERGED/);
  });

  it("PR CLOSED: merged:false sem esperar nem mergear, sem timedOut", () => {
    let sleeps = 0;
    const gh: GhRunner = (args) => {
      if (args[1] === "view") return view([RUNNING], "CLOSED");
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    const r = waitAndMergeSitePagePr("/repo", 1, gh, () => sleeps++);
    assert.equal(r.merged, false);
    assert.equal(r.timedOut, undefined);
    assert.equal(sleeps, 0);
  });

  it("pede o campo state no gh pr view", () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      if (args[1] === "view") return view([PASSING]);
      return "Merged\n";
    };
    waitAndMergeSitePagePr("/repo", 1, gh, () => {});
    const v = calls.find((c) => c[1] === "view")!;
    assert.match(v[v.indexOf("--json") + 1], /\bstate\b/);
  });

  it("timeout com CI pending marca timedOut:true; CI vermelho não marca", () => {
    withFakeClock((sleep) => {
      const pending: GhRunner = (args) => (args[1] === "view" ? view([RUNNING]) : "");
      const r = waitAndMergeSitePagePr("/repo", 1, pending, sleep, 30_000, 5_000);
      assert.equal(r.merged, false);
      assert.equal(r.timedOut, true);
    });
    const red: GhRunner = (args) => (args[1] === "view" ? view([FAILING]) : "");
    assert.equal(waitAndMergeSitePagePr("/repo", 1, red, () => {}).timedOut, undefined);
  });
});

describe("productionDeps.publish — delega ao waiter quando o CI não fecha (#9593)", () => {
  it("cenário real da 261005: CI pending além dos 120s → dispara o waiter com PR e editionDir", () => {
    const spawned: Array<{ prNumber: number; editionDir?: string }> = [];
    const spawnWaiter: MergeWaiterSpawner = ({ prNumber, editionDir }) => {
      spawned.push({ prNumber, editionDir });
      return { pid: 4242 };
    };
    const gh: GhRunner = (args) => {
      if (args[1] === "list") return "[]";
      if (args[1] === "create") return "https://github.com/vjpixel/diaria-studio/pull/9588\n";
      if (args[1] === "view") return view([PASSING, RUNNING]);
      throw new Error(`gh pr merge não pode rodar com CI pending: ${args.join(" ")}`);
    };
    const result = withFakeClock((sleep) =>
      productionDeps("/repo", git, gh, lock, sleep, undefined, spawnWaiter).publish(
        "meu-slug",
        undefined,
        "/repo/data/editions/2610/261005",
      ),
    );
    assert.equal(result.merged, false);
    assert.deepEqual(spawned, [{ prNumber: 9588, editionDir: "/repo/data/editions/2610/261005" }]);
    assert.match(result.mergeReason ?? "", /waiter em background \(pid 4242/);
  });

  it("CI vermelho NÃO dispara waiter (esperar não resolve)", () => {
    let spawned = 0;
    const gh: GhRunner = (args) => {
      if (args[1] === "list") return "[]";
      if (args[1] === "create") return "https://github.com/vjpixel/diaria-studio/pull/7\n";
      if (args[1] === "view") return view([FAILING]);
      return "";
    };
    const result = productionDeps("/repo", git, gh, lock, () => {}, undefined, () => {
      spawned++;
      return {};
    }).publish("meu-slug");
    assert.equal(result.merged, false);
    assert.equal(spawned, 0);
  });

  it("spawn do waiter falha: fail-soft, motivo registrado, nunca lança", () => {
    const gh: GhRunner = (args) => {
      if (args[1] === "list") return "[]";
      if (args[1] === "create") return "https://github.com/vjpixel/diaria-studio/pull/7\n";
      if (args[1] === "view") return view([RUNNING]);
      return "";
    };
    const result = withFakeClock((sleep) =>
      productionDeps("/repo", git, gh, lock, sleep, undefined, () => {
        throw new Error("EAGAIN");
      }).publish("meu-slug"),
    );
    assert.equal(result.merged, false);
    assert.match(result.mergeReason ?? "", /NÃO disparou \(EAGAIN\)/);
  });
});

describe("applyMergeWaiterResult (#9593)", () => {
  const base = {
    code: 0,
    slug: "meu-slug",
    published: true,
    prUrl: "https://github.com/vjpixel/diaria-studio/pull/9588",
    merged: false,
    mergeReason: "CI não convergiu",
    mergeBlocker: "BLOQUEIO: ...",
  };

  it("merge confirmado limpa o mergeBlocker e marca merged:true", () => {
    const next = applyMergeWaiterResult(base, 9588, { merged: true, reason: "CI verde" })!;
    assert.equal(next.merged, true);
    assert.equal("mergeBlocker" in next, false);
    assert.match(String(next.mergeReason), /waiter em background/);
  });

  it("waiter sem merge mantém um bloqueio com o motivo novo", () => {
    const next = applyMergeWaiterResult(base, 9588, { merged: false, reason: "CI fail" })!;
    assert.equal(next.merged, false);
    assert.match(String(next.mergeBlocker), /BLOQUEIO.*CI fail/);
  });

  it("state de OUTRO PR (republicação posterior) não é tocado", () => {
    assert.equal(applyMergeWaiterResult(base, 1234, { merged: true, reason: "x" }), null);
  });
});

describe("runMergeWaiter — fim a fim com state file real (#9593)", () => {
  it("pending → verde: mergeia e o state file deixa de bloquear o gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "site-waiter-9593-"));
    try {
      mkdirSync(join(dir, "_internal"));
      const statePath = join(dir, "_internal", "site-page-published.json");
      const initial = {
        code: 0,
        slug: "meu-slug",
        published: true,
        prUrl: "https://github.com/vjpixel/diaria-studio/pull/9588",
        merged: false,
        mergeReason: "CI não convergiu em 120000ms",
      };
      writeFileSync(
        statePath,
        JSON.stringify({ ...initial, mergeBlocker: sitePageMergeBlocker(initial) }),
      );
      let views = 0;
      const merges: string[][] = [];
      const gh: GhRunner = (args) => {
        if (args[1] === "view") return ++views < 4 ? view([RUNNING]) : view([PASSING]);
        if (args[1] === "merge") {
          merges.push(args);
          return "Merged\n";
        }
        throw new Error(`gh inesperado: ${args.join(" ")}`);
      };
      const r = withFakeClock((sleep) =>
        runMergeWaiter("/repo", 9588, dir, gh, sleep, SITE_PAGE_CI_BACKGROUND_WAIT_MS, 15_000),
      );
      assert.equal(r.merged, true);
      assert.equal(merges.length, 1);
      const after = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(after.merged, true);
      assert.equal(after.mergeBlocker, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("janela do waiter cobre o job test medido (~12min) com folga", () => {
    assert.ok(SITE_PAGE_CI_BACKGROUND_WAIT_MS >= 20 * 60_000);
  });
});
