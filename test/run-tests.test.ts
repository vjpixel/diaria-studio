/**
 * test/run-tests.test.ts (#6495)
 *
 * Cobre o wrapper de descoberta explícita de `scripts/run-tests.ts`: batching
 * puro (`chunk`) e a agregação de exit code em `runTestBatches` (com
 * `spawn` injetado — nunca dispara um `node --test` real dentro do teste).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunk, runTestBatches, BATCH_SIZE } from "../scripts/run-tests.ts";

describe("chunk (#6495)", () => {
  it("parte em batches do tamanho pedido, último batch menor sobra", () => {
    const items = Array.from({ length: 7 }, (_, i) => i);
    assert.deepEqual(chunk(items, 3), [
      [0, 1, 2],
      [3, 4, 5],
      [6],
    ]);
  });

  it("lista vazia produz zero batches", () => {
    assert.deepEqual(chunk([], 10), []);
  });

  it("size maior que a lista produz 1 batch só", () => {
    assert.deepEqual(chunk([1, 2], 100), [[1, 2]]);
  });

  it("size <= 0 lança (guard contra loop infinito)", () => {
    assert.throws(() => chunk([1], 0), /size deve ser > 0/);
    assert.throws(() => chunk([1], -1), /size deve ser > 0/);
  });

  it("BATCH_SIZE é positivo e finito (sanity do valor exportado)", () => {
    assert.ok(BATCH_SIZE > 0 && Number.isFinite(BATCH_SIZE));
  });
});

describe("runTestBatches (#6495) — spawn injetado, nunca roda node --test real", () => {
  it("lista vazia: retorna 0 sem chamar spawn (guard anti-vacuidade é o pretest, não este wrapper)", () => {
    let calls = 0;
    const exit = runTestBatches({
      files: [],
      spawn: (() => {
        calls++;
        return { status: 0 } as ReturnType<typeof import("node:child_process").spawnSync>;
      }) as typeof import("node:child_process").spawnSync,
    });
    assert.equal(exit, 0);
    assert.equal(calls, 0);
  });

  it("1 batch, spawn retorna status 0 → exit 0", () => {
    const exit = runTestBatches({
      files: ["/a.test.ts", "/b.test.ts"],
      batchSize: 10,
      spawn: (() => ({ status: 0 })) as typeof import("node:child_process").spawnSync,
    });
    assert.equal(exit, 0);
  });

  it("2 batches, 1º falha e 2º passa → exit agregado 1, AMBOS batches rodam (nunca aborta cedo)", () => {
    const seenBatches: number[][] = [];
    const exit = runTestBatches({
      files: [1, 2, 3, 4] as unknown as string[],
      batchSize: 2,
      spawn: ((_cmd, args) => {
        const batch = (args as string[]).slice(3); // pula --import tsx --test
        seenBatches.push(batch.map(Number));
        const status = Number(batch[0]) === 1 ? 1 : 0;
        return { status } as ReturnType<typeof import("node:child_process").spawnSync>;
      }) as typeof import("node:child_process").spawnSync,
    });
    assert.equal(exit, 1, "1 batch falhou → agregado deve ser 1");
    assert.equal(seenBatches.length, 2, "os 2 batches devem ter rodado, mesmo após o 1º falhar");
  });

  it("spawn retorna result.error (falha de spawn, não do teste) → tratado como falha, sem lançar", () => {
    const exit = runTestBatches({
      files: ["/a.test.ts"],
      spawn: (() => ({ error: new Error("ENOENT: spawn boom"), status: null })) as unknown as typeof import(
        "node:child_process"
      ).spawnSync,
    });
    assert.equal(exit, 1);
  });

  it("args extras (--test-name-pattern) são repassados a cada batch", () => {
    const invocations: string[][] = [];
    runTestBatches({
      files: ["/a.test.ts", "/b.test.ts", "/c.test.ts"],
      batchSize: 1,
      extraArgs: ["--test-name-pattern", "foo"],
      spawn: ((_cmd, args) => {
        invocations.push(args as string[]);
        return { status: 0 } as ReturnType<typeof import("node:child_process").spawnSync>;
      }) as typeof import("node:child_process").spawnSync,
    });
    assert.equal(invocations.length, 3);
    for (const args of invocations) {
      assert.deepEqual(args.slice(0, 3), ["--import", "tsx", "--test"]);
      assert.ok(args.includes("--test-name-pattern"));
      assert.ok(args.includes("foo"));
    }
  });

  it("todos os batches passam → exit 0", () => {
    const exit = runTestBatches({
      files: ["/a.test.ts", "/b.test.ts", "/c.test.ts", "/d.test.ts"],
      batchSize: 2,
      spawn: (() => ({ status: 0 })) as typeof import("node:child_process").spawnSync,
    });
    assert.equal(exit, 0);
  });
});
