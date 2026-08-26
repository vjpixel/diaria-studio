/**
 * test/brevo-429-retry-budget-6035.test.ts (#6035, #5942)
 *
 * Regressão do achado ao vivo 24-25/08/2026 (#6124/#6132): a Brevo respondeu
 * 429 com `Retry-After: 3402` (~57min) no meio do catch-up de export de
 * campanhas (`.brevo-sync-daily.log` linha 12866) — a versão anterior de
 * `withBrevo429Retry` (scripts/lib/brevo-client.ts) ignorava esse número,
 * dormia o teto por-tentativa (30s) e retentava mesmo assim, garantidamente
 * fadada a repetir o mesmo 429 (rate limit é por CONTA/HORA — não se resolve
 * em 30s). Este teste NUNCA dorme de verdade — `_sleep` injetado é síncrono
 * e o teste falharia por timeout (não por lentidão) se o código tentasse
 * dormir os 3402s reais.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withBrevo429Retry, throwBrevo429, parseRetryAfterSecs } from "../scripts/lib/brevo-client.ts";

function fake429(headerValue: string | null): Response {
  return {
    status: 429,
    headers: { get: (h: string) => (h === "retry-after" ? headerValue : null) },
  } as unknown as Response;
}

describe("withBrevo429Retry — Retry-After excede o orçamento => desiste JÁ, sem dormir (#6035/#5942)", () => {
  it("Retry-After: 3402 (o valor REAL medido) => lança IMEDIATAMENTE, zero sleep, mensagem explícita", async () => {
    let sleepCalls = 0;
    let execCalls = 0;
    const neverSleep = async (_ms: number): Promise<void> => {
      sleepCalls++;
      throw new Error("NUNCA deveria dormir — Retry-After 3402s excede qualquer orçamento razoável de retry");
    };
    await assert.rejects(
      () =>
        withBrevo429Retry(async () => {
          execCalls++;
          throwBrevo429(fake429("3402"));
        }, neverSleep),
      /Retry-After 3402s excede o orçamento de \d+s.*desistindo agora/,
    );
    assert.equal(sleepCalls, 0, "não deve dormir nenhuma vez — desistência é IMEDIATA");
    assert.equal(execCalls, 1, "só 1 tentativa — nenhuma re-tentativa garantidamente inútil");
  });

  it("Retry-After dentro do orçamento (ex: 5s) => ainda respeita o header e retenta normalmente", async () => {
    const sleeps: number[] = [];
    const captureSleep = async (ms: number): Promise<void> => { sleeps.push(ms); };
    let calls = 0;
    const result = await withBrevo429Retry(async () => {
      calls++;
      if (calls === 1) throwBrevo429(fake429("5"));
      return "ok";
    }, captureSleep);
    assert.equal(result, "ok");
    assert.deepEqual(sleeps, [5000], "Retry-After de 5s cabe no orçamento — dorme o valor pedido, não desiste");
    assert.equal(calls, 2);
  });

  it("Retry-After ausente (header null) => comportamento anterior preservado (fallback, sem desistência prematura)", async () => {
    const sleeps: number[] = [];
    const captureSleep = async (ms: number): Promise<void> => { sleeps.push(ms); };
    let calls = 0;
    await assert.rejects(
      () =>
        withBrevo429Retry(async () => {
          calls++;
          throwBrevo429(fake429(null));
        }, captureSleep),
      /Brevo API 429 após 3 tentativas/,
    );
    assert.equal(calls, 3, "esgota as 3 tentativas normais quando não há Retry-After pra avaliar orçamento");
    assert.equal(sleeps.length, 2, "dorme entre as 3 tentativas (2 esperas)");
  });
});

describe("parseRetryAfterSecs (#6035) — extração UNCAPPED (sem aplicar MAX_WAIT_MS)", () => {
  it("retry-after: 3402 => retorna 3402 (não capado a 30)", () => {
    const headers = { get: (h: string) => (h === "retry-after" ? "3402" : null) } as unknown as Headers;
    assert.equal(parseRetryAfterSecs(headers), 3402);
  });

  it("sem headers relevantes => null", () => {
    const headers = { get: () => null } as unknown as Headers;
    assert.equal(parseRetryAfterSecs(headers), null);
  });
});
