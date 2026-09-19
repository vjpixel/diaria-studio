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

/**
 * Exceção estruturada lançada por `callClaudeCli` quando o subprocesso
 * `claude --print` sai com erro. `execFileSync` já captura `status`/
 * `stdout`/`stderr` no objeto de erro que joga (`Command failed: …`),
 * mas o `catch` de quem chama `callClaudeCli` (ex:
 * `run-agent-eval-for-pr.ts::main`) imprimia só `error.message` — que é
 * `Command failed: <cmd + argv inteiro>`, ecoando ~30KB de prompt e
 * deixando o `error.stderr` (onde está a causa real) invisível (#8405).
 *
 * Esta classe preserva o `stderr`/`stdout`/`status` como campos
 * programáticos (quem quiser tratar o erro pode lê-los) e monta uma
 * mensagem legível que NUNCA ecoa o prompt inteiro — o resumo do
 * comando substitui o argv por `<prompt N chars>`.
 */
export class ClaudeCliError extends Error {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly command: string;

  constructor(
    message: string,
    opts: { status: number | null; stdout: string; stderr: string; command: string },
  ) {
    super(message);
    this.name = "ClaudeCliError";
    this.status = opts.status;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.command = opts.command;
    Object.setPrototypeOf(this, ClaudeCliError.prototype);
  }
}

/** Trunca um texto pro exibição, mantendo o inteiro disponível no campo `.stderr` do erro. */
function preview(text: string, max = 1200): string {
  return text.length > max ? text.slice(0, max) + `\n… [${text.length - max} chars ocultos na mensagem — leia err.stderr para o inteiro]` : text;
}

export interface ClaudeCliCallOptions {
  cwd: string;
  /** Env BRUTO (não-filtrado) do chamador — `claudeCliEnv()` roda por cima, sempre. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  maxTurns?: number;
  /** Nome do modelo pro `--model` do CLI (ex: "sonnet"). Sem isto, o CLI usa o default do ambiente — achado de review do #7981 (comment-analyzer, P2): a docstring de `holistic-critique.ts` afirmava "Sonnet, effort baixo" sem NENHUM flag garantindo isso; quem quiser a garantia agora passa este campo explicitamente (mesmo espírito do `model: sonnet` explícito exigido pro dispatch de subagentes ad-hoc, CLAUDE.md). */
  model?: string;
  /**
   * `"text"` (default, preserva o comportamento anterior a #8143 — resposta
   * crua, é o que `holistic-critique.ts` espera pra casar `VEREDITO:`/
   * `JUSTIFICATIVA:` via regex) ou `"json"` (#8143, eval de regressão de
   * prompt — `--output-format json` do CLI devolve usage/custo estruturado
   * junto da resposta, que `parseClaudeCliJsonResult`
   * (`prompt-regression-eval.ts`) parseia pra gravar custo MEDIDO, não
   * estimado, de cada replay). O retorno desta função continua sendo a
   * string crua nos dois casos — quem pede `"json"` faz o próprio
   * `JSON.parse`.
   */
  outputFormat?: "text" | "json";
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

  const args = ["--print", "--permission-mode", "acceptEdits", "--max-turns", String(maxTurns), "--output-format", opts.outputFormat ?? "text", "--no-session-persistence"];
  if (opts.model) args.push("--model", opts.model);
  args.push(prompt);

  const bin = resolveClaudeBinFn();
  const command = `${bin} ${args.map((a) => (a === prompt ? `<prompt ${prompt.length} chars>` : a)).join(" ")}`;
  try {
    return execFn(bin, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: filteredEnv,
    });
  } catch (err) {
    // #8405: `execFileSync` joga um Error cujo `.message` é `Command failed: <cmd + argv inteiro>`
    // e que carrega `status`/`stdout`/`stderr` — o stdout/stderr é onde está a causa real
    // (ex: `--max-turns` esgotado, `maxBuffer` estourado, cwd sem permissão). Reencapsulamos
    // como ClaudeCliError pra o chamador poder ler esses campos sem ecoar o prompt inteiro.
    const status = (err as { status?: number | null }).status ?? null;
    const stdout = (err as { stdout?: string }).stdout ?? "";
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const msg = err instanceof Error ? err.message : String(err);
    throw new ClaudeCliError(
      `claude CLI falhou (status ${status ?? "sinal"}): ${msg.replace(/^Command failed: /, "")}`,
      { status, stdout, stderr, command },
    );
  }
}
