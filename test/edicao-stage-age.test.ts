/**
 * test/edicao-stage-age.test.ts (#3871) — cobertura da lógica PURA de idade
 * do último evento de um stage "current" no cockpit
 * (`scripts/studio-ui/public/edicao-stage-age.js`). Mesmo padrão de
 * `test/revisao-guards.test.ts`: o módulo não toca `document`/`fetch`, então
 * é testável com fixtures puras, sem DOM real.
 *
 * Regressão coberta (#3871): antes deste fix, `renderTimeline` (edicao.js)
 * desenhava `status-${status}` + `current` sem indicar há quanto tempo o
 * stage estava naquele estado — um stage "current" há 2min e um "current"
 * há 2h renderizavam idêntico. `computeStageAge` calcula essa idade a
 * partir do `logBuffer` já em memória, espelhando o padrão de
 * `renderStudioSnapshotHtml` (workers/diaria-dashboard/src/index.ts, #3565).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStageAge, STAGE_AGE_STALE_MINUTES } from "../scripts/studio-ui/public/edicao-stage-age.js";

const NOW = new Date("2026-07-22T12:00:00.000Z").getTime();

describe("computeStageAge (#3871)", () => {
  it("sem NENHUM evento pro stage — retorna ageMinutes null, label explícito e stale=true (situação mais suspeita)", () => {
    const result = computeStageAge(2, [], NOW);
    assert.equal(result.ageMinutes, null);
    assert.equal(result.label, "sem eventos registrados ainda");
    assert.equal(result.stale, true);
  });

  it("logBuffer com eventos de OUTROS stages não conta pro stage consultado", () => {
    const logBuffer = [
      { stage: 1, timestamp: "2026-07-22T11:59:00.000Z" },
      { stage: 3, timestamp: "2026-07-22T11:59:59.000Z" },
    ];
    const result = computeStageAge(2, logBuffer, NOW);
    assert.equal(result.ageMinutes, null);
    assert.equal(result.stale, true);
  });

  it("evento recente (5min atrás) — não stale, label com minutos exatos", () => {
    const logBuffer = [{ stage: 2, timestamp: "2026-07-22T11:55:00.000Z" }];
    const result = computeStageAge(2, logBuffer, NOW);
    assert.equal(result.ageMinutes, 5);
    assert.equal(result.label, "último evento há 5min");
    assert.equal(result.stale, false);
  });

  it("evento agora mesmo (0min) — label especial 'agora mesmo'", () => {
    const logBuffer = [{ stage: 2, timestamp: "2026-07-22T12:00:00.000Z" }];
    const result = computeStageAge(2, logBuffer, NOW);
    assert.equal(result.ageMinutes, 0);
    assert.equal(result.label, "último evento agora mesmo");
    assert.equal(result.stale, false);
  });

  it(`evento exatamente no limiar (${STAGE_AGE_STALE_MINUTES}min) — ainda NÃO stale (limiar é estritamente 'acima de')`, () => {
    const ts = new Date(NOW - STAGE_AGE_STALE_MINUTES * 60_000).toISOString();
    const result = computeStageAge(2, [{ stage: 2, timestamp: ts }], NOW);
    assert.equal(result.ageMinutes, STAGE_AGE_STALE_MINUTES);
    assert.equal(result.stale, false);
  });

  it(`evento 1min acima do limiar (${STAGE_AGE_STALE_MINUTES + 1}min) — stale=true`, () => {
    const ts = new Date(NOW - (STAGE_AGE_STALE_MINUTES + 1) * 60_000).toISOString();
    const result = computeStageAge(2, [{ stage: 2, timestamp: ts }], NOW);
    assert.equal(result.ageMinutes, STAGE_AGE_STALE_MINUTES + 1);
    assert.equal(result.stale, true);
  });

  it("usa o evento MAIS RECENTE do stage quando há múltiplos (não o primeiro nem o mais antigo)", () => {
    const logBuffer = [
      { stage: 2, timestamp: "2026-07-22T10:00:00.000Z" }, // 2h atrás
      { stage: 2, timestamp: "2026-07-22T11:58:00.000Z" }, // 2min atrás — o mais recente
      { stage: 2, timestamp: "2026-07-22T11:30:00.000Z" }, // 30min atrás
    ];
    const result = computeStageAge(2, logBuffer, NOW);
    assert.equal(result.ageMinutes, 2);
    assert.equal(result.stale, false);
  });

  it("evento com timestamp inválido/ausente é ignorado — cai no caso 'sem eventos válidos'", () => {
    const logBuffer = [
      { stage: 2, timestamp: "não-é-uma-data" },
      { stage: 2 },
    ];
    const result = computeStageAge(2, logBuffer, NOW);
    assert.equal(result.ageMinutes, null);
    assert.equal(result.stale, true);
  });

  it("logBuffer não-array (defensivo) não quebra — trata como vazio", () => {
    // @ts-expect-error — teste defensivo de input malformado
    const result = computeStageAge(2, undefined, NOW);
    assert.equal(result.ageMinutes, null);
    assert.equal(result.stale, true);
  });
});
