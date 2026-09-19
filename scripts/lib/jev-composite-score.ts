/**
 * jev-composite-score.ts (#8415 — Medição 2 do epic #8412)
 *
 * Miolo PURO da medição "composite scoring": decompor o rubrico monolítico
 * do `scorer-chunk` em eixos atômicos (pergunta `score` do Jev, uma por
 * eixo) e comparar um score composto (`Σ wᵢ·nívelᵢ`) contra o score do
 * mecanismo atual e contra a decisão real do editor no gate — ver a issue
 * para o desenho completo. Este módulo não chama rede nem lê disco: quem
 * orquestra I/O é `scripts/jev-composite-score-eval.ts`.
 *
 * **Pesos são um PONTO DE PARTIDA documentado, não uma calibração** (a
 * calibração pelos erros do editor é a Fase C, #7979, fora desta issue).
 * Ancorados nas magnitudes já usadas pelos bônus determinísticos do
 * `scorer-chunk` (`.claude/agents/scorer-chunk.md`) — maior bônus fixo hoje é
 * +10 (`impact_routine`, `audience_affinity` no teto, `primary_source`);
 * +8 pro hands_on; +5/+6 pros de nicho (BR, academy). Os pesos abaixo
 * preservam essa ordem relativa (impacto/utilidade > fonte primária/hands-on
 * > BR > novidade, que hoje não tem bônus explícito nenhum — só entra
 * qualitativamente em "Atualidade" no rubrico monolítico, por isso o peso
 * mais baixo aqui).
 */

import type { JevQuestion, JevScoreAnswer } from "./jev.ts";

export interface CompositeAxis {
  /** Também o `id` da pergunta em `askJev` — casa com a chave de `answers`. */
  id: string;
  /** Peso relativo (não precisa somar 1 — `compositeScore` normaliza pela soma). */
  weight: number;
  /** Níveis ORDENADOS, do mais baixo ao mais alto (contrato real da API, #8415). */
  criteria: string[];
  instructions: string;
}

/**
 * Os 6 eixos propostos na issue #8415, cada um pergunta `score` do Jev.
 * `novidade` e `relevancia_br`/`hands_on`/`fonte_primaria` usam 3 níveis;
 * `impacto` usa 4 (o rubrico atual já trata impacto como o bônus mais alto
 * e mais granular — 4 níveis dá mais resolução onde o mecanismo atual já
 * aposta mais peso).
 */
export const COMPOSITE_AXES: CompositeAxis[] = [
  {
    id: "novidade",
    weight: 1.0,
    instructions:
      "O quão NOVO/inédito é este conteúdo — é notícia de hoje ou é " +
      "requentado (já veiculado há dias/semanas por outras fontes)?",
    criteria: [
      "requentado — cobertura repetida de algo já noticiado há dias/semanas",
      "parcialmente novo — alguma cobertura recente, ângulo ainda não saturado",
      "totalmente inédito — anúncio/achado de hoje, primeira cobertura",
    ],
  },
  {
    id: "utilidade_pratica",
    weight: 2.0,
    instructions:
      "Utilidade prática para um leitor de tecnologia/produto/startups/IA no " +
      "Brasil: o conteúdo muda como esse leitor trabalha, decide ou investe?",
    criteria: [
      "baixa — curiosidade ou notícia institucional sem ação prática",
      "moderada — relevante mas não muda decisão/rotina imediatamente",
      "alta — o leitor pode agir (adotar, decidir, se proteger) a partir disto",
    ],
  },
  {
    id: "fonte_primaria",
    weight: 1.5,
    instructions:
      "Este conteúdo é FONTE PRIMÁRIA (anúncio/post/paper/repo da própria " +
      "empresa/pesquisador que fez o trabalho) ou COBERTURA DE SEGUNDA MÃO " +
      "(imprensa/blog reportando sobre o que outra fonte fez)?",
    criteria: [
      "cobertura de segunda mão — imprensa/blog reportando outra fonte",
      "cobertura jornalística de uma fonte oficial (entrevista, release lido)",
      "fonte primária direta — blog/post/paper/repo de quem fez o trabalho",
    ],
  },
  {
    id: "hands_on",
    weight: 1.5,
    instructions:
      "É um tutorial/hands-on que o leitor consegue aplicar diretamente (passo " +
      "a passo, ferramenta acessível, sem setup cloud/IAM obrigatório)?",
    criteria: [
      "não é tutorial nem aplicável — só notícia/anúncio",
      "parcialmente aplicável — dá pra tentar mas falta passo a passo/setup simples",
      "tutorial completo e acionável em poucas horas, sem barreira de acesso",
    ],
  },
  {
    id: "relevancia_br",
    weight: 1.5,
    instructions:
      "Qual a relevância deste conteúdo especificamente para o leitor BRASILEIRO " +
      "(dado, caso ou ângulo do Brasil — não só tradução de algo global)?",
    criteria: [
      "irrelevante para o Brasil — conteúdo genérico global, sem ângulo BR",
      "relevância genérica — aplica-se ao Brasil como a qualquer outro mercado",
      "relevância específica — dado, caso ou impacto direto no Brasil",
    ],
  },
  {
    id: "impacto",
    weight: 2.5,
    instructions:
      "Escala do efeito deste conteúdo no mercado ou na profissão de tecnologia " +
      "— quantas pessoas/quão profundamente isso afeta como trabalham, estudam, " +
      "são contratadas ou decidem, agora ou em menos de 6 meses.",
    criteria: [
      "nenhum impacto perceptível na rotina de trabalho",
      "impacto de nicho — afeta poucos profissionais/uma especialidade",
      "impacto amplo em uma indústria/categoria profissional inteira",
      "impacto amplo em múltiplas indústrias ou na sociedade em geral",
    ],
  },
];

export function totalWeight(axes: CompositeAxis[] = COMPOSITE_AXES): number {
  return axes.reduce((s, a) => s + a.weight, 0);
}

/** Converte os eixos em `JevQuestion[]` (tipo `score`) prontos pra `askJev`. */
export function axesToJevQuestions(axes: CompositeAxis[] = COMPOSITE_AXES): JevQuestion[] {
  return axes.map((a) => ({
    id: a.id,
    type: "score" as const,
    instructions: a.instructions,
    criteria: a.criteria,
  }));
}

/** Normaliza o `score` bruto do Jev (índice contínuo 0..nLevels-1) pra 0..1. */
export function normalizedAxisScore(rawScore: number, nLevels: number): number {
  if (nLevels <= 1) return 0;
  const n = rawScore / (nLevels - 1);
  return Math.max(0, Math.min(1, n));
}

/**
 * Score composto 0-100 a partir das respostas Jev (uma por eixo). Eixo sem
 * resposta (erro de transporte pontual) é excluído do peso total — evita
 * penalizar um item por falha de rede num único eixo.
 */
export function compositeScore(
  answers: Record<string, JevScoreAnswer | null | undefined>,
  axes: CompositeAxis[] = COMPOSITE_AXES,
): number | null {
  let weightedSum = 0;
  let weightUsed = 0;
  for (const axis of axes) {
    const a = answers[axis.id];
    if (!a) continue;
    const norm = normalizedAxisScore(a.score, axis.criteria.length);
    weightedSum += axis.weight * norm;
    weightUsed += axis.weight;
  }
  if (weightUsed === 0) return null;
  return (weightedSum / weightUsed) * 100;
}

// ---------------------------------------------------------------------------
// Dataset — extração de candidatos de 01-approved.json (edição já concluída)
// ---------------------------------------------------------------------------

export interface Candidate {
  edition: string;
  url: string;
  title: string;
  summary: string;
  source?: string;
  published_at?: string;
  /** Score do mecanismo atual (scorer-chunk, campo `score` já gravado no disco). */
  mechanismScore: number;
  /** `true` quando o artigo VIROU destaque (D1/D2/D3) nesta edição — a "verdade" do gate. */
  isDestaque: boolean;
  bucket: string;
}

interface ApprovedFile {
  highlights?: Array<{ score?: number; bucket?: string; url?: string; article?: Record<string, unknown> }>;
  [bucket: string]: unknown;
}

const POOL_BUCKETS = ["lancamento", "radar", "use_melhor", "video"] as const;

function truncate(s: unknown, max: number): string {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max) : str;
}

/**
 * Extrai candidatos de UMA edição já concluída a partir de `01-approved.json`
 * parseado. Dedup por URL — quando o mesmo artigo aparece em `highlights` E
 * num bucket do pool (o destaque promovido geralmente some do pool, mas não
 * há garantia disso em todo formato histórico), a entrada de `highlights`
 * vence (`isDestaque: true`, score do highlight).
 */
export function collectEditionCandidates(approved: ApprovedFile, edition: string): Candidate[] {
  const byUrl = new Map<string, Candidate>();

  for (const bucket of POOL_BUCKETS) {
    const arr = approved[bucket] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(arr)) continue;
    for (const a of arr) {
      const url = typeof a.url === "string" ? a.url : null;
      if (!url || typeof a.score !== "number") continue;
      byUrl.set(url, {
        edition,
        url,
        title: truncate(a.title, 200),
        summary: truncate(a.summary, 500),
        source: typeof a.source === "string" ? a.source : undefined,
        published_at: typeof a.published_at === "string" ? a.published_at : (typeof a.date === "string" ? a.date : undefined),
        mechanismScore: a.score,
        isDestaque: false,
        bucket,
      });
    }
  }

  for (const h of approved.highlights ?? []) {
    const url = h.url ?? (h.article?.url as string | undefined);
    if (!url || typeof h.score !== "number") continue;
    const article = h.article ?? {};
    byUrl.set(url, {
      edition,
      url,
      title: truncate(article.title, 200),
      summary: truncate(article.summary, 500),
      source: typeof article.source === "string" ? (article.source as string) : undefined,
      published_at:
        typeof article.published_at === "string"
          ? (article.published_at as string)
          : typeof article.date === "string"
            ? (article.date as string)
            : undefined,
      mechanismScore: h.score,
      isDestaque: true,
      bucket: h.bucket ?? "destaque",
    });
  }

  return [...byUrl.values()];
}

// ---------------------------------------------------------------------------
// Métricas — concordância no top-15 e correlação
// ---------------------------------------------------------------------------

export interface RankedItem {
  url: string;
  isDestaque: boolean;
  score: number;
}

export interface Top15Result {
  /** Quantos candidatos entraram no corte (min(15, total)). */
  cutoff: number;
  total: number;
  totalDestaques: number;
  /** Destaques reais que caem dentro do top-N por este score. */
  destaquesInTop: number;
}

/** Concordância no top-15: dos destaques REAIS da edição, quantos o ranking por `score` capturaria dentro do corte. */
export function top15Concordance(items: RankedItem[], topN = 15): Top15Result {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const cutoff = Math.min(topN, sorted.length);
  const top = new Set(sorted.slice(0, cutoff).map((i) => i.url));
  const destaques = items.filter((i) => i.isDestaque);
  const destaquesInTop = destaques.filter((d) => top.has(d.url)).length;
  return { cutoff, total: items.length, totalDestaques: destaques.length, destaquesInTop };
}

/** Correlação de Pearson simples — usada só como métrica secundária (a issue pede TOP-15 como métrica principal). */
export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return null;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}
