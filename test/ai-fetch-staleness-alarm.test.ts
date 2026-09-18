/**
 * test/ai-fetch-staleness-alarm.test.ts (#8340)
 *
 * Cobertura da lógica pura do alarme de staleness da task diária
 * `Diaria-Ai-Fetch-Report`: staleness via `computeStaleness` reusado,
 * idempotência por fingerprint, geração de e-mail, e a leitura fail-soft do
 * `ts` mais recente de `history.jsonl` (linha corrompida não invalida as
 * demais).
 *
 * Regressão do bug de origem (#8340): a própria issue nasceu de uma task
 * mergeada e nunca agendada — a série ficou parada por semanas sem alarme
 * nenhum. `readLatestAiFetchTs`/`computeStaleness` juntos são o guard que
 * detecta exatamente esse sintoma (série parada), não a presença da task no
 * registro (que `test/scheduled-tasks.test.ts` cobre separadamente).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStaleness } from "../scripts/lib/geo-citation-staleness-alarm.ts";
import {
  AI_FETCH_STALENESS_THRESHOLD_DAYS,
  emptyAiFetchStalenessAlarmState,
  fingerprintFor,
  shouldAlarm,
  advanceState,
  buildAiFetchStalenessAlarmEmail,
} from "../scripts/lib/ai-fetch-staleness-alarm.ts";
import { readLatestAiFetchTs } from "../scripts/ai-fetch-staleness-alarm.ts";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-09-18T12:00:00Z");

describe("computeStaleness aplicado à série ai-fetch (limiar próprio)", () => {
  it("registro de hoje → não stale", () => {
    const check = computeStaleness("2026-09-18T09:00:00Z", NOW, AI_FETCH_STALENESS_THRESHOLD_DAYS);
    assert.equal(check.isStale, false);
  });

  it("registro com mais dias que o limiar → stale", () => {
    const staleTs = new Date(NOW.getTime() - (AI_FETCH_STALENESS_THRESHOLD_DAYS + 1) * DAY_MS).toISOString();
    const check = computeStaleness(staleTs, NOW, AI_FETCH_STALENESS_THRESHOLD_DAYS);
    assert.equal(check.isStale, true);
  });

  it("nenhum registro (null) → stale (staleness máxima, nunca rodou)", () => {
    const check = computeStaleness(null, NOW, AI_FETCH_STALENESS_THRESHOLD_DAYS);
    assert.equal(check.isStale, true);
    assert.equal(check.staleDays, null);
  });

  it("#8340: exatamente o cenário do bug de origem — último registro de 1 mês atrás → stale", () => {
    const check = computeStaleness("2026-08-18T00:00:00Z", NOW, AI_FETCH_STALENESS_THRESHOLD_DAYS);
    assert.equal(check.isStale, true);
    assert.ok(check.staleDays !== null && check.staleDays > 25);
  });
});

describe("idempotência (fingerprint + should-alarm)", () => {
  it("nunca alarma quando não stale", () => {
    const check = computeStaleness("2026-09-18T00:00:00Z", NOW, AI_FETCH_STALENESS_THRESHOLD_DAYS);
    assert.equal(shouldAlarm(check, "2026-09-18T00:00:00Z", emptyAiFetchStalenessAlarmState()), false);
  });

  it("alarma na 1ª vez que fica stale, e não reenvia o MESMO estado", () => {
    const staleTs = "2026-09-01T00:00:00Z";
    const check = computeStaleness(staleTs, NOW, AI_FETCH_STALENESS_THRESHOLD_DAYS);
    const state0 = emptyAiFetchStalenessAlarmState();
    assert.equal(shouldAlarm(check, staleTs, state0), true);
    const state1 = advanceState(check, staleTs);
    assert.equal(shouldAlarm(check, staleTs, state1), false);
  });

  it("re-arma quando a série volta a registrar (isStale volta a false) e fica stale de novo depois", () => {
    const staleTs = "2026-09-01T00:00:00Z";
    const check = computeStaleness(staleTs, NOW, AI_FETCH_STALENESS_THRESHOLD_DAYS);
    const alarmed = advanceState(check, staleTs);
    // Série volta a registrar — task consertada.
    const okCheck = computeStaleness("2026-09-18T00:00:00Z", NOW, AI_FETCH_STALENESS_THRESHOLD_DAYS);
    const recovered = advanceState(okCheck, "2026-09-18T00:00:00Z");
    assert.equal(recovered.lastAlarmedFingerprint, null);
    // Fica stale de novo — deve alarmar mesmo tendo o mesmo `isStale` do 1º incidente,
    // porque o `ts` mudou (fingerprint muda) e o state foi limpo no meio.
    const staleAgainTs = "2026-09-19T00:00:00Z";
    const checkAgain = computeStaleness(staleAgainTs, new Date(NOW.getTime() + 20 * DAY_MS), AI_FETCH_STALENESS_THRESHOLD_DAYS);
    assert.equal(shouldAlarm(checkAgain, staleAgainTs, recovered), true);
    void alarmed;
  });

  it("fingerprintFor é estável para o mesmo (isStale, ts)", () => {
    const check = computeStaleness("2026-09-01T00:00:00Z", NOW, AI_FETCH_STALENESS_THRESHOLD_DAYS);
    const a = fingerprintFor(check, "2026-09-01T00:00:00Z");
    const b = fingerprintFor(check, "2026-09-01T00:00:00Z");
    assert.equal(a, b);
  });
});

describe("buildAiFetchStalenessAlarmEmail", () => {
  it("cita o timestamp e o limiar no corpo", () => {
    const { subject, body } = buildAiFetchStalenessAlarmEmail("2026-08-18T00:00:00Z", 31);
    assert.match(subject, /2026-08-18T00:00:00Z/);
    assert.match(body, /2026-08-18T00:00:00Z/);
    assert.match(body, /31 dia\(s\) atrás/);
    assert.match(body, new RegExp(`${AI_FETCH_STALENESS_THRESHOLD_DAYS} dia\\(s\\)\\.`));
  });

  it("caso sem nenhum registro cita 'nenhum registro encontrado'", () => {
    const { body } = buildAiFetchStalenessAlarmEmail(null, null);
    assert.match(body, /nenhum registro encontrado/);
  });
});

describe("readLatestAiFetchTs", () => {
  let dir: string;

  const withTmpFile = (content: string | null, fn: (path: string) => void): void => {
    dir = mkdtempSync(join(tmpdir(), "ai-fetch-staleness-test-"));
    const path = join(dir, "history.jsonl");
    try {
      if (content !== null) writeFileSync(path, content, "utf8");
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("arquivo ausente → null", () => {
    withTmpFile(null, (path) => {
      assert.equal(readLatestAiFetchTs(path), null);
    });
  });

  it("arquivo vazio → null", () => {
    withTmpFile("", (path) => {
      assert.equal(readLatestAiFetchTs(path), null);
    });
  });

  it("devolve o ts da ÚLTIMA linha válida", () => {
    const lines = [
      JSON.stringify({ date: "2026-09-16", ts: "2026-09-16T10:00:00Z" }),
      JSON.stringify({ date: "2026-09-17", ts: "2026-09-17T10:00:00Z" }),
    ].join("\n") + "\n";
    withTmpFile(lines, (path) => {
      assert.equal(readLatestAiFetchTs(path), "2026-09-17T10:00:00Z");
    });
  });

  it("linha corrompida no fim é ignorada — devolve o ts da última linha válida anterior (fail-soft)", () => {
    const lines = [
      JSON.stringify({ date: "2026-09-16", ts: "2026-09-16T10:00:00Z" }),
      "not valid json",
    ].join("\n") + "\n";
    withTmpFile(lines, (path) => {
      assert.equal(readLatestAiFetchTs(path), "2026-09-16T10:00:00Z");
    });
  });

  it("linha sem campo ts (string) é pulada", () => {
    const lines = [
      JSON.stringify({ date: "2026-09-16", ts: "2026-09-16T10:00:00Z" }),
      JSON.stringify({ date: "2026-09-17" }),
    ].join("\n") + "\n";
    withTmpFile(lines, (path) => {
      assert.equal(readLatestAiFetchTs(path), "2026-09-16T10:00:00Z");
    });
  });
});
