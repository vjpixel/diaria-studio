/**
 * beehiiv-sync.ts (#1357)
 *
 * Popula `data/beehiiv-cache/posts/` com 1 JSON por post (detalhes + stats +
 * clicks), e `data/beehiiv-cache/publication.json` (info + stats da publicação).
 * Esses arquivos são consumidos por:
 *   - `scripts/build-link-ctr.ts` (lê posts/*.json pra construir CTR table)
 *   - `scripts/update-audience.ts` (lê publication.json pra subscriber count)
 *
 * Histórico: `beehiiv-sync.ts` foi adicionado no commit `20023ba` (2026-04-22)
 * junto com `build-link-ctr.ts`, mas o squash-merge de PR #24 só trouxe
 * `build-link-ctr.ts`. Resultado: build-link-ctr ficou órfão, dependendo de
 * cache que nenhum script populava. Sem este sync, `data/link-ctr-table.csv`
 * fica vazio (só header) → `update-audience.ts` não vê CTR comportamental →
 * `context/audience-profile.md` fica sem seção comportamental → scorer roda
 * só com sinal de survey. Regressão silenciosa (Stage 0 é warn-only).
 *
 * **Click data:** Beehiiv removeu o endpoint REST `/posts/{id}/clicks` da API
 * pública em algum momento após 2026-04-22. Hoje só dá pra buscar per-link
 * clicks via MCP `mcp__claude_ai_Beehiiv__list_post_clicks` — que **só é
 * chamável do top-level Claude** (não de scripts ou subagents). Este sync,
 * por isso, **não busca clicks**; só popula metadata + content + aggregate
 * stats. Emite `posts_needing_clicks` no resultado pra orchestrator
 * top-level enriquecer via MCP + `scripts/apply-mcp-clicks.ts`.
 *
 * Uso:
 *   npx tsx scripts/beehiiv-sync.ts              # incremental (default)
 *   npx tsx scripts/beehiiv-sync.ts --full       # re-fetch todos (ignora cache)
 *   npx tsx scripts/beehiiv-sync.ts --dry-run    # só lista o que faria
 *   npx tsx scripts/beehiiv-sync.ts --posts-only # pula publication.json
 *
 * Env:
 *   BEEHIIV_API_KEY           obrigatório
 *   BEEHIIV_PUBLICATION_ID    opcional — fallback p/ platform.config.json
 *   BEEHIIV_API_URL           opcional — override para tests
 *
 * Output (stdout): JSON `{ mode, posts_fetched, posts_skipped, posts_total,
 *   publication_synced, dry_run }`. Stderr: progresso humano.
 *
 * Exit codes: 0=sucesso, 1=erro API/IO, 2=config inválida.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseListPostsResponse } from "./lib/schemas/beehiiv.ts";
import { loadBeehiivConfig, type BeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// CONFIG_PATH removido: era usado apenas por loadConfig() — agora delegado a loadBeehiivConfig() (#2104)
const CACHE_DIR = resolve(ROOT, "data/beehiiv-cache");
const POSTS_DIR = resolve(CACHE_DIR, "posts");
const POSTS_INDEX = resolve(POSTS_DIR, "index.json");
const PUBLICATION_JSON = resolve(CACHE_DIR, "publication.json");
const BEEHIIV_API = beehiivApiBase(); // #2834/#2850: base URL centralizada em lib/beehiiv-config.ts

const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 5;

// #2104: Config é re-exportado de scripts/lib/beehiiv-config.ts (dedup de 3 cópias)
type Config = BeehiivConfig;

interface PostIndexEntry {
  id: string;
  title: string;
  status: string;
  publish_date: number | null;
  updated_at: string | null;
  web_url?: string;
}

export interface PostNeedingClicks {
  id: string;
  title: string;
  email_clicks: number;
}

export interface SyncResult {
  mode: "bootstrap" | "incremental" | "full";
  posts_fetched: number;
  posts_skipped: number;
  posts_total: number;
  publication_synced: boolean;
  dry_run: boolean;
  /**
   * Posts publicados há > MIN_AGE_DAYS_FOR_CLICKS dias, com aggregate
   * `email.clicks > 0` mas `stats.clicks` vazio no cache. Orchestrator
   * top-level deve enriquecê-los via MCP `list_post_clicks` + pipe pra
   * `apply-mcp-clicks.ts`. Cap em CLICKS_FETCH_BUDGET pra evitar bursts
   * grandes em runs incrementais.
   */
  posts_needing_clicks: PostNeedingClicks[];
}

/** Posts mais novos que isso ainda têm CTR não-estabilizado — mesmo filtro
 *  do build-link-ctr.ts (linha ~1180). */
const MIN_AGE_DAYS_FOR_CLICKS = 7;

/** Cap defensivo no manifest pra incremental runs. Mantido como sanity check
 *  caso o agent enricher fique indisponível e cair fallback no top-level —
 *  antes (#1357 followup) este cap protegia o contexto da conversa parent;
 *  com o agent `beehiiv-clicks-enricher` (#1361) o cap virou apenas safety
 *  net pra casos de erro. Pode subir significativamente sem custo. */
const CLICKS_FETCH_BUDGET_INCREMENTAL = 50;

// #2104: delegado ao helper centralizado em scripts/lib/beehiiv-config.ts
function loadConfig(): Config {
  return loadBeehiivConfig("[beehiiv-sync]");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiFetch<T>(path: string, apiKey: string, retries = 0): Promise<T> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch(`${BEEHIIV_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  if (res.status === 429 && retries < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    const wait = Math.max(retryAfter * 1000, 30_000);
    process.stderr.write(
      `[beehiiv-sync] rate-limited — esperando ${Math.round(wait / 1000)}s (tentativa ${retries + 1}/${MAX_RETRIES})\n`,
    );
    await sleep(wait);
    return apiFetch<T>(path, apiKey, retries + 1);
  }

  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status} ${path}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}

function ensureDirs(): void {
  mkdirSync(POSTS_DIR, { recursive: true });
}

function loadIndex(): PostIndexEntry[] {
  if (!existsSync(POSTS_INDEX)) return [];
  try {
    return JSON.parse(readFileSync(POSTS_INDEX, "utf8")) as PostIndexEntry[];
  } catch {
    return [];
  }
}

function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

export interface NeedsUpdateOpts {
  full?: boolean;
}

/**
 * Decide se precisa re-fetch o detalhe de um post.
 *
 * Pure function — separada pra testes unitários (#1357).
 */
export function needsUpdate(
  summary: { id: string; updated_at?: string | null },
  cachedIndex: Map<string, PostIndexEntry>,
  postFileExists: (id: string) => boolean,
  opts: NeedsUpdateOpts = {},
): boolean {
  if (opts.full) return true;
  const cached = cachedIndex.get(summary.id);
  if (!cached) return true;
  if (summary.updated_at && cached.updated_at !== summary.updated_at) return true;
  if (!postFileExists(summary.id)) return true;
  return false;
}

interface ListPostsPage {
  data: Array<{
    id: string;
    title?: string;
    subject?: string;
    status?: string;
    publish_date?: number | null;
    updated_at?: string | null;
    web_url?: string;
  }>;
  page?: number;
  total_pages?: number;
}

interface PostDetailResponse {
  data: {
    id: string;
    status?: string;
    publish_date?: number | null;
    stats?: { email?: Record<string, unknown>; web?: Record<string, unknown>; clicks?: unknown[] };
    content?: { free?: { web?: string; email?: string } };
    [k: string]: unknown;
  };
}

/**
 * Identifica posts que precisam de enrichment de clicks via MCP.
 *
 * Pure function — separada pra testes (#1357 followup). Retorna posts que:
 *   1. Status confirmed
 *   2. Publicados há > MIN_AGE_DAYS_FOR_CLICKS dias (mesmo cutoff do build-link-ctr)
 *   3. Aggregate `email.clicks > 0` (vale a pena buscar)
 *   4. `stats.clicks` vazio no cache local (ainda não foi enriquecido)
 *
 * Ordena por publish_date desc (mais recentes primeiro — orchestrator
 * processa em ordem de relevância) e respeita o budget passado.
 */
export function identifyPostsNeedingClicks(
  posts: Array<{
    id: string;
    title?: string;
    status?: string;
    publish_date?: number | null;
    stats?: { email?: { clicks?: number }; clicks?: unknown[] };
  }>,
  now: Date = new Date(),
  budget: number = Number.POSITIVE_INFINITY,
): PostNeedingClicks[] {
  const cutoffMs = now.getTime() - MIN_AGE_DAYS_FOR_CLICKS * 24 * 60 * 60 * 1000;
  const eligible: Array<PostNeedingClicks & { _publish_date: number }> = [];
  for (const p of posts) {
    if (p.status !== "confirmed") continue;
    if (!p.publish_date || p.publish_date * 1000 > cutoffMs) continue;
    const emailClicks = p.stats?.email?.clicks ?? 0;
    if (emailClicks <= 0) continue;
    if ((p.stats?.clicks?.length ?? 0) > 0) continue;
    eligible.push({
      id: p.id,
      title: p.title ?? "",
      email_clicks: emailClicks,
      _publish_date: p.publish_date,
    });
  }
  eligible.sort((a, b) => b._publish_date - a._publish_date);
  return eligible.slice(0, budget).map(({ _publish_date: _, ...rest }) => rest);
}

export interface SyncOpts {
  full: boolean;
  postsOnly: boolean;
  dryRun: boolean;
  /** Sem cap no manifest — usado em bootstrap quando orchestrator quer ver tudo. */
  unboundedClicksManifest?: boolean;
  /** Override config carregada — para tests. */
  configOverride?: Config;
}

export async function syncBeehiiv(opts: SyncOpts): Promise<SyncResult> {
  const cfg = opts.configOverride ?? loadConfig();
  ensureDirs();

  const cachedIndex = new Map(loadIndex().map((e) => [e.id, e]));
  const isBootstrap = cachedIndex.size === 0;
  const mode: SyncResult["mode"] = opts.full ? "full" : isBootstrap ? "bootstrap" : "incremental";

  process.stderr.write(`[beehiiv-sync] mode=${mode} pub=${cfg.publicationId}\n`);

  const newIndex: PostIndexEntry[] = [];
  let fetched = 0;
  let skipped = 0;
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const params = new URLSearchParams({
      per_page: "50",
      order_by: "publish_date",
      direction: "desc",
      page: String(page),
    });
    process.stderr.write(`[beehiiv-sync] listing page ${page}\n`);
    const raw = await apiFetch<unknown>(
      `/publications/${cfg.publicationId}/posts?${params}`,
      cfg.apiKey,
    );
    const parsed = parseListPostsResponse(raw);
    const summaries = (parsed.data ?? []) as ListPostsPage["data"];
    totalPages = parsed.total_pages ?? 1;

    let allCached = true;
    for (const s of summaries) {
      if (needsUpdate(s, cachedIndex, (id) => existsSync(resolve(POSTS_DIR, `${id}.json`)), { full: opts.full })) {
        allCached = false;
        break;
      }
    }

    for (const s of summaries) {
      const indexEntry: PostIndexEntry = {
        id: s.id,
        title: s.title ?? s.subject ?? "",
        status: s.status ?? "",
        publish_date: s.publish_date ?? null,
        updated_at: s.updated_at ?? null,
        web_url: s.web_url,
      };
      newIndex.push(indexEntry);

      if (!needsUpdate(s, cachedIndex, (id) => existsSync(resolve(POSTS_DIR, `${id}.json`)), { full: opts.full })) {
        skipped++;
        continue;
      }

      if (opts.dryRun) {
        process.stderr.write(`  [dry-run] would fetch ${s.id} — ${indexEntry.title}\n`);
        fetched++;
        continue;
      }

      // Fetch detail (content + stats)
      const expandParams = new URLSearchParams();
      expandParams.append("expand[]", "free_web_content");
      expandParams.append("expand[]", "free_email_content");
      expandParams.append("expand[]", "stats");
      let detail: PostDetailResponse["data"];
      try {
        const resp = await apiFetch<PostDetailResponse>(
          `/publications/${cfg.publicationId}/posts/${s.id}?${expandParams}`,
          cfg.apiKey,
        );
        detail = resp.data;
      } catch (e) {
        process.stderr.write(`  ! detail failed for ${s.id}: ${e instanceof Error ? e.message : e}\n`);
        skipped++;
        continue;
      }

      // Per-link clicks NÃO são buscadas aqui — endpoint REST `/posts/{id}/clicks`
      // não existe mais na API pública. Preservar clicks enriquecidos via
      // MCP em runs anteriores (sobrescrever só perde dado caro de buscar).
      const cachedPath = resolve(POSTS_DIR, `${s.id}.json`);
      let preservedClicks: unknown[] = [];
      if (existsSync(cachedPath)) {
        try {
          const cached = JSON.parse(readFileSync(cachedPath, "utf8"));
          preservedClicks = cached?.stats?.clicks ?? [];
        } catch {
          // cache corrompido — ignora, vai sobrescrever com array vazio
        }
      }
      detail.stats = { ...(detail.stats ?? {}), clicks: preservedClicks };

      // Also expose content.free.{web,email} layout que build-link-ctr lê
      // — alguns posts retornam `free_web_content`/`free_email_content` no top
      // level em vez de `content.free.*`. Normalizar.
      const detailAny = detail as Record<string, unknown>;
      const freeWeb = detailAny["free_web_content"] as string | undefined;
      const freeEmail = detailAny["free_email_content"] as string | undefined;
      if (freeWeb || freeEmail) {
        const existingContent = (detail.content ?? {}) as { free?: { web?: string; email?: string } };
        const existingFree = existingContent.free ?? {};
        detail.content = {
          ...existingContent,
          free: {
            web: existingFree.web ?? freeWeb,
            email: existingFree.email ?? freeEmail,
          },
        };
      }

      atomicWrite(
        resolve(POSTS_DIR, `${s.id}.json`),
        JSON.stringify({ ...detail, _synced_at: new Date().toISOString() }, null, 2),
      );
      fetched++;
      process.stderr.write(`  ↓ ${s.id} — ${indexEntry.title.slice(0, 60)}\n`);
    }

    // Incremental shortcut: se a página inteira já está cached, parar de paginar.
    if (!opts.full && allCached && page > 1) {
      process.stderr.write(`[beehiiv-sync] página ${page} toda cached — parando incremental\n`);
      // Preservar entradas do índice antigo que ainda não vimos.
      for (const [id, entry] of cachedIndex) {
        if (!newIndex.find((p) => p.id === id)) newIndex.push(entry);
      }
      break;
    }

    page++;
  }

  // Ordenar por publish_date desc (mais recentes primeiro).
  newIndex.sort((a, b) => (b.publish_date ?? 0) - (a.publish_date ?? 0));

  if (!opts.dryRun) {
    atomicWrite(POSTS_INDEX, JSON.stringify(newIndex, null, 2));
  }

  // Publication info + stats (subscriber count usado por update-audience).
  let publicationSynced = false;
  if (!opts.postsOnly) {
    if (opts.dryRun) {
      process.stderr.write(`[beehiiv-sync] [dry-run] would fetch publication\n`);
      publicationSynced = true;
    } else {
      try {
        const pubResp = await apiFetch<{ data: unknown }>(
          `/publications/${cfg.publicationId}?expand[]=stats`,
          cfg.apiKey,
        );
        if (pubResp.data) {
          atomicWrite(
            PUBLICATION_JSON,
            JSON.stringify({ ...(pubResp.data as object), _synced_at: new Date().toISOString() }, null, 2),
          );
          publicationSynced = true;
          process.stderr.write(`[beehiiv-sync] publication.json saved\n`);
        }
      } catch (e) {
        process.stderr.write(`[beehiiv-sync] publication fetch failed: ${e instanceof Error ? e.message : e}\n`);
      }
    }
  }

  // Build needs-clicks manifest scanning the cache (não os summaries da lista,
  // que não têm `stats` populado). Bootstrap pode emitir centenas; incremental
  // só os mais recentes (cap CLICKS_FETCH_BUDGET_INCREMENTAL).
  const postsNeedingClicks: PostNeedingClicks[] = [];
  if (!opts.dryRun) {
    const cachedPosts: Array<{
      id: string;
      title?: string;
      status?: string;
      publish_date?: number | null;
      stats?: { email?: { clicks?: number }; clicks?: unknown[] };
    }> = [];
    for (const f of readdirSync(POSTS_DIR)) {
      if (f === "index.json" || !f.endsWith(".json")) continue;
      try {
        const obj = JSON.parse(readFileSync(resolve(POSTS_DIR, f), "utf8"));
        cachedPosts.push(obj);
      } catch {
        // skip corrupt
      }
    }
    const budget = opts.unboundedClicksManifest
      ? Number.POSITIVE_INFINITY
      : (mode === "bootstrap" || mode === "full" ? Number.POSITIVE_INFINITY : CLICKS_FETCH_BUDGET_INCREMENTAL);
    postsNeedingClicks.push(...identifyPostsNeedingClicks(cachedPosts, new Date(), budget));
  }

  return {
    mode,
    posts_fetched: fetched,
    posts_skipped: skipped,
    posts_total: newIndex.length,
    publication_synced: publicationSynced,
    dry_run: opts.dryRun,
    posts_needing_clicks: postsNeedingClicks,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: SyncOpts = {
    full: argv.includes("--full"),
    postsOnly: argv.includes("--posts-only"),
    dryRun: argv.includes("--dry-run"),
    unboundedClicksManifest: argv.includes("--unbounded-clicks-manifest"),
  };
  const result = await syncBeehiiv(opts);
  console.log(JSON.stringify(result));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
