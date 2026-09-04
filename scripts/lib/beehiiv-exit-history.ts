/**
 * beehiiv-exit-history.ts (#7248)
 *
 * Miolo PURO da drenagem de `exited_at` REAL da Beehiiv — residual do
 * #7201 (fatia 6 do epic #7163): `ingestBeehiivRoster`
 * (`beehiiv-subscribers-ingest.ts`) já popula `subscription.exited_at`, mas
 * só com uma APROXIMAÇÃO (`now` da captura do snapshot semanal, na 1ª
 * rodada em que a transição é detectada — guard do #7222). Este módulo
 * fecha a lacuna de precisão.
 *
 * ## O que a issue #7248 assumia, e o que a investigação ao vivo (04/09/2026) achou
 *
 * A issue pedia pra investigar `get_subscriber_history` (MCP Beehiiv). Essa
 * tool **NÃO é per-assinante** — o schema (`publication_id` + `time_period`,
 * sem nenhum id de assinante) e a descrição ("the publication's active
 * subscriber count over time... subscriber growth chart") confirmam que é a
 * série AGREGADA de contagem de assinantes da publicação, o mesmo gráfico
 * de crescimento do dashboard. Não serve pra esta issue — inútil pra
 * derivar `exited_at` de 1 assinante específico.
 *
 * A fonte real é outra: `list_subscriptions`/`get_subscription`/
 * `get_subscription_batch` (MCP) já expõem `unsubscribed_on` — o timestamp
 * REAL de transição — algo que a REST `/subscriptions` nunca devolveu
 * (verificação original registrada em `scripts/cohort-retention.ts:73`).
 * Medido ao vivo contra a publicação real (`pub_b9534d43-…`, 04/09/2026):
 * `list_subscriptions(status: "inactive")` devolve, por página,
 * `{id, email, status, unsubscribed_on, subscribed_on, ...}` — sem
 * paginação por assinante, sem custo de 1 chamada por pessoa. 847
 * assinantes inactive cabem em ~9 páginas de 100 (bem menos do que a issue
 * antecipava — "1 chamada MCP por assinante não é barato em escala").
 *
 * ## A coorte `invalid` — confirmado que a MCP a OMITE INTEIRA, não só "tende a"
 *
 * A issue nomeava que a MCP "costuma omitir" a coorte `invalid` (só existe
 * como `status` na REST). Medição ao vivo confirma que é total, não
 * parcial: 3 `subscription_id` reais com `status: "invalid"` puxados da
 * REST (`GET /subscriptions?status=invalid`) voltaram `not_found` em
 * `get_subscription_batch`. `list_subscriptions` nem aceita `"invalid"`
 * como valor de `status` (enum MCP: `active`/`inactive`/`pending`/
 * `needs_attention`) — `needs_attention` foi testado e devolveu 0
 * resultados nesta publicação, então não é onde `invalid` reaparece
 * escondida.
 *
 * Consequência: **não existe hoje nenhuma fonte (REST nem MCP) que devolva
 * timestamp de saída pra `invalid`** — ela permanece SEMPRE na aproximação
 * de `ingestBeehiivRoster` (a data de captura do snapshot em que a
 * transição foi detectada), nunca "corrigida" por este módulo. Isso não é
 * uma omissão silenciosa: `applyBeehiivExitHistory`
 * (`beehiiv-subscribers-ingest.ts`) só toca `subscription` cujo `status`
 * gravado é `"inactive"` — um `subscriber` `invalid` nunca casa essa
 * condição, então nunca é tocado por este módulo, e a aproximação
 * pré-existente continua valendo pra ele. Ver docstring de
 * `applyBeehiivExitHistory` pro texto simétrico do lado do merge.
 *
 * ## Pipeline (molde de `beehiiv-engagement-manifest.ts`, mais simples)
 *
 * Diferente da drenagem por-post (`beehiiv-engagement-backup`, cursor
 * paginado sem `total_pages` — #7197), `list_subscriptions` devolve
 * `pagination.total_pages` de verdade (medido: `{page, per_page, total,
 * total_pages}`), então o manifest aqui não precisa de âncora externa nem
 * de heurística `email_az` — só rastreia página a página até
 * `pages_fetched >= total_pages`. Um único recurso (não 1 manifest entry
 * por post), então `ExitHistoryManifest` é achatado: 1 registro de
 * progresso, não uma lista.
 *
 * Fluxo:
 *   1. `parseExitHistoryPage` — filtra a página crua da MCP pra só os
 *      registros usáveis (status inactive + unsubscribed_on presente).
 *   2. `applyExitHistoryPageToManifest` — avança o checkpoint de página.
 *   3. `nextExitHistoryPage` — que página pedir em seguida.
 *
 * I/O (ler/escrever `subscribers.jsonl`/`manifest.json`) fica em
 * `scripts/apply-mcp-exit-history.ts` — este módulo é puro.
 */

/** Shape tolerante de 1 linha crua de `list_subscriptions`/`get_subscription`
 *  — campos podem faltar (registro malformado). Nenhum campo é assumido
 *  presente sem checagem. */
export interface BeehiivExitHistoryRawRecord {
  id?: unknown;
  email?: unknown;
  status?: unknown;
  unsubscribed_on?: unknown;
  subscribed_on?: unknown;
}

/** 1 registro USÁVEL — já filtrado (status inactive + unsubscribed_on
 *  presente). `unsubscribedOn` é sempre uma string ISO não-vazia. */
export interface BeehiivExitHistoryRecord {
  externalId: string | null;
  email: string | null;
  unsubscribedOn: string;
}

/**
 * Extrai 1 registro usável de 1 linha crua — `null` quando o registro não
 * serve (status diferente de `inactive`, sem `unsubscribed_on` utilizável,
 * ou sem identidade nenhuma). Só `inactive` porque é o único status que a
 * MCP confirmadamente preenche `unsubscribed_on` (medição ao vivo) — um
 * `pending`/`active` sempre traz o campo `null`, e `invalid` nunca aparece
 * nesta fonte (ver docstring do módulo).
 */
export function parseExitHistoryRecord(raw: BeehiivExitHistoryRawRecord): BeehiivExitHistoryRecord | null {
  const status = typeof raw.status === "string" ? raw.status : null;
  if (status !== "inactive") return null;

  const unsubscribedOn =
    typeof raw.unsubscribed_on === "string" && raw.unsubscribed_on.trim() ? raw.unsubscribed_on.trim() : null;
  if (!unsubscribedOn) return null;

  const externalId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
  const email = typeof raw.email === "string" && raw.email.trim() ? raw.email.trim().toLowerCase() : null;
  if (!externalId && !email) return null;

  return { externalId, email, unsubscribedOn };
}

/** Filtra uma página inteira — linhas inúteis (status != inactive, sem
 *  unsubscribed_on, sem identidade) são descartadas silenciosamente aqui;
 *  não são erro, são a maioria esperada de qualquer página (a maior parte
 *  do roster não é inactive). */
export function parseExitHistoryPage(rows: readonly BeehiivExitHistoryRawRecord[]): BeehiivExitHistoryRecord[] {
  const out: BeehiivExitHistoryRecord[] = [];
  for (const row of rows) {
    const parsed = parseExitHistoryRecord(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Chave de dedup de 1 registro — `externalId` (id nativo, preferido) ou
 *  `email` como fallback. Nunca `null` (`parseExitHistoryRecord` já garante
 *  que ao menos um dos dois está presente). */
export function exitHistoryRecordKey(record: BeehiivExitHistoryRecord): string {
  return record.externalId ?? record.email ?? "";
}

/**
 * Mescla `existing` (já em disco) com `incoming` (página recém-buscada),
 * deduplicando por `exitHistoryRecordKey` — incoming vence em caso de
 * conflito (mesma convenção do resto do repo, ex:
 * `mergeEngagementRecords`). Como cada página é uma fatia DISJUNTA do mesmo
 * filtro (`status=inactive`), conflito real seria só um re-fetch da mesma
 * página — incoming vencer é seguro e idempotente.
 */
export function mergeExitHistoryRecords(
  existing: readonly BeehiivExitHistoryRecord[],
  incoming: readonly BeehiivExitHistoryRecord[],
): BeehiivExitHistoryRecord[] {
  const merged = new Map<string, BeehiivExitHistoryRecord>();
  for (const r of existing) merged.set(exitHistoryRecordKey(r), r);
  for (const r of incoming) merged.set(exitHistoryRecordKey(r), r);
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Manifest — checkpoint de paginação (1 recurso, não 1 entry por post)
// ---------------------------------------------------------------------------

export interface ExitHistoryManifest {
  generated_at: string;
  /** Único filtro suportado hoje — só `inactive` tem `unsubscribed_on`
   *  confiável nesta MCP (ver docstring do módulo). */
  status_filter: "inactive";
  per_page: number;
  /** Maior número de página já aplicado com sucesso — não "quantas páginas
   *  existem no total", isso é `total_pages`. */
  pages_fetched: number;
  total_pages: number | null;
  total: number | null;
  /** `true` só quando `pages_fetched >= total_pages` (e `total_pages`
   *  conhecido) — nunca inferido de ausência de campo (ao contrário do
   *  manifest de engagement, #7197, esta MCP confirmadamente devolve
   *  `total_pages`). */
  complete: boolean;
  last_updated_at: string;
}

export const DEFAULT_EXIT_HISTORY_PER_PAGE = 100;

export function buildInitialExitHistoryManifest(
  now: string,
  perPage: number = DEFAULT_EXIT_HISTORY_PER_PAGE,
): ExitHistoryManifest {
  return {
    generated_at: now,
    status_filter: "inactive",
    per_page: perPage,
    pages_fetched: 0,
    total_pages: null,
    total: null,
    complete: false,
    last_updated_at: now,
  };
}

/** `{page, per_page, total, total_pages}` — mesmo shape de
 *  `pagination` na resposta crua de `list_subscriptions`. Todos opcionais
 *  na entrada (tolerante a resposta malformada); `page` é o único
 *  obrigatório pra avançar o checkpoint. */
export interface ExitHistoryPageMeta {
  page: number;
  per_page?: number | null;
  total?: number | null;
  total_pages?: number | null;
}

/**
 * Avança o checkpoint do manifest com o resultado de 1 página aplicada.
 * `pages_fetched` nunca REGRIDE (usa `Math.max` — reaplicar uma página
 * antiga não desfaz progresso); `total_pages`/`total` são atualizados só
 * quando a página informa um valor (preserva o anterior quando ausente).
 */
export function applyExitHistoryPageToManifest(
  manifest: ExitHistoryManifest,
  page: ExitHistoryPageMeta,
  now: string,
): ExitHistoryManifest {
  const pagesFetched = Math.max(manifest.pages_fetched, page.page);
  const totalPages = typeof page.total_pages === "number" ? page.total_pages : manifest.total_pages;
  const total = typeof page.total === "number" ? page.total : manifest.total;
  const perPage = typeof page.per_page === "number" && page.per_page > 0 ? page.per_page : manifest.per_page;
  const complete = totalPages != null && pagesFetched >= totalPages;
  return {
    ...manifest,
    per_page: perPage,
    pages_fetched: pagesFetched,
    total_pages: totalPages,
    total,
    complete,
    last_updated_at: now,
  };
}

/** Próxima página a buscar — `1` num manifest novo, senão `pages_fetched + 1`. */
export function nextExitHistoryPage(manifest: ExitHistoryManifest): number {
  return manifest.pages_fetched + 1;
}
