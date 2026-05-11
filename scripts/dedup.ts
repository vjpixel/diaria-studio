/**
 * dedup.ts
 *
 * Remove artigos duplicados da lista de candidatos.
 * Dois passes:
 *   1. Contra `past-editions.md` — URL canônica (últimas N edições)
 *   2. Dentro da própria lista — URL canônica + similaridade de título
 *
 * Uso:
 *   npx tsx scripts/dedup.ts --articles <articles.json> --past-editions context/past-editions.md [--window 3] [--title-threshold 0.85] [--out <out.json>]
 *
 * Input:  array JSON de artigos (cada um com ao menos { url, title? })
 * Output: { kept: Article[], removed: RemovedEntry[] }
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isAggregator } from "./lib/aggregators";
import { CONFIG } from "./lib/config.ts";
import { canonicalize } from "./lib/url-utils.ts";
import { runMain } from "./lib/exit-handler.ts";
import { logEvent } from "./lib/run-log.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";

export { canonicalize };

// URL canonicalization — centralizada em scripts/lib/url-utils.ts (#523)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Levenshtein similarity (0 = completamente diferente, 1 = idêntico)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[n];
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|o|e|um|uma|de|da|do|em|para|por|com|que|se|na|no|as|os|ao|aos|das|dos|pela|pelo|pelas|pelos|is|the|a|an|of|in|for|to|and|on|at|by|with)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 0; // #674: sem conteúdo normalizável, não há similaridade
  return 1 - levenshtein(na, nb) / maxLen;
}

// ---------------------------------------------------------------------------
// Parse past-editions.md — extrair URLs das últimas `window` edições
// Format: seções ## YYYY-MM-DD — "..." com "Links usados:\n- url" dentro
// ---------------------------------------------------------------------------

/** Janela default de edições passadas usadas pra dedup (#1067/#1068).
 * Compartilhado entre dedup.ts (phase 1) e finalize-stage1.ts (phase 2)
 * pra evitar mismatch — phase 1 permite secondary→novo, phase 2 dropa
 * secondary→secondary, e ambas precisam operar na mesma janela. */
export const DEFAULT_PAST_WINDOW = 3;

export function extractPastUrls(md: string, window: number): Set<string> {
  const urls = new Set<string>();

  // Split into edition sections by ## YYYY-MM-DD header
  const sectionRe = /^## \d{4}-\d{2}-\d{2}/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)).slice(0, window);

  for (const section of editionSections) {
    for (const line of section.split("\n")) {
      const m = line.match(/^-\s+(https?:\/\/\S+)/);
      if (m) urls.add(canonicalize(m[1].replace(/[.,);]+$/, "")));
    }
  }
  return urls;
}

/**
 * Extrai títulos das últimas `window` edições publicadas (#231 defense-in-depth).
 * Captura o título de cada edição (`## YYYY-MM-DD — "Título"`) para comparação
 * de similaridade com artigos candidatos.
 *
 * Nota: são títulos das newsletters (headline do destaque principal), não títulos
 * individuais dos artigos. Sinal mais fraco que URL match, mas útil quando URL
 * difere (mesma notícia, fonte diferente).
 */
export function extractPastTitles(md: string, window: number): string[] {
  const titles: string[] = [];
  const sectionRe = /^## \d{4}-\d{2}-\d{2}/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)).slice(0, window);
  for (const section of editionSections) {
    const titleMatch = section.match(/^## \d{4}-\d{2}-\d{2}[^"]*"([^"]+)"/m);
    if (titleMatch) titles.push(titleMatch[1]);
  }
  return titles;
}

// ---------------------------------------------------------------------------
// #897: Subject-level dedup contra past editions
//
// Além de URL match e headline match, comparar título do artigo candidato
// contra títulos de TODOS os artigos cobertos nas últimas N edições. Pega o
// caso "TechCrunch reporta lançamento OpenAI X" quando "OpenAI lança X" já
// rodou em N-1.
//
// Fonte: `data/editions/{AAMMDD}/_internal/01-approved.json` (highlights +
// runners_up). Fallback gracioso: se arquivo não existe (edições antigas)
// ou JSON inválido, simplesmente skipa a edição e segue.
// ---------------------------------------------------------------------------

interface ApprovedArticleLike {
  url?: string;
  title?: string;
  article?: { url?: string; title?: string };
}

interface ApprovedJsonShape {
  highlights?: ApprovedArticleLike[];
  runners_up?: ApprovedArticleLike[];
  lancamento?: ApprovedArticleLike[];
  pesquisa?: ApprovedArticleLike[];
  noticias?: ApprovedArticleLike[];
  tutorial?: ApprovedArticleLike[];
}

/**
 * Pure (#1068): lê URLs de `highlights[]` (= destaques D1/D2/D3) do
 * `_internal/01-approved.json` de uma edição. Usado pra distinguir
 * "URL já foi destaque" (bloquear) vs "URL foi só secondary" (permitir
 * promoção secondary→destaque na edição corrente).
 */
function readApprovedDestaqueUrls(approvedPath: string): string[] {
  if (!existsSync(approvedPath)) return [];
  let parsed: ApprovedJsonShape;
  try {
    parsed = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJsonShape;
  } catch {
    return [];
  }
  const urls = new Set<string>();
  for (const item of parsed.highlights ?? []) {
    const u = item?.url ?? item?.article?.url;
    if (u && typeof u === "string" && u.trim()) urls.add(u.trim());
  }
  return [...urls];
}

function readApprovedTitles(approvedPath: string): string[] {
  if (!existsSync(approvedPath)) return [];
  let parsed: ApprovedJsonShape;
  try {
    parsed = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJsonShape;
  } catch {
    return [];
  }
  const titles = new Set<string>();
  const buckets: ApprovedArticleLike[][] = [
    parsed.highlights ?? [],
    parsed.runners_up ?? [],
    parsed.lancamento ?? [],
    parsed.pesquisa ?? [],
    parsed.noticias ?? [],
    parsed.tutorial ?? [],
  ];
  for (const bucket of buckets) {
    for (const item of bucket) {
      const t = item?.article?.title ?? item?.title;
      if (t && typeof t === "string" && t.trim()) titles.add(t.trim());
    }
  }
  return [...titles];
}

/**
 * Lê títulos individuais de artigos cobertos nas últimas `window` edições
 * salvas localmente em `data/editions/{AAMMDD}/`. Procura `01-approved.json`
 * em `_internal/` (formato pós-#574) e em root (formato anterior).
 *
 * Edição atual (`currentAammdd`) é excluída pra evitar self-match.
 *
 * Falha gracioso: arquivos ausentes/corrompidos viram skip silencioso.
 *
 * Refs #897.
 */
/**
 * Pure (#1068): agrega URLs que **foram destaques** (highlights D1/D2/D3) nas
 * últimas `window` edições salvas em `editionsDir`. Usado pra dedup com
 * distinção destaque-vs-secondary: dedup.ts bloqueia se URL nesta lista,
 * libera se URL veio só de bucket secundário em edição passada.
 *
 * Edição atual (`currentAammdd`) é excluída pra evitar self-match.
 *
 * Falha gracioso: arquivos ausentes/corrompidos viram skip silencioso. Retorna
 * Set vazio quando editionsDir não existe ou nenhuma edição tem `highlights`.
 */
export function extractPastDestaqueUrls(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
): Set<string> {
  if (!existsSync(editionsDir)) return new Set();
  let dirs: string[];
  try {
    dirs = readdirSync(editionsDir).filter((d) => /^\d{6}$/.test(d));
  } catch {
    return new Set();
  }
  dirs.sort().reverse();
  if (currentAammdd) dirs = dirs.filter((d) => d !== currentAammdd);
  const recent = dirs.slice(0, window);

  const urls = new Set<string>();
  for (const aammdd of recent) {
    const candidates = [
      resolve(editionsDir, aammdd, "_internal", "01-approved.json"),
      resolve(editionsDir, aammdd, "01-approved.json"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      for (const u of readApprovedDestaqueUrls(path)) {
        // Canonicalize pra match com canonicalize(art.url) no dedup
        urls.add(canonicalize(u));
      }
      break;
    }
  }
  return urls;
}

export function extractPastEditionArticleTitles(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
): string[] {
  if (!existsSync(editionsDir)) return [];
  let dirs: string[];
  try {
    dirs = readdirSync(editionsDir).filter((d) => /^\d{6}$/.test(d));
  } catch {
    return [];
  }
  // Sort decrescente (mais recente primeiro), excluir current.
  dirs.sort().reverse();
  if (currentAammdd) dirs = dirs.filter((d) => d !== currentAammdd);
  const recent = dirs.slice(0, window);

  const titles = new Set<string>();
  for (const aammdd of recent) {
    const candidates = [
      resolve(editionsDir, aammdd, "_internal", "01-approved.json"),
      resolve(editionsDir, aammdd, "01-approved.json"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      for (const t of readApprovedTitles(path)) titles.add(t);
      break; // primeiro arquivo encontrado = source-of-truth da edição
    }
  }
  return [...titles];
}

// ---------------------------------------------------------------------------
// Jaccard similarity sobre tokens normalizados (#897)
//
// Mais permissivo que Levenshtein pra comparar títulos PT-BR vs EN da mesma
// história — a sobreposição de entidades/keywords domina, palavras de
// transição diferem.
// ---------------------------------------------------------------------------

/**
 * Tokeniza título normalizado em set de palavras de >= 3 chars (descarta
 * stopwords e tokens curtos). Usa o mesmo `normalizeTitle` (lowercase, sem
 * acentos, stopwords PT/EN removidas).
 *
 * Tokens curtos descartados pra reduzir noise: "a", "de", "em" não diferenciam.
 */
export function tokenizeForJaccard(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const tokens = normalized.split(/\s+/).filter((t) => t.length >= 3);
  return new Set(tokens);
}

/**
 * Jaccard similarity entre dois sets — |A ∩ B| / |A ∪ B|. Ambos vazios = 0
 * (degeneração: títulos sem token significativo não devem disparar dup).
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Conveniência: similaridade de subject (Jaccard sobre tokens) entre dois
 * títulos. Se ambos são similares > threshold, considerar duplicata-de-tema.
 *
 * Threshold sugerido pelo issue #897: 0.6 (mais permissivo que Levenshtein
 * intra-edição em 0.85). Defaults conservadores são caller-controlled.
 */
export function subjectSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenizeForJaccard(a), tokenizeForJaccard(b));
}

// ---------------------------------------------------------------------------
// Inbox title resolution (#485)
// ---------------------------------------------------------------------------

/** Placeholder values that indicate an unresolved inbox title. */
const INBOX_TITLE_PLACEHOLDERS = ["(inbox)", "(no title)", "(sem título)"];

/** Returns true if the article title is a placeholder that needs resolution. */
export function needsTitleResolution(title: string | undefined | null): boolean {
  if (!title || !title.trim()) return true;
  const lower = title.trim().toLowerCase();
  if (INBOX_TITLE_PLACEHOLDERS.includes(lower)) return true;
  if (/^\(inbox/i.test(lower)) return true;
  if (/^\[inbox\]/i.test(lower)) return true;
  return false;
}

/**
 * Fetches the real title of a page by parsing its `<title>` tag.
 * Returns null on network error, non-OK response, or missing `<title>`.
 */
export async function fetchTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Diar.ia/1.0 (https://diar.ia.br; diariaeditor@gmail.com)",
      },
      signal: AbortSignal.timeout(CONFIG.timeouts.fetch),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim().replace(/\s+/g, " ") : null;
  } catch {
    return null;
  }
}

/**
 * For each article with a placeholder title (e.g. `(inbox)`), resolves the
 * real title via an HTTP fetch. Processed in parallel up to `concurrency`
 * simultaneous requests. Articles that fail to resolve keep their original
 * title. Never throws — uses Promise.allSettled internally.
 *
 * @param articles    Mutable array; titles are updated in-place on success.
 * @param concurrency Max parallel fetches (default: 15).
 */
export async function resolveInboxTitles(
  articles: { url: string; title?: string | null; [key: string]: unknown }[],
  concurrency = CONFIG.dedup.titleResolutionConcurrency,
): Promise<{ resolved: number; failed: number }> {
  const targets = articles
    .map((a, i) => ({ idx: i, article: a }))
    .filter(({ article }) => needsTitleResolution(article.title));

  if (targets.length === 0) return { resolved: 0, failed: 0 };

  let resolved = 0;
  let failed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const job = targets[cursor++];
      const title = await fetchTitle(job.article.url);
      if (title) {
        articles[job.idx].title = title;
        resolved++;
      } else {
        failed++;
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, targets.length)) },
    () => worker(),
  );
  await Promise.allSettled(workers);

  return { resolved, failed };
}

// ---------------------------------------------------------------------------
// Main dedup logic
// ---------------------------------------------------------------------------

interface Article {
  url: string;
  title?: string;
  source?: string;
  discovered_source?: boolean;
  [key: string]: unknown;
}

interface RemovedEntry {
  url: string;
  title?: string;
  dedup_note: string;
}

export function dedup(
  articles: Article[],
  pastUrlsSet: Set<string>,
  titleThreshold: number,
  pastTitles: string[] = [],
  titleVsPastThreshold = 0.70,
  pastArticleTitles: string[] = [],
  subjectVsPastThreshold = 0.6,
  // #1068: URLs que foram destaques (highlights) em edições passadas.
  // Quando fornecido, dedup distingue:
  //   - URL em pastDestaqueUrlsSet → bloqueia (já foi destaque, evita repetição)
  //   - URL em pastUrlsSet mas NÃO em pastDestaqueUrlsSet → permite
  //     (foi só secondary passado, permite promoção a destaque agora)
  // Quando ausente (legacy callers), comportamento antigo: bloqueia tudo em pastUrlsSet.
  pastDestaqueUrlsSet?: Set<string>,
): { kept: Article[]; removed: RemovedEntry[] } {
  const kept: Article[] = [];
  const removed: RemovedEntry[] = [];

  // ---- Pass 0: reject aggregator URLs (safety net) -----------------------
  const afterPass0: Article[] = [];
  let pass0Rejected = 0;
  for (const art of articles) {
    if (isAggregator(art.url)) {
      removed.push({ url: art.url, title: art.title, dedup_note: "agregador/roundup bloqueado (use fonte primária)" });
      pass0Rejected++;
    } else {
      afterPass0.push(art);
    }
  }
  if (pass0Rejected > 0) {
    console.error(`dedup Pass-0: ${pass0Rejected} URL(s) de agregador/roundup rejeitadas`);
  }

  // ---- Pass 1: dedup against past editions (URL only) --------------------
  // #1068: quando pastDestaqueUrlsSet fornecido, distingue destaque-passado
  // (bloqueia sempre) vs só-secondary-passado (permite promoção). Quando
  // ausente, comportamento legacy: bloqueia tudo em pastUrlsSet.
  const afterPass1: Article[] = [];
  let promotedFromSecondary = 0;
  for (const art of afterPass0) {
    const canon = canonicalize(art.url);
    const wasInPast = pastUrlsSet.has(canon);
    if (!wasInPast) {
      afterPass1.push(art);
      continue;
    }
    if (pastDestaqueUrlsSet && !pastDestaqueUrlsSet.has(canon)) {
      // URL apareceu em past só como secondary — permite promoção pra destaque.
      afterPass1.push(art);
      promotedFromSecondary++;
      console.error(
        `dedup Pass-1: secondary→destaque permitido (#1068) | ${art.url}`,
      );
      continue;
    }
    removed.push({ url: art.url, title: art.title, dedup_note: "url-match com edição anterior" });
  }
  if (promotedFromSecondary > 0) {
    console.error(
      `dedup Pass-1: ${promotedFromSecondary} URL(s) liberadas via promoção secondary→destaque (#1068)`,
    );
  }

  // ---- Pass 1b: title similarity vs past edition headlines (#231 defense-in-depth) ---
  // Threshold mais permissivo (0.70 vs 0.85 dentro da lista) — títulos de newsletter
  // diferem em idioma/ângulo mas evento idêntico deve ter sim > 0.70.
  // Só roda se pastTitles foi fornecido (backward-compat).
  const afterPass1b: Article[] = [];
  if (pastTitles.length > 0) {
    for (const art of afterPass1) {
      if (!art.title) {
        afterPass1b.push(art);
        continue;
      }
      let isDupVsPast = false;
      for (const pastTitle of pastTitles) {
        const sim = titleSimilarity(art.title, pastTitle);
        if (sim >= titleVsPastThreshold) {
          removed.push({
            url: art.url,
            title: art.title,
            dedup_note: `título similar (${(sim * 100).toFixed(0)}%) ao headline de edição anterior "${pastTitle}"`,
          });
          isDupVsPast = true;
          break;
        }
      }
      if (!isDupVsPast) afterPass1b.push(art);
    }
    if (afterPass1.length > afterPass1b.length) {
      console.error(`dedup Pass-1b: ${afterPass1.length - afterPass1b.length} artigo(s) removido(s) por similaridade com headline de edição anterior`);
    }
  } else {
    afterPass1b.push(...afterPass1);
  }

  // ---- Pass 1c: subject (Jaccard) similarity vs past edition ARTICLES (#897) ---
  // Diferença pra Pass-1b: 1b compara contra o headline-da-newsletter (1 título
  // por edição, normalmente o destaque #1). 1c compara contra TODOS os artigos
  // cobertos na edição (highlights + runners_up + buckets). Pega o caso "fonte
  // diferente, mesma history" que vazaria pelos outros passes.
  //
  // Jaccard em vez de Levenshtein: mais permissivo pra PT-BR vs EN — sobreposição
  // de entidades/produtos domina. Threshold default 0.6.
  //
  // Só roda quando pastArticleTitles foi fornecido (backward-compat).
  const afterPass1c: Article[] = [];
  if (pastArticleTitles.length > 0) {
    // Pré-tokenizar past titles uma vez — caro recomputar pra cada artigo.
    const pastTokens = pastArticleTitles.map((t) => ({
      title: t,
      tokens: tokenizeForJaccard(t),
    }));
    for (const art of afterPass1b) {
      if (!art.title) {
        afterPass1c.push(art);
        continue;
      }
      const candidateTokens = tokenizeForJaccard(art.title);
      // Títulos sem tokens significativos (curtos/vazios) não disparam
      // — Jaccard contra qualquer set vazio = 0.
      if (candidateTokens.size === 0) {
        afterPass1c.push(art);
        continue;
      }
      let isDupVsPastSubject = false;
      let bestMatch: { title: string; sim: number } | null = null;
      for (const pt of pastTokens) {
        const sim = jaccardSimilarity(candidateTokens, pt.tokens);
        if (sim >= subjectVsPastThreshold && (bestMatch === null || sim > bestMatch.sim)) {
          bestMatch = { title: pt.title, sim };
        }
      }
      if (bestMatch !== null) {
        removed.push({
          url: art.url,
          title: art.title,
          dedup_note: `subject similar (${(bestMatch.sim * 100).toFixed(0)}% Jaccard) a artigo de edição anterior "${bestMatch.title}"`,
        });
        isDupVsPastSubject = true;
      }
      if (!isDupVsPastSubject) afterPass1c.push(art);
    }
    if (afterPass1b.length > afterPass1c.length) {
      console.error(
        `dedup Pass-1c (#897): ${afterPass1b.length - afterPass1c.length} artigo(s) removido(s) por subject-Jaccard >= ${subjectVsPastThreshold} contra título de artigo em edição anterior`,
      );
    }
  } else {
    afterPass1c.push(...afterPass1b);
  }

  // ---- Pass 2: dedup within the current list -----------------------------
  // Sub-pass 2a: group by canonical URL, keep best per group
  const byUrl = new Map<string, Article[]>();
  for (const art of afterPass1c) {
    const canon = canonicalize(art.url);
    const group = byUrl.get(canon) ?? [];
    group.push(art);
    byUrl.set(canon, group);
  }

  const afterUrlDedup: Article[] = [];
  for (const [, group] of byUrl) {
    if (group.length === 1) {
      afterUrlDedup.push(group[0]);
      continue;
    }
    // Keep the best: prefer registered source (no discovered_source flag) + longest title
    const sorted = [...group].sort((a, b) => {
      const aDisc = a.discovered_source ? 1 : 0;
      const bDisc = b.discovered_source ? 1 : 0;
      if (aDisc !== bDisc) return aDisc - bDisc; // non-discovered first
      return (b.title?.length ?? 0) - (a.title?.length ?? 0);
    });
    afterUrlDedup.push(sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
      removed.push({ url: sorted[i].url, title: sorted[i].title, dedup_note: `url-duplicado na lista (mantido: ${sorted[0].url})` });
    }
  }

  // Sub-pass 2b: title similarity dedup
  for (let i = 0; i < afterUrlDedup.length; i++) {
    const artI = afterUrlDedup[i];
    if (!artI.title) {
      kept.push(artI);
      continue;
    }
    let isDup = false;
    for (let j = 0; j < i; j++) {
      const artJ = afterUrlDedup[j];
      if (!artJ.title) continue;
      // #482: artigos inbox têm título "(inbox)" — não comparar por título;
      // deduplicação real já foi feita por URL na sub-pass 2a.
      if (
        artI.title.toLowerCase() === "(inbox)" ||
        artJ.title.toLowerCase() === "(inbox)"
      ) continue;
      const sim = titleSimilarity(artI.title, artJ.title);
      if (sim >= titleThreshold) {
        // Keep the one from a registered source; in a tie, keep artJ (already in kept)
        const iIsDisc = artI.discovered_source ? 1 : 0;
        const jIsDisc = artJ.discovered_source ? 1 : 0;
        if (iIsDisc >= jIsDisc) {
          // artI is worse or equal — remove it
          removed.push({
            url: artI.url,
            title: artI.title,
            dedup_note: `título similar (${(sim * 100).toFixed(0)}%) ao de "${artJ.title}" (${artJ.url})`,
          });
          isDup = true;
          break;
        } else {
          // artI is from a registered source, artJ is discovered — swap: remove artJ
          // But artJ is already in kept... flag it for removal retroactively
          const jIdx = kept.findIndex((a) => a.url === artJ.url);
          if (jIdx !== -1) {
            removed.push({
              url: artJ.url,
              title: artJ.title,
              dedup_note: `título similar (${(sim * 100).toFixed(0)}%) ao de "${artI.title}" (${artI.url}) — fonte cadastrada preferida`,
            });
            kept.splice(jIdx, 1);
          }
          // artI will be added below
        }
      }
    }
    if (!isDup) kept.push(artI);
  }

  return { kept, removed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  // #926: usar parser compartilhado em vez de reinventar.
  const args = parseCliArgs(process.argv.slice(2)).values;

  const articlesPath = args["articles"];
  const pastEditionsPath = args["past-editions"] ?? "context/past-editions.md";
  const window = parseInt(args["window"] ?? String(DEFAULT_PAST_WINDOW), 10);
  const titleThreshold = parseFloat(args["title-threshold"] ?? String(CONFIG.dedup.titleThreshold));
  const outPath = args["out"];

  if (!articlesPath) {
    console.error("Uso: dedup.ts --articles <articles.json> [--past-editions <path>] [--editions-dir data/editions] [--current-edition AAMMDD] [--window 3] [--title-threshold 0.85] [--title-vs-past-threshold 0.70] [--subject-vs-past-threshold 0.60] [--out <out.json>]");
    process.exit(1);
  }

  const articles: Article[] = JSON.parse(readFileSync(articlesPath, "utf8"));

  // Pre-pass (#485): resolve placeholder titles for inbox articles before dedup
  // so "(inbox)" doesn't cause false-positive title similarity matches.
  const inboxCount = articles.filter((a) => needsTitleResolution(a.title)).length;
  if (inboxCount > 0) {
    console.error(`dedup pre-pass: ${inboxCount} artigo(s) com título placeholder — resolvendo títulos reais...`);
    const { resolved, failed } = await resolveInboxTitles(articles);
    console.error(`dedup pre-pass: ${resolved} título(s) resolvido(s), ${failed} falha(s) (mantidos com placeholder)`);
  }

  const pastMd = readFileSync(pastEditionsPath, "utf8");
  const pastUrls = extractPastUrls(pastMd, window);
  const pastTitles = extractPastTitles(pastMd, window); // #231 defense-in-depth

  // #672: guard contra past-editions.md vazio (ex: Beehiiv offline em Stage 0d)
  if (pastUrls.size === 0 && pastTitles.length === 0) {
    console.error(
      `WARN [dedup]: past-editions.md sem seções YYYY-MM-DD — histórico vazio. ` +
      `Dedup contra edições anteriores não funcionou. Verificar se scripts/refresh-dedup.ts completou.`,
    );
  }

  const titleVsPastThreshold = parseFloat(args["title-vs-past-threshold"] ?? String(CONFIG.dedup.titleVsPastThreshold));

  // #897: também extrair títulos individuais de artigos de edições passadas
  // pra subject-level dedup. Default: data/editions/ + window edições recentes.
  const editionsDir = args["editions-dir"] ?? "data/editions";
  const subjectVsPastThreshold = parseFloat(
    args["subject-vs-past-threshold"] ?? "0.6",
  );
  const currentAammdd = args["current-edition"]; // optional, exclude self
  const pastArticleTitles = extractPastEditionArticleTitles(
    editionsDir,
    window,
    currentAammdd,
  );
  if (pastArticleTitles.length > 0) {
    console.error(
      `dedup: ${pastArticleTitles.length} título(s) de artigos de edições anteriores carregado(s) (#897 subject-dedup)`,
    );
  }

  // #1068: extrair URLs que foram destaques (highlights) em edições passadas.
  // Dedup usa pra permitir promoção secondary→destaque (URL em past mas não
  // como destaque → permite na edição corrente como destaque).
  const pastDestaqueUrls = extractPastDestaqueUrls(
    editionsDir,
    window,
    currentAammdd,
  );
  if (pastDestaqueUrls.size > 0) {
    console.error(
      `dedup: ${pastDestaqueUrls.size} URL(s) de destaques passados carregados (#1068)`,
    );
  }

  const result = dedup(
    articles,
    pastUrls,
    titleThreshold,
    pastTitles,
    titleVsPastThreshold,
    pastArticleTitles,
    subjectVsPastThreshold,
    pastDestaqueUrls,
  );

  console.error(
    `dedup: ${articles.length} input → ${result.kept.length} kept, ${result.removed.length} removed (window=${window} edições, threshold=${titleThreshold}, title-vs-past=${titleVsPastThreshold}, subject-vs-past=${subjectVsPastThreshold})`
  );

  const removed = result.removed.length;
  const kept = result.kept.length;
  logEvent({
    edition: null,
    stage: 1,
    agent: "dedup.ts",
    level: "info",
    message: `dedup: ${removed} artigos removidos por similaridade, ${kept} mantidos`,
    details: { removed, kept },
  });

  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    console.error(`Wrote to ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  runMain(main);
}
