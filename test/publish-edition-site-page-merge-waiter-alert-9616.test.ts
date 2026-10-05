import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  waitAndMergeSitePagePr,
  applyMergeWaiterResult,
  runMergeWaiter,
  buildMergeWaiterAlertFinding,
  sitePageMergeBlocker,
  type GhRunner,
  type MergeWaiterFailure,
} from "../scripts/publish-edition-site-page.ts";

/**
 * #9616 (review consolidado do commit 39ae6ea9e, #9593): o waiter em
 * background que mergeia o PR da página do site tinha dois buracos.
 *
 *  1. Terminando sem merge DEPOIS do gate do Stage 6 (o caso normal — o job
 *     `test` leva ~12min), o desfecho só ia pro state file e pro log, que
 *     ninguém lê depois do gate: `/p/{slug}` dava 404 no envio sem alarme.
 *  2. O `catch` do `gh pr merge` devolvia `merged:false` sem re-checar o
 *     estado do PR — com 2 waiters (resume do Stage 6), o que perdeu a
 *     corrida sobrescrevia no state file o merge real do outro.
 */

const PASSING = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const FAILING = { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" };
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function view(entries: unknown[], state = "OPEN", headRefOid?: string): string {
  return JSON.stringify({ statusCheckRollup: entries, mergeable: "MERGEABLE", state, headRefOid });
}

const PR_URL = "https://github.com/vjpixel/diaria-studio/pull/9588";

function makeEditionDir(state: Record<string, unknown>): { dir: string; statePath: string } {
  const root = mkdtempSync(join(tmpdir(), "site-waiter-9616-"));
  const dir = join(root, "2610", "261005");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const statePath = join(dir, "_internal", "site-page-published.json");
  writeFileSync(statePath, JSON.stringify(state));
  return { dir: root, statePath };
}

const delegated = {
  code: 0,
  slug: "meu-slug",
  published: true,
  prUrl: PR_URL,
  merged: false,
  mergeReason: "CI não convergiu em 120000ms; merge delegado ao waiter em background",
};

describe("catch do gh pr merge re-checa MERGED (#9616 item 2)", () => {
  it("2 waiters: o merge do outro chegou antes → gh pr merge lança, mas o desfecho é merged:true", () => {
    let views = 0;
    const gh: GhRunner = (args) => {
      if (args[1] === "view") {
        views++;
        // 1ª leitura: CI verde, PR aberto (os 2 waiters veem isso no mesmo poll).
        // Re-leitura no catch: o outro waiter já mergeou.
        return views === 1 ? view([PASSING]) : view([PASSING], "MERGED");
      }
      if (args[1] === "merge") throw new Error("Pull request is not mergeable: already merged");
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    const r = waitAndMergeSitePagePr("/repo", 9588, gh, () => {});
    assert.equal(r.merged, true);
    assert.match(r.reason, /já está MERGED — merge concorrente/);
  });

  it("merge falha de verdade (PR segue OPEN): continua merged:false", () => {
    const gh: GhRunner = (args) => {
      if (args[1] === "view") return view([PASSING]);
      if (args[1] === "merge") throw new Error("required review thread not resolved");
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    const r = waitAndMergeSitePagePr("/repo", 9588, gh, () => {});
    assert.equal(r.merged, false);
    assert.match(r.reason, /gh pr merge falhou/);
  });

  it("re-checagem com gh falhando: não inventa merge (merged:false)", () => {
    let views = 0;
    const gh: GhRunner = (args) => {
      if (args[1] === "view") {
        if (++views === 1) return view([PASSING]);
        throw new Error("gh offline");
      }
      if (args[1] === "merge") throw new Error("boom");
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    assert.equal(waitAndMergeSitePagePr("/repo", 9588, gh, () => {}).merged, false);
  });

  it("merge amarra o head avaliado com --match-head-commit", () => {
    const merges: string[][] = [];
    const gh: GhRunner = (args) => {
      if (args[1] === "view") return view([PASSING], "OPEN", HEAD);
      merges.push(args);
      return "Merged\n";
    };
    waitAndMergeSitePagePr("/repo", 9588, gh, () => {});
    assert.equal(merges.length, 1);
    const m = merges[0];
    assert.equal(m[m.indexOf("--match-head-commit") + 1], HEAD);
  });

  it("sem headRefOid válido no payload: mergeia sem a flag (não inventa SHA)", () => {
    const merges: string[][] = [];
    const gh: GhRunner = (args) => {
      if (args[1] === "view") return view([PASSING], "OPEN", "not-a-sha");
      merges.push(args);
      return "Merged\n";
    };
    waitAndMergeSitePagePr("/repo", 9588, gh, () => {});
    assert.equal(merges[0].includes("--match-head-commit"), false);
  });
});

describe("applyMergeWaiterResult nunca rebaixa um merge registrado (#9616 item 2)", () => {
  it("state já merged:true + waiter tardio merged:false → null (não grava)", () => {
    const state = { ...delegated, merged: true, mergeReason: "waiter A mergeou" };
    assert.equal(applyMergeWaiterResult(state, 9588, { merged: false, reason: "gh pr merge falhou" }), null);
  });

  it("state merged:false + waiter merged:true continua gravando o merge", () => {
    const next = applyMergeWaiterResult(delegated, 9588, { merged: true, reason: "CI verde" });
    assert.equal(next?.merged, true);
  });
});

describe("runMergeWaiter alerta quando termina sem merge (#9616 item 1)", () => {
  it("CI vermelho depois do gate → alerta com PR, slug e motivo; state file com bloqueio", async () => {
    const { dir, statePath } = makeEditionDir({ ...delegated, mergeBlocker: sitePageMergeBlocker(delegated) });
    try {
      const failures: MergeWaiterFailure[] = [];
      const gh: GhRunner = (args) => {
        if (args[1] === "view") return view([FAILING]);
        throw new Error(`gh pr merge não pode rodar com CI vermelho: ${args.join(" ")}`);
      };
      const editionDir = join(dir, "2610", "261005");
      const r = await runMergeWaiter("/repo", 9588, editionDir, gh, () => {}, 60_000, 15_000, async (f) => {
        failures.push(f);
      });
      assert.equal(r.merged, false);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].prNumber, 9588);
      assert.equal(failures[0].slug, "meu-slug");
      assert.equal(failures[0].prUrl, PR_URL);
      assert.equal(failures[0].editionDirAbs, editionDir);
      assert.match(failures[0].result.reason, /CI fail/);
      const after = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(after.merged, false);
      assert.match(String(after.mergeBlocker), /CI fail/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("state file já registra merge (outro waiter venceu): não rebaixa nem alerta", async () => {
    const merged = { ...delegated, merged: true, mergeReason: "waiter A mergeou" };
    const { dir, statePath } = makeEditionDir(merged);
    try {
      let alerts = 0;
      const gh: GhRunner = (args) => {
        if (args[1] === "view") return view([FAILING]);
        throw new Error("inesperado");
      };
      const r = await runMergeWaiter("/repo", 9588, join(dir, "2610", "261005"), gh, () => {}, 60_000, 15_000, async () => {
        alerts++;
      });
      assert.equal(r.merged, false);
      assert.equal(alerts, 0);
      assert.equal(JSON.parse(readFileSync(statePath, "utf8")).merged, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("state file aponta pra OUTRO PR (republicação assumiu a página): não alerta", async () => {
    const { dir } = makeEditionDir({ ...delegated, prUrl: "https://github.com/vjpixel/diaria-studio/pull/9999" });
    try {
      let alerts = 0;
      const gh: GhRunner = (args) => (args[1] === "view" ? view([FAILING]) : "");
      await runMergeWaiter("/repo", 9588, join(dir, "2610", "261005"), gh, () => {}, 60_000, 15_000, async () => {
        alerts++;
      });
      assert.equal(alerts, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("state file ilegível: alerta mesmo assim, carregando o erro de escrita", async () => {
    const root = mkdtempSync(join(tmpdir(), "site-waiter-9616-"));
    try {
      const failures: MergeWaiterFailure[] = [];
      const gh: GhRunner = (args) => (args[1] === "view" ? view([FAILING]) : "");
      await runMergeWaiter("/repo", 9588, join(root, "261005"), gh, () => {}, 60_000, 15_000, async (f) => {
        failures.push(f);
      });
      assert.equal(failures.length, 1);
      assert.match(failures[0].stateWriteError ?? "", /site-page-published\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("alerta que lança não derruba o waiter", async () => {
    const gh: GhRunner = (args) => (args[1] === "view" ? view([FAILING]) : "");
    const r = await runMergeWaiter("/repo", 9588, undefined, gh, () => {}, 60_000, 15_000, async () => {
      throw new Error("gh issue create falhou");
    });
    assert.equal(r.merged, false);
  });
});

describe("buildMergeWaiterAlertFinding (#9616)", () => {
  const finding = buildMergeWaiterAlertFinding({
    prNumber: 9588,
    result: { merged: false, reason: "CI fail — PR #9588 fica aberto" },
    editionDirAbs: "/data/editions/2610/261005",
    slug: "meu-slug",
    prUrl: PR_URL,
  });

  it("urgente + evento + P1, fingerprint estável por PR", () => {
    assert.equal(finding.severity, "urgente");
    assert.equal(finding.family, "evento");
    assert.equal(finding.priority, "P1");
    assert.equal(finding.fingerprint, "site-page-merge-waiter:pr-9588");
  });

  it("assunto e corpo nomeiam edição, página, PR, motivo e a ação", () => {
    assert.match(finding.subject, /PR #9588/);
    assert.match(finding.subject, /\/p\/meu-slug/);
    assert.match(finding.subject, /261005/);
    assert.match(finding.body, /CI fail/);
    assert.match(finding.body, /gh pr merge 9588 --squash/);
    assert.match(finding.body, /site-page-merge-waiter\.log/);
  });
});
