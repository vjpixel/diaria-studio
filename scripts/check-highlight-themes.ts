/**
 * check-highlight-themes.ts (#2073, #2652)
 *
 * Compara os candidatos a destaque da edição corrente contra os TÍTULOS
 * DE DESTAQUE das últimas ~12 edições em `data/past-editions.md`.
 *
 * Problema reportado (#2073): o dedup URL+Jaccard tem janela curta (3 edições).
 * Uma URL inédita de tema repetido 7 edições atrás passa por todas as guards
 * de dedup, mas o editor reconhece o repeat visualmente. Este script detecta
 * o padrão e emite aviso destacado no gate da Etapa 1 — sem demotion automática.
 *
 * #2652: extensão para itens SECUNDÁRIOS (RADAR/LANÇAMENTOS). Detecta repetição
 * de empresa+sub-tema nos buckets secundários usando janela de 10 edições e
 * comparando contra 01-approved.json das edições anteriores. Caso real:
 * Nubank×contratações em 260626 e 260629 (mesma empresa, mesmo sub-tema).
 *
 * Algoritmo para DESTAQUES (dois passes):
 *   1. Jaccard de tokens normalizados entre título do candidato e título de
 *      edição passada (threshold >= 0.35 — mais permissivo que o dedup-vs-artigos
 *      de 0.6 porque compara headline-vs-headline, não artigo-vs-artigo).
 *   2. Entity overlap: se candidato e edição passada compartilham ≥1 entidade
 *      nomeada (capitalized token ≥4 chars, exceto stopwords), abaixar threshold
 *      pra 0.25 (mesmo evento com vocabulário divergente).
 *
 * Algoritmo para SECUNDÁRIOS (#2652, dois sinais obrigatórios):
 *   1. Entity overlap (incluindo 1ª palavra — empresas costumam estar no início):
 *      ≥1 entidade em comum (stopwords mais permissivos que o check de destaques).
 *   2. Tema em comum: Jaccard ≥ 0.15 OU sobreposição de prefixo ≥6 chars
 *      (pega variantes morfológicas PT-BR: contratar/contratações → "contrat").
 *
 * Falso-positivo guard: mesmo com entity overlap, títulos com entidades muito
 * genéricas (empresa + produto novo, ex: "Google lança X" vs "Google demite 100")
 * precisam de tema em comum. Para isso, o threshold nunca cai abaixo de 0.25
 * e o match de entidade exige que a entidade NÃO esteja em ENTITY_STOPWORDS.
 *
 * Uso (via orchestrator — não chamado diretamente):
 *   npx tsx scripts/check-highlight-themes.ts \
 *     --categorized data/editions/260611/_internal/01-categorized.json \
 *     --past-editions data/past-editions.md \
 *     [--window 12] \
 *     [--editions-dir data/editions] \
 *     [--secondary-window 10] \
 *     [--current-edition 260611] \
 *     [--out-json data/editions/260611/_internal/01-highlight-theme-check.json]
 *
 * Output JSON (stdout quando --out-json não passado):
 *   {
 *     "warnings": [...],           // destaques candidatos (destaque vs headline histórico)
 *     "secondary_warnings": [...], // RADAR/LANÇAMENTOS (#2652)
 *     "checked": 6,
 *     "secondary_checked": 12,
 *     "window": 12,
 *     "secondary_editions_with_data": 8,  // #2684 item 4: edições distintas do histórico com itens (renomeado de secondary_window)
 *     "secondary_window_requested": 10    // #2684 item 4: janela nominal solicitada (--secondary-window)
 *   }
 *
 * Exit codes:
 *   0 — sempre (warnings são non-fatal — gate decide)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runMain } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  tokenizeForJaccard,
  jaccardSimilarity,
  extractNamedEntities,
  recentEditionDirs,
  deriveCurrentEdition,
} from "./dedup.ts";
import { canonicalize } from "./lib/url-utils.ts"; // #2684 item 5: dedup cross-bucket highlight↔secundário
import { enumerateEditionDirs } from "./lib/find-current-edition.ts"; // #2463/#3025: layout flat+nested (#3055)
// #2716 item 1: importa a lista canônica de buckets secundários em vez de
// hardcodar uma cópia local — SECONDARY_BUCKETS de check-secondary-themes.ts é a
// fonte única (dedup-intra-edition.ts e check-intra-themes.ts já a consomem do
// mesmo lugar). Ver nota "Consolidação parcial" mais abaixo, junto de
// DEFAULT_SECONDARY_BUCKETS, para o que NÃO foi consolidado nesta passada.
import { SECONDARY_BUCKETS } from "./check-secondary-themes.ts";
// #2834: CategorizedJson/Highlight local consolidado no reader canônico.
import type { CategorizedJson } from "./lib/types/categorized-json.ts";

// ---------------------------------------------------------------------------
// Entity stopwords — entidades tão genéricas que não discriminam tema
// (ex: "Google" sozinho não confirma que o tema é o mesmo — Google lança
// coisas novas todo dia). Compartilhadas com dedup.ts via re-export.
// ---------------------------------------------------------------------------

// Termos genéricos para o check de tema highlights.
// Mais conservador que GENERIC_DEDUP_WORDS — permite detectar produtos
// específicos (Gemma, GPT-4o) mas bloqueia empresas e plataformas genéricas.
const ENTITY_STOPWORDS_HIGHLIGHT = new Set([
  // Empresas grandes (muito frequentes em headlines de IA)
  "google", "microsoft", "apple", "amazon", "meta", "nvidia", "openai",
  "anthropic", "deepmind", "deepseek", "mistral", "cohere",
  // Plataformas e assistentes genéricos
  "gemini", "chatgpt", "claude", "copilot", "grok", "perplexity",
  "codex", "cursor", "alexa", "siri",
  // Palavras de domínio muito comuns
  "modelo", "model", "agent", "agente", "plugin", "api", "sdk",
  // PT-BR muito comuns
  "regulacao", "mercado", "brasil", "lanca", "novo", "nova", "vers",
  // EN muito comuns
  "launch", "new", "update", "next", "first", "best",
]);

// ---------------------------------------------------------------------------
// Past-editions parser (local, leve — não importar dedup inteiro)
// ---------------------------------------------------------------------------

export interface PastEditionEntry {
  date: string;    // YYYY-MM-DD
  title: string;   // título da edição (do header ## YYYY-MM-DD — "...")
}

/**
 * Extrai os títulos de destaque das últimas `window` edições de `past-editions.md`.
 * Cada edição tem 1 título (o headline do destaque principal) no header.
 */
export function extractPastEditionTitles(
  md: string,
  window: number,
): PastEditionEntry[] {
  const entries: PastEditionEntry[] = [];
  if (!md.trim()) return entries;

  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  // Captura até a ÚLTIMA aspas da linha para suportar títulos com aspas internas
  // Ex: ## 2026-06-10 — "O modelo "melhor" do mercado" → captura 'O modelo "melhor" do mercado'
  // \r? antes do $ para tolerância CRLF (hardening de portabilidade Windows).
  const sectionRe = /^## (\d{4}-\d{2}-\d{2})[^"]*"(.+)"\r?$/m;

  for (const part of parts) {
    if (entries.length >= window) break;
    const m = part.match(sectionRe);
    if (!m) continue;
    entries.push({ date: m[1], title: m[2] });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Candidate highlight extractor
// ---------------------------------------------------------------------------

interface HighlightCandidate {
  rank: number;
  title: string;
  url: string;
}

export function extractHighlightCandidates(
  categorizedPath: string,
): HighlightCandidate[] {
  if (!existsSync(categorizedPath)) return [];
  let data: CategorizedJson;
  try {
    data = JSON.parse(readFileSync(categorizedPath, "utf8")) as CategorizedJson;
  } catch {
    return [];
  }
  const highlights = data.highlights ?? [];
  return highlights
    .map((h, idx) => {
      const art = h.article ?? {};
      const title = art.title ?? h.title ?? "";
      const url = art.url ?? h.url ?? "";
      const rank = h.rank ?? idx + 1;
      return { rank, title: title.trim(), url: url.trim() };
    })
    .filter((h) => h.title.length > 0);
}

// ---------------------------------------------------------------------------
// Core matching logic (highlights)
// ---------------------------------------------------------------------------

export const DEFAULT_HIGHLIGHT_WINDOW = 12;
const JACCARD_THRESHOLD = 0.35;
const JACCARD_THRESHOLD_WITH_ENTITY = 0.25;

/**
 * Converte data ISO (YYYY-MM-DD, formato de `past-editions.md`) para AAMMDD
 * (formato canônico de diretório de edição, `data/editions/{AAMMDD}/`).
 *
 * #2684 item 3: antes `HighlightThemeWarning.matched_edition` saía em
 * YYYY-MM-DD (ex: "2026-06-04") enquanto `SecondaryThemeWarning.matched_edition`
 * (mais abaixo neste arquivo) já saía em AAMMDD (ex: "260626" — vem direto do
 * nome do diretório da edição, sem conversão). O gate do Stage 1 mostra os
 * dois lado a lado (ver orchestrator-stage-1-research.md) — formato misto
 * confundia o editor. Padronizado em AAMMDD (formato canônico do repo).
 *
 * @param iso Data no formato YYYY-MM-DD.
 * @returns AAMMDD, ou `iso` inalterado se não bater o formato esperado
 *   (defensivo — nunca deveria acontecer, `sectionRe` já valida o formato).
 */
export function isoDateToAammdd(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[1].slice(2)}${m[2]}${m[3]}`;
}

export interface HighlightThemeWarning {
  candidate_rank: number;
  candidate_title: string;
  candidate_url: string;
  /** AAMMDD (#2684 item 3 — antes YYYY-MM-DD, agora padronizado com secondary_warnings). */
  matched_edition: string;
  matched_title: string;
  jaccard: number;
  shared_entities: string[];
  effective_threshold: number;
}

export interface CheckHighlightThemesResult {
  warnings: HighlightThemeWarning[];
  checked: number;
  window: number;
}

/**
 * Extrai entidades nomeadas discriminantes de um título.
 * Usa extractNamedEntities de dedup.ts + filtra pelo stopwords específico
 * de highlights (mais conservador que o dedup geral).
 */
function extractHighlightEntities(title: string): Set<string> {
  // Start from dedup.ts named entities (non-sentence-start capitalized words ≥4 chars)
  const raw = extractNamedEntities(title);
  // Filter using the conservative highlight stopwords
  const result = new Set<string>();
  for (const e of raw) {
    if (!ENTITY_STOPWORDS_HIGHLIGHT.has(e)) result.add(e);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pre-computed index for past editions (tokens + entities computed once)
// ---------------------------------------------------------------------------

interface PastEditionIndex {
  entry: PastEditionEntry;
  tokens: Set<string>;
  entities: Set<string>;
}

/**
 * Pré-computa tokens e entidades de cada edição passada UMA vez.
 * Evita recomputar janela × candidatos (padrão de dedup.ts ~900).
 */
function buildPastIndex(pastEditions: PastEditionEntry[]): PastEditionIndex[] {
  return pastEditions
    .map((entry) => ({
      entry,
      tokens: tokenizeForJaccard(entry.title),
      entities: extractHighlightEntities(entry.title),
    }))
    .filter((idx) => idx.tokens.size > 0);
}

/**
 * Compara um candidato a destaque contra o índice pré-computado de edições passadas.
 * Retorna o melhor match (se acima do threshold) ou null.
 */
function findThemeMatch(
  candidate: HighlightCandidate,
  pastIndex: PastEditionIndex[],
): HighlightThemeWarning | null {
  const candidateTokens = tokenizeForJaccard(candidate.title);
  if (candidateTokens.size === 0) return null;

  const candidateEntities = extractHighlightEntities(candidate.title);

  let bestMatch: HighlightThemeWarning | null = null;

  for (const { entry: past, tokens: pastTokens, entities: pastEntities } of pastIndex) {
    // Compute shared entities
    const sharedEntities: string[] = [];
    for (const e of candidateEntities) {
      if (pastEntities.has(e)) sharedEntities.push(e);
    }

    // Determine effective threshold
    const effectiveThreshold = sharedEntities.length > 0
      ? JACCARD_THRESHOLD_WITH_ENTITY
      : JACCARD_THRESHOLD;

    const jaccard = jaccardSimilarity(candidateTokens, pastTokens);

    if (jaccard >= effectiveThreshold) {
      if (bestMatch === null || jaccard > bestMatch.jaccard) {
        bestMatch = {
          candidate_rank: candidate.rank,
          candidate_title: candidate.title,
          candidate_url: candidate.url,
          matched_edition: isoDateToAammdd(past.date),
          matched_title: past.title,
          jaccard: Math.round(jaccard * 100) / 100,
          shared_entities: sharedEntities,
          effective_threshold: effectiveThreshold,
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Checks all highlight candidates for theme repeats against past editions.
 * Main exported function — also used directly by tests.
 */
export function checkHighlightThemes(
  candidates: HighlightCandidate[],
  pastEditions: PastEditionEntry[],
): CheckHighlightThemesResult {
  const warnings: HighlightThemeWarning[] = [];

  // Pré-computar tokens/entidades das edições passadas uma única vez
  const pastIndex = buildPastIndex(pastEditions);

  for (const candidate of candidates) {
    const match = findThemeMatch(candidate, pastIndex);
    if (match) warnings.push(match);
  }

  return {
    warnings,
    checked: candidates.length,
    window: pastEditions.length,
  };
}

// ---------------------------------------------------------------------------
// Secondary bucket theme check (#2652)
//
// Detecta itens RADAR/LANÇAMENTOS da edição corrente que repetem uma
// combinação empresa+sub-tema de itens dos mesmos buckets nas últimas N edições.
//
// Diferenças do check de destaques:
//   1. Fonte de dados: lê radar/lancamento dos 01-approved.json das edições
//      anteriores (não dos headlines de past-editions.md).
//   2. Extração de entidades: inclui a 1ª palavra (empresas costumam ser
//      sujeito em headlines de RADAR: "Nubank prioriza..."). Stopwords mais
//      permissivos — só filtra termos ultra-genéricos do domínio IA.
//   3. Sobreposição de tema: Jaccard ≥ SECONDARY_JACCARD_THRESHOLD OU
//      sobreposição de prefixo ≥ SECONDARY_PREFIX_MIN_LEN (captura variantes
//      morfológicas PT-BR: contratar/contratações → prefixo "contra").
//   4. Janela: DEFAULT_SECONDARY_WINDOW = 10 (maior que o dedup de 3-4).
//
// WARN-ONLY — nunca bloqueia o gate. (#633 test required)
// ---------------------------------------------------------------------------

/** Comprimento mínimo de entidade para check secundário (vs 4 no check de highlights).
 * 5 chars filtra palavras curtas comuns como "meta" (em PT = meta/objetivo) E
 * os acrônimos ubíquos do domínio IA ("IA", "AI", "ML", "LLM", "GPT" — todos
 * ≤3 chars) que aparecem em quase toda headline de RADAR e não discriminam
 * tema. Mantém nomes de empresas (Google, Nubank, OpenAI — todos ≥5 chars)
 * como entidades válidas.
 *
 * #2684 item 1: havia um `ENTITY_STOPWORDS_SECONDARY` separado ({ia, ai, ml,
 * llm, gpt}) pra filtrar esses mesmos acrônimos — DEAD CODE, porque todo termo
 * do set tem <5 chars e já era removido pelo filtro `SECONDARY_ENTITY_MIN_LEN`
 * ANTES do lookup no stopword set rodar (a ordem no loop de
 * `extractSecondaryEntities` é: length-filter primeiro, stopword-check depois
 * — nunca sobrava nada pro segundo filtro avaliar). Removido em vez de
 * "consertado" pra rodar antes do length-filter: isso mudaria o comportamento
 * (filtrar nomes de empresa curtos tb, não só acrônimos) sem necessidade —
 * `SECONDARY_ENTITY_MIN_LEN` já cobre 100% dos termos que o set intencionava
 * filtrar.
 */
const SECONDARY_ENTITY_MIN_LEN = 5;

/** Janela padrão de edições para check de itens secundários (#2652). */
export const DEFAULT_SECONDARY_WINDOW = 10;

/**
 * Jaccard mínimo para sinalizar repeat de tema em item secundário.
 * Mais baixo que o check de destaques (0.35) porque também exigimos entity match —
 * o requisito duplo (entidade + tema) compensa o threshold mais permissivo.
 */
const SECONDARY_JACCARD_THRESHOLD = 0.15;

/**
 * Comprimento mínimo de prefixo para match morfológico PT-BR.
 * 6 chars captura variantes que compartilham o radical nos 6 primeiros chars:
 *   contratar/contratações → "contra", investir/investimento → "invest".
 * NÃO captura pares cujo radical diverge antes do 6º char (ex: demitir="demiti"
 * vs demissão="demiss") — esses dependem do sinal Jaccard.
 */
const SECONDARY_PREFIX_MIN_LEN = 6;

/**
 * Shape cru (parcial) de um item de bucket em 01-categorized.json / 01-approved.json.
 * Suporta `{ title, url }` direto e o wrapper `{ article: { title, url } }`.
 */
interface RawBucketItem {
  url?: string;
  title?: string;
  article?: { url?: string; title?: string };
}
type RawBuckets = Record<string, RawBucketItem[]>;

export interface SecondaryItem {
  bucket: string;  // "radar" | "lancamento" | "use_melhor"
  title: string;
  url: string;
}

export interface PastSecondaryItem {
  edition: string;  // AAMMDD (ex: "260626")
  title: string;
  bucket: string;
}

export interface SecondaryThemeWarning {
  bucket: string;
  item_url: string;
  item_title: string;
  matched_edition: string;
  matched_title: string;
  matched_bucket: string;
  shared_entities: string[];
  theme_evidence: string;  // "jaccard:0.18" ou "prefix:contra (contratar/contratacoes)"
  jaccard: number;
}

export interface CheckSecondaryThemesResult {
  secondary_warnings: SecondaryThemeWarning[];
  secondary_checked: number;
  /**
   * #2684 item 4: renomeado de `secondary_window` (nome enganoso — parecia a
   * janela CONFIGURADA, mas na verdade sempre reportava `distinctEditions.size`
   * derivado de `pastItems`, ou seja, quantas edições DISTINTAS do histórico
   * de fato contribuíram algum item). Pode ser menor que
   * `secondary_window_requested` quando o histórico é curto (bootstrap) ou
   * quando edições no meio da janela não tinham `01-approved.json`.
   */
  secondary_editions_with_data: number;
  /** Janela nominal solicitada (arg `window` de checkSecondaryThemes / `--secondary-window` da CLI / DEFAULT_SECONDARY_WINDOW). #2684 item 4. */
  secondary_window_requested: number;
}

/**
 * Extrai entidades nomeadas incluindo a 1ª palavra (ao contrário de
 * extractNamedEntities de dedup.ts, que pula i=0). Headlines de RADAR
 * frequentemente começam com o nome da empresa ("Nubank prioriza...").
 *
 * Exige ≥ SECONDARY_ENTITY_MIN_LEN — ver docstring da constante pra por que
 * isso já basta pra filtrar os acrônimos ubíquos do domínio (#2684 item 1).
 */
function extractSecondaryEntities(title: string): Set<string> {
  const entities = new Set<string>();
  const words = title.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^\p{L}\p{N}]/gu, "");
    if (clean.length < SECONDARY_ENTITY_MIN_LEN) continue;
    const firstChar = clean.charAt(0);
    if (firstChar !== firstChar.toUpperCase()) continue;
    if (firstChar === firstChar.toLowerCase()) continue; // não é letra
    const normalized = clean
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, ""); // strip combining diacritics (U+0300–U+036F)
    entities.add(normalized);
  }
  return entities;
}

/**
 * Retorna o primeiro par de tokens (a, b) que compartilha um prefixo de ao menos
 * minPrefixLen chars, onde a ≠ b (evita self-match de token idêntico).
 * Captura variantes morfológicas PT-BR: contratar + contratações → prefixo "contra".
 *
 * Returns null quando não há sobreposição.
 */
function findPrefixTokenOverlap(
  tokensA: Set<string>,
  tokensB: Set<string>,
  minPrefixLen: number,
): { tokenA: string; tokenB: string; prefix: string } | null {
  for (const a of tokensA) {
    if (a.length < minPrefixLen) continue;
    const prefA = a.substring(0, minPrefixLen);
    for (const b of tokensB) {
      if (b.length >= minPrefixLen && b.startsWith(prefA) && a !== b) {
        return { tokenA: a, tokenB: b, prefix: prefA };
      }
    }
  }
  return null;
}

/**
 * Buckets secundários cobertos por default pelo check de tema (#2684 item 2).
 * Antes só `radar`+`lancamento` — itens históricos de `use_melhor`/`video`
 * não entravam na janela de comparação, deixando escapar repeat de tema
 * quando o mesmo assunto aparece num bucket diferente entre edições (ex:
 * ferramenta coberta como tutorial numa edição e como radar noutra).
 *
 * #2716 item 1: antes uma cópia local hardcoded (`["radar", "lancamento",
 * "use_melhor", "video"]`) que só *documentava* espelhar `SECONDARY_BUCKETS`
 * de check-secondary-themes.ts sem de fato importar — risco de as duas listas
 * divergirem silenciosamente numa mudança futura. Agora deriva diretamente da
 * constante importada (fonte única, mesma que dedup-intra-edition.ts e
 * check-intra-themes.ts já usam).
 *
 * Consolidação PARCIAL — o que não foi feito nesta passada e por quê:
 *   - `checkSecondaryThemes` / `SecondaryThemeWarning` deste arquivo (definidos
 *     mais abaixo) são uma implementação PARALELA à de check-secondary-themes.ts,
 *     com shape de warning incompatível (`theme_evidence: string` aqui vs
 *     `shared_companies: string[] + match_reason` lá) e algoritmos de matching
 *     diferentes (entity+jaccard/prefix aqui; jaccard/company/stem lá).
 *   - `extractSecondaryEntities` (abaixo) duplica `extractNamedEntities` importado
 *     de dedup.ts com parametrização própria (inclui 1ª palavra, min-len 5,
 *     stopwords permissivos) — não é um alias trivial.
 *   - O `checkSecondaryThemes` de check-secondary-themes.ts (e seu CLI `main()`)
 *     não é invocado por nenhum orchestrator/skill hoje — só `check-highlight-themes.ts`
 *     é chamado em produção (ver orchestrator-stage-1-research.md). O irmão em
 *     check-secondary-themes.ts é, na prática, código morto de produção (mas
 *     testado e com CLI própria) — merge-lo neste arquivo trocaria contratos e
 *     algoritmo sem cobertura de regressão cross-teste; fora do escopo desta
 *     passada de fixes seguros/isolados. Ver #2716 para follow-up de consolidação
 *     completa (decisão de qual algoritmo/shape vira canônico).
 */
export const DEFAULT_SECONDARY_BUCKETS: string[] = [...SECONDARY_BUCKETS];

/**
 * Extrai itens dos buckets secundários do 01-categorized.json atual.
 * Suporta tanto { title, url } direto quanto { article: { title, url } }.
 *
 * @param categorizedPath  Caminho para _internal/01-categorized.json
 * @param buckets          Buckets a extrair (default: DEFAULT_SECONDARY_BUCKETS, #2684 item 2)
 */
export function extractSecondaryItems(
  categorizedPath: string,
  buckets: string[] = DEFAULT_SECONDARY_BUCKETS,
): SecondaryItem[] {
  if (!existsSync(categorizedPath)) return [];
  let data: RawBuckets;
  try {
    data = JSON.parse(readFileSync(categorizedPath, "utf8")) as RawBuckets;
  } catch {
    return [];
  }
  // #2684 item 6: JSON válido mas shape inesperada (root não é objeto — ex:
  // arquivo de versão pré-#2652 com schema totalmente diferente, ou array na
  // raiz) — tratar como "sem dados" em vez de deixar `data[bucket]` explodir.
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];

  // #2684 item 5: `01-categorized.json` é PRÉ-GATE — um artigo escolhido pelo
  // scorer como highlight PERMANECE no array do seu bucket de origem
  // (radar/lancamento/etc; ver finalize-stage1.ts `protectedUrls`, que só
  // isenta highlights do filtro de score/domain-cap, não os remove do
  // bucket). Sem este guard, o mesmo artigo seria avaliado 2x: uma vez pelo
  // check de DESTAQUES (via extractHighlightCandidates lendo `data.highlights`)
  // e outra vez aqui como se ainda estivesse competindo no secundário —
  // podendo gerar um warning "SECUNDÁRIO REPETIDO [radar]" pra um artigo que
  // editorialmente já vai sair como DESTAQUE, confundindo o editor no gate.
  const highlightUrls = new Set<string>();
  const highlightArr = data["highlights"];
  if (Array.isArray(highlightArr)) {
    for (const h of highlightArr) {
      if (h === null || typeof h !== "object") continue;
      const url = (h.article?.url ?? h.url ?? "").trim();
      if (url) highlightUrls.add(canonicalize(url));
    }
  }

  const items: SecondaryItem[] = [];
  for (const bucket of buckets) {
    const arr = data[bucket];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      // #2684 item 6: item pode ser `null`/primitivo em JSON de formato antigo
      // ou corrompido — `null.article` lançaria TypeError e abortaria o check
      // inteiro (não só este item). Skip silencioso do item malformado.
      if (item === null || typeof item !== "object") continue;
      const art = item.article ?? {};
      const title = (art.title ?? item.title ?? "").trim();
      const url = (art.url ?? item.url ?? "").trim();
      if (!title) continue;
      if (url && highlightUrls.has(canonicalize(url))) continue; // #2684 item 5
      items.push({ bucket, title, url });
    }
  }
  return items;
}

/**
 * Lê itens RADAR/LANÇAMENTOS dos 01-approved.json das `window` edições mais
 * recentes em `editionsDir`, excluindo `currentAammdd`.
 *
 * Falha gracioso: arquivo ausente/corrompido → skip silencioso.
 */
export function readPastApprovedSecondary(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
  buckets: string[] = DEFAULT_SECONDARY_BUCKETS,
): PastSecondaryItem[] {
  if (!existsSync(editionsDir)) return [];
  const recent = recentEditionDirs(editionsDir, window, currentAammdd);
  // #2463/#3025 (#3055): resolve o path REAL (flat ou nested) de cada aammdd —
  // nunca `resolve(editionsDir, aammdd, ...)`, que assume flat. Mesmo padrão
  // de check-secondary-themes.ts (extractSecondaryItemsFromEdition).
  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);
  const items: PastSecondaryItem[] = [];

  for (const aammdd of recent) {
    const editionDir = editionDirsByAammdd.get(aammdd);
    if (!editionDir) continue;
    // Tenta _internal/ primeiro (pós-#574), depois root (legado)
    const candidates = [
      resolve(editionDir, "_internal", "01-approved.json"),
      resolve(editionDir, "01-approved.json"),
    ];
    let parsed: RawBuckets | null = null;

    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        // #2684 item 6: 01-approved.json de edição pré-#2652 (ou corrompido)
        // pode ter root não-objeto (array, string, null) — tratar como
        // "sem dados nesta edição" em vez de deixar `parsed[bucket]` explodir
        // mais abaixo (edição legada não deve abortar o resume inteiro).
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        parsed = raw as RawBuckets;
        break;
      } catch {
        continue;
      }
    }
    if (!parsed) continue;

    for (const bucket of buckets) {
      const arr = parsed[bucket];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        // #2684 item 6: item pode ser `null`/primitivo em edição de formato
        // antigo — `null.article` lançaria TypeError. Skip silencioso.
        if (item === null || typeof item !== "object") continue;
        const art = item.article ?? {};
        const title = (art.title ?? item.title ?? "").trim();
        if (title) items.push({ edition: aammdd, title, bucket });
      }
    }
  }
  return items;
}

/**
 * Verifica se itens dos buckets secundários (RADAR/LANÇAMENTOS) da edição corrente
 * repetem uma combinação empresa+sub-tema de itens das edições anteriores.
 *
 * Algoritmo (dois sinais obrigatórios):
 *   1. Entity overlap: ≥1 entidade em comum (inclui 1ª palavra, stopwords permissivos).
 *   2. Tema em comum: Jaccard ≥ SECONDARY_JACCARD_THRESHOLD
 *                     OU sobreposição de prefixo ≥ SECONDARY_PREFIX_MIN_LEN.
 *
 * WARN-ONLY — nunca bloqueia o gate. Exit code sempre 0.
 *
 * @param currentItems     Itens da edição corrente (de extractSecondaryItems)
 * @param pastItems        Itens das edições anteriores (de readPastApprovedSecondary)
 * @param requestedWindow  Janela nominal solicitada (#2684 item 4 — só pra reportar em
 *   `secondary_window_requested`; não afeta o matching, que já opera sobre `pastItems`
 *   pré-filtrado pelo caller). Default DEFAULT_SECONDARY_WINDOW.
 */
export function checkSecondaryThemes(
  currentItems: SecondaryItem[],
  pastItems: PastSecondaryItem[],
  requestedWindow: number = DEFAULT_SECONDARY_WINDOW,
): CheckSecondaryThemesResult {
  const secondary_warnings: SecondaryThemeWarning[] = [];

  // Pré-computar tokens + entidades das edições passadas uma única vez
  interface PastSecondaryIndex {
    item: PastSecondaryItem;
    tokens: Set<string>;
    entities: Set<string>;
  }
  const pastIndex: PastSecondaryIndex[] = pastItems
    .map((item) => ({
      item,
      tokens: tokenizeForJaccard(item.title),
      entities: extractSecondaryEntities(item.title),
    }))
    .filter((idx) => idx.tokens.size > 0);

  for (const current of currentItems) {
    const currentTokens = tokenizeForJaccard(current.title);
    if (currentTokens.size === 0) continue;
    const currentEntities = extractSecondaryEntities(current.title);

    let bestWarning: SecondaryThemeWarning | null = null;
    let bestJaccardRaw = -1; // raw (não-arredondado) p/ comparar best-match sem viés de rounding

    for (const { item: past, tokens: pastTokens, entities: pastEntities } of pastIndex) {
      // Sinal 1: entity overlap obrigatório
      const sharedEntities: string[] = [];
      for (const e of currentEntities) {
        if (pastEntities.has(e)) sharedEntities.push(e);
      }
      if (sharedEntities.length === 0) continue;

      // Sinal 2: tema em comum via Jaccard OU prefix match
      const jaccard = jaccardSimilarity(currentTokens, pastTokens);
      const prefixOverlap = jaccard < SECONDARY_JACCARD_THRESHOLD
        ? findPrefixTokenOverlap(currentTokens, pastTokens, SECONDARY_PREFIX_MIN_LEN)
        : null;

      if (jaccard < SECONDARY_JACCARD_THRESHOLD && prefixOverlap === null) continue;

      const themeEvidence = jaccard >= SECONDARY_JACCARD_THRESHOLD
        ? `jaccard:${Math.round(jaccard * 100) / 100}`
        : `prefix:${prefixOverlap!.prefix} (${prefixOverlap!.tokenA}/${prefixOverlap!.tokenB})`;

      // Manter o melhor match (maior Jaccard) por item corrente. Compara o jaccard
      // RAW (não o campo arredondado) p/ não descartar match marginalmente melhor
      // quando o anterior arredondou pra cima (ex: 0.177 vs stored 0.18).
      if (bestWarning === null || jaccard > bestJaccardRaw) {
        bestJaccardRaw = jaccard;
        bestWarning = {
          bucket: current.bucket,
          item_url: current.url,
          item_title: current.title,
          matched_edition: past.edition,
          matched_title: past.title,
          matched_bucket: past.bucket,
          shared_entities: sharedEntities,
          theme_evidence: themeEvidence,
          jaccard: Math.round(jaccard * 100) / 100,
        };
      }
    }

    if (bestWarning) secondary_warnings.push(bestWarning);
  }

  const distinctEditions = new Set(pastItems.map((p) => p.edition));
  return {
    secondary_warnings,
    secondary_checked: currentItems.length,
    secondary_editions_with_data: distinctEditions.size,
    secondary_window_requested: requestedWindow,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2)).values;

  const categorizedPath = args["categorized"];
  const pastEditionsPath = args["past-editions"] ?? "data/past-editions.md";
  const window = parseInt(args["window"] ?? String(DEFAULT_HIGHLIGHT_WINDOW), 10);
  const outJson = args["out-json"];
  // #2652: secondary check flags
  const editionsDir = args["editions-dir"] ?? "data/editions";
  const secondaryWindow = parseInt(args["secondary-window"] ?? String(DEFAULT_SECONDARY_WINDOW), 10);
  // #2652: fallback p/ deriveCurrentEdition (espelha dedup.ts CLI #1856) — sem isso,
  // re-run/resume onde o 01-approved.json da edição atual já existe inclui a própria
  // edição na janela e gera self-match (Jaccard ~1.0) em todo item secundário.
  const currentEdition = args["current-edition"] ?? deriveCurrentEdition(args["categorized"]);

  if (!categorizedPath) {
    console.error(
      "Uso: check-highlight-themes.ts --categorized <path> [--past-editions <path>] [--window 12] " +
      "[--editions-dir data/editions] [--secondary-window 10] [--current-edition AAMMDD] [--out-json <path>]",
    );
    process.exit(1);
  }

  // Read past editions (graceful if missing — bootstrap / CI)
  let pastMd = "";
  if (existsSync(pastEditionsPath)) {
    pastMd = readFileSync(pastEditionsPath, "utf8");
  } else {
    console.error(
      `[check-highlight-themes] WARN: ${pastEditionsPath} não encontrado — sem histórico, nenhum warn de tema emitido.`,
    );
  }

  const pastEditions = extractPastEditionTitles(pastMd, window);
  const candidates = extractHighlightCandidates(categorizedPath);
  const highlightResult = checkHighlightThemes(candidates, pastEditions);

  if (highlightResult.warnings.length > 0) {
    for (const w of highlightResult.warnings) {
      console.error(
        `[check-highlight-themes] ⚠️  Candidato #${w.candidate_rank} "${w.candidate_title}" repete tema de ${w.matched_edition} "${w.matched_title}" (Jaccard=${w.jaccard}, entities=[${w.shared_entities.join(",")}])`,
      );
    }
  } else {
    console.error(
      `[check-highlight-themes] ✓ ${highlightResult.checked} candidato(s) verificado(s) contra ${highlightResult.window} edição(ões) — nenhum repeat de tema detectado.`,
    );
  }

  // #2652: secondary check
  const secondaryItems = extractSecondaryItems(categorizedPath);
  const pastSecondary = readPastApprovedSecondary(editionsDir, secondaryWindow, currentEdition);
  const secondaryResult = checkSecondaryThemes(secondaryItems, pastSecondary, secondaryWindow);

  if (secondaryResult.secondary_warnings.length > 0) {
    for (const w of secondaryResult.secondary_warnings) {
      // #2684 item 7: item_url incluído no display — sem ele o editor (no gate
      // mobile/Drive) não consegue identificar QUAL item específico é o
      // suspeito quando o título sozinho é ambíguo (título curto/genérico
      // repetido em buckets diferentes).
      console.error(
        `[check-highlight-themes] ⚠️  SECUNDÁRIO [${w.bucket}] "${w.item_title}" (${w.item_url}) repete tema de ${w.matched_edition} "${w.matched_title}" (${w.theme_evidence}, entities=[${w.shared_entities.join(",")}])`,
      );
    }
  } else {
    console.error(
      `[check-highlight-themes] ✓ ${secondaryResult.secondary_checked} item(ns) secundário(s) verificado(s) contra ${secondaryResult.secondary_editions_with_data}/${secondaryResult.secondary_window_requested} edição(ões) com dados na janela — nenhum repeat de tema detectado.`,
    );
  }

  // Combina os dois resultados num único JSON (backward-compatible: novos campos adicionados)
  const combined = {
    warnings: highlightResult.warnings,
    secondary_warnings: secondaryResult.secondary_warnings,
    checked: highlightResult.checked,
    secondary_checked: secondaryResult.secondary_checked,
    window: highlightResult.window,
    // #2684 item 4: secondary_window (nome enganoso) substituído pelos 2 campos abaixo.
    secondary_editions_with_data: secondaryResult.secondary_editions_with_data,
    secondary_window_requested: secondaryResult.secondary_window_requested,
  };

  const json = JSON.stringify(combined, null, 2);
  if (outJson) {
    writeFileSync(resolve(outJson), json, "utf8");
    console.error(`[check-highlight-themes] Wrote ${outJson}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
