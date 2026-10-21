/**
 * #10700 item 3 — duas issues de sonda abertas no MESMO host. A herança de
 * `carryForwardInconclusiveProbes` usava a união dos bots das duas: um bot
 * inconclusivo da issue A era carregado como `blocked` enquanto se tentava
 * casar a issue B, o conjunto resultante não batia com nenhuma, e a issue B
 * (cuja medição bastava) abria duplicata.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { carryForwardInconclusiveProbes, toAiCrawlerAlarmFindings } from "../scripts/robots-txt-drift-check.ts";
import { alarmIssueStateKey, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";
import { aiCrawlerProbeFindingKey, type AiCrawlerProbeResult } from "../scripts/lib/ai-crawler-access-check.ts";

const HOST = "diar.ia.br";
const keyFor = (bots: string[]) => alarmIssueStateKey(`ai-crawler-probe:${HOST}`, aiCrawlerProbeFindingKey(HOST, bots));

function openEntry(n: number): AlarmIssuesState[string] {
  return { issueNumber: n, url: `https://example.invalid/${n}`, missingStreak: 0, closedAt: null, family: "estado" };
}

function probe(bot: string, status: AiCrawlerProbeResult["status"]): AiCrawlerProbeResult {
  return {
    host: HOST,
    bot,
    url: `https://${HOST}/`,
    status,
    httpStatus: status === "inconclusive" ? null : status === "blocked" ? 403 : 200,
    fetchError: status === "inconclusive" ? "ECONNRESET" : null,
  };
}

const findingKeys = (probes: AiCrawlerProbeResult[], state: AlarmIssuesState) =>
  toAiCrawlerAlarmFindings(carryForwardInconclusiveProbes(probes, state), null).map((f) =>
    alarmIssueStateKey(f.check, f.fingerprint),
  );

describe("#10700 item 3 — duas issues abertas no mesmo host", () => {
  const A = keyFor(["GPTBot"]);
  const B = keyFor(["CCBot", "ClaudeBot"]);
  const state: AlarmIssuesState = { [A]: openEntry(1), [B]: openEntry(2) };

  it("herda só o bot da issue cuja medição basta; o da outra fica inconclusivo", () => {
    const out = carryForwardInconclusiveProbes(
      [probe("CCBot", "blocked"), probe("ClaudeBot", "inconclusive"), probe("GPTBot", "inconclusive")],
      state,
    );
    assert.deepEqual(
      out.map((p) => [p.bot, p.status]),
      [
        ["CCBot", "blocked"],
        ["ClaudeBot", "blocked"],
        ["GPTBot", "inconclusive"],
      ],
    );
  });

  it("o achado reproduz a issue B — nenhuma chave nova (sem duplicata)", () => {
    const keys = findingKeys(
      [probe("CCBot", "blocked"), probe("ClaudeBot", "inconclusive"), probe("GPTBot", "inconclusive")],
      state,
    );
    assert.deepEqual(keys, [B]);
  });

  it("a issue A medida sozinha também casa, sem arrastar os bots de B", () => {
    const keys = findingKeys(
      [probe("GPTBot", "blocked"), probe("CCBot", "inconclusive"), probe("ClaudeBot", "inconclusive")],
      state,
    );
    assert.deepEqual(keys, [A]);
  });

  it("estado medido que não reproduz nenhuma das duas não herda nada", () => {
    const probes = [probe("CCBot", "blocked"), probe("GPTBot", "blocked"), probe("ClaudeBot", "inconclusive")];
    assert.deepEqual(carryForwardInconclusiveProbes(probes, state), probes);
  });
});
