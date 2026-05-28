/**
 * brave-credits.ts (#1558)
 *
 * Counter persistente de queries Brave Search. Cada chamada bem-sucedida
 * (`status: ok` ou `rate_limited`) vira 1 linha em `data/brave-credits.jsonl`.
 * Queries com `status: error` NÃO contam (não são cobradas pelo Brave).
 *
 * Free tier: 2000 queries/mês. Counter local dá visibilidade imediata —
 * dashboard Brave tem ~1h de delay.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const DEFAULT_PATH = "data/brave-credits.jsonl";

export interface BraveCreditEntry {
  timestamp: string; // ISO 8601
  edition?: string; // AAMMDD when called from edition context
  query: string;
  status: "ok" | "rate_limited";
  http_status?: number;
}

/**
 * Append uma entrada ao log de créditos. Cria dir/arquivo se ausente.
 * No-op silent se path inválido (defensive — counter não pode quebrar pipeline).
 */
export function recordBraveCredit(
  entry: Omit<BraveCreditEntry, "timestamp">,
  path: string = DEFAULT_PATH,
): void {
  try {
    const fullPath = resolve(process.cwd(), path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const fullEntry: BraveCreditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(fullPath, JSON.stringify(fullEntry) + "\n", "utf8");
  } catch {
    // Counter não pode quebrar pipeline
  }
}

export interface BraveCreditStats {
  queries_this_edition: number;
  queries_this_month: number;
  free_tier_limit: number;
  percent_used: number;
  projected_month_end: number | null;
  alert_level: "ok" | "warn" | "critical";
}

const FREE_TIER_LIMIT = 2000;
const WARN_THRESHOLD = 0.8;
const CRITICAL_THRESHOLD = 0.95;

/**
 * Pure: lê o JSONL, filtra por mês corrente (e edição se informada),
 * retorna stats agregadas. Linhas inválidas são puladas silently.
 */
export function computeBraveCreditStats(
  edition: string | null = null,
  path: string = DEFAULT_PATH,
  now: Date = new Date(),
): BraveCreditStats {
  const fullPath = resolve(process.cwd(), path);
  if (!existsSync(fullPath)) {
    return {
      queries_this_edition: 0,
      queries_this_month: 0,
      free_tier_limit: FREE_TIER_LIMIT,
      percent_used: 0,
      projected_month_end: null,
      alert_level: "ok",
    };
  }

  const content = readFileSync(fullPath, "utf8");
  const lines = content.split("\n").filter(Boolean);

  const monthPrefix = now.toISOString().slice(0, 7); // YYYY-MM
  let queries_this_month = 0;
  let queries_this_edition = 0;

  for (const line of lines) {
    let entry: BraveCreditEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.timestamp !== "string" || !entry.timestamp.startsWith(monthPrefix)) continue;
    queries_this_month++;
    if (edition && entry.edition === edition) queries_this_edition++;
  }

  // Projeção: extrapolar baseado no dia do mês (linear)
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  const projected_month_end =
    dayOfMonth > 0
      ? Math.round((queries_this_month / dayOfMonth) * daysInMonth)
      : null;

  const percent_used = queries_this_month / FREE_TIER_LIMIT;
  const alert_level: BraveCreditStats["alert_level"] =
    percent_used >= CRITICAL_THRESHOLD
      ? "critical"
      : percent_used >= WARN_THRESHOLD
        ? "warn"
        : "ok";

  return {
    queries_this_edition,
    queries_this_month,
    free_tier_limit: FREE_TIER_LIMIT,
    percent_used: Math.round(percent_used * 10000) / 100, // 2 decimais como %
    projected_month_end,
    alert_level,
  };
}
