/**
 * #10522 — o congelamento de alarme de crawler de IA (#10520) era por HOST:
 * qualquer bot inconclusivo no host congelava toda issue de sonda daquele
 * host, e um bot inconclusivo que pertencia a uma issue aberta mudava o
 * fingerprint e abria issue duplicada. Agora a granularidade é host × bot,
 * e cada chave congelada aparece no log via `listFrozenUnmeasuredKeys`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aiCrawlerUnmeasuredKeys,
  carryForwardInconclusiveProbes,
  parseAiCrawlerProbeKeyBots,
  toAiCrawlerAlarmFindings,
} from "../scripts/robots-txt-drift-check.ts";
import {
  applyAlarmReconciliation,
  alarmIssueStateKey,
  listFrozenUnmeasuredKeys,
  type AlarmIssuesState,
  type GhRunFn,
} from "../scripts/lib/alarm-issues.ts";
import { aiCrawlerProbeFindingKey, type AiCrawlerProbeResult } from "../scripts/lib/ai-crawler-access-check.ts";

const HOST = "diar.ia.br";
const keyFor = (bots: string[], host = HOST) =>
  alarmIssueStateKey(`ai-crawler-probe:${host}`, aiCrawlerProbeFindingKey(host, bots));

function openEntry(n = 42): AlarmIssuesState[string] {
  return { issueNumber: n, url: `https://example.invalid/${n}`, missingStreak: 0, closedAt: null, family: "estado" };
}

function probe(bot: string, status: AiCrawlerProbeResult["status"], host = HOST): AiCrawlerProbeResult {
  return {
    host,
    bot,
    url: `https://${host}/`,
    status,
    httpStatus: status === "inconclusive" ? null : status === "blocked" ? 403 : 200,
    fetchError: status === "inconclusive" ? "ECONNRESET" : null,
  };
}

/** Uma rodada do caminho real de `main()`: carry-forward → achados →
 * reconciliação com o predicado de não-medido. */
function round(state: AlarmIssuesState, probes: AiCrawlerProbeResult[]) {
  const ghCalls: string[][] = [];
  const run: GhRunFn = (args) => {
    ghCalls.push(args);
    // `gh issue create` devolve a URL da issue nova.
    return { status: 0, stdout: args[1] === "create" ? "https://example.invalid/99\n" : "", stderr: "" };
  };
  const findings = toAiCrawlerAlarmFindings(carryForwardInconclusiveProbes(probes, state), null);
  const pred = aiCrawlerUnmeasuredKeys(probes, "ok");
  const frozen = listFrozenUnmeasuredKeys(findings, state, pred);
  const { nextState } = applyAlarmReconciliation(findings, state, { cwd: ".", closeAfterRuns: 2, run, isAbsenceUnmeasured: pred });
  return { nextState, ghCalls, frozen, findings };
}

describe("#10522 — congelamento por par host × bot", () => {
  it("issue {ClaudeBot,GPTBot} aberta, GPTBot blocked + ClaudeBot inconclusive → nenhuma issue nova", () => {
    const OLD = keyFor(["ClaudeBot", "GPTBot"]);
    const { nextState, ghCalls, findings } = round({ [OLD]: openEntry() }, [
      probe("GPTBot", "blocked"),
      probe("ClaudeBot", "inconclusive"),
    ]);
    assert.deepEqual(findings.map((f) => alarmIssueStateKey(f.check, f.fingerprint)), [OLD]);
    assert.ok(!ghCalls.some((a) => a[1] === "create"), `não deve criar issue: ${JSON.stringify(ghCalls)}`);
    assert.deepEqual(Object.keys(nextState), [OLD]);
    assert.equal(nextState[OLD].closedAt, null);
  });

  it("issue só de GPTBot, GPTBot medido allowed + outro bot inconclusive → resolve (não congela)", () => {
    const OLD = keyFor(["GPTBot"]);
    let state: AlarmIssuesState = { [OLD]: openEntry() };
    const probes = [probe("GPTBot", "allowed"), probe("ClaudeBot", "inconclusive")];
    const r1 = round(state, probes);
    assert.deepEqual(r1.frozen, []);
    state = r1.nextState;
    state = round(state, probes).nextState;
    assert.notEqual(state[OLD].closedAt, null);
  });

  it("issue só de GPTBot, GPTBot inconclusive → mantida sem medição, nunca fecha", () => {
    const OLD = keyFor(["GPTBot"]);
    let state: AlarmIssuesState = { [OLD]: openEntry() };
    for (let i = 0; i < 3; i++) state = round(state, [probe("GPTBot", "inconclusive")]).nextState;
    assert.equal(state[OLD].closedAt, null);
  });

  it("issue {ClaudeBot,GPTBot}, GPTBot allowed + ClaudeBot inconclusive → nenhuma issue nova; antiga congelada", () => {
    const OLD = keyFor(["ClaudeBot", "GPTBot"]);
    const { nextState, ghCalls, findings, frozen } = round({ [OLD]: openEntry() }, [
      probe("GPTBot", "allowed"),
      probe("ClaudeBot", "inconclusive"),
    ]);
    assert.deepEqual(findings, []);
    assert.deepEqual(ghCalls, []);
    assert.deepEqual(frozen, [{ key: OLD, issueNumber: 42 }]);
    assert.equal(nextState[OLD].closedAt, null);
  });

  it("#10596 — todos inconclusive no host continuam congelados e visíveis a cada rodada", () => {
    const OLD = keyFor(["ClaudeBot", "GPTBot"]);
    let state: AlarmIssuesState = { [OLD]: { ...openEntry(), missingStreak: 1 } };
    const probes = [
      probe("ClaudeBot", "inconclusive"),
      probe("GPTBot", "inconclusive"),
      // Medir outro host não autoriza herança no host inacessível.
      probe("GPTBot", "allowed", "outro.diar.ia.br"),
    ];
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(carryForwardInconclusiveProbes(probes, state), probes);
      const result = round(state, probes);
      assert.deepEqual(result.findings, []);
      assert.deepEqual(result.frozen, [{ key: OLD, issueNumber: 42 }]);
      assert.deepEqual(result.ghCalls, []);
      assert.deepEqual(result.nextState, state);
      state = result.nextState;
    }
  });

  it("issue fechada não herda bot inconclusivo", () => {
    const OLD = keyFor(["GPTBot"]);
    const state: AlarmIssuesState = { [OLD]: { ...openEntry(), closedAt: "2026-10-01T00:00:00Z" } };
    const out = carryForwardInconclusiveProbes([probe("GPTBot", "inconclusive")], state);
    assert.equal(out[0].status, "inconclusive");
  });

  it("predicado: só congela a chave cujo conjunto de bots tem um inconclusivo daquele host", () => {
    const pred = aiCrawlerUnmeasuredKeys([probe("ClaudeBot", "inconclusive")], "ok");
    assert.equal(pred(keyFor(["GPTBot"])), false);
    assert.equal(pred(keyFor(["ClaudeBot", "GPTBot"])), true);
    assert.equal(pred(keyFor(["ClaudeBot"], "outro.diar.ia.br")), false);
    // chave fora do formato: conservador, congela o host inteiro
    assert.equal(pred(alarmIssueStateKey(`ai-crawler-probe:${HOST}`, "fp-legado")), true);
  });

  it("parseAiCrawlerProbeKeyBots lê o fingerprint e recusa formato estranho", () => {
    assert.deepEqual(parseAiCrawlerProbeKeyBots(aiCrawlerProbeFindingKey(HOST, ["GPTBot", "ClaudeBot"]), HOST), ["ClaudeBot", "GPTBot"]);
    assert.equal(parseAiCrawlerProbeKeyBots("fp", HOST), null);
    assert.equal(parseAiCrawlerProbeKeyBots(aiCrawlerProbeFindingKey("x.br", ["GPTBot"]), HOST), null);
  });
});

describe("#10522 — listFrozenUnmeasuredKeys expõe o congelamento silencioso", () => {
  it("lista só a entry aberta, não-pendente, de estado e não medida", () => {
    const FROZEN = "ai-crawler-403-zona:ai-crawler-403-zona";
    const state: AlarmIssuesState = {
      [FROZEN]: openEntry(7),
      "x:closed": { ...openEntry(8), closedAt: "2026-10-01T00:00:00Z" },
      "x:evento": { ...openEntry(9), family: "evento" },
      "x:medido": openEntry(10),
    };
    const pred = (k: string) => k !== "x:medido";
    assert.deepEqual(listFrozenUnmeasuredKeys([], state, pred), [{ key: FROZEN, issueNumber: 7 }]);
  });

  it("chave pendente nesta rodada não conta como congelada", () => {
    const K = keyFor(["GPTBot"]);
    const findings = toAiCrawlerAlarmFindings([probe("GPTBot", "blocked")], null);
    assert.deepEqual(listFrozenUnmeasuredKeys(findings, { [K]: openEntry() }, () => true), []);
  });
});
