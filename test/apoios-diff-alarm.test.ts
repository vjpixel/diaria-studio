/**
 * test/apoios-diff-alarm.test.ts (#4485 item 2)
 *
 * Regressão pura pra `scripts/lib/apoios-diff-alarm.ts` — fingerprint,
 * idempotência (re-arma quando o diff limpa), e o texto do e-mail. Nenhum
 * teste bate em rede/Gmail/Beehiiv real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  hasPendingDiff,
  computeDiffFingerprint,
  emptyApoiosDiffAlarmState,
  advanceState,
  shouldAlarm,
  buildApoiosDiffAlarmEmail,
  type DiffAlarmInput,
} from "../scripts/lib/apoios-diff-alarm.ts";
import { loadState, saveState } from "../scripts/apoios-diff-alarm.ts";

const EMPTY: DiffAlarmInput = { toApply: [], toRemove: [] };

function entry(email: string, fromLevel: string | null, toLevel: string | null) {
  return { email, contactName: email.split("@")[0], fromLevel, toLevel };
}

describe("hasPendingDiff (#4485 item 2)", () => {
  it("sem toApply nem toRemove -> false", () => {
    assert.equal(hasPendingDiff(EMPTY), false);
  });

  it("com toApply -> true", () => {
    assert.equal(hasPendingDiff({ toApply: [entry("a@x.com", null, "amigo")], toRemove: [] }), true);
  });

  it("com toRemove -> true", () => {
    assert.equal(hasPendingDiff({ toApply: [], toRemove: [entry("a@x.com", "amigo", null)] }), true);
  });
});

describe("computeDiffFingerprint (#4485 item 2)", () => {
  it("determinístico e independente da ordem de chegada", () => {
    const a: DiffAlarmInput = { toApply: [entry("a@x.com", null, "amigo"), entry("b@x.com", "amigo", "patrono")], toRemove: [] };
    const b: DiffAlarmInput = { toApply: [entry("b@x.com", "amigo", "patrono"), entry("a@x.com", null, "amigo")], toRemove: [] };
    assert.equal(computeDiffFingerprint(a), computeDiffFingerprint(b));
  });

  it("diff diferente -> fingerprint diferente", () => {
    const a: DiffAlarmInput = { toApply: [entry("a@x.com", null, "amigo")], toRemove: [] };
    const b: DiffAlarmInput = { toApply: [entry("a@x.com", null, "apoiador")], toRemove: [] };
    assert.notEqual(computeDiffFingerprint(a), computeDiffFingerprint(b));
  });

  it("toApply e toRemove nunca colidem no fingerprint mesmo com o mesmo email/níveis", () => {
    const applyOnly: DiffAlarmInput = { toApply: [entry("a@x.com", "amigo", "apoiador")], toRemove: [] };
    const removeOnly: DiffAlarmInput = { toApply: [], toRemove: [entry("a@x.com", "amigo", "apoiador")] };
    assert.notEqual(computeDiffFingerprint(applyOnly), computeDiffFingerprint(removeOnly));
  });
});

describe("shouldAlarm (#4485 item 2)", () => {
  it("sem diff pendente -> nunca alarma, mesmo com state vazio", () => {
    assert.equal(shouldAlarm(emptyApoiosDiffAlarmState(), EMPTY), false);
  });

  it("1ª ocorrência de um diff (state vazio) -> alarma", () => {
    const input: DiffAlarmInput = { toApply: [entry("a@x.com", null, "amigo")], toRemove: [] };
    assert.equal(shouldAlarm(emptyApoiosDiffAlarmState(), input), true);
  });

  it("MESMO diff já alarmado antes -> não realarma (evita spam diário do mesmo pendente)", () => {
    const input: DiffAlarmInput = { toApply: [entry("a@x.com", null, "amigo")], toRemove: [] };
    const state = advanceState(computeDiffFingerprint(input), new Date("2026-08-01T09:00:00Z"));
    assert.equal(shouldAlarm(state, input), false);
  });

  it("diff MUDOU de shape desde o último alarme -> alarma de novo", () => {
    const before: DiffAlarmInput = { toApply: [entry("a@x.com", null, "amigo")], toRemove: [] };
    const after: DiffAlarmInput = { toApply: [entry("a@x.com", null, "amigo"), entry("b@x.com", null, "apoiador")], toRemove: [] };
    const state = advanceState(computeDiffFingerprint(before), new Date("2026-08-01T09:00:00Z"));
    assert.equal(shouldAlarm(state, after), true);
  });

  it("diff resolvido (state re-armado pra null) e o MESMO diff reaparece -> alarma de novo", () => {
    const input: DiffAlarmInput = { toApply: [entry("a@x.com", null, "amigo")], toRemove: [] };
    // Rodada 1: diff existia, foi alarmado.
    let state = advanceState(computeDiffFingerprint(input), new Date("2026-08-01T09:00:00Z"));
    assert.equal(shouldAlarm(state, input), false);
    // Rodada 2: editor rodou --push, diff limpou -> caller re-arma (fingerprint null).
    state = advanceState(null, new Date("2026-08-02T09:00:00Z"));
    // Rodada 3: o MESMO diff reaparece (ex: cancelou e re-assinou no mesmo nível).
    assert.equal(shouldAlarm(state, input), true);
  });
});

describe("buildApoiosDiffAlarmEmail (#4485 item 2)", () => {
  it("assunto reporta as contagens; corpo lista as entradas de toApply e toRemove; nunca menciona --push automático", () => {
    const input: DiffAlarmInput = {
      toApply: [entry("novo@x.com", null, "amigo")],
      toRemove: [entry("saiu@x.com", "apoiador", null)],
    };
    const { subject, body } = buildApoiosDiffAlarmEmail(input);
    assert.match(subject, /1 adição/);
    assert.match(subject, /1 remoção/);
    assert.match(body, /novo@x\.com/);
    assert.match(body, /saiu@x\.com/);
    assert.match(body, /NUNCA aplica --push sozinho/);
  });

  it("sem toApply -> corpo não lista seção de adições", () => {
    const input: DiffAlarmInput = { toApply: [], toRemove: [entry("saiu@x.com", "apoiador", null)] };
    const { body } = buildApoiosDiffAlarmEmail(input);
    assert.doesNotMatch(body, /Adições\/trocas/);
    assert.match(body, /Remoções/);
  });
});

describe("loadState / saveState (scripts/apoios-diff-alarm.ts, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apoios-diff-alarm-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyApoiosDiffAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = advanceState("abc123", new Date("2026-08-02T09:00:00Z"));
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyApoiosDiffAlarmState());
  });

  it("lastAlarmedFingerprint: null é preservado no roundtrip (diff limpo/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = advanceState(null, new Date("2026-08-02T09:00:00Z"));
    saveState(state, path);
    const loaded = loadState(path);
    assert.equal(loaded.lastAlarmedFingerprint, null);
  });
});
