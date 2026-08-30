/**
 * test/run-tests.test.ts (#6495)
 *
 * Cobre o wrapper de descoberta explícita de `scripts/run-tests.ts`: batching
 * puro (`chunk`) e a agregação de exit code em `runTestBatches` (com
 * `spawn` injetado — nunca dispara um `node --test` real dentro do teste).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunk, runTestBatches, shouldRetryBatch, parseFailCount, BATCH_SIZE } from "../scripts/run-tests.ts";

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
      spawn: (() => ({ status: 0 })) as unknown as typeof import("node:child_process").spawnSync,
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
      spawn: (() => ({ status: 0 })) as unknown as typeof import("node:child_process").spawnSync,
    });
    assert.equal(exit, 0);
  });
});

// --- retry de ERR_MODULE_NOT_FOUND (#6495) --------------------------------

describe("parseFailCount (#6495)", () => {
  it("reconhece o sumário do reporter spec (prefixo ℹ, local/TTY)", () => {
    const output = "ℹ tests 5\nℹ pass 5\nℹ fail 0\nℹ duration_ms 12\n";
    assert.equal(parseFailCount(output), 0);
  });

  it("reconhece o sumário do reporter tap (prefixo #, CI/sem TTY)", () => {
    const output = "# tests 5\n# pass 4\n# fail 1\n";
    assert.equal(parseFailCount(output), 1);
  });

  it("pega a ÚLTIMA ocorrência (nunca uma linha de teste cujo NOME contenha 'fail')", () => {
    const output = "ℹ fail em algum outro lugar não deveria casar\nℹ tests 3\nℹ fail 0\n";
    assert.equal(parseFailCount(output), 0);
  });

  it("nenhum sumário reconhecível → null (não sei, nunca assume fail 0)", () => {
    assert.equal(parseFailCount("output qualquer sem sumário do node:test"), null);
  });
});

describe("shouldRetryBatch (#6495) — os 3 critérios precisam bater", () => {
  const ERR = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/repo/test/foo.test.ts'";

  it("status != 0 + ERR_MODULE_NOT_FOUND + fail 0 → retry", () => {
    const output = `${ERR}\nℹ fail 0\n`;
    assert.equal(shouldRetryBatch(output, 1), true);
  });

  it("status 0 (sucesso) → nunca retry, mesmo com o texto do erro presente em algum log", () => {
    const output = `${ERR}\nℹ fail 0\n`;
    assert.equal(shouldRetryBatch(output, 0), false);
  });

  it("falha SEM ERR_MODULE_NOT_FOUND → nunca retry (falha comum de teste)", () => {
    const output = "AssertionError: expected true to be false\nℹ fail 1\n";
    assert.equal(shouldRetryBatch(output, 1), false);
  });

  it("ERR_MODULE_NOT_FOUND presente mas fail > 0 (falha de teste REAL também no batch) → nunca retry", () => {
    const output = `${ERR}\nℹ fail 2\n`;
    assert.equal(shouldRetryBatch(output, 1), false, "não mascarar falha de teste real como infra");
  });

  it("ERR_MODULE_NOT_FOUND presente mas sumário ilegível (fail count desconhecido) → nunca retry", () => {
    const output = `${ERR}\nsem linha de sumário reconhecível\n`;
    assert.equal(shouldRetryBatch(output, 1), false);
  });
});

describe("runTestBatches — retry automático (#6495)", () => {
  const ERR_OUTPUT = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/repo/test/foo.test.ts'\nℹ fail 0\n";

  it("1ª tentativa bate a assinatura do #6495, 2ª tentativa (retry) passa → exit 0, spawn chamado 2×", () => {
    let calls = 0;
    const exit = runTestBatches({
      files: ["/a.test.ts"],
      spawn: (() => {
        calls++;
        if (calls === 1) return { status: 1, stdout: ERR_OUTPUT, stderr: "" };
        return { status: 0, stdout: "ℹ fail 0\n", stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.equal(exit, 0, "retry passou → exit agregado deve ser 0");
    assert.equal(calls, 2, "spawn deve ter sido chamado 2× (tentativa original + 1 retry)");
  });

  it("retry TAMBÉM falha → conta como falha definitiva, exit 1, só 1 retry (nunca 2+)", () => {
    let calls = 0;
    const exit = runTestBatches({
      files: ["/a.test.ts"],
      spawn: (() => {
        calls++;
        return { status: 1, stdout: ERR_OUTPUT, stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.equal(exit, 1);
    assert.equal(calls, 2, "exatamente 1 retry — nunca insiste indefinidamente");
  });

  it("falha comum (sem ERR_MODULE_NOT_FOUND) → NUNCA retry, spawn chamado só 1×", () => {
    let calls = 0;
    const exit = runTestBatches({
      files: ["/a.test.ts"],
      spawn: (() => {
        calls++;
        return { status: 1, stdout: "AssertionError: boom\nℹ fail 1\n", stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.equal(exit, 1);
    assert.equal(calls, 1, "falha de teste real nunca dispara retry");
  });

  it("output capturado (stdout/stderr do batch) é repassado ao sink injetado — visibilidade preservada", () => {
    const written: string[] = [];
    runTestBatches({
      files: ["/a.test.ts"],
      spawn: (() => ({
        status: 0,
        stdout: "conteudo do stdout do batch\n",
        stderr: "conteudo do stderr do batch\n",
      })) as unknown as typeof import("node:child_process").spawnSync,
      stdout: { write: (s: string) => written.push(`OUT:${s}`) },
      stderr: { write: (s: string) => written.push(`ERR:${s}`) },
    });
    assert.ok(written.some((s) => s.includes("conteudo do stdout do batch")));
    assert.ok(written.some((s) => s.includes("conteudo do stderr do batch")));
  });

  it("multi-batch com 1 retry no meio: todos os batches ainda rodam até o fim", () => {
    const seen: number[] = [];
    let attemptForBatch2 = 0;
    const exit = runTestBatches({
      files: ["/a.test.ts", "/b.test.ts"],
      batchSize: 1,
      spawn: ((_cmd, args) => {
        const file = (args as string[]).slice(3)[0];
        seen.push(file === "/a.test.ts" ? 1 : 2);
        if (file === "/b.test.ts") {
          attemptForBatch2++;
          if (attemptForBatch2 === 1) return { status: 1, stdout: ERR_OUTPUT, stderr: "" };
          return { status: 0, stdout: "ℹ fail 0\n", stderr: "" };
        }
        return { status: 0, stdout: "ℹ fail 0\n", stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.equal(exit, 0);
    assert.equal(attemptForBatch2, 2, "batch 2 rodou original + retry");
    assert.deepEqual(seen, [1, 2, 2], "batch 1 rodou 1×, batch 2 rodou 2× (original + retry)");
  });
});
