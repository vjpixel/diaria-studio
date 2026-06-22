/**
 * count-subscriptions-by-utm.ts (#2457)
 *
 * Script de análise read-only: agrega assinantes do Beehiiv por `utm_source`
 * para rastrear quantos chegaram via newsletter mensal Clarice (Brevo).
 *
 * O link de inscrição da diária que sai DENTRO da mensal deve carregar
 * `?utm_source=mensal-brevo` — assim este script consegue identificar os
 * assinantes da diária que vieram por esse canal. Ver seção "Configuração"
 * abaixo sobre onde adicionar o parâmetro.
 *
 * ## Configuração do utm_source na mensal (ação do editor)
 *
 * O link de inscrição da diária que aparece no ENCERRAMENTO da mensal
 * (escrito pelo `writer-monthly`) deve usar:
 *
 *   https://diar.ia.br/?utm_source=mensal-brevo
 *
 * Esse link não está hardcoded no código — o `writer-monthly` o gera via
 * `context/templates/newsletter-monthly.md` (seção ENCERRAMENTO). O editor
 * deve garantir que o rascunho e o template contenham essa URL com o parâmetro.
 * O Beehiiv captura automaticamente `utm_source` quando alguém se inscreve
 * clicando num link com esse parâmetro.
 *
 * ## Uso
 *
 *   npx tsx scripts/count-subscriptions-by-utm.ts
 *   npx tsx scripts/count-subscriptions-by-utm.ts --source mensal-brevo
 *   npx tsx scripts/count-subscriptions-by-utm.ts --json
 *
 * Flags:
 *   --source <nome>   Filtra para exibir detalhes só de uma fonte específica.
 *   --json            Emite o resultado como JSON (stdout) para uso em pipelines.
 *
 * ## Saída
 *
 * Sem --json: tabela no stderr + total por utm_source.
 * Com --json: { counts: Record<string, number>, total: number, fetched_at: string }
 *
 * Env:
 *   BEEHIIV_API_KEY           obrigatório
 *   BEEHIIV_PUBLICATION_ID    opcional — fallback p/ platform.config.json
 *   BEEHIIV_API_URL           opcional — override para tests
 *
 * Exit codes: 0=sucesso, 1=erro de API, 2=config inválida.
 */

import "dotenv/config";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";

const BEEHIIV_API = process.env.BEEHIIV_API_URL ?? "https://api.beehiiv.com/v2";
const PER_PAGE = 100;
const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 5;

/** Campos de UTM que o Beehiiv expõe na subscription. */
export interface SubscriptionUtm {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_channel: string | null;
  referring_site: string | null;
}

/** Subscription com apenas os campos de atribuição que nos interessam. */
export interface SubscriptionAttribution {
  id: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_channel: string | null;
  referring_site: string | null;
}

/** Resultado agregado por utm_source. */
export interface UtmCountResult {
  counts: Record<string, number>;
  total: number;
  fetched_at: string;
}

/**
 * Normaliza o valor de utm_source:
 * - null / undefined / "" → "__none__" (sem UTM)
 * - qualquer outro valor → lowercase trimmed
 *
 * @pure testável sem I/O
 */
export function normalizeUtmSource(raw: unknown): string {
  if (raw == null) return "__none__";
  const s = String(raw).trim().toLowerCase();
  return s === "" ? "__none__" : s;
}

/**
 * Agrega um array de subscription objects por utm_source normalizado.
 *
 * @pure testável sem I/O
 *
 * @param subs  Array de objetos com pelo menos `{ utm_source?: unknown }`.
 * @returns     Map com contagem por utm_source (key "__none__" para ausentes).
 */
export function aggregateByUtmSource(subs: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sub of subs) {
    const key = normalizeUtmSource(sub["utm_source"]);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Formata a tabela de contagens para exibição human-friendly.
 *
 * @pure testável sem I/O
 */
export function formatCountsTable(counts: Record<string, number>, total: number): string {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return "(nenhum assinante encontrado)";

  const maxKeyLen = Math.max(...rows.map(([k]) => k.length), "utm_source".length);
  const header = `${"utm_source".padEnd(maxKeyLen)}  assinantes  %`;
  const sep = "-".repeat(header.length);
  const lines = [header, sep];

  for (const [key, count] of rows) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    lines.push(`${key.padEnd(maxKeyLen)}  ${String(count).padStart(10)}  ${pct}%`);
  }
  lines.push(sep);
  lines.push(`${"TOTAL".padEnd(maxKeyLen)}  ${String(total).padStart(10)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTTP helpers (mesmo padrão do backup-beehiiv.ts)
// ---------------------------------------------------------------------------

interface FetchResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
}

interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiFetch<T>(path: string, apiKey: string, retries = 0): Promise<FetchResult<T>> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch(`${BEEHIIV_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  if (res.status === 429 && retries < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    const wait = Math.max(retryAfter * 1000, 30_000);
    process.stderr.write(
      `[count-subscriptions-by-utm] rate-limited — esperando ${Math.round(wait / 1000)}s (tentativa ${retries + 1}/${MAX_RETRIES})\n`,
    );
    await sleep(wait);
    return apiFetch<T>(path, apiKey, retries + 1);
  }

  if (!res.ok) return { ok: false, status: res.status, body: null };
  return { ok: true, status: res.status, body: (await res.json()) as T };
}

// ---------------------------------------------------------------------------
// Core: drena todas as páginas de subscriptions e agrega por utm_source
// ---------------------------------------------------------------------------

/**
 * Busca todas as subscriptions do Beehiiv (paginado) e agrega por utm_source.
 *
 * Não exportado como puro porque depende de I/O (fetch); testado via mock
 * da fetch global ou via integração com BEEHIIV_API_URL override.
 */
export async function fetchAndAggregate(
  publicationId: string,
  apiKey: string,
): Promise<UtmCountResult> {
  const allSubs: Array<Record<string, unknown>> = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;

  while (more) {
    // Beehiiv v2: `expand[]=utm_params` expõe utm_source/utm_medium/utm_campaign/
    // utm_channel dentro de cada subscription object.
    // Sem esse expand, os campos ficam ausentes na resposta.
    const path =
      `/publications/${publicationId}/subscriptions` +
      `?expand[]=utm_params&limit=${PER_PAGE}&page=${page}`;
    const res = await apiFetch<Page<Record<string, unknown>>>(path, apiKey);

    if (!res.ok) {
      throw new Error(
        `[count-subscriptions-by-utm] Beehiiv API ${res.status} em subscriptions página ${page}`,
      );
    }

    const body = res.body!;
    const chunk = body.data ?? [];
    allSubs.push(...chunk);
    if (body.total_results != null) totalResults = body.total_results;

    // Mesmo guard de anti-truncamento do backup-beehiiv.ts (#1897):
    // prefere total_results; fallback para "got < PER_PAGE" → última página.
    if (chunk.length === 0) {
      more = false;
    } else if (totalResults != null) {
      more = allSubs.length < totalResults;
    } else {
      // #2457 fix: usar o `limit` REPORTADO pela API (Beehiiv capa ~10/página, #1897),
      // não PER_PAGE — senão numa base sem total_results o loop para na 1ª página
      // (undercount silencioso). Página cheia (== limit da API) → há mais.
      const apiLimit =
        typeof body.limit === "number" && body.limit > 0 ? body.limit : PER_PAGE;
      more = chunk.length >= apiLimit;
    }

    process.stderr.write(
      `[count-subscriptions-by-utm] página ${page}: ${chunk.length} subscriptions (${allSubs.length}${totalResults != null ? `/${totalResults}` : ""} total)\n`,
    );
    page++;
  }

  // #2457 fix: guard anti-truncação pós-loop (como backup-beehiiv.ts) — se a API
  // reportou total_results mas não drenamos tudo (página vazia mid-drain, hiccup),
  // é truncamento silencioso → falhar em vez de retornar contagem parcial autoritativa.
  if (totalResults != null && allSubs.length < totalResults) {
    throw new Error(
      `[count-subscriptions-by-utm] truncado: ${allSubs.length}/${totalResults} subscriptions drenadas — contagem incompleta, abortando.`,
    );
  }

  return {
    counts: aggregateByUtmSource(allSubs),
    total: allSubs.length,
    fetched_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI guard
// ---------------------------------------------------------------------------

if (
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname
) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const sourceIdx = args.indexOf("--source");
  const filterSource = sourceIdx >= 0 ? args[sourceIdx + 1] : null;

  const cfg = loadBeehiivConfig("[count-subscriptions-by-utm]");

  fetchAndAggregate(cfg.publicationId, cfg.apiKey)
    .then((result) => {
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }

      const counts = filterSource
        ? Object.fromEntries(
            Object.entries(result.counts).filter(([k]) => k === normalizeUtmSource(filterSource)),
          )
        : result.counts;

      process.stderr.write(
        `\n[count-subscriptions-by-utm] Resultado (fetched_at=${result.fetched_at})\n\n`,
      );
      process.stdout.write(formatCountsTable(counts, result.total) + "\n");

      const mensal = result.counts["mensal-brevo"] ?? 0;
      const pct = result.total > 0 ? ((mensal / result.total) * 100).toFixed(1) : "0.0";
      process.stderr.write(
        `\n[count-subscriptions-by-utm] via mensal-brevo: ${mensal} (${pct}% do total de ${result.total})\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(`[count-subscriptions-by-utm] ERRO: ${String(err)}\n`);
      process.exit(1);
    });
}
