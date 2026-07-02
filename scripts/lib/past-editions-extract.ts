/**
 * lib/past-editions-extract.ts (#2833)
 *
 * Extração de URLs/títulos/entidades de `past-editions.md` e de edições
 * salvas em `data/editions/{AAMMDD}/` — usado pelo dedup contra histórico
 * publicado (pass 1/1b/1c/1d/1e do dedup() em scripts/dedup.ts).
 *
 * Extraído de dedup.ts — movimentação pura, sem mudança de comportamento.
 * dedup.ts re-exporta esses símbolos pra manter compat com importadores
 * existentes (`./dedup.ts` / `../scripts/dedup.ts`).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "./url-utils.ts";
import { isValidEditionDir } from "./edition-utils.ts"; // #1680: validador consolidado

export { isValidEditionDir };

// ---------------------------------------------------------------------------
// Parse past-editions.md — extrair URLs das últimas `window` edições
// Format: seções ## YYYY-MM-DD — "..." com "Links usados:\n- url" dentro
// ---------------------------------------------------------------------------

/** Janela default de edições passadas usadas pra dedup (#1067/#1068).
 * Compartilhado entre dedup.ts (phase 1) e finalize-stage1.ts (phase 2)
 * pra evitar mismatch — phase 1 permite secondary→novo, phase 2 dropa
 * secondary→secondary, e ambas precisam operar na mesma janela. */
export const DEFAULT_PAST_WINDOW = 3;

/**
 * #1847: lê o conteúdo de `past-editions.md`, retornando "" quando o arquivo
 * está AUSENTE. Pós-#1847 o arquivo mora em `data/` (gitignored, regenerado no
 * Stage 0), então num clone fresco / CI antes do primeiro `refresh-dedup` ele
 * pode não existir — tratar como histórico vazio (mesma semântica do guard #672)
 * em vez de crashar com ENOENT. `extractPastUrls`/`extractPastTitles` já tratam
 * "" como histórico vazio.
 *
 * `required: true` (quando o caller passou `--past-editions` EXPLÍCITO): aí a
 * ausência é erro de wiring (typo no path, refresh que não escreveu), não
 * bootstrap — falhar ALTO em vez de degradar a dedup-vs-histórico pra "" e
 * deixar um link das últimas 3 edições vazar pro publicado (review #1887). Só o
 * default-ausente é tratado como bootstrap silencioso.
 */
export function readPastEditionsMd(path: string, opts: { required?: boolean } = {}): string {
  if (existsSync(path)) return readFileSync(path, "utf8");
  if (opts.required) {
    throw new Error(
      `past-editions.md não encontrado em '${path}' (passado via --past-editions mas ausente — ` +
        `wiring error). Pra bootstrap sem histórico, omita --past-editions (usa o default em data/).`,
    );
  }
  return "";
}

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
 * #2548 (Furo 1): extrai URLs de TODAS as edições passadas sem limitar por janela.
 * Usado para dedup de conteúdo evergreen (use_melhor/video), que é re-descoberto
 * semanas ou meses depois e precisaria de uma janela muito maior que as notícias
 * efêmeras (radar/lancamento).
 *
 * Analogia: `extractPastUrls(md, Infinity)` — sem `.slice(0, window)`.
 */
export function extractPastUrlsUnbounded(md: string): Set<string> {
  const urls = new Set<string>();
  const sectionRe = /^## \d{4}-\d{2}-\d{2}/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)); // sem .slice(0, window)
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

/**
 * #1475: extrai entidades dos "Temas cobertos:" de past-editions.md.
 * Retorna Set de entidades lowercased das últimas `window` edições.
 */
export function extractPastThemeEntities(md: string, window: number): Set<string> {
  const entities = new Set<string>();
  const sectionRe = /^## \d{4}-\d{2}-\d{2}/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)).slice(0, window);
  for (const section of editionSections) {
    const themeStart = section.indexOf("Temas cobertos:");
    if (themeStart < 0) continue;
    const themeBlock = section.slice(themeStart);
    for (const line of themeBlock.split("\n")) {
      const m = line.match(/^-\s+(.+)/);
      if (m) entities.add(m[1].trim().toLowerCase());
    }
  }
  return entities;
}

/**
 * #1475: checa se um artigo candidato compartilha entidade com temas recentes.
 * Match case-insensitive: cada entidade do past-themes é buscada no título+summary.
 * Entidades curtas (<5 chars) ou genéricas ("Model", "Agent") são ignoradas.
 */
const GENERIC_THEME_WORDS = new Set([
  // common tech words
  "model","agent","cloud","flash","spark","ultra","build","tools","alpha",
  "delta","scale","state","smart","brain","pilot","robot","coral","atlas",
  "llama","search","studio","platform","release","update","launch",
  // major companies — too frequent to block by name alone
  "google","microsoft","apple","amazon","meta","nvidia","openai",
  "anthropic","deepmind","deepseek","mistral","cohere",
  // major products with daily news — block by specific feature, not product family
  "gemini","chatgpt","claude","copilot","alexa","siri","grok",
  "codex","cursor","perplexity",
  // common PT-BR words that slip through capitalization filter
  "regulação","mercado","brasil","lança","novo","nova",
]);
export function matchesRecentTheme(
  title: string,
  summary: string,
  pastEntities: Set<string>,
): string | null {
  const hay = `${title} ${summary}`.toLowerCase();
  for (const entity of pastEntities) {
    if (entity.length < 5) continue;
    if (GENERIC_THEME_WORDS.has(entity)) continue;
    if (hay.includes(entity)) return entity;
  }
  return null;
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
  // #1629: buckets renomeados
  lancamento?: ApprovedArticleLike[];
  radar?: ApprovedArticleLike[];
  use_melhor?: ApprovedArticleLike[];
  video?: ApprovedArticleLike[];
  // Legacy fields (preservados pra parsear approved.json de edições históricas)
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

/**
 * Pure (#1452): lê URLs dos destaques (D1/D2/D3) do MD final `02-reviewed.md`.
 * Padrão do renderer:
 *   **DESTAQUE N | category**
 *   (blank)
 *   [**title**](url)        ← canonical
 *   ou
 *   **[title](url)**        ← writer agent variant
 *
 * Pegamos a primeira URL após cada marcador `DESTAQUE N`. Mais autoritativo
 * que approved.json porque MD reflete edições pós-Stage-1 (title-picker,
 * dedup cleanup, Drive edits) que approved.json não captura.
 */
export function readReviewedDestaqueUrls(reviewedPath: string): string[] {
  if (!existsSync(reviewedPath)) return [];
  let md: string;
  try {
    md = readFileSync(reviewedPath, "utf8");
  } catch {
    // Race com OneDrive sync ou permissão flake — fail gracioso
    return [];
  }
  const urls: string[] = [];
  const lines = md.split(/\r?\n/);
  let inDestaque = false;
  // Markdown link tolerante a URLs com parênteses balanceados (Wikipedia etc.):
  // captura até o último `)` que precede whitespace ou fim de linha.
  // Aceita formatos:
  //   [**title**](url)     (canonical)
  //   **[title](url)**     (writer variant)
  //   [title](url)         (bare inline)
  // Trim já remove leading/trailing whitespace; t.startsWith() permitiria
  // qualquer prefixo de blockquote/list, mas conservador: regex aceita só
  // os prefixos esperados pelo renderer.
  const LINK_PATTERN = /\*{0,2}\[(?:\*{0,2})?[^\]]+(?:\*{0,2})?\]\((https?:\/\/[^\s]+?)\)\*{0,2}\s*$/;
  for (const line of lines) {
    const t = line.trim();
    // Reset on section separator
    if (t === "---") {
      inDestaque = false;
      continue;
    }
    // Destaque header (com ou sem emoji+pipe, tolerante a leading prefix)
    if (/^\*{0,2}DESTAQUE\s+\d+\s*\|/i.test(t)) {
      inDestaque = true;
      continue;
    }
    // Dentro de destaque, pega primeira URL canônica ou inline-link
    if (inDestaque) {
      const m = t.match(LINK_PATTERN);
      if (m) {
        urls.push(m[1]);
        inDestaque = false; // só primeira URL conta
      }
    }
  }
  return urls;
}

/**
 * Pure (#1452): lê URLs dos destaques do HTML final pasted no Beehiiv.
 * Padrão do render-newsletter-html.ts:
 *   <p>...DESTAQUE N | category...</p>
 *   <p>...<a href="URL" ...>title</a>...</p>
 *
 * Última instância de fallback antes do legacy 01-approved.json — HTML é
 * o que foi de fato entregue ao subscriber.
 */
export function readNewsletterHtmlDestaqueUrls(htmlPath: string): string[] {
  if (!existsSync(htmlPath)) return [];
  let html: string;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch {
    return [];
  }
  const urls: string[] = [];
  // Decodifica entities HTML comuns no href ANTES de extrair pra alinhar com
  // canonicalize() (que opera em URL "limpa", não encoded).
  const decoded = html.replace(/&amp;/gi, "&");
  // Pattern restritivo: marker DESTAQUE seguido de <a href> DENTRO de até
  // ~500 chars (~scope típico do bloco do destaque no template). Sem boundary,
  // [\s\S]*? podia pular pra <a> de footer/share em template degradado.
  // O lookahead negativo `?!\1` previne span passar pelo próximo marker.
  const re = /DESTAQUE\s+\d+[\s\S]{0,500}?<a\s+[^>]*href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    // Skip non-article links: anchors, share/permalink, mailto, javascript
    if (/^(#|mailto:|javascript:|tel:)/i.test(href)) continue;
    if (/share\.|\/share\?|\/unsubscribe|\/share-this/i.test(href)) continue;
    urls.push(href);
  }
  return urls;
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
  // #1629: lê buckets novos (radar/use_melhor/video) + legacy (pesquisa/noticias/tutorial).
  const buckets: ApprovedArticleLike[][] = [
    parsed.highlights ?? [],
    parsed.runners_up ?? [],
    parsed.lancamento ?? [],
    parsed.radar ?? [],
    parsed.use_melhor ?? [],
    parsed.video ?? [],
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
 * true se o dir contém algum artefato de edição real (não é um marker vazio).
 * Espelha as fontes que extractPastDestaqueUrls/extractPastEditionArticleTitles
 * sabem ler: MD revisado, HTML final publicado, ou approved.json (root/_internal).
 */
function hasEditionArtifact(editionsDir: string, name: string): boolean {
  return [
    resolve(editionsDir, name, "02-reviewed.md"),
    resolve(editionsDir, name, "_internal", "newsletter-final.html"),
    resolve(editionsDir, name, "_internal", "01-approved.json"),
    resolve(editionsDir, name, "01-approved.json"),
  ].some((p) => existsSync(p));
}

/**
 * As `window` edições REAIS mais recentes em `editionsDir` (ordem decrescente),
 * excluindo `currentAammdd`, dirs com nome inválido (ex: `260999`) e dirs sem
 * artefato de edição (markers de teste). Centraliza a seleção de janela usada
 * pelo dedup contra past-editions locais — antes o filtro `/^\d{6}$/` sozinho
 * deixava um dir sintético poluir a janela de 3 edições (#1567 audit).
 */
export function recentEditionDirs(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(editionsDir).filter(
      (d) => isValidEditionDir(d) && hasEditionArtifact(editionsDir, d),
    );
  } catch {
    return [];
  }
  dirs.sort().reverse();
  if (currentAammdd) dirs = dirs.filter((d) => d !== currentAammdd);
  return dirs.slice(0, window);
}

/**
 * Pure (#1856): deriva o AAMMDD da edição corrente a partir de um path que passa
 * por `editions/{AAMMDD}/` (tipicamente `--out` ou `--articles`, ex:
 * `data/editions/260605/_internal/01-approved.json`). Retorna o 1º match.
 *
 * Usado pra excluir a edição corrente do dedup subject-level mesmo quando o
 * caller esquece `--current-edition` — senão a edição deduplica contra o próprio
 * `01-approved.json` (self-match) e re-runs/resumes esvaziam a edição (#1856).
 */
export function deriveCurrentEdition(...paths: Array<string | undefined>): string | undefined {
  for (const p of paths) {
    if (!p) continue;
    const m = p.replace(/\\/g, "/").match(/(?:^|\/)editions\/(\d{6})(?:\/|$)/);
    // #1875 review: valida o AAMMDD (rejeita 260999/261301 de dirs sintéticos/
    // markers) pra ficar consistente com recentEditionDirs e surfaçar paths
    // malformados em vez de mascará-los.
    if (m && isValidEditionDir(m[1])) return m[1];
  }
  return undefined;
}

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
  const recent = recentEditionDirs(editionsDir, window, currentAammdd);

  const urls = new Set<string>();
  for (const aammdd of recent) {
    // #1452 hierarchy: MD final > HTML final > approved.json (legacy fallback).
    // Razão: 02-reviewed.md reflete edições pós-Stage-1 (title-picker, dedup
    // cleanup, Drive sync) que approved.json não captura — caso 260520 onde
    // approved.json tinha D1=Karpathy mas o publicado tinha D1=Gemini 3.5.
    const reviewedPath = resolve(editionsDir, aammdd, "02-reviewed.md");
    const htmlPath = resolve(editionsDir, aammdd, "_internal", "newsletter-final.html");
    const approvedCandidates = [
      resolve(editionsDir, aammdd, "_internal", "01-approved.json"),
      resolve(editionsDir, aammdd, "01-approved.json"),
    ];

    let sourceUrls: string[] = [];
    if (existsSync(reviewedPath)) {
      sourceUrls = readReviewedDestaqueUrls(reviewedPath);
    }
    if (sourceUrls.length === 0 && existsSync(htmlPath)) {
      sourceUrls = readNewsletterHtmlDestaqueUrls(htmlPath);
    }
    if (sourceUrls.length === 0) {
      for (const path of approvedCandidates) {
        if (!existsSync(path)) continue;
        sourceUrls = readApprovedDestaqueUrls(path);
        if (sourceUrls.length > 0) break;
      }
    }

    for (const u of sourceUrls) {
      // Canonicalize pra match com canonicalize(art.url) no dedup
      urls.add(canonicalize(u));
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
  const recent = recentEditionDirs(editionsDir, window, currentAammdd);

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
