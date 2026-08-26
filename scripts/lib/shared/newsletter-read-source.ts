/**
 * newsletter-read-source.ts (#6184 — migração Beehiiv → Kit, fatia
 * metadados+conteúdo do épico #463)
 *
 * ## O problema que este módulo resolve
 *
 * `refresh-dedup.ts`, `fetch-monthly-posts.ts` (e, transitivamente,
 * `refresh-past-editions.ts`, que só processa o `Post[]` que os dois acima
 * produzem — não faz nenhuma chamada de rede própria) leem metadados e
 * conteúdo (HTML) de edições publicadas **ao vivo via REST**, direto contra
 * a Beehiiv. Desde o switchover do #6114 (`platform.config.json` →
 * `publishing.newsletter.backend: "kit"`), o ENVIO real de novas edições já
 * saiu pra Kit — sem esta migração, toda edição nova fica invisível pro
 * dedup (`data/past-editions.md`) e pro digest mensal (`fetch-monthly-posts.ts`),
 * porque os dois só sabem perguntar pra Beehiiv.
 *
 * Isto é DIFERENTE de `scripts/lib/shared/edition-cache-reader.ts` (#6187):
 * aquele módulo lê o CACHE EM ARQUIVO já materializado
 * (`data/beehiiv-cache/posts/`, `data/kit-cache/broadcasts/`) — histórico
 * congelado. Este módulo faz a chamada de API AO VIVO que POPULA esse tipo
 * de cache — o ponto de entrada que ainda não existia pro lado Kit.
 *
 * ## Desenho
 *
 * Resolve o backend (`platform.config.json` → `publishing.newsletter.backend`,
 * default `"beehiiv"`) e as credenciais UMA vez (`resolveNewsletterReadConfig`),
 * devolvendo um objeto discriminado (`NewsletterReadConfig`) que os 3
 * pontos de leitura abaixo aceitam sem precisar saber qual backend está por
 * trás:
 *
 *   - `listRecentNewsletterPosts` — bootstrap/incremental (refresh-dedup.ts:
 *     "N mais recentes" ou "mais novos que um cutoff").
 *   - `listNewsletterPostsInWindow` — janela de datas (fetch-monthly-posts.ts:
 *     "tudo publicado no mês X").
 *   - `fetchNewsletterPostContent` — HTML + URL pública de 1 post/broadcast.
 *
 * Ambas as funções de listagem devolvem apenas METADADOS (`NormalizedNewsletterPost`)
 * — nunca HTML —, mesma separação que o código Beehiiv original já tinha
 * (listar é barato, buscar conteúdo por item é caro; os 2 backends paginam
 * diferente: Beehiiv por `page`, Kit por cursor `after`).
 *
 * ## `webUrl` explicitamente `string | null` — nunca assumido (#6096/#6184)
 *
 * `KitBroadcastDetail.public_url` (`lib/kit-client.ts`) é `string | undefined`
 * porque nunca foi confirmado que o Kit sempre popula esse campo. Este
 * módulo formaliza a mesma ausência em TODO ponto de saída como `null`
 * explícito (nunca `undefined` silencioso, nunca um cast/`!` que assumiria
 * presença) — `NormalizedNewsletterPost.webUrl` e
 * `NewsletterPostContent.webUrl` são sempre `string | null`. O teste
 * dedicado (`test/newsletter-read-source.test.ts`) cobre exatamente esse
 * caminho: `getBroadcast` sem `public_url` não lança, não vira string vazia,
 * devolve `null`.
 *
 * `listBroadcasts` (resumo, usado pelas 2 funções de listagem) não devolve
 * `public_url` — só `getBroadcast` (detalhe) devolve. Por isso
 * `NormalizedNewsletterPost.webUrl` do lado Kit é sempre `null` na LISTAGEM;
 * o valor real só existe depois de `fetchNewsletterPostContent`. Mesmo
 * padrão que o código Beehiiv original já tinha (`toCanonicalPost` em
 * `refresh-dedup.ts` faz `web_url ?? summary.web_url` — o valor "bom" vem do
 * detalhe, o da listagem é só um fallback).
 *
 * ## O que este módulo NÃO faz
 *
 * - Não decide QUANDO trocar de backend — só LÊ a flag já decidida em
 *   `publishing.newsletter.backend` (escrita pelo #6114/#464).
 * - Não escreve nenhum cache em disco — puro round-trip de rede,
 *   normalizado. `edition-cache-reader.ts` continua sendo quem lê cache já
 *   materializado.
 * - Não migra `gen-archive-pages.ts` (shape `ArchivePost` próprio, com
 *   campos fora do normalizado aqui, e testado direto por fixture de
 *   arquivo) — registrado como pendente na issue #6184, fora desta unidade.
 */

import { resolveBeehiivConfig, beehiivApiBase, type BeehiivConfig } from "../beehiiv-config.ts";
import { resolveKitConfig, type KitConfig } from "../kit-config.ts";
import { listBroadcasts, getBroadcast, type KitBroadcastSummary } from "../kit-client.ts";
import { extractPublishedDate, extractPublishedAtIso } from "../beehiiv-timestamp.ts";
import { parseListPostsResponse, parseBeehiivPost } from "../schemas/beehiiv.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_CONFIG_PATH = resolve(ROOT, "platform.config.json");

export type NewsletterBackend = "beehiiv" | "kit";

/**
 * Lê `platform.config.json` → `publishing.newsletter.backend`. Puro, nunca
 * lança — arquivo ausente/inválido/campo ausente/valor desconhecido caem
 * todos no default `"beehiiv"` (fail-safe: um typo no config nunca deve
 * silenciosamente trocar de backend pro lado errado sozinho — só `"kit"`
 * explícito ativa o ramo Kit).
 */
export function resolveNewsletterBackend(configPath: string = DEFAULT_CONFIG_PATH): NewsletterBackend {
  if (!existsSync(configPath)) return "beehiiv";
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      publishing?: { newsletter?: { backend?: string } };
    };
    return cfg.publishing?.newsletter?.backend === "kit" ? "kit" : "beehiiv";
  } catch {
    return "beehiiv";
  }
}

/** Config resolvida e discriminada por backend — o que as 3 funções de
 *  leitura abaixo recebem. Nunca reconstruída internamente a partir do
 *  ambiente — sempre passada explicitamente pelo caller (mesmo padrão de
 *  `config?: KitConfig`/`config?: BeehiivConfig` já usado em
 *  `kit-client.ts`/`beehiiv-config.ts` — injeção facilita teste). */
export type NewsletterReadConfig =
  | { backend: "beehiiv"; config: BeehiivConfig }
  | { backend: "kit"; config: KitConfig };

export type NewsletterReadConfigResult =
  | { ok: true; config: NewsletterReadConfig }
  | { ok: false; reason: string };

/**
 * Resolve backend + credenciais correspondentes, sem nunca lançar ou chamar
 * `process.exit` (mesmo contrato de `resolveBeehiivConfig`/`resolveKitConfig`,
 * que este módulo delega — não reimplementa resolução de credencial).
 *
 * @param opts.backend      Override do backend resolvido de
 *                           `platform.config.json` — útil pra teste ou pra
 *                           um caller que já sabe o backend por outro meio.
 * @param opts.env           Fonte do env — default `process.env`.
 * @param opts.configPath    Path de `platform.config.json` — default o real.
 */
export function resolveNewsletterReadConfig(opts: {
  backend?: NewsletterBackend;
  env?: Record<string, string | undefined>;
  configPath?: string;
} = {}): NewsletterReadConfigResult {
  const backend = opts.backend ?? resolveNewsletterBackend(opts.configPath ?? DEFAULT_CONFIG_PATH);
  if (backend === "kit") {
    const result = resolveKitConfig(opts.env);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, config: { backend: "kit", config: result.config } };
  }
  const result = resolveBeehiivConfig(opts.env, opts.configPath ?? DEFAULT_CONFIG_PATH);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, config: { backend: "beehiiv", config: result.config } };
}

/** Shape normalizado de 1 post/broadcast, backend-agnóstico. `webUrl` e
 *  `publishedAtIso` são explicitamente `string | null` — ver docstring do
 *  módulo sobre por que nunca assumir presença. */
export interface NormalizedNewsletterPost {
  id: string;
  title: string;
  webUrl: string | null;
  publishedAtIso: string | null;
}

/** Conteúdo (HTML) + URL pública de 1 post/broadcast — resultado de
 *  `fetchNewsletterPostContent`. */
export interface NewsletterPostContent {
  html: string | null;
  webUrl: string | null;
}

// ---------------------------------------------------------------------------
// Beehiiv — extraído de refresh-dedup.ts / fetch-monthly-posts.ts (comportamento
// preservado 1:1; só a casca de tipo/local mudou).
// ---------------------------------------------------------------------------

interface BeehiivPostSummaryRaw {
  id: string;
  status?: string;
  publish_date?: number | null;
  published_at?: string | null;
  scheduled_at?: string | null;
  updated_at?: string | null;
  web_url?: string;
  title?: string;
  subject?: string;
}

async function beehiivApiFetch<T>(path: string, config: BeehiivConfig): Promise<T> {
  const res = await fetch(`${beehiivApiBase()}${path}`, {
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status} ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function normalizeBeehiivSummary(p: BeehiivPostSummaryRaw, now: Date): NormalizedNewsletterPost | null {
  const publishedAtIso = extractPublishedAtIso(p, now);
  if (!publishedAtIso) return null;
  return {
    id: p.id,
    title: p.title ?? p.subject ?? "(sem título)",
    webUrl: p.web_url ?? null,
    publishedAtIso,
  };
}

async function listRecentBeehiivPosts(
  config: BeehiivConfig,
  opts: { limit: number; stopBeforeMs?: number },
): Promise<NormalizedNewsletterPost[]> {
  const collected: NormalizedNewsletterPost[] = [];
  const now = new Date();
  let page = 1;

  while (collected.length < opts.limit) {
    // #972: `order_by=newest_first` retorna ordem invertida na Beehiiv API v2 —
    // a query correta é `publish_date` + `direction=desc`.
    const params = new URLSearchParams({
      per_page: "50",
      order_by: "publish_date",
      direction: "desc",
      page: String(page),
    });
    const raw = await beehiivApiFetch<unknown>(`/publications/${config.publicationId}/posts?${params}`, config);
    const data = parseListPostsResponse(raw);
    const posts = (data.data ?? []) as BeehiivPostSummaryRaw[];
    if (posts.length === 0) break;

    let stoppedAtCutoff = false;
    for (const p of posts) {
      const dt = extractPublishedDate(p, now);
      if (!dt) continue; // agendado futuro ou sem timestamp parseável — pula
      const ms = dt.getTime();
      if (opts.stopBeforeMs !== undefined && ms <= opts.stopBeforeMs) {
        stoppedAtCutoff = true;
        break;
      }
      const normalized = normalizeBeehiivSummary(p, now);
      if (normalized) collected.push(normalized);
      if (collected.length >= opts.limit) break;
    }

    if (stoppedAtCutoff) break;
    if (data.total_pages && page >= data.total_pages) break;
    page++;
  }

  return collected;
}

async function listBeehiivPostsInWindow(
  config: BeehiivConfig,
  opts: { startMs: number; endMs: number },
): Promise<NormalizedNewsletterPost[]> {
  const collected: NormalizedNewsletterPost[] = [];
  const now = new Date();
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      per_page: "50",
      order_by: "publish_date",
      direction: "desc",
      page: String(page),
    });
    const raw = await beehiivApiFetch<unknown>(`/publications/${config.publicationId}/posts?${params}`, config);
    const data = parseListPostsResponse(raw);
    const posts = (data.data ?? []) as BeehiivPostSummaryRaw[];
    if (posts.length === 0) break;

    let anyInWindow = false;
    let allBefore = true;
    for (const p of posts) {
      const dt = extractPublishedDate(p);
      const ms = dt ? dt.getTime() : (p.publish_date ? p.publish_date * 1000 : undefined);
      if (ms === undefined) continue;
      if (ms >= opts.startMs && ms < opts.endMs) {
        const normalized = normalizeBeehiivSummary(p, now);
        if (normalized) collected.push(normalized);
        anyInWindow = true;
        allBefore = false;
      } else if (ms >= opts.endMs) {
        allBefore = false;
      }
    }

    if (!anyInWindow && allBefore) break; // toda a página é anterior à janela
    if (data.total_pages && page >= data.total_pages) break;
    page++;
  }

  return collected;
}

async function fetchBeehiivPostContent(config: BeehiivConfig, id: string): Promise<NewsletterPostContent> {
  const params = new URLSearchParams();
  params.append("expand[]", "free_web_content");
  params.append("expand[]", "free_email_content");
  const raw = await beehiivApiFetch<{ data: unknown }>(
    `/publications/${config.publicationId}/posts/${id}?${params}`,
    config,
  );
  const detail = parseBeehiivPost(raw.data) as {
    html?: string;
    free_web_content?: string;
    free_email_content?: string;
    web_url?: string;
    content?: { free?: { web?: string; email?: string } };
  };
  const html =
    detail.html ||
    detail.free_email_content ||
    detail.content?.free?.email ||
    detail.free_web_content ||
    detail.content?.free?.web ||
    null;
  return { html: html ?? null, webUrl: detail.web_url ?? null };
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

/**
 * Ordem de retorno do `GET /v4/broadcasts` não é documentada explicitamente
 * como "mais recente primeiro" em lugar nenhum verificado ao vivo até esta
 * unidade — premissa assumida por analogia com toda API de feed paginado já
 * integrada neste repo (Beehiiv inclusive) e por não ter volume real hoje
 * pra contradizer (cache Kit ainda vazio, ver `edition-cache-reader.ts`).
 * Se um dia a ordem real se mostrar diferente (ex: mais antigo primeiro), os
 * critérios de parada abaixo (`stopBeforeMs`/janela) param cedo demais ou
 * tarde demais — sinal de alerta seria `listRecentNewsletterPosts` devolver
 * menos posts do que o esperado com broadcasts Kit reais no meio do backlog.
 */
function normalizeKitSummary(b: KitBroadcastSummary, now: Date): NormalizedNewsletterPost | null {
  const publishedAtIso = extractPublishedAtIso({ published_at: b.published_at ?? b.send_at }, now);
  if (!publishedAtIso) return null;
  return {
    id: String(b.id),
    title: b.subject,
    // `listBroadcasts` (resumo) nunca devolve `public_url` — só `getBroadcast`
    // (detalhe) devolve. `null` aqui é o valor real da listagem, não uma
    // ausência anômala — ver docstring do módulo.
    webUrl: null,
    publishedAtIso,
  };
}

async function listRecentKitPosts(
  config: KitConfig,
  opts: { limit: number; stopBeforeMs?: number },
): Promise<NormalizedNewsletterPost[]> {
  const collected: NormalizedNewsletterPost[] = [];
  const now = new Date();
  let after: string | undefined;

  while (collected.length < opts.limit) {
    const { broadcasts, pagination } = await listBroadcasts({
      status: "completed",
      perPage: 50,
      after,
      config,
    });
    if (broadcasts.length === 0) break;

    let stoppedAtCutoff = false;
    for (const b of broadcasts) {
      const dt = extractPublishedDate({ published_at: b.published_at ?? b.send_at }, now);
      if (!dt) continue; // agendado futuro ou sem timestamp parseável — pula
      const ms = dt.getTime();
      if (opts.stopBeforeMs !== undefined && ms <= opts.stopBeforeMs) {
        stoppedAtCutoff = true;
        break;
      }
      const normalized = normalizeKitSummary(b, now);
      if (normalized) collected.push(normalized);
      if (collected.length >= opts.limit) break;
    }

    if (stoppedAtCutoff) break;
    if (!pagination.has_next_page || !pagination.end_cursor) break;
    after = pagination.end_cursor;
  }

  return collected;
}

async function listKitPostsInWindow(
  config: KitConfig,
  opts: { startMs: number; endMs: number },
): Promise<NormalizedNewsletterPost[]> {
  const collected: NormalizedNewsletterPost[] = [];
  const now = new Date();
  let after: string | undefined;

  while (true) {
    const { broadcasts, pagination } = await listBroadcasts({
      status: "completed",
      perPage: 50,
      after,
      config,
    });
    if (broadcasts.length === 0) break;

    let anyInWindow = false;
    let allBefore = true;
    for (const b of broadcasts) {
      const dt = extractPublishedDate({ published_at: b.published_at ?? b.send_at });
      if (!dt) continue;
      const ms = dt.getTime();
      if (ms >= opts.startMs && ms < opts.endMs) {
        const normalized = normalizeKitSummary(b, now);
        if (normalized) collected.push(normalized);
        anyInWindow = true;
        allBefore = false;
      } else if (ms >= opts.endMs) {
        allBefore = false;
      }
    }

    if (!anyInWindow && allBefore) break;
    if (!pagination.has_next_page || !pagination.end_cursor) break;
    after = pagination.end_cursor;
  }

  return collected;
}

async function fetchKitPostContent(config: KitConfig, id: string): Promise<NewsletterPostContent> {
  const detail = await getBroadcast(Number(id), config);
  // `public_url` é `string | undefined` no tipo (#6096) — nunca confirmado
  // que o Kit sempre popula. `?? null` é o tratamento explícito exigido
  // pela docstring do módulo — nunca um `!`/cast que assumiria presença.
  return { html: detail.content ?? null, webUrl: detail.public_url ?? null };
}

// ---------------------------------------------------------------------------
// API pública — dispatch por backend
// ---------------------------------------------------------------------------

/** Bootstrap ("N mais recentes") ou incremental ("mais novos que
 *  `stopBeforeMs`") — usado por `refresh-dedup.ts`. */
export async function listRecentNewsletterPosts(
  readConfig: NewsletterReadConfig,
  opts: { limit: number; stopBeforeMs?: number },
): Promise<NormalizedNewsletterPost[]> {
  return readConfig.backend === "kit"
    ? listRecentKitPosts(readConfig.config, opts)
    : listRecentBeehiivPosts(readConfig.config, opts);
}

/** Janela de datas (`[startMs, endMs)`) — usado por `fetch-monthly-posts.ts`. */
export async function listNewsletterPostsInWindow(
  readConfig: NewsletterReadConfig,
  opts: { startMs: number; endMs: number },
): Promise<NormalizedNewsletterPost[]> {
  return readConfig.backend === "kit"
    ? listKitPostsInWindow(readConfig.config, opts)
    : listBeehiivPostsInWindow(readConfig.config, opts);
}

/** HTML + URL pública de 1 post/broadcast, pelo `id` normalizado (string —
 *  Kit é convertido de volta pra `number` internamente). */
export async function fetchNewsletterPostContent(
  readConfig: NewsletterReadConfig,
  id: string,
): Promise<NewsletterPostContent> {
  return readConfig.backend === "kit"
    ? fetchKitPostContent(readConfig.config, id)
    : fetchBeehiivPostContent(readConfig.config, id);
}
