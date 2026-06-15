/**
 * audience-affinity.ts (#2063)
 *
 * Pré-computa deterministicamente a afinidade de um artigo `use_melhor` com o
 * perfil de audiência da Diar.ia (princípio #1111 — determinístico onde der).
 *
 * Fontes de sinal (em ordem de confiabilidade):
 *   1. CTR por categoria de `data/link-ctr-table.csv` via `parseCtrFromCsv`
 *      (comportamental — primário).
 *   2. Stack declarado no survey via `data/audience-raw.json`
 *      (declarativo — secundário).
 *
 * Quando os dados não estão disponíveis (worktree sem `data/`, CI, testes),
 * o fallback gracioso retorna `null` — os agentes scorers mantêm o
 * comportamento atual sem anotação.
 *
 * Freshness check (#2063 item 2): se o arquivo de audiência tiver mtime > 30
 * dias, emite warning no stderr (via `scripts/lib/mtime.ts`) mas nunca bloqueia.
 *
 * Uso (integrado em `split-articles-for-scoring.ts` antes do scorer):
 *   import { annotateAudienceAffinity, loadAudienceSignals } from './lib/audience-affinity.ts';
 *   const signals = loadAudienceSignals();
 *   for (const article of use_melhor_articles) {
 *     article.audience_affinity = annotateAudienceAffinity(article, signals);
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mtimeMs } from "./mtime.ts";
import { parseCtrFromCsv } from "../update-audience.ts";
import { isTutorialAcademy, hasHowToBrSignal } from "./use-melhor-curation.ts"; // #2276 #2278

export const AUDIENCE_AFFINITY_FRESHNESS_DAYS = 30;
const MS_PER_DAY = 86_400_000;

// Paths relativos à raiz do repo (resolvidos no loadAudienceSignals).
const RELATIVE_CTR_CSV = "data/link-ctr-table.csv";
const RELATIVE_SURVEY_JSON = "data/audience-raw.json";

// ─── Tipos públicos ────────────────────────────────────────────────────────────

/**
 * Anotação de afinidade gravada em cada artigo `use_melhor`.
 *
 * - `affinity` — [0, 1] onde 1 = máxima afinidade.
 *   Calculado como (CTR_relativo × 0.6) + (survey_match × 0.4), ambos
 *   normalizados 0-1 (ver implementação).
 * - `matched` — lista de sinais que contribuíram (para explicabilidade / `reason`
 *   dos agentes scorers). Inclui `"hands_on:true"` quando detectado (#2143).
 * - `hands_on` — sinal "hands-on curto" detectado deterministicamente (#2143).
 *   `true` quando o artigo tem ≥2 sinais de tutorial hands-on (passos numerados,
 *   tempo estimado, setup mínimo, ferramenta consumer PT-BR/casual). Quando
 *   `true`, o scorer deve adicionar +8 pontos ao score do artigo (ver rubrica
 *   em scorer.md e scorer-chunk.md). Sinal puro de texto — não depende de dados
 *   de audiência. Computado dentro de `annotateAudienceAffinity`, portanto **não**
 *   disponível quando `signals.loaded === false` (retorno `null`). Se hands_on
 *   independente de dados de audiência for necessário, chamar `detectHandsOnShort`
 *   diretamente.
 *
 * O campo é `null` quando não há dados de audiência disponíveis — o scorer
 * ignora a anotação nesse caso (comportamento pré-#2063).
 */
export interface AudienceAffinity {
  affinity: number; // 0..1
  matched: string[]; // ex: ["categoria:Treinamento", "categoria:Ferramenta", "tool:ChatGPT", "hands_on:true"]
  hands_on: boolean; // sinal determinístico de tutorial hands-on curto (#2143)
}

/**
 * Descreve a origem dos sinais carregados em `AudienceSignals`.
 *
 * - `"ctr+survey"` — CTR comportamental + respostas reais de survey.
 * - `"ctr"`        — Só CTR; survey ausente ou sem respostas de ferramenta.
 * - `"survey"`     — Só survey; CTR ausente ou vazio.
 * - `"fallback"`   — Survey presente mas sem respostas de ferramenta →
 *                    `surveyTools` usa KNOWN_TOOLS como substituto. O survey
 *                    score NÃO é usado no cálculo de affinity neste caso
 *                    (ver `annotateAudienceAffinity`).
 * - `"none"`       — Nenhuma fonte disponível; `loaded === false`.
 */
export type AudienceSignalsSource = "ctr+survey" | "ctr" | "survey" | "fallback" | "none";

/**
 * Sinais de audiência pré-carregados — reutilizáveis por múltiplos artigos
 * sem I/O por artigo.
 */
export interface AudienceSignals {
  /** CTR relativo por categoria (normalizado: 1.0 = CTR médio). */
  ctrByCategory: Map<string, number>;
  /** CTR médio absoluto (para calcular relativo). */
  avgCtr: number;
  /** Ferramentas / tópicos declarados no survey (lowercase, normalizado). */
  surveyTools: Set<string>;
  /**
   * Origem dos dados. Derivar comportamento de scoring a partir daqui:
   * - `"fallback"` → surveyTools é KNOWN_TOOLS estático, não usar para score.
   * - `"none"`     → loaded === false, annotateAudienceAffinity retorna null.
   */
  source: AudienceSignalsSource;
  /**
   * Atalho: `source !== "none"`. Mantido por retrocompatibilidade com callers
   * que checam `signals.loaded` diretamente.
   */
  loaded: boolean;
}

// ─── Normalização de ferramentas ───────────────────────────────────────────────

/**
 * Ferramentas/termos do stack de IA conhecidos pelos readers da Diar.ia.
 * Derivados do survey (`audience-raw.json` section "ferramentas") e do
 * CTR histórico. Mantido conservador — falso-positivo em afinidade é
 * menos prejudicial que falso-negativo.
 *
 * NOTA: esta lista é estática e complementa a extração dinâmica do survey.
 * Fontes dinâmicas têm prioridade; esta lista serve de base mínima quando o
 * survey não contém respostas de ferramentas.
 */
export const KNOWN_TOOLS: readonly string[] = [
  // Modelos / APIs
  "chatgpt", "gpt", "openai", "claude", "anthropic", "gemini", "google",
  "llama", "mistral", "deepseek", "grok", "copilot",
  // Ferramentas de dev
  "cursor", "github", "huggingface", "langchain", "langgraph",
  "rag", "embeddings", "vector", "pinecone", "weaviate", "chroma",
  "agents", "agentes",
  // Plataformas de uso
  "notion", "figma", "midjourney", "stable diffusion", "runway",
  "perplexity", "replit", "bolt", "v0",
  // Termos genéricos de IA aplicada
  "prompt", "fine-tuning", "training", "treinamento",
  "inference", "inferência", "deployment",
];

/**
 * Normaliza um token de ferramenta para comparação (lowercase, sem acentos
 * básicos). Não usa Intl.Collate pra ser compatível com Node < 22 sem icu.
 */
export function normalizeTool(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrai ferramentas mencionadas em respostas de survey.
 *
 * O survey Beehiiv tem perguntas abertas ("Quais ferramentas de IA você usa?").
 * Esta função extrai tokens plausíveis das respostas, filtrando por KNOWN_TOOLS
 * para evitar ruído.
 *
 * Regra de admissão: um token `tok` é aceito se:
 *   (a) é exatamente igual a um KNOWN_TOOL normalizado, OU
 *   (b) CONTÉM um KNOWN_TOOL normalizado como palavra completa (ex: "chatgpt4"
 *       contém "chatgpt" como prefixo intacto).
 *
 * A check anterior (`KNOWN_TOOLS.some(k => normalizeTool(k).includes(tok))`)
 * estava invertida — admitia tokens curtos como "not" porque "notion".includes("not")
 * é true, gerando falsos positivos em artigos com negação ou palavras comuns.
 *
 * @returns `{ tools, wasFallback }` — `wasFallback: true` quando survey não
 *   tinha respostas e KNOWN_TOOLS foi usado como substituto.
 */
export function extractSurveyTools(
  responses: Array<{ answers: Array<{ question_prompt: string; answer: string }> }>,
): Set<string> {
  const tools = new Set<string>();
  const toolQuestion = /ferramenta|ferramentas|tool|usa|utiliza/i;
  // Pré-computar normalized KNOWN_TOOLS uma vez para eficiência.
  const normalizedKnown = KNOWN_TOOLS.map(normalizeTool);

  for (const r of responses) {
    for (const a of r.answers) {
      if (!toolQuestion.test(a.question_prompt)) continue;
      const tokens = normalizeTool(a.answer).split(/[\s,;/]+/);
      for (const tok of tokens) {
        if (tok.length < 3) continue;
        // Admite tok se:
        //   (a) tok === algum known tool (igualdade exata), OU
        //   (b) tok contém algum known tool como palavra completa.
        // Nunca: known_tool.includes(tok) — isso admite substrings de tools
        // como "not" (de "notion") ou "rag" (de qualquer tool que contivesse).
        const admitted = normalizedKnown.some(
          k => k === tok || (tok.length > k.length && wordMatchIn(tok, k)),
        );
        if (admitted) tools.add(tok);
      }
    }
  }

  // Fallback: sempre incluir os termos base se survey não retornou nada.
  // Emite warning para alertar que o sinal de survey é fraco — source será
  // "fallback" no AudienceSignals e o survey score NÃO será usado no cálculo.
  if (tools.size === 0) {
    console.error(
      "[audience-affinity] WARN: survey não contém respostas de ferramentas" +
      " — usando KNOWN_TOOLS como fallback. Execute /diaria-atualiza-audiencia" +
      " para recalibrar o survey.",
    );
    for (const k of KNOWN_TOOLS) tools.add(normalizeTool(k));
  }

  return tools;
}

// ─── Carregamento de sinais ────────────────────────────────────────────────────

/**
 * Carrega os sinais de audiência da `data/` (CTR CSV + survey JSON).
 *
 * Falhas de I/O são graciosamente tratadas — retorna `{ loaded: false }` quando
 * os dados não estão disponíveis (CI, worktrees sem data junction).
 *
 * @param root  Raiz do repo (default: cwd ou `import.meta.dirname/../..`).
 */
export function loadAudienceSignals(root?: string): AudienceSignals {
  const base = root ?? resolveRoot();

  const empty: AudienceSignals = {
    ctrByCategory: new Map(),
    avgCtr: 0,
    surveyTools: new Set(),
    source: "none",
    loaded: false,
  };

  // ─── Freshness check (#2063 item 2) ────────────────────────────────────────
  const ctrPath = resolve(base, RELATIVE_CTR_CSV);
  const surveyPath = resolve(base, RELATIVE_SURVEY_JSON);

  checkFreshness(ctrPath, "link-ctr-table.csv");
  checkFreshness(surveyPath, "audience-raw.json");

  // ─── CTR (primary) ─────────────────────────────────────────────────────────
  let ctrByCategory = new Map<string, number>();
  let avgCtr = 0;
  let hasCtr = false;

  if (existsSync(ctrPath)) {
    try {
      const csv = readFileSync(ctrPath, "utf8");
      const parsed = parseCtrFromCsv(csv);
      if (parsed) {
        // Compute average CTR across all categories
        let totalClicks = 0;
        let totalOpens = 0;
        for (const agg of parsed.byCategory.values()) {
          totalClicks += agg.clicks;
          totalOpens += agg.opens;
        }
        avgCtr = totalOpens > 0 ? totalClicks / totalOpens : 0;

        // Compute relative CTR per category (1.0 = average)
        for (const [cat, agg] of parsed.byCategory) {
          const catCtr = agg.opens > 0 ? agg.clicks / agg.opens : 0;
          ctrByCategory.set(cat, avgCtr > 0 ? catCtr / avgCtr : 1);
        }
        hasCtr = ctrByCategory.size > 0;
      }
    } catch (e) {
      console.error(`[audience-affinity] WARN: falha ao ler CTR CSV (${(e as Error).message}) — sem sinal de CTR`);
    }
  }

  // ─── Survey (secondary) ────────────────────────────────────────────────────
  let surveyTools = new Set<string>();
  let surveySource: "survey" | "fallback" | "none" = "none";

  if (existsSync(surveyPath)) {
    try {
      const all = JSON.parse(readFileSync(surveyPath, "utf8")) as Array<{
        status?: string;
        answers: Array<{ question_prompt: string; answer: string }>;
      }>;
      const active = all.filter((r) => !r.status || r.status === "active");
      // Detectar se há respostas de ferramenta antes de chamar extractSurveyTools,
      // para distinguir "survey real" de "fallback KNOWN_TOOLS".
      const toolQuestion = /ferramenta|ferramentas|tool|usa|utiliza/i;
      const hasToolAnswers = active.some(r =>
        r.answers.some(a => toolQuestion.test(a.question_prompt) && a.answer.trim().length > 0),
      );
      surveyTools = extractSurveyTools(active);
      surveySource = hasToolAnswers ? "survey" : "fallback";
    } catch (e) {
      console.error(`[audience-affinity] WARN: falha ao ler survey JSON (${(e as Error).message}) — sem sinal de survey`);
    }
  }

  // Se nenhuma fonte carregou, retornar empty
  if (!hasCtr && surveySource === "none") {
    return empty;
  }

  // Derivar source combinada
  let source: AudienceSignalsSource;
  if (hasCtr && surveySource === "survey") {
    source = "ctr+survey";
  } else if (hasCtr && surveySource === "fallback") {
    source = "fallback"; // CTR existe mas survey é fallback — ainda não usar survey para score
  } else if (hasCtr) {
    source = "ctr";
  } else if (surveySource === "survey") {
    source = "survey";
  } else {
    // surveySource === "fallback", sem CTR
    source = "fallback";
  }

  return {
    ctrByCategory,
    avgCtr,
    surveyTools,
    source,
    // O early-return acima garante que source nunca é "none" aqui (TS2367 se comparar).
    loaded: true,
  };
}

// ─── Anotação por artigo ───────────────────────────────────────────────────────

/**
 * Computa a `AudienceAffinity` de um artigo `use_melhor` contra os sinais de
 * audiência pré-carregados.
 *
 * Algoritmo (proporcional com teto — decisão do editor para #2063):
 *
 *   1. **CTR signal** (60% do peso):
 *      - Encontra categorias do CTR cujos nomes aparecem no título/summary/slug.
 *      - Usa a maior `ctr_relativa` encontrada (best-match).
 *      - Normalizado 0-1: `min(ctr_relativa / MAX_CTR_RATIO, 1)`.
 *        `MAX_CTR_RATIO = 6.0` (categoria Treinamento ~2.43% / avg 0.43% ≈ 5.65×).
 *
 *   2. **Survey tool signal** (40% do peso):
 *      - Encontra ferramentas do survey que aparecem no texto do artigo.
 *      - Score = `min(matches / MAX_TOOL_MATCHES, 1)` onde MAX_TOOL_MATCHES = 3.
 *      - **Zerado quando `signals.source === "fallback"`**: surveyTools foi
 *        populado com KNOWN_TOOLS estático (sem respostas reais), não com o
 *        perfil real de ferramentas. Usar esse sinal inflaria artificialmente a
 *        affinity de qualquer artigo que mencione um dos ~40 termos genéricos.
 *
 *   affinity = (ctr_score × 0.6) + (survey_score × 0.4)
 *
 * Quando `signals.loaded === false`, retorna `null` — sem anotação.
 */
const MAX_CTR_RATIO = 6.0;
const MAX_TOOL_MATCHES = 3;

// ─── Detecção de tutorial hands-on curto (#2143) ──────────────────────────────

/**
 * Bonus de score aplicado pelo scorer LLM quando `hands_on === true`.
 * Exportado para referência nos testes e na rubrica do prompt.
 *
 * +8 pontos: suficiente para colocar um bom tutorial casual acima de um guia
 * conceitual equivalente (gap típico entre ambos = 5-10 pts), sem distorcer
 * o ranking de notícias de alto impacto (que chegam com 85-95 de base).
 */
export const HANDS_ON_BONUS_PTS = 8;

/**
 * Sinais textuais de tutorial "hands-on curto" (#2143).
 *
 * Um artigo é classificado como hands-on curto quando atende ≥2 sinais abaixo.
 * Cada sinal é detectado por regex sobre o texto normalizado do artigo
 * (título + summary + slug da URL). O threshold de 2 evita falsos positivos
 * de artigos que mencionam apenas "passo a passo" na chamada mas são deep-dives.
 *
 * Critérios derivados da decisão editorial de 260612 (issue #2143):
 *   - Passos numerados / passo a passo / step-by-step (estrutura de tutorial)
 *   - Tempo estimado de conclusão explícito (≤2h como critério editorial)
 *   - Ferramenta consumer sem setup cloud/API key obrigatório
 *     (NotebookLM, Gems, GPTs, ChatGPT, Gemini, Claude — interface web)
 *   - Sinal de scope fechado (guia prático, quickstart, getting started, mini-curso)
 *   - Idioma PT-BR (bônus de audiência — 58,6% da base é casual/consciente)
 *
 * Nota: os sinais de "ferramenta consumer" e "setup mínimo" são detectados
 * via palavras-chave no texto, não via verificação do artigo completo — é uma
 * heurística boa o suficiente para pré-filtragem; o scorer LLM faz a decisão
 * final com o contexto completo do artigo.
 */

/** Regex de passos numerados / estrutura step-by-step. */
const RE_NUMBERED_STEPS = /\b(passo a passo|step[- ]by[- ]step|step \d|etapas?|passos?|steps?:|\d\.\s|\bpasso \d)/i;

/** Regex de tempo estimado (≤2h — heurística: menção de minutos ou horas pequenas).
 * Nota: `~\d` só funciona sobre rawText (título/summary) — tilde é stripped por normalizeTool em `hay`.
 * `quick(ly)?` foi removido: dispara em adjetivos de notícias ("OpenAI quickly added X"), gerando
 * falso-positivo quando combinado com RE_CONSUMER_TOOL. Usar `rapido`/`rápido`/`em poucos minutos`.
 */
const RE_TIME_ESTIMATE = /\b(\d+\s*(min(utes?|uto)?s?|h(ou)?r?s?|hora?s?)\b|em menos de \d|~\d|em \d+(h|min)\b|rapido|rápido|em poucos minutos|em menos de uma hora)/i;

/** Regex de ferramentas consumer (interface web, sem API key/cloud obrigatório).
 * `openai` bare foi restringido a `openai (academy|playground|api|platform)` para evitar falso-
 * positivo em artigos de financiamento/política ("OpenAI raises $40B"). `gpt[- ]?4?o?` foi
 * restringido para exigir sufixo concreto (4, 4o, o, o1, etc.) — a versão anterior degenerava
 * para `/\bgpt\b/` com todos os sufixos opcionais, capturando surveys teóricos sobre "GPT architecture".
 */
const RE_CONSUMER_TOOL = /\b(notebooklm|notebook lm|gemini|chatgpt|chat gpt|claude\.ai|copilot|gpt[- ]?(?:4o?|o1?|3\.5|4\.?\d)|openai\s+(?:academy|playground|platform|api)|transformers\.js|scikit[- ]?llm|gemini for workspace|google ai studio)\b/i;

/** Regex de scope fechado / quickstart.
 * `lab` foi removido: é demasiado genérico em inglês ("AI Safety Lab", "DeepMind Lab",
 * "research lab") e dispara falso-positivo em artigos de política/produto. O sinal pretendido
 * ("Jupyter Lab", "Google Colab") já é coberto por `hands-on` + `getting started`.
 * `guide` foi adicionado: equivalente EN de `guia` — sem ele, tutoriais EN eram sistematicamente
 * menos prováveis de atingir o threshold vs PT-BR equivalentes.
 */
const RE_CLOSED_SCOPE = /\b(guia|guia pratico|guia prático|tutorial|guide|quickstart|getting started|mini[- ]?curso|introdução|introducao|iniciante|para iniciantes|beginners?|primeiros passos|hello[- ]world|hands[- ]?on|pratica|prática|exercicio|exercício)\b/i;

/** Regex de idioma PT-BR explícito no conteúdo ou origem.
 * `\.com\.br\/` substituído por `\.com\.br\b` — a versão anterior exigia path component
 * após o domínio (site.com.br/tutorial OK, mas https://dados.com.br sem trailing slash falhava).
 */
const RE_PTBR = /\b(pt[- ]?br|português|portugues|em português|em portugues|brasil|brazilian|zently\.com\.br)|\b\.com\.br\b/i;

/**
 * Detecta deterministicamente se um artigo USE MELHOR é um "tutorial hands-on curto"
 * (#2143).
 *
 * @param article  Artigo com `url`, `title` e/ou `summary`.
 * @returns        `{ isHandsOn, signals }` — `isHandsOn` é `true` quando ≥2 sinais
 *                 distintos forem detectados. `signals` lista quais foram detectados
 *                 (para explicabilidade na `reason` do scorer).
 */
export function detectHandsOnShort(
  article: { url?: string; title?: string; summary?: string },
): { isHandsOn: boolean; signals: string[] } {
  const hay = normalizeTool([
    article.title ?? "",
    article.summary ?? "",
    extractSlug(article.url ?? ""),
    // inclui o domínio bruto (para detectar .com.br, zently.com.br etc.)
    (() => { try { return new URL(article.url ?? "").hostname; } catch { return ""; } })(),
  ].join(" "));

  const rawText = [article.title ?? "", article.summary ?? ""].join(" ");

  const signals: string[] = [];

  if (RE_NUMBERED_STEPS.test(rawText) || RE_NUMBERED_STEPS.test(hay)) {
    signals.push("numbered_steps");
  }
  if (RE_TIME_ESTIMATE.test(rawText) || RE_TIME_ESTIMATE.test(hay)) {
    signals.push("time_estimate");
  }
  if (RE_CONSUMER_TOOL.test(rawText) || RE_CONSUMER_TOOL.test(hay)) {
    signals.push("consumer_tool");
  }
  if (RE_CLOSED_SCOPE.test(rawText) || RE_CLOSED_SCOPE.test(hay)) {
    signals.push("closed_scope");
  }
  if (RE_PTBR.test(rawText) || RE_PTBR.test(article.url ?? "")) {
    signals.push("ptbr");
  }

  return { isHandsOn: signals.length >= 2, signals };
}

export function annotateAudienceAffinity(
  article: { url?: string; title?: string; summary?: string; category?: string },
  signals: AudienceSignals,
): AudienceAffinity | null {
  if (!signals.loaded) return null;

  const hay = buildHaystack(article);
  const matched: string[] = [];

  // ─── 1. CTR signal ─────────────────────────────────────────────────────────
  let bestCtrRatio = 0;

  for (const [cat, relCtr] of signals.ctrByCategory) {
    // Match com word-boundary: categoria deve aparecer como palavra, não substring interna
    const catNorm = normalizeTool(cat);
    if (catNorm.length < 3) continue;
    if (wordMatch(hay, catNorm)) {
      matched.push(`categoria:${cat}`);
      if (relCtr > bestCtrRatio) bestCtrRatio = relCtr;
    }
  }

  const ctrScore = Math.min(bestCtrRatio / MAX_CTR_RATIO, 1);

  // ─── 2. Survey tool signal ─────────────────────────────────────────────────
  // Quando source === "fallback", surveyTools = KNOWN_TOOLS estático — não usa
  // para score (evita inflar affinity com falsos positivos genéricos).
  let surveyScore = 0;
  const useSurvey = signals.source !== "fallback";

  if (useSurvey) {
    let toolMatches = 0;
    for (const tool of signals.surveyTools) {
      if (tool.length < 3) continue;
      if (wordMatch(hay, tool)) {
        matched.push(`tool:${tool}`);
        toolMatches++;
      }
    }
    surveyScore = Math.min(toolMatches / MAX_TOOL_MATCHES, 1);
  }

  // ─── 3. Hands-on curto (#2143) ─────────────────────────────────────────────
  // Sinal determinístico — independente de dados de audiência. Emite
  // "hands_on:true" + sub-sinais "ho:{sinal}" em `matched` quando detectado:
  // o scorer LLM adiciona HANDS_ON_BONUS_PTS ao score do artigo (ver rubrica em scorer.md).
  // Os sub-sinais (ex: "ho:numbered_steps", "ho:consumer_tool") são para explicabilidade
  // na `reason` do scorer — permitem justificar "detectado porque: passos + ferramenta".
  const { isHandsOn, signals: hoSignals } = detectHandsOnShort(article);
  if (isHandsOn) {
    matched.push("hands_on:true");
    for (const s of hoSignals) matched.push(`ho:${s}`);
  }

  // ─── 4. Tutorial academy (#2276) ──────────────────────────────────────────
  // Sinal: artigo é curso/tutorial oficial (deeplearning.ai, HF /learn, etc.).
  // "academy:true" no matched → scorer LLM aplica bônus.
  if (isTutorialAcademy(article.url ?? "", article.title ?? "")) {
    matched.push("academy:true");
  }

  // ─── 5. How-to PT-BR (#2278) ───────────────────────────────────────────────
  // Sinal: título ou slug tem padrão how-to aplicado PT-BR.
  // "howto_br:true" no matched → scorer LLM aplica bônus.
  if (hasHowToBrSignal(article.url ?? "", article.title ?? "")) {
    matched.push("howto_br:true");
  }

  // ─── Composite ─────────────────────────────────────────────────────────────
  const affinity = parseFloat(((ctrScore * 0.6) + (surveyScore * 0.4)).toFixed(3));

  return { affinity, matched, hands_on: isHandsOn };
}

// ─── Annotate bucket ──────────────────────────────────────────────────────────

/**
 * Anota todos os artigos do bucket `use_melhor` em-place com `audience_affinity`.
 * Artigos de outros buckets não são tocados.
 *
 * @param categorized  Objeto de buckets (`{ lancamento, radar, use_melhor, video }`)
 * @param signals      Sinais pré-carregados (chama `loadAudienceSignals()` antes)
 * @returns            Número de artigos anotados
 */
export function annotateUseMelhorBucket(
  categorized: Record<string, Array<{ url?: string; title?: string; summary?: string; category?: string; audience_affinity?: AudienceAffinity | null; [key: string]: unknown }>>,
  signals: AudienceSignals,
): number {
  if (!signals.loaded) return 0;
  const items = categorized["use_melhor"] ?? [];
  let count = 0;
  for (const item of items) {
    item.audience_affinity = annotateAudienceAffinity(item, signals);
    if (item.audience_affinity !== null) count++;
  }
  return count;
}

// ─── Freshness check ──────────────────────────────────────────────────────────

/**
 * Emite warning no stderr se `path` tem mtime > `AUDIENCE_AFFINITY_FRESHNESS_DAYS`.
 * Nunca bloqueia (#2063 item 2).
 */
export function checkFreshness(path: string, label: string, today: Date = new Date()): void {
  const ms = mtimeMs(path);
  if (ms === null) return; // arquivo ausente — fallback gracioso, sem warning aqui
  const ageDays = (today.getTime() - ms) / MS_PER_DAY;
  if (ageDays > AUDIENCE_AFFINITY_FRESHNESS_DAYS) {
    console.error(
      `[audience-affinity] WARN: ${label} está com ${Math.round(ageDays)} dias de idade` +
      ` (threshold: ${AUDIENCE_AFFINITY_FRESHNESS_DAYS}d). Execute /diaria-atualiza-audiencia` +
      ` para atualizar. O pipeline continua normalmente.`,
    );
  }
}

// ─── Helpers privados ─────────────────────────────────────────────────────────

function buildHaystack(
  article: { url?: string; title?: string; summary?: string },
): string {
  const parts = [
    article.title ?? "",
    article.summary ?? "",
    extractSlug(article.url ?? ""),
  ];
  return normalizeTool(parts.join(" "));
}

/**
 * Word-boundary match: `needle` deve aparecer como palavra completa no `hay`
 * (não como substring interna de outra palavra). Usa lookbehind/lookahead
 * negativos sobre o alfabeto a-z0-9 e hífen para evitar falsos positivos
 * como "rag" em "storage", "prompt" em "promptly", "deploy" em "deployment".
 */
function wordMatch(hay: string, needle: string): boolean {
  // Escapar caracteres especiais de regex no needle (ex: "fine-tuning")
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(hay);
}

/**
 * Variante de wordMatch para verificar se `hay` CONTÉM `needle` como
 * palavra completa (usada em extractSurveyTools para a check de admissão).
 * Equivalente a `wordMatch(hay, needle)` mas com nomes mais explícitos para
 * o sentido "needle aparece como palavra dentro de hay".
 */
function wordMatchIn(hay: string, needle: string): boolean {
  return wordMatch(hay, needle);
}

function extractSlug(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname).replace(/[-_/]+/g, " ").trim();
  } catch {
    return "";
  }
}

function resolveRoot(): string {
  // import.meta.dirname is scripts/lib/, so ../../ is repo root
  try {
    // ESM
    const dir = import.meta.dirname;
    return resolve(dir, "../..");
  } catch {
    return process.cwd();
  }
}
