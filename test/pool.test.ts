import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../scripts/lib/pool.ts";

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
