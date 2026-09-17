/**
 * test/stage4-adjust-timing.test.ts (#8123 Fatia 5)
 *
 * Testa o miolo puro de scripts/lib/stage4-adjust-timing.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeAdjustTimingMetrics } from "../scripts/lib/stage4-adjust-timing.ts";

describe("computeAdjustTimingMetrics", () => {
  it("calcula os 3 deltas e withinTarget10s=true dentro do alvo de 10s", () => {
    const metrics = computeAdjustTimingMetrics({
      requestedAt: "2026-09-17T12:00:00.000Z",
      editedAt: "2026-09-17T12:00:02.000Z",
      previewServedAt: "2026-09-17T12:00:07.000Z",
      toolCalls: 3,
    });
    assert.equal(metrics.requestToEditMs, 2000);
    assert.equal(metrics.editToPreviewMs, 5000);
    assert.equal(metrics.requestToPreviewMs, 7000);
    assert.equal(metrics.toolCalls, 3);
    assert.equal(metrics.withinTarget10s, true);
    assert.equal(metrics.orderWarning, undefined);
  });

  it("withinTarget10s=false quando pedido→preview excede 10s", () => {
    const metrics = computeAdjustTimingMetrics({
      requestedAt: "2026-09-17T12:00:00.000Z",
      editedAt: "2026-09-17T12:00:15.000Z",
      previewServedAt: "2026-09-17T12:00:45.000Z",
      toolCalls: 27,
    });
    assert.equal(metrics.requestToPreviewMs, 45_000);
    assert.equal(metrics.withinTarget10s, false);
  });

  it("exatamente 10.000ms conta como dentro do alvo (limite inclusivo)", () => {
    const metrics = computeAdjustTimingMetrics({
      requestedAt: "2026-09-17T12:00:00.000Z",
      editedAt: "2026-09-17T12:00:01.000Z",
      previewServedAt: "2026-09-17T12:00:10.000Z",
      toolCalls: 2,
    });
    assert.equal(metrics.requestToPreviewMs, 10_000);
    assert.equal(metrics.withinTarget10s, true);
  });

  it("clama deltas negativos em 0 e sinaliza orderWarning quando os timestamps saem fora de ordem", () => {
    const metrics = computeAdjustTimingMetrics({
      requestedAt: "2026-09-17T12:00:10.000Z",
      editedAt: "2026-09-17T12:00:05.000Z", // antes do pedido — relógio divergente
      previewServedAt: "2026-09-17T12:00:20.000Z",
      toolCalls: 1,
    });
    assert.equal(metrics.requestToEditMs, 0);
    assert.ok(metrics.orderWarning?.includes("fora da ordem"));
  });

  it("lança com mensagem acionável em timestamp ausente/vazio", () => {
    assert.throws(
      () =>
        computeAdjustTimingMetrics({
          requestedAt: "",
          editedAt: "2026-09-17T12:00:05.000Z",
          previewServedAt: "2026-09-17T12:00:20.000Z",
          toolCalls: 1,
        }),
      /requestedAt: timestamp ausente\/vazio/,
    );
  });

  it("lança em timestamp não-ISO (ex: data BR dd/mm/aaaa)", () => {
    assert.throws(
      () =>
        computeAdjustTimingMetrics({
          requestedAt: "17/09/2026 12:00:00",
          editedAt: "2026-09-17T12:00:05.000Z",
          previewServedAt: "2026-09-17T12:00:20.000Z",
          toolCalls: 1,
        }),
      /não parece ISO-8601/,
    );
  });

  it("lança em toolCalls não-inteiro ou negativo", () => {
    const base = {
      requestedAt: "2026-09-17T12:00:00.000Z",
      editedAt: "2026-09-17T12:00:02.000Z",
      previewServedAt: "2026-09-17T12:00:07.000Z",
    };
    assert.throws(() => computeAdjustTimingMetrics({ ...base, toolCalls: -1 }), /toolCalls/);
    assert.throws(() => computeAdjustTimingMetrics({ ...base, toolCalls: 1.5 }), /toolCalls/);
  });
});
