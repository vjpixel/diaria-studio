/**
 * #13094: fila de escaladas com janelas de 6h/24h (eram 24h/48h) e triagem
 * de TODA PR aberta (`--all-open`). PR manual nunca recebe `fechar-*`; bot
 * fica fora; PR reivindicada por sessão viva entra só como informação.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ESCALATION_EXPIRY_MS,
  ESCALATION_QUEUE_AFTER_MS,
  PENDING_AFTER_FIX_MS,
  escalationDestination,
  isClosingDestination,
  prLane,
  runEscalationQueue,
  type DestinationInput,
  type GateOutput,
  type OpenEscalatedPr,
  type QueueDeps,
} from "../scripts/list-continuo-escalation-queue.ts";

const HOUR = 3600_000;

describe("janelas de 6h/24h (#13094)", () => {
  it("constantes: entrada em 6h (igual a PENDING_AFTER_FIX_MS), destino em 24h", () => {
    assert.equal(ESCALATION_QUEUE_AFTER_MS, 6 * HOUR);
    assert.equal(ESCALATION_QUEUE_AFTER_MS, PENDING_AFTER_FIX_MS);
    assert.equal(ESCALATION_EXPIRY_MS, 24 * HOUR);
  });

  const base: DestinationInput = {
    ageMs: 0, isDraft: true, labels: ["continuo-escalado", "bloqueio-execucao"], mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE", checksVerdict: "pass", retido: false, claimed: false, redundant: false, issue: 1,
  };
  it("borda de 24h: exatamente 24h ainda é briefing; 24h + 1ms recebe destino", () => {
    assert.equal(escalationDestination({ ...base, ageMs: 24 * HOUR }), "briefing");
    assert.equal(escalationDestination({ ...base, ageMs: 24 * HOUR + 1 }), "fechar-para-issue");
  });
});

describe("prLane (#13094)", () => {
  it("lanes autônomas pela branch", () => {
    for (const b of ["overnight/fix-1-x", "overnight/batch-y", "develop/fix-2", "continuo/fix-3-z", "continuo/rescue-2026"]) {
      assert.equal(prLane({ headRefName: b }), "autonomous", b);
    }
  });
  it("qualquer outra branch é manual, com autor do editor ou desconhecido", () => {
    assert.equal(prLane({ headRefName: "feat/minha-ideia", author: { login: "vjpixel", is_bot: false } }), "manual");
    assert.equal(prLane({ headRefName: "worktree-agent-abc" }), "manual");
    assert.equal(prLane({ headRefName: "overnightfix-1" }), "manual");
    assert.equal(prLane({ headRefName: "x/overnight/fix-1", author: null }), "manual");
  });
  it("bot: autor bot ou branch de bot", () => {
    assert.equal(prLane({ headRefName: "dependabot/npm_and_yarn/x", author: { login: "app/dependabot", is_bot: true } }), "bot");
    assert.equal(prLane({ headRefName: "bot/heatmap-weekly-regen" }), "bot");
    assert.equal(prLane({ headRefName: "feat/x", author: { login: "renovate[bot]" } }), "bot");
  });
});

describe("PR manual nunca recebe fechar-* (#13094, regressão)", () => {
  const closingInputs: Partial<DestinationInput>[] = [
    { redundant: true },
    { isDraft: true, labels: ["bloqueio-execucao"] },
    { mergeStateStatus: "DIRTY", labels: ["continuo-ci-fix-tentado"] },
    { checksVerdict: "fail", labels: ["continuo-ci-fix-tentado"] },
    { checksVerdict: "pending", labels: ["continuo-ci-fix-tentado"], fixTriedAgeMs: 100 * HOUR },
  ];
  const base: DestinationInput = {
    ageMs: 100 * HOUR, isDraft: false, labels: [], mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE", checksVerdict: "pass", retido: false, claimed: false, redundant: false, issue: 9,
  };
  it("os mesmos cenários que fecham uma PR autônoma viram briefing na manual", () => {
    for (const over of closingInputs) {
      const auto = escalationDestination({ ...base, ...over });
      assert.ok(isClosingDestination(auto), `pré-condição: ${JSON.stringify(over)} fecha a autônoma (${auto})`);
      assert.equal(escalationDestination({ ...base, ...over, manual: true }), "briefing", JSON.stringify(over));
    }
  });
  it("manual ainda vai ao fixer quando a causa é mecânica", () => {
    assert.equal(escalationDestination({ ...base, mergeStateStatus: "DIRTY", manual: true }), "fixer");
    assert.equal(escalationDestination({ ...base, checksVerdict: "fail", manual: true }), "fixer");
  });
});

describe("runEscalationQueue --all-open (#13094)", () => {
  const NOW = Date.parse("2026-11-15T12:00:00Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const pr = (n: number, over: Partial<OpenEscalatedPr> = {}): OpenEscalatedPr => ({
    number: n, url: `u/${n}`, title: `t${n}`, body: null, headRefName: `overnight/fix-${n}-x`, isDraft: false,
    mergeStateStatus: "CLEAN", labels: [], createdAt: iso(30 * HOUR), author: { login: "vjpixel", is_bot: false }, ...over,
  });
  const okGate: GateOutput = { action: "escalate", reason: "r", details: { checksVerdict: "pass", mergeable: "MERGEABLE", retidoParaEditor: { retido: false }, sessionClaims: { ok: true } } };
  const run = (prs: OpenEscalatedPr[], opts: { allOpen?: boolean; apply?: boolean; gate?: (n: number) => GateOutput; events?: QueueDeps["events"] } = {}) => {
    const calls: string[] = [];
    const deps: QueueDeps = {
      listPrs: () => prs,
      events: opts.events ?? (() => []),
      gate: opts.gate ?? (() => okGate),
      redundant: () => true,
      issueState: () => ({ state: "OPEN" }),
      reopenIssue: (n) => calls.push(`reopen ${n}`),
      commentIssue: (n) => calls.push(`comment ${n}`),
      closePr: (n) => calls.push(`close ${n}`),
      now: () => NOW,
    };
    return { r: runEscalationQueue(deps, opts.apply ?? true, { allOpen: opts.allOpen ?? true }), calls };
  };

  it("sem --all-open, PR sem continuo-escalado segue fora da fila (comportamento anterior)", () => {
    const { r } = run([pr(1)], { allOpen: false });
    assert.deepEqual(r.queue, []);
  });

  it("com --all-open, PR sem label entra pela idade (createdAt) e ganha kind=aberta", () => {
    const { r } = run([pr(1, { createdAt: iso(7 * HOUR) }), pr(2, { createdAt: iso(5 * HOUR) })], { apply: false });
    assert.deepEqual(r.queue.map((q) => [q.number, q.kind, q.lane, q.since]), [[1, "aberta", "autonomous", iso(7 * HOUR)]]);
  });

  it("PR manual com mais de 24h e conteúdo redundante nunca é fechada no --apply", () => {
    const manual = pr(3, { headRefName: "feat/editor-x", createdAt: iso(200 * HOUR) });
    const { r, calls } = run([manual]);
    assert.deepEqual(calls, []);
    assert.equal(r.queue[0].destination, "briefing");
    assert.equal(r.queue[0].lane, "manual");
  });

  it("PR manual escalada (label) também nunca fecha", () => {
    const manual = pr(4, { headRefName: "feat/y", labels: [{ name: "continuo-escalado" }] });
    const events = () => [{ event: "labeled", label: { name: "continuo-escalado" }, created_at: iso(100 * HOUR) }];
    const { r, calls } = run([manual], { allOpen: false, events });
    assert.deepEqual(calls, []);
    assert.equal(r.queue[0].kind, "escalada");
    assert.equal(r.queue[0].destination, "briefing");
  });

  it("PR autônoma redundante passadas 24h segue fechando como antes", () => {
    const { calls } = run([pr(5, { createdAt: iso(25 * HOUR) })]);
    assert.deepEqual(calls, ["close 5"]);
  });

  it("bot fica fora e é listado em skipped", () => {
    const bot = pr(6, { headRefName: "bot/heatmap-weekly-regen", createdAt: iso(500 * HOUR) });
    const { r, calls } = run([bot]);
    assert.deepEqual(r.queue, []);
    assert.deepEqual(r.skipped, [{ number: 6, reason: "bot" }]);
    assert.deepEqual(calls, []);
  });

  it("reivindicada por sessão viva entra só como informação (briefing, claimed)", () => {
    const gate = () => ({ details: { checksVerdict: "fail", retidoParaEditor: { retido: false }, sessionClaims: { ok: false } } });
    const { r, calls } = run([pr(7, { createdAt: iso(100 * HOUR) })], { gate });
    assert.deepEqual(calls, []);
    assert.equal(r.queue[0].destination, "briefing");
    assert.equal(r.queue[0].claimed, true);
  });

  it("createdAt ilegível é falha explícita, nunca PR que some", () => {
    const { r } = run([pr(8, { createdAt: undefined })]);
    assert.deepEqual(r.queue, []);
    assert.equal(r.failures[0].number, 8);
    assert.equal(r.failures[0].step, "since");
  });

  it("CLI lista todas as PRs abertas só com --all-open e pede createdAt/author", () => {
    const src = readFileSync(new URL("../scripts/list-continuo-escalation-queue.ts", import.meta.url), "utf8");
    assert.match(src, /\.\.\.\(allOpen \? \[\] : \["--label", ESCALATION_LABEL\]\)/);
    assert.match(src, /labels,createdAt,author/);
  });
});
