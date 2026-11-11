/**
 * #12804: a fila de escalada do contínuo fechava PR com CI `pending` (CI do
 * conserto ainda na fila de runners) ou `error` (gate não leu os checks)
 * depois do fixer. Regressão dos dois cenários, na função pura e no `--apply`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ESCALATION_EXPIRY_MS,
  PENDING_AFTER_FIX_MS,
  escalationDestination,
  labelSince,
  runEscalationQueue,
  type DestinationInput,
  type OpenEscalatedPr,
  type QueueDeps,
} from "../scripts/list-continuo-escalation-queue.ts";

const HOUR = 3600_000;
const fixed = ["continuo-escalado", "continuo-ci-fix-tentado"];
const base: DestinationInput = {
  ageMs: ESCALATION_EXPIRY_MS + 1, isDraft: false, labels: fixed, mergeStateStatus: "CLEAN",
  mergeable: "MERGEABLE", checksVerdict: "pass", retido: false, claimed: false, redundant: false, issue: 1,
};
const d = (over: Partial<DestinationInput>) => escalationDestination({ ...base, ...over });

describe("destino com CI pending/error depois do fixer (#12804)", () => {
  it("error nunca fecha nem despacha fixer, com ou sem tentativa", () => {
    assert.equal(d({ checksVerdict: "error" }), "briefing");
    assert.equal(d({ checksVerdict: "error", labels: ["continuo-escalado"] }), "briefing");
    assert.equal(d({ checksVerdict: "error", fixTriedAgeMs: 100 * HOUR }), "briefing");
  });

  it("error com conflito real continua seguindo o conflito", () => {
    assert.equal(d({ checksVerdict: "error", mergeStateStatus: "DIRTY" }), "fechar-reabrir-issue");
  });

  it("pending logo depois do fixer espera (briefing), não fecha", () => {
    assert.equal(d({ checksVerdict: "pending", fixTriedAgeMs: HOUR }), "briefing");
    assert.equal(d({ checksVerdict: "pending", fixTriedAgeMs: PENDING_AFTER_FIX_MS }), "briefing");
  });

  it("pending com idade da tentativa desconhecida não fecha (fail-closed)", () => {
    assert.equal(d({ checksVerdict: "pending" }), "briefing");
    assert.equal(d({ checksVerdict: "pending", fixTriedAgeMs: null }), "briefing");
    assert.equal(d({ checksVerdict: "pending", fixTriedAgeMs: Number.NaN }), "briefing");
  });

  it("pending muito depois do fixer fecha e reabre a issue", () => {
    assert.equal(d({ checksVerdict: "pending", fixTriedAgeMs: PENDING_AFTER_FIX_MS + 1 }), "fechar-reabrir-issue");
  });

  it("fail depois do fixer segue fechando (sem janela)", () => {
    assert.equal(d({ checksVerdict: "fail", fixTriedAgeMs: HOUR }), "fechar-reabrir-issue");
  });

  it("labelSince respeita unlabeled", () => {
    const ev = [
      { event: "labeled", label: { name: "continuo-ci-fix-tentado" }, created_at: "2026-11-01T00:00:00Z" },
      { event: "unlabeled", label: { name: "continuo-ci-fix-tentado" }, created_at: "2026-11-02T00:00:00Z" },
      { event: "labeled", label: { name: "continuo-ci-fix-tentado" }, created_at: "2026-11-03T00:00:00Z" },
    ];
    assert.equal(labelSince(ev, "continuo-ci-fix-tentado"), "2026-11-03T00:00:00Z");
    assert.equal(labelSince(ev.slice(0, 2), "continuo-ci-fix-tentado"), null);
  });
});

describe("runEscalationQueue --apply com CI pending/error (#12804)", () => {
  const NOW = Date.parse("2026-11-11T12:00:00Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const pr: OpenEscalatedPr = {
    number: 7, url: "u/7", title: "t", body: null, headRefName: "continuo/fix-7-x", isDraft: false,
    mergeStateStatus: "CLEAN", labels: fixed.map((name) => ({ name })),
  };
  const run = (verdict: string, fixAgoMs: number | null) => {
    const calls: string[] = [];
    const events = [{ event: "labeled", label: { name: "continuo-escalado" }, created_at: iso(ESCALATION_EXPIRY_MS + HOUR) }];
    if (fixAgoMs !== null) events.push({ event: "labeled", label: { name: "continuo-ci-fix-tentado" }, created_at: iso(fixAgoMs) });
    const deps: QueueDeps = {
      listPrs: () => [pr],
      events: () => events,
      gate: () => ({ details: { checksVerdict: verdict, mergeable: "MERGEABLE", retidoParaEditor: { retido: false }, sessionClaims: { ok: true } } }),
      redundant: () => false,
      issueState: () => ({ state: "OPEN" }),
      reopenIssue: (n) => calls.push(`reopen ${n}`),
      commentIssue: (n) => calls.push(`comment ${n}`),
      closePr: (n) => calls.push(`close ${n}`),
      now: () => NOW,
    };
    return { r: runEscalationQueue(deps, true), calls };
  };

  it("pending com fixer recém-aplicado não fecha a PR (cenário da issue)", () => {
    const { r, calls } = run("pending", 2 * HOUR);
    assert.deepEqual(calls, []);
    assert.equal(r.queue[0].destination, "briefing");
  });

  it("error (gh transitório) não fecha a PR", () => {
    const { calls } = run("error", 30 * HOUR);
    assert.deepEqual(calls, []);
  });

  it("pending 7h depois da tentativa fecha", () => {
    const { calls } = run("pending", 7 * HOUR);
    assert.deepEqual(calls, ["comment 7", "close 7"]);
  });

  it("label presente sem evento legível não fecha pending", () => {
    const { calls } = run("pending", null);
    assert.deepEqual(calls, []);
  });
});
