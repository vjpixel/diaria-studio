/**
 * test/clarice-check-semaphore-4347.test.ts (#4347 Etapa 4, D4)
 *
 * Guard de semáforo da skill /diaria-clarice-novos — decisão pura sobre o
 * resultado de `deriveRampVolumes` (já testado em test/clarice-schedule-ramp.test.ts;
 * aqui só a política "vermelho aborta, resto passa").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSemaphoreGuard } from "../scripts/clarice-check-semaphore.ts";

test("decideSemaphoreGuard: semáforo 'red' -> ok=false (aborta)", () => {
  const result = decideSemaphoreGuard({ ok: true, plan: { volumes: [10, 10, 10], semaphore: "red", flagged: [], baseVolume: 30 } });
  assert.equal(result.ok, false);
  assert.equal(result.semaphore, "red");
});

test("decideSemaphoreGuard: semáforo 'yellow' -> ok=true (passa)", () => {
  const result = decideSemaphoreGuard({ ok: true, plan: { volumes: [10, 10, 10], semaphore: "yellow", flagged: [], baseVolume: 30 } });
  assert.equal(result.ok, true);
  assert.equal(result.semaphore, "yellow");
});

test("decideSemaphoreGuard: semáforo 'green' -> ok=true (passa)", () => {
  const result = decideSemaphoreGuard({ ok: true, plan: { volumes: [10, 10, 10], semaphore: "green", flagged: [], baseVolume: 30 } });
  assert.equal(result.ok, true);
  assert.equal(result.semaphore, "green");
});

test("decideSemaphoreGuard: deriveRampVolumes indeterminado (ok:false) -> passa com aviso, NÃO é 'red'", () => {
  const result = decideSemaphoreGuard({ ok: false, reason: "Nenhum envio maduro (>48h) ainda." });
  assert.equal(result.ok, true);
  assert.equal(result.semaphore, "indeterminate");
  assert.match(result.reason ?? "", /maduro/);
});
