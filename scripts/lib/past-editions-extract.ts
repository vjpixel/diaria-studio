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

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "./url-utils.ts";
import { isValidEditionDir } from "./edition-utils.ts"; // #1680: validador consolidado
import { enumerateEditionDirs } from "./find-current-edition.ts"; // #2463/#3025: layout flat+nested
import { decodeHtmlEntities } from "./clean-summary.ts"; // #9646: entidade HTML não vira token

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
 * #9955: janela do bloqueio de URL REPETIDA, em DIAS (decisão do editor,
 * briefing overnight 261009). Antes o bloqueio usava `DEFAULT_PAST_WINDOW`
 * (3 edições) — a mesma URL voltou como D1 em 261009 oito edições depois de
 * sair como D2 em 261001 e passou. Vale só pra URL exata (canônica): os
 * sinais fuzzy (título, tema, entidade, fato) continuam em
 * `DEFAULT_PAST_WINDOW`, onde a janela curta é deliberada (follow-up de
 * história em andamento não é repetição).
 *
 * Depende de `data/past-editions.md` cobrir esses dias: o gerador trunca em
 * `beehiiv.dedupEditionCount` (platform.config.json), que precisa ser
 * >= o nº de edições publicadas em `DEDUP_URL_WINDOW_DAYS` dias.
 */
export const DEDUP_URL_WINDOW_DAYS = 30;

/** AAMMDD → epoch ms (UTC, meia-noite). `undefined` se inválido. */
function aammddToUtcMs(aammdd: string): number | undefined {
  if (!/^\d{6}$/.test(aammdd)) return undefined;
  const y = 2000 + Number(aammdd.slice(0, 2));
  const m = Number(aammdd.slice(2, 4));
  const d = Number(aammdd.slice(4, 6));
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return undefined;
  }
  return ms;
}

/** YYYY-MM-DD → epoch ms (UTC). */
function isoDateToUtcMs(iso: string): number | undefined {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  return aammddToUtcMs(`${m[1].slice(2)}${m[2]}${m[3]}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * #9955: seleciona as seções `## YYYY-MM-DD` de past-editions.md publicadas
 * nos `days` dias ANTERIORES à edição de referência: `ref - days <= data < ref`.
 * A própria edição (e posteriores, num replay) fica de fora — sem self-match
 * quando o refresh-dedup já incluiu a edição corrente.
 *
 * Sem `referenceAammdd` (caller não sabe a edição corrente): ancora na seção
 * mais recente como se a referência fosse o dia seguinte a ela (edição é
 * sempre D+1), incluindo-a.
 */
export function pastSectionsWithinDays(
  md: string,
  days: number,
  referenceAammdd?: string,
): { date: string; section: string }[] {
  const sectionRe = /^## (\d{4}-\d{2}-\d{2})/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const sections: { date: string; ms: number; section: string }[] = [];
  for (const s of parts) {
    const m = s.match(sectionRe);
    if (!m) continue;
    const ms = isoDateToUtcMs(m[1]);
    if (ms === undefined) continue;
    sections.push({ date: m[1], ms, section: s });
  }
  if (sections.length === 0) return [];

  let refMs = referenceAammdd ? aammddToUtcMs(referenceAammdd) : undefined;
  if (refMs === undefined) {
    refMs = Math.max(...sections.map((s) => s.ms)) + DAY_MS;
  }
  const cutoffMs = refMs - days * DAY_MS;
  return sections
    .filter((s) => s.ms >= cutoffMs && s.ms < refMs!)
    .map(({ date, section }) => ({ date, section }));
}

function urlsOfSection(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^-\s+(https?:\/\/\S+)/);
    if (m) out.push(canonicalize(m[1].replace(/[.,);]+$/, "")));
  }
  return out;
}

/**
 * #9955: URLs canônicas publicadas nos últimos `days` dias (default
 * `DEDUP_URL_WINDOW_DAYS`) antes da edição de referência. Substitui
 * `extractPastUrls(md, DEFAULT_PAST_WINDOW)` nos bloqueios de URL repetida
 * (dedup Stage 1, finalize-stage1, check-promoted-dedup, invariante Stage 4).
 */
export function extractPastUrlsWithinDays(
  md: string,
  days: number = DEDUP_URL_WINDOW_DAYS,
  referenceAammdd?: string,
): Set<string> {
  const urls = new Set<string>();
  for (const { section } of pastSectionsWithinDays(md, days, referenceAammdd)) {
    for (const u of urlsOfSection(section)) urls.add(u);
  }
  return urls;
}

/**
 * #9955: como `extractPastUrlsWithOrigin`, mas pela janela em dias. Primeira
 * ocorrência (a mais recente, seções em ordem decrescente) vence.
 */
export function extractPastUrlsWithOriginWithinDays(
  md: string,
  days: number = DEDUP_URL_WINDOW_DAYS,
  referenceAammdd?: string,
): Map<string, string> {
  const origins = new Map<string, string>();
  const sections = pastSectionsWithinDays(md, days, referenceAammdd).sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  for (const { date, section } of sections) {
    for (const u of urlsOfSection(section)) {
      if (!origins.has(u)) origins.set(u, date);
    }
  }
  return origins;
}

/**
 * #9955: AAMMDD de corte (inclusive) da janela em dias — edições com
 * AAMMDD >= este valor estão dentro da janela. Usado pra filtrar diretórios
 * de edição (`extractPastDestaqueUrls`). `undefined` se a referência é inválida.
 */
export function cutoffAammdd(referenceAammdd: string, days: number): string | undefined {
  const refMs = aammddToUtcMs(referenceAammdd);
  if (refMs === undefined) return undefined;
  const d = new Date(refMs - days * DAY_MS);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

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
 * #8993: mesma extração de `extractPastUrls`, mas mapeando cada URL canônica
 * pra data (YYYY-MM-DD) da edição de origem — usado pelo guard de Stage 4
 * (`check-no-duplicate-urls-vs-past-editions`) pra citar em qual edição o
 * link já saiu, em vez de só sinalizar "repetido". Sections já vêm em ordem
 * decrescente de data (mesma premissa de `extractPastUrls`); primeira
 * ocorrência de uma URL na janela é a mais recente, então `set` só na
 * primeira vez (não sobrescreve com uma origem mais antiga).
 */
export function extractPastUrlsWithOrigin(md: string, window: number): Map<string, string> {
  const origins = new Map<string, string>();

  const sectionRe = /^## (\d{4}-\d{2}-\d{2})/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)).slice(0, window);

  for (const section of editionSections) {
    const dateMatch = section.match(sectionRe);
    const date = dateMatch ? dateMatch[1] : "?";
    for (const line of section.split("\n")) {
      const m = line.match(/^-\s+(https?:\/\/\S+)/);
      if (!m) continue;
      const canonical = canonicalize(m[1].replace(/[.,);]+$/, ""));
      if (!origins.has(canonical)) origins.set(canonical, date);
    }
  }
  return origins;
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
  // #8666: delega para a variante com data — uma única regex de parsing, pra as
  // chaves do mapa de distâncias do event-dedup nunca divergirem destes títulos.
  return extractPastTitlesWithEdition(md, window).map((e) => e.title);
}

/**
 * #8666: como `extractPastTitles`, mas com o AAMMDD da edição de cada título
 * (derivado do cabeçalho `## YYYY-MM-DD`). Usado pelo dedup por evento pra
 * saber a distância em dias até a edição corrente.
 */
export function extractPastTitlesWithEdition(
  md: string,
  window: number,
): { title: string; aammdd: string }[] {
  const out: { title: string; aammdd: string }[] = [];
  const sectionRe = /^## \d{4}-\d{2}-\d{2}/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)).slice(0, window);
  for (const section of editionSections) {
    const m = section.match(/^## \d{2}(\d{2})-(\d{2})-(\d{2})[^"]*"([^"]+)"/m);
    if (m) out.push({ title: m[4], aammdd: `${m[1]}${m[2]}${m[3]}` });
  }
  return out;
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
// #9646: theme-entity exige FATO em comum, não só a entidade
//
// `matchesRecentTheme` (acima) descarta o candidato que só CITA a entidade —
// e por substring. Medição da #9646 (6 edições com tmp-dedup-output,
// 260827–261005): 99 itens derrubados, 75 pela "entidade" `agente` (1ª
// palavra da manchete "Agente rebelde invade sistema de governo") — quase
// todos sem relação com aquele fato —, e o desdobramento novo da saga Amodei
// (Guardian "Senate inquiry", 260928) que o editor recolocou à mão.
// A regra nova exige (a) a entidade como PALAVRA inteira e (b) ao menos 1
// termo em comum com o FATO da edição que gerou a entidade (manchete + título
// e summary do D1 em `01-approved.json`). Repetição real (Gemini 4 Argon em
// 261002/261005 vs D1 de 261001) segue barrada: compartilha "gemini", "4"…
// ---------------------------------------------------------------------------

const THEME_FACT_STOPWORDS = new Set([
  // PT
  "de","da","do","das","dos","em","no","na","nos","nas","um","uma","uns","umas",
  "para","pra","por","com","que","se","ao","aos","os","as","é","são","foi","ser",
  "seu","sua","seus","suas","mais","como","sobre","após","entre","sem","mas",
  "não","nao","já","pode","podem","ter","tem","têm","isso","esse","essa","este",
  "esta","ele","ela","eles","elas","quem","onde","quando","qual","the","ia","ai",
  "diz","dizem","novo","nova","novos","novas",
  // EN
  "of","and","to","in","for","on","with","an","is","are","by","at","from","its",
  "it","this","that","after","has","have","be","was","were","will","our","out",
  "new","can","not","but","you","your","more","into","over","than","their","they",
  "about","how","what","why","who","now",
]);

/** Texto pronto pra comparar: entidades HTML decodificadas, NFC, minúsculo. */
function normalizeThemeText(text: string): string {
  return decodeHtmlEntities(text).normalize("NFC").toLowerCase();
}

const NUMERIC_TOKEN = /^\p{N}+$/u;

/**
 * #9646: tokens de conteúdo (≥3 letras, ou número de qualquer tamanho).
 * Entidades HTML (`&ccedil;`, `&#8230;`) são decodificadas antes — senão
 * viram tokens espúrios ("ccedil", "8230") que corroboram o fato à toa.
 */
export function themeFactTokens(text: string): Set<string> {
  const out = new Set<string>();
  const normalized = normalizeThemeText(text);
  for (const w of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (THEME_FACT_STOPWORDS.has(w)) continue;
    if (w.length >= 3 || NUMERIC_TOKEN.test(w)) out.add(w);
  }
  return out;
}

/** Palavra inteira, aceitando plural regular (`agente` ↔ `agentes`). */
export function containsWholeWord(hay: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?:e?s)?(?![\\p{L}\\p{N}])`, "u").test(hay);
}

/**
 * #9660: variante de `matchesRecentTheme` com a entidade como PALAVRA inteira
 * (mesmo `containsWholeWord` + decodificação de entidades HTML da #9646;
 * hífen e ponto delimitam/escapam como lá). Sem o filtro de fato — é o que o
 * check de tema repetido do gate (warning-only) usa.
 */
export function matchesRecentThemeWholeWord(
  title: string,
  summary: string,
  pastEntities: Set<string>,
): string | null {
  const hay = normalizeThemeText(`${title} ${summary}`);
  for (const rawEntity of pastEntities) {
    const entity = normalizeThemeText(rawEntity);
    if (entity.length < 5) continue;
    if (GENERIC_THEME_WORDS.has(entity)) continue;
    if (containsWholeWord(hay, entity)) return rawEntity;
  }
  return null;
}

/** Destaque passado (subset de `PastDestaqueTitle`) usado como fato do tema. */
export interface ThemeFactDestaque {
  aammdd: string;
  title: string;
  summary?: string;
}

/**
 * #9646: entidade de tema (lowercased) → texto do FATO das edições que a
 * geraram: manchete da edição + título/summary do D1 (`highlights[0]` do
 * `01-approved.json`, quando `destaques` traz a edição). Mesma janela e mesma
 * extração de entidades de `extractPastThemeEntities`.
 */
export function extractPastThemeFacts(
  md: string,
  window: number,
  destaques: ThemeFactDestaque[] = [],
): Map<string, string> {
  const d1ByEdition = new Map<string, ThemeFactDestaque>();
  for (const d of destaques) {
    if (!d1ByEdition.has(d.aammdd)) d1ByEdition.set(d.aammdd, d); // 1º = D1
  }
  const facts = new Map<string, string>();
  const sectionRe = /^## \d{4}-\d{2}-\d{2}/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)).slice(0, window);
  for (const section of editionSections) {
    const themeStart = section.indexOf("Temas cobertos:");
    if (themeStart < 0) continue;
    const head = section.match(/^## \d{2}(\d{2})-(\d{2})-(\d{2})[^"\n]*(?:"([^"]+)")?/m);
    const aammdd = head ? `${head[1]}${head[2]}${head[3]}` : "";
    const d1 = d1ByEdition.get(aammdd);
    const factText = [head?.[4] ?? "", d1?.title ?? "", d1?.summary ?? ""].join(" ").trim();
    for (const line of section.slice(themeStart).split("\n")) {
      const m = line.match(/^-\s+(.+)/);
      if (!m) continue;
      const entity = m[1].trim().toLowerCase();
      const prev = facts.get(entity);
      facts.set(entity, prev ? `${prev} ${factText}` : factText);
    }
  }
  return facts;
}

export interface ThemeFactMatch {
  entity: string;
  /** Termos do candidato que também estão no fato passado (além da entidade). */
  sharedTerms: string[];
}

/**
 * #9646: como `matchesRecentTheme`, mas só casa quando o candidato (a) tem a
 * entidade como palavra inteira (plural regular incluso) e (b) divide ≥1
 * termo de conteúdo com o fato da edição que gerou a entidade. Mesmo filtro
 * de entidade curta/genérica.
 */
export function matchesRecentThemeFact(
  title: string,
  summary: string,
  pastFacts: Map<string, string>,
): ThemeFactMatch | null {
  const hay = normalizeThemeText(`${title} ${summary}`);
  let candTokens: Set<string> | null = null;
  for (const [rawEntity, factText] of pastFacts) {
    const entity = normalizeThemeText(rawEntity);
    if (entity.length < 5) continue;
    if (GENERIC_THEME_WORDS.has(entity)) continue;
    if (!containsWholeWord(hay, entity)) continue;
    candTokens ??= themeFactTokens(hay);
    const factTokens = themeFactTokens(factText);
    const entityParts = [...themeFactTokens(entity), entity];
    const shared = [...candTokens].filter(
      (t) => factTokens.has(t) && !isEntityFamily(t, entityParts),
    );
    // Número curto/ano ("4", "2026") só corrobora junto com termo não-numérico.
    if (shared.some((t) => !NUMERIC_TOKEN.test(t))) return { entity, sharedTerms: shared };
  }
  return null;
}

/**
 * #9646: o termo é a própria entidade (ou pedaço dela, p/ "gpt-5" → "gpt",
 * "5"), um plural/derivado dela ("agentes") ou o cognato que ela estende
 * ("agent" ⊂ "agente", D1 em inglês). Família da entidade não é fato em
 * comum — contar isso reintroduz o "só cita a entidade" que a #9646 tirou.
 */
function isEntityFamily(token: string, entityParts: string[]): boolean {
  for (const part of entityParts) {
    if (token === part) return true;
    if (NUMERIC_TOKEN.test(part)) continue;
    if (part.length >= 4 && token.startsWith(part)) return true;
    if (token.length >= 4 && part.startsWith(token)) return true;
  }
  return false;
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
  summary?: unknown;
  article?: { url?: string; title?: string; summary?: unknown };
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

export function readApprovedTitles(approvedPath: string): string[] {
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
 *
 * #2463/#3025: recebe o diretório REAL da edição (já resolvido, flat ou nested)
 * em vez de `editionsDir` + `name` — chamador resolve via `enumerateEditionDirs`.
 */
function hasEditionArtifact(editionDir: string): boolean {
  return [
    resolve(editionDir, "02-reviewed.md"),
    resolve(editionDir, "_internal", "newsletter-final.html"),
    resolve(editionDir, "_internal", "01-approved.json"),
    resolve(editionDir, "01-approved.json"),
  ].some((p) => existsSync(p));
}

/**
 * As `window` edições REAIS mais recentes em `editionsDir` (ordem decrescente),
 * anteriores a `currentAammdd` (a corrente e as posteriores ficam fora), dirs com nome inválido (ex: `260999`) e dirs sem
 * artefato de edição (markers de teste). Centraliza a seleção de janela usada
 * pelo dedup contra past-editions locais — antes o filtro `/^\d{6}$/` sozinho
 * deixava um dir sintético poluir a janela de 3 edições (#1567 audit).
 *
 * #2463/#3025: enumera AMBOS os layouts (flat legado + nested novo) via
 * `enumerateEditionDirs` — antes `readdirSync(editionsDir)` só via top-level
 * perdia edições no layout nested pós-#3023.
 */
export function recentEditionDirs(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
  // #9955: com `withinDays` E `currentAammdd`, a janela é por data
  // (`currentAammdd - withinDays <= d < currentAammdd`) em vez de contagem.
  withinDays?: number,
): string[] {
  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);
  let dirs = [...editionDirsByAammdd.keys()].filter(
    (d) => isValidEditionDir(d) && hasEditionArtifact(editionDirsByAammdd.get(d)!),
  );
  dirs.sort().reverse();
  // Só edições ANTERIORES à corrente (#9100 review): `!==` deixava passar as
  // POSTERIORES — rerun/replay de uma edição antiga deduplicava contra URLs de
  // edições futuras.
  if (currentAammdd) dirs = dirs.filter((d) => d < currentAammdd);
  if (withinDays !== undefined && currentAammdd) {
    const cutoff = cutoffAammdd(currentAammdd, withinDays);
    if (cutoff) return dirs.filter((d) => d >= cutoff);
  }
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
 *
 * #2463/#3025: aceita tanto `editions/{AAMMDD}/` (flat legado) quanto
 * `editions/{AAMM}/{AAMMDD}/` (nested novo) — o grupo `{AAMM}/` opcional
 * absorve o prefixo de mês do layout nested antes do AAMMDD capturado.
 */
export function deriveCurrentEdition(...paths: Array<string | undefined>): string | undefined {
  for (const p of paths) {
    if (!p) continue;
    const m = p.replace(/\\/g, "/").match(/(?:^|\/)editions\/(?:\d{4}\/)?(\d{6})(?:\/|$)/);
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
  // #9955: janela por data (ver `recentEditionDirs`); sem `currentAammdd`
  // cai na contagem `window`.
  withinDays?: number,
): Set<string> {
  if (!existsSync(editionsDir)) return new Set();
  const recent = recentEditionDirs(editionsDir, window, currentAammdd, withinDays);
  // #2463/#3025: resolve o path REAL (flat ou nested) de cada aammdd — nunca
  // `resolve(editionsDir, aammdd, ...)`, que assume flat.
  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);

  const urls = new Set<string>();
  for (const aammdd of recent) {
    const editionDir = editionDirsByAammdd.get(aammdd);
    if (!editionDir) continue;
    // #1452 hierarchy: MD final > HTML final > approved.json (legacy fallback).
    // Razão: 02-reviewed.md reflete edições pós-Stage-1 (title-picker, dedup
    // cleanup, Drive sync) que approved.json não captura — caso 260520 onde
    // approved.json tinha D1=Karpathy mas o publicado tinha D1=Gemini 3.5.
    const reviewedPath = resolve(editionDir, "02-reviewed.md");
    const htmlPath = resolve(editionDir, "_internal", "newsletter-final.html");
    const approvedCandidates = [
      resolve(editionDir, "_internal", "01-approved.json"),
      resolve(editionDir, "01-approved.json"),
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
  return [...new Set(extractPastEditionArticleTitlesWithEdition(editionsDir, window, currentAammdd).map((e) => e.title))];
}

/**
 * #8666: como `extractPastEditionArticleTitles`, mas com o AAMMDD da edição de
 * cada título (mesmo título em 2 edições aparece 2x — o consumidor escolhe a
 * mais próxima). Ordem: edição mais recente primeiro.
 */
export function extractPastEditionArticleTitlesWithEdition(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
): { title: string; aammdd: string }[] {
  if (!existsSync(editionsDir)) return [];
  const recent = recentEditionDirs(editionsDir, window, currentAammdd);
  // #2463/#3025: resolve o path REAL (flat ou nested) de cada aammdd.
  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);

  const titles: { title: string; aammdd: string }[] = [];
  for (const aammdd of recent) {
    const editionDir = editionDirsByAammdd.get(aammdd);
    if (!editionDir) continue;
    const candidates = [
      resolve(editionDir, "_internal", "01-approved.json"),
      resolve(editionDir, "01-approved.json"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      for (const t of readApprovedTitles(path)) titles.push({ title: t, aammdd });
      break; // primeiro arquivo encontrado = source-of-truth da edição
    }
  }
  return [...titles];
}

export interface PastDestaqueTitle {
  title: string;
  aammdd: string;
  url?: string;
  /** #9595: resumo do destaque (sinal de MESMO FATO por cifras). */
  summary?: string;
}

/**
 * Pure (#8896): lê título + AAMMDD de cada item de `highlights[]` (D1/D2/D3,
 * nunca `runners_up[]`/buckets) do `01-approved.json` das últimas `window`
 * edições REAIS salvas localmente em `editionsDir`.
 *
 * Diferença pra `extractPastEditionArticleTitles`: aquele agrega título de
 * TODO bucket (highlights + runners_up + lancamento/radar/use_melhor/video),
 * útil pro dedup "subject-level" contra qualquer artigo já coberto. Este é
 * restrito a `highlights[]` — o conjunto pequeno (≤3 por edição, ≤9 na janela
 * default) que `check-highlight-themes.ts` (`findCrossSourceMatch`, #8896/
 * #8951) usa pra comparar candidato × DESTAQUE recente, sem o ruído de
 * comparar contra todo o pool secundário.
 *
 * Mesma ressalva de `extractPastEditionArticleTitles`: `01-approved.json` é o
 * snapshot do momento do gate-apply do Stage 1 — não reflete swap/title-picker
 * pós-gate. Aceitável para um check warning-only (nunca bloqueia).
 */
export function extractPastDestaqueTitles(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
): PastDestaqueTitle[] {
  if (!existsSync(editionsDir)) return [];
  const recent = recentEditionDirs(editionsDir, window, currentAammdd);
  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);

  const out: PastDestaqueTitle[] = [];
  for (const aammdd of recent) {
    const editionDir = editionDirsByAammdd.get(aammdd);
    if (!editionDir) continue;
    const candidates = [
      resolve(editionDir, "_internal", "01-approved.json"),
      resolve(editionDir, "01-approved.json"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      let parsed: ApprovedJsonShape;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8")) as ApprovedJsonShape;
      } catch {
        break;
      }
      for (const item of parsed.highlights ?? []) {
        const t = item?.article?.title ?? item?.title;
        const u = item?.url ?? item?.article?.url;
        const sm = item?.article?.summary ?? item?.summary;
        if (t && typeof t === "string" && t.trim()) {
          out.push({
            title: t.trim(),
            aammdd,
            url: typeof u === "string" ? u : undefined,
            ...(typeof sm === "string" && sm.trim() ? { summary: sm.trim() } : {}),
          });
        }
      }
      break; // primeiro arquivo encontrado = source-of-truth da edição
    }
  }
  return out;
}
