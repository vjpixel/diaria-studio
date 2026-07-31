/**
 * test/cursos-error-alarm.test.ts (#4320)
 *
 * Cobre a lógica PURA de `scripts/lib/cursos-error-alarm.ts`: detecção de
 * padrões fatais (qualquer ocorrência), cálculo da taxa de "?email= não
 * confirmado" (com amostra mínima), janela + cursor de idempotência, e o
 * texto do e-mail de alarme.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FATAL_LOG_PATTERNS,
  EMAIL_GATE_CONFIRMED_MESSAGE,
  EMAIL_GATE_NOT_CONFIRMED_MESSAGE,
  DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT,
  DEFAULT_NOT_CONFIRMED_MIN_SAMPLE,
  detectFatalMatches,
  computeNotConfirmedRate,
  isRateBreached,
  emptyCursosAlarmState,
  resolveWindow,
  advanceState,
  INITIAL_LOOKBACK_MS,
  evaluateCursosLogs,
  shouldAlarm,
  buildCursosAlarmEmail,
  type CursosLogEvent,
} from "../scripts/lib/cursos-error-alarm.ts";

function ev(message: string, timestamp = "2026-07-31T12:00:00.000Z"): CursosLogEvent {
  return { timestamp, message };
}

// ── detectFatalMatches ──

test("detectFatalMatches — casa COOKIE_HMAC_SECRET ausente (index.ts e subscribe.ts) e cadastro na Beehiiv falhou", () => {
  const events: CursosLogEvent[] = [
    ev("[cursos] COOKIE_HMAC_SECRET ausente — servindo teaser; NINGUÉM consegue desbloquear"),
    ev("[cursos] COOKIE_HMAC_SECRET ausente — /gate/subscribe indisponível"),
    ev("[cursos] cadastro na Beehiiv falhou (HTTP 500) — nenhum assinante criado"),
    ev("[cursos] ?email= não confirmado como assinante ativo — servindo teaser"), // não fatal
  ];
  const matches = detectFatalMatches(events);
  assert.equal(matches.length, 3);
  assert.deepEqual(
    matches.map((m) => m.pattern),
    ["COOKIE_HMAC_SECRET ausente", "COOKIE_HMAC_SECRET ausente", "cadastro na Beehiiv falhou"],
  );
});

test("detectFatalMatches — sem eventos fatais → array vazio", () => {
  const events: CursosLogEvent[] = [ev(EMAIL_GATE_CONFIRMED_MESSAGE), ev("[cursos] ?email= presente mas malformado")];
  assert.deepEqual(detectFatalMatches(events), []);
});

test("detectFatalMatches — todas as constantes de FATAL_LOG_PATTERNS batem literalmente com o log real do worker", () => {
  // Trava contra drift silencioso: se o texto do log em workers/cursos/src/*.ts
  // mudar sem atualizar este módulo, o alarme para de detectar em silêncio.
  assert.deepEqual([...FATAL_LOG_PATTERNS], ["COOKIE_HMAC_SECRET ausente", "cadastro na Beehiiv falhou"]);
});

// ── computeNotConfirmedRate ──

test("computeNotConfirmedRate — conta confirmado x não-confirmado, ignora outras mensagens", () => {
  const events: CursosLogEvent[] = [
    ev(EMAIL_GATE_CONFIRMED_MESSAGE),
    ev(EMAIL_GATE_CONFIRMED_MESSAGE),
    ev(EMAIL_GATE_NOT_CONFIRMED_MESSAGE),
    ev("[cursos] ?email= — verificação Beehiiv falhou (rede/401/403/429/5xx) — servindo teaser mesmo assim"), // #4321: fora do cômputo
    ev("[cursos] ?email= presente mas malformado — provável merge tag não resolvida"), // fora do cômputo
  ];
  const result = computeNotConfirmedRate(events, 1);
  assert.equal(result.confirmed, 2);
  assert.equal(result.notConfirmed, 1);
  assert.equal(result.total, 3);
  assert.ok(Math.abs(result.ratePct! - 33.333) < 0.01);
});

test("computeNotConfirmedRate — amostra abaixo do mínimo → ratePct null (nunca mede em N pequeno, #eia-poll)", () => {
  const events: CursosLogEvent[] = [ev(EMAIL_GATE_NOT_CONFIRMED_MESSAGE)];
  const result = computeNotConfirmedRate(events, DEFAULT_NOT_CONFIRMED_MIN_SAMPLE);
  assert.equal(result.total, 1);
  assert.equal(result.ratePct, null);
});

test("computeNotConfirmedRate — 100% não-confirmado (gate morto) → ratePct 100", () => {
  const events: CursosLogEvent[] = Array.from({ length: 10 }, () => ev(EMAIL_GATE_NOT_CONFIRMED_MESSAGE));
  const result = computeNotConfirmedRate(events, 5);
  assert.equal(result.confirmed, 0);
  assert.equal(result.notConfirmed, 10);
  assert.equal(result.ratePct, 100);
});

test("computeNotConfirmedRate — sem nenhum evento → total 0, ratePct null", () => {
  const result = computeNotConfirmedRate([], 0);
  assert.equal(result.total, 0);
  assert.equal(result.ratePct, null);
});

// ── isRateBreached ──

test("isRateBreached — ratePct null (amostra insuficiente) nunca dispara, mesmo com threshold baixo", () => {
  assert.equal(isRateBreached({ confirmed: 0, notConfirmed: 1, total: 1, ratePct: null }, 1), false);
});

test("isRateBreached — cruza o limiar (>=) → true; abaixo → false", () => {
  const atThreshold = { confirmed: 1, notConfirmed: 9, total: 10, ratePct: 90 };
  const belowThreshold = { confirmed: 2, notConfirmed: 8, total: 10, ratePct: 80 };
  assert.equal(isRateBreached(atThreshold, DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT), true);
  assert.equal(isRateBreached(belowThreshold, DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT), false);
});

// ── janela + cursor de idempotência ──

test("resolveWindow — sem state prévio (1ª execução), since = now - INITIAL_LOOKBACK_MS", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  const { since, until } = resolveWindow(emptyCursosAlarmState(), now);
  assert.equal(until.getTime(), now.getTime());
  assert.equal(since.getTime(), now.getTime() - INITIAL_LOOKBACK_MS);
});

test("resolveWindow — com cursor salvo, since = lastCheckedUntil (janelas nunca se sobrepõem)", () => {
  const now = new Date("2026-07-31T14:00:00.000Z");
  const state = { lastCheckedUntil: "2026-07-31T12:00:00.000Z" };
  const { since, until } = resolveWindow(state, now);
  assert.equal(since.toISOString(), "2026-07-31T12:00:00.000Z");
  assert.equal(until.getTime(), now.getTime());
});

test("advanceState — grava o fim da janela como ISO", () => {
  const until = new Date("2026-07-31T14:00:00.000Z");
  assert.deepEqual(advanceState(until), { lastCheckedUntil: "2026-07-31T14:00:00.000Z" });
});

test("cursor encadeado: resolveWindow(advanceState(until1), now2).since === until1 (nunca reavalia a mesma janela 2x)", () => {
  const t1 = new Date("2026-07-31T12:00:00.000Z");
  const state1 = advanceState(t1);
  const t2 = new Date("2026-07-31T14:00:00.000Z");
  const { since } = resolveWindow(state1, t2);
  assert.equal(since.getTime(), t1.getTime());
});

// ── evaluateCursosLogs / shouldAlarm ──

test("evaluateCursosLogs + shouldAlarm — sem fatal e sem taxa breach → não alarma", () => {
  const events: CursosLogEvent[] = [ev(EMAIL_GATE_CONFIRMED_MESSAGE), ev(EMAIL_GATE_CONFIRMED_MESSAGE)];
  const window = { since: new Date("2026-07-31T10:00:00.000Z"), until: new Date("2026-07-31T12:00:00.000Z") };
  const evaluation = evaluateCursosLogs(events, window);
  assert.equal(evaluation.fatalMatches.length, 0);
  assert.equal(evaluation.rateBreached, false);
  assert.equal(shouldAlarm(evaluation), false);
});

test("evaluateCursosLogs + shouldAlarm — fatal presente dispara mesmo com taxa saudável", () => {
  const events: CursosLogEvent[] = [
    ev("[cursos] cadastro na Beehiiv falhou (HTTP 500) — nenhum assinante criado"),
    ...Array.from({ length: 9 }, () => ev(EMAIL_GATE_CONFIRMED_MESSAGE)),
    ev(EMAIL_GATE_NOT_CONFIRMED_MESSAGE),
  ];
  const window = { since: new Date("2026-07-31T10:00:00.000Z"), until: new Date("2026-07-31T12:00:00.000Z") };
  const evaluation = evaluateCursosLogs(events, window);
  assert.equal(evaluation.fatalMatches.length, 1);
  assert.equal(evaluation.rateBreached, false);
  assert.equal(shouldAlarm(evaluation), true);
});

test("evaluateCursosLogs + shouldAlarm — taxa estourada dispara mesmo sem fatal", () => {
  const events: CursosLogEvent[] = Array.from({ length: 10 }, () => ev(EMAIL_GATE_NOT_CONFIRMED_MESSAGE));
  const window = { since: new Date("2026-07-31T10:00:00.000Z"), until: new Date("2026-07-31T12:00:00.000Z") };
  const evaluation = evaluateCursosLogs(events, window);
  assert.equal(evaluation.fatalMatches.length, 0);
  assert.equal(evaluation.rateBreached, true);
  assert.equal(shouldAlarm(evaluation), true);
});

test("evaluateCursosLogs — rateThresholdPct customizado é respeitado (--rate-threshold-pct)", () => {
  const events: CursosLogEvent[] = [
    ...Array.from({ length: 6 }, () => ev(EMAIL_GATE_NOT_CONFIRMED_MESSAGE)),
    ...Array.from({ length: 4 }, () => ev(EMAIL_GATE_CONFIRMED_MESSAGE)),
  ]; // 60% não-confirmado
  const window = { since: new Date("2026-07-31T10:00:00.000Z"), until: new Date("2026-07-31T12:00:00.000Z") };
  const strict = evaluateCursosLogs(events, window, { rateThresholdPct: 50 });
  const lenient = evaluateCursosLogs(events, window, { rateThresholdPct: 90 });
  assert.equal(strict.rateBreached, true);
  assert.equal(lenient.rateBreached, false);
});

// ── buildCursosAlarmEmail ──

test("buildCursosAlarmEmail — inclui os dois sinais quando ambos disparam, nomeia a janela avaliada", () => {
  const events: CursosLogEvent[] = [
    ev("[cursos] COOKIE_HMAC_SECRET ausente — servindo teaser; NINGUÉM consegue desbloquear", "2026-07-31T11:00:00.000Z"),
    ...Array.from({ length: 10 }, () => ev(EMAIL_GATE_NOT_CONFIRMED_MESSAGE)),
  ];
  const window = { since: new Date("2026-07-31T10:00:00.000Z"), until: new Date("2026-07-31T12:00:00.000Z") };
  const evaluation = evaluateCursosLogs(events, window);
  const { subject, body } = buildCursosAlarmEmail(evaluation);
  assert.match(subject, /Worker cursos/);
  assert.match(subject, /erro/);
  assert.match(subject, /taxa não-confirmado/);
  assert.match(body, /COOKIE_HMAC_SECRET ausente/);
  assert.match(body, /100\.0%/);
  assert.match(body, /2026-07-31T10:00:00\.000Z/);
  assert.match(body, /2026-07-31T12:00:00\.000Z/);
});

test("buildCursosAlarmEmail — só o sinal que disparou aparece (fatal sem taxa)", () => {
  const events: CursosLogEvent[] = [
    ev("[cursos] cadastro na Beehiiv falhou (HTTP 500) — nenhum assinante criado"),
    ...Array.from({ length: 10 }, () => ev(EMAIL_GATE_CONFIRMED_MESSAGE)),
  ];
  const window = { since: new Date("2026-07-31T10:00:00.000Z"), until: new Date("2026-07-31T12:00:00.000Z") };
  const evaluation = evaluateCursosLogs(events, window);
  const { subject, body } = buildCursosAlarmEmail(evaluation);
  assert.match(subject, /erro/);
  assert.doesNotMatch(subject, /taxa não-confirmado/);
  assert.match(body, /cadastro na Beehiiv falhou/);
  assert.doesNotMatch(body, /Taxa de/);
});
