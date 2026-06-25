#!/usr/bin/env npx tsx
/**
 * dedup-intra-edition.ts (#2367, #2397)
 *
 * Dedup INTRA-EDIÇÃO: remove itens de buckets secundários (radar, lancamento,
 * use_melhor, video) que cobrem o mesmo evento que um destaque aprovado.
 *
 * `dedup.ts` detecta duplicatas contra edições PASSADAS. Este script detecta
 * duplicatas DENTRO da mesma edição — caso real 260618: D1 "SpaceX compra o
 * Cursor por US$ 60 bilhões" (braziljournal) + RADAR "SpaceX compra Cursor..."
 * (exame) — mesmo evento, URLs diferentes → passou todas as guards existentes.
 *
 * Algoritmo:
 *   1. Para cada destaque nos top-`destaqueCount` de `highlights[]` (por rank),
 *      extrair título canônico. (#2397: usar só os destaques que de fato
 *      renderizarão — top N por rank, não todos os 6 candidatos do scorer.)
 *   2. Para cada item em radar/lancamento/use_melhor/video:
 *      a. Jaccard similarity sobre tokens normalizados (threshold 0.45 — mais
 *         permissivo que dedup.ts pois é intra-edição onde divergência de
 *         vocabulário entre fontes é maior).
 *      b. Entity overlap: ≥2 entidades nomeadas compartilhadas (empresa +
 *         produto / empresa + número / produto + número).
 *         (#2397: usa `extractNamedEntitiesIntra` — variante local que strip
 *         sufixo de veículo "- Publisher" e NÃO pula index-0.)
 *   3. Se match encontrado: remover do bucket secundário (destaque preservado).
 *
 * Uso:
 *   npx tsx scripts/dedup-intra-edition.ts \
 *     --in data/editions/{AAMMDD}/_internal/01-categorized.json \
 *     --out data/editions/{AAMMDD}/_internal/01-categorized.json \
 *     [--destaque-count 3]
 *
 * Input:  JSON com `{ highlights, runners_up?, lancamento, radar, use_melhor, video, ... }`
 *         (output do passo 1u do orchestrator).
 * Output: mesmo JSON com items duplicados removidos dos buckets secundários.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  tokenizeForJaccard,
  jaccardSimilarity,
} from "./dedup.ts";

// ---------------------------------------------------------------------------
// #2397: Extração de entidades LOCAL (não usa extractNamedEntities do dedup.ts)
//
// Dois defeitos do helper compartilhado causavam falsos positivos no contexto
// intra-edição:
//
// 1. Sufixo de veículo tratado como entidade: títulos como
//    "Nubank prepara... - Finsiders Brasil" produzem {finsiders, brasil},
//    que match qualquer outro título "X - Finsiders Brasil" → remoção incorreta.
//
// 2. Skip de index-0 derrubava a 1ª palavra: "SpaceX compra Cursor..." tem
//    SpaceX em index-0 → skip → entities={cursor} → shared=1 < 2 → FP neg.
//
// Fix local: strip " - PublisherSuffix" antes de tokenizar; não pular index-0.
// Preservar o shared `extractNamedEntities` do dedup.ts intacto (cross-edition
// dedup não tem o mesmo problema de sufixo e testa títulos de newsletters, não
// de artigos individuais).
// ---------------------------------------------------------------------------

/**
 * Regex para strip de sufixo de veículo em títulos de artigos.
 * Padrão: " - Finsiders Brasil", " - Exame", " - Brazil Journal", etc.
 * Captura o ÚLTIMO " - " seguido de 1–3 palavras (a primeira capitalizada),
 * ancorado no fim da string.
 *
 * Restrições deliberadas pra evitar over-strip (review #2406):
 *  - O segmento do sufixo NÃO pode conter outro " - " (`(?:(?! - ).)`),
 *    então "Governo - OpenAI e Meta - Exame" só perde "- Exame", não o meio.
 *  - Máximo 3 palavras no nome do veículo (`(?:\s+[\p{L}\p{N}&]+){0,2}`),
 *    cobrindo "Finsiders Brasil", "Brazil Journal", "MIT Technology Review"
 *    sem engolir orações longas tipo "- Por que isso importa demais agora".
 *  - 1ª palavra do sufixo deve começar com maiúscula (`[\p{Lu}]`) — nomes de
 *    veículo são próprios.
 *
 * Exemplos:
 *   "Nubank prepara IA - Finsiders Brasil" → "Nubank prepara IA"
 *   "SpaceX compra Cursor - Exame" → "SpaceX compra Cursor"
 *   "Governo - OpenAI e Meta - Exame" → "Governo - OpenAI e Meta"
 *   "Título sem sufixo" → inalterado
 */
export const VEHICLE_SUFFIX_RE = /\s+-\s+[\p{Lu}][\p{L}\p{N}&]*(?:\s+[\p{L}\p{N}&]+){0,2}\s*$/u;

/** Strip sufixo de veículo de um título de artigo (intra-edition only). */
export function stripVehicleSuffix(title: string): string {
  return title.replace(VEHICLE_SUFFIX_RE, "");
}

/** Termos comuns no domínio IA que NÃO contam como entidade discriminante.
 *  #2406: inclui big-tech de alta frequência (microsoft, google, meta, etc.)
 *  além dos nomes de IA — em edições com 2+ itens da mesma empresa, "Microsoft"
 *  sozinho não deve disparar entity-match entre histórias diferentes (o evento
 *  específico precisa de uma 2ª entidade discriminante). Mantém paridade com o
 *  espírito do GENERIC_THEME_WORDS de dedup.ts. */
const ENTITY_STOPWORDS_INTRA = new Set([
  "ia", "ai", "ml", "llm", "gpt", "chatgpt", "claude", "gemini", "openai",
  "inteligencia", "artificial", "machine", "learning",
  "diaria", "newsletter", "edicao",
  // big-tech de alta frequência — bloquear por nome só não discrimina evento
  "microsoft", "google", "apple", "amazon", "meta", "nvidia",
  "anthropic", "deepmind", "deepseek", "mistral", "cohere",
  "copilot", "alexa", "siri", "grok", "perplexity",
  "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo",
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]);

/**
 * Extrai entidades nomeadas para dedup INTRA-edição.
 *
 * Diferenças vs `extractNamedEntities` do dedup.ts (#2397):
 *  - Strip de sufixo de veículo "- Publisher" antes de tokenizar.
 *    Evita que "Finsiders"/"Brasil" do sufixo virem entidades compartilhadas
 *    por todos os artigos do mesmo veículo.
 *  - NÃO pula index-0. Artigos com empresa no início do título
 *    ("SpaceX compra Cursor") têm a entidade capturada.
 *    Em dedup.ts o skip de index-0 evita capitalizações de início de sentença
 *    em títulos de newsletters; aqui os inputs são títulos de artigos onde
 *    a primeira palavra frequentemente é a entidade principal.
 *
 * Não altera `extractNamedEntities` do dedup.ts (cross-edition dedup).
 */
export function extractNamedEntitiesIntra(title: string): Set<string> {
  const cleaned = stripVehicleSuffix(title);
  const entities = new Set<string>();
  const words = cleaned.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[^\p{L}\p{N}]/gu, "");
    if (word.length < 4) continue;
    // #2397: NÃO pular index-0 — em títulos de artigos a empresa principal
    // frequentemente é a primeira palavra (ex: "SpaceX compra Cursor").
    const firstChar = word.charAt(0);
    if (firstChar !== firstChar.toUpperCase()) continue;
    if (firstChar === firstChar.toLowerCase()) continue;
    const normalized = word
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    if (ENTITY_STOPWORDS_INTRA.has(normalized)) continue;
    entities.add(normalized);
  }
  return entities;
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface Article {
  url: string;
  title?: string;
  /** Domínio oficial sugerido por `enrich-primary-source.ts` (#487).
   *  Ex: "google.com" para RADAR item cobrindo lançamento do Google.
   *  Usado pelo dedup intra-edição (Furo 2, #2548) para detectar cobertura de
   *  imprensa de um lançamento que já aparece como destaque. */
  suggested_primary_domain?: string;
  [key: string]: unknown;
}

interface HighlightEntry {
  url?: string;
  title?: string;
  article?: Article;
  [key: string]: unknown;
}

interface CategorizedWithHighlights {
  highlights?: HighlightEntry[];
  runners_up?: HighlightEntry[];
  lancamento?: Article[];
  radar?: Article[];
  use_melhor?: Article[];
  video?: Article[];
  [key: string]: unknown;
}

export interface IntraEditionDedupResult {
  kept: CategorizedWithHighlights;
  removed: Array<{
    url: string;
    title?: string;
    bucket: string;
    match_type: "jaccard" | "entity" | "domain";
    matched_highlight: string;
    score: number;
  }>;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Threshold Jaccard para dedup intra-edição. Mais permissivo que cross-edition
 * (0.6) porque fontes diferentes cobrem o mesmo evento com vocabulários
 * divergentes (PT vs EN, título longo vs short).
 */
export const INTRA_JACCARD_THRESHOLD = 0.45;

/**
 * Número mínimo de entidades compartilhadas para considerar entity-match.
 * 2 entidades = 1 empresa/produto + 1 numérico/outro, ou 2 entidades nomeadas.
 * Evita falso-positivo de 1 entidade genérica (ex: só "SpaceX" matcharia
 * qualquer notícia de SpaceX do dia, não só o mesmo evento).
 */
export const INTRA_ENTITY_MIN_SHARED = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extrai título canônico de um HighlightEntry (suporta shapes legados). */
export function highlightTitle(h: HighlightEntry): string | null {
  const t = h.title ?? h.article?.title;
  if (t && typeof t === "string") return t;
  return null;
}

/** Extrai URL de um HighlightEntry. */
export function highlightUrl(h: HighlightEntry): string | null {
  const u = h.url ?? h.article?.url;
  if (u && typeof u === "string") return u;
  return null;
}

/**
 * Extrai o registrable domain (eTLD+1) de uma URL, normalizado lowercase.
 * Ex: "https://blog.google.com/foo" → "google.com"
 *     "https://openai.com/research/x" → "openai.com"
 *
 * Usado para comparar `suggested_primary_domain` do artigo RADAR com o
 * domínio da URL do destaque (Furo 2, #2548).
 *
 * Implementação simples (não usa Public Suffix List completa): pega os
 * últimos 2 segmentos do hostname (cobre .com, .net, .org, .io, .ai, etc.).
 * Casos como ".co.uk" ou ".com.br" podem divergir, mas são raros no corpus
 * de fontes oficiais de tech. Falso-negativo nesses casos é aceitável — o
 * dedup só perde um match, não gera falso-positivo.
 */
export function extractRegistrableDomain(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    const parts = hostname.toLowerCase().split(".");
    if (parts.length < 2) return null;
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}

/**
 * #2548 (Furo 2): Retorna true se a URL do destaque pertence ao
 * `suggested_primary_domain` do artigo RADAR.
 *
 * Caso real: RADAR = canaltech.com.br (suggested_primary_domain = "google.com"),
 * D1 = blog.google.com → extractRegistrableDomain("blog.google.com") = "google.com"
 * → match → RADAR é cobertura de imprensa do mesmo lançamento que D1.
 *
 * Só aplica quando o artigo tem `suggested_primary_domain` definido (campo
 * adicionado por `enrich-primary-source.ts` apenas a itens com verbo de
 * lançamento + empresa conhecida no título). Sem esse campo, o check é no-op.
 */
export function isPressCovertageOfHighlight(
  article: Article,
  highlightUrl: string | null,
): boolean {
  const suggestedDomain = article.suggested_primary_domain;
  if (!suggestedDomain || !highlightUrl) return false;

  const hDomain = extractRegistrableDomain(highlightUrl);
  if (!hDomain) return false;

  // suggested_primary_domain já é o domínio registrável (ex: "google.com").
  // Comparar diretamente.
  return hDomain === suggestedDomain.toLowerCase();
}

/**
 * Checa se um artigo é duplicata intra-edição de qualquer destaque.
 *
 * #2397: usa `extractNamedEntitiesIntra` (local) em vez de `extractNamedEntities`
 * do dedup.ts — strip de sufixo de veículo + não pula index-0.
 *
 * #2548 (Furo 2): adiciona check de domínio via `suggested_primary_domain`.
 * Quando um item RADAR tem `suggested_primary_domain` = X (campo adicionado por
 * `enrich-primary-source.ts` para cobertura de imprensa de lançamento), e o
 * destaque tem URL do domínio X, o item é flagrado como cobertura-de-imprensa
 * do mesmo lançamento. Caso real: RADAR canaltech.com.br/google-libera-ia-que...
 * (suggested_primary_domain="google.com") + D1 blog.google.com/gemini-computer-use.
 *
 * @returns match info se duplicata, null caso contrário.
 */
export function isIntraEditionDuplicate(
  article: Article,
  highlights: HighlightEntry[],
  options: {
    jaccardThreshold?: number;
    entityMinShared?: number;
  } = {},
): {
  match_type: "jaccard" | "entity" | "domain";
  matched_highlight: string;
  score: number;
} | null {
  const jThreshold = options.jaccardThreshold ?? INTRA_JACCARD_THRESHOLD;
  const entityMin = options.entityMinShared ?? INTRA_ENTITY_MIN_SHARED;

  const artTitle = article.title;
  if (!artTitle) return null;

  // #2397/#2406: stripVehicleSuffix ANTES de tokenizar para Jaccard também —
  // não só para o entity-check. Sem isso, os tokens do sufixo de veículo
  // ("finsiders", "brasil", "exame", "journal") participam do Jaccard, e dois
  // títulos curtos do mesmo veículo podem cruzar o threshold só pelo sufixo
  // compartilhado (ex: "OpenAI - Brazil Journal" vs "Anthropic - Brazil
  // Journal" → 0.5 ≥ 0.45). Stripping em ambos os lados mantém o sinal Jaccard
  // alinhado com o entity-check.
  const artTokens = tokenizeForJaccard(stripVehicleSuffix(artTitle));
  const artEntities = extractNamedEntitiesIntra(artTitle);

  for (const h of highlights) {
    const hTitle = highlightTitle(h);
    if (!hTitle) continue;

    // Skip exact-same URL (destaque pode aparecer no bucket também — não é intra-dup)
    const hUrl = highlightUrl(h);
    if (hUrl && article.url === hUrl) continue;

    // (c) #2548 Furo 2: domain-based match via suggested_primary_domain.
    // Roda ANTES de Jaccard/entity pois é sinal muito mais preciso: o campo
    // suggested_primary_domain só existe quando enrich-primary-source detectou
    // verbo de lançamento + empresa conhecida no título RADAR. Se o domínio
    // oficial bate com o domínio do destaque, é quase certamente cobertura de
    // imprensa do mesmo evento.
    if (isPressCovertageOfHighlight(article, hUrl ?? null)) {
      return {
        match_type: "domain",
        matched_highlight: hTitle,
        score: 1.0,
      };
    }

    // (a) Jaccard sobre tokens normalizados (sufixo de veículo já stripado)
    const hTokens = tokenizeForJaccard(stripVehicleSuffix(hTitle));
    const jaccard = jaccardSimilarity(artTokens, hTokens);
    if (jaccard >= jThreshold) {
      return {
        match_type: "jaccard",
        matched_highlight: hTitle,
        score: jaccard,
      };
    }

    // (b) Entity overlap: contar entidades compartilhadas
    // #2397: usa variante local que strip sufixo de veículo e não pula index-0
    const hEntities = extractNamedEntitiesIntra(hTitle);
    let sharedCount = 0;
    const sharedNames: string[] = [];
    for (const e of artEntities) {
      if (hEntities.has(e)) {
        sharedCount++;
        sharedNames.push(e);
      }
    }
    if (sharedCount >= entityMin) {
      return {
        match_type: "entity",
        matched_highlight: hTitle,
        score: sharedCount / Math.max(artEntities.size, hEntities.size, 1),
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main dedup function
// ---------------------------------------------------------------------------

const SECONDARY_BUCKETS = ["radar", "lancamento", "use_melhor", "video"] as const;

/**
 * Default number of top highlights to compare against in intra-edition dedup.
 * #2397: scorer returns 6 candidates; editor selects top 3 at Stage 1 gate.
 * Comparing against all 6 removes items that match rank-4..6 candidates
 * (which the editor will NOT promote), causing false removals pre-gate.
 * Default: 3 (standard edition). Can be overridden via --destaque-count N.
 */
export const DEFAULT_INTRA_DESTAQUE_COUNT = 3;

/**
 * Aplica dedup intra-edição ao JSON de categorized.
 * Remove dos buckets secundários itens que duplicam um destaque.
 *
 * #2397: compara contra top-`destaqueCount` highlights por rank (default 3),
 * não contra todos os 6 candidatos do scorer. Evita remoção pré-gate de itens
 * que seriam legítimos se o editor não promover o candidato rank 4–6.
 *
 * Pure function — não muta input.
 */
export function dedupIntraEdition(
  input: CategorizedWithHighlights,
  options: {
    jaccardThreshold?: number;
    entityMinShared?: number;
    /** #2397: quantos highlights (top-N por rank) usar para comparação.
     *  Default: DEFAULT_INTRA_DESTAQUE_COUNT (3). */
    destaqueCount?: number;
  } = {},
): IntraEditionDedupResult {
  const allHighlights = input.highlights ?? [];
  // #2397: limitar aos top-destaqueCount por rank. Highlights do scorer têm
  // campo `rank` (1-based). Ordenar por rank ascendente e pegar top-N.
  const n = options.destaqueCount ?? DEFAULT_INTRA_DESTAQUE_COUNT;
  const highlights = [...allHighlights]
    .sort((a, b) => {
      const ra = typeof a.rank === "number" ? a.rank : 999;
      const rb = typeof b.rank === "number" ? b.rank : 999;
      return ra - rb;
    })
    .slice(0, n);
  const removed: IntraEditionDedupResult["removed"] = [];

  const keptBuckets: Record<string, Article[]> = {};

  for (const bucket of SECONDARY_BUCKETS) {
    const articles = input[bucket] ?? [];
    const bucketKept: Article[] = [];

    for (const article of articles) {
      const match = isIntraEditionDuplicate(article, highlights, options);
      if (match) {
        removed.push({
          url: article.url,
          title: article.title,
          bucket,
          ...match,
        });
      } else {
        bucketKept.push(article);
      }
    }

    keptBuckets[bucket] = bucketKept;
  }

  const kept: CategorizedWithHighlights = {
    ...input,
    ...keptBuckets,
  };

  return { kept, removed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { in: string; out: string; destaqueCount: number } {
  let inPath = "";
  let outPath = "";
  let destaqueCount = DEFAULT_INTRA_DESTAQUE_COUNT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") inPath = argv[++i];
    else if (argv[i] === "--out") outPath = argv[++i];
    else if (argv[i] === "--destaque-count") destaqueCount = parseInt(argv[++i], 10);
  }
  if (!inPath || !outPath) {
    throw new Error("Uso: dedup-intra-edition.ts --in <categorized.json> --out <out.json> [--destaque-count N]");
  }
  if (!Number.isFinite(destaqueCount) || destaqueCount < 1) {
    throw new Error(`--destaque-count deve ser inteiro >= 1, recebido: ${destaqueCount}`);
  }
  return { in: inPath, out: outPath, destaqueCount };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const input: CategorizedWithHighlights = JSON.parse(
    readFileSync(resolve(args.in), "utf8"),
  );

  const highlightCount = input.highlights?.length ?? 0;
  const { kept, removed } = dedupIntraEdition(input, { destaqueCount: args.destaqueCount });

  const totalSecondary = SECONDARY_BUCKETS.reduce(
    (sum, b) => sum + (input[b]?.length ?? 0),
    0,
  );
  const totalKept = SECONDARY_BUCKETS.reduce(
    (sum, b) => sum + (kept[b]?.length ?? 0),
    0,
  );

  process.stderr.write(
    `[dedup-intra-edition] highlights_total=${highlightCount}, destaque_count=${args.destaqueCount}, ` +
    `secondary_input=${totalSecondary}, removed=${removed.length}, secondary_output=${totalKept}\n`,
  );

  if (removed.length > 0) {
    process.stderr.write("[dedup-intra-edition] removed:\n");
    for (const r of removed) {
      process.stderr.write(
        `  [${r.bucket}] ${r.title ?? r.url} — ${r.match_type} (${(r.score * 100).toFixed(0)}%) → "${r.matched_highlight}"\n`,
      );
    }
  }

  writeFileSync(resolve(args.out), JSON.stringify(kept, null, 2), "utf8");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
