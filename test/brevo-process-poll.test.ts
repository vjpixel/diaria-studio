/**
 * test/brevo-process-poll.test.ts (#5653)
 *
 * Unit direto de `scripts/lib/brevo-process-poll.ts` — regressão do achado
 * ao vivo 24-25/08/2026 (`.novos-run.log` linha 990): um import de ~29
 * linhas não completou em 30 tentativas (default anterior, 60s) sob rate
 * limit sustentado da conta Brevo — `Error: Processo 1993 não completou
 * após 30 tentativas de poll.`
 *
 * Nenhum teste aqui dorme de verdade — `sleep` é sempre injetado como
 * síncrono/imediato.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  pollProcessUntilTerminal,
  PollBudgetExhaustedError,
  type ProcessStatusResult,
} from "../scripts/lib/brevo-process-poll.ts";

const noSleep = async (_ms: number): Promise<void> => {};

describe("pollProcessUntilTerminal — orçamento configurável (#5653)", () => {
  it("default (sem opts) sobe pra 90 tentativas — 3x o orçamento anterior de 30 (achado ao vivo #6132: 30 não bastou)", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        pollProcessUntilTerminal<ProcessStatusResult>(
          async () => { calls++; return { status: "in_process" }; },
          1993,
          { sleep: noSleep },
        ),
      PollBudgetExhaustedError,
    );
    assert.equal(calls, 90, "default de maxAttempts deve ser 90, não mais o antigo 30");
  });

  it("maxAttempts customizado via opts é respeitado (override por chamada)", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        pollProcessUntilTerminal<ProcessStatusResult>(
          async () => { calls++; return { status: "queued" }; },
          "x",
          { sleep: noSleep, maxAttempts: 5 },
        ),
      PollBudgetExhaustedError,
    );
    assert.equal(calls, 5);
  });

  describe("override via env var", () => {
    const ENV_VAR = "BREVO_PROCESS_POLL_MAX_ATTEMPTS";
    let original: string | undefined;
    beforeEach(() => { original = process.env[ENV_VAR]; });
    afterEach(() => {
      if (original === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = original;
    });

    it("BREVO_PROCESS_POLL_MAX_ATTEMPTS=4 sem opts.maxAttempts => usa 4, não o default 90", async () => {
      process.env[ENV_VAR] = "4";
      let calls = 0;
      await assert.rejects(
        () =>
          pollProcessUntilTerminal<ProcessStatusResult>(
            async () => { calls++; return { status: "queued" }; },
            "y",
            { sleep: noSleep },
          ),
        PollBudgetExhaustedError,
      );
      assert.equal(calls, 4);
    });

    it("opts.maxAttempts explícito VENCE a env var (chamador tem prioridade)", async () => {
      process.env[ENV_VAR] = "4";
      let calls = 0;
      await assert.rejects(
        () =>
          pollProcessUntilTerminal<ProcessStatusResult>(
            async () => { calls++; return { status: "queued" }; },
            "z",
            { sleep: noSleep, maxAttempts: 2 },
          ),
        PollBudgetExhaustedError,
      );
      assert.equal(calls, 2);
    });
  });
});

describe("pollProcessUntilTerminal — mensagens DISTINTAS: falha reportada vs orçamento esgotado (#5653)", () => {
  it("status terminal 'failed' da Brevo => Error genérico (nome 'Error'), mensagem 'falhou (status=...)', NÃO espera maxAttempts", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        pollProcessUntilTerminal<ProcessStatusResult>(
          async () => { calls++; return { status: "failed" }; },
          42,
          { sleep: noSleep, maxAttempts: 30 },
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.notEqual(err.constructor, PollBudgetExhaustedError, "falha REPORTADA nunca é a mesma classe de orçamento esgotado");
        assert.match(err.message, /Processo 42 falhou \(status=failed\)/);
        return true;
      },
    );
    assert.equal(calls, 1, "lança na 1ª leitura terminal de falha — não gasta o orçamento inteiro");
  });

  it("esgota maxAttempts sem status terminal => PollBudgetExhaustedError, mensagem distinta ('orçamento de poll ESGOTADO', nunca 'falhou')", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        pollProcessUntilTerminal<ProcessStatusResult>(
          async () => { calls++; return { status: "in_process" }; },
          1993,
          { sleep: noSleep, maxAttempts: 3 },
        ),
      (err: unknown) => {
        assert.ok(err instanceof PollBudgetExhaustedError);
        assert.match(err.message, /orçamento de poll ESGOTADO/);
        assert.match(err.message, /NÃO é uma falha reportada por ela/);
        assert.doesNotMatch(err.message, /Processo 1993 falhou/, "não deve reusar o texto de falha reportada");
        return true;
      },
    );
    assert.equal(calls, 3);
  });

  it("as duas mensagens de erro são MUTUAMENTE distintas por regex simples (regressão: hoje eram fáceis de confundir na leitura de log)", async () => {
    let reportedFailureMsg = "";
    let budgetExhaustedMsg = "";
    try {
      await pollProcessUntilTerminal<ProcessStatusResult>(async () => ({ status: "error" }), 1, { sleep: noSleep });
    } catch (e) { reportedFailureMsg = (e as Error).message; }
    try {
      await pollProcessUntilTerminal<ProcessStatusResult>(async () => ({ status: "queued" }), 2, { sleep: noSleep, maxAttempts: 2 });
    } catch (e) { budgetExhaustedMsg = (e as Error).message; }
    assert.notEqual(reportedFailureMsg, "");
    assert.notEqual(budgetExhaustedMsg, "");
    assert.notEqual(reportedFailureMsg, budgetExhaustedMsg);
  });
});

describe("pollProcessUntilTerminal — comportamento preservado (não-regressão)", () => {
  it("status completed/success resolve normalmente, sem lançar", async () => {
    const r = await pollProcessUntilTerminal<ProcessStatusResult>(async () => ({ status: "completed", exportUrl: "x" }), 1, { sleep: noSleep });
    assert.equal(r.status, "completed");
  });

  it("status transitório seguido de completed => resolve após retentar", async () => {
    let calls = 0;
    const r = await pollProcessUntilTerminal<ProcessStatusResult>(
      async () => { calls++; return calls < 3 ? { status: "queued" } : { status: "success" }; },
      1,
      { sleep: noSleep },
    );
    assert.equal(r.status, "success");
    assert.equal(calls, 3);
  });
});
