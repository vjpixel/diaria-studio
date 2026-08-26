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
 * `data/past-editions.md` (derivado, lido por dedup.ts) end-to-end:
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
import { editionsRoot as getEditionsRoot } from "./lib/edition-paths.ts";
import {
  type Post,
  populateLinksFromTracking,
  populateAllFromApproved,
  populateAllThemes,
  renderMarkdown,
  extractLinks,
} from "./refresh-past-editions.ts";
import { writeEditionReport } from "./send-edition-report.ts"; // #1950
import { isMainModule } from "./lib/cli-args.ts";
import {
  resolveNewsletterReadConfig,
  listRecentNewsletterPosts,
  fetchNewsletterPostContent,
  type NewsletterReadConfig,
  type NormalizedNewsletterPost,
} from "./lib/shared/newsletter-read-source.ts"; // #6184

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "platform.config.json");
const RAW_PATH = resolve(ROOT, "data/past-editions-raw.json");
const MD_PATH = resolve(ROOT, "data/past-editions.md");

export interface RefreshConfig {
  /** Backend + credenciais resolvidas (Beehiiv ou Kit, atrás de
   *  `platform.config.json` → `publishing.newsletter.backend` — #6184). */
  readConfig: NewsletterReadConfig;
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

/**
 * #6184: resolve backend (Beehiiv ou Kit, `platform.config.json` →
 * `publishing.newsletter.backend`) + credenciais via
 * `resolveNewsletterReadConfig` (delega pra `resolveBeehiivConfig`/
 * `resolveKitConfig` — não reimplementa validação de credencial). Mantém o
 * mesmo contrato de saída (`process.exit(2)` em config inválida) que a
 * versão Beehiiv-only tinha.
 */
function loadConfig(): RefreshConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`platform.config.json não encontrado em ${CONFIG_PATH}`);
    process.exit(2);
  }
  let cfg: { beehiiv?: { dedupEditionCount?: number } };
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`platform.config.json inválido: ${(e as Error).message}`);
    process.exit(2);
  }
  const dedupEditionCount = cfg.beehiiv?.dedupEditionCount ?? 14;
  const result = resolveNewsletterReadConfig();
  if (!result.ok) {
    console.error(result.reason);
    process.exit(2);
  }
  return { readConfig: result.config, dedupEditionCount };
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

/**
 * #1950: garante que `_internal/edition-report.html` exista pra uma edição
 * confirmada como publicada. O relatório é o último passo do Stage 4 e era
 * pulado quando a edição saía por publish manual / Stage 4 interrompido
 * (caso 260608 — editor não achou o relatório). Aqui, no mesmo ponto em que
 * já detectamos a publicação (auto-stamp #978), geramos o relatório se faltar.
 * Idempotente (só gera se ausente) e best-effort (falha vira warning, nunca
 * quebra o refresh-dedup). Retorna true quando gerou.
 *
 * **#4478: `notify` propaga pro `writeEditionReport` (default `true`,
 * preserva o comportamento existente — a chamada de produção em `main()`,
 * abaixo, não passa nada).** Testes que exercitam este caminho podem passar
 * `notify: false` como defesa em profundidade (ver
 * `defaultHasCredentials` em `scripts/studio-ui/studio-reports.ts` pro fix
 * sistêmico equivalente).
 */
export function ensureEditionReport(editionsRoot: string, post: Post, notify = true): boolean {
  const edition = publishedAtToEditionDir(post.published_at);
  if (!edition) return false;
  const dirPath = resolve(editionsRoot, edition);
  if (!existsSync(dirPath)) return false; // sem edition local
  const reportPath = resolve(dirPath, "_internal", "edition-report.html");
  if (existsSync(reportPath)) return false; // já existe — não re-gera
  try {
    const { registered } = writeEditionReport(edition, dirPath, reportPath, notify);
    if (!registered) {
      process.stderr.write(
        `[refresh-dedup] warn: edition-report de ${edition} escrito, mas registro no Studio falhou (#3714) — ver warn de send-edition-report acima\n`,
      );
    }
    return true;
  } catch (e) {
    process.stderr.write(
      `[refresh-dedup] warn: falha ao gerar edition-report de ${edition} (#1950): ${(e as Error).message}\n`,
    );
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
 * Converte NormalizedNewsletterPost (#6184 — Beehiiv ou Kit) + html buscado
 * em `Post` canônico do raw JSON.
 */
function toCanonicalPost(
  summary: NormalizedNewsletterPost,
  html: string | null,
  webUrl: string | null,
): Post | null {
  // Defensivo: `listRecentNewsletterPosts` já filtra summaries sem timestamp
  // parseável antes de devolvê-los — este `null` nunca deveria disparar na
  // prática, mas `publishedAtIso` é tipado `string | null` (#6184), então o
  // check fica explícito em vez de um `!` assumindo presença.
  if (!summary.publishedAtIso) return null;
  return {
    id: summary.id,
    title: summary.title,
    // `webUrl` (do fetch de conteúdo, mais confiável) vence sobre o da
    // listagem quando presente; `?? undefined` converte o `null` explícito
    // do backend pro shape opcional que `Post.web_url` espera (#6184).
    web_url: (webUrl ?? summary.webUrl) ?? undefined,
    published_at: summary.publishedAtIso,
    html: html ?? undefined,
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

  const existing = readJsonOrNull<Post[]>(rawPath);
  const isBootstrap = !existing || existing.length === 0;

  let mode: "bootstrap" | "incremental";
  let incomingSummaries: NormalizedNewsletterPost[];

  if (isBootstrap) {
    mode = "bootstrap";
    process.stderr.write(
      `[refresh-dedup] Bootstrap: buscando ${cfg.dedupEditionCount} edições mais recentes\n`,
    );
    incomingSummaries = await listRecentNewsletterPosts(cfg.readConfig, { limit: cfg.dedupEditionCount });
  } else {
    mode = "incremental";
    const maxKnownMs = Math.max(
      ...(existing as Post[]).map((p) => new Date(p.published_at).getTime()),
    );
    const maxKnownIso = new Date(maxKnownMs).toISOString();
    process.stderr.write(
      `[refresh-dedup] Incremental: buscando edições > ${maxKnownIso}\n`,
    );
    incomingSummaries = await listRecentNewsletterPosts(cfg.readConfig, {
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
    const { html, webUrl } = await fetchNewsletterPostContent(cfg.readConfig, summary.id);
    const canonical = toCanonicalPost(summary, html, webUrl);
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

  // #1475: popular themes[] (entidades-chave dos highlights) para dedup temático.
  if (opts.editionsRoot) {
    const projectRootForApproved = resolve(opts.editionsRoot, "..", "..");
    populateAllThemes(truncated, projectRootForApproved);
  } else {
    populateAllThemes(truncated);
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
    const editionsRoot = opts.editionsRoot ?? resolve(ROOT, getEditionsRoot());
    let stamped = 0;
    let reports = 0;
    for (const post of truncated) {
      if (autoStampPublishedJson(editionsRoot, post)) stamped++;
      if (ensureEditionReport(editionsRoot, post)) reports++; // #1950
    }
    if (stamped > 0) {
      process.stderr.write(
        `[refresh-dedup] Auto-stamped 05-published.json pra ${stamped} edição(ões) (#978)\n`,
      );
    }
    if (reports > 0) {
      process.stderr.write(
        `[refresh-dedup] Gerou edition-report.html pra ${reports} edição(ões) faltante(s) (#1950)\n`,
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
if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
