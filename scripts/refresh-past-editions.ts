/**
 * Regera `context/past-editions.md` a partir de `data/past-editions-raw.json`.
 *
 * O raw JSON é a fonte canônica — o markdown é derivado. O orchestrator
 * (via subagente `refresh-dedup-runner`) alimenta este script com:
 *
 *   - modo `full`: substitui o raw JSON pelo input passado (usado no bootstrap).
 *   - modo `merge`: lê o raw JSON existente, une com o input (dedup por `id`),
 *     ordena por `published_at` desc, trunca ao `dedupEditionCount` de
 *     `platform.config.json`. (Usado nos refreshes incrementais do dia a dia.)
 *   - modo `regen-md-only` (#162): regenera apenas o MD a partir do raw
 *     existente, sem precisar de input. Usado quando o raw está atualizado
 *     mas o MD ficou stale (ex: `git pull` resetou o tracked file).
 *
 * Uso:
 *   npx tsx scripts/refresh-past-editions.ts <input.json>              # modo full
 *   npx tsx scripts/refresh-past-editions.ts <input.json> --merge      # modo incremental
 *   npx tsx scripts/refresh-past-editions.ts --regen-md-only           # só regen MD do raw
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "platform.config.json");
const RAW_PATH = resolve(ROOT, "data/past-editions-raw.json");
const MD_PATH = resolve(ROOT, "context/past-editions.md");

export type Post = {
  id: string;
  title: string;
  slug?: string;
  web_url?: string;
  published_at: string; // ISO
  html?: string;
  markdown?: string;
  links?: string[];
  themes?: string[];
};

function loadConfig(): { dedupEditionCount: number } {
  if (!existsSync(CONFIG_PATH)) return { dedupEditionCount: 14 };
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return { dedupEditionCount: cfg?.beehiiv?.dedupEditionCount ?? 14 };
}

function extractLinks(content: string): string[] {
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const m of content.matchAll(re)) {
    const url = m[0].replace(/[.,);]+$/, "");
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      if (host === "diaria.beehiiv.com") continue;
      if (host.endsWith("beehiiv.com")) continue;
      urls.add(url);
    } catch {
      // ignore
    }
  }
  return [...urls];
}

/**
 * Extrai URLs de tracking do Beehiiv (`https://diaria.beehiiv.com/c/...`)
 * que `extractLinks` filtra silenciosamente. Usado pelo `--resolve-tracking`
 * pra resolver originais via HEAD antes de chamar extractLinks.
 *
 * Refs #234.
 */
export function extractBeehiivTrackingLinks(content: string): string[] {
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const m of content.matchAll(re)) {
    const url = m[0].replace(/[.,);]+$/, "");
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      if (host === "diaria.beehiiv.com" || host.endsWith(".beehiiv.com")) {
        urls.add(url);
      }
    } catch {
      // ignore
    }
  }
  return [...urls];
}

/**
 * HEAD request com `redirect: 'manual'`, lê o header `Location` pra obter
 * a URL original que o Beehiiv wrappou como tracking. Tolerante a falhas:
 * retorna null em qualquer erro (timeout, 4xx, sem Location).
 *
 * Beehiiv geralmente responde 302 com Location → URL externa direta.
 * Algumas sources usam cadeia de redirects; um único HEAD com manual
 * pega só o primeiro hop, que é suficiente — o destino do primeiro hop
 * já é a URL externa de interesse pra dedup (não a página final).
 *
 * Refs #234.
 */
export async function resolveBeehiivTracking(
  trackingUrl: string,
  timeoutMs = 5000,
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(trackingUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: ctrl.signal,
    });
    const loc = res.headers.get("location");
    if (!loc) return null;
    try {
      const parsed = new URL(loc);
      // Defesa scheme (#249): rejeita javascript:, data:, ftp: etc. URLs
      // exotic parseiam como URL válida mas não são páginas de conteúdo —
      // dedup compara como string (sem RCE direta), mas downstream que
      // renderiza em <a href> pode virar XSS.
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      const host = parsed.hostname.replace(/^www\./, "");
      // Defesa: se o Location aponta de volta pro beehiiv (cadeia interna),
      // ignorar. Vale a pena resolver se vai pra fora do domínio.
      if (host === "diaria.beehiiv.com" || host.endsWith(".beehiiv.com")) {
        return null;
      }
      return loc;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Para um post, popula `links[]` resolvendo URLs de tracking do Beehiiv
 * em paralelo com concurrency limit. Idempotente: se o post já tem
 * `links[]` não-vazio, retorna sem alterar (caller decide quando re-resolver).
 *
 * Refs #234.
 */
export async function populateLinksFromTracking(
  post: Post,
  concurrency = 5,
): Promise<{ resolved: number; skipped: number }> {
  if (post.links && post.links.length > 0) {
    return { resolved: 0, skipped: 0 };
  }
  const content = [post.html, post.markdown].filter(Boolean).join("\n");
  if (!content) return { resolved: 0, skipped: 0 };

  const trackingUrls = extractBeehiivTrackingLinks(content);
  if (trackingUrls.length === 0) {
    // Conteúdo sem tracking — fall-through pro extractLinks tradicional.
    post.links = extractLinks(content);
    return { resolved: 0, skipped: 0 };
  }

  const resolved = new Set<string>(extractLinks(content));
  let skipped = 0;
  for (let i = 0; i < trackingUrls.length; i += concurrency) {
    const batch = trackingUrls.slice(i, i + concurrency);
    const out = await Promise.all(batch.map((u) => resolveBeehiivTracking(u)));
    for (const u of out) {
      if (u) resolved.add(u);
      else skipped++;
    }
  }
  post.links = [...resolved];
  return { resolved: post.links.length, skipped };
}

/**
 * Converte ISO timestamp pra AAMMDD (formato usado em `data/editions/{N}/`).
 * Usa UTC pra ser consistente com o resto do pipeline.
 */
export function aammddFromIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Lê `data/editions/{AAMMDD}/_internal/01-approved.json` e extrai todas
 * as URLs cobertas pela edição (highlights + runners_up + buckets).
 *
 * `01-approved.json` é a source-of-truth pós-gate da edição — local,
 * confiável, sem dependência de Beehiiv API. Resolve o gap do #234
 * (`get_post_content` retorna URLs como tracking redirects).
 *
 * Refs #238.
 */
export function extractUrlsFromApproved(
  yymmdd: string,
  root: string = ROOT,
): string[] {
  if (!yymmdd) return [];
  const path = resolve(root, `data/editions/${yymmdd}/_internal/01-approved.json`);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const r = parsed as {
    highlights?: Array<{ url?: string; article?: { url?: string } }>;
    runners_up?: Array<{ url?: string; article?: { url?: string } }>;
    lancamento?: Array<{ url?: string }>;
    pesquisa?: Array<{ url?: string }>;
    noticias?: Array<{ url?: string }>;
    tutorial?: Array<{ url?: string }>;
  };

  const urls = new Set<string>();
  for (const a of r.lancamento ?? []) if (a.url) urls.add(a.url);
  for (const a of r.pesquisa ?? []) if (a.url) urls.add(a.url);
  for (const a of r.noticias ?? []) if (a.url) urls.add(a.url);
  for (const a of r.tutorial ?? []) if (a.url) urls.add(a.url);
  for (const h of r.highlights ?? []) {
    const url = h.url ?? h.article?.url;
    if (url) urls.add(url);
  }
  for (const h of r.runners_up ?? []) {
    const url = h.url ?? h.article?.url;
    if (url) urls.add(url);
  }
  return [...urls];
}

/**
 * Para um post sem `links[]`, popula a partir do `_internal/01-approved.json`
 * local da edição correspondente. No-op se post já tem links ou se o
 * arquivo local não existe.
 *
 * Refs #238.
 */
export function populateLinksFromApproved(
  post: Post,
  root: string = ROOT,
): { populated: number } {
  if (post.links && post.links.length > 0) return { populated: 0 };
  const yymmdd = aammddFromIso(post.published_at);
  const urls = extractUrlsFromApproved(yymmdd, root);
  if (urls.length === 0) return { populated: 0 };
  post.links = urls;
  return { populated: urls.length };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}

function mergeById(existing: Post[], incoming: Post[]): Post[] {
  const byId = new Map<string, Post>();
  for (const p of existing) byId.set(p.id, p);
  for (const p of incoming) byId.set(p.id, p); // incoming wins on conflict (fresher data)
  return [...byId.values()];
}

export function renderMarkdown(posts: Post[]): string {
  const lines: string[] = [
    "# Últimas edições publicadas — para dedup",
    "",
    `**atualizado em:** ${new Date().toISOString().slice(0, 10)}`,
    `**edições carregadas:** ${posts.length}`,
    "",
    "Usado por `scripts/dedup.ts` para evitar repetir links ou temas das últimas edições.",
    "",
    "---",
    "",
  ];

  for (const p of posts) {
    const date = p.published_at.slice(0, 10);
    const links =
      p.links?.length
        ? p.links
        : extractLinks([p.html, p.markdown].filter(Boolean).join("\n"));
    lines.push(
      `## ${date} — "${p.title}"`,
      p.web_url ? `URL: ${p.web_url}` : "",
      "",
      "Links usados:",
      ...links.map((u) => `- ${u}`),
      ""
    );
    if (p.themes?.length) {
      lines.push("Temas cobertos:", ...p.themes.map((t) => `- ${t}`), "");
    }
    lines.push("---", "");
  }
  return lines.join("\n");
}

async function main() {
  // Modo regen-md-only (#162): regenera o MD a partir do raw existente.
  // Sem input file. Útil quando git resetou o tracked MD mas o raw
  // (gitignored) está atualizado.
  if (process.argv.includes("--regen-md-only")) {
    if (!existsSync(RAW_PATH)) {
      console.error(
        "past-editions-raw.json não existe — rode bootstrap (refresh-dedup-runner em modo full) antes",
      );
      process.exit(1);
    }
    const posts = readJson<Post[]>(RAW_PATH);
    writeFileSync(MD_PATH, renderMarkdown(posts), "utf8");
    console.log(
      `Regen MD-only: regenerated past-editions.md from raw (${posts.length} posts)`,
    );
    return;
  }

  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error(
      "Usage: refresh-past-editions.ts <input.json> [--merge] [--resolve-tracking] | --regen-md-only",
    );
    process.exit(1);
  }

  const isMerge = process.argv.includes("--merge");
  const resolveTracking = process.argv.includes("--resolve-tracking");
  const { dedupEditionCount } = loadConfig();

  const incoming = readJson<Post[]>(inputPath);

  let merged: Post[];
  if (isMerge && existsSync(RAW_PATH)) {
    const existing = readJson<Post[]>(RAW_PATH);
    merged = mergeById(existing, incoming);
    console.log(
      `Merge mode: ${existing.length} existing + ${incoming.length} incoming → ${merged.length} unique`
    );
  } else {
    merged = incoming;
    console.log(
      `Full mode: replacing raw store with ${incoming.length} posts` +
        (isMerge ? " (merge requested but no existing raw file — treating as full)" : "")
    );
  }

  merged.sort(
    (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );
  const truncated = merged.slice(0, dedupEditionCount);

  // Popular links[] do _internal/01-approved.json local quando disponível
  // (#238). Source-of-truth completo pra cada edição produzida nesta máquina.
  // Sempre-on, sem flag — só lê arquivos locais, sem network. No-op pra posts
  // que já têm links (incluindo `--merge` com base existente populada).
  {
    let totalPopulated = 0;
    let postsTouched = 0;
    for (const post of truncated) {
      if (post.links && post.links.length > 0) continue;
      const { populated } = populateLinksFromApproved(post);
      if (populated > 0) {
        totalPopulated += populated;
        postsTouched++;
      }
    }
    if (postsTouched > 0) {
      console.log(
        `Populated links[] from approved.json: ${postsTouched} post(s), ${totalPopulated} URLs`,
      );
    }
  }

  // Resolução de tracking URLs do Beehiiv (#234). Opt-in via --resolve-tracking.
  // Cada post sem `links[]` populado tenta resolver via HEAD requests.
  if (resolveTracking) {
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
      console.log(
        `Tracking resolution: ${postsTouched} post(s) sem links — ${totalResolved} URLs resolvidas, ${totalSkipped} HEAD failures`,
      );
    }
  }

  writeFileSync(RAW_PATH, JSON.stringify(truncated, null, 2), "utf8");
  writeFileSync(MD_PATH, renderMarkdown(truncated), "utf8");

  console.log(
    `Wrote ${truncated.length} editions (dedupEditionCount=${dedupEditionCount}) → ${MD_PATH}`
  );
}

// Guard contra import em tests — só rodar main() quando invocado como CLI.
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
