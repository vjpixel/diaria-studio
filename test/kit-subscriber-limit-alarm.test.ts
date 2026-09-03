/**
 * test/kit-subscriber-limit-alarm.test.ts (#7362)
 *
 * Cobre o miolo puro (`scripts/lib/kit-subscriber-limit-alarm.ts`) — nenhuma
 * chamada de rede. Foco no limiar PERCENTUAL de 85% (decisão do editor,
 * comentário de 03/09/2026 18:55Z — reabriu a issue porque a 1ª
 * implementação, #7368, tinha entrado com um limiar ABSOLUTO de 900, que
 * quebra na virada de plano creator→free de 07/09/2026) e no latch de
 * idempotência (arma na transição, re-arma quando volta a cair abaixo do
 * threshold).
 *
 * Cenário exato que motivou a reabertura, coberto explicitamente abaixo:
 * `total_count=900` alarma contra `subscriber_limit=1000` (90% ≥ 85%) mas
 * NÃO alarma contra `subscriber_limit=10000` (9% < 85%) — a mesma contagem
 * absoluta, dois vereditos diferentes, dependendo só do teto real do plano.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD_PCT,
  evaluateKitSubscriberLimitAlarm,
  emptyKitSubscriberLimitAlarmState,
  shouldAlarmKitSubscriberLimit,
  advanceKitSubscriberLimitAlarmState,
  buildKitSubscriberLimitAlarmEmail,
  KIT_SUBSCRIBER_LIMIT_FINDING_KEY,
} from "../scripts/lib/kit-subscriber-limit-alarm.ts";
import { toAlarmFindings, loadState } from "../scripts/kit-subscriber-limit-alarm.ts";

const NOW = new Date("2026-09-03T12:00:00.000Z");

describe("DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD_PCT (#7362)", () => {
  it("é 0.85 (85%) — decisão explícita do editor, comentário de 03/09/2026 18:55Z", () => {
    assert.equal(DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD_PCT, 0.85);
  });
});

describe("evaluateKitSubscriberLimitAlarm — limiar PERCENTUAL de 85% (#7362, reabertura)", () => {
  it("mesma contagem absoluta (900), teto 1000 (plano creator) → 90% ≥ 85% → triggered", () => {
    const ev = evaluateKitSubscriberLimitAlarm(900, 1000);
    assert.equal(ev.occupancyPct, 0.9);
    assert.equal(ev.triggered, true);
  });

  it("mesma contagem absoluta (900), teto 10000 (plano free pós-virada 07/09) → 9% < 85% → NÃO triggered", () => {
    const ev = evaluateKitSubscriberLimitAlarm(900, 10000);
    assert.equal(ev.occupancyPct, 0.09);
    assert.equal(ev.triggered, false);
  });

  it("849/1000 = 84,9% → NÃO triggered (abaixo do limiar)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(849, 1000);
    assert.equal(ev.triggered, false);
  });

  it("exatamente 850/1000 = 85% → triggered (inclusivo)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(850, 1000);
    assert.equal(ev.triggered, true);
  });

  it("851/1000 → triggered", () => {
    const ev = evaluateKitSubscriberLimitAlarm(851, 1000);
    assert.equal(ev.triggered, true);
  });

  it("estado real medido em 03/09/2026 (629 ativos, teto 1000, 62,9%) → NÃO triggered", () => {
    const ev = evaluateKitSubscriberLimitAlarm(629, 1000);
    assert.equal(ev.triggered, false);
    assert.equal(ev.remainingToLimit, 371);
  });

  it("remainingToLimit pode ficar negativo se o teto já foi ultrapassado (sem clamp)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(1010, 1000);
    assert.equal(ev.triggered, true);
    assert.equal(ev.remainingToLimit, -10);
  });

  it("thresholdPct é override-ável (não fixo em 85%, plano/editor pode recalibrar)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(1800, 2000, 0.95); // 90% < 95%
    assert.equal(ev.triggered, false);
    const ev2 = evaluateKitSubscriberLimitAlarm(1900, 2000, 0.95); // 95% >= 95%
    assert.equal(ev2.triggered, true);
  });

  it("subscriberLimit <= 0 (teto desconhecido) → occupancyPct 0, nunca triggered (sem NaN/Infinity)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(500, 0);
    assert.equal(ev.occupancyPct, 0);
    assert.equal(ev.triggered, false);
    assert.ok(Number.isFinite(ev.occupancyPct));
  });
});

describe("shouldAlarmKitSubscriberLimit / advanceKitSubscriberLimitAlarmState — latch", () => {
  it("estado vazio, abaixo do threshold → não alarma", () => {
    const ev = evaluateKitSubscriberLimitAlarm(500, 1000); // 50%
    assert.equal(shouldAlarmKitSubscriberLimit(emptyKitSubscriberLimitAlarmState(), ev), false);
  });

  it("estado vazio, cruzou o threshold → alarma (1ª vez)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(950, 1000); // 95%
    assert.equal(shouldAlarmKitSubscriberLimit(emptyKitSubscriberLimitAlarmState(), ev), true);
  });

  it("já alarmado, permanece acima do threshold → NÃO alarma de novo (idempotência, latch)", () => {
    const ev1 = evaluateKitSubscriberLimitAlarm(950, 1000);
    const state = advanceKitSubscriberLimitAlarmState(emptyKitSubscriberLimitAlarmState(), ev1, NOW);
    assert.equal(state.alarmed, true);

    const ev2 = evaluateKitSubscriberLimitAlarm(970, 1000); // subiu mais, ainda acima
    assert.equal(shouldAlarmKitSubscriberLimit(state, ev2), false);
  });

  it("já alarmado, caiu de volta abaixo do threshold → re-arma (não alarma nesta leitura)", () => {
    const ev1 = evaluateKitSubscriberLimitAlarm(950, 1000);
    const alarmedState = advanceKitSubscriberLimitAlarmState(emptyKitSubscriberLimitAlarmState(), ev1, NOW);

    const ev2 = evaluateKitSubscriberLimitAlarm(800, 1000); // caiu abaixo (80% < 85%)
    assert.equal(shouldAlarmKitSubscriberLimit(alarmedState, ev2), false);
    const rearmedState = advanceKitSubscriberLimitAlarmState(alarmedState, ev2, NOW);
    assert.equal(rearmedState.alarmed, false);
  });

  it("re-armado, cruza o threshold de novo → alarma de novo", () => {
    const ev1 = evaluateKitSubscriberLimitAlarm(950, 1000);
    const alarmedState = advanceKitSubscriberLimitAlarmState(emptyKitSubscriberLimitAlarmState(), ev1, NOW);
    const ev2 = evaluateKitSubscriberLimitAlarm(800, 1000);
    const rearmedState = advanceKitSubscriberLimitAlarmState(alarmedState, ev2, NOW);

    const ev3 = evaluateKitSubscriberLimitAlarm(900, 1000); // 90%
    assert.equal(shouldAlarmKitSubscriberLimit(rearmedState, ev3), true);
  });

  it("virada de plano em produção: alarmado a 90%/1000, teto muda pra 10000 na leitura seguinte → re-arma", () => {
    const ev1 = evaluateKitSubscriberLimitAlarm(900, 1000); // 90%, triggered
    const alarmedState = advanceKitSubscriberLimitAlarmState(emptyKitSubscriberLimitAlarmState(), ev1, NOW);
    assert.equal(alarmedState.alarmed, true);

    const ev2 = evaluateKitSubscriberLimitAlarm(900, 10000); // mesma contagem, teto novo: 9%
    assert.equal(ev2.triggered, false);
    assert.equal(shouldAlarmKitSubscriberLimit(alarmedState, ev2), false);
    const rearmedState = advanceKitSubscriberLimitAlarmState(alarmedState, ev2, NOW);
    assert.equal(rearmedState.alarmed, false);
  });
});

describe("buildKitSubscriberLimitAlarmEmail", () => {
  it("assunto/corpo citam contagem, ocupação percentual, threshold percentual e teto", () => {
    const ev = evaluateKitSubscriberLimitAlarm(905, 1000); // 90,5%
    const { subject, body } = buildKitSubscriberLimitAlarmEmail(ev, NOW);
    assert.match(subject, /905/);
    assert.match(subject, /90%|91%/); // Math.round(90.5) === 91, mas tolerante a arredondamento
    assert.match(subject, /85%/);
    assert.match(subject, /1000/);
    assert.match(body, /#7362/);
    assert.match(body, /85%/);
  });

  it("issueRef presente → corpo cita o número da issue", () => {
    const ev = evaluateKitSubscriberLimitAlarm(905, 1000);
    const { body } = buildKitSubscriberLimitAlarmEmail(ev, NOW, {
      issueNumber: 7400,
      url: "https://github.com/x/y/issues/7400",
      action: "created",
    });
    assert.match(body, /#7400/);
  });

  it("issueRef com action failed → corpo cita a falha, não um número inventado", () => {
    const ev = evaluateKitSubscriberLimitAlarm(905, 1000);
    const { body } = buildKitSubscriberLimitAlarmEmail(ev, NOW, {
      issueNumber: null,
      url: null,
      action: "failed",
      error: "gh não autenticado",
    });
    assert.match(body, /falha ao criar\/reusar/);
    assert.match(body, /gh não autenticado/);
  });
});

describe("loadState — camada de I/O (scripts/kit-subscriber-limit-alarm.ts, #7368)", () => {
  // Mesma receita de tmpdir de test/codex-credential-alarm-script-7250.test.ts
  // — precedente exato pra este padrão (readState/writeState do alarme
  // Codex), citado no fleet review desta PR (pr-test-analyzer, P2).
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-subscriber-limit-alarm-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("arquivo ausente devolve estado vazio, nunca lança", () => {
    assert.deepEqual(loadState(join(dir, "nao-existe.json")), emptyKitSubscriberLimitAlarmState());
  });

  it("JSON corrompido degrada para estado vazio, nunca lança", () => {
    const p = join(dir, "corrompido.json");
    writeFileSync(p, "{isto não é json", "utf8");
    assert.deepEqual(loadState(p), emptyKitSubscriberLimitAlarmState());
  });

  it("`alarmed` não-booleano degrada para false (nunca herda um valor truthy solto)", () => {
    const p = join(dir, "alarmed-nao-booleano.json");
    writeFileSync(p, JSON.stringify({ alarmed: "sim", lastCheckedAt: "2026-09-03T12:00:00.000Z" }), "utf8");
    const state = loadState(p);
    assert.equal(state.alarmed, false);
    assert.equal(state.lastCheckedAt, "2026-09-03T12:00:00.000Z");
  });

  it("`lastCheckedAt` não-string degrada para null", () => {
    const p = join(dir, "lastcheckedat-nao-string.json");
    writeFileSync(p, JSON.stringify({ alarmed: true, lastCheckedAt: 1756900800000 }), "utf8");
    const state = loadState(p);
    assert.equal(state.alarmed, true);
    assert.equal(state.lastCheckedAt, null);
  });

  it("caso feliz repassa os campos sem alterar", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify({ alarmed: true, lastCheckedAt: "2026-09-03T12:00:00.000Z" }), "utf8");
    assert.deepEqual(loadState(p), { alarmed: true, lastCheckedAt: "2026-09-03T12:00:00.000Z" });
  });
});

describe("toAlarmFindings (scripts/kit-subscriber-limit-alarm.ts)", () => {
  it("abaixo do threshold → nenhum finding", () => {
    const ev = evaluateKitSubscriberLimitAlarm(500, 1000);
    assert.deepEqual(toAlarmFindings(ev), []);
  });

  it("acima do threshold → 1 finding, check == fingerprint == chave constante", () => {
    const ev = evaluateKitSubscriberLimitAlarm(905, 1000);
    const findings = toAlarmFindings(ev);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, KIT_SUBSCRIBER_LIMIT_FINDING_KEY);
    assert.equal(findings[0].fingerprint, KIT_SUBSCRIBER_LIMIT_FINDING_KEY);
    assert.equal(findings[0].family, "estado");
    assert.equal(findings[0].priority, "P1");
  });

  it("fingerprint constante independente da contagem exata (não abre 2ª issue por variação de contagem)", () => {
    const findingsA = toAlarmFindings(evaluateKitSubscriberLimitAlarm(905, 1000));
    const findingsB = toAlarmFindings(evaluateKitSubscriberLimitAlarm(950, 1000));
    assert.equal(findingsA[0].fingerprint, findingsB[0].fingerprint);
  });

  it("mesma contagem absoluta (900), teto diferente (10000) → nenhum finding — o cenário da reabertura", () => {
    const findings1000 = toAlarmFindings(evaluateKitSubscriberLimitAlarm(900, 1000));
    const findings10000 = toAlarmFindings(evaluateKitSubscriberLimitAlarm(900, 10000));
    assert.equal(findings1000.length, 1);
    assert.equal(findings10000.length, 0);
  });
});
