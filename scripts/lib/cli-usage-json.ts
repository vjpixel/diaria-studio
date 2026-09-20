/**
 * scripts/lib/cli-usage-json.ts (#8560)
 *
 * Parseia o resultado de `claude --print --output-format json` para extrair
 * custo/tokens REAIS medidos pelo próprio CLI, sem depender do transcript
 * local em `~/.claude/projects/` (`scripts/lib/session-transcript.ts`).
 *
 * ## Por que isto existe — causa raiz do #8560
 *
 * A hipótese original da issue era que `capture-stage-usage.ts` não achava
 * o transcript CERTO dos Stages 1-3 (rodados por
 * `scripts/lib/edition-stage-runner.ts`, #5744, cada um num processo
 * `claude --print` isolado) e sugeria passar `--session-id` explícito pra
 * consertar a busca. **Não é isso.** Confirmado ao vivo (20/09/2026):
 * `edition-stage-runner.ts` já passa `--no-session-persistence` em TODO
 * spawn, e `claude --help` documenta essa flag como "sessions will not be
 * saved to disk and cannot be resumed" — ou seja, NENHUM transcript é
 * escrito, para NENHUM stage isolado, com QUALQUER `--session-id` que se
 * passe. Não há arquivo a achar. Isso explica os dois sintomas da issue:
 * Stage 1 (que tem `stage-1-run.ts` chamando `capture-stage-usage.ts`
 * deterministicamente) loga a falha `session_filter_fallback_session_file_
 * not_found`; Stages 2/3 (chamada só em PROSA no playbook do orchestrator,
 * `.claude/agents/orchestrator-stage-{2,3}.md`) nem chegam a rodar o passo
 * dentro do processo `--print` de turnos limitados — por isso a issue nunca
 * viu NENHUM evento de falha pra eles, e não só "sem sucesso".
 *
 * A correção real: `claude --print --output-format json` devolve, no
 * próprio stdout, um objeto único com `total_cost_usd` (custo já calculado
 * pelo CLI — mais preciso que a tabela própria de `scripts/lib/pricing.ts`,
 * sem aproximação de TTL de cache) e `usage`/`modelUsage` (tokens agregados
 * de TODOS os turnos da sessão, subagentes internos incluídos). Isso não
 * depende de disco nenhum fora do próprio stdout — funciona idêntico com ou
 * sem `--no-session-persistence`, e cobre TODO stage spawnado por
 * `edition-stage-runner.ts` (1-4) de uma vez, sem precisar reproduzir a
 * mesma lógica de sessão/transcript que só existe pra sessões LOCAIS
 * persistidas. Confirmado ao vivo contra uma chamada real `claude --print
 * --output-format json --max-turns 1`:
 *
 *   {"total_cost_usd":0.278,"usage":{"input_tokens":2,
 *    "cache_creation_input_tokens":68420,"cache_read_input_tokens":18544,
 *    "output_tokens":4,...},"modelUsage":{"claude-sonnet-5":{...},...},
 *    "result":"pong",...}
 *
 * `capture-stage-usage.ts`/`session-transcript.ts` continuam corretos e
 * necessários para os Stages 0/rodadas interativas (sessão local persistida
 * de verdade) — este módulo é um caminho ADICIONAL, específico do stdout
 * `--output-format json`, não uma substituição.
 *
 * Núcleo puro — sem IO, testável com fixtures de string.
 */

import { shortModelName } from "./pricing.ts";

export interface CliJsonUsage {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  models: string[];
}

/**
 * `null` quando `raw` não é um objeto JSON válido, ou não carrega os campos
 * mínimos (`total_cost_usd` numérico finito + `usage` objeto) — nunca
 * fabrica zero/custo parcial a partir de dado ausente ou malformado.
 */
export function parseCliJsonUsage(raw: string): CliJsonUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.total_cost_usd !== "number" || !Number.isFinite(obj.total_cost_usd)) return null;
  const usage = obj.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const tokensIn = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  const tokensOut = num(u.output_tokens);

  const modelUsage = obj.modelUsage;
  const models =
    typeof modelUsage === "object" && modelUsage !== null
      ? [...new Set(Object.keys(modelUsage as Record<string, unknown>).map(shortModelName))].sort()
      : [];

  return { costUsd: obj.total_cost_usd, tokensIn, tokensOut, models };
}

/**
 * Extrai o texto de resposta final (`result`) do stdout `--output-format
 * json` — usado pelos consumidores que faziam substring-match no texto puro
 * (`looksLikeBackgroundWaitExit`, `summarizeFailure` em
 * `edition-stage-runner.ts`) enquanto o spawn usava `--output-format text`.
 * Sem isto, trocar pra `json` faria esses dois lerem o objeto JSON inteiro
 * como se fosse texto humano — ainda funcional (substring sobrevive dentro
 * de JSON), mas com ruído estrutural que este helper evita.
 *
 * Devolve `raw` sem alteração quando não parseia como JSON com campo
 * `result` string — cobre o caminho de exceção (stderr puro, não
 * necessariamente JSON), preservando o comportamento anterior sem regressão.
 */
export function resultTextOrRaw(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.result === "string") return parsed.result;
  } catch {
    // não é JSON (ex: stderr/exception no caminho de falha) — usa raw como está
  }
  return raw;
}
