/**
 * scripts/lib/usage-breakdown.ts (#14115)
 *
 * Quebra do uso de um stage que o total agregado esconde, nos dois caminhos
 * de medição de `stage-status.json`:
 *
 * - **Por modelo** (`model_usage`). O total de `cost_usd`/`tokens_in` soma
 *   opus e sonnet num número só (a 261125 teve `opus-5-5` e `sonnet-5-5` no
 *   mesmo stage). O envelope `claude --print --output-format json` já traz
 *   `modelUsage` por modelo (`parseCliModelUsage`); o transcript local traz o
 *   `model` de cada resposta (`modelUsageFromEntries`).
 * - **Turnos e contexto** (`turn_stats`, só no caminho do transcript): turnos
 *   do thread principal, contexto do 1º turno (a base fixa: system prompt,
 *   CLAUDE.md, tools), mediana e máximo de contexto por turno, e a separação
 *   cache_read x cache_creation x input sem cache.
 *
 * Coordenador x subagente no caminho `cli_json`: o envelope não separa (o
 * `modelUsage` soma o processo inteiro, subagentes incluídos) e o
 * `--no-session-persistence` do runner impede ler o transcript. Separar
 * exigiria tirar essa flag, o que fica para o editor decidir (#14115). O
 * `model_usage` ainda ajuda: no pipeline o coordenador e os subagentes rodam
 * em modelos diferentes na maior parte dos stages.
 *
 * Núcleo puro, sem IO. Nunca lê nem devolve conteúdo de conversa, só números.
 */

import { shortModelName } from "./pricing.ts";
import type { UsageEntry } from "./session-transcript.ts";

/** Tokens (e custo, quando conhecido) de UM modelo. Chaves em snake_case, como o resto de `stage-status.json`. */
export interface ModelUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Ausente quando o custo do modelo não é conhecido (modelo sem tabela de preço). */
  cost_usd?: number;
}

/** Chave = `shortModelName` do modelo (mesma convenção de `models`). */
export type ModelUsageMap = Record<string, ModelUsageTotals>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round9 = (v: number): number => Math.round(v * 1e9) / 1e9;

function addTotals(a: ModelUsageTotals | undefined, b: ModelUsageTotals): ModelUsageTotals {
  if (!a) return { ...b };
  const out: ModelUsageTotals = {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
  // Custo só quando os dois lados o conhecem: somar um lado sem custo daria
  // um número menor que o real com cara de completo.
  if (a.cost_usd !== undefined && b.cost_usd !== undefined) out.cost_usd = round9(a.cost_usd + b.cost_usd);
  return out;
}

/**
 * `modelUsage` do envelope `--output-format json` (chaves camelCase do CLI:
 * `inputTokens`, `outputTokens`, `cacheReadInputTokens`,
 * `cacheCreationInputTokens`, `costUSD`) → `ModelUsageMap`. Modelos que
 * colapsam no mesmo `shortModelName` são somados. `null` quando o campo está
 * ausente, não é objeto ou não tem nenhum modelo legível.
 */
export function parseCliModelUsage(modelUsage: unknown): ModelUsageMap | null {
  if (typeof modelUsage !== "object" || modelUsage === null || Array.isArray(modelUsage)) return null;
  const out: ModelUsageMap = {};
  for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const totals: ModelUsageTotals = {
      input_tokens: num(r.inputTokens),
      output_tokens: num(r.outputTokens),
      cache_read_input_tokens: num(r.cacheReadInputTokens),
      cache_creation_input_tokens: num(r.cacheCreationInputTokens),
    };
    if (typeof r.costUSD === "number" && Number.isFinite(r.costUSD)) totals.cost_usd = r.costUSD;
    const key = shortModelName(model);
    out[key] = addTotals(out[key], totals);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Soma dois mapas por modelo (retry/re-run de um stage CLI, #9312). */
export function mergeModelUsage(a: ModelUsageMap | undefined, b: ModelUsageMap): ModelUsageMap {
  const out: ModelUsageMap = { ...(a ?? {}) };
  for (const [model, totals] of Object.entries(b)) out[model] = addTotals(out[model], totals);
  return out;
}

/**
 * Mapa por modelo a partir das entradas do transcript. `costOf` devolve o
 * custo de uma entrada ou `null` (modelo sem preço): um modelo com qualquer
 * entrada sem custo sai sem `cost_usd`.
 */
export function modelUsageFromEntries(
  entries: readonly UsageEntry[],
  costOf: (e: UsageEntry) => number | null,
): ModelUsageMap {
  const out: ModelUsageMap = {};
  const costless = new Set<string>();
  for (const e of entries) {
    const key = shortModelName(e.model);
    const cost = costOf(e);
    if (cost === null) costless.add(key);
    const totals: ModelUsageTotals = {
      input_tokens: e.inputTokens,
      output_tokens: e.outputTokens,
      cache_read_input_tokens: e.cacheReadInputTokens,
      cache_creation_input_tokens: e.cacheCreationInputTokens,
      cost_usd: cost ?? 0,
    };
    out[key] = addTotals(out[key], totals);
  }
  for (const key of costless) delete out[key].cost_usd;
  for (const t of Object.values(out)) if (t.cost_usd !== undefined) t.cost_usd = Math.round(t.cost_usd * 1e6) / 1e6;
  return out;
}

/** Turnos e contexto de uma janela do transcript (#14115 item 2). */
export interface TurnStats {
  /** Respostas da API no thread principal (coordenador), deduplicadas por `message.id`. */
  num_turns: number;
  /** Respostas da API de subagentes (`isSidechain`). */
  subagent_turns: number;
  /** Contexto (input + cache_read + cache_creation) do 1º turno principal: a base fixa da sessão. `null` sem turno principal. */
  context_first: number | null;
  /** Mediana do contexto por turno principal. */
  context_median: number | null;
  /** Maior contexto de um turno principal. */
  context_max: number | null;
  /** Totais da janela inteira (principal + subagentes). */
  cache_read_tokens: number;
  cache_creation_tokens: number;
  uncached_input_tokens: number;
}

function contextOf(e: UsageEntry): number {
  return e.inputTokens + e.cacheReadInputTokens + e.cacheCreationInputTokens;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

/** @pure */
export function summarizeTurnStats(entries: readonly UsageEntry[]): TurnStats {
  const main = entries
    .filter((e) => !e.isSidechain)
    .map((e) => ({ ts: Date.parse(e.timestamp), ctx: contextOf(e) }))
    .sort((a, b) => (Number.isFinite(a.ts) && Number.isFinite(b.ts) ? a.ts - b.ts : 0));
  const contexts = main.map((m) => m.ctx);
  let cacheRead = 0;
  let cacheCreation = 0;
  let uncached = 0;
  for (const e of entries) {
    cacheRead += e.cacheReadInputTokens;
    cacheCreation += e.cacheCreationInputTokens;
    uncached += e.inputTokens;
  }
  return {
    num_turns: main.length,
    subagent_turns: entries.length - main.length,
    context_first: main.length > 0 ? main[0].ctx : null,
    context_median: median(contexts),
    context_max: contexts.length > 0 ? Math.max(...contexts) : null,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    uncached_input_tokens: uncached,
  };
}
