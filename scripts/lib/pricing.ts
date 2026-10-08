/**
 * pricing.ts (#3441)
 *
 * Tabela de pricing Claude por modelo (Opus 5.5/Opus/Sonnet/Haiku) + resolução por
 * model string + estimativa de custo a partir de tokens reais.
 *
 * Extraído de `scripts/aggregate-costs.ts` (#3439) para reuso por
 * `scripts/capture-stage-usage.ts` (#3441), que precisa da MESMA tabela pra
 * não divergir preço entre o agregador mensal e a captura por-stage.
 *
 * Fonte e valores por modelo: ver constantes abaixo (#9003 corrigiu Sonnet
 * 2/10 sem virada e Opus 5.5 4/20 com leitura de cache 0,05x). ATENÇÃO: o
 * `cost_usd` já gravado em `stage-status.json` de setembro/2026 foi calculado
 * com a tabela antiga (Sonnet a 3/15 ≈ 1,5x inflado; Opus 5.5 a 5/25) — relatórios
 * de custo que leiam esses arquivos superestimam; só edições capturadas depois
 * do #9003 usam o preço real.
 * Cache: escrita ~1.25x (TTL 5min, default)
 * ou ~2x (TTL 1h). `usage.cache_creation_input_tokens` não distingue TTL —
 * assumimos 5min (o default do harness) por não termos como saber qual TTL
 * foi usado numa chamada específica. Isso é uma aproximação documentada,
 * não um número fabricado: os TOKENS são reais (lidos do transcript), só o
 * multiplicador de cache-write é uma suposição de TTL-padrão.
 */

export interface PricingEntry {
  inputPer1M: number;
  outputPer1M: number;
  /** Multiplicador de leitura de cache sobre o preço de input (por modelo, #9003). */
  cacheReadMultiplier: number;
}

// Preços oficiais (docs.claude.com/pricing, conferidos 2026-09-29, #9003):
//   Opus 5.5 $4/$20, leitura de cache 0,05x ($0,20/MTok)
//   Opus 5 / 4.x $5/$25, leitura 0,1x
//   Sonnet 5 e 5.5 $2/$10, leitura 0,1x — o aumento para $3/$15 de 01/09 foi
//     CANCELADO, então não existe mais virada por data.
//   Haiku 4.5 $1/$5, leitura 0,1x
export const OPUS_5_5_PRICING: PricingEntry = { inputPer1M: 4, outputPer1M: 20, cacheReadMultiplier: 0.05 };
export const OPUS_PRICING: PricingEntry = { inputPer1M: 5, outputPer1M: 25, cacheReadMultiplier: 0.1 };
export const SONNET_PRICING: PricingEntry = { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.1 };
export const HAIKU_PRICING: PricingEntry = { inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.1 };

// Escrita de cache: 1,25x (TTL 5min, default do harness). `cache_creation_input_tokens`
// do transcript não distingue TTL; o de 1h (2x) não é aplicável enquanto essa
// distinção não existir no dado.
const CACHE_WRITE_5M_MULTIPLIER = 1.25;

/** "AAMMDD" (ex: "260424") → epoch ms (UTC, meio-dia pra evitar off-by-one de fuso). */
export function editionDateMs(edition: string): number | null {
  const m = edition.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  return Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), 12);
}

/**
 * IDs Claude com preço CONFERIDO, por chave normalizada `{família}-{major}[-{minor}]`
 * (#9876). Só entra aqui modelo cujo preço está na tabela oficial citada acima —
 * nunca por família: `haiku-5-5` não é `haiku-4-5`, e cobrar o preço de um pelo
 * outro em silêncio é exatamente o bug que esta tabela fecha. Modelo novo →
 * adicionar a linha com o preço conferido (e o teste em `test/pricing.test.ts`).
 *
 * Fora de propósito: `opus-4`/`opus-4-1` ($15/$75) e `sonnet-4-x` ($3/$15) têm
 * preço diferente do tier que o casamento por substring lhes dava; como nenhum
 * dado do repo os usa, ficam fora (→ `null`) em vez de precificados errado.
 */
const KNOWN_MODEL_PRICING: Readonly<Record<string, PricingEntry>> = {
  "opus-5-5": OPUS_5_5_PRICING,
  "opus-5": OPUS_PRICING,
  "opus-4-8": OPUS_PRICING,
  "opus-4-7": OPUS_PRICING,
  "opus-4-6": OPUS_PRICING,
  "opus-4-5": OPUS_PRICING,
  "sonnet-5-5": SONNET_PRICING,
  "sonnet-5": SONNET_PRICING,
  "haiku-4-5": HAIKU_PRICING,
};

/**
 * Normaliza um model string livre na chave de `KNOWN_MODEL_PRICING`: minúsculo,
 * `.` → `-` (`opus-5.5`), sem prefixo até `claude-` (inclui `us.anthropic.`), sem
 * sufixo de snapshot datado (`-20251001`) nem de contexto (`[1m]`). Devolve `null`
 * quando o formato não é `{opus|sonnet|haiku}-{major}[-{minor}]` — inclusive o
 * alias sem versão (`sonnet`, `haiku`), que não diz QUAL preço.
 */
export function normalizeModelKey(modelString: string): string | null {
  let s = modelString.trim().toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/\./g, "-");
  const claudeAt = s.lastIndexOf("claude-");
  if (claudeAt >= 0) s = s.slice(claudeAt + "claude-".length);
  s = s.replace(/-\d{8}$/, "");
  const m = s.match(/^(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?$/);
  if (!m) return null;
  return m[3] !== undefined ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}

/**
 * Resolve pricing a partir de um model string livre (ex: "haiku-4-5",
 * "claude-opus-5-5", "claude-haiku-4-5-20251001"). Casa só IDs conhecidos
 * (`KNOWN_MODEL_PRICING`, #9876): modelo não-Claude (Gemini na Etapa 3), alias
 * sem versão e versão Claude sem preço conferido (ex: `claude-haiku-5-5`) →
 * `null` = "sem custo atribuível", nunca o preço de outra versão da família.
 */
export function resolvePricing(modelString: string, _dateMs?: number | null): PricingEntry | null {
  const key = normalizeModelKey(modelString);
  if (key === null) return null;
  return KNOWN_MODEL_PRICING[key] ?? null;
}

/** Usage bruto de uma entrada do transcript (`message.usage` da API). */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Estima custo USD de UMA chamada a partir do usage real (tokens) + model.
 * `dateMs` é ignorado desde #9003 (sem virada de preço por data). Aplica os
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
  const cacheReadCost = (cacheRead / 1_000_000) * pricing.inputPer1M * pricing.cacheReadMultiplier;
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
