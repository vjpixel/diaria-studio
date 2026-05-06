/**
 * inject-inbox-urls.ts (#593, #594)
 *
 * Injeta TODOS os URLs de submissões do editor (incluindo forwards de newsletter
 * com dezenas de tracking URLs) na pipeline de pesquisa como artigos sintéticos.
 * Substitui o passo 1h do orchestrator que dependia do top-level Claude
 * lembrar de fazer manualmente.
 *
 * Política (#593): zero filtragem por origem antes da injeção. Filtros aplicáveis
 * depois (verify, dedup, categorize, score) podem reduzir a lista — mas nunca
 * antes da injeção. Pipeline tem múltiplos estágios de filtragem; perder um URL
 * antes de chegar lá é silenciar o sinal editorial.
 *
 * Bug que motivou (#594): edição 260505 teve 26 entries do editor com ~35 URLs
 * únicas, ZERO entraram em tmp-urls-all.json (passo 1h foi skipado pelo
 * orchestrator). 0 dos 26 envios viraram destaques.
 *
 * Uso:
 *   npx tsx scripts/inject-inbox-urls.ts \
 *     --inbox-md data/inbox.md \
 *     [--pool data/editions/260505/_internal/tmp-articles-raw.json] \
 *     --out data/editions/260505/_internal/tmp-articles-raw.json \
 *     [--editor diariaeditor@gmail.com]
 *
 * Output: stdout JSON com `{ injected, total_pool_size, urls[] }`
 *
 * `--validate-pool`: sanity check do merge interno deste script. Confirma que
 * o pool resultante contém todas as URLs extraídas. Como o merge é feito por
 * este próprio script, falha apenas em bug interno (defensive guard).
 *
 * **Não pega o cenário original do #594** (orchestrator skipa a chamada do
 * script inteira) — esse cenário é externo. Validador anti-skip externo
 * (follow-up #625): lê tmp-urls-all.json após Stage 1 e compara contra inbox.md.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripUrlTrailingPunct, URL_REGEX_RAW, canonicalize } from "./lib/url-utils.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";

// ---------------------------------------------------------------------------
// Tracker decoders (#719)
// ---------------------------------------------------------------------------

const TRACKER_DECODERS: Array<{
  pattern: RegExp;
  decode: (url: string) => string | null;
}> = [
  {
    // 7min.ai tracker: base64 after /c/ contains segments separated by |
    // Third segment (index 2) is the destination URL
    pattern: /^https:\/\/track\.newsletter\.7min\.ai\/c\//,
    decode: (url: string) => {
      const m = url.match(/\/c\/([A-Za-z0-9+/=]+)/);
      if (!m) return null;
      try {
        const decoded = Buffer.from(m[1], "base64").toString("utf8");
        const parts = decoded.split("|");
        const dest = parts.find((p) => p.startsWith("http"));
        return dest ? new URL(dest).toString() : null;
      } catch {
        return null;
      }
    },
  },
];

/**
 * If the URL is a known tracker, attempt to decode it to the real destination.
 * Returns `{ url, decoded: true }` on success, `{ url: original, decoded: false }` on failure.
 */
export function decodeTrackerUrl(url: string): { url: string; decoded: boolean } {
  for (const decoder of TRACKER_DECODERS) {
    if (decoder.pattern.test(url)) {
      const result = decoder.decode(url);
      if (result) {
        return { url: result, decoded: true };
      }
      // Decoder matched but failed — keep original (graceful)
      return { url, decoded: false };
    }
  }
  return { url, decoded: false };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface SyntheticInboxArticle {
  url: string;
  source: "inbox";
  title: string;
  flag: "editor_submitted";
  submitted_at?: string;
  submitted_subject?: string;
  submitted_via?: string;
  tracker_decoded?: boolean;
}

export interface InboxBlock {
  iso: string;
  from: string;
  subject: string;
  urls: string[];
}

// ---------------------------------------------------------------------------
// URL extraction (pure) — usa helpers compartilhados de scripts/lib/url-utils.ts (#626)
// ---------------------------------------------------------------------------

/** Extrai blocos do markdown do inbox archive (ou inbox.md). */
export function parseInboxMd(text: string): InboxBlock[] {
  // Cada bloco começa com `## {ISO}\n` (timestamp do email)
  const blocks: InboxBlock[] = [];
  const segments = text.split(/^## /m).slice(1); // primeiro segmento é o header

  for (const seg of segments) {
    const lines = seg.split("\n");
    const iso = lines[0]?.trim() ?? "";
    if (!iso) continue;

    let from = "";
    let subject = "";
    const urls: string[] = [];

    for (const line of lines) {
      const fromMatch = line.match(/^-\s*\*\*from:\*\*\s*(.+)$/);
      if (fromMatch) {
        from = fromMatch[1].trim();
        continue;
      }
      const subjectMatch = line.match(/^-\s*\*\*subject:\*\*\s*(.+)$/);
      if (subjectMatch) {
        subject = subjectMatch[1].trim();
        continue;
      }
    }

    // Extrair URLs de qualquer linha do bloco (incluindo bullets e raw preview)
    // #626: usa stripUrlTrailingPunct que preserva `)` em URLs Wikipedia balanceadas
    const urlMatches = seg.match(URL_REGEX_RAW) ?? [];
    for (const u of urlMatches) {
      const cleaned = stripUrlTrailingPunct(u);
      if (cleaned.length > 10) urls.push(cleaned);
    }

    if (iso && (from || urls.length > 0)) {
      blocks.push({ iso, from, subject, urls });
    }
  }

  return blocks;
}

/** Filtra blocos enviados pelo editor (com base no e-mail). */
export function filterEditorBlocks(blocks: InboxBlock[], editorEmail: string): InboxBlock[] {
  const lower = editorEmail.toLowerCase();
  return blocks.filter((b) => b.from.toLowerCase().includes(lower));
}

/** Tracking-only URLs that aren't actual content (Beehiiv tracking, redirects, image CDNs). */
const TRACKING_URL_PATTERNS: RegExp[] = [
  // Beehiiv infrastructure — não conteúdo (#659)
  /^https?:\/\/link\.mail\.beehiiv\.com\//,
  /^https?:\/\/magic\.beehiiv\.com\//,
  /^https?:\/\/email\.beehiivstatus\.com\//,
  /^https?:\/\/hp\.beehiiv\.com\//,
  /^https?:\/\/media\.beehiiv\.com\/cdn-cgi\//,
  // TLDR newsletter links (com e sem "tracking." prefix)
  /^https?:\/\/(tracking\.)?tldrnewsletter\.com\//,
  /^https?:\/\/link\.tldrnewsletter\.com\//,
  // Email link trackers: subdomínio numérico (elink725.*, elink42.*) — #686.
  // Requer dígitos após "elink" para não filtrar domínios legítimos (elinkage.com, elink.io).
  /^https?:\/\/elink\d+\./,
  // Personal referral / signature links
  /^https?:\/\/ref\.wisprflow\.ai\//,
  /^https?:\/\/superhuman\.com\/refer\//,
];

export function isTrackingUrl(url: string): boolean {
  return TRACKING_URL_PATTERNS.some((p) => p.test(url));
}

/**
 * Extrai TODOS os URLs distintos (após filtrar tracking-only) dos blocos do
 * editor. Forwards de newsletter contam como submissões intencionais (#593) —
 * cada URL no body vira candidato.
 */
export function extractEditorUrls(blocks: InboxBlock[]): SyntheticInboxArticle[] {
  const seen = new Set<string>();
  const articles: SyntheticInboxArticle[] = [];

  for (const block of blocks) {
    const isForward = /^\s*(fwd|fw|res|enc):/i.test(block.subject);
    for (const rawUrl of block.urls) {
      // #719: attempt tracker decode BEFORE filtering — decoded URL is the real content.
      const { url, decoded: trackerDecoded } = decodeTrackerUrl(rawUrl);
      if (trackerDecoded) {
        console.error(`[inject-inbox-urls] tracker decoded: ${rawUrl} → ${url}`);
      } else if (isTrackingUrl(rawUrl)) {
        // Not decodable and matches tracking pattern — skip.
        continue;
      }

      // #660: usar canonicalize() de url-utils em vez de split("?")[0] —
      // remove só tracking params (utm_*, ref), preserva query params legítimos.
      const key = canonicalize(url).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const article: SyntheticInboxArticle = {
        url,
        source: "inbox",
        title: "(inbox)",
        flag: "editor_submitted",
        submitted_at: block.iso,
        submitted_subject: block.subject,
        submitted_via: isForward ? "forward" : "direct",
      };
      if (trackerDecoded) {
        article.tracker_decoded = true;
      }
      articles.push(article);
    }
  }

  return articles;
}

/**
 * Valida que todos os URLs extraídos estão no pool. Retorna lista de URLs
 * faltantes (vazia se OK).
 */
export function validateInjection(
  injected: SyntheticInboxArticle[],
  pool: Array<{ url: string }>,
): string[] {
  const poolUrls = new Set(pool.map((a) => a.url));
  return injected.filter((a) => !poolUrls.has(a.url)).map((a) => a.url);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur === "--validate-pool") {
      args["validate-pool"] = true;
    } else if (cur.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[cur.slice(2)] = argv[i + 1];
      i++;
    } else if (cur.startsWith("--")) {
      args[cur.slice(2)] = true;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inboxMdPath = args["inbox-md"] as string;
  const poolPath = args["pool"] as string | undefined;
  const outPath = args["out"] as string;
  const editorEmail = (args["editor"] as string) || process.env.EDITOR_EMAIL || resolveEditorEmail(resolve(ROOT, "platform.config.json"));

  if (!inboxMdPath || !outPath) {
    console.error(
      "Uso: inject-inbox-urls.ts --inbox-md <path> [--pool <path>] --out <path> [--editor <email>] [--validate-pool]"
    );
    process.exit(1);
  }
  const inboxMdAbs = resolve(ROOT, inboxMdPath);

  if (!existsSync(inboxMdAbs)) {
    console.error(`ERRO: inbox markdown não encontrado: ${inboxMdAbs}`);
    process.exit(1);
  }

  const inboxText = readFileSync(inboxMdAbs, "utf8");
  const allBlocks = parseInboxMd(inboxText);
  const editorBlocks = filterEditorBlocks(allBlocks, editorEmail);
  const injected = extractEditorUrls(editorBlocks);

  // Merge com pool existente se passado
  let pool: Array<{ url: string; [k: string]: unknown }> = [];
  if (poolPath && existsSync(resolve(ROOT, poolPath))) {
    pool = JSON.parse(readFileSync(resolve(ROOT, poolPath), "utf8"));
  }

  // Dedup contra pool: artigos já em pool com mesma URL não duplicam
  const poolUrls = new Set(pool.map((a) => a.url));
  const newInjected = injected.filter((a) => !poolUrls.has(a.url));
  const merged = [...pool, ...newInjected];

  writeFileSync(resolve(ROOT, outPath), JSON.stringify(merged, null, 2) + "\n", "utf8");

  // Validate-pool mode: sanity check do merge interno (não anti-skip externo).
  // Como o merge é feito acima, falha aqui só em bug do script.
  // Anti-skip externo é tracked em #625.
  if (args["validate-pool"]) {
    const missing = validateInjection(injected, merged);
    if (missing.length > 0) {
      console.error(
        `ERRO: ${missing.length} URLs do editor faltando no pool após merge interno (bug do script, não skip externo — esse é tracked em #625):`
      );
      for (const u of missing.slice(0, 10)) console.error(`  - ${u}`);
      process.exit(1);
    }
  }

  console.log(
    JSON.stringify({
      injected: newInjected.length,
      already_in_pool: injected.length - newInjected.length,
      total_editor_urls: injected.length,
      total_pool_size: merged.length,
      editor_blocks: editorBlocks.length,
      total_inbox_blocks: allBlocks.length,
    })
  );
}

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
