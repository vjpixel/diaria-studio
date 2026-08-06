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
 * #3972: gatilho INDEPENDENTE entity-only (janela curta). Casos reais da
 * edição 260724 (mesmo evento coberto por fonte diferente, poucas horas de
 * distância) escaparam dos dois passes acima porque o Jaccard textual ficava
 * abaixo até do threshold rebaixado (0.25) — o entity overlap só abaixava o
 * threshold, nunca disparava por si só. Agora, quando o candidato compartilha
 * ≥2 entidades específicas (`extractEntityOnlyEntities` — inclui a 1ª palavra
 * do título e acrônimos all-caps como "AMD", ao contrário da extração usada
 * no passe 2 acima) com uma edição DENTRO da janela curta
 * (`ENTITY_ONLY_RECENT_WINDOW`, últimas 1-2 edições), o warning dispara
 * mesmo com Jaccard baixo. Guard de falso-positivo: exige 2+ entidades (uma
 * entidade genérica sozinha — "IA", "OpenAI" — nunca basta) e só roda contra
 * o histórico MUITO recente (o risco de coincidência cresce com a distância).
 * Esse gatilho só é usado como FALLBACK — se o algoritmo padrão (passes 1-2)
 * já encontrou um match, ele prevalece (nenhuma mudança de comportamento nos
 * casos que já funcionavam).
 *
 * #4661: terceiro gatilho, ainda mais permissivo — "saga em andamento". Cobre
 * o caso onde o MESMO incidente é destaque várias vezes ao longo de semanas
 * (não dias), cada cobertura enfatizando um fato novo daquela rodada, e a
 * ÚNICA coisa que persiste é a empresa + a categoria do evento (ex:
 * "OpenAI" + "invasão de sistema") — nem 2 entidades específicas nem o mesmo
 * verbo se repetem entre as coberturas, então nem o passe padrão nem o
 * entity-only (#3972, janela curta) pegam. Dispara com só 1 entidade de
 * empresa em comum + vocabulário de incidente/segurança presente em AMBOS os
 * títulos (não precisa ser o mesmo termo), contra a janela INTEIRA (não só
 * as últimas 1-2 edições). A "entidade de empresa" exclui qualquer token que
 * também seja vocabulário de incidente — sem isso a própria palavra de
 * abertura da manchete ("Vazamento...", "Hackers...") contaria como entidade
 * sozinha (ver `excludeIncidentStemEntities`). Ver docstring de
 * `SAGA_MIN_SHARED_ENTITIES`.
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
// #4262: reusa o comparador cross-veículo já calibrado de dedup-intra-edition.ts
// (jaccard/entity/domain/cross_vehicle/product_code + os 2 sinais adicionais de
// `crossEditionMode`) em vez de desenhar um detector novo — ver checkFullBodyThemes.
import { isIntraEditionDuplicate } from "./dedup-intra-edition.ts";

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

/**
 * #3972: stopwords do gatilho entity-only independente.
 *
 * Deliberadamente MENOR que ENTITY_STOPWORDS_HIGHLIGHT — mantém nomes de
 * empresa (google, openai, anthropic, amd, meta...) como entidades válidas.
 * A defesa contra falso-positivo aqui não é filtrar cada entidade genérica
 * individualmente (uma empresa grande sozinha nunca teria bastado de qualquer
 * forma — exigimos 2+ compartilhadas), e sim continuar filtrando os termos
 * que são tão ubíquos que aparecem em quase toda headline de IA e NÃO
 * discriminam evento mesmo em combinação com outro termo: assistentes/
 * produtos genéricos (chatgpt, gemini) e vocabulário de domínio (modelo, ia).
 * Caso real #3972: "AMD" + "Anthropic" juntos identificam o evento (parceria
 * ~2GW de GPUs) mesmo que nenhum dos dois sozinho discrimine — por isso não
 * podem ser stopword aqui, ao contrário do passe 2 (ENTITY_STOPWORDS_HIGHLIGHT).
 */
const ENTITY_ONLY_STOPWORDS = new Set([
  "gemini", "chatgpt", "claude", "copilot", "grok", "perplexity",
  "codex", "cursor", "alexa", "siri",
  "modelo", "model", "agent", "agente", "plugin", "api", "sdk",
  "ia", "ai", "ml", "llm", "gpt",
  "regulacao", "mercado", "brasil", "lanca", "novo", "nova", "vers",
  "launch", "new", "update", "next", "first", "best",
  // Acrônimos/termos curtos ubíquos em manchetes PT-BR que o guard all-caps
  // (ver extractEntityOnlyEntities) passaria a capturar por serem all-caps
  // de 2-3 letras — nenhum discrimina evento.
  "ti", "eua", "ceo", "cfo", "ipo", "pib", "ong", "tv",
]);

/** Janela de edições recentes para o gatilho entity-only independente (#3972). */
export const ENTITY_ONLY_RECENT_WINDOW = 2;

/** Mínimo de entidades específicas compartilhadas para o gatilho entity-only disparar (#3972). */
export const ENTITY_ONLY_MIN_SHARED = 2;

/**
 * #4661: gatilho "saga em andamento" — terceiro nível de fallback, mais amplo
 * que o entity-only (#3972) acima.
 *
 * Problema: uma SAGA (mesmo incidente coberto múltiplas vezes ao longo de
 * semanas, cada cobertura enfatizando um FATO NOVO daquela rodada) escapa
 * tanto do Jaccard textual quanto do entity-only, porque:
 *   1. O Jaccard textual é baixo — cada cobertura usa vocabulário diferente
 *      pro fato novo (plataforma atacada, estágio da investigação).
 *   2. O entity-only (#3972) exige 2+ entidades específicas compartilhadas
 *      E só olha pra janela CURTA (últimas `ENTITY_ONLY_RECENT_WINDOW`
 *      edições) — uma saga se estende por mais tempo que isso, e a única
 *      entidade que persiste entre as coberturas costuma ser 1 (a empresa).
 *
 * Caso real (#4661, edições 260723/260730/260806 — ~2 semanas de distância,
 * todas dentro da janela padrão de 12): o mesmo incidente ("agente da OpenAI
 * escapa de sandbox e invade sistemas reais") foi destaque 3x, cada vez
 * citando OpenAI + um verbo de invasão diferente ("hackeou", "invadiu",
 * "invadiram") — nunca a MESMA entidade extra (Hugging Face só aparece em
 * 2 das 3 coberturas) nem o MESMO verbo exato.
 *
 * Sinal: 1 entidade de empresa em comum (via `extractEntityOnlyEntities` —
 * já inclui nomes de empresa grandes como openai/google/meta, ao contrário
 * do passe 2 que os filtra) + AMBOS os títulos mencionarem vocabulário de
 * incidente/segurança (`INCIDENT_KEYWORD_STEMS` abaixo) — não precisa ser o
 * MESMO termo em ambos, porque o que persiste numa saga é a CATEGORIA do
 * evento ("é um incidente de segurança envolvendo essa empresa"), não o
 * verbo específico usado naquela rodada.
 *
 * Roda contra a janela INTEIRA de `pastIndex` (mesma do algoritmo padrão,
 * default 12 edições) — não limitada à janela curta do entity-only —
 * porque sagas se espalham por mais tempo que 1-2 edições.
 *
 * Risco assumido (falso-positivo): mesma empresa + termo de incidente
 * recorrente para 2 eventos GENUINAMENTE diferentes também dispara. Aceito
 * de propósito — este é o terceiro nível de fallback, sempre WARN-ONLY
 * (nunca bloqueia o gate, nunca remove o candidato); o editor vê o histórico
 * completo (`matched_edition` + `matched_title`) e decide. Preferir avisar
 * de mais a deixar uma saga real passar em silêncio 3x (decisão da issue).
 */
export const SAGA_MIN_SHARED_ENTITIES = 1;

/**
 * Stems (prefixos, lowercase, sem acentos) de vocabulário de incidente/
 * segurança usados pelo gatilho "saga em andamento" (#4661). Prefixo, não
 * palavra exata, pra capturar conjugações PT-BR sem precisar listar cada
 * variante (hackeou/hackear/hackeada → "hacke"; invadiu/invadiram/invasor →
 * "invad"). Deliberadamente restrito a vocabulário de segurança/incidente —
 * não é uma lista genérica de verbos de "evento ruim" (evita capturar
 * "demitiu"/"cortou" etc., que já têm seu próprio vocabulário editorial e
 * não são o padrão de saga que esta issue endereça).
 */
const INCIDENT_KEYWORD_STEMS = [
  "hacke",     // hackeou, hackear, hackeada, hackers
  "invad",     // invadiu, invadiram, invadir, invasor
  "invas",     // invasão, invasoes
  "escap",     // escapou, escapar, escape (sandbox escape)
  "vaz",       // vazou, vazamento, vazaram
  "compromet", // comprometeu, comprometimento
  "sandbox",
  "brecha",
  "explor",    // explorou, exploração, exploit
  "atac",      // atacou, atacar, atacaram — verbal. NÃO cobre "ataque"/"ataques":
               // ortografia PT-BR troca c→qu antes de e/i, então
               // "ataque".startsWith("atac") é FALSE (verificado; o comentário
               // antigo estava errado). Precisa do stem separado abaixo.
  "ataqu",     // ataque, ataques — substantivo, a forma mais comum em
               // manchete de incidente de segurança pt-BR ("Ataque derruba
               // sistema..."); sem este stem o substantivo nunca disparava
               // o gatilho saga (#4661 review, achado 2).
  "violac",    // violação
  "viol",      // violou
  "roub",      // roubou, roubo
  "furt",      // furto, furtou
  "malici",    // malicioso, maliciosamente
  "seguranca", // "falha de segurança", "teste de segurança"
];

/**
 * Extrai os stems de `INCIDENT_KEYWORD_STEMS` presentes num set de tokens já
 * normalizados (saída de `tokenizeForJaccard` — lowercase, sem acentos).
 * Retorna o STEM casado (não o token original), pra permitir comparação de
 * "categoria compartilhada" entre títulos que usam verbos diferentes da
 * mesma família (#4661 — ver docstring de `SAGA_MIN_SHARED_ENTITIES`).
 */
function extractIncidentKeywords(tokens: Set<string>): Set<string> {
  const matched = new Set<string>();
  for (const token of tokens) {
    for (const stem of INCIDENT_KEYWORD_STEMS) {
      if (token.startsWith(stem)) {
        matched.add(stem);
        break;
      }
    }
  }
  return matched;
}

/**
 * #4661 review (achado 1, crítico): remove de um set de entidades qualquer
 * token que TAMBÉM seja vocabulário de incidente (`INCIDENT_KEYWORD_STEMS`).
 *
 * Sem este filtro, o gatilho saga usava `extractEntityOnlyEntities` — que
 * INCLUI a 1ª palavra do título — como fonte da "entidade de empresa em
 * comum". Manchete de incidente pt-BR abre rotineiramente com o próprio
 * substantivo do incidente capitalizado por estar no início da frase
 * ("Vazamento revela...", "Hackers invadem..."), então essa palavra
 * satisfazia OS DOIS sinais (entidade E vocabulário de incidente) sozinha —
 * os dois sinais deixavam de ser independentes e colapsavam numa palavra só.
 * Falso-positivo real reproduzido: "Vazamento revela falha grave em sistema
 * do INSS" × "Vazamento expõe dados de milhões de clientes da Serasa"
 * disparava saga_match com shared_entities=["vazamento"] — INSS e Serasa não
 * têm relação nenhuma, a única coisa em comum é a palavra de abertura.
 *
 * Aplicado SÓ ao gatilho saga (via `sagaEntities`/`candidateSagaEntities`
 * abaixo) — não muda `extractEntityOnlyEntities` em si nem o gatilho
 * entity-only (#3972), que não teve esse bug reportado e já é mais estrito
 * (exige 2+ entidades específicas contra janela curta).
 */
function excludeIncidentStemEntities(entities: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const e of entities) {
    const isIncidentWord = INCIDENT_KEYWORD_STEMS.some((stem) => e.startsWith(stem));
    if (!isIncidentWord) result.add(e);
  }
  return result;
}

/**
 * Extrai entidades para o gatilho entity-only independente (#3972).
 *
 * Diferenças de `extractHighlightEntities` (usada só para abaixar o threshold
 * de Jaccard no passe 2):
 *   - INCLUI a 1ª palavra do título — empresas frequentemente abrem a
 *     headline ("AMD fecha...", "AMD e Anthropic..."); o skip de
 *     sentence-start do passe 2 perderia esse match.
 *   - Aceita acrônimos all-caps de 2+ letras (ex: "AMD", "GPU") além do
 *     padrão title-case ≥4 chars — sem isso "AMD" (3 chars) nunca vira
 *     entidade. Restrito a `/^[A-Z]+$/` (só letras) para não capturar
 *     tokens alfanuméricos tipo "12B"/"4o" (versões/tamanhos de modelo) que
 *     tecnicamente "diferem" em maiúsc./minúsc. mas não são acrônimos.
 *   - Usa `ENTITY_ONLY_STOPWORDS` (mais permissivo — mantém nomes de empresa).
 */
export function extractEntityOnlyEntities(title: string): Set<string> {
  const entities = new Set<string>();
  const words = title.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^\p{L}\p{N}]/gu, "");
    if (clean.length < 2) continue;
    const isAllCapsAcronym = clean.length >= 2 && /^[A-Z]+$/.test(clean);
    const firstChar = clean.charAt(0);
    const isTitleCaseWord =
      clean.length >= 4 &&
      firstChar === firstChar.toUpperCase() &&
      firstChar !== firstChar.toLowerCase();
    if (!isAllCapsAcronym && !isTitleCaseWord) continue;
    const normalized = clean
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    if (ENTITY_ONLY_STOPWORDS.has(normalized)) continue;
    entities.add(normalized);
  }
  return entities;
}

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
  /**
   * #3972: true quando o warning foi disparado pelo gatilho entity-only
   * independente (janela curta, ≥2 entidades específicas compartilhadas)
   * em vez do passe padrão Jaccard/entity-threshold — `jaccard` pode estar
   * abaixo de `effective_threshold` nesse caso (o Jaccard textual não é o
   * critério; ele só é reportado para contexto).
   */
  entity_only_match?: boolean;
  /**
   * #4661: true quando o warning foi disparado pelo gatilho "saga em
   * andamento" (janela ampla, 1+ entidade de empresa + vocabulário de
   * incidente/segurança compartilhado em AMBOS os títulos, não
   * necessariamente o mesmo termo) — ver docstring de
   * `SAGA_MIN_SHARED_ENTITIES`. Como no entity-only, `jaccard` pode estar
   * abaixo de `effective_threshold`; não é o critério aqui.
   */
  saga_match?: boolean;
  /**
   * #4661: stems de vocabulário de incidente/segurança encontrados (união
   * candidato + edição passada) quando `saga_match` é true — contexto pro
   * editor entender por que o par foi sinalizado.
   */
  saga_keywords?: string[];
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
  /** #3972: entidades pré-computadas para o gatilho entity-only independente. */
  entityOnlyEntities: Set<string>;
  /**
   * #4661 review (achado 1): subconjunto de `entityOnlyEntities` SEM os
   * tokens que também são vocabulário de incidente — fonte da "entidade de
   * empresa em comum" usada pelo gatilho saga (nunca usado pelo entity-only
   * #3972, que continua consumindo `entityOnlyEntities` sem filtro). Ver
   * docstring de `excludeIncidentStemEntities`.
   */
  sagaEntities: Set<string>;
  /** #4661: stems de incidente/segurança pré-computados para o gatilho "saga em andamento". */
  incidentKeywords: Set<string>;
}

/**
 * Pré-computa tokens e entidades de cada edição passada UMA vez.
 * Evita recomputar janela × candidatos (padrão de dedup.ts ~900).
 */
function buildPastIndex(pastEditions: PastEditionEntry[]): PastEditionIndex[] {
  return pastEditions
    .map((entry) => {
      const tokens = tokenizeForJaccard(entry.title);
      const entityOnlyEntities = extractEntityOnlyEntities(entry.title);
      return {
        entry,
        tokens,
        entities: extractHighlightEntities(entry.title),
        entityOnlyEntities,
        sagaEntities: excludeIncidentStemEntities(entityOnlyEntities),
        incidentKeywords: extractIncidentKeywords(tokens),
      };
    })
    .filter((idx) => idx.tokens.size > 0);
}

/**
 * Compara um candidato a destaque contra o índice pré-computado de edições passadas.
 * Retorna o melhor match (se acima do threshold) ou null.
 *
 * #3972: além do passe padrão (Jaccard + threshold rebaixado por entity
 * overlap), roda um gatilho INDEPENDENTE contra as `ENTITY_ONLY_RECENT_WINDOW`
 * edições mais recentes (índice 0 = mais recente, já que `pastIndex` preserva
 * a ordem de `pastEditions`) — se ≥`ENTITY_ONLY_MIN_SHARED` entidades
 * específicas forem compartilhadas, emite warning mesmo com Jaccard baixo.
 * O gatilho padrão tem PRIORIDADE quando encontra algo (nenhuma mudança de
 * comportamento nos casos que já funcionavam) — o entity-only é fallback.
 */
function findThemeMatch(
  candidate: HighlightCandidate,
  pastIndex: PastEditionIndex[],
): HighlightThemeWarning | null {
  const candidateTokens = tokenizeForJaccard(candidate.title);
  if (candidateTokens.size === 0) return null;

  const candidateEntities = extractHighlightEntities(candidate.title);
  const candidateEntityOnly = extractEntityOnlyEntities(candidate.title);
  // #4661: stems de incidente/segurança do candidato — pré-computado uma vez.
  const candidateIncidentKeywords = extractIncidentKeywords(candidateTokens);
  // #4661 review (achado 1): entidades do candidato pra fins de saga, SEM os
  // tokens que também são vocabulário de incidente — ver docstring de
  // `excludeIncidentStemEntities`.
  const candidateSagaEntities = excludeIncidentStemEntities(candidateEntityOnly);

  let bestMatch: HighlightThemeWarning | null = null;
  // #3972: melhor match do gatilho entity-only independente (fallback).
  let bestEntityOnlyMatch: HighlightThemeWarning | null = null;
  // #4661: melhor match do gatilho "saga em andamento" (fallback final, janela ampla).
  let bestSagaMatch: HighlightThemeWarning | null = null;

  pastIndex.forEach((pastEntry, position) => {
    const {
      entry: past,
      tokens: pastTokens,
      entities: pastEntities,
      entityOnlyEntities: pastEntityOnly,
      sagaEntities: pastSagaEntities,
      incidentKeywords: pastIncidentKeywords,
    } = pastEntry;

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

    // #3972: gatilho entity-only independente — só contra a janela curta
    // (edições mais recentes), independente do Jaccard textual.
    if (position < ENTITY_ONLY_RECENT_WINDOW) {
      const sharedEntityOnly: string[] = [];
      for (const e of candidateEntityOnly) {
        if (pastEntityOnly.has(e)) sharedEntityOnly.push(e);
      }
      if (sharedEntityOnly.length >= ENTITY_ONLY_MIN_SHARED) {
        const isBetter =
          bestEntityOnlyMatch === null ||
          sharedEntityOnly.length > bestEntityOnlyMatch.shared_entities.length ||
          (sharedEntityOnly.length === bestEntityOnlyMatch.shared_entities.length && jaccard > bestEntityOnlyMatch.jaccard);
        if (isBetter) {
          bestEntityOnlyMatch = {
            candidate_rank: candidate.rank,
            candidate_title: candidate.title,
            candidate_url: candidate.url,
            matched_edition: isoDateToAammdd(past.date),
            matched_title: past.title,
            jaccard: Math.round(jaccard * 100) / 100,
            shared_entities: sharedEntityOnly,
            effective_threshold: JACCARD_THRESHOLD_WITH_ENTITY,
            entity_only_match: true,
          };
        }
      }
    }

    // #4661: gatilho "saga em andamento" — janela AMPLA (toda `pastIndex`,
    // não só `ENTITY_ONLY_RECENT_WINDOW`). Dispara quando candidato e edição
    // passada compartilham ≥1 entidade de empresa E AMBOS mencionam
    // vocabulário de incidente/segurança (não precisa ser o mesmo termo —
    // "hackeou" num título e "invadiu" noutro contam, porque o que persiste
    // numa saga é a categoria do evento, não o verbo exato). Ver docstring de
    // `SAGA_MIN_SHARED_ENTITIES` para o caso real e o trade-off assumido.
    if (candidateIncidentKeywords.size > 0 && pastIncidentKeywords.size > 0) {
      // #4661 review (achado 1): usa os sets JÁ FILTRADOS de vocabulário de
      // incidente (`candidateSagaEntities`/`pastSagaEntities`), não
      // `candidateEntityOnly`/`pastEntityOnly` brutos — senão a própria
      // palavra de incidente (ex: "vazamento", "hackers" no início da
      // manchete) conta como a "entidade de empresa em comum" sozinha. Ver
      // docstring de `excludeIncidentStemEntities`.
      const sharedSagaEntities: string[] = [];
      for (const e of candidateSagaEntities) {
        if (pastSagaEntities.has(e)) sharedSagaEntities.push(e);
      }
      if (sharedSagaEntities.length >= SAGA_MIN_SHARED_ENTITIES) {
        const isBetter =
          bestSagaMatch === null ||
          sharedSagaEntities.length > bestSagaMatch.shared_entities.length ||
          (sharedSagaEntities.length === bestSagaMatch.shared_entities.length && jaccard > bestSagaMatch.jaccard);
        if (isBetter) {
          bestSagaMatch = {
            candidate_rank: candidate.rank,
            candidate_title: candidate.title,
            candidate_url: candidate.url,
            matched_edition: isoDateToAammdd(past.date),
            matched_title: past.title,
            jaccard: Math.round(jaccard * 100) / 100,
            shared_entities: sharedSagaEntities,
            effective_threshold: JACCARD_THRESHOLD_WITH_ENTITY,
            saga_match: true,
            saga_keywords: [...new Set([...candidateIncidentKeywords, ...pastIncidentKeywords])].sort(),
          };
        }
      }
    }
  });

  // #3972/#4661: algoritmo padrão (Jaccard/threshold) tem prioridade quando
  // encontra algo; entity-only (janela curta, mais específico) é o próximo
  // fallback; saga (janela ampla, mais permissivo) é o último recurso — só
  // pega o que os dois anteriores não cobrem.
  return bestMatch ?? bestEntityOnlyMatch ?? bestSagaMatch;
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

// ---------------------------------------------------------------------------
// Full-body cross-edition check (#4262)
//
// Problema (#4262): `checkHighlightThemes` acima compara candidato a destaque
// só contra os TÍTULOS DE DESTAQUE passados (headline de `past-editions.md`).
// Um item que saiu como RADAR/LANÇAMENTOS ontem pode virar destaque hoje sem
// nenhum alarme, porque ele nunca entra no universo comparado. Caso real
// 260729: 5 dos 6 candidatos a destaque eram histórias já cobertas nas
// edições 260727/260728 — 3 delas como item SECUNDÁRIO (não destaque) na
// edição anterior.
//
// Fix: comparar candidatos a destaque contra o CORPO INTEIRO (destaques +
// todos os buckets secundários) de `01-approved.json` das últimas N edições,
// reusando o mesmo comparador cross-veículo de `dedup-intra-edition.ts`
// (`isIntraEditionDuplicate`, com `crossEditionMode: true`) em vez de
// desenhar um detector novo — decisão do editor no comentário da #4262: o
// mecanismo já existe e está calibrado, só precisa olhar pro histórico.
//
// WARN-ONLY, como o resto deste arquivo — nunca bloqueia o gate. O guard
// GATE-BLOCKING pré-Stage-2 proposto na #4262 (item 3) é responsabilidade de
// outro ponto do pipeline (fora do escopo deste arquivo).
// ---------------------------------------------------------------------------

/** Buckets do corpo inteiro de uma edição passada: destaques + secundários. */
const FULL_BODY_BUCKETS = ["highlights", ...SECONDARY_BUCKETS];

export interface PastFullBodyItem {
  edition: string; // AAMMDD
  bucket: string;  // "highlights" | radar | lancamento | use_melhor | video
  title: string;
  url: string;
}

/**
 * Lê TODOS os itens (destaques + buckets secundários) dos `01-approved.json`
 * das `window` edições mais recentes em `editionsDir`, excluindo `currentAammdd`.
 *
 * Mesma resolução de path (flat/nested, `_internal/` vs root) de
 * `readPastApprovedSecondary` — diferença: inclui o bucket `highlights` e
 * também captura `url` (necessário pro comparador de `dedup-intra-edition.ts`,
 * que usa a URL só pra pular self-match quando bate com a do candidato).
 *
 * Falha gracioso: arquivo ausente/corrompido → skip silencioso.
 */
export function readPastFullBodyItems(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
): PastFullBodyItem[] {
  if (!existsSync(editionsDir)) return [];
  const recent = recentEditionDirs(editionsDir, window, currentAammdd);
  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);
  const items: PastFullBodyItem[] = [];

  for (const aammdd of recent) {
    const editionDir = editionDirsByAammdd.get(aammdd);
    if (!editionDir) continue;
    const candidates = [
      resolve(editionDir, "_internal", "01-approved.json"),
      resolve(editionDir, "01-approved.json"),
    ];
    let parsed: RawBuckets | null = null;

    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        parsed = raw as RawBuckets;
        break;
      } catch {
        continue;
      }
    }
    if (!parsed) continue;

    for (const bucket of FULL_BODY_BUCKETS) {
      const arr = parsed[bucket];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (item === null || typeof item !== "object") continue;
        const art = item.article ?? {};
        const title = (art.title ?? item.title ?? "").trim();
        const url = (art.url ?? item.url ?? "").trim();
        if (title) items.push({ edition: aammdd, bucket, title, url });
      }
    }
  }
  return items;
}

export interface FullBodyThemeWarning {
  candidate_rank: number;
  candidate_title: string;
  candidate_url: string;
  matched_edition: string;
  matched_bucket: string;
  matched_title: string;
  /** match_type retornado por `isIntraEditionDuplicate` — ver dedup-intra-edition.ts. */
  match_type: string;
  score: number;
}

export interface CheckFullBodyThemesResult {
  full_body_warnings: FullBodyThemeWarning[];
  full_body_checked: number;
  /** Edições distintas do histórico que de fato contribuíram algum item (mesma semântica de secondary_editions_with_data). */
  full_body_editions_with_data: number;
  full_body_window_requested: number;
}

export const DEFAULT_FULL_BODY_WINDOW = 10;

/**
 * Verifica se candidatos a destaque da edição corrente repetem uma história
 * já coberta em QUALQUER bucket (não só destaque) das edições passadas.
 *
 * Reusa `isIntraEditionDuplicate` com `crossEditionMode: true` — o mesmo
 * comparador jaccard/entity/domain/cross_vehicle/product_code do dedup
 * intra-edição, mais os 2 sinais adicionais calibrados pro gap de paráfrase
 * cross-edição (ver docstring de `crossEditionMode` em dedup-intra-edition.ts).
 *
 * WARN-ONLY — nunca bloqueia o gate.
 */
export function checkFullBodyThemes(
  candidates: HighlightCandidate[],
  pastItems: PastFullBodyItem[],
  requestedWindow: number = DEFAULT_FULL_BODY_WINDOW,
): CheckFullBodyThemesResult {
  const full_body_warnings: FullBodyThemeWarning[] = [];
  const pastAsHighlights = pastItems.map((p) => ({ title: p.title, url: p.url }));

  for (const candidate of candidates) {
    if (!candidate.title) continue;
    const match = isIntraEditionDuplicate(
      { title: candidate.title, url: candidate.url },
      pastAsHighlights,
      { crossEditionMode: true },
    );
    if (!match) continue;

    // #4262: recupera edição/bucket do item casado pra exibir no warning —
    // isIntraEditionDuplicate só retorna o título (`matched_highlight`), não
    // a referência do item de origem. Match por título é suficiente aqui
    // (display-only, warn-only) — colisão de título idêntico entre 2 itens
    // de edições diferentes é rara o bastante pra não justificar refatorar
    // o comparador só pra devolver o índice.
    const matchedPast = pastItems.find((p) => p.title === match.matched_highlight);

    full_body_warnings.push({
      candidate_rank: candidate.rank,
      candidate_title: candidate.title,
      candidate_url: candidate.url,
      matched_edition: matchedPast?.edition ?? "unknown",
      matched_bucket: matchedPast?.bucket ?? "unknown",
      matched_title: match.matched_highlight,
      match_type: match.match_type,
      score: match.score,
    });
  }

  const distinctEditions = new Set(pastItems.map((p) => p.edition));
  return {
    full_body_warnings,
    full_body_checked: candidates.length,
    full_body_editions_with_data: distinctEditions.size,
    full_body_window_requested: requestedWindow,
  };
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
  // #4262: full-body cross-edition check flag (destaque vs CORPO INTEIRO das
  // edições passadas, não só destaques passados). Default: mesma janela do
  // secondary check (10) — histórico de mesma profundidade.
  const fullBodyWindow = parseInt(args["full-body-window"] ?? String(DEFAULT_FULL_BODY_WINDOW), 10);
  // #2652: fallback p/ deriveCurrentEdition (espelha dedup.ts CLI #1856) — sem isso,
  // re-run/resume onde o 01-approved.json da edição atual já existe inclui a própria
  // edição na janela e gera self-match (Jaccard ~1.0) em todo item secundário.
  const currentEdition = args["current-edition"] ?? deriveCurrentEdition(args["categorized"]);

  if (!categorizedPath) {
    console.error(
      "Uso: check-highlight-themes.ts --categorized <path> [--past-editions <path>] [--window 12] " +
      "[--editions-dir data/editions] [--secondary-window 10] [--full-body-window 10] " +
      "[--current-edition AAMMDD] [--out-json <path>]",
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
      // #3972: entity_only_match sinaliza que o gatilho foi o entity-overlap
      // independente (janela curta) — o Jaccard reportado pode estar abaixo
      // do threshold normal, então isso é anotado explicitamente no log.
      const note = w.entity_only_match
        ? " [entity-only: match independente do Jaccard, janela curta]"
        : w.saga_match
          ? ` [saga: empresa em comum + vocabulário de incidente (${(w.saga_keywords ?? []).join(",")}), janela ampla]`
          : "";
      console.error(
        `[check-highlight-themes] ⚠️  Candidato #${w.candidate_rank} "${w.candidate_title}" repete tema de ${w.matched_edition} "${w.matched_title}" (Jaccard=${w.jaccard}, entities=[${w.shared_entities.join(",")}])${note}`,
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

  // #4262: full-body cross-edition check — candidato a destaque vs CORPO
  // INTEIRO (destaques + secundários) das edições passadas.
  const pastFullBody = readPastFullBodyItems(editionsDir, fullBodyWindow, currentEdition);
  const fullBodyResult = checkFullBodyThemes(candidates, pastFullBody, fullBodyWindow);

  if (fullBodyResult.full_body_warnings.length > 0) {
    for (const w of fullBodyResult.full_body_warnings) {
      console.error(
        `[check-highlight-themes] ⚠️  CORPO INTEIRO Candidato #${w.candidate_rank} "${w.candidate_title}" (${w.candidate_url}) repete história de ${w.matched_edition} [${w.matched_bucket}] "${w.matched_title}" (${w.match_type}, score=${w.score.toFixed(2)})`,
      );
    }
  } else {
    console.error(
      `[check-highlight-themes] ✓ ${fullBodyResult.full_body_checked} candidato(s) verificado(s) contra o corpo inteiro de ${fullBodyResult.full_body_editions_with_data}/${fullBodyResult.full_body_window_requested} edição(ões) com dados na janela — nenhuma história repetida detectada.`,
    );
  }

  // Combina os resultados num único JSON (backward-compatible: novos campos adicionados)
  const combined = {
    warnings: highlightResult.warnings,
    secondary_warnings: secondaryResult.secondary_warnings,
    full_body_warnings: fullBodyResult.full_body_warnings,
    checked: highlightResult.checked,
    secondary_checked: secondaryResult.secondary_checked,
    full_body_checked: fullBodyResult.full_body_checked,
    window: highlightResult.window,
    // #2684 item 4: secondary_window (nome enganoso) substituído pelos 2 campos abaixo.
    secondary_editions_with_data: secondaryResult.secondary_editions_with_data,
    secondary_window_requested: secondaryResult.secondary_window_requested,
    full_body_editions_with_data: fullBodyResult.full_body_editions_with_data,
    full_body_window_requested: fullBodyResult.full_body_window_requested,
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
