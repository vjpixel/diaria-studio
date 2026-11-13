/**
 * #12950 — PRs aprovadas e verdes ficavam 1-2 dias sem merge.
 *
 * 1. `mergeable=UNKNOWN` é transitório: o gate relê antes de escalar.
 * 2. Escalada com causa mecânica (conflito, CI vermelho) vai ao fixer sem
 *    esperar 24h/48h.
 * 4. O prompt do implementador do contínuo não manda mais abrir toda PR como
 *    draft + `bloqueio-execucao`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rereadMergeableWhileUnknown, normalizeMergeable } from "../scripts/lib/mergeable-reread.ts";
import {
  escalationDestination,
  isMechanicalEscalation,
  runEscalationQueue,
  type DestinationInput,
  type QueueDeps,
} from "../scripts/list-continuo-escalation-queue.ts";

const ROOT = resolve(import.meta.dirname, "..");
const HOUR = 60 * 60 * 1000;

describe("#12950 item 1 — mergeable=UNKNOWN é relido antes de escalar", () => {
  it("caso #12896/#12897: UNKNOWN na 1ª leitura, MERGEABLE na 2ª → MERGEABLE", () => {
    const sleeps: number[] = [];
    const reads = ["MERGEABLE"];
    const r = rereadMergeableWhileUnknown("UNKNOWN", () => reads.shift(), (ms) => sleeps.push(ms), 3, 5000);
    assert.deepEqual(r, { mergeable: "MERGEABLE", rereads: 1 });
    assert.deepEqual(sleeps, [5000]);
  });
  it("MERGEABLE/CONFLICTING na leitura inicial não relê nem espera", () => {
    for (const v of ["MERGEABLE", "CONFLICTING"] as const) {
      let called = 0;
      const r = rereadMergeableWhileUnknown(v, () => { called++; return "UNKNOWN"; }, () => { called++; });
      assert.deepEqual(r, { mergeable: v, rereads: 0 });
      assert.equal(called, 0);
    }
  });
  it("UNKNOWN persistente segue UNKNOWN depois das tentativas (fail-closed)", () => {
    let reads = 0;
    const r = rereadMergeableWhileUnknown("UNKNOWN", () => { reads++; return "UNKNOWN"; }, () => {}, 3);
    assert.deepEqual(r, { mergeable: "UNKNOWN", rereads: 3 });
    assert.equal(reads, 3);
  });
  it("leitura que lança nunca vira MERGEABLE", () => {
    const r = rereadMergeableWhileUnknown("UNKNOWN", () => { throw new Error("gh caiu"); }, () => {}, 2);
    assert.deepEqual(r, { mergeable: null, rereads: 2 });
  });
  it("UNKNOWN que vira CONFLICTING para na hora", () => {
    const reads = ["CONFLICTING", "MERGEABLE"];
    const r = rereadMergeableWhileUnknown("UNKNOWN", () => reads.shift(), () => {}, 3);
    assert.deepEqual(r, { mergeable: "CONFLICTING", rereads: 1 });
  });
  it("valor ilegível normaliza para null", () => {
    assert.equal(normalizeMergeable("mergeable"), null);
    assert.equal(normalizeMergeable(undefined), null);
  });
  it("o gate do contínuo usa a releitura (não lê mergeable uma vez só)", () => {
    const cli = readFileSync(resolve(ROOT, "scripts/check-continuo-merge-gate.ts"), "utf8");
    assert.match(cli, /rereadMergeableWhileUnknown\(payload\.mergeable,/);
    assert.match(cli, /mergeableRereads: reread\.rereads/);
  });
});

function input(over: Partial<DestinationInput>): DestinationInput {
  return {
    ageMs: 2 * HOUR, isDraft: false, labels: ["continuo-escalado"], mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE", checksVerdict: "pass", retido: false, claimed: false, redundant: false,
    issue: 12873, ...over,
  };
}

describe("#12950 item 2 — causa mecânica vai ao fixer sem esperar 24h/48h", () => {
  it("caso #12880: CI vermelho escalado há 2h → fixer", () => {
    assert.equal(escalationDestination(input({ checksVerdict: "fail" })), "fixer");
  });
  it("conflito escalado há 2h → fixer", () => {
    assert.equal(escalationDestination(input({ mergeStateStatus: "DIRTY" })), "fixer");
    assert.equal(escalationDestination(input({ mergeable: "CONFLICTING" })), "fixer");
  });
  it("pending/error/verde antes de 48h seguem briefing", () => {
    for (const checksVerdict of ["pending", "error", "pass"]) {
      assert.equal(escalationDestination(input({ checksVerdict })), "briefing", checksVerdict);
    }
  });
  it("draft com bloqueio-execucao não é mecânico", () => {
    const i = input({ isDraft: true, labels: ["bloqueio-execucao"], checksVerdict: "fail" });
    assert.equal(isMechanicalEscalation(i), false);
    assert.equal(escalationDestination(i), "briefing");
  });
  it("com tentativa de fixer já feita, antes de 48h não repete: briefing", () => {
    assert.equal(escalationDestination(input({ checksVerdict: "fail", labels: ["continuo-ci-fix-tentado"] })), "briefing");
  });
  it("retida ou reivindicada nunca vai ao fixer automático", () => {
    assert.equal(escalationDestination(input({ checksVerdict: "fail", retido: true })), "briefing");
    assert.equal(escalationDestination(input({ checksVerdict: "fail", retido: null })), "briefing");
    assert.equal(escalationDestination(input({ checksVerdict: "fail", claimed: true })), "briefing");
  });
  it("vencida e redundante continua fechando como redundante (antes do fixer)", () => {
    assert.equal(escalationDestination(input({ ageMs: 50 * HOUR, checksVerdict: "fail", redundant: true })), "fechar-redundante");
  });

  function deps(prs: { number: number; checksVerdict: string; hoursAgo: number }[]): QueueDeps {
    const now = Date.parse("2026-11-13T12:00:00Z");
    return {
      listPrs: () => prs.map((p) => ({
        number: p.number, url: `u/${p.number}`, title: "t", body: "Closes #1",
        headRefName: `continuo/fix-${p.number}-x`, isDraft: false, mergeStateStatus: "CLEAN",
        labels: [{ name: "continuo-escalado" }],
      })),
      events: (n) => {
        const p = prs.find((x) => x.number === n)!;
        return [{ event: "labeled", label: { name: "continuo-escalado" }, created_at: new Date(now - p.hoursAgo * HOUR).toISOString() }];
      },
      gate: (n) => ({
        action: "escalate", reason: "CI",
        details: { checksVerdict: prs.find((x) => x.number === n)!.checksVerdict, mergeable: "MERGEABLE", retidoParaEditor: { retido: false }, sessionClaims: { ok: true } },
      }),
      redundant: () => false,
      issueState: () => ({ state: "OPEN" }),
      reopenIssue: () => { throw new Error("não deveria reabrir"); },
      commentIssue: () => { throw new Error("não deveria comentar"); },
      closePr: () => { throw new Error("não deveria fechar"); },
      now: () => now,
    };
  }

  it("fila: CI vermelho há 2h entra como fixer; pending há 2h fica de fora; pending há 30h entra no briefing", () => {
    const r = runEscalationQueue(deps([
      { number: 12880, checksVerdict: "fail", hoursAgo: 2 },
      { number: 12900, checksVerdict: "pending", hoursAgo: 2 },
      { number: 12901, checksVerdict: "pending", hoursAgo: 30 },
    ]), true);
    assert.deepEqual(r.queue.map((q) => [q.number, q.destination, q.owner]), [
      [12880, "fixer", "coordenador"],
      [12901, "briefing", "editor"],
    ]);
    assert.deepEqual(r.applied, []);
    assert.deepEqual(r.failures, []);
  });
});

describe("#12950 item 4 — PR do contínuo não nasce draft por padrão", () => {
  const skill = readFileSync(resolve(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md"), "utf8");
  it("a instrução incondicional '(draft: --draft --label bloqueio-execucao' sumiu", () => {
    assert.ok(!skill.includes("(draft: --draft --label bloqueio-execucao, #12460)"));
  });
  it("o prompt manda abrir pronta para review e só usar draft com bloqueio real descrito no corpo", () => {
    assert.match(skill, /referenciando a issue, sem --draft; draft \(--draft --label bloqueio-execucao\) só com bloqueio de execução real descrito no corpo/);
  });
});
