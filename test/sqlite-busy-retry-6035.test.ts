/**
 * test/sqlite-busy-retry-6035.test.ts (#6035)
 *
 * Regressão: `diaria-clarice-sync.service` saiu com "database is locked"
 * (SQLITE_BUSY) 32min após o início, mesmo com `PRAGMA busy_timeout` já
 * configurado — a transação concorrente segurou o lock por mais tempo do
 * que o driver esperava. `retryOnSqliteBusy` (`scripts/lib/sqlite-busy-retry.ts`)
 * dá uma 2ª chance no nível do aplicativo, só para esse tipo de erro, com
 * backoff FINITO — nunca infinito, decisão documentada no PR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSqliteBusyError,
  retryOnSqliteBusy,
  DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS,
} from "../scripts/lib/sqlite-busy-retry.ts";

// sleep fake — nunca aguarda o tempo real, só registra os delays pedidos.
function fakeSleep(log: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    log.push(ms);
  };
}

describe("isSqliteBusyError", () => {
  it("reconhece 'database is locked'", () => {
    assert.equal(isSqliteBusyError(new Error("database is locked")), true);
  });

  it("reconhece SQLITE_BUSY (case-insensitive)", () => {
    assert.equal(isSqliteBusyError(new Error("SQLITE_BUSY: something")), true);
    assert.equal(isSqliteBusyError(new Error("sqlite_busy")), true);
  });

  it("NÃO reconhece erro não relacionado a lock", () => {
    assert.equal(isSqliteBusyError(new Error("network timeout")), false);
    assert.equal(isSqliteBusyError(new Error("UNIQUE constraint failed")), false);
  });

  it("não lança sobre valor não-Error", () => {
    assert.equal(isSqliteBusyError("database is locked"), true);
    assert.equal(isSqliteBusyError(undefined), false);
  });
});

describe("retryOnSqliteBusy", () => {
  it("sucesso na 1ª tentativa: não espera, não chama onRetry", async () => {
    const delays: number[] = [];
    let onRetryCalls = 0;
    const result = await retryOnSqliteBusy(() => 42, {
      sleep: fakeSleep(delays),
      onRetry: () => onRetryCalls++,
    });
    assert.equal(result, 42);
    assert.deepEqual(delays, []);
    assert.equal(onRetryCalls, 0);
  });

  it("retry em erro de lock: tenta de novo e retorna o resultado do sucesso subsequente", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await retryOnSqliteBusy(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("database is locked");
        return "ok";
      },
      { sleep: fakeSleep(delays), delays: [10, 20, 30] },
    );
    assert.equal(result, "ok");
    assert.equal(attempts, 3);
    // 2 falhas → 2 esperas, com os 2 primeiros delays configurados, na ordem.
    assert.deepEqual(delays, [10, 20]);
  });

  it("respeita a lista de delays passada explicitamente (não sempre o default)", async () => {
    const delays: number[] = [];
    let attempts = 0;
    await retryOnSqliteBusy(
      () => {
        attempts++;
        if (attempts < 2) throw new Error("SQLITE_BUSY");
        return "ok";
      },
      { sleep: fakeSleep(delays), delays: [999] },
    );
    assert.deepEqual(delays, [999]);
  });

  it("erro que NÃO é de lock relança IMEDIATAMENTE, sem nenhum retry", async () => {
    const delays: number[] = [];
    let attempts = 0;
    await assert.rejects(
      () =>
        retryOnSqliteBusy(
          () => {
            attempts++;
            throw new Error("UNIQUE constraint failed: clarice_users.email");
          },
          { sleep: fakeSleep(delays) },
        ),
      /UNIQUE constraint failed/,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(delays, []);
  });

  it("esgotar os retries relança o erro de lock da ÚLTIMA tentativa — nunca retry infinito", async () => {
    const delays: number[] = [];
    let attempts = 0;
    await assert.rejects(
      () =>
        retryOnSqliteBusy(
          () => {
            attempts++;
            throw new Error(`database is locked (tentativa ${attempts})`);
          },
          { sleep: fakeSleep(delays), delays: [1, 2] },
        ),
      /tentativa 3/, // 1ª tentativa + 2 retries = 3 chamadas ao todo
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [1, 2]);
  });

  it("chama onRetry com {error, attemptIndex, delayMs} antes de cada espera", async () => {
    const calls: Array<{ attemptIndex: number; delayMs: number; message: string }> = [];
    let attempts = 0;
    await retryOnSqliteBusy(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("database is locked");
        return "ok";
      },
      {
        sleep: fakeSleep([]),
        delays: [5, 15],
        onRetry: ({ error, attemptIndex, delayMs }) =>
          calls.push({ attemptIndex, delayMs, message: error.message }),
      },
    );
    assert.deepEqual(calls, [
      { attemptIndex: 0, delayMs: 5, message: "database is locked" },
      { attemptIndex: 1, delayMs: 15, message: "database is locked" },
    ]);
  });

  it("default é finito (3 tentativas extras) — não é retry indefinido por default", () => {
    assert.deepEqual(DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS, [1000, 3000, 6000]);
  });

  it("funciona com attempt() assíncrono", async () => {
    let attempts = 0;
    const result = await retryOnSqliteBusy(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("database is locked");
        return "async-ok";
      },
      { sleep: fakeSleep([]) },
    );
    assert.equal(result, "async-ok");
    assert.equal(attempts, 2);
  });
});
