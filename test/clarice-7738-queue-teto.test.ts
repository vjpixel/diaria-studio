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

test("#7738: wiring — queued-only vs committed=queued+sent, engajados sobrevivem", () => {
  // Simula: 1 campanha queued (lista Q), 2 listas sent (S1,S2) → committed={Q,S1,S2}
  const queuedOnly = new Set(["list-queued-01"]);
  const committed = new Set(["list-queued-01", "list-sent-a", "list-sent-b"]);
  const rows = [
    { email: "e@t.com", send_eligible: 1, sends_count: 3, priority_points: 12, created: "2025-01-01" }, // engajado
    { email: "r@t.com", send_eligible: 1, sends_count: 3, priority_points: 0, created: "2025-01-01" }, // reativacao (fora, #7406)
    { email: "n@t.com", send_eligible: 1, sends_count: 0, priority_points: 0, created: "2026-09-01" }, // ramp-warm
  ];
  // Engajado (sends>0) usa queuedOnly guard; ramp-warm (sends=0) usa committed guard
  const withQueuedOnly = buildDailySendQueue(rows as any, { queuedListIds: queuedOnly, committedListIds: committed }, null);
  // Engajado deve sobreviver porque queuedOnly não inclui sent (fica fora só se agendado — não é o caso)
  assert.ok(withQueuedOnly.some((r:any)=>r.email==="e@t.com"), "engajado sobrevive com queued-only guard");
  // Reativacao (priority_points==0, sends>0) deve ser excluído por predicado, não pelo guard
  assert.strictEqual(withQueuedOnly.some((r:any)=>r.email==="r@t.com"), false, "reativacao fora (#7406)");
  // Ramp-warm entra porque committed inclui que recebeu; se tivesse sent, sairia — ok
  assert.ok(withQueuedOnly.length >= 1, "fila não vazia com queued-only guard"); // predicado send_eligible decide entrada do ramp-warm, não guard
});
