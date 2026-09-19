/**
 * test/claude-cli-subprocess.test.ts (#7981)
 *
 * Teste DEDICADO exigido pela restrição de design não-negociável da issue
 * #7981: `scripts/lib/claude-cli-subprocess.ts` precisa reusar o mesmo
 * mecanismo de filtragem de ambiente de `run-scheduled-edicao.ts`
 * (`CLAUDE_CLI_STRIPPED_ENV_VARS`/`claudeCliEnv`), nunca reimplementar.
 * Este teste prova que TODA chamada via `callClaudeCli` filtra o ambiente
 * — inclusive quando o chamador tenta injetar as vars proibidas
 * diretamente em `opts.env` (#5608/#6714) — capturando o `env` que de
 * fato chega no `execFn` injetado (nunca spawna um `claude` real).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { callClaudeCli, ClaudeCliError } from "../scripts/lib/claude-cli-subprocess.ts";
import { CLAUDE_CLI_STRIPPED_ENV_VARS } from "../scripts/overnight/run-scheduled-edicao.ts";

function fakeExecFn(capturedEnvs: NodeJS.ProcessEnv[]) {
  return ((_bin: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    capturedEnvs.push(opts.env ?? {});
    return "resposta simulada";
  }) as unknown as typeof import("node:child_process").execFileSync;
}

describe("callClaudeCli — filtragem de ambiente NÃO-NEGOCIÁVEL (#7981, #5608, #6714)", () => {
  it("remove TODAS as CLAUDE_CLI_STRIPPED_ENV_VARS do env passado ao subprocesso", () => {
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    const dirtyEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of CLAUDE_CLI_STRIPPED_ENV_VARS) dirtyEnv[key] = "valor-perigoso";
    dirtyEnv["PATH"] = dirtyEnv["PATH"] ?? "/usr/bin";

    callClaudeCli("critique isto", {
      cwd: "/tmp",
      env: dirtyEnv,
      execFn: fakeExecFn(capturedEnvs),
      resolveClaudeBinFn: () => "/fake/claude",
    });

    assert.equal(capturedEnvs.length, 1);
    for (const key of CLAUDE_CLI_STRIPPED_ENV_VARS) {
      assert.equal(capturedEnvs[0][key], undefined, `${key} deveria ter sido removida do env do subprocesso`);
    }
    assert.equal(capturedEnvs[0]["PATH"], dirtyEnv["PATH"], "vars NÃO na lista de exclusão devem sobreviver");
  });

  it("mesmo se opts.env já vier 'limpo', a filtragem roda de novo (defesa em profundidade)", () => {
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    const cleanEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    callClaudeCli("critique isto", {
      cwd: "/tmp",
      env: cleanEnv,
      execFn: fakeExecFn(capturedEnvs),
      resolveClaudeBinFn: () => "/fake/claude",
    });

    for (const key of CLAUDE_CLI_STRIPPED_ENV_VARS) {
      assert.equal(capturedEnvs[0][key], undefined);
    }
  });

  it("sem opts.env explícito, usa process.env (ainda filtrado)", () => {
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    callClaudeCli("critique isto", {
      cwd: "/tmp",
      execFn: fakeExecFn(capturedEnvs),
      resolveClaudeBinFn: () => "/fake/claude",
    });
    assert.equal(capturedEnvs.length, 1);
    for (const key of CLAUDE_CLI_STRIPPED_ENV_VARS) {
      assert.equal(capturedEnvs[0][key], undefined);
    }
  });

  it("monta os args exatos --print/--permission-mode acceptEdits/--max-turns/--output-format text/--no-session-persistence/prompt, mesmo padrão de edition-stage-runner.ts", () => {
    const capturedCalls: unknown[][] = [];
    const execFn = ((bin: string, args: string[], opts: unknown) => {
      capturedCalls.push([bin, args, opts]);
      return "ok";
    }) as unknown as typeof import("node:child_process").execFileSync;

    callClaudeCli("meu prompt de crítica", { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude", maxTurns: 5 });

    const [bin, args] = capturedCalls[0] as [string, string[], unknown];
    assert.equal(bin, "/fake/claude");
    assert.deepEqual(args, [
      "--print",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "5",
      "--output-format",
      "text",
      "--no-session-persistence",
      "meu prompt de crítica",
    ]);
  });

  it("com opts.model, inclui --model <valor> antes do prompt (achado de review do #7981: docstring afirmava Sonnet sem garantia em runtime)", () => {
    const capturedCalls: unknown[][] = [];
    const execFn = ((bin: string, args: string[], opts: unknown) => {
      capturedCalls.push([bin, args, opts]);
      return "ok";
    }) as unknown as typeof import("node:child_process").execFileSync;

    callClaudeCli("prompt", { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude", model: "sonnet" });

    const [, args] = capturedCalls[0] as [string, string[], unknown];
    assert.deepEqual(args.slice(-3), ["--model", "sonnet", "prompt"]);
  });

  it("sem opts.model, --model nunca aparece nos args", () => {
    const capturedCalls: unknown[][] = [];
    const execFn = ((bin: string, args: string[], opts: unknown) => {
      capturedCalls.push([bin, args, opts]);
      return "ok";
    }) as unknown as typeof import("node:child_process").execFileSync;

    callClaudeCli("prompt", { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude" });

    const [, args] = capturedCalls[0] as [string, string[], unknown];
    assert.equal(args.includes("--model"), false);
  });

  it("retorna o stdout do execFn", () => {
    const execFn = (() => "texto de resposta") as unknown as typeof import("node:child_process").execFileSync;
    const result = callClaudeCli("prompt", { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude" });
    assert.equal(result, "texto de resposta");
  });

  it("(#8405) falha do subprocesso vira ClaudeCliError com status/stdout/stderr legíveis, NUNCA ecoando o prompt inteiro", () => {
    // O fixture reproduz o que `execFileSync` joga de fato: um Error cuja
    // `.message` é `Command failed: <bin> <argv inteiro>` — com o prompt
    // (~30KB) embutido. Antes do fix, `callClaudeCli` lia `err.message`
    // e ecoava isso na mensagem do ClaudeCliError; o teste anterior não
    // reproduzia isso (a mensagem falsa já trazia `<prompt 30000 chars>`,
    // então o assert passava sem testar nada). Aqui o prompt é real.
    const prompt = "X".repeat(30000);
    const execFn = ((bin: string, args: string[]) => {
      const err = new Error(`Command failed: ${bin} ${args.join(" ")}`);
      (err as { status?: number }).status = 1;
      (err as { stdout?: string }).stdout = "stdout legível";
      (err as { stderr?: string }).stderr = "stderr com a causa real: max_turns esgotado";
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;

    assert.throws(
      () => callClaudeCli(prompt, { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude" }),
      ClaudeCliError,
    );
    try {
      callClaudeCli(prompt, { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude" });
      assert.fail("devia lançar");
    } catch (err) {
      assert.ok(err instanceof ClaudeCliError, "deveria ser ClaudeCliError");
      assert.equal(err.status, 1);
      assert.equal(err.stdout, "stdout legível");
      assert.equal(err.stderr, "stderr com a causa real: max_turns esgotado");
      assert.ok(err.command.includes("/fake/claude"));
      assert.ok(err.command.includes("<prompt 30000 chars>"), "o prompt é substituído por um resumo no command");
      // #8405: a mensagem NUNCA ecoa o prompt inteiro — o argv é truncado.
      assert.ok(!err.message.includes(prompt), "a mensagem não pode ecoar o prompt inteiro");
      assert.ok(err.message.includes("<prompt 30000 chars>"), "o prompt é substituído por um resumo na mensagem");
      assert.ok(!err.message.includes("Command failed:"), "a mensagem não repete a capa do execFileSync");
    }
  });

  it("(#8405) ClaudeCliError preserva os campos mesmo quando o Error do execFileSync não os tiver", () => {
    const execFn = (() => {
      throw new Error("falha qualquer");
    }) as unknown as typeof import("node:child_process").execFileSync;
    try {
      callClaudeCli("prompt", { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude" });
      assert.fail("devia lançar");
    } catch (err) {
      assert.ok(err instanceof ClaudeCliError);
      assert.equal(err.status, null);
      assert.equal(err.stdout, "");
      assert.equal(err.stderr, "");
    }
  });

  it("(#8405) mesmo com um Error genérico que carrega o prompt na message, o prompt não entra na mensagem do ClaudeCliError", () => {
    // Caso de defesa: alguém chama callClaudeCli e o execFn joga um Error
    // qualquer cuja `.message` é o prompt cru (não o formato do execFileSync).
    // O fix não deve confiar em `err.message` em momento algum.
    const prompt = "esse é o prompt de 30 mil caracteres ".repeat(2000);
    const execFn = (() => {
      throw new Error(prompt);
    }) as unknown as typeof import("node:child_process").execFileSync;
    try {
      callClaudeCli(prompt, { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude" });
      assert.fail("devia lançar");
    } catch (err) {
      assert.ok(err instanceof ClaudeCliError);
      assert.equal(err.status, null);
      assert.equal(err.stdout, "");
      assert.equal(err.stderr, "");
      assert.ok(!err.message.includes(prompt), "a mensagem não pode ecoar o prompt, mesmo vindo de um Error genérico");
      assert.ok(err.message.includes("/fake/claude"), "a mensagem é construída a partir do command, não do err.message");
    }
  });

  it("(#8143) com outputFormat:'json', usa '--output-format json' em vez de 'text'", () => {
    const capturedCalls: unknown[][] = [];
    const execFn = ((bin: string, args: string[], opts: unknown) => {
      capturedCalls.push([bin, args, opts]);
      return "{}";
    }) as unknown as typeof import("node:child_process").execFileSync;

    callClaudeCli("prompt", { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude", outputFormat: "json" });

    const [, args] = capturedCalls[0] as [string, string[], unknown];
    const idx = args.indexOf("--output-format");
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], "json");
  });

  it("(#8143) sem outputFormat explícito, continua 'text' (default preservado — holistic-critique.ts depende disso)", () => {
    const capturedCalls: unknown[][] = [];
    const execFn = ((bin: string, args: string[], opts: unknown) => {
      capturedCalls.push([bin, args, opts]);
      return "ok";
    }) as unknown as typeof import("node:child_process").execFileSync;

    callClaudeCli("prompt", { cwd: "/tmp", execFn, resolveClaudeBinFn: () => "/fake/claude" });

    const [, args] = capturedCalls[0] as [string, string[], unknown];
    const idx = args.indexOf("--output-format");
    assert.equal(args[idx + 1], "text");
  });
});
