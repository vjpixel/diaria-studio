/**
 * brave-credits.ts (#1558)
 *
 * Counter persistente de queries Brave Search. Cada chamada bem-sucedida
 * (`status: ok` ou `rate_limited`) vira 1 linha em `data/brave-credits.jsonl`.
 * Queries com `status: error` NÃO contam (não são cobradas pelo Brave).
 *
 * Free tier: 2000 queries/mês. Counter local dá visibilidade imediata —
 * dashboard Brave tem ~1h de delay.
 *
 * ## Semântica de query (#2378)
 *
 * - **1 entrada = 1 query cobrada.** Cada chamada `braveSearch()` que retorna
 *   `ok` ou `rate_limited` gera exactamente 1 entrada via `recordBraveCredit`.
 *   Não há batching — `count` (nº de resultados por query) não afeta o crédito.
 *
 * - **Retries de falha NÃO contam duplo.** Um retry após `status: "error"` não
 *   chama `recordBraveCredit` (o guard `if (ok || rate_limited)` em
 *   `fetch-websearch-batch.ts:201` exclui erros). Se o retry subsequente
 *   retornar `ok`, conta 1 crédito — comportamento correto (Brave cobra o
 *   retry como query nova). Não existe retry automático dentro de `braveSearch`
 *   nem de `fetch-websearch-batch.ts` — um retry é sempre uma nova invocação
 *   externa ao script, não um loop interno que duplicaria o counter.
 *
 * - **Escopo mensal usa UTC de ponta a ponta.** `timestamp` é gravado como
 *   `new Date().toISOString()` (UTC). `monthPrefix` é `now.toISOString()
 *   .slice(0,7)` (UTC). Ambos usam UTC → filtro de mês é consistente
 *   independentemente do timezone da máquina (BRT ou qualquer outro).
 *   O ciclo de 2000 queries/mês do Brave é também UTC-calendário, então
 *   a escolha de UTC é correta (não introduz desvio de 3h vs BRT).
 *
 * - **`daysInMonth` para projeção.** Calculado como
 *   `new Date(getUTCFullYear(), getUTCMonth() + 1, 0).getDate()` — correto:
 *   `Date(year, month+1, 0)` retorna o último dia do mês corrente UTC
 *   independentemente do timezone local da máquina.
 *
 * - **Fonte dos dados:** exclusivamente `data/brave-credits.jsonl` (append-only,
 *   gravado em runtime por `fetch-websearch-batch.ts`). Não há leitura de
 *   Beehiiv, run-log ou qualquer API externa — o counter é 100% local.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export const DEFAULT_PATH = "data/brave-credits.jsonl";

export interface BraveCreditEntry {
  timestamp: string; // ISO 8601
  edition?: string; // AAMMDD when called from edition context
  query: string;
  status: "ok" | "rate_limited";
  http_status?: number;
  quota_remaining?: number; // X-RateLimit-Remaining from Brave API response (#2608 C)
  estimated?: true; // present when entry is an estimate, not a real API call (#2608 A)
  source?: string; // originating agent/step for estimated entries
}

/**
 * Append uma entrada ao log de créditos. Cria dir/arquivo se ausente.
 * No-op silent se path inválido (defensive — counter não pode quebrar pipeline).
 */
function ensureDir(fullPath: string): void {
  const dir = dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function recordBraveCredit(
  entry: Omit<BraveCreditEntry, "timestamp">,
  path: string = DEFAULT_PATH,
): void {
  try {
    const fullPath = resolve(process.cwd(), path);
    ensureDir(fullPath);
    const fullEntry: BraveCreditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(fullPath, JSON.stringify(fullEntry) + "\n", "utf8");
  } catch {
    // Counter não pode quebrar pipeline
  }
}

/**
 * (#2608 A) Estimativa de queries consumidas por agentes Path B (source-researcher /
 * discovery-searcher via harness WebSearch), que não passam por recordBraveCredit().
 *
 * Escreve `count` entradas com `estimated: true` no JSONL. O campo `source` identifica
 * o passo que gerou a estimativa. Hoje a única fonte é `path-b-reconcile`
 * (`scripts/reconcile-brave-path-b.ts`, #2668) — NÃO usar outro `source` pra a mesma
 * edição/mês: o guard de idempotência é keyed em edition+source+mês, então duas
 * fontes distintas pra a mesma edição contariam em dobro. As entradas são somadas em
 * `computeBraveCreditStats` junto das reais, distinguidas em `_estimated` vs `_real`.
 *
 * `now` injetável (default new Date()) — usado p/ monthPrefix (idempotência) E
 * timestamp das entradas, pra ambos ficarem no MESMO mês (sem split em virada de mês).
 */
export function recordBraveCreditEstimate(
  {
    edition,
    source,
    count,
  }: { edition?: string; source: string; count: number },
  path: string = DEFAULT_PATH,
  now: Date = new Date(),
): void {
  if (!Number.isFinite(count)) {
    // #2630 — warn explícito para count não-finito (NaN/±Infinity); não engolir silenciosamente.
    // Causa original: LLM passava expressão não-avaliada ({N}*2+{M}+{J}) que resultava em NaN
    // quando alguma variável era undefined. O gap ficava invisível porque o no-op era silencioso.
    console.warn(
      `[brave-credits] recordBraveCreditEstimate: count não-finito (${count}) — estimativa ignorada.` +
        ` source=${source}, edition=${edition ?? "n/a"}`,
    );
    return;
  }
  if (count <= 0) return;
  count = Math.round(count);
  try {
    const fullPath = resolve(process.cwd(), path);
    ensureDir(fullPath);
    const monthPrefix = now.toISOString().slice(0, 7);
    // Idempotency guard: skip if an estimated entry for this edition+source already exists this month
    if (edition && source && existsSync(fullPath)) {
      const existing = readFileSync(fullPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .some((l) => {
          try {
            const e = JSON.parse(l);
            return (
              e.estimated === true &&
              e.edition === edition &&
              e.source === source &&
              typeof e.timestamp === "string" &&
              e.timestamp.startsWith(monthPrefix)
            );
          } catch {
            return false;
          }
        });
      if (existing) return;
    }
    const ts = now.toISOString();
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const entry: BraveCreditEntry = {
        timestamp: ts,
        query: `[estimated:${source}:${i + 1}/${count}]`,
        status: "ok",
        estimated: true,
        source,
        ...(edition ? { edition } : {}),
      };
      lines.push(JSON.stringify(entry));
    }
    appendFileSync(fullPath, lines.join("\n") + "\n", "utf8");
  } catch {
    // Counter não pode quebrar pipeline
  }
}

export interface BraveCreditStats {
  queries_this_edition: number;
  queries_this_month: number;
  // (#2608 A) breakdown real vs estimated
  queries_this_edition_real: number;
  queries_this_edition_estimated: number;
  queries_this_month_real: number;
  queries_this_month_estimated: number;
  free_tier_limit: number;
  percent_used: number;
  projected_month_end: number | null;
  alert_level: "ok" | "warn" | "critical";
  // (#2608 C) reconciliação com quota real via header X-RateLimit-Remaining
  quota_remaining_last_seen?: number; // last value seen from Brave API header
  delta_untracked?: number; // real_used − local_counted (queries not tracked locally)
  // base do alerta: o MAIOR entre contagem local e uso real do header Brave.
  effective_used: number;
  alert_basis: "local" | "brave_header";
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
      queries_this_edition_real: 0,
      queries_this_edition_estimated: 0,
      queries_this_month_real: 0,
      queries_this_month_estimated: 0,
      free_tier_limit: FREE_TIER_LIMIT,
      percent_used: 0,
      projected_month_end: null,
      alert_level: "ok",
      effective_used: 0,
      alert_basis: "local",
    };
  }

  const content = readFileSync(fullPath, "utf8");
  const lines = content.split("\n").filter(Boolean);

  const monthPrefix = now.toISOString().slice(0, 7); // YYYY-MM
  let queries_this_month_real = 0;
  let queries_this_month_estimated = 0;
  let queries_this_edition_real = 0;
  let queries_this_edition_estimated = 0;
  let quota_remaining_last_seen: number | undefined;

  for (const line of lines) {
    let entry: BraveCreditEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.timestamp !== "string") continue;

    if (!entry.timestamp.startsWith(monthPrefix)) continue;

    // (#2608 C) track last quota_remaining seen — scoped to this month so cross-month
    // values from previous billing cycles don't corrupt delta_untracked at cycle boundaries
    if (typeof entry.quota_remaining === "number") {
      quota_remaining_last_seen = entry.quota_remaining;
    }

    const isEstimated = entry.estimated === true;
    if (isEstimated) {
      queries_this_month_estimated++;
      if (edition && entry.edition === edition) queries_this_edition_estimated++;
    } else {
      queries_this_month_real++;
      if (edition && entry.edition === edition) queries_this_edition_real++;
    }
  }

  const queries_this_month = queries_this_month_real + queries_this_month_estimated;
  const queries_this_edition = queries_this_edition_real + queries_this_edition_estimated;

  // Uso real do header (clamp ≥ 0 — defensivo contra quota_remaining > limite,
  // ex: mudança de API ou janela errada, que daria real_used negativo).
  const real_used =
    typeof quota_remaining_last_seen === "number"
      ? Math.max(0, FREE_TIER_LIMIT - quota_remaining_last_seen)
      : undefined;

  // Alerta AUTORITATIVO: o header X-RateLimit-Remaining do Brave é a verdade —
  // inclui o Path B (WebSearch dos agentes) que NÃO passa pelo counter local.
  // Dirigir o alerta pelo MAIOR entre contagem local e uso real do header, pra
  // nunca subnotificar. (Causa do esgotamento de jun/2026: local=999 mas Brave
  // contava 1951; o alerta confiava nos 999 → "ok" → voamos pelo $5. O contador
  // local sozinho subnotifica ~metade porque o estimate do Path B nunca dispara.)
  let effective_used = queries_this_month;
  let alert_basis: BraveCreditStats["alert_basis"] = "local";
  if (real_used !== undefined && real_used > effective_used) {
    effective_used = real_used;
    alert_basis = "brave_header";
  }

  // (#2608 C) delta = queries cobradas pelo Brave − (reais + estimadas locais).
  // delta ≈ 0 → estimativas corretas; delta > 0 → gap não explicado (Path B > estimativa).
  const delta_untracked =
    real_used !== undefined ? real_used - queries_this_month : undefined;

  // Projeção: extrapolar linear pelo dia do mês. Base = effective_used quando o
  // header é autoritativo (senão a projeção contradiria o alerta: "97% crítico"
  // + "projeção ~5"); senão só queries reais locais (estimativas vêm em lote
  // único no Stage 1 → incluí-las inflaria ~10× a projeção no início do mês).
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  const projectionBase =
    alert_basis === "brave_header" ? effective_used : queries_this_month_real;
  const projected_month_end =
    dayOfMonth > 0 ? Math.round((projectionBase / dayOfMonth) * daysInMonth) : null;

  const percent_used = effective_used / FREE_TIER_LIMIT;
  const alert_level: BraveCreditStats["alert_level"] =
    percent_used >= CRITICAL_THRESHOLD
      ? "critical"
      : percent_used >= WARN_THRESHOLD
        ? "warn"
        : "ok";

  return {
    queries_this_edition,
    queries_this_month,
    queries_this_edition_real,
    queries_this_edition_estimated,
    queries_this_month_real,
    queries_this_month_estimated,
    free_tier_limit: FREE_TIER_LIMIT,
    percent_used: Math.round(percent_used * 10000) / 100, // 2 decimais como %
    projected_month_end,
    alert_level,
    effective_used,
    alert_basis,
    ...(typeof quota_remaining_last_seen === "number" ? { quota_remaining_last_seen } : {}),
    ...(typeof delta_untracked === "number" ? { delta_untracked } : {}),
  };
}
