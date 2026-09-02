/**
 * test/run-tests.test.ts (#6495)
 *
 * Cobre o wrapper de descoberta explícita de `scripts/run-tests.ts`: batching
 * puro (`chunk`) e a agregação de exit code em `runTestBatches` (com
 * `spawn` injetado — nunca dispara um `node --test` real dentro do teste).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chunk,
  runTestBatches,
  shouldRetryBatch,
  parseFailCount,
  hasTestSummary,
  bisectHangingBatch,
  formatBisectResult,
  splitIntoWorkerGroups,
  finalizeExitCode,
  runTestBatchesParallel,
  cleanChildEnv,
  DEFAULT_WORKER_COUNT,
  BATCH_SIZE,
  DEFAULT_BATCH_TIMEOUT_MS,
  computeWorkerTimeoutMs,
  type RunTestBatchesParallelOptions,
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

  // #7094 — sumário VÁLIDO com `fail 0` + status não-zero era a única
  // atribuição de `exitCode = 1` do arquivo sem nenhuma escrita. O log
  // terminava com `ℹ fail 0` seguido de `exit code 1` e NADA entre os dois,
  // enquanto os dois caminhos vizinhos (batch sem sumário, cobertura parcial
  // do #6822) já gritavam e nomeavam. O exit code sempre esteve certo; o
  // defeito era o silêncio, que treina o re-run reflexivo.
  it("#7094: sumário válido com fail 0 + status != 0 → exit 1 E mensagem nomeada no stderr", () => {
    const written: string[] = [];
    const exit = runTestBatches({
      files: ["/a.test.ts"],
      batchSize: 10,
      spawn: (() => ({
        status: 1,
        stdout: OK_SUMMARY,
        stderr: "Uncaught Error: boom\n    at algum-lugar\n",
      })) as unknown as typeof import("node:child_process").spawnSync,
      stderr: { write: (c: string) => written.push(c) },
    });
    assert.equal(exit, 1);
    const out = written.join("");
    assert.match(out, /sumário VÁLIDO \(fail 0\) mas exit status 1/);
    assert.match(out, /SEM contabilizar falha/);
    // O tail do stderr do filho é o que distingue as causas possíveis —
    // sem ele a mensagem seria só mais uma afirmação sem evidência.
    assert.match(out, /Uncaught Error: boom/);
  });

  it("#7094: sumário válido com fail 0 e status 0 → exit 0, SEM a mensagem (não vira ruído por batch)", () => {
    const written: string[] = [];
    const exit = runTestBatches({
      files: ["/a.test.ts"],
      batchSize: 10,
      spawn: (() => ({ status: 0, stdout: OK_SUMMARY, stderr: "" })) as unknown as typeof import(
        "node:child_process"
      ).spawnSync,
      stderr: { write: (c: string) => written.push(c) },
    });
    assert.equal(exit, 0);
    assert.doesNotMatch(written.join(""), /sumário VÁLIDO/);
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

  it("spawnSync mata por ETIMEDOUT também aciona bisecção (não só o caminho de result.signal)", () => {
    const logs: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => logs.push(msg);
    try {
      runTestBatches({
        files: ["/inocente.test.ts", "/culpado.test.ts"],
        batchSize: 10,
        bisectTimeoutMs: 1000,
        spawn: ((_cmd: unknown, args: unknown) => {
          const batch = (args as string[]).slice(3);
          if (batch.length > 1) {
            return { error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }), status: null };
          }
          return batch[0] === "/culpado.test.ts"
            ? { status: null, signal: "SIGKILL", stdout: "", stderr: "" }
            : { status: 0, stdout: OK_SUMMARY, stderr: "" };
        }) as unknown as typeof import("node:child_process").spawnSync,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });
      assert.ok(
        logs.some((s) => s.includes("candidato") && s.includes("/culpado.test.ts") && !s.includes("/inocente.test.ts")),
        `deve isolar o culpado via bisecção mesmo no caminho de ETIMEDOUT, veio: ${JSON.stringify(logs)}`,
      );
    } finally {
      console.error = origError;
    }
  });

  it("batch sem sumário do node:test (status 0, Defeito A) também aciona bisecção e isola o culpado", () => {
    const written: string[] = [];
    runTestBatches({
      files: ["/inocente.test.ts", "/culpado.test.ts"],
      batchSize: 10,
      bisectTimeoutMs: 1000,
      spawn: ((_cmd, args) => {
        const batch = (args as string[]).slice(3);
        if (batch.length > 1) return { status: 0, stdout: "sem sumário nenhum aqui\n", stderr: "" };
        return batch[0] === "/culpado.test.ts"
          ? { status: 0, stdout: "sem sumário nenhum aqui\n", stderr: "" }
          : { status: 0, stdout: OK_SUMMARY, stderr: "" };
      }) as typeof import("node:child_process").spawnSync,
      stdout: { write: () => {} },
      stderr: { write: (s: string) => written.push(s) },
    });
    assert.ok(
      written.some((s) => s.includes("bisecção") && s.includes("/culpado.test.ts") && !s.includes("/inocente.test.ts")),
      `deve isolar o culpado via bisecção no caminho de sumário ausente, veio: ${JSON.stringify(written)}`,
    );
  });
});

// --- #6877: paralelismo de batches ----------------------------------------

describe("splitIntoWorkerGroups (#6877)", () => {
  it("distribui por ROUND-ROBIN (item i vai pro grupo i % groupCount), não contíguo", () => {
    const batches = ["b1", "b2", "b3", "b4", "b5"];
    assert.deepEqual(splitIntoWorkerGroups(batches, 2), [
      ["b1", "b3", "b5"],
      ["b2", "b4"],
    ]);
  });

  it("mais grupos que itens → grupos vazios são REMOVIDOS do resultado", () => {
    assert.deepEqual(splitIntoWorkerGroups(["b1", "b2"], 5), [["b1"], ["b2"]]);
  });

  it("groupCount igual ao número de itens → 1 item por grupo", () => {
    assert.deepEqual(splitIntoWorkerGroups(["b1", "b2", "b3"], 3), [["b1"], ["b2"], ["b3"]]);
  });

  it("lista vazia → array vazio, nenhum grupo (nem vazio)", () => {
    assert.deepEqual(splitIntoWorkerGroups([], 4), []);
  });

  it("groupCount <= 0 lança (mesmo guard de chunk)", () => {
    assert.throws(() => splitIntoWorkerGroups(["b1"], 0), /groupCount deve ser > 0/);
    assert.throws(() => splitIntoWorkerGroups(["b1"], -1), /groupCount deve ser > 0/);
  });

  it("todos os itens preservados, nenhum duplicado, em QUALQUER groupCount", () => {
    const batches = Array.from({ length: 17 }, (_, i) => `b${i}`);
    for (const groupCount of [1, 2, 3, 4, 5, 20]) {
      const groups = splitIntoWorkerGroups(batches, groupCount);
      const flat = groups.flat().sort();
      assert.deepEqual(flat, [...batches].sort(), `groupCount=${groupCount} perdeu ou duplicou item`);
    }
  });
});

describe("finalizeExitCode (#6877, extraído do check final de #6822)", () => {
  it("completedFiles === totalFiles → devolve o exitCode recebido, sem mexer", () => {
    assert.equal(finalizeExitCode(0, 10, 10), 0);
    assert.equal(finalizeExitCode(1, 10, 10), 1, "exitCode 1 de falha real de teste não é mascarado");
  });

  it("completedFiles !== totalFiles → SEMPRE 1, mesmo se exitCode recebido fosse 0 (#6822: nunca cobertura parcial vira sucesso)", () => {
    assert.equal(finalizeExitCode(0, 8, 10), 1);
  });

  it("cobertura incompleta escreve mensagem diagnóstica no stderr injetado, citando a contagem real", () => {
    const written: string[] = [];
    finalizeExitCode(0, 8, 10, { write: (s: string) => written.push(s) });
    assert.ok(written.some((s) => s.includes("8/10") && s.includes("cobertura incompleta")));
  });
});

// --- #6991: worker morto vira shard AUSENTE, não teste falhando ------------
//
// A issue #6991 descreve uma leitura enganosa: comparar duas rodadas pelo
// "conjunto de arquivos que falharam" é cego a um shard que nunca chegou a
// rodar — ele nunca produz uma linha de falha, então some da comparação sem
// deixar rastro NESSA leitura específica. O mecanismo que fecha essa lacuna
// (`finalizeExitCode`, acima) já existe desde o #6822/#6877/#6939 — este
// bloco fixa, em nome da própria issue, o cenário exato que ela descreve:
// N-1 batches com sumário GENUÍNO e LIMPO (fail 0 — "conjunto de falhas"
// vazio, a leitura que engana) e 1 batch que nunca produz sumário nenhum
// (morto por ETIMEDOUT, igual ao "spawnSync node ETIMEDOUT" citado na
// issue). O exit agregado precisa refletir o shard ausente, não o conjunto
// de falhas visível — nunca 0 por "todo mundo que respondeu está limpo".
describe("REGRESSÃO (#6991): shard morto não pode virar 'conjunto de falhas idêntico' silencioso", () => {
  it("3 de 4 shards saem com sumário limpo (fail 0) e 1 morre por ETIMEDOUT sem sumário → exit agregado é 1, nunca 0", () => {
    const deadShard = "/c.test.ts";
    const exit = runTestBatches({
      files: ["/a.test.ts", "/b.test.ts", deadShard, "/d.test.ts"],
      batchSize: 1,
      // Isola o resultado agregado sem o custo extra de bisecção — o alvo
      // deste teste é o exit code final, não o diagnóstico de qual arquivo
      // travou (já coberto pelos testes de bisecção acima).
      bisectBudgetMs: 0,
      spawn: ((_cmd: unknown, args: unknown) => {
        const batch = (args as string[]).slice(3); // pula --import tsx --test
        if (batch[0] === deadShard) {
          // Mesma assinatura da issue: spawnSync mata o processo por timeout
          // antes de qualquer sumário do node:test ser produzido.
          return {
            error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }),
            status: null,
          };
        }
        return { status: 0, stdout: OK_SUMMARY, stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
    });
    assert.equal(
      exit,
      1,
      "a leitura ingênua do 'conjunto de falhas' veria só shards limpos (fail 0) — o shard morto nunca " +
        "reportou um arquivo falhando, mas também nunca completou; o exit agregado precisa ser 1 mesmo assim",
    );
  });
});

// `spawn` não está no tipo público de `RunTestBatchesParallelOptions`
// (produção nunca injeta — o caminho `fork()` não tem como cruzar uma
// função pela fronteira de IPC) — mas o fallback sequencial (`workerCount
// <= 1`/1 batch só) delega em `runTestBatches`, que aceita normalmente via
// duck typing em runtime. Tipo local, mais estreito que `as never` (achado
// do review da PR #6909, P3: `as never` desligava a checagem de tipo do
// objeto INTEIRO, não só de `spawn` — um typo em `workerCont`/`batchSize`
// no mesmo literal não seria pego).
type ParallelOptionsWithSpawn = RunTestBatchesParallelOptions & {
  spawn: typeof import("node:child_process").spawnSync;
};

describe("runTestBatchesParallel (#6877) — roteamento pro caminho sequencial", () => {
  it("workerCount <= 1 → cai no runTestBatches de sempre (spawn injetado é respeitado, sem fork nenhum)", async () => {
    let calls = 0;
    const exit = await runTestBatchesParallel({
      files: ["/a.test.ts", "/b.test.ts"],
      batchSize: 10,
      workerCount: 1,
      spawn: (() => {
        calls++;
        return { status: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
    } as ParallelOptionsWithSpawn);
    assert.equal(exit, 0);
    assert.equal(calls, 1, "1 batch só (batchSize=10, 2 arquivos) → 1 chamada de spawn, caminho sequencial de sempre");
  });

  it("1 batch só (mesmo com workerCount > 1) → cai no caminho sequencial, sem overhead de fork", async () => {
    let calls = 0;
    const exit = await runTestBatchesParallel({
      files: ["/a.test.ts"],
      batchSize: 150,
      workerCount: 4,
      spawn: (() => {
        calls++;
        return { status: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "" };
      }) as unknown as typeof import("node:child_process").spawnSync,
    } as ParallelOptionsWithSpawn);
    assert.equal(exit, 0);
    assert.equal(calls, 1);
  });

  it("lista vazia → 0 sem chamar spawn, mesmo guard de sempre", async () => {
    let calls = 0;
    const exit = await runTestBatchesParallel({
      files: [],
      spawn: (() => {
        calls++;
        return { status: 0 } as ReturnType<typeof import("node:child_process").spawnSync>;
      }) as unknown as typeof import("node:child_process").spawnSync,
    } as ParallelOptionsWithSpawn);
    assert.equal(exit, 0);
    assert.equal(calls, 0);
  });

  it("DEFAULT_WORKER_COUNT é um inteiro positivo (nunca 0, nunca fracionário)", () => {
    assert.ok(Number.isInteger(DEFAULT_WORKER_COUNT) && DEFAULT_WORKER_COUNT > 0);
  });
});

describe("computeWorkerTimeoutMs (#6939) — teto do worker soma o orçamento de bisecção", () => {
  it("REGRESSÃO (#6939): cenário da issue — grupo de 2 batches de 5min + bisecção de 10min cabia no teto ANTES do fix (12min < 16min de gasto real) e não cabe mais", () => {
    const batchTimeoutMs = 5 * 60 * 1000;
    const bisectBudgetMs = 10 * 60 * 1000;
    const payload = { batches: [["a.test.ts"], ["b.test.ts"]], batchTimeoutMs, bisectBudgetMs };

    const timeoutMs = computeWorkerTimeoutMs(payload);

    // Teto ANTES do fix (#6939): só somava batches + margem — 2*5min+2min=12min.
    const legacyTimeoutMs = payload.batches.length * batchTimeoutMs + 2 * 60 * 1000;
    assert.equal(legacyTimeoutMs, 12 * 60 * 1000);

    // Gasto real possível no pior caso descrito na issue: 1 batch travado até
    // o SIGKILL (5min) + bisecção inteira (10min) + o outro batch saudável
    // (~1min) — até 16min, que estourava o teto legado de 12min.
    const worstCaseRealMs = batchTimeoutMs + bisectBudgetMs + 60 * 1000;
    assert.ok(
      legacyTimeoutMs < worstCaseRealMs,
      "pré-condição da regressão: o teto legado cabia menos que o pior caso real — é isso que matava o worker no meio da bisecção",
    );

    // Teto CORRIGIDO cobre o pior caso real inteiro (com folga da própria
    // margem de startup).
    assert.ok(
      timeoutMs >= worstCaseRealMs,
      `teto corrigido (${timeoutMs}ms) deveria cobrir o pior caso real (${worstCaseRealMs}ms) — sem isso o worker ainda morre no meio da bisecção`,
    );
    assert.equal(timeoutMs, 2 * batchTimeoutMs + bisectBudgetMs + 2 * 60 * 1000);
  });

  it("bisecção desligada (bisectBudgetMs=0) → teto idêntico ao comportamento pré-#6939 (só batches + margem)", () => {
    const batchTimeoutMs = 5 * 60 * 1000;
    const timeoutMs = computeWorkerTimeoutMs({
      batches: [["a.test.ts"], ["b.test.ts"], ["c.test.ts"]],
      batchTimeoutMs,
      bisectBudgetMs: 0,
    });
    assert.equal(timeoutMs, 3 * batchTimeoutMs + 2 * 60 * 1000);
  });

  it("grupo com 1 batch só → teto = 1 batch + bisecção + margem", () => {
    const timeoutMs = computeWorkerTimeoutMs({
      batches: [["a.test.ts"]],
      batchTimeoutMs: 5 * 60 * 1000,
      bisectBudgetMs: 10 * 60 * 1000,
    });
    assert.equal(timeoutMs, 5 * 60 * 1000 + 10 * 60 * 1000 + 2 * 60 * 1000);
  });
});

describe("runTestBatchesParallel (#6877) — integração REAL com fork() (sem spawn injetado)", () => {
  it("2 batches distribuídos em 2 workers reais (fork + IPC) → exit 0, ambos completam", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-parallel-it-"));
    try {
      const okTest = (name: string) =>
        `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("${name}", () => { assert.equal(1, 1); });\n`;
      const fileA = join(dir, "a.test.ts");
      const fileB = join(dir, "b.test.ts");
      writeFileSync(fileA, okTest("a"));
      writeFileSync(fileB, okTest("b"));
      const scriptPath = fileURLToPath(new URL("../scripts/run-tests.ts", import.meta.url));

      const exit = await runTestBatchesParallel({
        files: [fileA, fileB],
        batchSize: 1, // força 2 batches → 2 workers reais em paralelo
        workerCount: 2,
        scriptPath,
      });
      assert.equal(exit, 0, "2 arquivos de teste genuinamente OK, rodados via fork() real → exit 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("1 dos 2 batches falha de verdade → exit agregado 1 (falha real de um worker não é engolida)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-parallel-it-fail-"));
    try {
      const okTest = `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => { assert.equal(1, 1); });\n`;
      const failTest = `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("fail", () => { assert.equal(1, 2); });\n`;
      const fileOk = join(dir, "ok.test.ts");
      const fileFail = join(dir, "fail.test.ts");
      writeFileSync(fileOk, okTest);
      writeFileSync(fileFail, failTest);
      const scriptPath = fileURLToPath(new URL("../scripts/run-tests.ts", import.meta.url));

      const exit = await runTestBatchesParallel({
        files: [fileOk, fileFail],
        batchSize: 1,
        workerCount: 2,
        scriptPath,
      });
      assert.equal(exit, 1, "1 worker com falha real de asserção → agregado nunca vira 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // REGRESSÃO (achado do fleet review da PR #6909, P1/P2 confiança alta,
  // reportado por 3 dos 5 agentes independentemente): nenhum teste forçava
  // um worker a morrer SEM mandar o resultado via IPC — exatamente o
  // cenário que o `child.on("exit")` de `runWorker` existe pra cobrir
  // (docstring do módulo: "nunca deixa resultado ausente virar sucesso,
  // mesmo princípio do #6822 aplicado ao nível de worker"). `scriptPath`
  // aponta pra um script REAL, minúsculo, que sai com `process.exit(1)`
  // SEM NUNCA chamar `process.send` — simula um crash puro (SIGSEGV, OOM,
  // exceção não-tratada antes do `runAsWorker` terminar).
  it("REGRESSÃO (#6909): worker morre SEM enviar resultado via IPC → exit 1, nunca mascarado como sucesso", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-parallel-it-crash-"));
    try {
      const crashingScript = join(dir, "crashing-worker.mjs");
      // Nunca chama process.send — simula um crash antes do runAsWorker
      // conseguir mandar o resultado (o `fork()` real ainda estabelece o
      // canal IPC normalmente; o que falta é o PROCESSO usá-lo).
      writeFileSync(crashingScript, "process.exit(1);\n");
      const okTest = `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => { assert.equal(1, 1); });\n`;
      const fileA = join(dir, "a.test.ts");
      const fileB = join(dir, "b.test.ts");
      writeFileSync(fileA, okTest);
      writeFileSync(fileB, okTest);

      const exit = await runTestBatchesParallel({
        // #6877: `batches.length <= 1` cai no fallback sequencial mesmo com
        // `workerCount > 1` — 2 arquivos/batchSize 1 força 2 batches, então
        // o caminho `fork()` real (que é o que este teste precisa exercitar)
        // realmente dispara em vez de silenciosamente cair pro sequencial
        // (que ignoraria `scriptPath` — nunca chamaria o script crashado).
        files: [fileA, fileB],
        batchSize: 1,
        workerCount: 2,
        scriptPath: crashingScript,
      });
      assert.equal(exit, 1, "worker crashado sem IPC nunca pode sair como sucesso — mesmo princípio do #6822");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Teste direto de `cleanChildEnv` (achado do review, P3: só era exercitada
  // indiretamente pelos 2 testes de integração real acima — uma regressão
  // aqui apareceria como "exit code errado" sem nomear a causa real).
  it("REGRESSÃO (#6909): cleanChildEnv remove NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID, preserva o resto do env", () => {
    const fakeEnv = {
      NODE_TEST_CONTEXT: "1",
      NODE_TEST_WORKER_ID: "3",
      PATH: "/usr/bin",
      HOME: "/home/x",
    };
    const cleaned = cleanChildEnv(fakeEnv as NodeJS.ProcessEnv);
    assert.equal("NODE_TEST_CONTEXT" in cleaned, false);
    assert.equal("NODE_TEST_WORKER_ID" in cleaned, false);
    assert.equal(cleaned.PATH, "/usr/bin");
    assert.equal(cleaned.HOME, "/home/x");
  });

  it("cleanChildEnv: env sem as chaves NODE_TEST_* não lança, devolve intacto", () => {
    const fakeEnv = { PATH: "/usr/bin" };
    assert.deepEqual(cleanChildEnv(fakeEnv as NodeJS.ProcessEnv), fakeEnv);
  });
});
