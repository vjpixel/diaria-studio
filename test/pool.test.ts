import { test } from "node:test";
import assert from "node:assert/strict";
import { pool, poolAbortOnError } from "../scripts/lib/pool.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

test("pool: processa todos os itens exatamente uma vez", async () => {
  const seen: number[] = [];
  await pool([1, 2, 3, 4, 5], 2, async (x) => {
    await tick();
    seen.push(x);
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("pool: nunca excede o cap de concorrência", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await pool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick();
    inFlight--;
  });
  assert.ok(maxInFlight <= 4, `maxInFlight=${maxInFlight} deveria ser <= 4`);
  assert.ok(maxInFlight > 1, "deveria rodar concorrente (>1)");
});

test("pool: lista vazia → não lança, não chama o worker", async () => {
  let calls = 0;
  await pool([], 4, async () => {
    calls++;
  });
  assert.equal(calls, 0);
});

test("pool: concorrência maior que itens não quebra", async () => {
  const seen: number[] = [];
  await pool([1, 2], 10, async (x) => {
    seen.push(x);
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2]);
});

// #8091: poolAbortOnError — extraída de clarice-engagement-cohorts.ts pra
// lib/pool.ts, agora reusada também por clarice-sync-brevo.ts (flush() com
// retry contra SQLite lock).

test("poolAbortOnError: processa todos os itens quando nenhum falha", async () => {
  const seen: number[] = [];
  await poolAbortOnError([1, 2, 3, 4, 5], 2, async (x) => {
    await tick();
    seen.push(x);
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("poolAbortOnError: lista vazia → não lança, não chama o worker", async () => {
  let calls = 0;
  await poolAbortOnError([], 4, async () => {
    calls++;
  });
  assert.equal(calls, 0);
});

test("poolAbortOnError: propaga o erro original de um worker que falha", async () => {
  await assert.rejects(
    poolAbortOnError([1, 2, 3], 3, async (x) => {
      if (x === 2) throw new Error("boom");
    }),
    /boom/,
  );
});

// Cenário concreto da issue #8091: concurrency > 1, uma lane falha
// (simulando contenção SUSTENTADA de lock — o retry finito do chamador real
// já esgotou e relançou), e as OUTRAS lanes precisam parar de consumir a
// fila em vez de continuar processando itens de um run já fadado a abortar.
test("poolAbortOnError: concurrency > 1, uma lane falha → aborta as demais (não processa a fila inteira)", async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const processed: number[] = [];
  let unhandled: unknown = null;
  const onUnhandled = (err: unknown) => {
    unhandled = err;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      poolAbortOnError(items, 4, async (x) => {
        // item 5 simula o flush() que esgotou o retry contra SQLite lock e
        // relança o erro original — as demais lanes (0-4, 6-9, ...) devem
        // parar de puxar itens novos assim que isso acontece.
        if (x === 5) {
          await tick();
          throw new Error("database is locked — retries esgotados");
        }
        await tick();
        processed.push(x);
      }),
      /database is locked/,
    );
    // dá tempo pro event loop assentar qualquer rejeição pendente das outras
    // lanes antes de checar o listener de unhandledRejection.
    await tick();
    await tick();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled, null, "nenhuma lane deveria rejeitar sem handler (unhandledRejection)");
  // abort real: a fila de 20 itens não foi processada inteira — as lanes
  // pararam de puxar itens novos assim que `aborted` virou true.
  assert.ok(
    processed.length < items.length - 1,
    `processed.length=${processed.length} deveria ser bem menor que ${items.length} (abort deveria ter cortado a fila)`,
  );
});
