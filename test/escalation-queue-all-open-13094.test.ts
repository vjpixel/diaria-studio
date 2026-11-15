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
    { mergeStateStatus: "DIRTY", labels: ["continuo-ci-fix-tentado"], fixTriedAgeMs: 100 * HOUR },
    { checksVerdict: "fail", labels: ["continuo-ci-fix-tentado"], fixTriedAgeMs: 100 * HOUR },
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
  const run = (prs: OpenEscalatedPr[], opts: { allOpen?: boolean; apply?: boolean; gate?: (n: number) => GateOutput; events?: QueueDeps["events"]; lastCommitAt?: QueueDeps["lastCommitAt"]; issueClaimed?: QueueDeps["issueClaimed"] } = {}) => {
    const calls: string[] = [];
    const deps: QueueDeps = {
      listPrs: () => prs,
      events: opts.events ?? (() => []),
      lastCommitAt: opts.lastCommitAt ?? (() => null),
      issueClaimed: opts.issueClaimed ?? (() => ({ status: "free" })),
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
    const gate = () => ({ details: { checksVerdict: "fail", retidoParaEditor: { retido: false }, sessionClaims: { ok: false, reason: "vjpixel/diaria-studio#7 reivindicada pela sessão abc (develop/neo)" } } });
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

describe("review da PR #13181 (#13094)", () => {
  const NOW = Date.parse("2026-11-15T12:00:00Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const pr = (n: number, over: Partial<OpenEscalatedPr> = {}): OpenEscalatedPr => ({
    number: n, url: `u/${n}`, title: `t${n}`, body: null, headRefName: `overnight/fix-${n}-x`, isDraft: false,
    mergeStateStatus: "CLEAN", labels: [], createdAt: iso(30 * HOUR), author: { login: "vjpixel", is_bot: false }, ...over,
  });
  const gateWith = (over: Partial<NonNullable<GateOutput["details"]>> = {}): GateOutput => ({
    action: "escalate", reason: "r",
    details: { checksVerdict: "pass", mergeable: "MERGEABLE", retidoParaEditor: { retido: false }, sessionClaims: { ok: true }, ...over },
  });
  const run = (prs: OpenEscalatedPr[], over: Partial<QueueDeps> = {}, opts: { allOpen?: boolean; apply?: boolean } = {}) => {
    const calls: string[] = [];
    const deps: QueueDeps = {
      listPrs: () => prs,
      events: () => [],
      lastCommitAt: () => null,
      issueClaimed: () => ({ status: "free" }),
      gate: () => gateWith(),
      redundant: () => true,
      issueState: () => ({ state: "CLOSED", stateReason: "COMPLETED" }),
      reopenIssue: (n) => calls.push(`reopen ${n}`),
      commentIssue: (n, body) => calls.push(`comment ${n}: ${body}`),
      closePr: (n, body) => calls.push(`close ${n}: ${body}`),
      now: () => NOW,
      ...over,
    };
    return { r: runEscalationQueue(deps, opts.apply ?? true, { allOpen: opts.allOpen ?? true }), calls };
  };
  const fixTriedAt = (msAgo: number) => () => [{ event: "labeled", label: { name: "continuo-ci-fix-tentado" }, created_at: iso(msAgo) }];

  it("1: PR aberta há 30h com commit de 10min, DIRTY e fix-tried nunca recebe fechar-*", () => {
    const p = pr(1, { mergeStateStatus: "DIRTY", labels: [{ name: "continuo-ci-fix-tentado" }] });
    const { r, calls } = run([p], { lastCommitAt: () => iso(10 * 60_000), events: fixTriedAt(29 * HOUR), redundant: () => false });
    assert.deepEqual(calls, []);
    assert.ok(r.queue.every((q) => !isClosingDestination(q.destination)));
    assert.deepEqual(r.failures, []);
  });

  it("1: relógio da aberta é o maior entre createdAt, último commit e fix-tried", () => {
    const { r } = run([pr(2)], { lastCommitAt: () => iso(8 * HOUR), events: fixTriedAt(7 * HOUR), redundant: () => false }, { apply: false });
    assert.equal(r.queue[0].since, iso(7 * HOUR));
    assert.equal(r.queue[0].expired, false);
  });

  it("1: commit recente segura também o fechar-redundante", () => {
    const { r, calls } = run([pr(3)], { lastCommitAt: () => iso(HOUR) });
    assert.deepEqual(calls, []);
    assert.deepEqual(r.queue, []);
  });

  it("1: fechar-reabrir-issue exige a tentativa com mais de 6h, qualquer causa", () => {
    const base: DestinationInput = {
      ageMs: 30 * HOUR, isDraft: false, labels: ["continuo-ci-fix-tentado"], mergeStateStatus: "DIRTY",
      mergeable: "CONFLICTING", checksVerdict: "fail", retido: false, claimed: false, redundant: false, issue: 4,
    };
    assert.equal(escalationDestination({ ...base, fixTriedAgeMs: HOUR }), "briefing");
    assert.equal(escalationDestination({ ...base, fixTriedAgeMs: null }), "briefing");
    assert.equal(escalationDestination({ ...base, fixTriedAgeMs: PENDING_AFTER_FIX_MS + 1 }), "fechar-reabrir-issue");
  });

  it("2: body `Refs #N` com claim viva em N (issue da branch) → claimed, sem fechar-*", () => {
    const p = pr(5, { headRefName: "overnight/fix-500-x", body: "Refs #500", createdAt: iso(100 * HOUR) });
    const seen: number[] = [];
    const { r, calls } = run([p], {
      issueClaimed: (n) => { seen.push(n); return { status: "claimed", reason: `#${n} reivindicada pela sessão s1 (develop/neo)` }; },
    });
    assert.deepEqual(seen, [500]);
    assert.deepEqual(calls, []);
    assert.equal(r.queue[0].destination, "briefing");
    assert.equal(r.queue[0].claimed, true);
    assert.match(r.queue[0].claim_reason ?? "", /reivindicada pela sessão s1/);
  });

  it("3: aberta com causa mecânica não vai ao fixer antes de 6h da última atividade", () => {
    const { r } = run([pr(6, { mergeStateStatus: "DIRTY" })], { lastCommitAt: () => iso(HOUR) }, { apply: false });
    assert.deepEqual(r.queue, []);
    const late = run([pr(7, { mergeStateStatus: "DIRTY" })], { lastCommitAt: () => iso(7 * HOUR) }, { apply: false });
    assert.equal(late.r.queue[0].destination, "fixer");
  });

  it("3: escalada mantém o atalho mecânico imediato (#12950)", () => {
    const input: DestinationInput = {
      ageMs: HOUR, isDraft: false, labels: ["continuo-escalado"], mergeStateStatus: "DIRTY",
      mergeable: "CONFLICTING", checksVerdict: "fail", retido: false, claimed: false, redundant: false, issue: 8,
    };
    assert.equal(escalationDestination(input), "fixer");
  });

  it("4: manual com causa mecânica antes de 6h é briefing; depois, fixer", () => {
    const input: DestinationInput = {
      ageMs: HOUR, isDraft: false, labels: [], mergeStateStatus: "DIRTY",
      mergeable: "CONFLICTING", checksVerdict: "fail", retido: false, claimed: false, redundant: false, issue: 9, manual: true,
    };
    assert.equal(escalationDestination(input), "briefing");
    assert.equal(escalationDestination({ ...input, ageMs: 7 * HOUR }), "fixer");
  });

  it("5: draft com bloqueio-execucao sem escalada nunca fecha via --all-open", () => {
    const p = pr(10, { isDraft: true, labels: [{ name: "bloqueio-execucao" }], createdAt: iso(100 * HOUR) });
    const { r, calls } = run([p], { redundant: () => false });
    assert.deepEqual(calls, []);
    assert.equal(r.queue[0].destination, "briefing");
    const esc: DestinationInput = {
      ageMs: 30 * HOUR, isDraft: true, labels: ["continuo-escalado", "bloqueio-execucao"], mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE", checksVerdict: "pass", retido: false, claimed: false, redundant: false, issue: 10,
    };
    assert.equal(escalationDestination(esc), "fechar-para-issue");
    assert.equal(escalationDestination({ ...esc, aberta: true }), "briefing");
  });

  it("6: comentário na issue de aberta não diz 'seguiu escalada'", () => {
    const p = pr(11, { mergeStateStatus: "DIRTY", labels: [{ name: "continuo-ci-fix-tentado" }], createdAt: iso(100 * HOUR) });
    const { calls } = run([p], { events: fixTriedAt(30 * HOUR), redundant: () => false });
    const comment = calls.find((c) => c.startsWith("comment 11"));
    assert.ok(comment, JSON.stringify(calls));
    assert.doesNotMatch(comment, /seguiu escalada/);
    assert.match(comment, /aberta há mais de 24h/);
    const close = calls.find((c) => c.startsWith("close 11"));
    assert.match(close ?? "", /prazo de PR aberta/);
  });

  it("7: erro de parse nomeia o campo (label vs createdAt vs commit)", () => {
    const badLabel = run([pr(12, { labels: [{ name: "continuo-escalado" }] })], {
      events: () => [{ event: "labeled", label: { name: "continuo-escalado" }, created_at: "lixo" }],
    }, { allOpen: false });
    assert.match(badLabel.r.failures[0].error, /label continuo-escalado/);
    const badCreated = run([pr(13, { createdAt: "lixo" })]);
    assert.match(badCreated.r.failures[0].error, /createdAt/);
    const badCommit = run([pr(14)], { lastCommitAt: () => "lixo" });
    assert.match(badCommit.r.failures[0].error, /último commit/);
    assert.equal(badCommit.r.failures[0].step, "last-commit");
  });

  it("8: claim ilegível sai como claims_check failed, não como claimed", () => {
    const gate = () => gateWith({ checksVerdict: "fail", sessionClaims: { ok: false, reason: "registry ilegível: x" } });
    const { r, calls } = run([pr(15, { createdAt: iso(100 * HOUR) })], { gate, redundant: () => false });
    assert.deepEqual(calls, []);
    assert.equal(r.queue[0].destination, "briefing");
    assert.equal(r.queue[0].claimed, undefined);
    assert.equal(r.queue[0].claims_check, "failed");
    assert.match(r.queue[0].claim_reason ?? "", /registry ilegível/);
    const origin = run([pr(16, { createdAt: iso(100 * HOUR) })], { issueClaimed: () => ({ status: "failed", reason: "erro ao consultar claims: y" }) });
    assert.deepEqual(origin.calls, []);
    assert.equal(origin.r.queue[0].claims_check, "failed");
  });

  it("8: saída do gate sem sessionClaims é failed (fail-closed)", () => {
    const { r, calls } = run([pr(17, { createdAt: iso(100 * HOUR) })], { gate: () => ({ details: { checksVerdict: "pass", retidoParaEditor: { retido: false } } }) });
    assert.deepEqual(calls, []);
    assert.equal(r.queue[0].claims_check, "failed");
  });

  it("9: escalada de bot sem --all-open sai com lane bot e nunca fecha", () => {
    const bot = pr(18, { headRefName: "dependabot/npm/x", labels: [{ name: "continuo-escalado" }] });
    const { r, calls } = run([bot], { events: () => [{ event: "labeled", label: { name: "continuo-escalado" }, created_at: iso(100 * HOUR) }] }, { allOpen: false });
    assert.deepEqual(calls, []);
    assert.equal(r.queue[0].lane, "bot");
    assert.equal(r.queue[0].destination, "briefing");
  });
});
