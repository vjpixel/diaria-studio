/**
 * test/tmp-disk-alarm.test.ts (#8828)
 *
 * Cobre o miolo puro (`scripts/lib/tmp-disk-alarm.ts`) — nenhum I/O de
 * disco real (`statfsSync` fica no wrapper `scripts/tmp-disk-alarm.ts`,
 * não testado aqui por chamar o filesystem real da máquina).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TMP_DISK_ALARM_THRESHOLD_PCT,
  evaluateTmpDiskAlarm,
  blocksToGiB,
  TMP_DISK_ALARM_FINDING_KEY,
} from "../scripts/lib/tmp-disk-alarm.ts";

describe("DEFAULT_TMP_DISK_ALARM_THRESHOLD_PCT (#8828)", () => {
  it("é 0.80 (80%) — valor sugerido pela issue #8828", () => {
    assert.equal(DEFAULT_TMP_DISK_ALARM_THRESHOLD_PCT, 0.8);
  });
});

describe("evaluateTmpDiskAlarm", () => {
  it("65% de ocupação (medido ao vivo 25/09/2026, 9,8GB de 15GB) → NÃO triggered", () => {
    const ev = evaluateTmpDiskAlarm({ totalBlocks: 1000, availableBlocks: 350 });
    assert.equal(ev.occupancyPct, 0.65);
    assert.equal(ev.triggered, false);
  });

  it("exatamente 80% → triggered (inclusivo)", () => {
    const ev = evaluateTmpDiskAlarm({ totalBlocks: 1000, availableBlocks: 200 });
    assert.equal(ev.occupancyPct, 0.8);
    assert.equal(ev.triggered, true);
  });

  it("79.9% → NÃO triggered", () => {
    const ev = evaluateTmpDiskAlarm({ totalBlocks: 1000, availableBlocks: 201 });
    assert.equal(ev.triggered, false);
  });

  it("100% ocupado (availableBlocks=0, o cenário do EDQUOT de 25/09/2026) → triggered", () => {
    const ev = evaluateTmpDiskAlarm({ totalBlocks: 1000, availableBlocks: 0 });
    assert.equal(ev.occupancyPct, 1);
    assert.equal(ev.triggered, true);
  });

  it("totalBlocks <= 0 (leitura inválida) → occupancyPct=0, nunca triggered (nunca NaN)", () => {
    const ev = evaluateTmpDiskAlarm({ totalBlocks: 0, availableBlocks: 0 });
    assert.equal(ev.occupancyPct, 0);
    assert.equal(ev.triggered, false);
    assert.equal(Number.isNaN(ev.occupancyPct), false);
  });

  it("threshold custom é respeitado", () => {
    const ev = evaluateTmpDiskAlarm({ totalBlocks: 1000, availableBlocks: 400 }, 0.5);
    assert.equal(ev.occupancyPct, 0.6);
    assert.equal(ev.triggered, true);
  });

  it("usedBlocks nunca negativo mesmo se availableBlocks > totalBlocks (dado inconsistente)", () => {
    const ev = evaluateTmpDiskAlarm({ totalBlocks: 1000, availableBlocks: 1500 });
    assert.equal(ev.usedBlocks, 0);
  });
});

describe("blocksToGiB", () => {
  it("converte blocos + tamanho de bloco pra GiB", () => {
    // 15 GiB de tmpfs em blocos de 4096 bytes.
    const totalBytes = 15 * 1024 * 1024 * 1024;
    const blockSize = 4096;
    const blocks = totalBytes / blockSize;
    assert.ok(Math.abs(blocksToGiB(blocks, blockSize) - 15) < 0.001);
  });
});

describe("TMP_DISK_ALARM_FINDING_KEY", () => {
  it("é uma chave estável não-vazia", () => {
    assert.equal(TMP_DISK_ALARM_FINDING_KEY, "tmp-disk-alarm");
  });
});
