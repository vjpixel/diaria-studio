/**
 * #10545 — quando a GraphQL dos 403 de AI Crawler (sinal 2) não volta `ok`
 * (token ausente/sem Analytics), o #10520 congela a issue
 * `ai-crawler-403-zona` aberta — corretamente, ausência não medida não prova
 * resolução —, mas nada avisava que o sensor estava cego: a issue ficava
 * congelada para sempre e o editor não tinha como saber. Agora N rodadas
 * seguidas sem medição viram um achado próprio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aiCrawlerUnmeasuredKeys,
  toAiCrawlerAlarmFindings,
  advanceZone403MeasurementState,
  emptyZone403MeasurementState,
  loadZone403MeasurementState,
  toZone403BlindFinding,
  ZONE_403_BLIND_AFTER_RUNS,
  AI_CRAWLER_403_BLIND_CHECK,
  type Zone403MeasurementState,
} from "../scripts/robots-txt-drift-check.ts";
import {
  applyAlarmReconciliation,
  alarmIssueStateKey,
  type AlarmIssuesState,
  type GhRunFn,
} from "../scripts/lib/alarm-issues.ts";
import { AI_CRAWLER_403_ZONE_FINGERPRINT } from "../scripts/lib/ai-crawler-access-check.ts";

const ZONE_KEY = alarmIssueStateKey("ai-crawler-403-zona", AI_CRAWLER_403_ZONE_FINGERPRINT);
const BLIND_KEY = alarmIssueStateKey(AI_CRAWLER_403_BLIND_CHECK, `${AI_CRAWLER_403_BLIND_CHECK}:graphql`);

function openEntry(): AlarmIssuesState[string] {
  return { issueNumber: 10530, url: "https://example.invalid/10530", missingStreak: 0, closedAt: null, family: "estado" };
}

/** Simula N rodadas do main(): avança o contador, monta os achados (sem
 * 403 medidos → nenhum achado da zona) e reconcilia. */
function runRounds(
  alarm: AlarmIssuesState,
  measurement: Zone403MeasurementState,
  statuses: Array<"ok" | "skipped" | "error">,
): { alarm: AlarmIssuesState; measurement: Zone403MeasurementState; ghCalls: string[][] } {
  const ghCalls: string[][] = [];
  const run: GhRunFn = (args) => {
    ghCalls.push(args);
    if (args[0] === "issue" && args[1] === "create") {
      return { status: 0, stdout: "https://github.com/vjpixel/diaria-studio/issues/99\n", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (args[0] === "issue" && args[1] === "view") return { status: 0, stdout: '{"state":"OPEN"}', stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  let a = alarm;
  let m = measurement;
  for (const status of statuses) {
    m = advanceZone403MeasurementState(m, status, status === "ok" ? null : "HTTP 403: authz", new Date("2026-10-19T13:15:00Z"));
    const blind = toZone403BlindFinding(m);
    const findings = [...toAiCrawlerAlarmFindings([], null), ...(blind ? [blind] : [])];
    a = applyAlarmReconciliation(findings, a, {
      cwd: ".",
      closeAfterRuns: 2,
      run,
      isAbsenceUnmeasured: aiCrawlerUnmeasuredKeys([], status),
    }).nextState;
  }
  return { alarm: a, measurement: m, ghCalls };
}

const created = (calls: string[][]) => calls.filter((c) => c[0] === "issue" && c[1] === "create");

describe("#10545 — sinal 2 cego vira alarme próprio", () => {
  it(`abaixo de ${ZONE_403_BLIND_AFTER_RUNS} rodadas sem medição: nada abre; a issue da zona segue congelada`, () => {
    const r = runRounds({ [ZONE_KEY]: openEntry() }, emptyZone403MeasurementState(), ["error", "error"]);
    assert.equal(r.measurement.consecutiveUnmeasured, 2);
    assert.deepEqual(created(r.ghCalls), []);
    assert.equal(r.alarm[ZONE_KEY].closedAt, null);
  });

  it(`${ZONE_403_BLIND_AFTER_RUNS}ª rodada seguida sem medição abre a issue de sensor cego (zona segue congelada)`, () => {
    const r = runRounds({ [ZONE_KEY]: openEntry() }, emptyZone403MeasurementState(), ["skipped", "error", "error"]);
    const c = created(r.ghCalls);
    assert.equal(c.length, 1);
    assert.match(c[0][c[0].indexOf("--title") + 1], /sensor cego/);
    assert.equal(r.alarm[BLIND_KEY]?.issueNumber, 99);
    assert.equal(r.alarm[ZONE_KEY].closedAt, null, "#10520 continua: zona não fecha sem medição");
  });

  it("medição volta → contador zera e a issue de sensor cego fecha por streak", () => {
    const blind = runRounds({}, emptyZone403MeasurementState(), ["error", "error", "error"]);
    const r = runRounds(blind.alarm, blind.measurement, ["ok", "ok"]);
    assert.equal(r.measurement.consecutiveUnmeasured, 0);
    assert.notEqual(r.alarm[BLIND_KEY].closedAt, null);
  });

  it("uma rodada ok no meio reinicia a contagem", () => {
    const r = runRounds({}, emptyZone403MeasurementState(), ["error", "error", "ok", "error", "error"]);
    assert.equal(r.measurement.consecutiveUnmeasured, 2);
    assert.deepEqual(created(r.ghCalls), []);
  });

  it("unmeasuredSince guarda o início da sequência", () => {
    let m = advanceZone403MeasurementState(emptyZone403MeasurementState(), "error", "x", new Date("2026-10-17T13:15:00Z"));
    m = advanceZone403MeasurementState(m, "error", "y", new Date("2026-10-18T13:15:00Z"));
    assert.equal(m.unmeasuredSince, "2026-10-17T13:15:00.000Z");
    assert.equal(m.lastDetail, "y");
  });

  it("estado ausente/corrompido carrega vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "zone403-10545-"));
    try {
      assert.deepEqual(loadZone403MeasurementState(join(dir, "nada.json")), emptyZone403MeasurementState());
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{nao json");
      assert.deepEqual(loadZone403MeasurementState(bad), emptyZone403MeasurementState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
