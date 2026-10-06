import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateSitePageMergeCheck,
  buildSitePageMergeCheckFinding,
  runSitePageMergeCheck,
  todayEditionBrt,
} from "../scripts/check-site-page-merge.ts";
import {
  buildMergeWaiterAlertFinding,
  waitAndMergeSitePagePr,
  runMergeWaiter,
  makeSessionRegistryMergeLock,
  type GhRunner,
  type SitePageMergeLock,
} from "../scripts/publish-edition-site-page.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import { acquireMergeLock, releaseMergeLock } from "../scripts/lib/session-registry.ts";
import type { NotifyEditorFinding } from "../scripts/lib/editor-notify.ts";

/**
 * #9621 (resíduo da #9616):
 *  1. waiter morto por reboot/kill deixava `_internal/site-page-published.json`
 *     em "merge delegado ao waiter" sem nenhum leitor antes do envio das
 *     06:00 → check agendado pré-envio que alerta se o PR não estiver MERGED.
 *  2. o merge do waiter acontecia fora do merge lock (#636) → agora sob lock.
 */

const PR_URL = "https://github.com/vjpixel/diaria-studio/pull/9588";
const delegated = {
  code: 0,
  slug: "meu-slug",
  published: true,
  prUrl: PR_URL,
  merged: false,
  mergeReason: "CI não convergiu em 120000ms; merge delegado ao waiter em background (pid 123, até 35min)",
};

function ghState(state: string, calls: string[][] = []): GhRunner {
  return (args) => {
    calls.push(args);
    return JSON.stringify({ state });
  };
}

function makeRoot(edition: string, state: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), "site-merge-check-9621-"));
  const dir = join(root, "data", "editions", edition.slice(0, 4), edition, "_internal");
  mkdirSync(dir, { recursive: true });
  if (state) writeFileSync(join(dir, "site-page-published.json"), JSON.stringify(state));
  return root;
}

describe("evaluateSitePageMergeCheck (#9621 item 1)", () => {
  it("cenário da issue: waiter morto, state em 'merge delegado', PR OPEN → alert", () => {
    const v = evaluateSitePageMergeCheck(delegated, "/repo", ghState("OPEN"));
    assert.equal(v.kind, "alert");
    if (v.kind === "alert") {
      assert.equal(v.prNumber, 9588);
      assert.equal(v.prState, "OPEN");
      assert.equal(v.slug, "meu-slug");
    }
  });

  it("PR CLOSED sem merge → alert", () => {
    assert.equal(evaluateSitePageMergeCheck(delegated, "/repo", ghState("CLOSED")).kind, "alert");
  });

  it("PR já MERGED (state defasado) → ok, sem alerta", () => {
    assert.equal(evaluateSitePageMergeCheck(delegated, "/repo", ghState("MERGED")).kind, "ok");
  });

  it("state já registra merged:true → ok sem chamar gh", () => {
    const calls: string[][] = [];
    const v = evaluateSitePageMergeCheck({ ...delegated, merged: true }, "/repo", ghState("OPEN", calls));
    assert.equal(v.kind, "ok");
    assert.equal(calls.length, 0);
  });

  it("sem state file → no-state", () => {
    assert.equal(evaluateSitePageMergeCheck(null, "/repo", ghState("OPEN")).kind, "no-state");
  });

  it("página não publicada → not-published (não alerta)", () => {
    assert.equal(evaluateSitePageMergeCheck({ ...delegated, published: false }, "/repo", ghState("OPEN")).kind, "not-published");
  });

  it("sem prUrl → no-pr", () => {
    assert.equal(evaluateSitePageMergeCheck({ ...delegated, prUrl: undefined }, "/repo", ghState("OPEN")).kind, "no-pr");
  });

  it("gh lança → cannot-verify (nunca alerta falso, nunca ok falso)", () => {
    const gh: GhRunner = () => {
      throw new Error("rede");
    };
    assert.equal(evaluateSitePageMergeCheck(delegated, "/repo", gh).kind, "cannot-verify");
  });

  it("gh devolve JSON sem state → cannot-verify", () => {
    assert.equal(evaluateSitePageMergeCheck(delegated, "/repo", () => "{}").kind, "cannot-verify");
  });
});

describe("buildSitePageMergeCheckFinding (#9621)", () => {
  it("urgente, mesmo check/fingerprint do alerta do waiter (1 issue por PR, sem 2º e-mail)", () => {
    const v = evaluateSitePageMergeCheck(delegated, "/repo", ghState("OPEN"));
    assert.equal(v.kind, "alert");
    if (v.kind !== "alert") return;
    const f = buildSitePageMergeCheckFinding(v, "261006", "/repo/data/editions/2610/261006");
    const waiter = buildMergeWaiterAlertFinding({ prNumber: 9588, result: { merged: false, reason: "x" } });
    assert.equal(f.severity, "urgente");
    assert.equal(f.check, waiter.check);
    assert.equal(f.fingerprint, waiter.fingerprint);
    assert.match(f.subject, /PR #9588/);
    assert.match(f.subject, /261006/);
    assert.match(f.body, /merge delegado ao waiter/);
  });
});

describe("todayEditionBrt (#9621)", () => {
  it("05:15 BRT de 06/10/2026 (08:15Z) → 261006", () => {
    assert.equal(todayEditionBrt(new Date("2026-10-06T08:15:00Z")), "261006");
  });
  it("01:00Z ainda é o dia anterior em BRT", () => {
    assert.equal(todayEditionBrt(new Date("2026-10-06T01:00:00Z")), "261005");
  });
});

describe("runSitePageMergeCheck (#9621)", () => {
  it("lê o state da edição do dia (layout nested) e notifica uma vez → exit 0", async () => {
    const root = makeRoot("261006", delegated);
    const sent: NotifyEditorFinding[] = [];
    const r = await runSitePageMergeCheck(root, undefined, {
      gh: ghState("OPEN"),
      now: new Date("2026-10-06T08:15:00Z"),
      notify: async (f) => {
        sent.push(f);
      },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.edition, "261006");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].severity, "urgente");
  });

  it("--dry-run não notifica", async () => {
    const root = makeRoot("261006", delegated);
    let n = 0;
    const r = await runSitePageMergeCheck(root, "261006", { gh: ghState("OPEN"), dryRun: true, notify: async () => void n++ });
    assert.equal(r.exitCode, 0);
    assert.equal(n, 0);
  });

  it("dia sem edição → exit 0, sem notificar", async () => {
    const root = makeRoot("261006", null);
    let n = 0;
    const r = await runSitePageMergeCheck(root, "261006", { gh: ghState("OPEN"), notify: async () => void n++ });
    assert.equal(r.exitCode, 0);
    assert.equal(r.verdict.kind, "no-state");
    assert.equal(n, 0);
  });

  it("gh falha → exit 1 (unit failed, alarme de units pega)", async () => {
    const root = makeRoot("261006", delegated);
    const r = await runSitePageMergeCheck(root, "261006", {
      gh: () => {
        throw new Error("x");
      },
      notify: async () => {},
    });
    assert.equal(r.exitCode, 1);
  });

  it("notify lança → exit 1", async () => {
    const root = makeRoot("261006", delegated);
    const r = await runSitePageMergeCheck(root, "261006", {
      gh: ghState("OPEN"),
      notify: async () => {
        throw new Error("gmail");
      },
    });
    assert.equal(r.exitCode, 1);
  });
});

describe("registro da task (#9621)", () => {
  it("Diaria-Site-Page-Merge-Check: diária 05:15 BRT, antes do envio das 06:00, script certo", () => {
    const t = getScheduledTaskByName("Diaria-Site-Page-Merge-Check");
    assert.ok(t);
    assert.deepEqual(t.schedule, { kind: "daily", hour: 5, minute: 15 });
    assert.equal(t.steps[0].script, "scripts/check-site-page-merge.ts");
    assert.notEqual(t.enabled, false);
  });
});

// ─── item 2: merge sob o merge lock ─────────────────────────────────────────

const PASSING = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function greenGh(calls: string[][]): GhRunner {
  return (args) => {
    calls.push(args);
    if (args[1] === "view") {
      return JSON.stringify({ statusCheckRollup: [PASSING], mergeable: "MERGEABLE", state: "OPEN", headRefOid: HEAD });
    }
    return "";
  };
}

function fakeLock(acquireResults: boolean[], events: string[]): SitePageMergeLock {
  return {
    acquire: () => {
      const r = acquireResults.length ? acquireResults.shift()! : true;
      events.push(`acquire:${r}`);
      return r;
    },
    release: () => {
      events.push("release");
    },
  };
}

describe("waitAndMergeSitePagePr sob merge lock (#9621 item 2)", () => {
  it("merge acontece entre acquire e release", () => {
    const calls: string[][] = [];
    const events: string[] = [];
    const gh: GhRunner = (args, cwd) => {
      if (args[1] === "merge") events.push("merge");
      return greenGh(calls)(args, cwd);
    };
    const r = waitAndMergeSitePagePr("/repo", 9588, gh, () => {}, 60_000, 15_000, fakeLock([true], events));
    assert.equal(r.merged, true);
    assert.deepEqual(events, ["acquire:true", "merge", "release"]);
    assert.match(r.reason, /merge lock/);
  });

  it("lock ocupado → NÃO mergeia, volta pro poll e mergeia quando liberar", () => {
    const calls: string[][] = [];
    const events: string[] = [];
    let sleeps = 0;
    const r = waitAndMergeSitePagePr("/repo", 9588, greenGh(calls), () => void sleeps++, 60_000, 15_000, fakeLock([false, false, true], events));
    assert.equal(r.merged, true);
    assert.equal(calls.filter((a) => a[1] === "merge").length, 1);
    assert.equal(sleeps, 2);
    assert.deepEqual(events, ["acquire:false", "acquire:false", "acquire:true", "release"]);
    assert.match(r.reason, /esperou o lock/);
  });

  it("lock ocupado até o deadline → merged:false timedOut, nenhum gh pr merge", () => {
    const calls: string[][] = [];
    const events: string[] = [];
    const r = waitAndMergeSitePagePr("/repo", 9588, greenGh(calls), () => {}, 0, 15_000, fakeLock([false], events));
    assert.equal(r.merged, false);
    assert.equal(r.timedOut, true);
    assert.match(r.reason, /merge lock/);
    assert.equal(calls.filter((a) => a[1] === "merge").length, 0);
    assert.ok(!events.includes("release"));
  });

  it("acquire lança → tratado como ocupado, nunca mergeia sem lock", () => {
    const calls: string[][] = [];
    const lock: SitePageMergeLock = {
      acquire: () => {
        throw new Error("EACCES");
      },
      release: () => {},
    };
    const r = waitAndMergeSitePagePr("/repo", 9588, greenGh(calls), () => {}, 0, 15_000, lock);
    assert.equal(r.merged, false);
    assert.equal(calls.filter((a) => a[1] === "merge").length, 0);
  });

  it("gh pr merge lança → lock é liberado mesmo assim", () => {
    const events: string[] = [];
    const gh: GhRunner = (args) => {
      if (args[1] === "merge") throw new Error("boom");
      if (args.includes("statusCheckRollup,mergeable,state,headRefOid")) {
        return JSON.stringify({ statusCheckRollup: [PASSING], mergeable: "MERGEABLE", state: "OPEN", headRefOid: HEAD });
      }
      return JSON.stringify({ state: "OPEN" });
    };
    const r = waitAndMergeSitePagePr("/repo", 9588, gh, () => {}, 60_000, 15_000, fakeLock([true], events));
    assert.equal(r.merged, false);
    assert.deepEqual(events, ["acquire:true", "release"]);
  });

  it("sem lock injetado (chamada síncrona do Stage 6) → comportamento antigo intacto", () => {
    const calls: string[][] = [];
    const r = waitAndMergeSitePagePr("/repo", 9588, greenGh(calls), () => {}, 60_000, 15_000);
    assert.equal(r.merged, true);
    assert.equal(r.reason, "CI verde — mergeado automaticamente (#8158, revoga #6598)");
  });

  it("runMergeWaiter repassa o lock ao merge", async () => {
    const calls: string[][] = [];
    const events: string[] = [];
    const r = await runMergeWaiter(
      "/repo",
      9588,
      undefined,
      greenGh(calls),
      () => {},
      60_000,
      15_000,
      async () => {},
      fakeLock([true], events),
    );
    assert.equal(r.merged, true);
    assert.deepEqual(events, ["acquire:true", "release"]);
  });
});

describe("makeSessionRegistryMergeLock (#9621 item 2)", () => {
  it("usa o MESMO lock do session-registry: enquanto o waiter segura, coordenador não adquire (e vice-versa)", () => {
    const root = mkdtempSync(join(tmpdir(), "site-merge-lock-9621-"));
    const lock = makeSessionRegistryMergeLock(root, 9588);
    assert.equal(lock.acquire(), true);
    assert.equal(acquireMergeLock(root, "coordenador"), false);
    lock.release();
    assert.equal(acquireMergeLock(root, "coordenador"), true);
    assert.equal(lock.acquire(), false);
    releaseMergeLock(root, "coordenador");
    assert.equal(lock.acquire(), true);
    lock.release();
  });
});
