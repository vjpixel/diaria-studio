/**
 * test/clarice-check-semaphore-4347.test.ts (#4347 Etapa 4, D4)
 *
 * Guard de semáforo da skill /diaria-clarice-novos — decisão pura sobre o
 * resultado de `deriveRampVolumes` (já testado em test/clarice-schedule-ramp.test.ts;
 * aqui só a política "vermelho aborta, resto passa").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSemaphoreGuard, checkSemaphore } from "../scripts/clarice-check-semaphore.ts";

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

// ---------------------------------------------------------------------------
// checkSemaphore — GET falhou (não-2xx) é categoria DIFERENTE de
// "indeterminado": trata como falha (lança), não como "seguro prosseguir".
// Simetria com erro de rede (fetch rejeitado), que já propagava como exceção.
// ---------------------------------------------------------------------------

test("REGRESSÃO (#4347): checkSemaphore com GET não-2xx (5xx) LANÇA — não degrada pra indeterminate/passa", async () => {
  const fetchImpl = (async () =>
    new Response("erro interno", { status: 500 })) as typeof fetch;
  await assert.rejects(() => checkSemaphore("https://fake-dashboard", 50, fetchImpl), /falhou \(500\)/);
});

test("checkSemaphore: erro de rede (fetch rejeita) também propaga (simétrico com o 5xx acima)", async () => {
  const fetchImpl = (async () => { throw new Error("network down"); }) as typeof fetch;
  await assert.rejects(() => checkSemaphore("https://fake-dashboard", 50, fetchImpl), /network down/);
});

test("checkSemaphore: GET 2xx bem-formado mas sem envio maduro -> indeterminate/passa (não lança)", async () => {
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/campaigns")) return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(null), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const result = await checkSemaphore("https://fake-dashboard", 50, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.semaphore, "indeterminate");
});
