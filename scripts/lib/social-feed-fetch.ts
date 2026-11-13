/**
 * scripts/lib/social-feed-fetch.ts (#13009) — leitura SOMENTE-LEITURA do feed
 * das contas da diar.ia.br no Instagram, Threads e LinkedIn, pelas APIs
 * oficiais, normalizada em `FeedRead` para `social-feed-reconcile.ts`.
 *
 * Endpoints (todos GET, token no header, nunca na query — #7779):
 *   - Instagram: `GET graph.facebook.com/{v}/{ig-user-id}/media?fields=id,permalink,timestamp,caption,media_product_type`
 *   - Threads:   `GET graph.threads.net/{v}/{threads-user-id}/threads?fields=id,permalink,timestamp,text`
 *   - LinkedIn:  `GET api.linkedin.com/rest/posts?q=author&author={urn}&sortBy=CREATED` (escopo
 *     `r_organization_social` do token da página, #8055)
 *
 * Os três vêm do mais novo para o mais antigo. A leitura pagina até passar do
 * `since` (ou até o teto de páginas) e devolve `coveredSince` = até onde
 * garantidamente leu. Feed esgotado (sem próxima página) cobre tudo. Teto de
 * páginas antes de alcançar o `since` deixa `coveredSince` depois dele, e o
 * reconciliador nunca declara ausência nessa faixa.
 *
 * Credencial ausente ou erro de API vira `error` no `FeedRead`: o canal fica
 * sem conclusão, nunca "ausente".
 */

import type { FeedItem, FeedRead } from "./social-feed-reconcile.ts";
import { parseFeedTime } from "./social-feed-reconcile.ts";
import { defaultLinkedInApiVersion, restHeaders } from "./linkedin-personal.ts";

export type FeedFetch = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FeedFetch = (url, init) => fetch(url, init);
const TIMEOUT_MS = 30_000;
export const FEED_MAX_PAGES = 8;
/** Coberto desde sempre: o feed acabou antes do `since`. */
const FEED_START = "1970-01-01T00:00:00.000Z";

interface Page {
  items: FeedItem[];
  next: string | null;
}

async function getJson(fetchFn: FeedFetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body as { error?: { message?: string }; message?: string } | null) ?? null;
    throw new Error(`HTTP ${res.status}${e?.error?.message ? `: ${e.error.message}` : e?.message ? `: ${e.message}` : ""}`);
  }
  return body;
}

/**
 * Pagina `firstUrl` até o item mais antigo da página ficar antes de `sinceMs`
 * ou até `maxPages`. Pura em relação ao I/O (`loadPage` injetado).
 */
export async function readFeedPages(
  firstUrl: string,
  loadPage: (url: string) => Promise<Page>,
  sinceIso: string,
  maxPages: number = FEED_MAX_PAGES,
): Promise<FeedRead> {
  const sinceMs = Date.parse(sinceIso);
  const items: FeedItem[] = [];
  let url: string | null = firstUrl;
  let pages = 0;
  try {
    while (url && pages < maxPages) {
      const page = await loadPage(url);
      pages++;
      items.push(...page.items);
      const oldest = page.items.reduce((m, it) => Math.min(m, parseFeedTime(it.timestamp)), Infinity);
      url = page.next;
      if (page.items.length === 0 || oldest < sinceMs) break;
    }
  } catch (e) {
    return { items, coveredSince: null, error: (e as Error).message };
  }
  const oldestAll = items.reduce((m, it) => {
    const ms = parseFeedTime(it.timestamp);
    return Number.isFinite(ms) ? Math.min(m, ms) : m;
  }, Infinity);
  // Sem próxima página: o feed acabou, então cobre desde sempre.
  const coveredSince = url === null ? FEED_START : Number.isFinite(oldestAll) ? new Date(oldestAll).toISOString() : null;
  return { items, coveredSince, error: null };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Página da Graph API (Instagram/Threads): `{ data: [...], paging: { next } }`. */
export function parseGraphPage(body: unknown, textField: "caption" | "text"): Page {
  const b = body as { data?: unknown; paging?: { next?: unknown } } | null;
  if (!b || !Array.isArray(b.data)) throw new Error("resposta sem `data` em array");
  const items: FeedItem[] = [];
  for (const raw of b.data as Array<Record<string, unknown>>) {
    const id = str(raw.id);
    const permalink = str(raw.permalink);
    const timestamp = str(raw.timestamp);
    if (!id || !permalink || !timestamp) continue;
    items.push({ id, permalink, timestamp, text: str(raw[textField]), productType: str(raw.media_product_type) });
  }
  return { items, next: str(b.paging?.next) };
}

/** Página do `/rest/posts` do LinkedIn: `{ elements: [...] }` com `createdAt`/`publishedAt` em ms. */
export function parseLinkedInPage(body: unknown, nextUrl: string | null, pageSize: number): Page {
  const b = body as { elements?: unknown } | null;
  if (!b || !Array.isArray(b.elements)) throw new Error("resposta sem `elements` em array");
  const items: FeedItem[] = [];
  for (const raw of b.elements as Array<Record<string, unknown>>) {
    const id = str(raw.id);
    const ms = typeof raw.publishedAt === "number" ? raw.publishedAt : typeof raw.createdAt === "number" ? raw.createdAt : NaN;
    if (!id || !Number.isFinite(ms)) continue;
    items.push({
      id,
      permalink: `https://www.linkedin.com/feed/update/${id}/`,
      timestamp: new Date(ms).toISOString(),
      text: str(raw.commentary),
    });
  }
  // Página incompleta (contando os elementos crus) = fim do feed.
  return { items, next: b.elements.length >= pageSize ? nextUrl : null };
}

type Env = Record<string, string | undefined>;

export async function fetchInstagramFeed(sinceIso: string, env: Env = process.env, fetchFn: FeedFetch = defaultFetch): Promise<FeedRead> {
  const id = env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  const token = env.INSTAGRAM_ACCESS_TOKEN;
  if (!id || !token) return { items: [], coveredSince: null, error: "credencial ausente (INSTAGRAM_BUSINESS_ACCOUNT_ID, INSTAGRAM_ACCESS_TOKEN)" };
  const v = env.INSTAGRAM_API_VERSION || "v25.0";
  const first = `https://graph.facebook.com/${v}/${id}/media?fields=id,permalink,timestamp,caption,media_product_type&limit=50`;
  const headers = { Authorization: `Bearer ${token}` };
  return readFeedPages(first, async (url) => parseGraphPage(await getJson(fetchFn, url, headers), "caption"), sinceIso);
}

export async function fetchThreadsFeed(sinceIso: string, env: Env = process.env, fetchFn: FeedFetch = defaultFetch): Promise<FeedRead> {
  const id = env.THREADS_USER_ID;
  const token = env.THREADS_ACCESS_TOKEN;
  if (!id || !token) return { items: [], coveredSince: null, error: "credencial ausente (THREADS_USER_ID, THREADS_ACCESS_TOKEN)" };
  const v = env.THREADS_API_VERSION || "v1.0";
  const first = `https://graph.threads.net/${v}/${id}/threads?fields=id,permalink,timestamp,text&limit=50`;
  const headers = { Authorization: `Bearer ${token}` };
  return readFeedPages(first, async (url) => parseGraphPage(await getJson(fetchFn, url, headers), "text"), sinceIso);
}

export async function fetchLinkedInPageFeed(
  sinceIso: string,
  env: Env = process.env,
  fetchFn: FeedFetch = defaultFetch,
  now: Date = new Date(),
): Promise<FeedRead> {
  const token = env.LINKEDIN_ACCESS_TOKEN;
  const author = env.LINKEDIN_AUTHOR_URN;
  if (!token || !author) return { items: [], coveredSince: null, error: "credencial ausente (LINKEDIN_ACCESS_TOKEN, LINKEDIN_AUTHOR_URN)" };
  const version = env.LINKEDIN_API_VERSION || defaultLinkedInApiVersion(now);
  const headers = { ...restHeaders(token, version), "X-RestLi-Method": "FINDER" };
  const count = 50;
  const pageUrl = (start: number) =>
    `https://api.linkedin.com/rest/posts?q=author&author=${encodeURIComponent(author)}&sortBy=CREATED&count=${count}&start=${start}`;
  return readFeedPages(
    pageUrl(0),
    async (url) => {
      const start = Number(new URL(url).searchParams.get("start") ?? "0");
      return parseLinkedInPage(await getJson(fetchFn, url, headers), pageUrl(start + count), count);
    },
    sinceIso,
  );
}
