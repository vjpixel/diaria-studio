/**
 * scripts/lib/claude-cli-subprocess.ts (#7981, Camada 3 da #7972 — Fase 7)
 *
 * Wrapper único e testável pra QUALQUER subprocesso `claude --print` que
 * `distill-prompt-corrections.ts` precisar spawnar (crítica holística via
 * `social-critic.md`). Restrição de design NÃO-NEGOCIÁVEL da issue #7981:
 * reusar o MESMO mecanismo de filtragem de ambiente de
 * `scripts/overnight/run-scheduled-edicao.ts` — nunca reimplementar, nunca
 * abrir uma 2ª cópia da lista de vars que degradaria em silêncio se a
 * original crescesse (#5608/#6714, ver docstring de `CLAUDE_CLI_STRIPPED_ENV_VARS`
 * pro histórico completo do porquê de cada var).
 *
 * `claudeCliEnv` é importado, não reimplementado — este arquivo SEMPRE
 * filtra o ambiente antes de montar o subprocesso, mesmo que o chamador
 * já tenha passado um `env` "limpo" (defesa em profundidade: filtrar 2x é
 * barato, esquecer de filtrar 1x é o incidente #6714).
 *
 * Mesmo padrão de injeção de `execFn`/`resolveClaudeBinFn` de
 * `run-scheduled-edicao.ts`/`edition-stage-runner.ts` — testável sem
 * depender de um binário `claude` real existir no CI.
 */

import { execFileSync } from "node:child_process";
import { resolveClaudeBin } from "./resolve-claude-bin.ts";
import { claudeCliEnv } from "../overnight/run-scheduled-edicao.ts";

export interface ClaudeCliCallOptions {
  cwd: string;
  /** Env BRUTO (não-filtrado) do chamador — `claudeCliEnv()` roda por cima, sempre. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  maxTurns?: number;
  execFn?: typeof execFileSync;
  resolveClaudeBinFn?: typeof resolveClaudeBin;
}

const DEFAULT_MAX_TURNS = 20;

/**
 * 1 chamada single-turn a `claude --print`, ambiente SEMPRE filtrado por
 * `claudeCliEnv` (importado de `run-scheduled-edicao.ts`, nunca
 * reimplementado — a restrição não-negociável da #7981). Lança se o
 * processo sair com erro (`execFileSync` já faz isso nativamente) — sem
 * fallback silencioso pra string vazia.
 */
export function callClaudeCli(prompt: string, opts: ClaudeCliCallOptions): string {
  const execFn = opts.execFn ?? execFileSync;
  const resolveClaudeBinFn = opts.resolveClaudeBinFn ?? resolveClaudeBin;
  const rawEnv = opts.env ?? process.env;
  const filteredEnv = claudeCliEnv(rawEnv);
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  return execFn(
    resolveClaudeBinFn(),
    ["--print", "--permission-mode", "acceptEdits", "--max-turns", String(maxTurns), "--output-format", "text", "--no-session-persistence", prompt],
    {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: filteredEnv,
    },
  );
}
