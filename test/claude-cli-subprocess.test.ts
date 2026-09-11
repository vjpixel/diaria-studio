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
import { callClaudeCli } from "../scripts/lib/claude-cli-subprocess.ts";
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
});
