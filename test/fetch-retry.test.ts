/**
 * test/fetch-retry.test.ts (#5973)
 *
 * Unit direto de `scripts/lib/fetch-retry.ts` — o motor de retry+timeout
 * extraído de `scripts/seo-index-check.ts` depois do #5943 (blip de rede
 * de UMA requisição derrubando a `diaria-seo-weekly.service` inteira).
 * Cobre exatamente os 3 cenários exigidos pela issue: falha N-1 vezes e
 * sucede na última (exit 0 no caller), falha em todas as N (exit 1 no
 * caller), e 404 falhando já na 1ª tentativa sem gastar retry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../scripts/lib/fetch-retry.ts";

function okResponse(): Response {
  return new Response("ok", { status: 200 });
}

function statusResponse(status: number): Response {
  return new Response("", { status });
}

/** Sleep injetável que nunca espera de verdade — só registra as chamadas. */
function fakeSleep(sleeps: number[]): (ms: number) => Promise<void> {
  return (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
}

describe("fetchWithRetry (#5973)", () => {
  it("sucesso na 1ª tentativa => nem retenta nem dorme", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const res = await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(okResponse());
      },
      { sleep: fakeSleep(sleeps) },
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(res.ok, true);
  });

  it("falha de rede N-1 vezes e sucede na última => retorna ok, sem relançar (caller conclui exit 0)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const res = await fetchWithRetry(
      () => {
        calls++;
        if (calls < 3) return Promise.reject(new Error("fetch failed"));
        return Promise.resolve(okResponse());
      },
      { attempts: 3, sleep: fakeSleep(sleeps) },
    );
    assert.equal(calls, 3);
    assert.equal(res.ok, true);
    // 2 esperas (antes da 2ª e da 3ª tentativa), respeitando o backoff default.
    assert.deepEqual(sleeps, [1000, 3000]);
  });

  it("falha de rede em TODAS as N tentativas => relança na última (caller conclui exit 1)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await assert.rejects(
      () =>
        fetchWithRetry(
          () => {
            calls++;
            return Promise.reject(new Error("fetch failed"));
          },
          { attempts: 3, sleep: fakeSleep(sleeps) },
        ),
      /fetch failed/,
    );
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [1000, 3000]);
  });

  it("404 falha já na 1ª tentativa, SEM gastar retry (4xx não é retriável)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const res = await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(statusResponse(404));
      },
      { attempts: 3, sleep: fakeSleep(sleeps) },
    );
    assert.equal(calls, 1);
    assert.equal(res.status, 404);
    assert.deepEqual(sleeps, []);
  });

  it("5xx persistente esgota as tentativas e retorna a última resposta (não lança)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const res = await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(statusResponse(503));
      },
      { attempts: 3, sleep: fakeSleep(sleeps) },
    );
    assert.equal(calls, 3);
    assert.equal(res.status, 503);
    assert.deepEqual(sleeps, [1000, 3000]);
  });

  it("5xx seguido de sucesso => retorna ok assim que a tentativa passar", async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(calls === 1 ? statusResponse(502) : okResponse());
      },
      { attempts: 3, sleep: fakeSleep([]) },
    );
    assert.equal(calls, 2);
    assert.equal(res.ok, true);
  });

  it("repassa o AbortSignal da tentativa atual pro doFetch", async () => {
    const signals: AbortSignal[] = [];
    await fetchWithRetry(
      (signal) => {
        signals.push(signal);
        return Promise.resolve(okResponse());
      },
      { sleep: fakeSleep([]) },
    );
    assert.equal(signals.length, 1);
    assert.equal(signals[0] instanceof AbortSignal, true);
  });

  it("isRetriableStatus customizado é respeitado (ex: 429 tratado como retriável)", async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(calls === 1 ? statusResponse(429) : okResponse());
      },
      { attempts: 3, sleep: fakeSleep([]), isRetriableStatus: (s) => s === 429 || s >= 500 },
    );
    assert.equal(calls, 2);
    assert.equal(res.ok, true);
  });

  it("attempts < 1 lança erro de configuração explícito, nunca o 'inalcançável' genérico (achado do fleet review)", async () => {
    await assert.rejects(() => fetchWithRetry(() => Promise.resolve(okResponse()), { attempts: 0 }), /attempts precisa ser >= 1/);
    await assert.rejects(() => fetchWithRetry(() => Promise.resolve(okResponse()), { attempts: -1 }), /attempts precisa ser >= 1/);
  });

  it("resposta retriável descartada drena/cancela o corpo antes de retentar (achado do fleet review: vazamento de conexão)", async () => {
    let canceled = 0;
    function retriableResponseWithTrackedBody(): Response {
      const res = statusResponse(503);
      const origCancel = res.body!.cancel.bind(res.body);
      res.body!.cancel = ((reason?: unknown) => {
        canceled++;
        return origCancel(reason);
      }) as typeof res.body.cancel;
      return res;
    }
    let calls = 0;
    const res = await fetchWithRetry(
      () => {
        calls++;
        return Promise.resolve(calls === 1 ? retriableResponseWithTrackedBody() : okResponse());
      },
      { attempts: 3, sleep: fakeSleep([]) },
    );
    assert.equal(calls, 2);
    assert.equal(res.ok, true);
    assert.equal(canceled, 1, "a resposta 503 descartada na 1ª tentativa deve ter o corpo cancelado");
  });

  it("erro final relançado carrega contexto (tentativas + timeoutMs), não só a mensagem original (achado do fleet review)", async () => {
    await assert.rejects(
      () =>
        fetchWithRetry(() => Promise.reject(new Error("fetch failed")), {
          attempts: 2,
          timeoutMs: 5000,
          sleep: fakeSleep([]),
        }),
      (err: Error) => {
        assert.match(err.message, /falhou após 2 tentativa\(s\)/);
        assert.match(err.message, /timeoutMs=5000/);
        assert.match(err.message, /fetch failed/);
        assert.equal((err as Error & { cause?: unknown }).cause instanceof Error, true);
        return true;
      },
    );
  });
});
