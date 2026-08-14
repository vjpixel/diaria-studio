/**
 * test/geo-citation-staleness-alarm.test.ts (#4755)
 *
 * Lógica pura do alarme de staleness do monitor de citação GEO: cálculo de
 * dias desde o último registro, idempotência por fingerprint (não reenvia o
 * mesmo alarme a cada checagem semanal, mas re-arma quando o histórico
 * volta a crescer e depois para de novo), texto do e-mail, e o reader
 * string-safe de `history.jsonl`. Nenhum teste bate em rede/Gmail real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  STALENESS_THRESHOLD_DAYS,
  NEVER_MEASURED_FINGERPRINT,
  emptyGeoCitationStalenessAlarmState,
  computeStaleness,
  fingerprintFor,
  advanceState,
  shouldAlarm,
  buildGeoCitationStalenessAlarmEmail,
  type GeoCitationStalenessAlarmState,
} from "../scripts/lib/geo-citation-staleness-alarm.ts";
import { loadState, saveState, readLatestGeoCitationTs } from "../scripts/geo-citation-staleness-alarm.ts";

const T0 = new Date("2026-08-08T10:00:00.000Z");

describe("computeStaleness (#4755)", () => {
  it("null (sem registro) -> stale com staleDays null", () => {
    const check = computeStaleness(null, T0);
    assert.equal(check.isStale, true);
    assert.equal(check.staleDays, null);
  });

  it("registro ilegível (data inválida) -> tratado como nunca medido", () => {
    const check = computeStaleness("não-é-uma-data", T0);
    assert.equal(check.isStale, true);
    assert.equal(check.staleDays, null);
  });

  it("registro recente (1 dia) -> não stale", () => {
    const oneDayAgo = new Date(T0.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const check = computeStaleness(oneDayAgo, T0);
    assert.equal(check.isStale, false);
    assert.equal(check.staleDays, 1);
  });

  it(`registro no limiar exato de ${STALENESS_THRESHOLD_DAYS} dias -> stale`, () => {
    const atThreshold = new Date(T0.getTime() - STALENESS_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const check = computeStaleness(atThreshold, T0);
    assert.equal(check.isStale, true);
    assert.equal(check.staleDays, STALENESS_THRESHOLD_DAYS);
  });

  it(`1 dia abaixo do limiar -> não stale`, () => {
    const belowThreshold = new Date(T0.getTime() - (STALENESS_THRESHOLD_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString();
    const check = computeStaleness(belowThreshold, T0);
    assert.equal(check.isStale, false);
  });
});

describe("fingerprintFor (#4755)", () => {
  it("null -> sentinela NEVER_MEASURED_FINGERPRINT", () => {
    assert.equal(fingerprintFor(null), NEVER_MEASURED_FINGERPRINT);
  });

  it("ts real -> o próprio ts (nunca colide com o sentinela)", () => {
    assert.equal(fingerprintFor("2026-08-07T10:30:00.000Z"), "2026-08-07T10:30:00.000Z");
    assert.notEqual(fingerprintFor("2026-08-07T10:30:00.000Z"), NEVER_MEASURED_FINGERPRINT);
  });
});

describe("shouldAlarm / advanceState (#4755) — idempotência por fingerprint", () => {
  it("não stale -> nunca alarma", () => {
    const state = emptyGeoCitationStalenessAlarmState();
    assert.equal(shouldAlarm(state, { isStale: false, staleDays: 1 }, "x"), false);
  });

  it("stale + nunca alarmado -> alarma", () => {
    const state = emptyGeoCitationStalenessAlarmState();
    assert.equal(shouldAlarm(state, { isStale: true, staleDays: 30 }, "2026-07-01T00:00:00.000Z"), true);
  });

  it("stale + mesmo fingerprint já alarmado -> não reenvia", () => {
    const state: GeoCitationStalenessAlarmState = {
      lastAlarmedFingerprint: "2026-07-01T00:00:00.000Z",
      lastCheckedAt: T0.toISOString(),
    };
    assert.equal(shouldAlarm(state, { isStale: true, staleDays: 37 }, "2026-07-01T00:00:00.000Z"), false);
  });

  it("stale + fingerprint diferente do já alarmado -> alarma de novo", () => {
    const state: GeoCitationStalenessAlarmState = {
      lastAlarmedFingerprint: "2026-06-01T00:00:00.000Z",
      lastCheckedAt: T0.toISOString(),
    };
    assert.equal(shouldAlarm(state, { isStale: true, staleDays: 60 }, "2026-06-15T00:00:00.000Z"), true);
  });

  it("advanceState(null) re-arma — próximo shouldAlarm avalia o novo streak do zero", () => {
    const rearmed = advanceState(null, T0);
    assert.equal(rearmed.lastAlarmedFingerprint, null);
    assert.equal(shouldAlarm(rearmed, { isStale: true, staleDays: 25 }, "novo-ts"), true);
  });

  it("integração: alarma, não reenvia enquanto parado, re-arma quando volta a crescer, alarma de novo se parar outra vez", () => {
    let state = emptyGeoCitationStalenessAlarmState();

    // Histórico parado no mesmo ts há mais do threshold -> alarma.
    const staleFingerprint = fingerprintFor("2026-07-01T00:00:00.000Z");
    const check1 = computeStaleness("2026-07-01T00:00:00.000Z", T0);
    assert.equal(shouldAlarm(state, check1, staleFingerprint), true);
    state = advanceState(staleFingerprint, T0);

    // Checagem seguinte, MESMO último registro ainda -> não reenvia.
    assert.equal(shouldAlarm(state, check1, staleFingerprint), false);

    // Histórico volta a crescer (task rodou de novo, registro fresco) -> não stale -> re-arma.
    const freshTs = new Date(T0.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const freshFingerprint = fingerprintFor(freshTs);
    const check2 = computeStaleness(freshTs, T0);
    assert.equal(check2.isStale, false);
    state = advanceState(check2.isStale ? freshFingerprint : null, T0);
    assert.equal(state.lastAlarmedFingerprint, null);

    // Para de novo (novo ts fica velho) -> deve re-alarmar mesmo com fingerprint diferente do 1º streak.
    const T1 = new Date(T0.getTime() + (STALENESS_THRESHOLD_DAYS + 5) * 24 * 60 * 60 * 1000);
    const check3 = computeStaleness(freshTs, T1);
    assert.equal(check3.isStale, true);
    assert.equal(shouldAlarm(state, check3, freshFingerprint), true);
  });
});

describe("buildGeoCitationStalenessAlarmEmail (#4755)", () => {
  it("com registro conhecido: assunto e corpo mencionam os dias e o ts", () => {
    const { subject, body } = buildGeoCitationStalenessAlarmEmail("2026-07-01T00:00:00.000Z", 38);
    assert.match(subject, /38/);
    assert.match(body, /2026-07-01T00:00:00\.000Z/);
    assert.match(body, /Diaria-Geo-Citation-Monitor/);
  });

  it("sem nenhum registro (null): assunto/corpo cobrem esse caso sem lançar", () => {
    const { subject, body } = buildGeoCitationStalenessAlarmEmail(null, null);
    assert.match(subject, /nunca registrou/);
    assert.match(body, /ausente, vazio/);
  });

  it("achado de self-review: ts NÃO-null mas staleDays null (data corrompida) — nunca interpola staleDays como a string 'null'", () => {
    const { subject, body } = buildGeoCitationStalenessAlarmEmail("não-é-uma-data", null);
    assert.doesNotMatch(subject, /\bnull\b/);
    assert.doesNotMatch(body, /\bnull\b/);
    assert.match(subject, /nunca registrou/);
    assert.match(body, /ilegível/);
    assert.match(body, /não-é-uma-data/);
  });
});

describe("loadState / saveState (scripts/geo-citation-staleness-alarm.ts, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "geo-citation-staleness-alarm-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyGeoCitationStalenessAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state: GeoCitationStalenessAlarmState = {
      lastAlarmedFingerprint: "2026-07-01T00:00:00.000Z",
      lastCheckedAt: T0.toISOString(),
      // #5316: campo novo, cobre roundtrip com valor não-null aqui.
      lastAlarmedMissingProviderFingerprint: "geral:anthropic",
    };
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyGeoCitationStalenessAlarmState());
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state: GeoCitationStalenessAlarmState = { lastAlarmedFingerprint: null, lastCheckedAt: T0.toISOString() };
    saveState(state, path);
    assert.deepEqual(loadState(path).lastAlarmedFingerprint, null);
  });
});

describe("readLatestGeoCitationTs (scripts/geo-citation-staleness-alarm.ts, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "geo-citation-history-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> null", () => {
    assert.equal(readLatestGeoCitationTs(resolve(tmpDir, "nao-existe.jsonl")), null);
  });

  it("arquivo vazio -> null", () => {
    const path = resolve(tmpDir, "history.jsonl");
    writeFileSync(path, "");
    assert.equal(readLatestGeoCitationTs(path), null);
  });

  it("lê o ts do último registro (JSONL multi-linha)", () => {
    const path = resolve(tmpDir, "history.jsonl");
    const lines = [
      JSON.stringify({ ts: "2026-07-01T10:00:00.000Z", provider: "anthropic" }),
      JSON.stringify({ ts: "2026-07-08T10:00:00.000Z", provider: "openai" }),
      JSON.stringify({ ts: "2026-07-15T10:00:00.000Z", provider: "gemini" }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    assert.equal(readLatestGeoCitationTs(path), "2026-07-15T10:00:00.000Z");
  });

  it("última linha corrompida -> cai pra linha anterior válida (fail-soft, string-safe)", () => {
    const path = resolve(tmpDir, "history.jsonl");
    const lines = [
      JSON.stringify({ ts: "2026-07-01T10:00:00.000Z" }),
      "{ isso nao eh json valido",
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    assert.equal(readLatestGeoCitationTs(path), "2026-07-01T10:00:00.000Z");
  });

  it("100% das linhas corrompidas -> null", () => {
    const path = resolve(tmpDir, "history.jsonl");
    writeFileSync(path, "não\nisso\nnem isso\n");
    assert.equal(readLatestGeoCitationTs(path), null);
  });

  it("registro sem campo ts (unexpected shape) -> pula pra linha anterior", () => {
    const path = resolve(tmpDir, "history.jsonl");
    const lines = [JSON.stringify({ ts: "2026-07-01T10:00:00.000Z" }), JSON.stringify({ provider: "anthropic" })];
    writeFileSync(path, lines.join("\n") + "\n");
    assert.equal(readLatestGeoCitationTs(path), "2026-07-01T10:00:00.000Z");
  });

  it("diretório inexistente no path (não só o arquivo) -> null, sem lançar", () => {
    assert.equal(readLatestGeoCitationTs(resolve(tmpDir, "subdir-inexistente", "history.jsonl")), null);
  });
});
