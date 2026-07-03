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
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripUrlTrailingPunct, URL_REGEX_RAW, canonicalize } from "./lib/url-utils.ts";
import { canonicalizeGmail } from "./lib/canonicalize-gmail.ts";
import { writeMarker } from "./lib/pipeline-state.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { readCaptureFailedSentinel } from "./lib/newsletter-capture-failure.ts";

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
  source: "inbox" | string; // "inbox" pra editor-forward; "inbox_newsletter:{sender}" pra extraído de newsletter (#1095)
  title: string;
  flag: "editor_submitted" | "newsletter_extracted"; // #1095
  submitted_at?: string;
  submitted_subject?: string;
  submitted_via?: string;
  tracker_decoded?: boolean; // #719: set when URL was decoded from a tracker
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

/**
 * Filtra blocos enviados pelo editor (com base no e-mail).
 * #1969: compara via `canonicalizeGmail` — `diaria.editor@` e `diariaeditor@`
 * (dot/+tag/case) são a mesma caixa. Antes era `toLowerCase().includes()`,
 * que tratava a forma com ponto como remetente diferente.
 */
export function filterEditorBlocks(blocks: InboxBlock[], editorEmail: string): InboxBlock[] {
  const canon = canonicalizeGmail(editorEmail);
  return blocks.filter((b) => canonicalizeGmail(b.from) === canon);
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
 * #1095: filtra blocos de newsletters não-Pixel no inbox (Cyberman, Superhuman,
 * AlphaSignal, etc.) — emails que chegaram direto no `diariaeditor@gmail.com`
 * (forwards do Pixel ou subscriptions). Editor não é o `from`, mas o body tem
 * links primários (TechCrunch, Guardian, BBC, etc) que valem a pena extrair
 * conforme regra `feedback_aggregators.md`.
 */
export function filterNewsletterBlocks(blocks: InboxBlock[], editorEmail: string): InboxBlock[] {
  const canon = canonicalizeGmail(editorEmail);
  return blocks.filter((b) => canonicalizeGmail(b.from) !== canon);
}

/**
 * #1095: extrai URLs primárias de newsletters não-Pixel. Filtra:
 *   - Tracking/CDN (já feito pelo isTrackingUrl)
 *   - URLs do próprio domínio do sender (auto-promo: cyberman.ai/subscribe, etc)
 *   - URLs comuns de afiliados/ads em newsletters (hubspot offers, etc — heurística)
 *
 * O resto é candidato editorial — TechCrunch, Guardian, BBC, etc. Cada um
 * vira artigo sintético com `flag: "newsletter_extracted"`.
 *
 * Como diferenciar URL primária de auto-promo do sender:
 *   - sender = "Cyberman <cyberman@mail.beehiiv.com>" → domain do sender = "cyberman" / "beehiiv.com"
 *   - urls do próprio cyberman.ai → skip (auto-promo)
 *   - urls do própria infra beehiiv.com → skip (tracking, já filtrado)
 *   - URLs externos (techcrunch.com, guardian.com, etc) → keep
 */
const AFFILIATE_PATH_PATTERNS: RegExp[] = [
  /^https?:\/\/offers\.hubspot\.com\//i,
  /^https?:\/\/resources\.belaysolutions\.com\//i,
  /utm_campaign=[^&]*newsletter/i, // ads de newsletter parceira
  /\?_bhiiv=/i, // beehiiv affiliate referral
  /^https?:\/\/go\.sauna\.ai\//i,
  /^https?:\/\/go\.granola\.ai\//i,
  /^https?:\/\/betterpic\.link\//i,
  /^https?:\/\/clipstory\.app\//i,
  /^https?:\/\/try\.gamma\.app\//i,
];

/** Extrai dominio raiz do sender header ("Cyberman <foo@bar.com>" → "bar.com"). */
export function senderDomain(from: string): string {
  const m = from.match(/<([^@>]+@([^>]+))>/) ?? from.match(/^[^<]*\b\S+@(\S+)/);
  if (!m) return "";
  const host = (m[2] ?? m[1] ?? "").trim();
  // Remove subdomínios comuns (mail., link., etc) — fica com root domain
  return host.replace(/^(mail|link|news|hello|notify|hi)\./i, "");
}

/** True se URL pertence ao domínio do sender (auto-promo da própria newsletter).
 * Aceita também `senderBrand` opcional (ex: "cyberman" extraído de display name)
 * pra detectar casos onde o brand domain difere do mail provider
 * (ex: Cyberman <cyberman@mail.beehiiv.com> mas URLs em cyberman.ai). */
export function isSenderOwnUrl(url: string, senderDomainStr: string, senderBrand?: string): boolean {
  if (!senderDomainStr && !senderBrand) return false;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (senderDomainStr) {
    const dom = senderDomainStr.toLowerCase();
    if (host === dom || host.endsWith("." + dom)) return true;
  }
  if (senderBrand && senderBrand.length >= 4) {
    const brand = senderBrand.toLowerCase();
    // host contém o brand como substring (cyberman.ai contém "cyberman")
    if (host.includes(brand)) return true;
  }
  return false;
}

export function isAffiliateUrl(url: string): boolean {
  return AFFILIATE_PATH_PATTERNS.some((p) => p.test(url));
}

export function extractNewsletterUrls(blocks: InboxBlock[]): SyntheticInboxArticle[] {
  const seen = new Set<string>();
  const articles: SyntheticInboxArticle[] = [];

  for (const block of blocks) {
    const senderDom = senderDomain(block.from);
    const senderLabel = (block.from.match(/^([^<]+?)\s*</)?.[1] ?? senderDom).trim() || "newsletter";
    // Brand name pra dedup auto-promo quando brand domain ≠ mail provider
    // (ex: "Cyberman" <cyberman@mail.beehiiv.com> mas URL em cyberman.ai).
    const senderBrand = senderLabel.replace(/[^a-z0-9]/gi, "").toLowerCase();

    for (const rawUrl of block.urls) {
      const { url, decoded: trackerDecoded } = decodeTrackerUrl(rawUrl);
      if (!trackerDecoded && isTrackingUrl(rawUrl)) continue;
      if (isAffiliateUrl(url)) continue;
      if (isSenderOwnUrl(url, senderDom, senderBrand)) continue; // auto-promo

      const key = canonicalize(url).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      articles.push({
        url,
        source: `inbox_newsletter:${senderLabel}`,
        title: `(newsletter:${senderLabel})`,
        flag: "newsletter_extracted",
        submitted_at: block.iso,
        submitted_subject: block.subject,
        submitted_via: `newsletter:${senderLabel}`,
        tracker_decoded: trackerDecoded || undefined,
      });
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

async function main(): Promise<void> {
  const { values, flags } = parseCliArgs(process.argv.slice(2));
  const inboxMdPath = values["inbox-md"];
  const poolPath = values["pool"];
  const outPath = values["out"];
  const editorEmail = values["editor"] || process.env.EDITOR_EMAIL || resolveEditorEmail(resolve(ROOT, "platform.config.json"));

  const capturedArticlesPath = values["captured-articles"];

  if (!inboxMdPath || !outPath) {
    console.error(
      "Uso: inject-inbox-urls.ts --inbox-md <path> [--pool <path>] --out <path> [--editor <email>] [--captured-articles <path>] [--validate-pool]"
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
  const injectedFromEditor = extractEditorUrls(editorBlocks);

  // #1520: Load pre-captured newsletter articles if --captured-articles provided.
  // When present, skip newsletter extraction from inbox.md entirely — the
  // captured-articles file IS the newsletter source (already filtered by
  // capture-newsletter-urls.ts).
  let injectedFromNewsletters: SyntheticInboxArticle[] = [];
  let newsletterBlocks: InboxBlock[] = [];
  let newsletterSource: "captured-articles" | "inbox-md" | "none" = "none";
  let capturedNewsletterCount = 0;

  if (capturedArticlesPath) {
    const absCapPath = resolve(ROOT, capturedArticlesPath);
    if (existsSync(absCapPath)) {
      injectedFromNewsletters = JSON.parse(readFileSync(absCapPath, "utf8"));
      newsletterSource = "captured-articles";
      // #1541: count distinct newsletter threads (not URLs) for the marker.
      // captured-newsletters.json has 1 entry per thread — that's the editorial
      // submission count. Derive path from captured-articles sibling.
      const capNewslettersPath = resolve(dirname(absCapPath), "captured-newsletters.json");
      if (existsSync(capNewslettersPath)) {
        try {
          const capNewsletters = JSON.parse(readFileSync(capNewslettersPath, "utf8"));
          capturedNewsletterCount = Array.isArray(capNewsletters) ? capNewsletters.length : 0;
        } catch { /* non-critical */ }
      }
      console.error(`[inject-inbox-urls] loaded ${injectedFromNewsletters.length} articles from ${capturedNewsletterCount} captured newsletters`);
    } else {
      console.error(`[inject-inbox-urls] captured-articles not found: ${absCapPath}, falling back to inbox.md`);
      newsletterBlocks = filterNewsletterBlocks(allBlocks, editorEmail);
      injectedFromNewsletters = extractNewsletterUrls(newsletterBlocks);
      newsletterSource = "inbox-md";
    }
  } else if (!flags.has("no-newsletters")) {
    newsletterBlocks = filterNewsletterBlocks(allBlocks, editorEmail);
    injectedFromNewsletters = extractNewsletterUrls(newsletterBlocks);
    newsletterSource = "inbox-md";
  }

  const injected = [...injectedFromEditor, ...injectedFromNewsletters];

  // Merge com pool existente se passado
  let pool: Array<{ url: string; [k: string]: unknown }> = [];
  if (poolPath && existsSync(resolve(ROOT, poolPath))) {
    pool = JSON.parse(readFileSync(resolve(ROOT, poolPath), "utf8"));
  }

  // Dedup contra pool: artigos já em pool com mesma URL não duplicam
  const poolUrls = new Set(pool.map((a) => a.url));
  const newInjected = injected.filter((a) => !poolUrls.has(a.url));
  const merged = [...pool, ...newInjected];

  // Atomic write (#628): write to .tmp + rename, evita leitor pegar JSON parcial
  // se o write crashar mid-flight. Padrão usado em drive-sync.ts, publish-facebook.ts.
  const targetPath = resolve(ROOT, outPath);
  const tmpPath = targetPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  renameSync(tmpPath, targetPath);

  // #1330: marker pra step 1h. Próximo step (1j dedup) checa via
  // `pipeline-sentinel.ts assert-marker --name inject-inbox-urls`. Garante
  // que o passo não foi pulado silenciosamente (caso 260518/260505/#594).
  // Edition dir é o diretório que contém o pool (outPath é normalmente
  // `data/editions/{AAMMDD}/_internal/tmp-articles-raw.json`).
  try {
    const internalDir = dirname(targetPath);
    const editionDir = dirname(internalDir); // .../{AAMMDD}/
    // Só grava marker se a estrutura bate (não em uso ad-hoc fora de edição).
    if (basename(internalDir) === "_internal" && /^\d{6}$/.test(basename(editionDir))) {
      // #2878: se `fetch-newsletter-threads.ts` (0b-bis) falhou por auth/rede,
      // ele deixou o sentinel `.capture-newsletter-failed.json` neste mesmo
      // `_internal`. Propagar pro marker — sem isso, `captured_newsletter_count: 0`
      // fica indistinguível de "editor genuinamente não enviou newsletter
      // nenhuma" pro resto da pipeline (sync-coverage-line, Stage 4 gate).
      // INVARIANTE DE ACOPLAMENTO (#2878 self-review MEDIUM): o sinal só chega
      // aqui porque o `--out` de 0b-bis (captured-newsletters.json) e o `--out`
      // deste passo (tmp-articles-raw.json) resolvem para o MESMO `_internal/`
      // da edição. Ambos são amarrados a `data/editions/{AAMMDD}/_internal/` no
      // orchestrator (Stage 0/1). Se algum dos dois mudar de subdir, o sentinel
      // some silenciosamente e o bug volta — manter os dois `--out` colocados.
      const captureFailure = readCaptureFailedSentinel(internalDir);
      writeMarker(editionDir, "inject-inbox-urls", {
        injected: newInjected.length,
        total_editor_urls: injectedFromEditor.length,
        total_newsletter_urls: injectedFromNewsletters.length,
        total_pool_size: merged.length,
        // #1368: contagem de emails distintos do editor (1 por thread/forward).
        // sync-coverage-line lê isso pra X em "enviei X submissões". Antes lia
        // de data/inbox.md, mas Stage 1 §1y arquivava inbox.md → contagem zerava.
        editor_blocks: editorBlocks.length,
        newsletter_blocks: newsletterBlocks.length,
        newsletter_source: newsletterSource, // #1520
        // #1541: distinct newsletter thread count (1 per thread, not per URL).
        // When newsletter_source is "captured-articles", newsletter_blocks is 0
        // (no inbox parsing) — this field carries the real count.
        captured_newsletter_count: capturedNewsletterCount,
        ...(captureFailure && {
          capture_failed: true,
          capture_error: captureFailure.error,
        }),
      });
    }
  } catch (e) {
    // Marker write falha não bloqueia o injetor — só perde a guarantee
    // anti-skip do step seguinte.
    console.error(`[inject-inbox-urls] warn: marker write falhou: ${(e as Error).message}`);
  }

  // Validate-pool mode: sanity check do merge interno (não anti-skip externo).
  // Como o merge é feito acima, falha aqui só em bug do script.
  // Anti-skip externo é tracked em #625.
  if (flags.has("validate-pool")) {
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
      total_editor_urls: injectedFromEditor.length,
      total_newsletter_urls: injectedFromNewsletters.length, // #1095
      total_pool_size: merged.length,
      editor_blocks: editorBlocks.length,
      newsletter_blocks: newsletterBlocks.length, // #1095
      captured_newsletter_count: capturedNewsletterCount, // #1541
      total_inbox_blocks: allBlocks.length,
      newsletter_source: newsletterSource, // #1520
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
