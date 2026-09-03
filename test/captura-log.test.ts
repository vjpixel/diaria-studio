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

  it("#7179: usa `dia` (já BRT) quando presente, ignorando o dia UTC de captured_at", () => {
    // captured_at cai num dia UTC diferente de `dia` (execução do backfill
    // rodando de madrugada) — `dia` precisa vencer, nunca o captured_at.
    const entries = [
      buildCapturaLogEntry({
        platform: "beehiiv",
        capturedAt: "2026-09-03T02:00:00.000Z", // 2026-09-02 23:00 BRT
        totalRetornadoApi: 3,
        novosGravados: 3,
        eventosEstado: 3,
        exit: 0,
        origemSerie: "backfill-beehiiv",
        dia: "2026-06-01",
      }),
    ];
    assert.equal(hasCaptureOnDay(entries, "2026-06-01"), true);
    assert.equal(hasCaptureOnDay(entries, "2026-09-02"), false);
    assert.equal(entries[0].origem_serie, "backfill-beehiiv");
  });

  it("#7179: sem `dia` (linha kit-vivo pré-existente), cai para captured_at convertido pra BRT", () => {
    // 2026-09-02T02:00:00Z = 2026-09-01 23:00 BRT (UTC-3) — dia BRT é o
    // anterior ao dia UTC.
    const entries = [
      buildCapturaLogEntry({ platform: "kit", capturedAt: "2026-09-02T02:00:00.000Z", totalRetornadoApi: 1, novosGravados: 0, eventosEstado: 0, exit: 0 }),
    ];
    assert.equal(hasCaptureOnDay(entries, "2026-09-01"), true);
    assert.equal(hasCaptureOnDay(entries, "2026-09-02"), false);
  });

  it("#7179: origem_serie/dia ausentes por padrão (compatibilidade com linhas pré-#7179)", () => {
    const entry = buildCapturaLogEntry({ platform: "kit", capturedAt: "2026-09-02T04:25:00.000Z", totalRetornadoApi: 1, novosGravados: 0, eventosEstado: 0, exit: 0 });
    assert.equal(entry.origem_serie, undefined);
    assert.equal(entry.dia, undefined);
  });
});
