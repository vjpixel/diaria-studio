/**
 * test/clarice-postmaster-alarm.test.ts (#5399 achado 2, estendido pelo #5412)
 *
 * Lógica pura do alarme de sinal de spam do Postmaster degradado por
 * staleness: `isPostmasterEntryStale` (regressão exigida pela issue #5399 +
 * cobertura estendida `recorded-stale`/`low-coverage` do #5412), streak de
 * checagens consecutivas, idempotência (não reenvia o mesmo alarme a cada
 * checagem), re-armamento após uma leitura fresca, e a distinção
 * `fetch-failed` vs. leitura stale (#5412 achado 2).
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
  type PostmasterEntryForStaleCheck,
  // #5446 item 2
  emptyCampaignSpamMissingAlarmState,
  hasAttributableCampaignSpam,
  advanceCampaignSpamMissingState,
  shouldAlarmCampaignSpamMissing,
  markCampaignSpamMissingAlarmed,
  buildCampaignSpamMissingAlarmEmail,
  CAMPAIGN_SPAM_MISSING_THRESHOLD_DAYS,
  type CampaignSpamMissingAlarmState,
} from "../scripts/lib/clarice-postmaster-alarm.ts";
import {
  loadState,
  saveState,
  loadCampaignSpamMissingState,
  saveCampaignSpamMissingState,
  toAlarmFinding,
  toCampaignSpamMissingFinding,
} from "../scripts/clarice-postmaster-alarm.ts";
import { POSTMASTER_STALE_MS } from "../workers/brevo-dashboard/src/thresholds.ts";

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** Entry VÁLIDA e FRESCA por padrão (todos os 3 guards de `resolveSpamSignal`
 * passam) — cada teste sobrescreve só o campo que quer exercitar. Sem isso,
 * um `{ date: ... }` sozinho (padrão pré-#5412) já cai no branch `malformed`
 * (sem `spamRatePct`/`recordedAt`), mascarando o que o teste quer isolar. */
function freshEntry(p: Partial<PostmasterEntryForStaleCheck & { date: string }> = {}): PostmasterEntryForStaleCheck {
  return {
    date: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    spamRatePct: 0.05,
    recordedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    daysWithData: 10,
    daysProbed: 10,
    ...p,
  } as PostmasterEntryForStaleCheck;
}

describe("isPostmasterEntryStale (#5399 achado 2 + #5412 — cobre os 5 motivos de resolveSpamSignal)", () => {
  it("entry com date além de POSTMASTER_DATA_STALE_MS → stale (date-stale)", () => {
    const staleDate = new Date(NOW.getTime() - POSTMASTER_DATA_STALE_MS - 1).toISOString();
    assert.equal(isPostmasterEntryStale(freshEntry({ date: staleDate }), NOW), true);
  });

  it("entry fresca (todos os guards OK) → não stale", () => {
    assert.equal(isPostmasterEntryStale(freshEntry(), NOW), false);
  });

  it("entry null (nenhuma leitura registrada) → stale, fail-safe (missing)", () => {
    assert.equal(isPostmasterEntryStale(null, NOW), true);
  });

  it("date inválida/inparseável → stale, fail-safe (date-stale)", () => {
    assert.equal(isPostmasterEntryStale(freshEntry({ date: "não-é-uma-data" }), NOW), true);
  });

  it("exatamente na borda de POSTMASTER_DATA_STALE_MS ainda NÃO é stale — só '>' dispara", () => {
    const borderline = new Date(NOW.getTime() - POSTMASTER_DATA_STALE_MS);
    assert.equal(isPostmasterEntryStale(freshEntry({ date: borderline.toISOString() }), NOW), false);
  });

  // #5412 — os 2 branches que o #5399 original NÃO cobria.
  it("#5412: recordedAt além de POSTMASTER_STALE_MS (gravação velha) → stale (recorded-stale), mesmo com date fresca", () => {
    const staleRecordedAt = new Date(NOW.getTime() - POSTMASTER_STALE_MS - 1).toISOString();
    assert.equal(isPostmasterEntryStale(freshEntry({ recordedAt: staleRecordedAt }), NOW), true);
  });

  it("#5412: cobertura baixa (daysWithData/daysProbed < 0.5) → stale (low-coverage), mesmo com date/recordedAt frescos", () => {
    assert.equal(isPostmasterEntryStale(freshEntry({ daysWithData: 1, daysProbed: 10 }), NOW), true);
  });

  it("#5412: cobertura exatamente no piso (0.5) NÃO é stale — só '<' dispara", () => {
    assert.equal(isPostmasterEntryStale(freshEntry({ daysWithData: 5, daysProbed: 10 }), NOW), false);
  });

  it("#5412: spamRatePct ausente/não-finito → stale (malformed)", () => {
    assert.equal(isPostmasterEntryStale(freshEntry({ spamRatePct: NaN }), NOW), true);
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

    state = advanceState(state, freshEntry(), NOW);
    assert.equal(state.consecutiveStale, 0);
    assert.equal(state.lastAlarmedAt, null);
    assert.equal(state.lastStaleReason, null);

    // Depois de reaparecer stale de novo, o threshold volta a valer normalmente.
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) state = advanceState(state, null, NOW);
    assert.equal(shouldAlarm(state), true);
  });

  // #5412 — lastStaleReason grava o motivo (superfície de diagnóstico do e-mail/issue).
  it("#5412: lastStaleReason reflete o motivo do resolveSpamSignal (date-stale, recorded-stale, low-coverage)", () => {
    let state = emptyPostmasterStaleAlarmState();
    state = advanceState(state, null, NOW);
    assert.equal(state.lastStaleReason, "missing");

    state = emptyPostmasterStaleAlarmState();
    const staleDate = new Date(NOW.getTime() - POSTMASTER_DATA_STALE_MS - 1).toISOString();
    state = advanceState(state, freshEntry({ date: staleDate }), NOW);
    assert.equal(state.lastStaleReason, "date-stale");

    state = emptyPostmasterStaleAlarmState();
    const staleRecordedAt = new Date(NOW.getTime() - POSTMASTER_STALE_MS - 1).toISOString();
    state = advanceState(state, freshEntry({ recordedAt: staleRecordedAt }), NOW);
    assert.equal(state.lastStaleReason, "recorded-stale");

    state = emptyPostmasterStaleAlarmState();
    state = advanceState(state, freshEntry({ daysWithData: 1, daysProbed: 10 }), NOW);
    assert.equal(state.lastStaleReason, "low-coverage");
  });

  // #5412 achado 2 — fetch-failed é um motivo DISTINTO, passado explicitamente
  // pelo chamador (não inferido de `entry === null` sozinho).
  it("#5412: opts.fetchFailed=true → lastStaleReason='fetch-failed', mesmo com entry null (indistinguível de 'sem leitura' sem o opt-in)", () => {
    let state = emptyPostmasterStaleAlarmState();
    state = advanceState(state, null, NOW, { fetchFailed: true });
    assert.equal(state.consecutiveStale, 1);
    assert.equal(state.lastStaleReason, "fetch-failed");
  });

  it("#5412: sem opts (default) — entry null vira 'missing', NÃO 'fetch-failed'", () => {
    let state = emptyPostmasterStaleAlarmState();
    state = advanceState(state, null, NOW);
    assert.equal(state.lastStaleReason, "missing");
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

  // #5412 achado 2 — texto distinto pra "dashboard fora do ar" vs "leitura stale".
  it("#5412: lastStaleReason='fetch-failed' → corpo menciona o DASHBOARD, não a task de sync como 1ª suspeita", () => {
    let state = emptyPostmasterStaleAlarmState();
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) state = advanceState(state, null, NOW, { fetchFailed: true });
    const { body } = buildPostmasterStaleAlarmEmail(state, null, undefined);
    assert.match(body, /dashboard não respondeu/i);
  });

  it("#5412: lastStaleReason='recorded-stale' (leitura stale, fetch OK) → corpo NÃO confunde com 'dashboard não respondeu'", () => {
    let state = emptyPostmasterStaleAlarmState();
    const staleRecordedAt = new Date(NOW.getTime() - POSTMASTER_STALE_MS - 1).toISOString();
    for (let i = 0; i < CONSECUTIVE_STALE_THRESHOLD; i++) {
      state = advanceState(state, freshEntry({ recordedAt: staleRecordedAt }), NOW);
    }
    const { body } = buildPostmasterStaleAlarmEmail(state, { date: "2026-08-11" }, undefined);
    assert.doesNotMatch(body, /dashboard não respondeu/i);
    assert.match(body, /provavelmente parou de rodar/);
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

  it("roundtrip: save + load preserva o estado (inclui lastStaleReason, #5412)", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state: PostmasterStaleAlarmState = {
      consecutiveStale: CONSECUTIVE_STALE_THRESHOLD,
      lastAlarmedAt: NOW.toISOString(),
      lastCheckedAt: NOW.toISOString(),
      lastStaleReason: "recorded-stale",
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
    const state: PostmasterStaleAlarmState = {
      consecutiveStale: 0,
      lastAlarmedAt: null,
      lastCheckedAt: NOW.toISOString(),
      lastStaleReason: null,
    };
    saveState(state, path);
    assert.deepEqual(loadState(path).lastAlarmedAt, null);
  });

  it("#5412: estado persistido por versão anterior (sem lastStaleReason) carrega com null — schema evolution fail-soft", () => {
    const path = resolve(tmpDir, "legacy-state.json");
    writeFileSync(
      path,
      JSON.stringify({ consecutiveStale: 1, lastAlarmedAt: null, lastCheckedAt: NOW.toISOString() }),
    );
    const loaded = loadState(path);
    assert.equal(loaded.lastStaleReason, null);
    assert.equal(loaded.consecutiveStale, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #5446 item 2 — ausência PROLONGADA de campaignSpam no KV. Streak
// INDEPENDENTE do de staleness geral acima: a entry pode estar
// perfeitamente fresca (todos os guards de `resolveSpamSignal` OK) e ainda
// assim nunca ter um `worstCampaignSpamRatePct` — cenário real do #5449
// (janela de descoberta curta demais nunca alcançava os dias esparsos com
// FEEDBACK_LOOP_ID publicado).
// ─────────────────────────────────────────────────────────────────────────

describe("hasAttributableCampaignSpam (#5446 item 2)", () => {
  it("entry com worstCampaignSpamRatePct finito → true", () => {
    assert.equal(hasAttributableCampaignSpam(freshEntry({ worstCampaignSpamRatePct: 1.39 })), true);
  });

  it("entry sem worstCampaignSpamRatePct (schema evolution / sem campanha atribuível) → false", () => {
    assert.equal(hasAttributableCampaignSpam(freshEntry()), false);
  });

  it("entry com worstCampaignSpamRatePct não-finito (NaN, payload corrompido) → false", () => {
    assert.equal(hasAttributableCampaignSpam(freshEntry({ worstCampaignSpamRatePct: NaN })), false);
  });

  it("entry null/undefined → false, nunca lança", () => {
    assert.equal(hasAttributableCampaignSpam(null), false);
    assert.equal(hasAttributableCampaignSpam(undefined), false);
  });
});

describe("advanceCampaignSpamMissingState / shouldAlarmCampaignSpamMissing (#5446 item 2)", () => {
  it("streak sobe 1 por checagem sem worstCampaignSpamRatePct", () => {
    let state = emptyCampaignSpamMissingAlarmState();
    state = advanceCampaignSpamMissingState(state, freshEntry(), NOW);
    assert.equal(state.consecutiveMissing, 1);
    state = advanceCampaignSpamMissingState(state, freshEntry(), NOW);
    assert.equal(state.consecutiveMissing, 2);
  });

  it("uma checagem com worstCampaignSpamRatePct presente zera o streak e re-arma o alarme", () => {
    let state: CampaignSpamMissingAlarmState = { consecutiveMissing: 20, lastAlarmedAt: NOW.toISOString(), lastCheckedAt: NOW.toISOString() };
    state = advanceCampaignSpamMissingState(state, freshEntry({ worstCampaignSpamRatePct: 0.5 }), NOW);
    assert.equal(state.consecutiveMissing, 0);
    assert.equal(state.lastAlarmedAt, null, "re-arma pro PRÓXIMO streak de ausência");
  });

  it("entry null (dashboard fora do ar / sem leitura nenhuma) também conta como ausência", () => {
    let state = emptyCampaignSpamMissingAlarmState();
    state = advanceCampaignSpamMissingState(state, null, NOW);
    assert.equal(state.consecutiveMissing, 1);
  });

  it("abaixo do threshold — sem alarme (regressão exigida: falso-positivo em janela de baixo volume normal)", () => {
    const state: CampaignSpamMissingAlarmState = {
      consecutiveMissing: CAMPAIGN_SPAM_MISSING_THRESHOLD_DAYS - 1,
      lastAlarmedAt: null,
      lastCheckedAt: NOW.toISOString(),
    };
    assert.equal(shouldAlarmCampaignSpamMissing(state), false);
  });

  it("no threshold, sem alarme anterior — dispara (regressão exigida pela #5446 item 2)", () => {
    const state: CampaignSpamMissingAlarmState = {
      consecutiveMissing: CAMPAIGN_SPAM_MISSING_THRESHOLD_DAYS,
      lastAlarmedAt: null,
      lastCheckedAt: NOW.toISOString(),
    };
    assert.equal(shouldAlarmCampaignSpamMissing(state), true);
  });

  it("markCampaignSpamMissingAlarmed impede reenviar o MESMO alarme enquanto o streak continua crescendo", () => {
    let state: CampaignSpamMissingAlarmState = {
      consecutiveMissing: CAMPAIGN_SPAM_MISSING_THRESHOLD_DAYS,
      lastAlarmedAt: null,
      lastCheckedAt: NOW.toISOString(),
    };
    assert.equal(shouldAlarmCampaignSpamMissing(state), true);
    state = markCampaignSpamMissingAlarmed(state, NOW);
    state = { ...state, consecutiveMissing: state.consecutiveMissing + 1 };
    assert.equal(shouldAlarmCampaignSpamMissing(state), false);
  });
});

describe("buildCampaignSpamMissingAlarmEmail (#5446 item 2)", () => {
  it("inclui o streak e menciona explicitamente que é sinal DIFERENTE do agregado de domínio", () => {
    const state: CampaignSpamMissingAlarmState = {
      consecutiveMissing: CAMPAIGN_SPAM_MISSING_THRESHOLD_DAYS,
      lastAlarmedAt: null,
      lastCheckedAt: NOW.toISOString(),
    };
    const { subject, body } = buildCampaignSpamMissingAlarmEmail(state);
    assert.match(subject, new RegExp(String(CAMPAIGN_SPAM_MISSING_THRESHOLD_DAYS)));
    assert.match(body, /campanha/i);
    assert.match(body, /média de domínio/i);
  });

  it("com issueRef 'created' cita a issue no corpo", () => {
    const state: CampaignSpamMissingAlarmState = { consecutiveMissing: 14, lastAlarmedAt: null, lastCheckedAt: NOW.toISOString() };
    const { body } = buildCampaignSpamMissingAlarmEmail(state, {
      issueNumber: 5446,
      url: "https://github.com/vjpixel/diaria-studio/issues/5446",
      action: "created",
    });
    assert.match(body, /#5446/);
  });
});

describe("loadCampaignSpamMissingState / saveCampaignSpamMissingState (I/O, #5446 item 2)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clarice-campaign-spam-missing-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    const path = resolve(tmpDir, "nao-existe.json");
    assert.deepEqual(loadCampaignSpamMissingState(path), emptyCampaignSpamMissingAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "state.json");
    const state: CampaignSpamMissingAlarmState = { consecutiveMissing: 14, lastAlarmedAt: NOW.toISOString(), lastCheckedAt: NOW.toISOString() };
    saveCampaignSpamMissingState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadCampaignSpamMissingState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadCampaignSpamMissingState(path), emptyCampaignSpamMissingAlarmState());
  });

  it("estado independente do arquivo de staleness geral — os 2 streaks nunca colidem no mesmo path", () => {
    const staleStatePath = resolve(tmpDir, "postmaster-alarm-state.json");
    const missingStatePath = resolve(tmpDir, "postmaster-campaign-spam-missing-state.json");
    const staleState: PostmasterStaleAlarmState = { consecutiveStale: 5, lastAlarmedAt: null, lastCheckedAt: NOW.toISOString(), lastStaleReason: "date-stale" };
    const missingState: CampaignSpamMissingAlarmState = { consecutiveMissing: 20, lastAlarmedAt: null, lastCheckedAt: NOW.toISOString() };
    saveState(staleState, staleStatePath);
    saveCampaignSpamMissingState(missingState, missingStatePath);
    assert.deepEqual(loadState(staleStatePath), staleState);
    assert.deepEqual(loadCampaignSpamMissingState(missingStatePath), missingState);
  });
});

describe("toAlarmFinding / toCampaignSpamMissingFinding — family (#5558)", () => {
  it("toAlarmFinding é sempre 'estado' — 'o SINAL está cego', resolve sozinho quando uma leitura fresca voltar", () => {
    const state: PostmasterStaleAlarmState = { consecutiveStale: 5, lastAlarmedAt: null, lastCheckedAt: NOW.toISOString(), lastStaleReason: "date-stale" };
    assert.equal(toAlarmFinding(state, null).family, "estado");
  });

  it("toCampaignSpamMissingFinding é sempre 'estado' — condição de ausência re-checada a cada execução", () => {
    const state: CampaignSpamMissingAlarmState = { consecutiveMissing: 20, lastAlarmedAt: null, lastCheckedAt: NOW.toISOString() };
    assert.equal(toCampaignSpamMissingFinding(state).family, "estado");
  });
});
