/**
 * #10520 — o alarme de crawler de IA não pode fechar sozinho quando o sinal
 * não foi medido (GraphQL em `error`/`skipped`, sonda `inconclusive`).
 * Antes do fix, a chave `ai-crawler-*` sumia do conjunto pendente e
 * `planAlarmReconciliation` comentava "resolvido" na 1ª rodada e fechava na
 * 2ª, com os 403 ainda ocorrendo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aiCrawlerUnmeasuredKeys, toAiCrawlerAlarmFindings } from "../scripts/robots-txt-drift-check.ts";
import {
  applyAlarmReconciliation,
  alarmIssueStateKey,
  type AlarmIssuesState,
  type GhRunFn,
} from "../scripts/lib/alarm-issues.ts";
import {
  AI_CRAWLER_403_ZONE_FINGERPRINT,
  aiCrawlerProbeFindingKey,
  type AiCrawlerProbeResult,
} from "../scripts/lib/ai-crawler-access-check.ts";

const ZONE_KEY = alarmIssueStateKey("ai-crawler-403-zona", AI_CRAWLER_403_ZONE_FINGERPRINT);
const HOST = "diar.ia.br";
const PROBE_KEY = alarmIssueStateKey(`ai-crawler-probe:${HOST}`, aiCrawlerProbeFindingKey(HOST, ["GPTBot"]));

function openEntry(): AlarmIssuesState[string] {
  return { issueNumber: 42, url: "https://example.invalid/42", missingStreak: 0, closedAt: null, family: "estado" };
}

function probe(status: AiCrawlerProbeResult["status"], bot = "GPTBot"): AiCrawlerProbeResult {
  return {
    host: HOST,
    bot,
    url: `https://${HOST}/`,
    status,
    httpStatus: status === "inconclusive" ? null : status === "blocked" ? 403 : 200,
    fetchError: status === "inconclusive" ? "ECONNRESET" : null,
  };
}

/** Roda N rodadas do mesmo cenário encadeando o state, registrando cada
 * chamada ao gh (comentário/fechamento). */
function runRounds(
  state: AlarmIssuesState,
  rounds: number,
  probes: AiCrawlerProbeResult[],
  status403: "ok" | "skipped" | "error",
): { state: AlarmIssuesState; ghCalls: string[][] } {
  const ghCalls: string[][] = [];
  const run: GhRunFn = (args) => {
    ghCalls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  let cur = state;
  for (let i = 0; i < rounds; i++) {
    // summary null = GraphQL não voltou ok → nenhum achado da zona.
    const findings = toAiCrawlerAlarmFindings(probes, null);
    cur = applyAlarmReconciliation(findings, cur, {
      cwd: ".",
      closeAfterRuns: 2,
      run,
      isAbsenceUnmeasured: aiCrawlerUnmeasuredKeys(probes, status403),
    }).nextState;
  }
  return { state: cur, ghCalls };
}

describe("#10520 — sinal de crawler de IA não medido preserva a issue aberta", () => {
  it("issue da zona aberta + 2 rodadas com GraphQL em error → continua aberta, sem gh", () => {
    const { state, ghCalls } = runRounds({ [ZONE_KEY]: openEntry() }, 2, [probe("allowed")], "error");
    assert.equal(state[ZONE_KEY].closedAt, null);
    assert.equal(state[ZONE_KEY].missingStreak, 0);
    assert.deepEqual(ghCalls, []);
  });

  it("GraphQL skipped (token ausente) também preserva", () => {
    const { state } = runRounds({ [ZONE_KEY]: openEntry() }, 2, [probe("allowed")], "skipped");
    assert.equal(state[ZONE_KEY].closedAt, null);
  });

  it("controle: GraphQL ok sem 403 por 2 rodadas → fecha (resolução medida)", () => {
    const { state } = runRounds({ [ZONE_KEY]: openEntry() }, 2, [probe("allowed")], "ok");
    assert.notEqual(state[ZONE_KEY].closedAt, null);
  });

  it("sonda inconclusive no host preserva a issue da sonda daquele host", () => {
    const { state, ghCalls } = runRounds({ [PROBE_KEY]: openEntry() }, 2, [probe("inconclusive")], "ok");
    assert.equal(state[PROBE_KEY].closedAt, null);
    assert.deepEqual(ghCalls, []);
  });

  it("controle: sonda allowed por 2 rodadas → fecha a issue da sonda", () => {
    const { state } = runRounds({ [PROBE_KEY]: openEntry() }, 2, [probe("allowed")], "ok");
    assert.notEqual(state[PROBE_KEY].closedAt, null);
  });

  it("predicado não toca chaves fora de ai-crawler-* nem host medido", () => {
    const pred = aiCrawlerUnmeasuredKeys([probe("inconclusive")], "error");
    assert.equal(pred("robots-txt:diar.ia.br:x"), false);
    assert.equal(pred(alarmIssueStateKey("ai-crawler-probe:outro.diar.ia.br", "fp")), false);
    assert.equal(pred(ZONE_KEY), true);
    assert.equal(pred(PROBE_KEY), true);
  });
});
