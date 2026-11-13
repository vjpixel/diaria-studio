/**
 * test/stuck-approved-pr-alarm-12950.test.ts (#12950 item 5)
 *
 * Regressão do alarme "PR aprovada e verde parada há mais de 4h". Os casos
 * reais da issue: #12896/#12897 (approve do review independente, CI verde,
 * `mergeable=UNKNOWN`, ~17h abertas) e #12920 (approve, verde, draft sem
 * bloqueio real) entram; o resto fica fora.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvalSource,
  buildStuckApprovedPrAlarmEmail,
  decideStuckApprovedRunOutcome,
  evaluateStuckApprovedPrs,
  needsStuckApprovedSetComment,
  selectStuckApprovedCandidates,
  stuckApprovedPrSetKey,
  stuckApprovedPrSetMarker,
  type StuckApprovedPrEntry,
} from "../scripts/lib/stuck-approved-pr-alarm.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-11-12T22:00:00Z");
const HEAD = "abc1234def5678";

function approveComment(at: string, head = HEAD): { body: string; authorAssociation: string } {
  return {
    body: `Review ok.\n<!-- continuo-review: run=r1 at=${at} verdict=approve head=${head} -->`,
    authorAssociation: "OWNER",
  };
}

function pr(overrides: Partial<StuckApprovedPrEntry> = {}): StuckApprovedPrEntry {
  return {
    number: 12897,
    title: "fix(guard): substituição de comando dentro de aspas duplas (#12894)",
    isDraft: false,
    labels: [],
    createdAt: "2026-11-12T06:31:00Z",
    mergeable: "UNKNOWN",
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviewDecision: null,
    headRefOid: HEAD,
    comments: [approveComment("2026-11-12T08:04:00Z")],
    ...overrides,
  };
}

describe("evaluateStuckApprovedPrs (#12950 item 5)", () => {
  it("caso real #12897: approve independente + CI verde + mergeable=UNKNOWN, 15h aberta -> alarma", () => {
    const findings = evaluateStuckApprovedPrs([pr()], NOW, 4);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].number, 12897);
    assert.equal(findings[0].approvedBy, "independent-review");
    assert.equal(findings[0].mergeable, "UNKNOWN");
    assert.ok(findings[0].hoursOpen > 15);
  });

  it("caso real #12920: draft sem bloqueio-execucao, aprovado e verde -> alarma, marcado draft", () => {
    const findings = evaluateStuckApprovedPrs([pr({ number: 12920, isDraft: true })], NOW, 4);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].isDraft, true);
  });

  it("aberta há menos que o limiar -> não alarma", () => {
    assert.equal(evaluateStuckApprovedPrs([pr({ createdAt: "2026-11-12T19:00:00Z" })], NOW, 4).length, 0);
  });

  it("CI vermelho ou pendente -> não alarma (o vermelho é do stale-red-pr-alarm)", () => {
    const red = pr({ statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }] });
    const pending = pr({ statusCheckRollup: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] });
    assert.equal(evaluateStuckApprovedPrs([red, pending], NOW, 4).length, 0);
  });

  it("sem review approve (nenhum, reject ou self-review mais novo) -> não alarma", () => {
    const none = pr({ comments: [] });
    const reject = pr({
      comments: [{ body: `<!-- continuo-review: run=r1 at=2026-11-12T08:04:00Z verdict=reject head=${HEAD} -->`, authorAssociation: "OWNER" }],
    });
    assert.equal(evaluateStuckApprovedPrs([none, reject], NOW, 4).length, 0);
  });

  it("approve de um HEAD antigo -> não conta como aprovada", () => {
    const stale = pr({ headRefOid: "ffff9999eeee", comments: [approveComment("2026-11-12T08:04:00Z", "abc1234")] });
    assert.equal(approvalSource(stale), null);
  });

  it("reviewDecision=APPROVED do GitHub basta, mesmo sem marcador", () => {
    const findings = evaluateStuckApprovedPrs([pr({ comments: [], reviewDecision: "APPROVED" })], NOW, 4);
    assert.equal(findings[0]?.approvedBy, "github-review");
  });

  it("exclusões: retido-para-editor, draft com bloqueio-execucao, CONFLICTING, createdAt ilegível", () => {
    const prs = [
      pr({ number: 1, labels: ["retido-para-editor"] }),
      pr({ number: 2, isDraft: true, labels: ["bloqueio-execucao"] }),
      pr({ number: 3, mergeable: "CONFLICTING" }),
      pr({ number: 4, createdAt: "não é data" }),
    ];
    assert.deepEqual(selectStuckApprovedCandidates(prs, NOW, 4), []);
  });

  it("e-mail cita PR, horas, draft e mergeable fora de MERGEABLE", () => {
    const findings = evaluateStuckApprovedPrs([pr(), pr({ number: 12920, isDraft: true, mergeable: "MERGEABLE" })], NOW, 4);
    const { subject, body } = buildStuckApprovedPrAlarmEmail(findings, 4, NOW);
    assert.match(subject, /2 PR\(s\) aprovada\(s\)/);
    assert.match(body, /PR #12897 .*mergeable=UNKNOWN/);
    assert.match(body, /PR #12920 .*draft/);
  });

  it("conjunto: chave estável, marcador decide se comenta", () => {
    const findings = evaluateStuckApprovedPrs([pr({ number: 12897 }), pr({ number: 12896 })], NOW, 4);
    const key = stuckApprovedPrSetKey(findings);
    assert.equal(key, "12896,12897");
    assert.equal(needsStuckApprovedSetComment([`x ${stuckApprovedPrSetMarker(key)}`], key), false);
    assert.equal(needsStuckApprovedSetComment(["outro"], key), true);
  });
});

describe("revisão do PR (#12950)", () => {
  it("retenção pelo marcador no corpo, sem label, tira a PR do alarme", () => {
    const retida = pr({ body: "Resumo.\n\n<!-- Retido-Para-Editor -->" });
    assert.deepEqual(selectStuckApprovedCandidates([retida], NOW, 4), []);
    assert.equal(selectStuckApprovedCandidates([pr({ body: "sem marcador" })], NOW, 4).length, 1);
  });

  it("candidata pulada por falha do gh nunca fecha a issue nem comenta conjunto", () => {
    assert.equal(decideStuckApprovedRunOutcome(0, 0), "close");
    assert.equal(decideStuckApprovedRunOutcome(2, 0), "notify");
    assert.equal(decideStuckApprovedRunOutcome(0, 1), "hold");
    assert.equal(decideStuckApprovedRunOutcome(2, 1), "notify-partial");
  });

  it("o script pede body no gh pr list e sai 1 em hold/notify-partial", () => {
    const src = readFileSync(resolve(ROOT, "scripts/stuck-approved-pr-alarm.ts"), "utf8");
    assert.match(src, /"number,title,body,/);
    assert.match(src, /outcome === "hold"[\s\S]*?process\.exitCode = 1/);
    assert.match(src, /outcome === "notify-partial"[\s\S]*?process\.exitCode = 1/);
  });
});

describe("registro da task (#12950 item 5)", () => {
  it("Diaria-Stuck-Approved-Pr-Alarm aponta para o script e o script existe", () => {
    const task = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Stuck-Approved-Pr-Alarm");
    assert.ok(task, "task registrada em scripts/lib/scheduled-tasks.ts");
    assert.equal(task.steps[0].script, "scripts/stuck-approved-pr-alarm.ts");
    assert.ok(readFileSync(resolve(ROOT, "scripts/stuck-approved-pr-alarm.ts"), "utf8").includes("notifyEditor"));
  });
});
