/**
 * test/clarice-postmaster-alarm.test.ts (#5399 achado 2)
 *
 * Lógica pura do alarme de sinal de spam do Postmaster degradado por
 * staleness: `isPostmasterEntryStale` (regressão exigida pela issue), streak
 * de checagens consecutivas, idempotência (não reenvia o mesmo alarme a cada
 * checagem), re-armamento após uma leitura fresca.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  emptyPostmasterStaleAlarmState,
  isPostmasterEntryStale,
  advanceState,
  shouldAlarm,
  markAlarmed,
  buildPostmasterStaleAlarmEmail,
  CONSECUTIVE_STALE_THRESHOLD,
  POSTMASTER_DATA_STALE_MS,
  type PostmasterStaleAlarmState,
} from "../scripts/lib/clarice-postmaster-alarm.ts";
import { loadState, saveState } from "../scripts/clarice-postmaster-alarm.ts";

const NOW = new Date("2026-08-16T12:00:00.000Z");

describe("isPostmasterEntryStale (#5399 achado 2 — regressão exigida pela issue)", () => {
  it("entry com date além de POSTMASTER_DATA_STALE_MS → stale (alarme dispararia)", () => {
    const staleDate = new Date(NOW.getTime() - POSTMASTER_DATA_STALE_MS - 1).toISOString().slice(0, 10);
    assert.equal(isPostmasterEntryStale({ date: staleDate }, NOW), true);
  });

  it("entry fresca (dentro de POSTMASTER_DATA_STALE_MS) → não stale", () => {
    const freshDate = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.equal(isPostmasterEntryStale({ date: freshDate }, NOW), false);
  });

  it("entry null (nenhuma leitura registrada) → stale, fail-safe", () => {
    assert.equal(isPostmasterEntryStale(null, NOW), true);
  });

  it("date inválida/inparseável → stale, fail-safe", () => {
    assert.equal(isPostmasterEntryStale({ date: "não-é-uma-data" }, NOW), true);
  });

  it("exatamente na borda (== POSTMASTER_DATA_STALE_MS) ainda NÃO é stale — só '>' dispara", () => {
    const borderline = new Date(NOW.getTime() - POSTMASTER_DATA_STALE_MS);
    assert.equal(isPostmasterEntryStale({ date: borderline.toISOString() }, NOW), false);
  });
});

describe("advanceState / shouldAlarm (streak de checagens consecutivas)", () => {
  it("1ª checagem stale isolada não atinge o threshold — sem alarme", () => {
    let state = emptyPostmasterStaleAlarmState();
    state = advanceState(state, null, NOW);
    assert.equal(state.consecutiveStale, 1);
    assert.equal(shouldAlarm(state), CONSECUTIVE_STALE_THRESHOLD <= 1);
  });

  it(`${CONSECUTIVE_STALE_THRESHOLD} checagens stale CONSECUTIVAS → shouldAlarm true`, () => {
    let state = emptyPostmasterStaleAlarmState();
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) {
      state = advanceState(state, null, NOW);
    }
    assert.equal(state.consecutiveStale, CONSECUTIVE_STALE_THRESHOLD);
    assert.equal(shouldAlarm(state), true);
  });

  it("markAlarmed impede reenviar o MESMO alarme enquanto o streak continua crescendo", () => {
    let state = emptyPostmasterStaleAlarmState();
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) state = advanceState(state, null, NOW);
    assert.equal(shouldAlarm(state), true);
    state = markAlarmed(state, NOW);
    // Streak continua crescendo (ainda stale) — não deveria alarmar de novo.
    state = advanceState(state, null, NOW);
    assert.equal(shouldAlarm(state), false);
  });

  it("uma leitura FRESCA zera o streak e RE-ARMA o alarme (lastAlarmedAt volta a null)", () => {
    let state = emptyPostmasterStaleAlarmState();
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) state = advanceState(state, null, NOW);
    state = markAlarmed(state, NOW);

    const freshDate = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    state = advanceState(state, { date: freshDate }, NOW);
    assert.equal(state.consecutiveStale, 0);
    assert.equal(state.lastAlarmedAt, null);

    // Depois de reaparecer stale de novo, o threshold volta a valer normalmente.
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) state = advanceState(state, null, NOW);
    assert.equal(shouldAlarm(state), true);
  });
});

describe("buildPostmasterStaleAlarmEmail", () => {
  it("inclui o streak, a última data conhecida e menciona o freio fail-safe", () => {
    let state = emptyPostmasterStaleAlarmState();
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) state = advanceState(state, null, NOW);
    const { subject, body } = buildPostmasterStaleAlarmEmail(state, { date: "2026-08-11" }, undefined);
    assert.match(subject, /Postmaster/);
    assert.match(subject, new RegExp(String(CONSECUTIVE_STALE_THRESHOLD)));
    assert.match(body, /2026-08-11/);
    assert.match(body, /fail-safe/);
  });

  it("entry null → corpo indica ausência de leitura, sem lançar", () => {
    let state = emptyPostmasterStaleAlarmState();
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) state = advanceState(state, null, NOW);
    const { body } = buildPostmasterStaleAlarmEmail(state, null, undefined);
    assert.match(body, /nenhuma leitura registrada/);
  });

  it("com issueRef 'created' cita a issue no corpo", () => {
    let state = emptyPostmasterStaleAlarmState();
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) state = advanceState(state, null, NOW);
    const { body } = buildPostmasterStaleAlarmEmail(state, null, {
      issueNumber: 5400,
      url: "https://github.com/vjpixel/diaria-studio/issues/5400",
      action: "created",
    });
    assert.match(body, /#5400/);
  });
});

describe("loadState / saveState (scripts/clarice-postmaster-alarm.ts, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "postmaster-alarm-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyPostmasterStaleAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state: PostmasterStaleAlarmState = {
      consecutiveStale: CONSECUTIVE_STALE_THRESHOLD,
      lastAlarmedAt: NOW.toISOString(),
      lastCheckedAt: NOW.toISOString(),
    };
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyPostmasterStaleAlarmState());
  });

  it("lastAlarmedAt null é preservado no roundtrip (streak zerado/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state: PostmasterStaleAlarmState = { consecutiveStale: 0, lastAlarmedAt: null, lastCheckedAt: NOW.toISOString() };
    saveState(state, path);
    assert.deepEqual(loadState(path).lastAlarmedAt, null);
  });
});
