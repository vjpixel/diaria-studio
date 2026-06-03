/**
 * backup-beehiiv.ts (#1742)
 *
 * Backup full **manual sob demanda** (MVP) de tudo que a API REST pública do
 * Beehiiv expõe pra esta publicação. Decisão editorial 2026-06-03: começar
 * manual, sem trigger automático — automatizar o disparo (piggyback no Stage 0
 * ou cron remoto) fica pra follow-up depois de validar que o backup roda
 * completo e cabe (especialmente `subscribers.jsonl` da base inteira).
 *
 * Grava em `data/beehiiv-backup/{YYYY-MM-DD}/`:
 *   publication.json        — metadata + stats da publicação
 *   custom-fields.json      — schema de custom fields (inclui poll_sig)
 *   segments.json           — segments definidos
 *   automations.json        — automations
 *   email-blasts.json       — email blasts (se o plano expõe)
 *   tiers.json              — subscription tiers
 *   referral-program.json   — programa de indicação (se configurado)
 *   posts/{post_id}.json    — 1 por post: content (web+email) + stats
 *   subscribers.jsonl       — 1 linha por subscriber (custom fields + tags)
 *   manifest.json           — sumário: timestamp, contagens, status por endpoint
 *
 * **Cobertura:** só o que a REST pública expõe. Per-link clicks e per-subscriber
 * engagement são MCP-only (`list_post_clicks`, `list_post_subscriber_engagement`,
 * cháveis só do top-level Claude — ver beehiiv-sync.ts) e NÃO entram neste MVP;
 * o manifest sinaliza esses gaps em `mcp_only_gaps`. Votos do É IA? vivem no
 * Worker KV (fora do Beehiiv) — backup separado (out of scope, ver issue).
 *
 * Uso:
 *   npx tsx scripts/backup-beehiiv.ts                  # backup completo de hoje
 *   npx tsx scripts/backup-beehiiv.ts --date 2026-06-03
 *   npx tsx scripts/backup-beehiiv.ts --out /caminho   # diretório alternativo
 *   npx tsx scripts/backup-beehiiv.ts --no-subscribers # pula a base (mais rápido)
 *   npx tsx scripts/backup-beehiiv.ts --no-content     # posts sem html (só stats)
 *   npx tsx scripts/backup-beehiiv.ts --posts-limit 5  # smoke test
 *   npx tsx scripts/backup-beehiiv.ts --dry-run        # só imprime o plano
 *
 * Env:
 *   BEEHIIV_API_KEY           obrigatório
 *   BEEHIIV_PUBLICATION_ID    opcional — fallback p/ platform.config.json
 *   BEEHIIV_API_URL           opcional — override para tests
 *
 * Output (stdout): JSON do manifest. Stderr: progresso humano.
 * Exit codes: 0=sucesso, 1=erro fatal de IO/API, 2=config inválida.
 */

import "dotenv/config";
import { readFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "platform.config.json");
const BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const BEEHIIV_API = process.env.BEEHIIV_API_URL ?? "https://api.beehiiv.com/v2";

const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 5;
const PER_PAGE = 100;

/** Endpoints que existem só no MCP (não na REST pública) — sinalizados no
 *  manifest pra que ninguém assuma que o backup é exaustivo. */
export const MCP_ONLY_GAPS = [
  "per-link clicks (list_post_clicks)",
  "per-subscriber engagement (list_post_subscriber_engagement)",
] as const;

export interface Config {
  apiKey: string;
  publicationId: string;
}

export interface EndpointSpec {
  /** Chave no manifest. */
  key: string;
  /** Path relativo à base da API (já com publicationId). */
  path: string;
  /** Nome do arquivo de saída. */
  file: string;
  /** Se o endpoint pagina (envelope { data, total_pages }). */
  paginated: boolean;
  /** 404/403 é tolerado (recurso não configurado no plano). */
  optional?: boolean;
}

/**
 * Enumera os endpoints publication-level a backupar. Pure — testável sem rede.
 *
 * Cobre o escopo declarado em #1742: metadata, custom fields, segments,
 * templates/automations, tiers e referral program.
 */
export function publicationEndpoints(pubId: string): EndpointSpec[] {
  const base = `/publications/${pubId}`;
  return [
    { key: "publication", path: `${base}?expand[]=stats`, file: "publication.json", paginated: false },
    { key: "custom_fields", path: `${base}/custom_fields`, file: "custom-fields.json", paginated: true },
    { key: "segments", path: `${base}/segments`, file: "segments.json", paginated: true },
    { key: "automations", path: `${base}/automations`, file: "automations.json", paginated: true, optional: true },
    { key: "email_blasts", path: `${base}/email_blasts`, file: "email-blasts.json", paginated: true, optional: true },
    { key: "tiers", path: `${base}/tiers`, file: "tiers.json", paginated: true, optional: true },
    { key: "referral_program", path: `${base}/referral_program`, file: "referral-program.json", paginated: false, optional: true },
  ];
}

export interface ManifestEntry {
  key: string;
  file: string;
  status: "ok" | "skipped" | "error";
  count?: number;
  error?: string;
}

export interface Manifest {
  generated_at: string;
  publication_id: string;
  api_base: string;
  options: { subscribers: boolean; content: boolean; posts_limit: number | null; dry_run: boolean };
  endpoints: ManifestEntry[];
  posts: { fetched: number; errors: number };
  subscribers: { fetched: number } | null;
  mcp_only_gaps: readonly string[];
  totals: { ok: number; skipped: number; error: number };
}

/**
 * Sumariza os resultados num manifest. Pure — testável sem rede.
 */
export function summarizeManifest(input: {
  generatedAt: string;
  publicationId: string;
  apiBase: string;
  options: Manifest["options"];
  endpoints: ManifestEntry[];
  posts: { fetched: number; errors: number };
  subscribers: { fetched: number } | null;
}): Manifest {
  const totals = { ok: 0, skipped: 0, error: 0 };
  for (const e of input.endpoints) totals[e.status]++;
  return {
    generated_at: input.generatedAt,
    publication_id: input.publicationId,
    api_base: input.apiBase,
    options: input.options,
    endpoints: input.endpoints,
    posts: input.posts,
    subscribers: input.subscribers,
    mcp_only_gaps: MCP_ONLY_GAPS,
    totals,
  };
}

export function backupDir(root: string, date: string): string {
  return resolve(root, date);
}

/** YYYY-MM-DD em UTC a partir de um Date. Pure. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function loadConfig(): Config {
  const apiKey = process.env.BEEHIIV_API_KEY;
  if (!apiKey) {
    console.error("BEEHIIV_API_KEY não definida. Configure no .env (veja .env.example).");
    process.exit(2);
  }
  if (!existsSync(CONFIG_PATH)) {
    console.error(`platform.config.json não encontrado em ${CONFIG_PATH}`);
    process.exit(2);
  }
  let cfg: { beehiiv?: { publicationId?: string } };
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`platform.config.json inválido: ${(e as Error).message}`);
    process.exit(2);
  }
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID ?? cfg.beehiiv?.publicationId ?? "";
  if (!publicationId) {
    console.error(
      "publicationId ausente — adicione `beehiiv.publicationId` em platform.config.json ou exporte BEEHIIV_PUBLICATION_ID.",
    );
    process.exit(2);
  }
  return { apiKey, publicationId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FetchResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
}

/**
 * Fetch com retry de rate-limit. Retorna `{ ok, status, body }` em vez de
 * lançar em 4xx — assim o caller decide se um 404 num endpoint opcional é
 * skip (tolerado) ou erro.
 */
async function apiFetch<T>(path: string, apiKey: string, retries = 0): Promise<FetchResult<T>> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch(`${BEEHIIV_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  if (res.status === 429 && retries < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    const wait = Math.max(retryAfter * 1000, 30_000);
    process.stderr.write(
      `[backup-beehiiv] rate-limited — esperando ${Math.round(wait / 1000)}s (tentativa ${retries + 1}/${MAX_RETRIES})\n`,
    );
    await sleep(wait);
    return apiFetch<T>(path, apiKey, retries + 1);
  }

  if (!res.ok) {
    return { ok: false, status: res.status, body: null };
  }
  return { ok: true, status: res.status, body: (await res.json()) as T };
}

interface Page<T> {
  data?: T[];
  total_pages?: number;
  page?: number;
}

/**
 * Drena todas as páginas de um endpoint paginado, concatenando `data`.
 * Lança em erro não-tolerado; retorna `null` se 404/403 (caller trata como skip).
 */
async function fetchAllPages<T>(
  basePath: string,
  apiKey: string,
): Promise<T[] | null> {
  const items: T[] = [];
  let page = 1;
  let totalPages = 1;
  const sep = basePath.includes("?") ? "&" : "?";
  while (page <= totalPages) {
    const res = await apiFetch<Page<T>>(`${basePath}${sep}per_page=${PER_PAGE}&page=${page}`, apiKey);
    if (!res.ok) {
      if (res.status === 404 || res.status === 403) return null;
      throw new Error(`Beehiiv API ${res.status} em ${basePath} (página ${page})`);
    }
    const body = res.body!;
    items.push(...(body.data ?? []));
    totalPages = body.total_pages ?? 1;
    page++;
  }
  return items;
}

export interface BackupOpts {
  date: string;
  outDir?: string;
  subscribers: boolean;
  content: boolean;
  postsLimit: number | null;
  dryRun: boolean;
  configOverride?: Config;
}

export async function backupBeehiiv(opts: BackupOpts): Promise<Manifest> {
  const cfg = opts.configOverride ?? loadConfig();
  const dir = opts.outDir ?? backupDir(BACKUP_ROOT, opts.date);
  const generatedAt = new Date().toISOString();

  process.stderr.write(
    `[backup-beehiiv] pub=${cfg.publicationId} out=${dir} subscribers=${opts.subscribers} content=${opts.content}${opts.dryRun ? " (dry-run)" : ""}\n`,
  );

  const endpoints: ManifestEntry[] = [];
  const postStats = { fetched: 0, errors: 0 };
  let subscribers: { fetched: number } | null = opts.subscribers ? { fetched: 0 } : null;

  if (opts.dryRun) {
    for (const ep of publicationEndpoints(cfg.publicationId)) {
      process.stderr.write(`[backup-beehiiv] (dry) ${ep.key} → ${ep.file}\n`);
      endpoints.push({ key: ep.key, file: ep.file, status: "skipped" });
    }
    process.stderr.write(`[backup-beehiiv] (dry) posts/ + subscribers.jsonl\n`);
    return summarizeManifest({
      generatedAt,
      publicationId: cfg.publicationId,
      apiBase: BEEHIIV_API,
      options: { subscribers: opts.subscribers, content: opts.content, posts_limit: opts.postsLimit, dry_run: true },
      endpoints,
      posts: postStats,
      subscribers,
    });
  }

  mkdirSync(resolve(dir, "posts"), { recursive: true });

  // 1. Endpoints publication-level
  for (const ep of publicationEndpoints(cfg.publicationId)) {
    try {
      if (ep.paginated) {
        const items = await fetchAllPages<unknown>(ep.path, cfg.apiKey);
        if (items === null) {
          process.stderr.write(`[backup-beehiiv] ${ep.key}: não disponível (skip)\n`);
          endpoints.push({ key: ep.key, file: ep.file, status: "skipped" });
          continue;
        }
        writeFileAtomic(resolve(dir, ep.file), JSON.stringify(items, null, 2));
        endpoints.push({ key: ep.key, file: ep.file, status: "ok", count: items.length });
        process.stderr.write(`[backup-beehiiv] ${ep.key}: ${items.length} itens\n`);
      } else {
        const res = await apiFetch<{ data?: unknown }>(ep.path, cfg.apiKey);
        if (!res.ok) {
          if (ep.optional && (res.status === 404 || res.status === 403)) {
            process.stderr.write(`[backup-beehiiv] ${ep.key}: não configurado (skip)\n`);
            endpoints.push({ key: ep.key, file: ep.file, status: "skipped" });
            continue;
          }
          throw new Error(`Beehiiv API ${res.status} em ${ep.path}`);
        }
        writeFileAtomic(resolve(dir, ep.file), JSON.stringify(res.body, null, 2));
        endpoints.push({ key: ep.key, file: ep.file, status: "ok", count: 1 });
        process.stderr.write(`[backup-beehiiv] ${ep.key}: ok\n`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[backup-beehiiv] ${ep.key}: ERRO — ${msg}\n`);
      endpoints.push({ key: ep.key, file: ep.file, status: "error", error: msg });
    }
  }

  // 2. Posts — lista + detalhe por post (content + stats)
  try {
    const summaries = await fetchAllPages<{ id: string }>(
      `/publications/${cfg.publicationId}/posts?order_by=publish_date&direction=desc`,
      cfg.apiKey,
    );
    const list = summaries ?? [];
    const limited = opts.postsLimit !== null ? list.slice(0, opts.postsLimit) : list;
    const expand = opts.content
      ? "expand[]=free_web_content&expand[]=free_email_content&expand[]=premium_web_content&expand[]=premium_email_content&expand[]=stats"
      : "expand[]=stats";
    for (const s of limited) {
      const res = await apiFetch<{ data?: unknown }>(
        `/publications/${cfg.publicationId}/posts/${s.id}?${expand}`,
        cfg.apiKey,
      );
      if (!res.ok) {
        postStats.errors++;
        process.stderr.write(`[backup-beehiiv] post ${s.id}: ERRO ${res.status}\n`);
        continue;
      }
      writeFileAtomic(resolve(dir, "posts", `${s.id}.json`), JSON.stringify(res.body, null, 2));
      postStats.fetched++;
    }
    endpoints.push({ key: "posts", file: "posts/", status: "ok", count: postStats.fetched });
    process.stderr.write(`[backup-beehiiv] posts: ${postStats.fetched} salvos, ${postStats.errors} erros\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[backup-beehiiv] posts: ERRO — ${msg}\n`);
    endpoints.push({ key: "posts", file: "posts/", status: "error", error: msg });
  }

  // 3. Subscribers — JSONL, 1 linha por subscriber (pode ser grande)
  if (opts.subscribers) {
    const subsFile = resolve(dir, "subscribers.jsonl");
    try {
      rmSync(subsFile, { force: true }); // overwrite limpo (append abaixo)
      let page = 1;
      let totalPages = 1;
      let count = 0;
      while (page <= totalPages) {
        const res = await apiFetch<Page<unknown>>(
          `/publications/${cfg.publicationId}/subscriptions?expand[]=custom_fields&expand[]=tags&expand[]=referrals&per_page=${PER_PAGE}&page=${page}`,
          cfg.apiKey,
        );
        if (!res.ok) throw new Error(`Beehiiv API ${res.status} em subscriptions (página ${page})`);
        const body = res.body!;
        const chunk = (body.data ?? []).map((sub) => JSON.stringify(sub)).join("\n");
        if (chunk) appendFileSync(subsFile, chunk + "\n", "utf8");
        count += body.data?.length ?? 0;
        totalPages = body.total_pages ?? 1;
        process.stderr.write(`[backup-beehiiv] subscribers: página ${page}/${totalPages} (${count} total)\n`);
        page++;
      }
      subscribers = { fetched: count };
      endpoints.push({ key: "subscribers", file: "subscribers.jsonl", status: "ok", count });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[backup-beehiiv] subscribers: ERRO — ${msg}\n`);
      endpoints.push({ key: "subscribers", file: "subscribers.jsonl", status: "error", error: msg });
    }
  }

  const manifest = summarizeManifest({
    generatedAt,
    publicationId: cfg.publicationId,
    apiBase: BEEHIIV_API,
    options: { subscribers: opts.subscribers, content: opts.content, posts_limit: opts.postsLimit, dry_run: false },
    endpoints,
    posts: postStats,
    subscribers,
  });
  writeFileAtomic(resolve(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function parseArgs(argv: string[]): BackupOpts {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const limitRaw = get("--posts-limit");
  return {
    date: get("--date") ?? isoDate(new Date()),
    outDir: get("--out"),
    subscribers: !argv.includes("--no-subscribers"),
    content: !argv.includes("--no-content"),
    postsLimit: limitRaw ? parseInt(limitRaw, 10) : null,
    dryRun: argv.includes("--dry-run"),
  };
}

async function main(): Promise<void> {
  const manifest = await backupBeehiiv(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(manifest, null, 2));
  if (manifest.totals.error > 0) {
    process.stderr.write(`[backup-beehiiv] ⚠ ${manifest.totals.error} endpoint(s) com erro — ver manifest.\n`);
  }
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
