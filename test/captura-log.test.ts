/**
 * test/captura-log.test.ts (#7174)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCapturaLogEntry, serializeCapturaLogEntry, hasCaptureOnDay } from "../scripts/lib/metrics/captura-log.ts";

describe("buildCapturaLogEntry", () => {
  it("monta captura_id determinístico a partir de platform+capturedAt", () => {
    const entry = buildCapturaLogEntry({
      platform: "kit",
      capturedAt: "2026-09-02T04:25:00.000Z",
      totalRetornadoApi: 649,
      novosGravados: 12,
      eventosEstado: 2,
      exit: 0,
    });
    assert.equal(entry.captura_id, "kit-2026-09-02T04:25:00.000Z");
    assert.equal(entry.total_retornado_api, 649);
    assert.equal(entry.novos_gravados, 12);
    assert.equal(entry.eventos_estado, 2);
    assert.equal(entry.exit, 0);
  });
});

describe("serializeCapturaLogEntry", () => {
  it("serializa como 1 linha JSON com \\n final, parseável de volta", () => {
    const entry = buildCapturaLogEntry({
      platform: "kit",
      capturedAt: "2026-09-02T04:25:00.000Z",
      totalRetornadoApi: 649,
      novosGravados: 0,
      eventosEstado: 0,
      exit: 0,
    });
    const line = serializeCapturaLogEntry(entry);
    assert.ok(line.endsWith("\n"));
    assert.deepEqual(JSON.parse(line.trimEnd()), entry);
  });
});

describe("hasCaptureOnDay", () => {
  it("true quando existe pelo menos 1 linha capturada naquele dia", () => {
    const entries = [
      buildCapturaLogEntry({ platform: "kit", capturedAt: "2026-09-02T04:25:00.000Z", totalRetornadoApi: 1, novosGravados: 0, eventosEstado: 0, exit: 0 }),
    ];
    assert.equal(hasCaptureOnDay(entries, "2026-09-02"), true);
  });

  it("false quando nenhuma linha bate o dia — distingue de 'dia com 0 cadastros'", () => {
    const entries = [
      buildCapturaLogEntry({ platform: "kit", capturedAt: "2026-09-01T04:25:00.000Z", totalRetornadoApi: 1, novosGravados: 0, eventosEstado: 0, exit: 0 }),
    ];
    assert.equal(hasCaptureOnDay(entries, "2026-09-02"), false);
  });

  it("dia com execução mas zero cadastros novos ainda conta como capturado (não confundir com ausência)", () => {
    const entries = [
      buildCapturaLogEntry({ platform: "kit", capturedAt: "2026-09-02T04:25:00.000Z", totalRetornadoApi: 649, novosGravados: 0, eventosEstado: 0, exit: 0 }),
    ];
    assert.equal(hasCaptureOnDay(entries, "2026-09-02"), true);
    assert.equal(entries[0].novos_gravados, 0);
  });
});
