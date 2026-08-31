/**
 * test/run-tests.test.ts (#6495)
 *
 * Cobre o wrapper de descoberta explícita de `scripts/run-tests.ts`: batching
 * puro (`chunk`) e a agregação de exit code em `runTestBatches` (com
 * `spawn` injetado — nunca dispara um `node --test` real dentro do teste).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunk,
  runTestBatches,
  shouldRetryBatch,
  parseFailCount,
  hasTestSummary,
  bisectHangingBatch,
  formatBisectResult,
  BATCH_SIZE,
  DEFAULT_BATCH_TIMEOUT_MS,
} from "../scripts/run-tests.ts";

/** Sumário mínimo válido do node:test (reporter tap, o default sem TTY —
 *  mas `parseFailCount`/`hasTestSummary` reconhecem os dois prefixos). Os
 *  testes que simulam um batch "passando de verdade" (#6822: um `status: 0`
 *  sozinho não basta mais) usam esta constante para não duplicar a string
 *  em cada mock. */
const OK_SUMMARY = "# tests 1\n# pass 1\n# fail 0\n";

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

  it("1 batch, spawn retorna status 0 + sumário válido → exit 0", () => {
    const exit = runTestBatches({
      files: ["/a.test.ts", "/b.test.ts"],
      batchSize: 10,
      spawn: (() => ({ status: 0, stdout: OK_SUMMARY, stderr: "" })) as unknown as typeof import(
        "node:child_process"
      ).spawnSync,
    });
    assert.equal(exit, 0);
  });

  it("2 batches, 1º falha e 2º passa → exit agregado 1, AMBOS batches rodam (nunca aborta cedo)", () => {
    const seenBatches: number[][] = [];
    const exit = runTestBatches({
      files: [1, 2, 3, 4] as unknown as string[],
      batchSize: 2,
      // Mock deliberadamente sem sumário do node:test — este teste exerce
      // "status != 0 é sempre falha", não a bisecção do #6822 Defeito B.
      // bisectBudgetMs:0 evita que a ausência de sumário (também presente
      // no batch que "passa" aqui) dispare spawns extras e infle a contagem
      // que este teste mede.
      bisectBudgetMs: 0,
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
      // Mock sem sumário do node:test — este teste exerce só o repasse de
      // extraArgs, não a bisecção do #6822 Defeito B.
      bisectBudgetMs: 0,
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

  it("todos os batches passam (com sumário válido) → exit 0", () => {
    const exit = runTestBatches({
      files: ["/a.test.ts", "/b.test.ts", "/c.test.ts", "/d.test.ts"],
      batchSize: 2,
      spawn: (() => ({ status: 0, stdout: OK_SUMMARY, stderr: "" })) as unknown as typeof import(
        "node:child_process"
      ).spawnSync,
    });
    assert.equal(exit, 0);
  });

  it("passa maxBuffer generoso pro spawn (#6807, review P1) — sem isso, um batch de 150 arquivos " +
    "com stdio:pipe estoura o default de 1 MB do Node e vira falha de spawn falsa ANTES do retry " +
    "de #6495 ter chance de rodar", () => {
    let seenOptions: Record<string, unknown> | undefined;
    runTestBatches({
      files: ["/a.test.ts"],
      spawn: ((_cmd: unknown, _args: unknown, options: unknown) => {
        seenOptions = options as Record<string, unknown>;
        return { status: 0 } as ReturnType<typeof import("node:child_process").spawnSync>;
      }) as typeof import("node:child_process").spawnSync,
    });
    assert.ok(seenOptions, "spawn não foi chamado");
    const maxBuffer = seenOptions?.maxBuffer;
    assert.ok(
      typeof maxBuffer === "number" && maxBuffer > 1024 * 1024,
      `maxBuffer precisa ser bem acima do default de 1 MB do Node, veio: ${maxBuffer}`,
    );
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

describe("shouldRetryBatch (#6495, alargado pelo #6857) — status != 0 + ERR_MODULE_NOT_FOUND, sem gate de fail count", () => {
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

  it("#6857 (achado ao vivo, PR #6855): ERR_MODULE_NOT_FOUND presente com fail 1 (o próprio crash contado como 1 falha, não uma asserção real) → AGORA retry", () => {
    const output = `${ERR}\nℹ fail 1\n`;
    assert.equal(shouldRetryBatch(output, 1), true, "o crash de módulo não é uma asserção real; gate por fail 0 escondia esse retry");
  });

  it("ERR_MODULE_NOT_FOUND presente com fail > 1 → também retry (a assinatura sozinha já basta, #6857)", () => {
    const output = `${ERR}\nℹ fail 2\n`;
    assert.equal(shouldRetryBatch(output, 1), true);
  });

  it("ERR_MODULE_NOT_FOUND presente mas sumário ilegível (fail count desconhecido) → também retry (#6857)", () => {
    const output = `${ERR}\nsem linha de sumário reconhecível\n`;
    assert.equal(shouldRetryBatch(output, 1), true);
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
      spawn: ((_cmd: unknown, args: unknown) => {
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

// --- #6822: resultado ausente nunca conta como bom -------------------------

describe("hasTestSummary (#6822)", () => {
  it("reconhece sumário reporter spec (ℹ) e tap (#) — reusa parseFailCount", () => {
    assert.equal(hasTestSummary("ℹ tests 5\nℹ pass 5\nℹ fail 0\n"), true);
    assert.equal(hasTestSummary("# tests 5\n# pass 4\n# fail 1\n"), true);
  });

  it("output vazio ou sem sumário reconhecível → false", () => {
    assert.equal(hasTestSummary(""), false);
    assert.equal(hasTestSummary("\n"), false);
    assert.equal(hasTestSummary("qualquer coisa sem o formato do node:test"), false);
  });
});

describe("runTestBatches — batch que TRAVA/MORRE produz exit != 0 (#6822, Defeito A)", () => {
  it("status 0 MAS sem sumário do node:test → FALHA DURA (resultado ausente nunca conta como bom)", () => {
    // Cenário exato medido ao vivo na PR #6830 (SHA d559013d): o job `test`
    // saiu `conclusion: success` com 2 asserções genuinamente quebradas,
    // porque o arquivo que continha essas asserções nunca rodou (o batch
    // morreu antes de chegar nele) — e nada no output confirmava isso além
    // da ausência do sumário final.
    const written: string[] = [];
    const exit = runTestBatches({
      files: ["/a.test.ts"],
      spawn: (() => ({ status: 0, stdout: "output qualquer, sem sumário final\n", stderr: "" })) as unknown as typeof import(
        "node:child_process"
      ).spawnSync,
      stdout: { write: (s: string) => written.push(s) },
      stderr: { write: (s: string) => written.push(s) },
    });
    assert.equal(exit, 1, "status 0 sem sumário não é sucesso — é resultado ausente");
    assert.ok(
      written.some((s) => s.includes("NÃO produziu sumário reconhecível")),
      "mensagem deve explicar que o sumário está ausente",
    );
  });

  it("processo morto por sinal (timeout do spawnSync) → FALHA DURA, mensagem nomeia os arquivos do batch", () => {
    const written: string[] = [];
    const exit = runTestBatches({
      files: ["/hang.test.ts", "/depois-do-hang.test.ts"],
      batchSize: 10,
      spawn: (() => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" })) as unknown as typeof import(
        "node:child_process"
      ).spawnSync,
      stdout: { write: (s: string) => written.push(s) },
      stderr: { write: (s: string) => written.push(s) },
    });
    assert.equal(exit, 1, "batch morto por sinal nunca pode sair 0");
    assert.ok(
      written.some((s) => s.includes("MORTO por sinal") && s.includes("/hang.test.ts") && s.includes("/depois-do-hang.test.ts")),
      "mensagem deve nomear os arquivos candidatos ao hang deste batch",
    );
  });

  it("batch com summary presente mas status 0 E signal setado (kill concorrente ao fim) → ainda falha (signal vence)", () => {
    // Defesa contra uma corrida improvável (processo termina e é morto quase
    // ao mesmo tempo) — `signal` não-nulo é sinal de morte forçada e deve
    // sempre prevalecer sobre um `status` que por acaso volte 0.
    const exit = runTestBatches({
      files: ["/a.test.ts"],
      spawn: (() => ({ status: 0, signal: "SIGTERM", stdout: OK_SUMMARY, stderr: "" })) as unknown as typeof import(
        "node:child_process"
      ).spawnSync,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.equal(exit, 1);
  });

  it("cobertura incompleta é reportada explicitamente no stderr (contagem batida contra files.length, mesma fonte do pretest)", () => {
    const written: string[] = [];
    runTestBatches({
      files: ["/a.test.ts", "/b.test.ts"],
      batchSize: 1,
      spawn: ((_cmd: unknown, args: unknown) => {
        const file = (args as string[]).slice(3)[0];
        // /a.test.ts trava (sem sumário); /b.test.ts roda normal.
        if (file === "/a.test.ts") return { status: 0, stdout: "sem sumário\n", stderr: "" };
        return { status: 0, stdout: OK_SUMMARY, stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
      stdout: { write: () => {} },
      stderr: { write: (s: string) => written.push(s) },
    });
    assert.ok(
      written.some((s) => s.includes("cobertura incompleta") && s.includes("1/2")),
      "deve reportar 1/2 arquivos confirmados",
    );
  });

  it("timeout/killSignal são passados pro spawn (teto por batch de verdade, não só cosmético)", () => {
    let seenOptions: Record<string, unknown> | undefined;
    runTestBatches({
      files: ["/a.test.ts"],
      batchTimeoutMs: 12345,
      spawn: ((_cmd: unknown, _args: unknown, options: unknown) => {
        seenOptions = options as Record<string, unknown>;
        return { status: 0, stdout: OK_SUMMARY, stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.equal(seenOptions?.timeout, 12345);
    assert.equal(seenOptions?.killSignal, "SIGKILL");
  });

  it("DEFAULT_BATCH_TIMEOUT_MS é positivo e finito, generoso o bastante pra não disparar em batch normal (>60s)", () => {
    assert.ok(Number.isFinite(DEFAULT_BATCH_TIMEOUT_MS));
    assert.ok(DEFAULT_BATCH_TIMEOUT_MS > 60_000);
  });

  it("spawnSync mata por ETIMEDOUT (caminho real do Node, não só result.signal) → mensagem nomeia os arquivos e o timeout usado", () => {
    const logs: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => logs.push(msg);
    try {
      const exit = runTestBatches({
        files: ["/hang.test.ts"],
        batchTimeoutMs: 9999,
        spawn: (() => ({
          error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }),
          status: null,
        })) as unknown as typeof import("node:child_process").spawnSync,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });
      assert.equal(exit, 1);
      assert.ok(
        logs.some((s) => s.includes("/hang.test.ts") && s.includes("9999") && s.includes("timeout")),
        `mensagem deve nomear arquivo + timeout usado, veio: ${JSON.stringify(logs)}`,
      );
    } finally {
      console.error = origError;
    }
  });

  it("review #6833 P2: output PARCIAL do batch é emitido mesmo quando spawnSync mata por ETIMEDOUT (não descartado)", () => {
    // Antes do fix pós-review: `emit(result)` só rodava DEPOIS do branch
    // `if (result.error) { ...; return; }` — qualquer stdout/stderr que o
    // batch tenha produzido antes do kill (o dado mais valioso pra bissecar
    // o Defeito B, ver docstring do módulo) era jogado fora.
    const written: string[] = [];
    runTestBatches({
      files: ["/a.test.ts"],
      spawn: (() => ({
        error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }),
        status: null,
        // partial: o Node ainda captura o que o processo escreveu antes do
        // kill — este é o dado que a PR #6833 (pré-fix) descartava.
        stdout: "▶ suite-x\n  ✔ teste que rodou antes do hang\n",
        stderr: "",
      })) as unknown as typeof import("node:child_process").spawnSync,
      stdout: { write: (s: string) => written.push(s) },
      stderr: { write: () => {} },
    });
    assert.ok(
      written.some((s) => s.includes("teste que rodou antes do hang")),
      "output parcial do batch morto deve chegar ao stdout injetado, não ser descartado",
    );
  });

  it("review #6833 P3: timeout detectado via error.code === 'ETIMEDOUT' (estruturado), não regex sobre error.message", () => {
    // error.message NÃO contém a string "ETIMEDOUT" — só error.code contém.
    // Se o código regredisse pra checar a mensagem, este teste pegaria.
    const logs: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => logs.push(msg);
    try {
      const exit = runTestBatches({
        files: ["/hang.test.ts"],
        batchTimeoutMs: 4242,
        spawn: (() => ({
          error: Object.assign(new Error("mensagem genérica sem menção a timeout"), { code: "ETIMEDOUT" }),
          status: null,
        })) as unknown as typeof import("node:child_process").spawnSync,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });
      assert.equal(exit, 1);
      assert.ok(
        logs.some((s) => s.includes("/hang.test.ts") && s.includes("4242") && s.includes("timeout")),
        `deve reconhecer timeout via error.code mesmo sem a palavra na mensagem, veio: ${JSON.stringify(logs)}`,
      );
    } finally {
      console.error = origError;
    }
  });

  it("loga os arquivos do batch ANTES de despachar (#6822 Defeito B: instrumentação pra bissecar hang futuro)", () => {
    const written: string[] = [];
    let spawnCalled = false;
    runTestBatches({
      files: ["/x.test.ts", "/y.test.ts"],
      batchSize: 10,
      spawn: (() => {
        spawnCalled = true;
        return { status: 0, stdout: OK_SUMMARY, stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
      stdout: {
        write: (s: string) => {
          // No momento em que a linha "despachando" é escrita, o spawn
          // ainda não deve ter sido chamado — prova que a lista de
          // arquivos é conhecida ANTES do dispatch, não reconstruída
          // depois a partir do resultado.
          if (s.includes("despachando")) assert.equal(spawnCalled, false);
          written.push(s);
        },
      },
      stderr: { write: () => {} },
    });
    assert.ok(written.some((s) => s.includes("/x.test.ts") && s.includes("/y.test.ts") && s.includes("despachando")));
  });
});

describe("bisectHangingBatch (#6822 Defeito B)", () => {
  const okResult = { status: 0, stdout: OK_SUMMARY, stderr: "" } as ReturnType<
    typeof import("node:child_process").spawnSync
  >;
  const hangResult = { status: null, signal: "SIGKILL", stdout: "", stderr: "" } as ReturnType<
    typeof import("node:child_process").spawnSync
  >;

  it("batch inteiro roda limpo dentro do subTimeout → tudo 'clean', nenhum spawn extra além do 1º", () => {
    let calls = 0;
    const result = bisectHangingBatch(
      ["/a.test.ts", "/b.test.ts", "/c.test.ts"],
      (() => {
        calls++;
        return okResult;
      }) as typeof import("node:child_process").spawnSync,
      [],
      1000,
      Date.now() + 60_000,
    );
    assert.deepEqual(result, { clean: ["/a.test.ts", "/b.test.ts", "/c.test.ts"], hanging: [], inconclusive: [] });
    assert.equal(calls, 1, "batch saudável não precisa bissecar — 1 spawn só");
  });

  it("1 arquivo específico trava sozinho mesmo isolado → isolado corretamente em 'hanging', o resto em 'clean'", () => {
    const result = bisectHangingBatch(
      ["/a.test.ts", "/b.test.ts", "/culpado.test.ts", "/d.test.ts"],
      ((_cmd, args) => {
        const batch = (args as string[]).slice(3);
        return batch.includes("/culpado.test.ts") ? hangResult : okResult;
      }) as typeof import("node:child_process").spawnSync,
      [],
      1000,
      Date.now() + 60_000,
    );
    assert.deepEqual(result.hanging, ["/culpado.test.ts"]);
    assert.deepEqual(result.inconclusive, []);
    assert.ok(!result.clean.includes("/culpado.test.ts"));
    assert.ok(
      ["/a.test.ts", "/b.test.ts", "/d.test.ts"].every((f) => result.clean.includes(f)),
      "os 3 arquivos inocentes devem sair como clean",
    );
  });

  it("nenhuma sub-lista reproduz isolada (contenção de recurso — só trava com vizinhos concorrentes) → tudo 'clean', nunca reportado como culpado", () => {
    // Simula o cenário em que o hang depende de CONCORRÊNCIA entre arquivos
    // — bissecar reduz o paralelismo junto com o tamanho, então nada
    // reproduz isolado. `formatBisectResult` deve refletir isso como
    // "não reproduziu", não como "está tudo bem".
    const result = bisectHangingBatch(
      ["/a.test.ts", "/b.test.ts"],
      (() => okResult) as typeof import("node:child_process").spawnSync,
      [],
      1000,
      Date.now() + 60_000,
    );
    assert.deepEqual(result, { clean: ["/a.test.ts", "/b.test.ts"], hanging: [], inconclusive: [] });
    assert.ok(formatBisectResult(result).includes("não reproduziu"));
  });

  it("orçamento total esgotado no meio da bisecção → arquivos restantes ficam 'inconclusive', NUNCA promovidos a 'clean' por falta de tempo", () => {
    const result = bisectHangingBatch(["/a.test.ts", "/b.test.ts", "/c.test.ts"], (() => hangResult) as typeof import(
      "node:child_process"
    ).spawnSync, [], 1000, Date.now() - 1 /* deadline já vencido antes da 1ª chamada */);
    assert.deepEqual(result, { clean: [], hanging: [], inconclusive: ["/a.test.ts", "/b.test.ts", "/c.test.ts"] });
  });

  it("batch de 1 arquivo que trava → 'hanging' direto, sem tentar recursar abaixo de 1", () => {
    const result = bisectHangingBatch(
      ["/sozinho.test.ts"],
      (() => hangResult) as typeof import("node:child_process").spawnSync,
      [],
      1000,
      Date.now() + 60_000,
    );
    assert.deepEqual(result, { clean: [], hanging: ["/sozinho.test.ts"], inconclusive: [] });
  });

  it("passa timeout reduzido (subTimeoutMs) pro spawn, não o batchTimeoutMs original", () => {
    let seenTimeout: unknown;
    bisectHangingBatch(
      ["/a.test.ts"],
      ((_cmd, _args, options) => {
        seenTimeout = (options as Record<string, unknown>).timeout;
        return okResult;
      }) as typeof import("node:child_process").spawnSync,
      [],
      4242,
      Date.now() + 60_000,
    );
    assert.equal(seenTimeout, 4242);
  });
});

describe("formatBisectResult (#6822 Defeito B)", () => {
  it("hanging não-vazio → rotula 'candidato(s) forte(s)', nunca 'causa comprovada'", () => {
    const msg = formatBisectResult({ clean: [], hanging: ["/x.test.ts"], inconclusive: [] });
    assert.ok(msg.includes("candidato"));
    assert.ok(msg.includes("/x.test.ts"));
    assert.ok(!msg.toLowerCase().includes("causa comprovada"));
  });

  it("inconclusive não-vazio → menciona contenção de recurso, nunca declara 'limpo'", () => {
    const msg = formatBisectResult({ clean: [], hanging: [], inconclusive: ["/y.test.ts"] });
    assert.ok(msg.includes("/y.test.ts"));
    assert.ok(msg.toLowerCase().includes("contenção") || msg.toLowerCase().includes("concorrente"));
  });

  it("tudo clean (não reproduziu em nenhuma sub-lista) → mensagem honesta de 'não reproduziu', não 'está tudo bem'", () => {
    const msg = formatBisectResult({ clean: ["/a.test.ts"], hanging: [], inconclusive: [] });
    assert.ok(msg.includes("não reproduziu"));
  });
});

describe("runTestBatches — bisecção automática no caminho de falha (#6822 Defeito B)", () => {
  it("batch morto por sinal aciona bisecção e reporta o(s) arquivo(s) isolado(s), não só a lista crua do batch inteiro", () => {
    const written: string[] = [];
    runTestBatches({
      files: ["/inocente.test.ts", "/culpado.test.ts"],
      batchSize: 10,
      bisectTimeoutMs: 1000,
      spawn: ((_cmd, args) => {
        const batch = (args as string[]).slice(3);
        if (batch.length > 1) return { status: null, signal: "SIGKILL", stdout: "", stderr: "" };
        return batch[0] === "/culpado.test.ts"
          ? { status: null, signal: "SIGKILL", stdout: "", stderr: "" }
          : { status: 0, stdout: OK_SUMMARY, stderr: "" };
      }) as typeof import("node:child_process").spawnSync,
      stdout: { write: () => {} },
      stderr: { write: (s: string) => written.push(s) },
    });
    assert.ok(
      written.some((s) => s.includes("bisecção") && s.includes("/culpado.test.ts") && !s.includes("/inocente.test.ts")),
      `deve isolar o culpado sem incluir o inocente na mensagem de bisecção, veio: ${JSON.stringify(written)}`,
    );
  });

  it("bisectBudgetMs: 0 desliga a bisecção — mensagem cai de volta na lista crua do batch, sem spawns extras", () => {
    let calls = 0;
    const written: string[] = [];
    runTestBatches({
      files: ["/a.test.ts", "/b.test.ts"],
      batchSize: 10,
      bisectBudgetMs: 0,
      spawn: (() => {
        calls++;
        return { status: null, signal: "SIGKILL", stdout: "", stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
      stdout: { write: () => {} },
      stderr: { write: (s: string) => written.push(s) },
    });
    assert.equal(calls, 1, "bisecção desligada não deve gastar spawn extra");
    assert.ok(written.some((s) => s.includes("bisecção desligada")));
  });
});
