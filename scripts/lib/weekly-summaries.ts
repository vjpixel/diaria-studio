/**
 * weekly-summaries.ts (#11062, opção a — decisão do editor 25/10/2026)
 *
 * Resumo de 1 linha por item na legenda da retro semanal
 * (`/diaria-retro-semanal`). Antes a linha de contexto era o "Por que isso
 * importa" (`why`) cru do destaque: dentro da newsletter ele vem DEPOIS do
 * corpo e tira a consequência; na legenda, sozinho embaixo do título, contava
 * a consequência sem dizer o que aconteceu ("O modelo questionou a ética do
 * atalho...", "Avanços como esse...").
 *
 * Agora quem escreve é o agente `weekly-summary-writer`, dispatchado pela
 * skill a partir do manifest (`publish-weekly-social.ts --summary-manifest`),
 * e grava `data/weekly/{sábado}-{modo}/_internal/06-summaries.json`. Este
 * módulo lê esse arquivo e valida cada resumo contra as 4 regras do editor:
 *
 *   1. Não repetir o título — informação nova (número, ator, desdobramento, limite).
 *   2. Fato concreto primeiro, não consequência abstrata.
 *   3. Ler sozinho — sem anáfora pro corpo ("o modelo", "esse avanço").
 *   4. Curto — 1 frase, no máximo 2 curtas.
 *
 * As regras 1 e 4 BARRAM o agendamento (`validateWeeklySummary`). A regra 3
 * vira aviso (`weeklySummaryWarnings`) — a mesma forma aparece em resumo bom
 * e ruim. A regra 2 fica no prompt do agente: não há regex honesta pra
 * "consequência abstrata". O juiz final é o editor no gate do Passo 3.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Teto de caracteres do resumo (regra 4). Os 8 aprovados em 261024 ficaram entre 82 e 156. */
export const WEEKLY_SUMMARY_MAX_CHARS = 200;
/** Máximo de frases (regra 4). */
export const WEEKLY_SUMMARY_MAX_SENTENCES = 2;

export interface WeeklySummaryEntry {
  url: string;
  title?: string;
  summary: string;
}

export interface WeeklySummariesFile {
  carouselKey?: string;
  items: WeeklySummaryEntry[];
}

export function weeklySummariesPath(dataRoot: string, carouselKey: string): string {
  return resolve(dataRoot, "weekly", carouselKey, "_internal", "06-summaries.json");
}

/** null se o arquivo não existe; lança se existe mas está corrompido (nunca trata corrompido como "sem resumo"). */
export function readWeeklySummaries(path: string): Map<string, string> | null {
  if (!existsSync(path)) return null;
  let data: WeeklySummariesFile;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as WeeklySummariesFile;
  } catch (e) {
    throw new Error(`06-summaries.json corrompido (${path}): ${(e as Error).message}`);
  }
  if (!data || !Array.isArray(data.items)) {
    throw new Error(`06-summaries.json sem "items" (${path})`);
  }
  const map = new Map<string, string>();
  for (const it of data.items) {
    if (it && typeof it.url === "string" && typeof it.summary === "string") map.set(it.url, it.summary.trim());
  }
  return map;
}

const STOPWORDS = new Set([
  "sobre", "entre", "contra", "depois", "antes", "porque", "quando", "ainda", "mesmo", "outra", "outro",
  "seus", "suas", "pela", "pelo", "pelas", "pelos", "para", "como", "mais", "menos", "muito", "sem", "com",
]);

function normalizeWord(w: string): string {
  return w.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Palavras "significativas" (≥5 letras, sem stopword), sem acento e em minúsculas. */
export function significantWords(text: string): string[] {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.map(normalizeWord).filter((w) => w.length >= 5 && !STOPWORDS.has(w)))];
}

/**
 * Anáforas soltas que só fazem sentido com o corpo da matéria antes (regra 3).
 * Casos reais do `why` cru que motivaram a regra: "O modelo questionou...",
 * "Avanços como esse...", "São dados internos de uma das empresas...".
 */
const LOOSE_ANAPHORA = [
  /^(o|a|os|as)\s+(modelo|modelos|empresa|empresas|ferramenta|estudo|caso|sistema|recurso|projeto|relat[óo]rio|medida|regra|falha|falhas|agente)\b/i,
  /^(esse|essa|esses|essas|este|esta|estes|estas|isso|isto)\b/i,
  /^\p{L}+\s+como\s+(esse|essa|este|esta|esses|essas)\b/iu,
  /^s[ãa]o\s+dados\b/i,
];

function countSentences(text: string): number {
  // "US$ 0,04" e abreviações curtas não quebram frase: só conta ponto final seguido de espaço+maiúscula, ou fim.
  const parts = text.trim().split(/(?<=[.!?])\s+(?=\p{Lu})/u).filter((s) => s.trim().length > 0);
  return parts.length;
}

/**
 * Problemas do resumo, em português, prontos pra mostrar ao editor/agente.
 * Lista vazia = passou. Heurística: um resumo pode nomear o mesmo ator do
 * título (ex: "Anthropic") — o corte é repetir METADE ou mais das palavras
 * significativas do título (mínimo 2).
 */
export function validateWeeklySummary(title: string, summary: string): string[] {
  const problems: string[] = [];
  const s = summary.trim();
  if (!s) return ["resumo vazio"];
  if (s.length > WEEKLY_SUMMARY_MAX_CHARS) problems.push(`passa de ${WEEKLY_SUMMARY_MAX_CHARS} caracteres (${s.length})`);
  const sentences = countSentences(s);
  if (sentences > WEEKLY_SUMMARY_MAX_SENTENCES) problems.push(`tem ${sentences} frases (máximo ${WEEKLY_SUMMARY_MAX_SENTENCES})`);
  const titleWords = significantWords(title);
  const summaryWords = new Set(significantWords(s));
  const repeated = titleWords.filter((w) => summaryWords.has(w));
  if (titleWords.length > 0 && repeated.length >= 2 && repeated.length / titleWords.length >= 0.5) {
    problems.push(`repete o título (${repeated.join(", ")})`);
  }
  if (/\*\*|\[|\]\(|→|←/.test(s)) problems.push("tem markdown ou seta");
  return problems;
}

/**
 * Avisos que NÃO barram o agendamento — vão pro preview/gate do Passo 3.
 * A anáfora solta (regra 3) fica aqui e não em `validateWeeklySummary`
 * porque a mesma forma serve aos dois lados: "O modelo questionou..." (why
 * cru, ruim) e "Os modelos são abertos..." (aprovado pelo editor em 261024,
 * o título fala do lançamento). Quem decide é o editor.
 */
export function weeklySummaryWarnings(summary: string): string[] {
  return LOOSE_ANAPHORA.some((re) => re.test(summary.trim()))
    ? ["começa com referência que pode depender do corpo da matéria (confira se se lê sozinho)"]
    : [];
}

export interface SummaryResolution {
  /** url → resumo válido. */
  ok: Map<string, string>;
  /** Itens sem resumo no arquivo (ou arquivo ausente). */
  missing: string[];
  /** Itens com resumo que não passou na validação: título + problemas. */
  invalid: { url: string; title: string; problems: string[] }[];
  /** Avisos não bloqueantes (`weeklySummaryWarnings`) dos resumos válidos. */
  warnings: { url: string; title: string; warnings: string[] }[];
}

export function resolveWeeklySummaries(
  items: { url: string; title: string }[],
  summaries: Map<string, string> | null,
): SummaryResolution {
  const ok = new Map<string, string>();
  const missing: string[] = [];
  const invalid: SummaryResolution["invalid"] = [];
  const warnings: SummaryResolution["warnings"] = [];
  for (const it of items) {
    const s = summaries?.get(it.url);
    if (!s) {
      missing.push(it.title);
      continue;
    }
    const problems = validateWeeklySummary(it.title, s);
    if (problems.length > 0) invalid.push({ url: it.url, title: it.title, problems });
    else {
      ok.set(it.url, s);
      const w = weeklySummaryWarnings(s);
      if (w.length > 0) warnings.push({ url: it.url, title: it.title, warnings: w });
    }
  }
  return { ok, missing, invalid, warnings };
}
