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
 *   dos agentes scorers).
 *
 * O campo é `null` quando não há dados de audiência disponíveis — o scorer
 * ignora a anotação nesse caso (comportamento pré-#2063).
 */
export interface AudienceAffinity {
  affinity: number; // 0..1
  matched: string[]; // ex: ["categoria:Treinamento", "categoria:Ferramenta", "tool:ChatGPT"]
}

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
  /** Sinaliza que os dados foram carregados com sucesso. */
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
  "prompt", "fine-tuning", "finetuning", "training", "treinamento",
  "inference", "inferência", "deployment", "deploy",
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
 * Esta função extrai tokens plausíveis das respostas, intersection com
 * `KNOWN_TOOLS` para evitar ruído.
 */
export function extractSurveyTools(
  responses: Array<{ answers: Array<{ question_prompt: string; answer: string }> }>,
): Set<string> {
  const tools = new Set<string>();
  const toolQuestion = /ferramenta|ferramentas|tool|usa|utiliza/i;

  for (const r of responses) {
    for (const a of r.answers) {
      if (!toolQuestion.test(a.question_prompt)) continue;
      const tokens = normalizeTool(a.answer).split(/[\s,;/]+/);
      for (const tok of tokens) {
        if (tok.length >= 3 && KNOWN_TOOLS.some(k => normalizeTool(k) === tok || normalizeTool(k).includes(tok))) {
          tools.add(tok);
        }
      }
    }
  }

  // Fallback: sempre incluir os termos base se survey não retornou nada
  if (tools.size === 0) {
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
      }
    } catch (e) {
      console.error(`[audience-affinity] WARN: falha ao ler CTR CSV (${(e as Error).message}) — sem sinal de CTR`);
    }
  }

  // ─── Survey (secondary) ────────────────────────────────────────────────────
  let surveyTools = new Set<string>();

  if (existsSync(surveyPath)) {
    try {
      const all = JSON.parse(readFileSync(surveyPath, "utf8")) as Array<{
        status?: string;
        answers: Array<{ question_prompt: string; answer: string }>;
      }>;
      const active = all.filter((r) => !r.status || r.status === "active");
      surveyTools = extractSurveyTools(active);
    } catch (e) {
      console.error(`[audience-affinity] WARN: falha ao ler survey JSON (${(e as Error).message}) — sem sinal de survey`);
    }
  }

  // Se nenhuma fonte carregou, retornar empty
  if (ctrByCategory.size === 0 && surveyTools.size === 0) {
    return empty;
  }

  return {
    ctrByCategory,
    avgCtr,
    surveyTools,
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
 *
 *   affinity = (ctr_score × 0.6) + (survey_score × 0.4)
 *
 * Quando `signals.loaded === false`, retorna `null` — sem anotação.
 */
const MAX_CTR_RATIO = 6.0;
const MAX_TOOL_MATCHES = 3;

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
    // Match flexible: category name (lowercase, normalized) in article text
    const catNorm = normalizeTool(cat);
    if (catNorm.length < 3) continue;
    if (hay.includes(catNorm)) {
      matched.push(`categoria:${cat}`);
      if (relCtr > bestCtrRatio) bestCtrRatio = relCtr;
    }
  }

  // Also check URL slug for category keywords
  const slug = extractSlug(article.url ?? "");
  if (slug) {
    for (const [cat, relCtr] of signals.ctrByCategory) {
      const catNorm = normalizeTool(cat);
      if (catNorm.length < 3) continue;
      const key = `categoria:${cat}`;
      if (!matched.includes(key) && slug.includes(catNorm)) {
        matched.push(key);
        if (relCtr > bestCtrRatio) bestCtrRatio = relCtr;
      }
    }
  }

  const ctrScore = Math.min(bestCtrRatio / MAX_CTR_RATIO, 1);

  // ─── 2. Survey tool signal ─────────────────────────────────────────────────
  let toolMatches = 0;

  for (const tool of signals.surveyTools) {
    if (tool.length < 3) continue;
    if (hay.includes(tool)) {
      matched.push(`tool:${tool}`);
      toolMatches++;
    }
  }

  const surveyScore = Math.min(toolMatches / MAX_TOOL_MATCHES, 1);

  // ─── Composite ─────────────────────────────────────────────────────────────
  const affinity = parseFloat(((ctrScore * 0.6) + (surveyScore * 0.4)).toFixed(3));

  return { affinity, matched };
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
