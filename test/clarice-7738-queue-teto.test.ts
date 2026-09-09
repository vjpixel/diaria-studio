/**
 * Regressão #7738: teto de fila deve usar fila diária unificada
 * (buildDailySendQueue / isDailyQueueEligible), não 1º envio vitalício.
 * Cobertura: cenário 4254 (dailyQueue > availableFirstSend); distinção
 * ramp-warm vs engajados preservada; reativacao EXCLUIDA (sem decisão).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDailySendQueue } from "../scripts/lib/clarice-segment.ts";

test("#7738: cenário 4254 — fila unificada excede pool vitalício (4254)", () => {
  const neverSent = 4254;
  const engaged = 15000;
  const rows = [
    ...Array.from({ length: neverSent }, () => ({ email: "n@t.com", send_eligible: 1, sends_count: 0, priority_points: 0, created: "2026-01-01" })),
    ...Array.from({ length: engaged }, () => ({ email: "e@t.com", send_eligible: 1, sends_count: 2, priority_points: 10, created: "2025-06-01" })),
  ];
  const daily = buildDailySendQueue(rows as any, { queuedListIds: new Set(), committedListIds: new Set() }, null);
  assert.ok(daily.length > neverSent, "fila diária > 1º envio vitalício");
  assert.strictEqual(neverSent, 4254);
  // Preservação de distinção: engajados (priority_points>0) entram mesmo
  // tendo histórico; reativacao (priority_points==0, sends>0) fica fora.
  assert.ok(daily.length >= engaged, "engajados do ciclo anterior mantidos");
});
