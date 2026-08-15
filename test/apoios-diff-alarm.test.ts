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
  maskEmailForIssue,
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

  it("sem guardWarnings (omitido) -> corpo não menciona nenhum guard (back-compat)", () => {
    const input: DiffAlarmInput = { toApply: [], toRemove: [entry("saiu@x.com", "apoiador", null)] };
    const { body } = buildApoiosDiffAlarmEmail(input);
    assert.doesNotMatch(body, /dados parciais/);
    assert.doesNotMatch(body, /blast radius/);
  });

  it("guardWarnings.partialDataBlocksRemovals -> corpo avisa que dados parciais bloqueariam as remoções", () => {
    const input: DiffAlarmInput = { toApply: [], toRemove: [entry("saiu@x.com", "apoiador", null)] };
    const { body } = buildApoiosDiffAlarmEmail(input, {
      partialDataBlocksRemovals: true,
      blastRadiusBlocked: false,
      blastRadiusRatioPct: 0,
    });
    assert.match(body, /dados parciais hoje bloqueariam estas remoções/);
    assert.doesNotMatch(body, /guard de blast radius bloquearia/);
  });

  it("guardWarnings.blastRadiusBlocked -> corpo avisa com o percentual calculado", () => {
    const input: DiffAlarmInput = { toApply: [], toRemove: [entry("saiu@x.com", "apoiador", null)] };
    const { body } = buildApoiosDiffAlarmEmail(input, {
      partialDataBlocksRemovals: false,
      blastRadiusBlocked: true,
      blastRadiusRatioPct: 42.5,
    });
    assert.match(body, /guard de blast radius bloquearia o --push inteiro \(42\.5% > 30%/);
  });

  it("guardWarnings sem toRemove -> nenhum aviso aparece (não há seção de remoções pra anexar)", () => {
    const input: DiffAlarmInput = { toApply: [entry("novo@x.com", null, "amigo")], toRemove: [] };
    const { body } = buildApoiosDiffAlarmEmail(input, {
      partialDataBlocksRemovals: true,
      blastRadiusBlocked: true,
      blastRadiusRatioPct: 99,
    });
    assert.doesNotMatch(body, /dados parciais/);
    assert.doesNotMatch(body, /blast radius/);
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

describe("maskEmailForIssue (#5339)", () => {
  it("mantém só o 1º caractere do local-part + domínio completo", () => {
    assert.equal(maskEmailForIssue("joao@example.com"), "j***@example.com");
  });

  it("e-mail sem @ (malformado) — mascara tudo menos o 1º caractere, fail-soft", () => {
    assert.equal(maskEmailForIssue("naoehemail"), "n***");
  });

  it("string vazia — não lança, retorna máscara genérica", () => {
    assert.equal(maskEmailForIssue(""), "***");
  });
});

describe("buildApoiosDiffAlarmEmail com issueRef (#5339)", () => {
  it("cita o número da issue quando issueRef tem action created/reused", () => {
    const input: DiffAlarmInput = { toApply: [entry("novo@x.com", null, "amigo")], toRemove: [] };
    const { body } = buildApoiosDiffAlarmEmail(input, undefined, {
      issueNumber: 5342,
      url: "https://github.com/vjpixel/diaria-studio/issues/5342",
      action: "created",
    });
    assert.match(body, /Issue: #5342/);
    assert.match(body, /issues\/5342/);
  });

  it("action 'failed' cita o motivo em vez de um número — e-mail nunca perde o achado por falha de gh", () => {
    const input: DiffAlarmInput = { toApply: [entry("novo@x.com", null, "amigo")], toRemove: [] };
    const { body } = buildApoiosDiffAlarmEmail(input, undefined, {
      issueNumber: null,
      url: null,
      action: "failed",
      error: "gh não autenticado",
    });
    assert.match(body, /falha ao criar\/reusar \(gh não autenticado\)/);
  });

  it("sem issueRef (undefined) — corpo sai igual ao comportamento pré-#5339, sem quebrar", () => {
    const input: DiffAlarmInput = { toApply: [entry("novo@x.com", null, "amigo")], toRemove: [] };
    const { body } = buildApoiosDiffAlarmEmail(input);
    assert.doesNotMatch(body, /Issue:/);
  });
});
