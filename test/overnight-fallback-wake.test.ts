/**
 * test/overnight-fallback-wake.test.ts (#2896, regressão #633)
 *
 * Cobre o helper puro de fallback-wake determinístico introduzido para
 * fechar o buraco descoberto no incidente overnight 260702-r2: o coordenador
 * ficou ~8h parado porque (1) o guard event-driven #2768 nunca roda sem
 * evento recebido, e (2) o watchdog externo #2688 não estava armado. Sem o
 * helper `shouldWakeCheck`, não há como o coordenador decidir
 * deterministicamente — ao acordar via `ScheduleWakeup` sem nenhum evento —
 * se uma unidade estagnou. Estes testes fixam timestamps de fixture (nunca
 * o relógio real), mesmo padrão de `test/overnight-watchdog.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldWakeCheck,
  computeElapsedMin,
  classifyResumeSignal,
} from "../scripts/lib/overnight-fallback-wake.ts";

// ---------------------------------------------------------------------------
// shouldWakeCheck
// ---------------------------------------------------------------------------

describe("shouldWakeCheck (#2896)", () => {
  const DISPATCH = "2026-07-02T10:00:00Z";

  it("dispatch há 61 min sem evento → true (stall determinístico)", () => {
    const now = "2026-07-02T11:01:00Z"; // +61 min
    assert.equal(shouldWakeCheck(DISPATCH, now, 60), true);
  });

  it("dispatch há 59 min → false (ainda dentro do threshold)", () => {
    const now = "2026-07-02T10:59:00Z"; // +59 min
    assert.equal(shouldWakeCheck(DISPATCH, now, 60), false);
  });

  it("exatamente no threshold (60 min) → true (borda inclusiva)", () => {
    const now = "2026-07-02T11:00:00Z"; // +60 min exatos
    assert.equal(shouldWakeCheck(DISPATCH, now, 60), true);
  });

  it("1 segundo antes do threshold → false", () => {
    const now = "2026-07-02T10:59:59Z"; // +59min59s
    assert.equal(shouldWakeCheck(DISPATCH, now, 60), false);
  });

  it("threshold customizado (30 min) — caso positivo", () => {
    const now = "2026-07-02T10:31:00Z"; // +31 min
    assert.equal(shouldWakeCheck(DISPATCH, now, 30), true);
  });

  it("threshold customizado (30 min) — caso negativo", () => {
    const now = "2026-07-02T10:29:00Z"; // +29 min
    assert.equal(shouldWakeCheck(DISPATCH, now, 30), false);
  });

  it("now anterior ao dispatch (relógio incoerente) → false, nunca lança", () => {
    const now = "2026-07-02T09:00:00Z"; // antes do dispatch
    assert.equal(shouldWakeCheck(DISPATCH, now, 60), false);
  });

  it("dispatchISO inválido → false (fail-soft, nunca lança dentro do wake handler)", () => {
    assert.equal(shouldWakeCheck("not-a-date", "2026-07-02T11:01:00Z", 60), false);
  });

  it("nowISO inválido → false (fail-soft)", () => {
    assert.equal(shouldWakeCheck(DISPATCH, "not-a-date", 60), false);
  });

  it("usa threshold default de 60 min quando omitido", () => {
    const now61 = "2026-07-02T11:01:00Z";
    const now59 = "2026-07-02T10:59:00Z";
    assert.equal(shouldWakeCheck(DISPATCH, now61), true);
    assert.equal(shouldWakeCheck(DISPATCH, now59), false);
  });

  // -------------------------------------------------------------------------
  // Cenário REAL do incidente 260702-r2: dispatch 03:37Z, wake em 12:19Z
  // (>60 min sem NENHUM evento recebido pelo coordenador) — o guard
  // determinístico deveria ter disparado o fluxo de stall do #2768 muito
  // antes das ~8h de silêncio observadas.
  // -------------------------------------------------------------------------
  it("cenário real do incidente #2896: dispatch 03:37Z, now 12:19Z, zero eventos → true", () => {
    const dispatchIncidente = "2026-07-02T03:37:00Z";
    const nowIncidente = "2026-07-02T12:19:00Z";
    assert.equal(shouldWakeCheck(dispatchIncidente, nowIncidente, 60), true);
    // elapsed real ~8h42min, muito além do threshold de 60min — o fallback
    // wake teria disparado dezenas de ciclos antes deste ponto se o
    // ScheduleWakeup de ~20min estivesse ativo desde o dispatch.
    const elapsed = computeElapsedMin(dispatchIncidente, nowIncidente);
    assert.ok(elapsed > 500, `elapsed esperado > 500min, obtido ${elapsed}`);
  });
});

// ---------------------------------------------------------------------------
// computeElapsedMin
// ---------------------------------------------------------------------------

describe("computeElapsedMin (#2896)", () => {
  it("60 minutos exatos", () => {
    assert.equal(
      computeElapsedMin("2026-07-02T10:00:00Z", "2026-07-02T11:00:00Z"),
      60,
    );
  });

  it("valor fracionário (90 segundos = 1.5 min)", () => {
    assert.equal(
      computeElapsedMin("2026-07-02T10:00:00Z", "2026-07-02T10:01:30Z"),
      1.5,
    );
  });

  it("zero minutos (mesmo timestamp)", () => {
    assert.equal(
      computeElapsedMin("2026-07-02T10:00:00Z", "2026-07-02T10:00:00Z"),
      0,
    );
  });

  it("valor negativo quando now é anterior ao dispatch (não normaliza)", () => {
    assert.equal(
      computeElapsedMin("2026-07-02T10:00:00Z", "2026-07-02T09:00:00Z"),
      -60,
    );
  });

  it("cenário real do incidente: dispatch 03:37Z → now 12:19Z = 522 min", () => {
    assert.equal(
      computeElapsedMin("2026-07-02T03:37:00Z", "2026-07-02T12:19:00Z"),
      522,
    );
  });

  it("lança erro claro para dispatchISO inválido", () => {
    assert.throws(
      () => computeElapsedMin("not-a-date", "2026-07-02T11:00:00Z"),
      /dispatchISO inválido/,
    );
  });

  it("lança erro claro para nowISO inválido", () => {
    assert.throws(
      () => computeElapsedMin("2026-07-02T10:00:00Z", "not-a-date"),
      /nowISO inválido/,
    );
  });
});

// ---------------------------------------------------------------------------
// classifyResumeSignal
// ---------------------------------------------------------------------------

describe("classifyResumeSignal (#2896)", () => {
  it('"queued for delivery at its next tool round" → queued', () => {
    assert.equal(
      classifyResumeSignal("queued for delivery at its next tool round"),
      "queued",
    );
  });

  it('"Message queued" → queued (case variant)', () => {
    assert.equal(classifyResumeSignal("Message queued"), "queued");
  });

  it('"agent stopped" → resumed', () => {
    assert.equal(classifyResumeSignal("agent stopped"), "resumed");
  });

  it('"agent resumed" → resumed', () => {
    assert.equal(classifyResumeSignal("agent resumed"), "resumed");
  });

  it("texto aleatório sem padrão reconhecido → unknown", () => {
    assert.equal(classifyResumeSignal("something completely different"), "unknown");
  });

  it("string vazia → unknown", () => {
    assert.equal(classifyResumeSignal(""), "unknown");
  });

  it("é case-insensitive: QUEUED FOR DELIVERY → queued", () => {
    assert.equal(classifyResumeSignal("QUEUED FOR DELIVERY"), "queued");
  });

  it("é case-insensitive: Agent STOPPED → resumed", () => {
    assert.equal(classifyResumeSignal("Agent STOPPED"), "resumed");
  });

  it("é case-insensitive: ReSuMeD mid-sentence → resumed", () => {
    assert.equal(classifyResumeSignal("The subagent was ReSuMeD successfully"), "resumed");
  });

  it("'queued' tem precedência se o texto contiver ambos os termos", () => {
    assert.equal(
      classifyResumeSignal("previously stopped, now queued for delivery"),
      "queued",
    );
  });
});
