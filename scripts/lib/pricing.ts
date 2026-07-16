/**
 * pricing.ts (#3441)
 *
 * Tabela de pricing Claude por tier (Opus/Sonnet/Haiku) + resolução por
 * model string + estimativa de custo a partir de tokens reais.
 *
 * Extraído de `scripts/aggregate-costs.ts` (#3439) para reuso por
 * `scripts/capture-stage-usage.ts` (#3441), que precisa da MESMA tabela pra
 * não divergir preço entre o agregador mensal e a captura por-stage.
 *
 * Fonte: skill `claude-api` (cache: 2026-06-24) — Opus $5/$25 por MTok,
 * Sonnet 5 $3/$15 padrão ($2/$10 intro até 2026-08-31), Haiku 4.5 $1/$5.
 * Cache: leitura ~0.1x o preço de input; escrita ~1.25x (TTL 5min, default)
 * ou ~2x (TTL 1h). `usage.cache_creation_input_tokens` não distingue TTL —
 * assumimos 5min (o default do harness) por não termos como saber qual TTL
 * foi usado numa chamada específica. Isso é uma aproximação documentada,
 * não um número fabricado: os TOKENS são reais (lidos do transcript), só o
 * multiplicador de cache-write é uma suposição de TTL-padrão.
 */

export interface PricingEntry {
  inputPer1M: number;
  outputPer1M: number;
}

export const OPUS_PRICING: PricingEntry = { inputPer1M: 5, outputPer1M: 25 };
export const SONNET_PRICING_STANDARD: PricingEntry = { inputPer1M: 3, outputPer1M: 15 };
export const SONNET_PRICING_INTRO: PricingEntry = { inputPer1M: 2, outputPer1M: 10 };
export const HAIKU_PRICING: PricingEntry = { inputPer1M: 1, outputPer1M: 5 };

// Sonnet 5 intro pricing ($2/$10) vale até 2026-08-31 (#3437); depois volta a $3/$15.
export const SONNET_5_INTRO_END = Date.UTC(2026, 7, 31, 23, 59, 59); // month is 0-indexed: 7 = August

// Cache multipliers (skill claude-api § Prompt Caching — Economics).
// Só o de 5min é usado: `estimateCallCostUsd` assume TTL padrão (5min) porque
// `cache_creation_input_tokens` do transcript não distingue qual TTL foi usado
// numa chamada específica (ver comentário do topo do arquivo). O multiplicador
// de 1h (2x) não é aplicável enquanto essa distinção não existir no dado —
// omitido pra não deixar export morto (knip).
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;

/** "AAMMDD" (ex: "260424") → epoch ms (UTC, meio-dia pra evitar off-by-one de fuso). */
export function editionDateMs(edition: string): number | null {
  const m = edition.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  return Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), 12);
}

/**
 * Resolve pricing por tier a partir de um model string livre (ex:
 * "haiku-4-5", "claude-opus-4-7", "gemini", "sonnet-4-6"). Retorna `null` pra
 * modelos não-Claude (ex: Gemini na Etapa 3) — não há tier a precificar.
 */
export function resolvePricing(modelString: string, dateMs: number | null): PricingEntry | null {
  const s = modelString.toLowerCase();
  if (s.includes("opus")) return OPUS_PRICING;
  if (s.includes("sonnet")) {
    const isIntro = dateMs !== null && dateMs <= SONNET_5_INTRO_END;
    return isIntro ? SONNET_PRICING_INTRO : SONNET_PRICING_STANDARD;
  }
  if (s.includes("haiku")) return HAIKU_PRICING;
  return null;
}

/** Usage bruto de uma entrada do transcript (`message.usage` da API). */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Estima custo USD de UMA chamada a partir do usage real (tokens) + model +
 * data efetiva (pra resolver pricing intro vs standard). Aplica os
 * multiplicadores de cache documentados acima. Retorna `null` quando o
 * modelo não é Claude (não há tier a precificar) — chamador deve tratar como
 * "sem custo atribuível", não como zero.
 */
export function estimateCallCostUsd(usage: RawUsage, modelString: string, dateMs: number | null): number | null {
  const pricing = resolvePricing(modelString, dateMs);
  if (!pricing) return null;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputCost = (input / 1_000_000) * pricing.inputPer1M;
  const outputCost = (output / 1_000_000) * pricing.outputPer1M;
  const cacheWriteCost = (cacheWrite / 1_000_000) * pricing.inputPer1M * CACHE_WRITE_5M_MULTIPLIER;
  const cacheReadCost = (cacheRead / 1_000_000) * pricing.inputPer1M * CACHE_READ_MULTIPLIER;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

/**
 * Estima custo de um stage inteiro a partir de tokens_in/tokens_out
 * agregados (sem breakdown de cache) — usado quando só temos o total, não
 * cada chamada individual (ex: `aggregate-costs.ts` lendo `stage-status.json`
 * já consolidado). Só dá pra atribuir quando `models` lista exatamente 1
 * tier Claude — retorna `undefined` quando não é possível estimar (0 ou 2+
 * modelos, ou modelo não-Claude).
 */
export function estimateAggregateCostUsd(
  tokensIn: number,
  tokensOut: number,
  models: string[],
  dateMs: number | null,
): number | undefined {
  if (models.length !== 1) return undefined;
  const pricing = resolvePricing(models[0], dateMs);
  if (!pricing) return undefined;
  const inputCost = (tokensIn / 1_000_000) * pricing.inputPer1M;
  const outputCost = (tokensOut / 1_000_000) * pricing.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Nome curto de modelo pra exibição (ex: "claude-opus-4-8" → "opus-4-8",
 * "claude-haiku-4-5-20251001" → "haiku-4-5"). Usado nas colunas `Modelos` de
 * `stage-status.md` — mesma convenção já usada em docs/prompts
 * ("haiku-4-5", "opus-4-7", "sonnet-4-6").
 */
export function shortModelName(modelString: string): string {
  let s = modelString;
  if (s.startsWith("claude-")) s = s.slice("claude-".length);
  // Strip a trailing dated snapshot suffix (ex: -20251001), if present.
  s = s.replace(/-\d{8}$/, "");
  return s;
}
