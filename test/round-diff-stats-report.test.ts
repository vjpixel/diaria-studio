/**
 * test/round-diff-stats-report.test.ts (#7292)
 *
 * Regressão: a issue #7292 mediu que a "janela de 7 dias" citada no título
 * do alarme era, na prática, UMA rodada só (`n=1`) — o texto prometia
 * agregação de tendência e entregava um ponto. Segundo achado: `--check-alarm`
 * imprimia a MESMA frase de saída ("sem alarme") tanto quando a razão de 7d
 * era saudável quanto quando não havia NENHUMA rodada medida na janela
 * (`rounds === 0`) — silêncio verde indistinguível nos dois casos.
 *
 * Dado sintético — sem bater em `git`/`run-log.jsonl` real (mesma disciplina
 * de test/round-diff-stats.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildRoundDiffRatioFinding,
  classifyCheckAlarmState,
  pendingFindingsForCheckAlarm,
} from "../scripts/round-diff-stats-report.ts";
import type { WindowedRoundDiffStats } from "../scripts/lib/round-diff-stats.ts";
import { alarmIssueStateKey, applyAlarmReconciliation, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";

function window7d(overrides: Partial<WindowedRoundDiffStats> = {}): WindowedRoundDiffStats {
  return {
    windowDays: 7,
    rounds: 1,
    added: 15335,
    removed: 1002,
    ratio: 15335 / 1002,
    net: 14333,
    netPerDay: 14333 / 7,
    ...overrides,
  };
}

describe("buildRoundDiffRatioFinding (#7292 — n declarado, 'janela' só com n>=2)", () => {
  it("n=1 (caso real que abriu a #7292): título e corpo falam 'uma rodada', nunca 'janela'", () => {
    const finding = buildRoundDiffRatioFinding(15335 / 1002, 15335, 14333 / 7, 1);
    assert.match(finding.title, /uma rodada/);
    assert.doesNotMatch(finding.title, /janela/);
    assert.match(finding.body, /n=1/);
    assert.doesNotMatch(finding.body, /janela dos últimos 7 dias/);
  });

  it("n>=2: título e corpo falam 'janela', com a contagem de rodadas explícita", () => {
    const finding = buildRoundDiffRatioFinding(36, 5042, 5042 / 7, 3);
    assert.match(finding.title, /janela de 7 dias/);
    assert.match(finding.body, /n=3 rodadas/);
  });

  it("ainda cita o limiar e o líquido/dia (comportamento pré-#7292 preservado)", () => {
    const finding = buildRoundDiffRatioFinding(20, 1000, 100, 2);
    assert.match(finding.body, /10:1/);
    assert.match(finding.body, /100/);
  });
});

describe("classifyCheckAlarmState (#7292 — distingue 'sem dado' de 'razão saudável')", () => {
  it("rounds === 0 → estado 'no-data', NUNCA confundido com 'sem alarme'/saudável", () => {
    const result = classifyCheckAlarmState(window7d({ rounds: 0, added: 0, removed: 0, ratio: null, net: 0, netPerDay: 0 }));
    assert.equal(result.state, "no-data");
    assert.match(result.message, /sem dado/);
    assert.doesNotMatch(result.message, /dentro do limiar/);
  });

  it("rounds > 0 e ratio abaixo do limiar → estado 'healthy', menciona n explicitamente", () => {
    const result = classifyCheckAlarmState(window7d({ rounds: 4, added: 100, removed: 50, ratio: 2, netPerDay: 50 / 7 }));
    assert.equal(result.state, "healthy");
    assert.match(result.message, /n=4/);
    assert.match(result.message, /dentro do limiar/);
  });

  it("rounds > 0 e ratio no/acima do limiar → estado 'alarming' (mensagem vazia, cabe ao caller montar o finding)", () => {
    const result = classifyCheckAlarmState(window7d({ rounds: 1, ratio: 15 }));
    assert.equal(result.state, "alarming");
  });

  it("caso real #7292 (15,3:1, n=1) classifica alarming — mas o texto do finding sabe que n=1 (coberto no describe acima)", () => {
    const result = classifyCheckAlarmState(window7d());
    assert.equal(result.state, "alarming");
  });
});

describe("pendingFindingsForCheckAlarm (#10062 item 1 — execução saudável conta como ausência)", () => {
  const healthy = window7d({ rounds: 4, added: 100, removed: 50, ratio: 2, netPerDay: 50 / 7 });
  const noData = window7d({ rounds: 0, added: 0, removed: 0, ratio: null, net: 0, netPerDay: 0 });

  it("saudável → [] (reconcilia), sem dado → null (não reconcilia), alarmante → [finding]", () => {
    assert.deepEqual(pendingFindingsForCheckAlarm(classifyCheckAlarmState(healthy), healthy), []);
    assert.equal(pendingFindingsForCheckAlarm(classifyCheckAlarmState(noData), noData), null);
    const alarming = window7d();
    const pending = pendingFindingsForCheckAlarm(classifyCheckAlarmState(alarming), alarming);
    assert.equal(pending?.length, 1);
    assert.equal(pending![0]!.check, "round-diff-ratio");
  });

  it("2 execuções saudáveis seguidas fecham a issue de alarme aberta (antes: código morto)", () => {
    const finding = buildRoundDiffRatioFinding(15, 15335, 2000, 3);
    const key = alarmIssueStateKey(finding.check, finding.fingerprint);
    let state: AlarmIssuesState = {
      [key]: { issueNumber: 7292, url: "https://x/7292", missingStreak: 0, closedAt: null, family: "estado" },
    };
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };
    for (let i = 0; i < 2; i++) {
      const pending = pendingFindingsForCheckAlarm(classifyCheckAlarmState(healthy), healthy)!;
      state = applyAlarmReconciliation(pending, state, { cwd: ".", closeAfterRuns: 2, run }).nextState;
    }
    assert.ok(state[key]!.closedAt, "issue deveria estar fechada após 2 execuções saudáveis");
    assert.ok(calls.some((a) => a[0] === "issue" && a[1] === "close" && a[2] === "7292"));
  });

  it("main() não retorna antes da reconciliação no caminho saudável (guard de fonte)", () => {
    const src = readFileSync(new URL("../scripts/round-diff-stats-report.ts", import.meta.url), "utf8");
    const main = src.slice(src.indexOf("async function main"));
    assert.match(main, /pendingFindingsForCheckAlarm\(/);
    assert.doesNotMatch(main, /classification\.state !== "alarming"\)\s*\{[^}]*return;/);
  });
});
