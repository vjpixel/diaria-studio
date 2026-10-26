/** #10819: preparação de horários de divulgação, sem mutations externas.
 * Defaults antigos viram preferências. Stage 5 nunca passa por este módulo.
 * Janela 06–22 BRT, 2h e picos gerais são as premissas do planner existente.
 *
 * Fontes da grade (todas só leitura, fail-soft com aviso): os stores da edição
 * de cada data, a fila do Worker (`GET /list`), o Facebook agendado direto na
 * Graph API (`GET /{page}/scheduled_posts`, por página habilitada com
 * credencial) e a fila do X no Buffer (GraphQL `posts`, `BUFFER_ACCESS_TOKEN`).
 * Fonte que falha só tira os posts DELA da grade: os stores da edição continuam
 * lá, então o post diário nunca some do cálculo.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();
import { editionDir } from "./lib/edition-paths.ts";
import { loadWorkerQueueForGrid } from "./publish-shorts.ts";
import { enabledFacebookPages, loadResolvedFacebookPages } from "./lib/facebook-pages.ts";
import {
  gridFromBufferPosts,
  gridFromFacebookScheduledPosts,
  gridFromLinkedInPersonalIntent,
  gridFromShortsPublished,
  gridFromSocialPublished,
  gridFromWorkerQueue,
  mergeGrids,
  planSlots,
  type ScheduledSlot,
} from "./lib/social-slot-planner.ts";
import { addMinutesIso, localDateInTz, localIsoAt } from "./lib/mensal/retrospectiva-schedule.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Mesmo teto do `GET /list` do Worker (#11001). */
export const GRID_SOURCE_TIMEOUT_MS = 10_000;
const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";

export interface DivulgacaoRequest { key: string; account: string; preferredAt: string; alsoAccounts?: readonly string[] }
export function planDivulgacao(grid: readonly ScheduledSlot[], requests: readonly DivulgacaoRequest[], now = Date.now()) {
  const decisions = planSlots(grid, requests.map((r) => {
    const day = localDateInTz(Date.parse(r.preferredAt), "America/Sao_Paulo");
    return { account: r.account, preferredAt: r.preferredAt,
      ...(r.alsoAccounts?.length ? { alsoAccounts: r.alsoAccounts } : {}),
      window: { start: localIsoAt(day, "06:00"), end: localIsoAt(day, "22:00") },
      notBefore: new Date(now + 10 * 60_000).toISOString() };
  }));
  return decisions.map((d, i) => {
    if (!d.at || d.warning) throw new Error(`Grade #10819 sem slot seguro para ${requests[i].key}: ${d.warning ?? d.premise}`);
    return { ...d, key: requests[i].key, at: addMinutesIso(d.at, 0) };
  });
}

/** `fetch` com teto de tempo; o abort libera o socket quando o fetch respeita o `signal`. */
async function fetchJsonWithTimeout(fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`timeout de ${timeoutMs} ms`)); }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchFn(url, { ...init, signal: controller.signal });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${res.status}`);
        }
        return (await res.json()) as unknown;
      })(),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
    timedOut.catch(() => {});
  }
}

export interface FacebookGridPage { slug: string; pageId: string; token: string }

/**
 * Posts agendados direto no Facebook, página a página (#10819). Página que
 * falha vira aviso e fica fora da grade; as outras seguem.
 */
export async function loadFacebookScheduledForGrid(
  pages: readonly FacebookGridPage[], apiVersion: string, fetchFn: typeof fetch, warn: (m: string) => void,
  timeoutMs = GRID_SOURCE_TIMEOUT_MS,
): Promise<ScheduledSlot[]> {
  const out: ScheduledSlot[] = [];
  for (const p of pages) {
    const url = `https://graph.facebook.com/${apiVersion}/${p.pageId}/scheduled_posts?fields=id,scheduled_publish_time&limit=100`;
    try {
      const json = await fetchJsonWithTimeout(fetchFn, url, { headers: { Authorization: `OAuth ${p.token}` } }, timeoutMs);
      const err = (json as { error?: { message?: string } })?.error;
      if (err) throw new Error(err.message ?? "erro da Graph API");
      if (!Array.isArray((json as { data?: unknown })?.data)) throw new Error("resposta sem data");
      out.push(...gridFromFacebookScheduledPosts(json, p.slug));
    } catch (e) {
      warn(`Grade #10819 sem os agendados do Facebook ${p.slug} (${(e as Error).message}) — só os stores da edição contam pra esta página`);
    }
  }
  return out;
}

/**
 * Fila do X no Buffer entre `start` e `end` (#10819). Duas chamadas GraphQL:
 * a organização do canal e os posts dele. Qualquer falha vira aviso e grade
 * vazia (só os stores da edição contam pro X).
 */
export async function loadBufferQueueForGrid(
  token: string, channelId: string, range: { start: string; end: string }, fetchFn: typeof fetch, warn: (m: string) => void,
  timeoutMs = GRID_SOURCE_TIMEOUT_MS,
): Promise<ScheduledSlot[]> {
  if (!token || !channelId) {
    warn(`Grade #10819 sem a fila do X no Buffer (${!token ? "BUFFER_ACCESS_TOKEN" : "publishing.social.twitter.buffer_channel_id"} ausente) — só os stores da edição contam pro X`);
    return [];
  }
  const gql = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
    const json = await fetchJsonWithTimeout(fetchFn, BUFFER_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }, timeoutMs);
    const errors = (json as { errors?: Array<{ message?: string }> })?.errors;
    if (errors?.length) throw new Error(errors.map((e) => e.message ?? "?").join("; "));
    return json;
  };
  try {
    const ch = await gql("query GridChannel($id: ChannelId!) { channel(input: { id: $id }) { organizationId } }", { id: channelId });
    const org = (ch as { data?: { channel?: { organizationId?: unknown } } })?.data?.channel?.organizationId;
    if (typeof org !== "string" || !org) throw new Error("canal sem organizationId");
    const posts = await gql(
      "query GridPosts($org: OrganizationId!, $ch: [ChannelId!], $start: DateTime, $end: DateTime) { posts(first: 100, input: { organizationId: $org, filter: { channelIds: $ch, status: [scheduled, sending], dueAt: { start: $start, end: $end } } }) { edges { node { dueAt status channelService } } } }",
      { org, ch: [channelId], start: range.start, end: range.end },
    );
    if (!Array.isArray((posts as { data?: { posts?: { edges?: unknown } } })?.data?.posts?.edges)) throw new Error("resposta sem posts.edges");
    return gridFromBufferPosts(posts);
  } catch (e) {
    warn(`Grade #10819 sem a fila do X no Buffer (${(e as Error).message}) — só os stores da edição contam pro X`);
    return [];
  }
}

/** Só leituras: GET /list, Graph `scheduled_posts`, Buffer `posts` e os stores das datas pedidas. */
interface GridConfig {
  publishing?: {
    social?: { linkedin?: { cloudflare_worker_url?: string }; twitter?: { buffer_channel_id?: string } };
    shorts?: { instagram_author_page?: string | null; instagram_collaborators?: string[] };
  };
}
export interface DivulgacaoGridDeps {
  loadQueue?: typeof loadWorkerQueueForGrid;
  editionDir?: typeof editionDir;
  /** Facebook agendado direto (default: Graph API das páginas habilitadas com credencial). */
  loadFacebook?: (warn: (m: string) => void) => Promise<ScheduledSlot[]>;
  /** Fila do X no Buffer (default: GraphQL com `BUFFER_ACCESS_TOKEN`). */
  loadBuffer?: (range: { start: string; end: string }, warn: (m: string) => void) => Promise<ScheduledSlot[]>;
}
export async function loadDivulgacaoGrid(rawConfig: unknown, dates: readonly string[], warn = console.error,
  deps: DivulgacaoGridDeps = {},
): Promise<ScheduledSlot[]> {
  const config = rawConfig as GridConfig;
  const social = config.publishing?.social;
  const days = [...new Set(dates)].sort();
  const queue = await (deps.loadQueue ?? loadWorkerQueueForGrid)(process.env.DIARIA_LINKEDIN_CRON_URL ?? social?.linkedin?.cloudflare_worker_url ?? "", process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "", fetch, warn);
  const loadFacebook = deps.loadFacebook ?? (async (w: (m: string) => void) => {
    let resolved: ReturnType<typeof loadResolvedFacebookPages>;
    try { resolved = loadResolvedFacebookPages(ROOT, rawConfig); }
    catch (e) { w(`Grade #10819 sem os agendados do Facebook (config: ${(e as Error).message})`); return []; }
    const pages = enabledFacebookPages(resolved.pages);
    for (const p of pages.filter((p) => p.missing.length > 0)) w(`Grade #10819 sem os agendados do Facebook ${p.slug} (${p.missing.join("/")} ausente)`);
    return loadFacebookScheduledForGrid(pages.filter((p) => p.missing.length === 0), resolved.apiVersion, fetch, w);
  });
  const loadBuffer = deps.loadBuffer ?? ((range: { start: string; end: string }, w: (m: string) => void) =>
    loadBufferQueueForGrid(process.env.BUFFER_ACCESS_TOKEN ?? "", social?.twitter?.buffer_channel_id ?? "", range, fetch, w));
  const range = days.length
    ? { start: new Date(localIsoAt(days[0], "00:00")).toISOString(), end: new Date(Date.parse(localIsoAt(days[days.length - 1], "00:00")) + 86_400_000).toISOString() }
    : null;
  const [facebook, buffer] = range ? await Promise.all([loadFacebook(warn), loadBuffer(range, warn)]) : [[], []];
  const read = (path: string): unknown => {
    if (!existsSync(path)) return undefined;
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { warn(`Grade #10819: ${path} ilegível: ${(e as Error).message}`); return undefined; }
  };
  const shorts = config.publishing?.shorts;
  const grids = days.map((day) => {
    const dir = join((deps.editionDir ?? editionDir)(day.replaceAll("-", "").slice(2)), "_internal");
    return mergeGrids(
      gridFromSocialPublished(read(join(dir, "06-social-published.json"))),
      gridFromShortsPublished(read(join(dir, "06-shorts-published.json")), shorts?.instagram_author_page ?? "diaria", shorts?.instagram_collaborators ?? []),
      // #11157: o vídeo do perfil que o timer do 300 publica fica no registro próprio dele.
      gridFromShortsPublished(read(join(dir, "06-shorts-published.linkedin-timer.json")), shorts?.instagram_author_page ?? "diaria", shorts?.instagram_collaborators ?? []),
      gridFromLinkedInPersonalIntent(read(join(dir, "06-linkedin-personal.json"))),
    );
  });
  return mergeGrids(gridFromWorkerQueue(queue), ...grids, facebook, buffer);
}
