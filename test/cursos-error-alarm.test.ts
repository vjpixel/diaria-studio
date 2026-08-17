/**
 * test/cursos-error-alarm.test.ts (#4320, REDESENHADO no #4382)
 *
 * Cobre a lógica PURA de `scripts/lib/cursos-error-alarm.ts`: delta de
 * contadores cumulativos, detecção de padrões fatais (delta > 0), cálculo da
 * taxa de "?email= não confirmado" (com amostra mínima), idempotência via
 * snapshot de contadores (não mais cursor de tempo), e o texto do e-mail de
 * alarme.
 *
 * #4382: a versão original testava eventos de log (`CursosLogEvent[]`) lidos
 * via Cloudflare GraphQL Analytics API — confirmado ao vivo que o dataset
 * usado (`workersInvocationsAdaptiveGroups`) não existe na API real. O
 * redesign troca a fonte de dado por 4 contadores cumulativos no KV
 * (incrementados pelo worker `cursos`, ver `scripts/lib/shared/cursos-alarm-counters.ts`);
 * este arquivo testa a lógica de DELTA sobre esses contadores.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FATAL_LOG_PATTERNS,
  DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT,
  DEFAULT_NOT_CONFIRMED_MIN_SAMPLE,
  emptyCounterSnapshot,
  emptyCursosAlarmState,
  advanceState,
  computeCounterDelta,
  detectFatalMatches,
  computeNotConfirmedRate,
  isRateBreached,
  evaluateCursosCounters,
  shouldAlarm,
  buildCursosAlarmEmail,
  alarmFindingsFor,
  type CursosCounterSnapshot,
  type CursosAlarmState,
} from "../scripts/lib/cursos-error-alarm.ts";

function snapshot(overrides: Partial<CursosCounterSnapshot> = {}): CursosCounterSnapshot {
  return { ...emptyCounterSnapshot(), ...overrides };
}

function stateWith(overrides: Partial<CursosAlarmState> = {}): CursosAlarmState {
  return { ...emptyCursosAlarmState(), ...overrides };
}

// ── computeCounterDelta ──

test("computeCounterDelta — 1ª execução (sem baseline) → delta sempre zerado, mesmo com contadores cumulativos altos", () => {
  const current = snapshot({ fatalCookieHmacSecretAusente: 40, emailGateConfirmed: 900, emailGateNotConfirmed: 50 });
  const delta = computeCounterDelta(emptyCursosAlarmState(), current);
  assert.deepEqual(delta, {
    fatalCookieHmacSecretAusente: 0,
    fatalCadastroBeehiivFalhou: 0,
    emailGateConfirmed: 0,
    emailGateNotConfirmed: 0,
    resetDetected: false,
  });
});

test("computeCounterDelta — com baseline, calcula a diferença desde a última checagem", () => {
  const prev = snapshot({ fatalCookieHmacSecretAusente: 2, emailGateConfirmed: 100, emailGateNotConfirmed: 10 });
  const current = snapshot({ fatalCookieHmacSecretAusente: 3, emailGateConfirmed: 109, emailGateNotConfirmed: 11 });
  const delta = computeCounterDelta(stateWith({ lastCounters: prev }), current);
  assert.equal(delta.fatalCookieHmacSecretAusente, 1);
  assert.equal(delta.emailGateConfirmed, 9);
  assert.equal(delta.emailGateNotConfirmed, 1);
  assert.equal(delta.resetDetected, false);
});

test("computeCounterDelta — sem incrementos desde a última checagem → delta todo zero", () => {
  const prev = snapshot({ fatalCookieHmacSecretAusente: 5, emailGateConfirmed: 20 });
  const delta = computeCounterDelta(stateWith({ lastCounters: prev }), prev);
  assert.deepEqual(delta, {
    fatalCookieHmacSecretAusente: 0,
    fatalCadastroBeehiivFalhou: 0,
    emailGateConfirmed: 0,
    emailGateNotConfirmed: 0,
    resetDetected: false,
  });
});

test("computeCounterDelta — contador atual MENOR que o anterior (reset externo do KV) → delta clampado a 0 + resetDetected", () => {
  const prev = snapshot({ fatalCadastroBeehiivFalhou: 10 });
  const current = snapshot({ fatalCadastroBeehiivFalhou: 2 }); // KV resetado/apagado manualmente
  const delta = computeCounterDelta(stateWith({ lastCounters: prev }), current);
  assert.equal(delta.fatalCadastroBeehiivFalhou, 0);
  assert.equal(delta.resetDetected, true);
});

test("computeCounterDelta — reset detectado num contador não impede o delta correto dos outros", () => {
  const prev = snapshot({ fatalCadastroBeehiivFalhou: 10, emailGateConfirmed: 50 });
  const current = snapshot({ fatalCadastroBeehiivFalhou: 1, emailGateConfirmed: 60 }); // só o 1º resetou
  const delta = computeCounterDelta(stateWith({ lastCounters: prev }), current);
  assert.equal(delta.fatalCadastroBeehiivFalhou, 0);
  assert.equal(delta.emailGateConfirmed, 10);
  assert.equal(delta.resetDetected, true);
});

// ── advanceState ──

test("advanceState — grava o snapshot atual + o instante da checagem", () => {
  const current = snapshot({ fatalCookieHmacSecretAusente: 3 });
  const now = new Date("2026-07-31T14:00:00.000Z");
  assert.deepEqual(advanceState(current, now), { lastCounters: current, lastCheckedAt: "2026-07-31T14:00:00.000Z" });
});

test("cursor encadeado: computeCounterDelta(advanceState(c1, t1), c2) mede só o incremento desde c1 (nunca reprocessa)", () => {
  const c1 = snapshot({ emailGateConfirmed: 10 });
  const state1 = advanceState(c1, new Date("2026-07-31T12:00:00.000Z"));
  const c2 = snapshot({ emailGateConfirmed: 15 });
  const delta = computeCounterDelta(state1, c2);
  assert.equal(delta.emailGateConfirmed, 5);
});

// ── detectFatalMatches ──

test("detectFatalMatches — delta > 0 nos dois contadores fatais → 2 matches com o count do delta", () => {
  const delta = computeCounterDelta(
    stateWith({ lastCounters: snapshot({ fatalCookieHmacSecretAusente: 0, fatalCadastroBeehiivFalhou: 0 }) }),
    snapshot({ fatalCookieHmacSecretAusente: 2, fatalCadastroBeehiivFalhou: 1 }),
  );
  const matches = detectFatalMatches(delta);
  assert.equal(matches.length, 2);
  assert.deepEqual(
    matches.map((m) => m.pattern),
    ["COOKIE_HMAC_SECRET ausente", "cadastro na Beehiiv falhou"],
  );
  assert.equal(matches[0].count, 2);
  assert.equal(matches[1].count, 1);
});

test("detectFatalMatches — sem incremento fatal → array vazio", () => {
  const delta = computeCounterDelta(stateWith({ lastCounters: snapshot() }), snapshot({ emailGateConfirmed: 5 }));
  assert.deepEqual(detectFatalMatches(delta), []);
});

test("FATAL_LOG_PATTERNS — mantém os nomes originais (documentação/asserção de literal no worker)", () => {
  assert.deepEqual([...FATAL_LOG_PATTERNS], ["COOKIE_HMAC_SECRET ausente", "cadastro na Beehiiv falhou"]);
});

// ── computeNotConfirmedRate ──

test("computeNotConfirmedRate — conta confirmado x não-confirmado do delta", () => {
  const delta = computeCounterDelta(
    stateWith({ lastCounters: snapshot() }),
    snapshot({ emailGateConfirmed: 2, emailGateNotConfirmed: 1 }),
  );
  const result = computeNotConfirmedRate(delta, 1);
  assert.equal(result.confirmed, 2);
  assert.equal(result.notConfirmed, 1);
  assert.equal(result.total, 3);
  assert.ok(Math.abs(result.ratePct! - 33.333) < 0.01);
});

test("computeNotConfirmedRate — amostra abaixo do mínimo → ratePct null (nunca mede em N pequeno, #eia-poll)", () => {
  const delta = computeCounterDelta(stateWith({ lastCounters: snapshot() }), snapshot({ emailGateNotConfirmed: 1 }));
  const result = computeNotConfirmedRate(delta, DEFAULT_NOT_CONFIRMED_MIN_SAMPLE);
  assert.equal(result.total, 1);
  assert.equal(result.ratePct, null);
});

test("computeNotConfirmedRate — 100% não-confirmado (gate morto) → ratePct 100", () => {
  const delta = computeCounterDelta(stateWith({ lastCounters: snapshot() }), snapshot({ emailGateNotConfirmed: 10 }));
  const result = computeNotConfirmedRate(delta, 5);
  assert.equal(result.confirmed, 0);
  assert.equal(result.notConfirmed, 10);
  assert.equal(result.ratePct, 100);
});

test("computeNotConfirmedRate — sem nenhum incremento → total 0, ratePct null", () => {
  const delta = computeCounterDelta(stateWith({ lastCounters: snapshot() }), snapshot());
  const result = computeNotConfirmedRate(delta, 0);
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

// ── evaluateCursosCounters / shouldAlarm ──

test("evaluateCursosCounters + shouldAlarm — sem fatal e sem taxa breach → não alarma", () => {
  const state = stateWith({ lastCounters: snapshot(), lastCheckedAt: "2026-07-31T10:00:00.000Z" });
  const current = snapshot({ emailGateConfirmed: 2 });
  const now = new Date("2026-07-31T12:00:00.000Z");
  const evaluation = evaluateCursosCounters(state, current, now);
  assert.equal(evaluation.fatalMatches.length, 0);
  assert.equal(evaluation.rateBreached, false);
  assert.equal(shouldAlarm(evaluation), false);
});

test("evaluateCursosCounters + shouldAlarm — fatal presente dispara mesmo com taxa saudável", () => {
  const state = stateWith({ lastCounters: snapshot(), lastCheckedAt: "2026-07-31T10:00:00.000Z" });
  const current = snapshot({ fatalCadastroBeehiivFalhou: 1, emailGateConfirmed: 9, emailGateNotConfirmed: 1 });
  const now = new Date("2026-07-31T12:00:00.000Z");
  const evaluation = evaluateCursosCounters(state, current, now);
  assert.equal(evaluation.fatalMatches.length, 1);
  assert.equal(evaluation.rateBreached, false);
  assert.equal(shouldAlarm(evaluation), true);
});

test("evaluateCursosCounters + shouldAlarm — taxa estourada dispara mesmo sem fatal", () => {
  const state = stateWith({ lastCounters: snapshot(), lastCheckedAt: "2026-07-31T10:00:00.000Z" });
  const current = snapshot({ emailGateNotConfirmed: 10 });
  const now = new Date("2026-07-31T12:00:00.000Z");
  const evaluation = evaluateCursosCounters(state, current, now);
  assert.equal(evaluation.fatalMatches.length, 0);
  assert.equal(evaluation.rateBreached, true);
  assert.equal(shouldAlarm(evaluation), true);
});

test("evaluateCursosCounters — rateThresholdPct customizado é respeitado (--rate-threshold-pct)", () => {
  const state = stateWith({ lastCounters: snapshot(), lastCheckedAt: "2026-07-31T10:00:00.000Z" });
  const current = snapshot({ emailGateNotConfirmed: 6, emailGateConfirmed: 4 }); // 60% não-confirmado
  const now = new Date("2026-07-31T12:00:00.000Z");
  const strict = evaluateCursosCounters(state, current, now, { rateThresholdPct: 50 });
  const lenient = evaluateCursosCounters(state, current, now, { rateThresholdPct: 90 });
  assert.equal(strict.rateBreached, true);
  assert.equal(lenient.rateBreached, false);
});

test("evaluateCursosCounters — 1ª execução (sem state.lastCounters) nunca alarma, mesmo com contadores cumulativos altos", () => {
  const current = snapshot({ fatalCookieHmacSecretAusente: 999, emailGateNotConfirmed: 500 });
  const now = new Date("2026-07-31T12:00:00.000Z");
  const evaluation = evaluateCursosCounters(emptyCursosAlarmState(), current, now);
  assert.equal(evaluation.fatalMatches.length, 0);
  assert.equal(evaluation.rateBreached, false);
  assert.equal(shouldAlarm(evaluation), false);
  assert.equal(evaluation.since, null);
});

// ── buildCursosAlarmEmail ──

test("buildCursosAlarmEmail — inclui os dois sinais quando ambos disparam, nomeia a janela avaliada", () => {
  const state = stateWith({ lastCounters: snapshot(), lastCheckedAt: "2026-07-31T10:00:00.000Z" });
  const current = snapshot({ fatalCookieHmacSecretAusente: 1, emailGateNotConfirmed: 10 });
  const now = new Date("2026-07-31T12:00:00.000Z");
  const evaluation = evaluateCursosCounters(state, current, now);
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
  const state = stateWith({ lastCounters: snapshot(), lastCheckedAt: "2026-07-31T10:00:00.000Z" });
  const current = snapshot({ fatalCadastroBeehiivFalhou: 1, emailGateConfirmed: 10 });
  const now = new Date("2026-07-31T12:00:00.000Z");
  const evaluation = evaluateCursosCounters(state, current, now);
  const { subject, body } = buildCursosAlarmEmail(evaluation);
  assert.match(subject, /erro/);
  assert.doesNotMatch(subject, /taxa não-confirmado/);
  assert.match(body, /cadastro na Beehiiv falhou/);
  assert.doesNotMatch(body, /Taxa de/);
});

test("buildCursosAlarmEmail — 1ª execução (sem baseline) nomeia a janela sem 'since', nunca alarma nesse caso mas o texto é sensato se chamado direto", () => {
  const current = snapshot({ fatalCookieHmacSecretAusente: 1 });
  const now = new Date("2026-07-31T12:00:00.000Z");
  // Chamado direto (não via evaluateCursosCounters com state vazio, que nunca
  // alarmaria) só pra travar o formato do texto de janela sem `since`.
  const evaluation = evaluateCursosCounters(
    { lastCounters: current, lastCheckedAt: null },
    snapshot({ fatalCookieHmacSecretAusente: 2 }),
    now,
  );
  const { body } = buildCursosAlarmEmail(evaluation);
  assert.match(body, /1ª checagem/);
});

test("buildCursosAlarmEmail — resetDetected adiciona aviso explícito no corpo", () => {
  const state = stateWith({ lastCounters: snapshot({ fatalCadastroBeehiivFalhou: 10 }), lastCheckedAt: "2026-07-31T10:00:00.000Z" });
  const current = snapshot({ fatalCadastroBeehiivFalhou: 1 }); // reset externo
  const now = new Date("2026-07-31T12:00:00.000Z");
  const evaluation = evaluateCursosCounters(state, current, now);
  assert.equal(evaluation.delta.resetDetected, true);
  // Nesse caso específico não haveria alarme (delta clampado a 0), mas o
  // texto do e-mail precisa saber relatar o aviso quando chamado.
  const { body } = buildCursosAlarmEmail(evaluation);
  assert.match(body, /reset externo/);
});

// ─── #5339: issues automáticas por achado ───────────────────────────────────

test("alarmFindingsFor — um finding por padrão fatal + um pra taxa quando ambos disparam", () => {
  const state = stateWith({
    lastCounters: snapshot({ fatalCookieHmacSecretAusente: 0, fatalCadastroBeehiivFalhou: 0, emailGateConfirmed: 0, emailGateNotConfirmed: 0 }),
    lastCheckedAt: "2026-08-14T00:00:00.000Z",
  });
  const current = snapshot({
    fatalCookieHmacSecretAusente: 1,
    fatalCadastroBeehiivFalhou: 2,
    emailGateConfirmed: 0,
    emailGateNotConfirmed: 10,
  });
  const evaluation = evaluateCursosCounters(state, current, new Date("2026-08-15T00:00:00.000Z"));
  const findings = alarmFindingsFor(evaluation);
  assert.equal(findings.length, 3);
  assert.deepEqual(
    findings.map((f) => f.fingerprint).sort(),
    ["fatal:cadastro-beehiiv-falhou", "fatal:cookie-hmac-secret-ausente", "rate-not-confirmed"],
  );
  for (const f of findings) assert.equal(f.check, "cursos-error");
  // #5558: family é sempre "estado" — os 2 padrões (fatal + taxa não confirmada)
  // são condição re-checável a cada execução, resolvem sozinhos.
  for (const f of findings) assert.equal(f.family, "estado");
});

test("alarmFindingsFor — nenhum finding quando nada dispara", () => {
  const state = stateWith({ lastCounters: snapshot(), lastCheckedAt: "2026-08-14T00:00:00.000Z" });
  const current = snapshot();
  const evaluation = evaluateCursosCounters(state, current, new Date("2026-08-15T00:00:00.000Z"));
  assert.deepEqual(alarmFindingsFor(evaluation), []);
});

test("buildCursosAlarmEmail com issueRefs — corpo cita o número da issue por achado (mock, sem rede real)", () => {
  const state = stateWith({
    lastCounters: snapshot(),
    lastCheckedAt: "2026-08-14T00:00:00.000Z",
  });
  const current = snapshot({ fatalCookieHmacSecretAusente: 1 });
  const evaluation = evaluateCursosCounters(state, current, new Date("2026-08-15T00:00:00.000Z"));
  const issueRefs = new Map([["fatal:cookie-hmac-secret-ausente", { issueNumber: 5401, url: "https://github.com/x/y/issues/5401", action: "created" }]]);
  const { body } = buildCursosAlarmEmail(evaluation, issueRefs);
  assert.match(body, /Issue: #5401/);
  assert.match(body, /issues\/5401/);
});

test("buildCursosAlarmEmail com issueRefs — action:'failed' cita o motivo, nunca suprime", () => {
  const state = stateWith({ lastCounters: snapshot(), lastCheckedAt: "2026-08-14T00:00:00.000Z" });
  const current = snapshot({ fatalCookieHmacSecretAusente: 1 });
  const evaluation = evaluateCursosCounters(state, current, new Date("2026-08-15T00:00:00.000Z"));
  const issueRefs = new Map([["fatal:cookie-hmac-secret-ausente", { issueNumber: null, url: null, action: "failed", error: "gh indisponível" }]]);
  const { body } = buildCursosAlarmEmail(evaluation, issueRefs);
  assert.match(body, /falha ao criar\/reusar \(gh indisponível\)/);
});

test("buildCursosAlarmEmail sem issueRefs (undefined) — corpo sai igual ao comportamento pré-#5339, sem quebrar", () => {
  const state = stateWith({ lastCounters: snapshot(), lastCheckedAt: "2026-08-14T00:00:00.000Z" });
  const current = snapshot({ fatalCookieHmacSecretAusente: 1 });
  const evaluation = evaluateCursosCounters(state, current, new Date("2026-08-15T00:00:00.000Z"));
  const { body } = buildCursosAlarmEmail(evaluation);
  assert.doesNotMatch(body, /Issue:/);
});
