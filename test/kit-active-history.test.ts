/**
 * test/kit-active-history.test.ts (#7916, fatia 3/N)
 *
 * Cobre `scripts/lib/metrics/kit-active-history.ts`: derivação BRT do
 * `dia`, tolerância a linha corrompida, e resolução "última linha do dia
 * vence" pra `findKitActiveCountForDay` — sem `0` fabricado quando o dia
 * não tem nenhuma entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildKitActiveHistoryEntry,
  serializeKitActiveHistoryEntry,
  parseKitActiveHistoryLines,
  findKitActiveCountForDay,
  type KitActiveHistoryEntry,
} from "../scripts/lib/metrics/kit-active-history.ts";

describe("buildKitActiveHistoryEntry", () => {
  it("deriva `dia` em BRT a partir de captured_at (madrugada UTC não vaza pro dia seguinte)", () => {
    // 2026-09-01T02:00:00Z = 2026-08-31T23:00:00 BRT (UTC-3) — ainda dia 31.
    const entry = buildKitActiveHistoryEntry({ capturedAt: "2026-09-01T02:00:00.000Z", count: 10, asOf: "2026-08-31T22:00:00.000Z" });
    assert.equal(entry.dia, "2026-08-31");
    assert.equal(entry.count, 10);
    assert.equal(entry.asOf, "2026-08-31T22:00:00.000Z");
    assert.equal(entry.captured_at, "2026-09-01T02:00:00.000Z");
  });

  it("meio-dia UTC cai no mesmo dia BRT", () => {
    const entry = buildKitActiveHistoryEntry({ capturedAt: "2026-09-01T15:00:00.000Z", count: 5, asOf: null });
    assert.equal(entry.dia, "2026-09-01");
  });

  it("count=0 preserva asOf=null (nunca inventa timestamp)", () => {
    const entry = buildKitActiveHistoryEntry({ capturedAt: "2026-09-01T15:00:00.000Z", count: 0, asOf: null });
    assert.equal(entry.count, 0);
    assert.equal(entry.asOf, null);
  });

  it("capturedAt inválido lança em vez de gravar dia: 'Invalid Date' em silêncio", () => {
    assert.throws(() => buildKitActiveHistoryEntry({ capturedAt: "not-a-date", count: 1, asOf: null }));
  });
});

describe("serializeKitActiveHistoryEntry + parseKitActiveHistoryLines", () => {
  it("round-trip: serializa e reparseia sem perda", () => {
    const entry = buildKitActiveHistoryEntry({ capturedAt: "2026-09-01T15:00:00.000Z", count: 7, asOf: "2026-09-01T14:00:00.000Z" });
    const line = serializeKitActiveHistoryEntry(entry);
    const parsed = parseKitActiveHistoryLines(line);
    assert.deepEqual(parsed, [entry]);
  });

  it("ignora linhas em branco e linhas corrompidas, sem lançar", () => {
    const good = buildKitActiveHistoryEntry({ capturedAt: "2026-09-01T15:00:00.000Z", count: 3, asOf: null });
    const raw = [
      "",
      "  ",
      "{not valid json",
      JSON.stringify({ dia: "2026-09-01" }), // faltam campos obrigatórios
      serializeKitActiveHistoryEntry(good).trim(),
    ].join("\n");
    const parsed = parseKitActiveHistoryLines(raw);
    assert.deepEqual(parsed, [good]);
  });
});

describe("findKitActiveCountForDay", () => {
  const entries: KitActiveHistoryEntry[] = [
    { dia: "2026-09-01", captured_at: "2026-09-01T09:00:00.000Z", count: 10, asOf: "2026-09-01T08:00:00.000Z" },
    { dia: "2026-09-02", captured_at: "2026-09-02T09:00:00.000Z", count: 12, asOf: "2026-09-02T08:00:00.000Z" },
    // 2ª execução no mesmo dia 09-02 — deve vencer sobre a 1ª (mais recente = mais atualizada).
    { dia: "2026-09-02", captured_at: "2026-09-02T18:00:00.000Z", count: 13, asOf: "2026-09-02T17:00:00.000Z" },
  ];

  it("resolve pela ÚLTIMA linha do dia quando há múltiplas execuções no mesmo dia", () => {
    assert.equal(findKitActiveCountForDay(entries, "2026-09-02"), 13);
  });

  it("resolve corretamente um dia com 1 única linha", () => {
    assert.equal(findKitActiveCountForDay(entries, "2026-09-01"), 10);
  });

  it("dia sem nenhuma entry devolve null — nunca 0 fabricado", () => {
    assert.equal(findKitActiveCountForDay(entries, "2026-08-31"), null);
    assert.equal(findKitActiveCountForDay([], "2026-09-01"), null);
  });
});
