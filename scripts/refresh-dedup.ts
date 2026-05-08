/**
 * refresh-dedup.ts (#895)
 *
 * Substitui o subagente `refresh-dedup-runner` por script determinístico que
 * usa a API REST do Beehiiv diretamente. Elimina dependência de MCP em
 * subagente (UUID antigo `mcp__ed929847-*` não existe mais; o conector ativo
 * `mcp__claude_ai_Beehiiv__*` não é repassado a subagentes; rodar inline no
 * top-level pulava a regen do MD — bug #895, regressão de #162).
 *
 * Mantém `data/past-editions-raw.json` (canônico) e regenera
 * `context/past-editions.md` (derivado, lido por dedup.ts) end-to-end:
 *
 *   1. Detecta bootstrap (raw não existe) ou incremental (raw existe).
 *   2. Bootstrap: busca as `dedupEditionCount` edições mais recentes.
 *   3. Incremental: busca só edições mais novas que `max(published_at)` do raw.
 *   4. Ambos: chama `get_post` pra cada novo, popula `links[]` (resolve tracking
 *      Beehiiv via HEAD; #234) e regenera o MD via `refresh-past-editions.ts`.
 *   5. **Sempre regenera o MD** — mesmo com 0 novos posts (cobre o caso de
 *      `git pull` ter resetado o tracked file enquanto o raw ficou intacto;
 *      #162).
 *
 * Uso:
 *   npx tsx scripts/refresh-dedup.ts
 *
 * Flags opcionais:
 *   --dry-run                  imprime o que faria sem mexer em arquivos
 *   --no-resolve-tracking      pular HEAD requests (tests / debugging)
 *
 * Variáveis de ambiente (dotenv carregado automaticamente):
 *   BEEHIIV_API_KEY           obrigatório
 *   BEEHIIV_PUBLICATION_ID    opcional — fallback p/ platform.config.json
 *
 * Output (stdout): JSON `{ mode, new_posts, total_in_base, most_recent_date,
 * skipped, md_regenerated }`. Schema casa com o que o subagente retornava
 * pra orchestrator não mudar.
 *
 * Exit codes:
 *   0 = sucesso
 *   1 = erro de API/IO (falha loud pro orchestrator parar Stage 0)
 *   2 = config inválida (sem API key, sem publicationId)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Post,
  populateLinksFromTracking,
  populateAllFromApproved,
  renderMarkdown,
  extractLinks,
} from "./refresh-past-editions.ts";
import { extractPublishedAtIso, extractPublishedDate } from "./lib/beehiiv-timestamp.ts";
import { parseListPostsResponse, parseBeehiivPost } from "./lib/schemas/beehiiv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "platform.config.json");
const RAW_PATH = resolve(ROOT, "data/past-editions-raw.json");
const MD_PATH = resolve(ROOT, "context/past-editions.md");
// `BEEHIIV_API_URL` override permite que testes apontem pra mock server local
// (#895). Em produção, ausente — usa a URL canônica.
const BEEHIIV_API = process.env.BEEHIIV_API_URL ?? "https://api.beehiiv.com/v2";

export interface RefreshConfig {
  apiKey: string;
  publicationId: string;
  dedupEditionCount: number;
}

export interface RefreshResult {
  mode: "bootstrap" | "incremental";
  new_posts: number;
  total_in_base: number;
  most_recent_date: string | null;
  skipped: false; // sempre false — MD é sempre regenerado, mesmo sem novos posts
  md_regenerated: true;
}

function loadConfig(): RefreshConfig {
  const apiKey = process.env.BEEHIIV_API_KEY;
  if (!apiKey) {
    console.error("BEEHIIV_API_KEY não definida. Configure no .env (veja .env.example).");
    process.exit(2);
  }
  if (!existsSync(CONFIG_PATH)) {
    console.error(`platform.config.json não encontrado em ${CONFIG_PATH}`);
    process.exit(2);
  }
  let cfg: { beehiiv?: { publicationId?: string; dedupEditionCount?: number } };
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`platform.config.json inválido: ${(e as Error).message}`);
    process.exit(2);
  }
  const publicationId =
    process.env.BEEHIIV_PUBLICATION_ID ?? cfg.beehiiv?.publicationId ?? "";
  if (!publicationId) {
    console.error(
      "publicationId ausente — adicione `beehiiv.publicationId` em platform.config.json ou exporte BEEHIIV_PUBLICATION_ID.",
    );
    process.exit(2);
  }
  const dedupEditionCount = cfg.beehiiv?.dedupEditionCount ?? 14;
  return { apiKey, publicationId, dedupEditionCount };
}

async function apiFetch<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${BEEHIIV_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status} ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface BeehiivPostSummary {
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

interface BeehiivPostDetail extends BeehiivPostSummary {
  html?: string;
  free_web_content?: string;
  free_email_content?: string;
  content?: {
    free?: { web?: string; email?: string };
  };
}

/**
 * Lista posts via API REST. Pagina até atingir `limit` ou `stopBeforeIso` —
 * ambos opcionais. `stopBeforeIso` é usado em modo incremental: para de
 * paginar assim que encontrar um post com `published_at <= stopBeforeIso`
 * (todos os subsequentes são iguais ou mais antigos).
 *
 * Filtra agendamentos futuros (`status: "confirmed"` mas `publish_date >
 * now`) via `extractPublishedDate(post, now)` retornando `null` (#573).
 */
async function listPosts(
  cfg: RefreshConfig,
  opts: { limit: number; stopBeforeMs?: number },
): Promise<BeehiivPostSummary[]> {
  const collected: BeehiivPostSummary[] = [];
  const now = new Date();
  let page = 1;

  while (collected.length < opts.limit) {
    // #972: `order_by=newest_first` retorna posts em ordem invertida (mais antigos
    // primeiro) na Beehiiv API v2. A query correta é `order_by=publish_date` +
    // `direction=desc`, que retorna os mais recentes primeiro — necessário pro
    // loop incremental parar no `stopBeforeMs` cutoff.
    const params = new URLSearchParams({
      per_page: "50",
      order_by: "publish_date",
      direction: "desc",
      page: String(page),
    });
    const raw = await apiFetch<unknown>(
      `/publications/${cfg.publicationId}/posts?${params}`,
      cfg.apiKey,
    );
    const data = parseListPostsResponse(raw);
    const posts = data.data ?? [];
    if (posts.length === 0) break;

    let stoppedAtCutoff = false;
    for (const p of posts as BeehiivPostSummary[]) {
      const dt = extractPublishedDate(p, now);
      if (!dt) continue; // agendado futuro ou sem timestamp parseável — pula
      const ms = dt.getTime();
      if (opts.stopBeforeMs !== undefined && ms <= opts.stopBeforeMs) {
        // Encontrou post igual/mais antigo que o cutoff — para de paginar.
        stoppedAtCutoff = true;
        break;
      }
      collected.push(p);
      if (collected.length >= opts.limit) break;
    }

    if (stoppedAtCutoff) break;
    if (data.total_pages && page >= data.total_pages) break;
    page++;
  }

  return collected;
}

/**
 * Busca conteúdo de 1 post (HTML). Beehiiv API v2 só retorna HTML
 * (não markdown) — mas pra dedup só precisamos extrair URLs, então é OK.
 */
async function fetchPostContent(
  postId: string,
  cfg: RefreshConfig,
): Promise<{ html?: string; web_url?: string }> {
  const params = new URLSearchParams();
  params.append("expand[]", "free_web_content");
  params.append("expand[]", "free_email_content");
  const raw = await apiFetch<{ data: unknown }>(
    `/publications/${cfg.publicationId}/posts/${postId}?${params}`,
    cfg.apiKey,
  );
  const detail = parseBeehiivPost(raw.data) as BeehiivPostDetail;
  // Preferência: html canônico > free_email_content > content.free.email > free_web_content > content.free.web
  const html =
    detail.html ||
    detail.free_email_content ||
    detail.content?.free?.email ||
    detail.free_web_content ||
    detail.content?.free?.web ||
    undefined;
  return { html, web_url: detail.web_url };
}

function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * #978: Converte ISO timestamp pra AAMMDD da edição (UTC).
 *
 * Edições publicam por padrão na manhã do dia indicado pelo `publish_date`
 * (Beehiiv). Não tentamos timezone-shift — UTC é suficiente pro mapping
 * data→edition_dir.
 */
export function publishedAtToEditionDir(isoUtc: string): string | null {
  const m = isoUtc.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const yy = m[1].slice(2);
  return `${yy}${m[2]}${m[3]}`;
}

interface PublishedJson {
  status?: string;
  published_at?: string;
  post_id?: string;
  post_url?: string;
  inferred_from_beehiiv?: boolean;
  [key: string]: unknown;
}

/**
 * #978: auto-stamp `05-published.json` quando refresh-dedup confirma que um
 * post foi publicado no Beehiiv. Idempotente — só atualiza quando status
 * != "published" (pra não sobrescrever metadata de rascunho/agendamento que
 * o agent gravou). Nunca cria diretório novo se a edição não existir local
 * (evita stamp pra edições futuras do scheduling Beehiiv).
 *
 * Caso 260507 publicada manualmente sem 05-published.json: stampa o arquivo
 * com `inferred_from_beehiiv: true`. Caso 260508 com `status: "scheduled"`
 * pré-publicação: deixa intocado (status correto refletindo agendamento).
 *
 * Retorna true quando arquivo foi escrito/atualizado.
 */
export function autoStampPublishedJson(
  editionsRoot: string,
  post: Post,
): boolean {
  const editionDir = publishedAtToEditionDir(post.published_at);
  if (!editionDir) return false;
  const dirPath = resolve(editionsRoot, editionDir);
  if (!existsSync(dirPath)) return false; // sem edition local — não criar
  const internalDir = resolve(dirPath, "_internal");
  const targetPath = resolve(internalDir, "05-published.json");

  let existing: PublishedJson = {};
  if (existsSync(targetPath)) {
    try {
      existing = JSON.parse(readFileSync(targetPath, "utf8"));
    } catch {
      existing = {};
    }
  }
  // Status "published" já refletido — no-op pra evitar re-write desnecessário.
  if (existing.status === "published") return false;

  const updated: PublishedJson = {
    ...existing,
    status: "published",
    published_at: post.published_at,
    post_id: post.id,
    post_url: post.web_url ?? existing.post_url,
    inferred_from_beehiiv: true,
  };

  try {
    mkdirSync(internalDir, { recursive: true });
    const tmp = targetPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(updated, null, 2), "utf8");
    renameSync(tmp, targetPath);
    return true;
  } catch {
    return false;
  }
}

function mergeById(existing: Post[], incoming: Post[]): Post[] {
  const byId = new Map<string, Post>();
  for (const p of existing) byId.set(p.id, p);
  for (const p of incoming) byId.set(p.id, p); // incoming wins (fresher data)
  return [...byId.values()];
}

function sortDesc(posts: Post[]): Post[] {
  return [...posts].sort(
    (a, b) =>
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
  );
}

/**
 * Converte BeehiivPostSummary + html buscado em `Post` canônico do raw JSON.
 */
function toCanonicalPost(
  summary: BeehiivPostSummary,
  html: string | undefined,
  web_url: string | undefined,
  now: Date,
): Post | null {
  const publishedIso = extractPublishedAtIso(summary, now);
  if (!publishedIso) return null;
  const title = summary.title ?? summary.subject ?? "(sem título)";
  return {
    id: summary.id,
    title,
    web_url: web_url ?? summary.web_url,
    published_at: publishedIso,
    html,
  };
}

export interface MainOpts {
  dryRun: boolean;
  resolveTracking: boolean;
  /** Override paths para testes (#895). */
  rawPath?: string;
  mdPath?: string;
  /** Override config carregada — se passado, pula `loadConfig()`. */
  configOverride?: RefreshConfig;
  /** #978: override do root de editions (default: data/editions). Tests injetam tmp. */
  editionsRoot?: string;
  /** #978: pular auto-stamp de 05-published.json (default: ativo). */
  noAutoStamp?: boolean;
}

export async function refreshDedup(opts: MainOpts): Promise<RefreshResult> {
  const cfg = opts.configOverride ?? loadConfig();
  const rawPath = opts.rawPath ?? RAW_PATH;
  const mdPath = opts.mdPath ?? MD_PATH;
  const now = new Date();

  const existing = readJsonOrNull<Post[]>(rawPath);
  const isBootstrap = !existing || existing.length === 0;

  let mode: "bootstrap" | "incremental";
  let incomingSummaries: BeehiivPostSummary[];

  if (isBootstrap) {
    mode = "bootstrap";
    process.stderr.write(
      `[refresh-dedup] Bootstrap: buscando ${cfg.dedupEditionCount} edições mais recentes\n`,
    );
    incomingSummaries = await listPosts(cfg, { limit: cfg.dedupEditionCount });
  } else {
    mode = "incremental";
    const maxKnownMs = Math.max(
      ...(existing as Post[]).map((p) => new Date(p.published_at).getTime()),
    );
    const maxKnownIso = new Date(maxKnownMs).toISOString();
    process.stderr.write(
      `[refresh-dedup] Incremental: buscando edições > ${maxKnownIso}\n`,
    );
    incomingSummaries = await listPosts(cfg, {
      limit: cfg.dedupEditionCount,
      stopBeforeMs: maxKnownMs,
    });
  }

  process.stderr.write(
    `[refresh-dedup] ${incomingSummaries.length} novos post(s) detectado(s)\n`,
  );

  // Buscar HTML de cada novo post pra popular links[] downstream.
  const incomingPosts: Post[] = [];
  for (const summary of incomingSummaries) {
    process.stderr.write(`  ↓ ${summary.id} (${summary.title ?? "sem título"})\n`);
    const { html, web_url } = await fetchPostContent(summary.id, cfg);
    const canonical = toCanonicalPost(summary, html, web_url, now);
    if (canonical) incomingPosts.push(canonical);
    else
      process.stderr.write(
        `    ! pulando ${summary.id}: sem timestamp parseável\n`,
      );
  }

  const merged = isBootstrap
    ? incomingPosts
    : mergeById(existing as Post[], incomingPosts);
  const sorted = sortDesc(merged);
  const truncated = sorted.slice(0, cfg.dedupEditionCount);

  // Popular links[] do _internal/01-approved.json local (#238) — sempre on.
  // #988: passa editionsRoot quando override existe (tests injetam tmp dir;
  // antes o read sempre usava ROOT real, contaminando fixture com edition data).
  // populateAllFromApproved espera o root do projeto (data/editions/ é resolvido
  // internamente), então passa um nível acima do editionsRoot.
  if (opts.editionsRoot) {
    const projectRootForApproved = resolve(opts.editionsRoot, "..", "..");
    populateAllFromApproved(truncated, projectRootForApproved);
  } else {
    populateAllFromApproved(truncated);
  }

  // Resolver tracking URLs do Beehiiv (#234) — opt-out via flag.
  if (opts.resolveTracking) {
    let totalResolved = 0;
    let totalSkipped = 0;
    let postsTouched = 0;
    for (const post of truncated) {
      if (post.links && post.links.length > 0) continue;
      const { resolved, skipped } = await populateLinksFromTracking(post);
      totalResolved += resolved;
      totalSkipped += skipped;
      postsTouched++;
    }
    if (postsTouched > 0) {
      process.stderr.write(
        `[refresh-dedup] Tracking resolution: ${postsTouched} post(s) sem links — ${totalResolved} URLs resolvidas, ${totalSkipped} HEAD failures\n`,
      );
    }
  } else {
    // #988: quando resolveTracking=false, ainda extrair links bare do html
    // (sem HEAD requests). Útil em produção quando HEAD falha consistentemente
    // ou em testes que não mockam network. Só toca posts sem links populados.
    for (const post of truncated) {
      if (post.links && post.links.length > 0) continue;
      const content = [post.html, post.markdown].filter(Boolean).join("\n");
      if (content) {
        post.links = extractLinks(content);
      }
    }
  }

  // #978: auto-stamp 05-published.json pra cada edição confirmada. Faz com
  // que Stage 0 da próxima edição não precise re-investigar status de Stage 4
  // anterior. Idempotente; só toca edições que existem localmente.
  if (!opts.dryRun && !opts.noAutoStamp) {
    const editionsRoot = opts.editionsRoot ?? resolve(ROOT, "data/editions");
    let stamped = 0;
    for (const post of truncated) {
      if (autoStampPublishedJson(editionsRoot, post)) stamped++;
    }
    if (stamped > 0) {
      process.stderr.write(
        `[refresh-dedup] Auto-stamped 05-published.json pra ${stamped} edição(ões) (#978)\n`,
      );
    }
  }

  // Persistir raw JSON + regen MD. **Sempre** ambos — mesmo com 0 novos posts,
  // pra cobrir o caso de `git pull` ter resetado o tracked MD enquanto o raw
  // (gitignored) está atualizado (#162, #895).
  if (!opts.dryRun) {
    const rawTmp = rawPath + ".tmp";
    writeFileSync(rawTmp, JSON.stringify(truncated, null, 2), "utf8");
    renameSync(rawTmp, rawPath);

    const mdTmp = mdPath + ".tmp";
    writeFileSync(mdTmp, renderMarkdown(truncated), "utf8");
    renameSync(mdTmp, mdPath);

    process.stderr.write(
      `[refresh-dedup] Wrote ${truncated.length} editions → ${mdPath}\n`,
    );
  } else {
    process.stderr.write(
      `[refresh-dedup] DRY-RUN: would write ${truncated.length} editions\n`,
    );
  }

  return {
    mode,
    new_posts: incomingPosts.length,
    total_in_base: truncated.length,
    most_recent_date:
      truncated.length > 0 ? truncated[0].published_at.slice(0, 10) : null,
    skipped: false,
    md_regenerated: true,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts: MainOpts = {
    dryRun: argv.includes("--dry-run"),
    resolveTracking: !argv.includes("--no-resolve-tracking"),
    noAutoStamp: argv.includes("--no-auto-stamp"),
  };
  const result = await refreshDedup(opts);
  console.log(JSON.stringify(result));
}

// Guard contra import em tests — só rodar main() quando invocado como CLI.
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
