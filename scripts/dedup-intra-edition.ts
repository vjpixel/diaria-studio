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
import { resolve, dirname } from "node:path";
import {
  tokenizeForJaccard,
  jaccardSimilarity,
} from "./dedup.ts";
import { detectLaunchCandidate, detectDomainMismatchCandidate } from "./lib/launch-detect.ts";
import { SECONDARY_BUCKETS } from "./check-secondary-themes.ts";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
// #4185: mesmo mecanismo de preservação do Pass-2b de dedup.ts (#3920) —
// aqui aplicado no ponto destaque-vs-pool (pós-scorer), não no pool bruto.
import { toClusterSource, type ClusterSource, type ClusterArticle } from "./lib/cluster-sources.ts";

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

/** Nomes de EMPRESA de alta frequência (#2406). NUNCA contam como entidade
 *  discriminante de evento: em edições com 2+ itens da mesma empresa, "Microsoft"
 *  sozinho não distingue histórias diferentes. Excluídos em TODOS os contextos
 *  de entity-match — inclusive o segundo-sinal do domain-match (#2587), onde a
 *  empresa já está estabelecida pelo próprio domain-match. */
const COMPANY_STOPWORDS_INTRA = new Set([
  "microsoft", "google", "apple", "amazon", "meta", "nvidia",
  "anthropic", "deepmind", "deepseek", "mistral", "cohere",
  "openai", "perplexity",
]);

/** Nomes de PRODUTO/modelo de IA + termos genéricos do domínio + dias/meses.
 *  Excluídos do entity-match GERAL (2-entidade, #2406) porque um produto
 *  sozinho ("Gemini") cobre muitas histórias do dia. MAS, no segundo-sinal do
 *  domain-match (#2587), o nome do produto É o discriminador de evento que a
 *  issue pede ("≥1 entidade nomeada compartilhada ALÉM do nome da empresa"):
 *  a empresa já vem do domínio, então "Gemini"/"GPT" compartilhado confirma o
 *  mesmo lançamento. Por isso `extractProductEntitiesIntra` re-inclui estes. */
const PRODUCT_STOPWORDS_INTRA = new Set([
  "ia", "ai", "ml", "llm", "gpt", "chatgpt", "claude", "gemini",
  "inteligencia", "artificial", "machine", "learning",
  "diaria", "newsletter", "edicao",
  "copilot", "alexa", "siri", "grok",
  "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo",
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]);

/** Termos comuns no domínio IA que NÃO contam como entidade discriminante no
 *  entity-match GERAL (2-entidade). União de empresa + produto/genéricos.
 *  Mantém o comportamento histórico de `extractNamedEntitiesIntra` (#2406). */
const ENTITY_STOPWORDS_INTRA = new Set([
  ...COMPANY_STOPWORDS_INTRA,
  ...PRODUCT_STOPWORDS_INTRA,
]);

/** Termos puramente genéricos (não-produto, não-empresa) — sempre excluídos,
 *  inclusive no segundo-sinal do domain-match. Evita que "IA"/dia-da-semana
 *  contem como produto-discriminador. Subconjunto de PRODUCT_STOPWORDS_INTRA. */
const GENERIC_STOPWORDS_INTRA = new Set([
  "ia", "ai", "ml", "llm",
  "inteligencia", "artificial", "machine", "learning",
  "diaria", "newsletter", "edicao",
  "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo",
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]);

/**
 * #3099: termos genéricos de manchete (verbos de atribuição jornalística,
 * substantivos de sourcing, descritores de produto de altíssima frequência)
 * que NÃO contam como TÓPICO discriminante no cross-vehicle same-company
 * match (item d de `isIntraEditionDuplicate`). Sem isso, duas notícias
 * DIFERENTES da mesma empresa no mesmo dia colidiriam só por compartilharem
 * um verbo de atribuição comum ("revela", "dizem", "anuncia") ou um
 * substantivo genérico ("modelo", "novo"). Termos de produto ESPECÍFICO
 * (chip, satélite, processador, etc.) ficam de fora de propósito — são
 * exatamente o que deve discriminar o evento.
 */
const TOPIC_TOKEN_STOPWORDS_INTRA = new Set([
  // #3099 review: GENERIC_STOPWORDS_INTRA (ia/ai/ml/llm, dias/meses, etc.)
  // precisa entrar aqui também — sem isso, "llm" (>=3 chars, sobrevive ao
  // tokenizeForJaccard) ou um dia-da-semana poderiam contar como token de
  // tópico compartilhado entre 2 histórias DIFERENTES da mesma empresa.
  ...GENERIC_STOPWORDS_INTRA,
  "novo", "nova", "novos", "novas",
  "modelo", "modelos",
  "empresa", "empresas",
  "tecnologia", "ferramenta", "plataforma", "produto", "versao",
  "revela", "revelam", "anuncia", "anunciam", "diz", "dizem", "afirma",
  "afirmam", "aponta", "apontam", "informa", "informam", "confirma", "confirmam",
  "portal", "fontes", "fonte",
]);

/**
 * #3099: nomes de empresa mencionados no título, SEM excluir via
 * COMPANY_STOPWORDS_INTRA — aqui a empresa É o sinal (ao contrário do
 * entity-match geral, onde ela é descartada por não discriminar sozinha
 * entre histórias da MESMA empresa). Usado no cross-vehicle same-company
 * match (item d de `isIntraEditionDuplicate`).
 *
 * Busca por palavra inteira (case-insensitive, sem acento) no título já sem
 * sufixo de veículo — não depende de capitalização (diferente de
 * `extractEntitiesWithStopwords`), porque a empresa pode aparecer em
 * qualquer posição/caixa dependendo do estilo de manchete do veículo (ex:
 * "Chinesa DeepSeek está desenvolvendo..." tem "DeepSeek" no meio da frase).
 */
export function extractCompanyMentionsIntra(title: string): Set<string> {
  const cleaned = stripVehicleSuffix(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const found = new Set<string>();
  for (const company of COMPANY_STOPWORDS_INTRA) {
    if (new RegExp(`\\b${company}\\b`).test(cleaned)) found.add(company);
  }
  return found;
}

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
function extractEntitiesWithStopwords(
  title: string,
  stopwords: Set<string>,
): Set<string> {
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
    if (stopwords.has(normalized)) continue;
    entities.add(normalized);
  }
  return entities;
}

/** Entity-match GERAL (2-entidade, #2406): exclui empresa + produto + genéricos.
 *  Um produto sozinho ("Gemini") cobre muitas histórias do dia → não discrimina. */
export function extractNamedEntitiesIntra(title: string): Set<string> {
  return extractEntitiesWithStopwords(title, ENTITY_STOPWORDS_INTRA);
}

/**
 * Entity-match para o SEGUNDO-SINAL do domain-match (#2587).
 *
 * Re-inclui nomes de PRODUTO/modelo (Gemini, GPT, Claude, Copilot…) como
 * entidades discriminantes, excluindo só nomes de EMPRESA e termos genéricos.
 *
 * Racional: no contexto do domain-match, a empresa já está estabelecida (o
 * `suggested_primary_domain` do RADAR bate com o domínio do destaque). O que a
 * issue #2587 pede como segundo sinal é "≥1 entidade nomeada compartilhada
 * ALÉM do nome da empresa" — i.e. o nome do PRODUTO/feature. Então:
 *   - D1 "Google lança Gemini computer use" + RADAR "canaltech: Google libera
 *     Gemini que mexe no PC" → compartilham "gemini" (produto) → MESMO evento.
 *   - D1 "Google lança Pixel 9" + RADAR "Google anuncia Android 16" →
 *     "pixel"/"android" não se cruzam, "google" é stopword de empresa →
 *     0 entidades compartilhadas → eventos DIFERENTES (preserva).
 */
export function extractProductEntitiesIntra(title: string): Set<string> {
  return extractEntitiesWithStopwords(
    title,
    new Set([...COMPANY_STOPWORDS_INTRA, ...GENERIC_STOPWORDS_INTRA]),
  );
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface Article {
  url: string;
  title?: string;
  /** #4695: marca artigos que chegaram via submissão direta do editor
   *  (`diariaeditor@gmail.com`). Mesmo campo/semântica de `dedup.ts` Pass 1d
   *  (#4192) e `filter-date-window.ts` (#4656) — exime o item da remoção
   *  aqui também, nos dois passes (destaque-vs-bucket e item-vs-item). */
  flag?: string;
  /** #4185: usado (junto com o title) como haystack pro sinal de código de
   *  produto (`extractProductCodeTokens`) — nome de produto versionado/
   *  codinome muitas vezes só aparece no corpo/lead da matéria, não na
   *  manchete. */
  summary?: string;
  /** Domínio oficial sugerido por `enrich-primary-source.ts` (#487).
   *  Ex: "google.com" para RADAR item cobrindo lançamento do Google.
   *  Usado pelo dedup intra-edição (Furo 2, #2548) para detectar cobertura de
   *  imprensa de um lançamento que já aparece como destaque. */
  suggested_primary_domain?: string;
  /** #4185: fontes extras preservadas quando este artigo é o CANÔNICO
   *  (destaque) de um cluster same-story detectado intra-edição. */
  cluster_sources?: ClusterSource[];
  [key: string]: unknown;
}

interface HighlightEntry {
  url?: string;
  title?: string;
  summary?: string;
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

interface IntraEditionRemovedEntry {
  url: string;
  title?: string;
  bucket: string;
  match_type:
    | "jaccard"
    | "entity"
    | "domain"
    | "cross_vehicle"
    | "product_code"
    | "content_terms"
    /** #4360: duplicata DENTRO do bucket LANÇAMENTOS (não envolve destaque). */
    | "intra_bucket";
  matched_highlight: string;
  score: number;
}

export interface IntraEditionDedupResult {
  kept: CategorizedWithHighlights;
  removed: IntraEditionRemovedEntry[];
  /**
   * #4695: itens `flag: "editor_submitted"` que casaram com um critério de
   * duplicata intra-edição em QUALQUER um dos dois passes, mas cujo
   * conteúdo NUNCA é descartado silenciosamente:
   *  - Passe destaque-vs-bucket: o item sai do bucket secundário como antes
   *    (#4185/#4228), mas é RESGATADO como `cluster_sources[]` no destaque
   *    que ele duplicou — o `writer-destaque` lê esse material. Aparece aqui
   *    só pra dar visibilidade ao gate (item 4c) de que isso aconteceu; não
   *    é uma perda real.
   *  - Passe item-vs-item (`dedupSecondaryIntraBucket`): não existe fold
   *    equivalente (o "sobrevivente" é outro item do MESMO bucket, não um
   *    destaque com corpo próprio), então aqui a exemção é INCONDICIONAL —
   *    o item permanece no bucket, sem nenhum dos dois lados sendo removido.
   * Em ambos os casos o campo `bucket` identifica de onde veio o match.
   * Mantém o nome `editorSubmittedLost` por consistência com o formato já
   * estabelecido por `dedup.ts` (#4192) e `filter-date-window.ts` (#4656).
   */
  editorSubmittedLost: IntraEditionRemovedEntry[];
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
 * #4675 review (fix de regressão do #4667): threshold Jaccard usado por
 * `dedupSecondaryIntraBucket` em modo `strict` (buckets secundários ≠
 * `lancamento` — hoje só RADAR via `INTRA_BUCKET_DEDUP_BUCKETS`). Ver
 * docstring de `dedupSecondaryIntraBucket` para o racional completo do modo
 * strict. Mais permissivo que `INTRA_JACCARD_THRESHOLD` (0.45) porque em
 * modo strict o caminho de entidade-sozinha está desligado — só Jaccard
 * resta como sinal, então o threshold precisa ser baixo o bastante para
 * capturar títulos de veículos diferentes cobrindo o mesmo fato do dia com
 * vocabulário bem divergente (ver os 2 clusters reais na issue #4667).
 * Calibrado contra o par mais fraco desses clusters (cluster "Claude caiu",
 * 4 fontes — menor Jaccard par-a-par ≈0.167), com margem folgada abaixo dos
 * pares falso-positivo reproduzidos no review do #4675 (≈0.06–0.08: "ChatGPT
 * banido em escolas" x "ChatGPT ganha novo modo de voz"; "Gemini fica
 * instável" x "Google testa recurso experimental do Gemini").
 */
export const SECONDARY_INTRA_BUCKET_STRICT_JACCARD_THRESHOLD = 0.15;

/**
 * Número mínimo de entidades compartilhadas para considerar entity-match.
 * 2 entidades = 1 empresa/produto + 1 numérico/outro, ou 2 entidades nomeadas.
 * Evita falso-positivo de 1 entidade genérica (ex: só "SpaceX" matcharia
 * qualquer notícia de SpaceX do dia, não só o mesmo evento).
 */
export const INTRA_ENTITY_MIN_SHARED = 2;

/**
 * Threshold de Jaccard mínimo aceito como SEGUNDO SINAL quando domain-match
 * é positivo (#2587), no caminho OR `(entidade-de-produto compartilhada) OR
 * (Jaccard ≥ este valor)`. Baixo o suficiente para confirmar mesmo evento com
 * 1–2 tokens específicos compartilhados, alto o suficiente para rejeitar dois
 * lançamentos diferentes da mesma empresa sem token comum além do nome da
 * companhia. O caminho de entidade-de-produto cobre o caso cross-lingual
 * (D1 inglês + RADAR português) onde o Jaccard de título é ~0 mas ambos citam
 * o nome do produto (ex: "Gemini").
 */
export const INTRA_DOMAIN_JACCARD_MIN = 0.2;

/**
 * #4262: threshold do path de TERMOS DE CONTEÚDO compartilhados — só ativo em
 * `options.crossEditionMode` (ver `isIntraEditionDuplicate`). Mínimo de
 * tokens específicos (não-genéricos, ≥ CROSS_EDITION_TERM_MIN_LEN chars)
 * compartilhados entre o título candidato e o título histórico, quando
 * NENHUM dos sinais anteriores (jaccard/entity/domain/cross_vehicle/
 * product_code) disparou.
 *
 * Caso real #4262 (edição 260729): "Com prompt invisível, professor
 * desmascara 32 alunos usando IA em prova" (Canaltech, candidato) x
 * "Professor cria armadilha para descobrir quem usou IA e reprova 32 de 35
 * alunos" (g1, edição passada) — nenhuma empresa de IA é citada (path (d)
 * cross_vehicle não se aplica), "professor" não é capturável pela heurística
 * de capitalização do entity-match (b) porque no título real do Canaltech é
 * substantivo comum minúsculo mid-sentence, e o Jaccard geral (~0.25) fica
 * abaixo do threshold intra-edição (0.45). "professor"/"alunos" SÃO o sinal
 * de mesma-história aqui — 2 tokens de conteúdo específicos compartilhados,
 * mesmo sem capitalização nem menção de empresa.
 *
 * Restrito a `crossEditionMode` (não ativo por default no dedup
 * intra-edição de produção, `dedup-intra-edition.ts` main()) porque é o path
 * mais permissivo dos seis — dois títulos DIFERENTES no mesmo dia podem
 * coincidentemente compartilhar 2 palavras de 6+ chars sem ser o mesmo
 * evento. Aceitável só no contexto cross-edição, que é warn-only
 * (`check-highlight-themes.ts` nunca bloqueia o gate).
 */
export const CROSS_EDITION_TERM_MIN_LEN = 6;

/** Ver docstring de `CROSS_EDITION_TERM_MIN_LEN`. */
export const CROSS_EDITION_TERM_MIN_SHARED = 2;

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

/** #4185: extrai summary de um HighlightEntry (mesmo padrão de highlightTitle/highlightUrl). */
export function highlightSummary(h: HighlightEntry): string | null {
  const s = h.summary ?? h.article?.summary;
  if (s && typeof s === "string") return s;
  return null;
}

/**
 * #4185: extrai tokens que parecem CÓDIGO/VERSÃO de produto — sequências
 * alfanuméricas unidas por ponto SEM espaço em nenhum dos lados, exigindo
 * LETRA inicial (ex: "ia.i", "itau.com.br", "gpt4o.mini"). Padrão raro o
 * bastante em prosa normal (frase termina em ". " — com espaço depois do
 * ponto — que não casa) pra servir de sinal de ALTA precisão quando
 * EXATAMENTE o mesmo token aparece nos dois lados.
 *
 * **Decisão deliberadamente conservadora:** token PURAMENTE numérico (ex:
 * "3.1" de "Llama 3.1") NÃO casa — a letra inicial é exigida. Sem essa
 * trava, "1.500" (separador de milhar comum em manchete PT-BR: "1.500
 * clientes", "1.500 funcionários") viraria sinal de mesmo-produto entre duas
 * matérias DIFERENTES da mesma empresa que coincidentemente citam o mesmo
 * número redondo — falso-positivo pior que o ganho de cobertura de números
 * de versão soltos. Custo aceito: "Llama 3.1" sozinho (sem prefixo
 * alfabético grudado) não gera token; "gpt4o.mini"/"ia.i" continuam cobertos
 * porque a letra inicial ancora o match a um nome de produto, não a um
 * número solto.
 *
 * Complementa o entity-match por capitalização (`extractNamedEntitiesIntra`):
 * nomes de produto versionados/codinomes em minúsculo (ex: "ia.i") nunca são
 * capturados por ela, e frequentemente só aparecem no corpo/lead da matéria,
 * não na manchete — por isso os callers aplicam esta função a título+summary
 * combinados, não só ao título.
 *
 * Caso real #4185 (edição 260728): D1 "Itaú coloca IA para cuidar do
 * relacionamento com o cliente" (Tecnoblog) + RADAR "Nova IA do Itaú mostra
 * para onde vai o seu dinheiro e te ajuda a controlar gastos" (Canaltech) —
 * cobrem o MESMO lançamento (assistente "ia.i" do Itaú), mas nenhum título
 * menciona "ia.i" literalmente (só o lead de cada matéria); o único token de
 * título compartilhado é "itau" (Jaccard ~0.07, abaixo até do threshold
 * intra-edição de 0.45; entity-match (b) via só o título vê 1 entidade
 * compartilhada, abaixo do mínimo de 2).
 */
export function extractProductCodeTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const re = /\b[a-z][a-z0-9]*(?:\.[a-z0-9]+)+\b/gi;
  const matches = text.match(re);
  if (!matches) return tokens;
  for (const m of matches) tokens.add(m.toLowerCase());
  return tokens;
}

/**
 * #2580: Alias map para normalizar multi-domínio de empresas com TLDs especiais.
 *
 * O Google usa tanto `.google` (gTLD próprio, ex: blog.google, deepmind.google,
 * ai.google) quanto `.com` (ex: cloud.google.com). A heurística de 2-labels
 * produz resultados inconsistentes:
 *   - blog.google  → "blog.google"  (hostname tem 2 labels → result = hostname)
 *   - cloud.google.com → "google.com"  (hostname tem 3 labels → result = last 2)
 * Isso quebra o match de `suggested_primary_domain` contra URLs de destaque.
 *
 * Fix: normalizar o resultado de 2-labels para o domínio canônico da empresa
 * quando o hostname inteiro é um sub-TLD conhecido. Mantém a lista mínima —
 * só aliases de hostnames que aparecem em `official-domains.ts` como primary_domain
 * ou domains[] com gTLD próprio (não .com/.net/.org).
 *
 * NÃO inclui `research.google` (não é primary_domain de nenhuma entrada;
 * o comentário antigo em extractRegistrableDomain usava domínio inexistente
 * "blog.google.com" — o blog real do Google é "blog.google" sem .com).
 */
export const DOMAIN_ALIASES: Record<string, string> = {
  // Google usa .google como TLD próprio. Os 3 abaixo aparecem em official-domains.ts
  // como domains[] ou primary_domain:
  //   - "blog.google"    → primary_domain da entry "Google (blog)"
  //   - "deepmind.google" → domains[] da entry "DeepMind / Google"
  //   - "ai.google"      → domains[] da entry "DeepMind / Google"
  // Todos são propriedades da mesma entidade (Google) para fins de dedup.
  "blog.google": "google.com",
  "deepmind.google": "google.com",
  "ai.google": "google.com",
  // #2586: deepmind.com é listado em official-domains.ts como domains[] da entry
  // "DeepMind / Google" (junto com deepmind.google e ai.google), mas estava faltando
  // aqui. Adicionar para que extractRegistrableDomain("https://deepmind.com/...") → "google.com".
  "deepmind.com": "google.com",
};

/**
 * Extrai o registrable domain (eTLD+1) de uma URL, normalizado lowercase.
 * Ex: "https://blog.google.com/foo" → "google.com"
 *     "https://blog.google/foo"     → "google.com"  (via alias, #2580)
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
 *
 * #2580: pós-normalização, aplica `DOMAIN_ALIASES` pra reconciliar entidades
 * com multi-domínio (ex: Google com blog.google + cloud.google.com).
 */
export function extractRegistrableDomain(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    const parts = hostname.toLowerCase().split(".");
    if (parts.length < 2) return null;
    const twoLabel = parts.slice(-2).join(".");
    // #2580: normalizar para domínio canônico quando é um alias conhecido.
    return DOMAIN_ALIASES[twoLabel] ?? twoLabel;
  } catch {
    return null;
  }
}

/**
 * Normaliza um domínio (hostname ou eTLD+1) através do alias map.
 * Suporta tanto hostnames completos (ex: "blog.google.com") quanto
 * domínios já extraídos (ex: "blog.google").
 *
 * Usado para comparar `suggested_primary_domain` (que pode ser o hostname
 * completo como "blog.google" — primary_domain do Google em official-domains.ts)
 * com o `extractRegistrableDomain()` do destaque (que aplica o alias map).
 * Sem normalização bilateral, "blog.google" ≠ "google.com" mesmo após o fix #2580.
 *
 * #2586: NÃO delega a `extractRegistrableDomain` porque a entrada aqui é um
 * domínio já normalizado (sem scheme "https://"), e `extractRegistrableDomain`
 * espera uma URL completa (chama `new URL(url)` que exige scheme). Extrair o
 * eTLD+1 inline é necessário. O alias map compartilhado (`DOMAIN_ALIASES`) garante
 * consistência de comportamento entre as duas funções.
 */
function normalizeDomainForMatch(domain: string): string {
  const lower = domain.toLowerCase();
  // Verificar se é hostname com path (ex: "blog.google.com/products") — pegar só o host
  const host = lower.split("/")[0];
  // Tentar extrair registrable domain (pega os 2 últimos labels) e aplicar alias.
  const parts = host.split(".");
  if (parts.length >= 2) {
    const twoLabel = parts.slice(-2).join(".");
    return DOMAIN_ALIASES[twoLabel] ?? twoLabel;
  }
  return host;
}

/**
 * #2548 (Furo 2): Retorna true se a URL do destaque pertence ao domínio oficial
 * do lançamento que o artigo RADAR cobre.
 *
 * Caso real: RADAR = canaltech.com.br (suggested_primary_domain = "blog.google"),
 * D1 = blog.google.com → extractRegistrableDomain → "google.com" (via alias #2580)
 * normalizeDomainForMatch("blog.google") → "google.com" (via alias #2580)
 * → match → RADAR é cobertura de imprensa do mesmo lançamento que D1.
 *
 * Fonte do domínio (preferência decrescente):
 *   1. `article.suggested_primary_domain` — campo setado por `enrich-primary-source.ts`
 *      no passo 1m (sobre `tmp-categorized.json`). Quando presente é o mais barato.
 *   2. Re-derivação via `detectLaunchCandidate` (#2578) — fallback quando o campo
 *      não sobreviveu ao pipeline (scorer/assemble drop de campos extra que o LLM
 *      não escreveu de volta). Aplica os mesmos critérios que `enrich-primary-source`.
 *
 * Sem nenhum dos dois, o check é no-op (retorna false graciosamente).
 *
 * #4262: aceita `options.crossEditionMode` — quando true, tenta uma Fonte 3
 * (`detectDomainMismatchCandidate`) antes de desistir. Ver docstring do
 * bloco Fonte 3 abaixo para o porquê disso ser restrito ao modo cross-edição.
 */
export function isPressCovertageOfHighlight(
  article: Article,
  highlightUrl: string | null,
  options: { crossEditionMode?: boolean } = {},
): boolean {
  if (!highlightUrl) return false;

  // Fonte 1: campo persistido pelo pipeline (quando sobrevive ao scorer).
  let suggestedDomain = article.suggested_primary_domain;

  // Fonte 2 (#2578): re-derivar via detectLaunchCandidate quando o campo foi
  // stripado (não-determinístico — LLM do scorer pode não preservar campos extras).
  // Mesmo critério de enrich-primary-source.ts: verbo de lançamento + empresa.
  if (!suggestedDomain) {
    const det = detectLaunchCandidate(article);
    if (det.is_candidate && det.suggested_domain) {
      suggestedDomain = det.suggested_domain;
    }
  }

  // Fonte 3 (#4262): só em `crossEditionMode` — `detectDomainMismatchCandidate`,
  // que NÃO exige verbo de lançamento no título (só empresa conhecida + URL
  // fora do domínio oficial). Necessário porque no caso cross-edição o
  // candidato costuma ser uma matéria de ANÁLISE/follow-up do lançamento
  // passado ("Claude Opus 5: o que muda no novo modelo"), não o anúncio em
  // si — Fonte 2 nunca dispara aí. Caso real #4262: Exame "Claude Opus 5: o
  // que muda no novo modelo" x destaque passado "Anthropic lança o Claude
  // Opus 5" (anthropic.com) — sem esta fonte, path (c) não encontra nenhum
  // `suggested_primary_domain` pro lado Exame.
  //
  // Restrito a `crossEditionMode`: `detectDomainMismatchCandidate` é
  // deliberadamente mais permissiva (ver docstring em launch-detect.ts) —
  // fora do modo cross-edição isso arriscaria remover itens RADAR legítimos
  // do mesmo dia que só citam uma empresa de passagem. Aqui fica seguro
  // porque path (c) ainda exige um SEGUNDO sinal logo abaixo
  // (`hasEntitySignal || hasJaccardSignal`), e o único caller de
  // `crossEditionMode` (`check-highlight-themes.ts`) é warn-only.
  if (!suggestedDomain && options.crossEditionMode) {
    const det = detectDomainMismatchCandidate(article);
    if (det.is_candidate && det.suggested_domain) {
      suggestedDomain = det.suggested_domain;
    }
  }

  if (!suggestedDomain) return false;

  const hDomain = extractRegistrableDomain(highlightUrl);
  if (!hDomain) return false;

  // #2580: normalizar `suggestedDomain` pelo mesmo alias map do extractRegistrableDomain.
  // `suggested_primary_domain` pode ser "blog.google" (primary_domain do Google em
  // official-domains.ts) — sem normalização, "blog.google" ≠ "google.com" (resultado
  // de cloud.google.com), então o match falharia para destaques em cloud.google.com.
  const normalizedSuggested = normalizeDomainForMatch(suggestedDomain);
  return hDomain === normalizedSuggested;
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
 * (suggested_primary_domain="blog.google") + D1 blog.google.com/gemini-computer-use.
 *
 * #2587: domain-match sozinho NÃO é suficiente — dois lançamentos DIFERENTES da
 * mesma empresa (D1=Google A + RADAR=Google B) compartilham o domínio sem ser o
 * mesmo evento. Exige um SEGUNDO SINAL, conforme a issue:
 *   (≥1 entidade-de-PRODUTO compartilhada além do nome da empresa)
 *   OR (Jaccard de título ≥ INTRA_DOMAIN_JACCARD_MIN).
 * O caminho de entidade (via `extractProductEntitiesIntra`) é o que faz o caso
 * real do #2548 passar sem trapaça: D1 inglês + RADAR português têm Jaccard ~0,
 * mas ambos citam o produto ("Gemini") → entidade compartilhada → mesmo evento.
 *
 * #4262: `options.crossEditionMode` — quando true, habilita dois sinais
 * ADICIONAIS calibrados especificamente pra comparar candidato-a-destaque da
 * edição corrente contra o CORPO INTEIRO (não só destaques) de edições
 * PASSADAS, onde o gap de paráfrase é maior que intra-edição no mesmo dia:
 *   - (c) ganha uma 3ª fonte de `suggested_primary_domain` via
 *     `detectDomainMismatchCandidate` (sem exigir verbo de lançamento).
 *   - (f) novo path: termos de conteúdo compartilhados (ver
 *     `CROSS_EDITION_TERM_MIN_LEN`/`CROSS_EDITION_TERM_MIN_SHARED`), fallback
 *     de último recurso quando nenhum sinal anterior disparou.
 * Ambos OFF por default (comportamento de produção do dedup intra-edição
 * inalterado) — só `check-highlight-themes.ts` liga `crossEditionMode`.
 *
 * @returns match info se duplicata, null caso contrário.
 */
export function isIntraEditionDuplicate(
  article: Article,
  highlights: HighlightEntry[],
  options: {
    jaccardThreshold?: number;
    entityMinShared?: number;
    /** #4262: ver docstring acima. Default false — inalterado pro dedup intra-edição de produção. */
    crossEditionMode?: boolean;
  } = {},
): {
  match_type:
    | "jaccard"
    | "entity"
    | "domain"
    | "cross_vehicle"
    | "product_code"
    | "content_terms";
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
  // #2587: entidades de PRODUTO (inclui Gemini/GPT, exclui só empresa+genéricos)
  // pro segundo-sinal do domain-match — capturadas 1× fora do loop.
  const artProductEntities = extractProductEntitiesIntra(artTitle);

  for (const h of highlights) {
    const hTitle = highlightTitle(h);
    if (!hTitle) continue;

    // Skip exact-same URL (destaque pode aparecer no bucket também — não é intra-dup)
    const hUrl = highlightUrl(h);
    if (hUrl && article.url === hUrl) continue;

    // (a) + (c) — computar Jaccard e domain-match antes da decisão.
    // Jaccard é necessário tanto para o check (a) quanto como segundo sinal do (c).
    const hTokens = tokenizeForJaccard(stripVehicleSuffix(hTitle));
    const jaccard = jaccardSimilarity(artTokens, hTokens);

    // (c) #2548 Furo 2: domain-based match via suggested_primary_domain.
    // O campo suggested_primary_domain só existe quando enrich-primary-source detectou
    // verbo de lançamento + empresa conhecida no título RADAR. Se o domínio oficial
    // bate com o domínio do destaque, o item PODE ser cobertura de imprensa.
    //
    // #2587: domain-match sozinho é insuficiente — dois lançamentos DIFERENTES
    // da mesma empresa ("Google lança produto A" + "Google lança produto B")
    // compartilham o domínio mas não são o mesmo evento. Exige um SEGUNDO SINAL
    // de mesmo-lançamento, exatamente como a issue pede:
    //   (≥1 entidade-de-PRODUTO compartilhada além do nome da empresa)
    //   OR (Jaccard de título ≥ INTRA_DOMAIN_JACCARD_MIN).
    // O caminho de entidade-de-produto é o que faz o caso real do #2548 passar
    // SEM trapaça: D1 em inglês + RADAR em português têm Jaccard ~0, mas ambos
    // citam o produto ("Gemini") → entidade compartilhada → mesmo evento.
    if (isPressCovertageOfHighlight(article, hUrl, { crossEditionMode: options.crossEditionMode })) {
      const hProductEntities = extractProductEntitiesIntra(hTitle);
      const sharedProduct = [...artProductEntities].filter((e) =>
        hProductEntities.has(e),
      );
      const hasEntitySignal = sharedProduct.length >= 1;
      const hasJaccardSignal = jaccard >= INTRA_DOMAIN_JACCARD_MIN;
      if (hasEntitySignal || hasJaccardSignal) {
        return {
          match_type: "domain",
          matched_highlight: hTitle,
          // Score reflete a força do segundo sinal (não 1.0 fixo): entidade de
          // produto compartilhada → 1.0; senão o Jaccard que disparou.
          score: hasEntitySignal ? 1.0 : jaccard,
        };
      }
    }

    // (a) Jaccard sobre tokens normalizados (sufixo de veículo já stripado)
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

    // (d) #3099: cross-vehicle cobertura da MESMA empresa/evento quando nem
    // Jaccard nem domain-match capturam — cenário em que AMBOS os lados são
    // cobertura de imprensa (nenhum é a página oficial do lançamento), então
    // (c) não se aplica, e a tradução PT/EN diverge o vocabulário o
    // suficiente pra Jaccard (a) ficar abaixo do threshold. O entity-match (b)
    // também falha porque o nome da empresa é justamente excluído ali
    // (COMPANY_STOPWORDS_INTRA) por não discriminar sozinho.
    //
    // Caso real 260708: D2 "DeepSeek prepara chip de IA para reduzir
    // dependência da NVIDIA, revela portal" (canaltech) + RADAR "Chinesa
    // DeepSeek está desenvolvendo o próprio chip de IA, dizem fontes" (CNN
    // Brasil) — Jaccard ≈ 0.14 (abaixo de 0.45), 0 entidades no entity-match
    // geral (DeepSeek/NVIDIA são stopword de empresa). Sinal: MESMA empresa
    // citada nos dois títulos (`extractCompanyMentionsIntra`, que inclui
    // companhia de propósito) + ≥1 token de tópico compartilhado além da
    // empresa (ex: "chip") via `tokenizeForJaccard`, excluindo verbos de
    // atribuição/substantivos genéricos (TOPIC_TOKEN_STOPWORDS_INTRA) — mesmo
    // padrão de segundo-sinal do domain-match (#2587), aplicado aqui sem
    // exigir `suggested_primary_domain`.
    const artCompanies = extractCompanyMentionsIntra(artTitle);
    const hCompanies = extractCompanyMentionsIntra(hTitle);
    const sharedCompanies = [...artCompanies].filter((c) => hCompanies.has(c));
    if (sharedCompanies.length >= 1) {
      const sharedTopicTokens = [...artTokens].filter(
        (t) =>
          hTokens.has(t) &&
          !sharedCompanies.includes(t) &&
          !TOPIC_TOKEN_STOPWORDS_INTRA.has(t),
      );
      if (sharedTopicTokens.length >= 1) {
        return {
          match_type: "cross_vehicle",
          matched_highlight: hTitle,
          score: sharedTopicTokens.length / Math.max(artTokens.size, hTokens.size, 1),
        };
      }
    }

    // (e) #4185: código/versão de produto compartilhado (título+summary) +
    // QUALQUER entidade nomeada compartilhada (não restrita à lista fixa de
    // gigantes de IA usada em (b)/(d)). Empresas fora dessa lista — bancos,
    // varejistas, etc. cobrindo lançamento de IA próprio — não tinham NENHUM
    // caminho de match quando o nome distintivo do produto só aparece no
    // corpo da matéria, não na manchete (ver docstring de
    // `extractProductCodeTokens` pro caso real que motivou este item).
    //
    // Exige AMBOS os sinais (AND, não OR) pra manter falso-positivo baixo:
    // um código de produto sozinho pode aparecer em textos sem relação
    // alguma (menção de passagem a um concorrente); uma entidade
    // compartilhada sozinha já é o entity-match (b), calibrado a exigir 2
    // justamente pra não confundir 2 histórias DIFERENTES da mesma empresa.
    // A combinação (entidade comum + código de produto EXATO comum) é mais
    // restritiva que qualquer um dos dois sozinho — um codinome de produto
    // ("ia.i") repetido ao lado do mesmo nome próprio em textos diferentes
    // é, na prática, sempre o mesmo evento (ver docstring de
    // `extractProductCodeTokens` sobre a exigência deliberada de letra
    // inicial — números de versão soltos como "3.1" não contam sozinhos).
    const artProductCodes = extractProductCodeTokens(
      `${artTitle} ${article.summary ?? ""}`,
    );
    if (artProductCodes.size > 0 && artEntities.size > 0) {
      const hProductCodes = extractProductCodeTokens(
        `${hTitle} ${highlightSummary(h) ?? ""}`,
      );
      const sharedProductCodes = [...artProductCodes].filter((t) =>
        hProductCodes.has(t),
      );
      const sharedEntitiesForCode = [...artEntities].filter((e) =>
        hEntities.has(e),
      );
      if (sharedProductCodes.length >= 1 && sharedEntitiesForCode.length >= 1) {
        return {
          match_type: "product_code",
          matched_highlight: hTitle,
          score: sharedProductCodes.length,
        };
      }
    }

    // (f) #4262: termos de conteúdo compartilhados — só em `crossEditionMode`.
    // Fallback de ÚLTIMO recurso (roda por último, só quando nenhum path
    // acima disparou): pega o caso onde a história-repetida não tem empresa
    // de IA citada (path d não se aplica) e as palavras discriminantes
    // ("professor", "alunos") não são capitalizadas no título real — o
    // entity-match (b), que depende de heurística de capitalização, não vê
    // nenhuma entidade em pelo menos um dos lados. Ver docstring de
    // `CROSS_EDITION_TERM_MIN_LEN`/`CROSS_EDITION_TERM_MIN_SHARED`.
    if (options.crossEditionMode) {
      const isContentTerm = (t: string) =>
        t.length >= CROSS_EDITION_TERM_MIN_LEN && !TOPIC_TOKEN_STOPWORDS_INTRA.has(t);
      const hContentTerms = new Set([...hTokens].filter(isContentTerm));
      const sharedContentTerms = [...artTokens].filter(
        (t) => isContentTerm(t) && hContentTerms.has(t),
      );
      if (sharedContentTerms.length >= CROSS_EDITION_TERM_MIN_SHARED) {
        return {
          match_type: "content_terms",
          matched_highlight: hTitle,
          score: sharedContentTerms.length / Math.max(artTokens.size, hTokens.size, 1),
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main dedup function
// ---------------------------------------------------------------------------

// SECONDARY_BUCKETS is imported from check-secondary-themes.ts (single source of truth).

/**
 * Default number of top highlights to compare against in intra-edition dedup.
 * #2397: scorer returns 6 candidates; editor selects top 3 at Stage 1 gate.
 * Comparing against all 6 removes items that match rank-4..6 candidates
 * (which the editor will NOT promote), causing false removals pre-gate.
 * Default: 3 (standard edition). Can be overridden via --destaque-count N.
 */
export const DEFAULT_INTRA_DESTAQUE_COUNT = 3;

/**
 * #4667: buckets secundários onde `dedupSecondaryIntraBucket` roda a
 * consolidação item-vs-item (além do destaque-vs-bucket já feito pelo loop
 * principal). `lancamento` está aqui desde o #4360; `radar` foi adicionado
 * pelo #4667 — maior volume (~30-40 itens/edição) e maior taxa observada de
 * notícia "quente" do dia coberta por 3-4 veículos brasileiros simultâneos
 * (outage, desativação de produto, etc.).
 *
 * `use_melhor`/`video` deliberadamente FORA por enquanto — a issue #4667 não
 * trouxe caso real para esses buckets (menor volume, cobertura menos
 * duplicada na prática); adicionar aqui quando houver evidência concreta,
 * mesmo mecanismo, sem precisar tocar `dedupIntraEdition`.
 */
export const INTRA_BUCKET_DEDUP_BUCKETS: readonly string[] = ["lancamento", "radar"];

/**
 * #4185: anexa `article` como `cluster_sources[]` do destaque (highlight
 * CLONE — nunca o original de `input`) que ele duplicou intra-edição. Mesma
 * semântica do `foldCluster` de `scripts/lib/cluster-sources.ts` (#3920),
 * aplicada aqui no ponto destaque-vs-pool (pós-scorer) em vez de no pool
 * bruto pré-categorização. Sem isso, um item removido do RADAR/LANÇAMENTOS
 * por duplicar um destaque simplesmente desaparece — não chega ao
 * `writer-destaque` (que só recebe `destaque.article` + `cluster_sources[]`,
 * ver `.claude/agents/orchestrator-stage-2.md` §2a), e os fatos que só
 * existem naquela cobertura secundária ficam inacessíveis — a raiz do
 * problema relatado na #4185 (contaminação cruzada de fonte ao tentar
 * enriquecer o destaque manualmente com um fato de uma URL não citada).
 *
 * Suporta os dois shapes de `HighlightEntry`: `{ article: {...} }` (formato
 * real de `01-categorized.json > highlights[]`) e flat `{ url, title,
 * cluster_sources? }` (formato usado em testes/shapes legados). Idempotente
 * (dedup por URL, mesmo padrão de `foldCluster`).
 */
function attachClusterSource(h: HighlightEntry, article: Article): void {
  const target = (h.article ?? h) as unknown as {
    cluster_sources?: ClusterSource[];
  };
  const existing = Array.isArray(target.cluster_sources)
    ? target.cluster_sources
    : [];
  if (existing.some((c) => c.url === article.url)) return;
  target.cluster_sources = [
    ...existing,
    toClusterSource(article as unknown as ClusterArticle),
  ];
}

// ---------------------------------------------------------------------------
// #4360/#4667: dedup DENTRO de um bucket secundário (item-vs-item, não
// destaque-vs-bucket). Nasceu específico de LANÇAMENTOS (#4360); generalizado
// pelo #4667 para rodar também sobre RADAR — a função já era bucket-agnostic
// na prática (recebe só `Article[]`, sem saber de qual bucket veio; já era
// reusada contra `radar[]` em `validate-lancamentos.ts` desde o #4386), o gap
// real era só o call site em `dedupIntraEdition`, cabeado só para `lancamento`.
// ---------------------------------------------------------------------------

/**
 * #4360: página de MODEL CARD / hub — tipicamente specs técnicas sem prosa
 * descritiva, ao contrário de um post oficial de blog (que tem lead/resumo).
 * Usado como critério de desempate em `dedupSecondaryIntraBucket`: quando 2
 * itens cobrem o MESMO lançamento, o post de blog (com descrição) é
 * preferido sobre a página de model-card/hub (sem descrição).
 *
 * Caso real (#4360, edição 260731): "Gemini Robotics ER 2" tinha 2 entradas em
 * LANÇAMENTOS — `deepmind.google/models/model-cards/...` (model card, sem
 * descrição) e `blog.google/.../gemini-robotics-er-2...` (post oficial, com
 * descrição) — mesmo lançamento, o dedup intra-edição existente (destaque-vs-
 * bucket) não capturava porque NENHUM dos 2 era destaque.
 */
const MODEL_CARD_PATH_RE = /\/models?\/model-cards?\//i;

const HUGGINGFACE_NON_MODEL_SEGMENTS = new Set([
  "blog",
  "papers",
  "learn",
  "spaces",
  "datasets",
  "docs",
]);

export function isModelCardOrHubPage(url: string): boolean {
  try {
    const u = new URL(url);
    if (MODEL_CARD_PATH_RE.test(u.pathname)) return true;
    // huggingface.co/{org}/{model} — página de model card (não /blog/, /papers/, etc).
    if (u.hostname.replace(/^www\./, "") === "huggingface.co") {
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length >= 1 && !HUGGINGFACE_NON_MODEL_SEGMENTS.has(segs[0].toLowerCase())) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export interface SecondaryIntraBucketResult {
  kept: Article[];
  removed: Array<{ url: string; title?: string; consolidated_into: string }>;
  /** #4695: itens `flag: "editor_submitted"` que casariam como duplicata de
   *  outro item do MESMO bucket (candidato a `dropped`) mas foram poupados
   *  incondicionalmente. Ver docstring de `IntraEditionDedupResult.editorSubmittedLost`. */
  editorSubmittedSpared: Array<{ url: string; title?: string; matched_against: string }>;
}

/**
 * #4360, generalizado pelo #4667: consolida duplicatas DENTRO de um bucket
 * secundário — 2+ URLs distintas cobrindo o MESMO produto/lançamento/evento
 * (ex: model-card + post oficial de blog em LANÇAMENTOS; 3 veículos cobrindo
 * a mesma notícia do dia em RADAR). `dedupIntraEdition`/`isIntraEditionDuplicate`
 * só comparam bucket-vs-HIGHLIGHTS — nunca item-vs-item dentro do mesmo bucket
 * secundário — então o caso real (#4360, depois #4667 para RADAR) em que os
 * itens estavam SIMULTANEAMENTE fora dos destaques nunca era comparado um com
 * o outro. A função é agnóstica de bucket (só recebe `Article[]`) — quem
 * decide QUAL bucket rodar é o caller (`dedupIntraEdition` via
 * `INTRA_BUCKET_DEDUP_BUCKETS`, ou `validate-lancamentos.ts` contra `radar[]`
 * cheio pós-demote, #4386).
 *
 * Sinal de "mesmo evento": Jaccard de título ≥ threshold OU ≥1 entidade de
 * PRODUTO compartilhada (`extractProductEntitiesIntra` — inclui nome de
 * modelo, exclui empresa/genéricos). Em caso de match, mantém o item com
 * `summary` não-vazio; se ambos (ou nenhum) têm summary, prefere o que NÃO é
 * model-card/hub page (`isModelCardOrHubPage`). Empate residual: mantém o
 * primeiro da lista (ordem estável).
 *
 * **`options.strict` (#4675 review, fix de regressão do #4667):** o
 * caminho "≥1 entidade de PRODUTO compartilhada" foi calibrado para
 * LANÇAMENTOS, onde TODO item já é por definição um lançamento — então
 * "mesmo produto citado" implica "mesmo lançamento" sem precisar de mais
 * nada. RADAR não tem essa garantia (~30-40 notícias gerais/dia) e, ao
 * contrário do segundo-sinal de `isIntraEditionDuplicate` (#2587), aqui não
 * existe gate de domínio (`isPressCovertageOfHighlight`) confirmando que os
 * 2 itens já são sobre a MESMA empresa/lançamento antes de aceitar a
 * entidade sozinha — então 2 notícias DIFERENTES sobre o mesmo produto
 * flagship (ex: "ChatGPT banido em escolas" x "ChatGPT ganha novo modo de
 * voz"; "Gemini fica instável" x "Google testa recurso do Gemini")
 * consolidavam incorretamente. Com `strict: true` (usado por
 * `dedupIntraEdition` para todo bucket ≠ `lancamento`), o caminho de
 * entidade-sozinha é DESLIGADO — só Jaccard conta, contra
 * `SECONDARY_INTRA_BUCKET_STRICT_JACCARD_THRESHOLD` (mais permissivo que o
 * default 0.45, calibrado contra o par mais fraco dos 2 clusters reais da
 * #4667 — "Claude caiu", mínimo par-a-par ≈0.167 — com margem folgada abaixo
 * dos pares falso-positivo observados, ≈0.06–0.08). Default `false`
 * preserva o comportamento original para LANÇAMENTOS e para o call site de
 * `validate-lancamentos.ts` (que roda contra `radar[]` mas em contexto
 * onde os itens recém-demovidos SÃO lançamento por origem, #4386).
 *
 * Pure function — não muta `articles`.
 */
export function dedupSecondaryIntraBucket(
  articles: Article[],
  options: { jaccardThreshold?: number; strict?: boolean } = {},
): SecondaryIntraBucketResult {
  const jThreshold =
    options.jaccardThreshold ??
    (options.strict ? SECONDARY_INTRA_BUCKET_STRICT_JACCARD_THRESHOLD : INTRA_JACCARD_THRESHOLD);
  const removedUrls = new Set<string>();
  const removed: SecondaryIntraBucketResult["removed"] = [];
  const editorSubmittedSpared: SecondaryIntraBucketResult["editorSubmittedSpared"] = [];

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    if (removedUrls.has(a.url) || !a.title) continue;
    for (let j = i + 1; j < articles.length; j++) {
      const b = articles[j];
      if (removedUrls.has(b.url) || removedUrls.has(a.url) || !b.title) continue;
      if (a.url === b.url) continue;

      const aTokens = tokenizeForJaccard(stripVehicleSuffix(a.title));
      const bTokens = tokenizeForJaccard(stripVehicleSuffix(b.title));
      const jaccard = jaccardSimilarity(aTokens, bTokens);

      // #4675 review: em modo `strict` (buckets ≠ lancamento), o caminho de
      // entidade-sozinha fica fora do critério — só Jaccard decide. Evita
      // recalcular `extractProductEntitiesIntra` à toa quando strict (e,
      // como efeito colateral, neutraliza pra RADAR o bug separado de
      // `extractProductEntitiesIntra` não pular o índice 0 — a 1ª palavra
      // maiúscula de início de frase não pode mais, sozinha, virar match).
      const sharedProduct = options.strict
        ? []
        : (() => {
            const aProductEntities = extractProductEntitiesIntra(a.title);
            const bProductEntities = extractProductEntitiesIntra(b.title);
            return [...aProductEntities].filter((e) => bProductEntities.has(e));
          })();

      const isSameLaunch = jaccard >= jThreshold || sharedProduct.length >= 1;
      if (!isSameLaunch) continue;

      // #4695: se QUALQUER um dos dois lados é submissão do editor, a dupla
      // inteira é poupada — nenhum dos dois é removido, mesmo que o outro
      // lado NÃO seja editor_submitted. Mesmo precedente do `dedup.ts` Pass
      // 1d (#4192): a curadoria do editor prevalece sobre o dedup mecânico.
      // Reporta em `editorSubmittedSpared` pra visibilidade no gate (item 4c)
      // em vez de descartar silenciosamente em stderr.
      const aIsEditorSubmitted = a.flag === "editor_submitted";
      const bIsEditorSubmitted = b.flag === "editor_submitted";
      if (aIsEditorSubmitted || bIsEditorSubmitted) {
        const editorItem = aIsEditorSubmitted ? a : b;
        const otherItem = aIsEditorSubmitted ? b : a;
        editorSubmittedSpared.push({
          url: editorItem.url,
          title: editorItem.title,
          matched_against: otherItem.url,
        });
        continue;
      }

      // Desempate: preferir item com summary/descrição não-vazia; senão,
      // preferir o que NÃO é model-card/hub page; senão, manter o primeiro.
      const aHasSummary = !!(a.summary && a.summary.trim().length > 0);
      const bHasSummary = !!(b.summary && b.summary.trim().length > 0);

      let keepA: boolean;
      if (aHasSummary !== bHasSummary) {
        keepA = aHasSummary;
      } else {
        const aIsModelCard = isModelCardOrHubPage(a.url);
        const bIsModelCard = isModelCardOrHubPage(b.url);
        keepA = aIsModelCard !== bIsModelCard ? !aIsModelCard : true;
      }

      const dropped = keepA ? b : a;
      const kept = keepA ? a : b;
      removedUrls.add(dropped.url);
      removed.push({ url: dropped.url, title: dropped.title, consolidated_into: kept.url });
      if (!keepA) break; // `a` foi descartado — não compará-lo contra os próximos j
    }
  }

  return {
    kept: articles.filter((a) => !removedUrls.has(a.url)),
    removed,
    editorSubmittedSpared,
  };
}

/**
 * Aplica dedup intra-edição ao JSON de categorized.
 * Remove dos buckets secundários itens que duplicam um destaque.
 *
 * #2397: compara contra top-`destaqueCount` highlights por rank (default 3),
 * não contra todos os 6 candidatos do scorer. Evita remoção pré-gate de itens
 * que seriam legítimos se o editor não promover o candidato rank 4–6.
 *
 * #4185: todo item removido por duplicar um destaque é preservado como
 * `cluster_sources[]` NAQUELE destaque (ver `attachClusterSource`) — não é
 * mais um descarte silencioso. O destaque some do output como cópia
 * ENRIQUECIDA (nunca a referência original de `input`).
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
  const editorSubmittedLost: IntraEditionDedupResult["editorSubmittedLost"] = [];

  // #4185: clona os highlights candidatos ANTES de qualquer mutação — a
  // função permanece pure (não muta `input`); as cópias substituem os
  // originais no `kept` final, preservando ordem/campos.
  const highlightClones = new Map<HighlightEntry, HighlightEntry>();
  for (const h of highlights) {
    const clone: HighlightEntry = { ...h };
    if (h.article) clone.article = { ...h.article };
    highlightClones.set(h, clone);
  }

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
        // #4185: preserva o artigo como cluster_sources[] no destaque
        // (clone) que ele duplicou, em vez de só descartá-lo. #4228 já
        // garantia que o marcador `flag: "editor_submitted"` sobrevive
        // nesse fold (`toClusterSource` preserva o campo) — o conteúdo da
        // submissão do editor não desaparece, vira material de apoio do
        // destaque que o `writer-destaque` de fato lê. Por isso este passe
        // NÃO exime a remoção do bucket (diferente do passe item-vs-item
        // abaixo, que não tem fold equivalente): remover exigiria descartar
        // um mecanismo de resgate já testado (#4228) por um pior (deixar o
        // item duplicado solto no bucket).
        const matchedHighlight = highlights.find(
          (h) => highlightTitle(h) === match.matched_highlight,
        );
        if (matchedHighlight) {
          attachClusterSource(highlightClones.get(matchedHighlight)!, article);
        }
        // #4695: mesmo sendo uma remoção "boa" (rescatada via cluster_sources,
        // não um descarte cru), o gate nunca soube disso — só ia pro stderr.
        // Reporta em `editorSubmittedLost` pra visibilidade (item 4c), com o
        // mesmo shape usado pelo passe item-vs-item (onde a exemção É
        // incondicional porque não existe fold equivalente lá).
        if (article.flag === "editor_submitted") {
          editorSubmittedLost.push({
            url: article.url,
            title: article.title,
            bucket,
            ...match,
          });
        }
      } else {
        bucketKept.push(article);
      }
    }

    keptBuckets[bucket] = bucketKept;
  }

  // #4360/#4667: consolida duplicatas DENTRO de um bucket secundário
  // (item-vs-item, não destaque-vs-bucket como o loop acima) — caso em que
  // 2+ URLs distintas cobrem o MESMO evento e NENHUMA delas é destaque, então
  // o loop acima nunca as compara umas com as outras. Nasceu restrito a
  // LANÇAMENTOS (#4360); generalizado pelo #4667 para rodar também sobre
  // RADAR (maior volume da edição e maior taxa observada de multi-fonte
  // cobrindo o mesmo fato do dia — ver `INTRA_BUCKET_DEDUP_BUCKETS`).
  for (const bucket of INTRA_BUCKET_DEDUP_BUCKETS) {
    const bucketAfterHighlightPass = keptBuckets[bucket] ?? [];
    if (bucketAfterHighlightPass.length <= 1) continue;

    // #4675 review: `strict` liga o modo mais conservador (só Jaccard, sem
    // o caminho de entidade-sozinha) pra todo bucket que não seja
    // `lancamento` — hoje, na prática, só `radar`. Ver docstring de
    // `dedupSecondaryIntraBucket`.
    const {
      kept: bucketKept,
      removed: bucketRemoved,
      editorSubmittedSpared: bucketSpared,
    } = dedupSecondaryIntraBucket(bucketAfterHighlightPass, {
      ...options,
      strict: bucket !== "lancamento",
    });
    if (bucketRemoved.length > 0) {
      keptBuckets[bucket] = bucketKept;
      for (const r of bucketRemoved) {
        removed.push({
          url: r.url,
          title: r.title,
          bucket,
          match_type: "intra_bucket",
          matched_highlight: r.consolidated_into,
          score: 1,
        });
      }
    }
    // #4695: item-vs-item também poupa editor_submitted incondicionalmente
    // (ver `dedupSecondaryIntraBucket`) — reporta pra visibilidade no gate.
    for (const s of bucketSpared) {
      editorSubmittedLost.push({
        url: s.url,
        title: s.title,
        bucket,
        match_type: "intra_bucket",
        matched_highlight: s.matched_against,
        score: 1,
      });
    }
  }

  // #4185: reconstrói highlights[] substituindo o top-N (possivelmente
  // enriquecido com cluster_sources[]) pelas cópias; entradas fora do
  // top-N (rank 4+) passam intactas, mesma ordem original. Só grava a chave
  // quando `input.highlights` já existia — preserva a semântica anterior de
  // "ausente continua ausente" (spread não inventava a chave).
  const kept: CategorizedWithHighlights = {
    ...input,
    ...keptBuckets,
    ...(input.highlights !== undefined
      ? { highlights: allHighlights.map((h) => highlightClones.get(h) ?? h) }
      : {}),
  };

  return { kept, removed, editorSubmittedLost };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { in: string; out: string; destaqueCount: number } {
  const parsed = parseArgsSimple(argv);
  const inPath = parsed["in"] ?? "";
  const outPath = parsed["out"] ?? "";

  // --destaque-count consome o próximo token incondicionalmente (mesmo se
  // ausente, no fim do array) para preservar o fail-fast original: sem
  // valor -> parseInt(undefined) -> NaN -> throw abaixo (#2834 fix-round).
  let destaqueCount = DEFAULT_INTRA_DESTAQUE_COUNT;
  const dcIdx = argv.lastIndexOf("--destaque-count");
  if (dcIdx !== -1) {
    destaqueCount = parseInt(argv[dcIdx + 1], 10);
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
  const { kept, removed, editorSubmittedLost } = dedupIntraEdition(input, {
    destaqueCount: args.destaqueCount,
  });

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

  // #4695: submissão(ões) do editor que bateram um critério de duplicata mas
  // NUNCA foram descartadas em silêncio — viram cluster_sources[] do destaque
  // (match destaque-vs-bucket) ou permanecem no bucket (match item-vs-item,
  // sem fold equivalente). Antes desta issue, esses casos só apareciam em
  // stderr — sem arquivo, sem stats, sem gate.
  if (editorSubmittedLost.length > 0) {
    process.stderr.write(
      `⚠️ [dedup-intra-edition] ${editorSubmittedLost.length} submissão(ões) sua(s) bateram um critério de duplicata mas o conteúdo foi preservado (#4695):\n`,
    );
    for (const r of editorSubmittedLost) {
      process.stderr.write(
        `  [${r.bucket}] ${r.title ?? r.url} — ${r.match_type} → "${r.matched_highlight}"\n`,
      );
    }
  }

  writeFileSync(resolve(args.out), JSON.stringify(kept, null, 2), "utf8");

  // #4695: sidecar de stats junto do --out (mesmo padrão de
  // `topic-cluster-stats.json`, ver orchestrator-stage-1-research.md 1n) —
  // `--out` sobrescreve `01-categorized.json` in-place com só `kept`, então
  // `removed`/`editorSubmittedLost` precisam de um arquivo próprio pro gate
  // (item 4c) conseguir ler sem depender do stderr desta invocação.
  const statsPath = resolve(dirname(resolve(args.out)), "dedup-intra-edition-stats.json");
  writeFileSync(
    statsPath,
    JSON.stringify({ removed, editorSubmittedLost }, null, 2),
    "utf8",
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
