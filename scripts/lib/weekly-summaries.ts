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
 * As regras 1 e 4 BARRAM o agendamento (`validateWeeklySummary`, que também
 * barra resumo vazio e markdown/seta). Resumo ausente também barra. A regra 3
 * vira aviso (`weeklySummaryWarnings`) — a mesma forma aparece em resumo bom
 * e ruim. A regra 2 fica no prompt do agente: não há regex honesta pra
 * "consequência abstrata". O juiz final é o editor no gate do Passo 3.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Teto de caracteres do resumo (regra 4). Os aprovados em 261024 ficaram bem abaixo (o maior, ~160). */
export const WEEKLY_SUMMARY_MAX_CHARS = 200;
/** Máximo de frases (regra 4). */
export const WEEKLY_SUMMARY_MAX_SENTENCES = 2;

export interface WeeklySummaryEntry {
  url: string;
  title?: string;
  /** Texto FINAL — o que vai pra legenda (pós-Humanizador e pós-Clarice, #11065). */
  summary: string;
  /** #11065: versão do agente `weekly-summary-writer`, antes dos 2 passes. */
  summary_raw?: string;
  /** #11065: versão pós-Humanizador, antes da Clarice. */
  summary_humanized?: string;
}

/**
 * #11065: estado dos passes de texto sobre os resumos (Passo 2c). Ausente =
 * o agente acabou de gravar e nenhum passe rodou. A ordem é a da diária:
 * Humanizador, depois Clarice. `clarice: "falhou"` = MCP e REST fora; o
 * texto humanizado segue e o preview avisa (decisão da implementação: o
 * texto é curto e o editor revisa no gate do Passo 3, sem halt).
 */
export interface WeeklySummaryPasses {
  humanizador?: "ok";
  clarice?: "ok" | "falhou";
  /** Por onde a Clarice rodou. */
  clarice_via?: "mcp" | "rest";
  /** Motivo quando `clarice: "falhou"`. */
  clarice_error?: string;
  /** Sugestões da Clarice que não puderam ser aplicadas (âncora ambígua/ausente). */
  clarice_skipped?: number;
}

export interface WeeklySummariesFile {
  carouselKey?: string;
  passes?: WeeklySummaryPasses;
  items: WeeklySummaryEntry[];
}

export function weeklySummariesPath(dataRoot: string, carouselKey: string): string {
  return resolve(dataRoot, "weekly", carouselKey, "_internal", "06-summaries.json");
}

/**
 * null se o arquivo não existe. Lança se existe mas está corrompido,
 * malformado (entrada sem `url`/`summary` string), com URL duplicada, ou de
 * outro carrossel (`carouselKey` diferente de `expectedKey`) — nunca trata
 * nenhum desses casos como "sem resumo", que mandaria o editor rodar o agente
 * de novo em vez de olhar o arquivo.
 */
export function readWeeklySummaries(path: string, expectedKey?: string): Map<string, string> | null {
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
  if (expectedKey && data.carouselKey && data.carouselKey !== expectedKey) {
    throw new Error(`06-summaries.json é do carrossel ${data.carouselKey}, não de ${expectedKey} (${path})`);
  }
  const map = new Map<string, string>();
  data.items.forEach((it, i) => {
    if (!it || typeof it.url !== "string" || typeof it.summary !== "string") {
      throw new Error(`06-summaries.json: entrada ${i + 1} sem "url"/"summary" em texto (${path})`);
    }
    if (map.has(it.url)) throw new Error(`06-summaries.json: URL repetida (${it.url}) (${path})`);
    map.set(it.url, it.summary.trim());
  });
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
 * Nomes próprios: palavra com maiúscula que NÃO abre frase ("Mistral",
 * "ElevenLabs" em "A Mistral cobra... a ElevenLabs"). Nomear de novo o ator
 * do título não é repetir o título — o review da PR #11064 mostrou que contar
 * isso barrava resumos bons ("Mistral desafia ElevenLabs" / "A Mistral
 * cobra US$ 0,04 o minuto, um décimo do que a ElevenLabs pede.").
 */
export function properNouns(text: string): Set<string> {
  const out = new Set<string>();
  for (const sentence of splitSentences(text)) {
    const words = sentence.match(/[\p{L}\p{N}]+/gu) ?? [];
    words.slice(1).forEach((w) => {
      if (/^\p{Lu}/u.test(w)) out.add(normalizeWord(w));
    });
  }
  return out;
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

const ABBREVIATIONS = /(?:^|\s)(?:dr|dra|sr|sra|srta|prof|profa|eng|av|art|inc|ltda|vs|etc)\.$/i;

/**
 * Frases: quebra em `.`/`!`/`?` seguido de espaço e maiúscula, dígito ou
 * aspas ("Caiu 30%. 17 ficaram."), menos depois de abreviação ("O Dr. Silva").
 * "US$ 0,04" não quebra (vírgula, sem espaço).
 */
export function splitSentences(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]\s+(?=[\p{Lu}\p{N}"“'‘«])/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const head = t.slice(start, m.index + 1);
    if (ABBREVIATIONS.test(head)) continue;
    out.push(head.trim());
    start = m.index + m[0].length;
  }
  out.push(t.slice(start).trim());
  return out.filter((x) => x.length > 0);
}

function countSentences(text: string): number {
  return splitSentences(text).length;
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
  // Nomes próprios (do título ou do resumo) não contam: renomear o ator não é repetir o título.
  const names = new Set([...properNouns(title), ...properNouns(s)]);
  const titleWords = significantWords(title).filter((w) => !names.has(w));
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
  /** Itens sem entrada no arquivo (ou arquivo ausente). Entrada vazia é `invalid` ("resumo vazio"). */
  missing: { url: string; title: string }[];
  /** Itens com resumo que não passou na validação: título + problemas. */
  invalid: { url: string; title: string; problems: string[] }[];
  /** Avisos não bloqueantes (`weeklySummaryWarnings`) dos resumos válidos. */
  warnings: { url: string; title: string; warnings: string[] }[];
  /** URLs com resumo no arquivo que não estão na seleção (seleção mudou depois do Passo 2c). */
  orphans: string[];
}

export function resolveWeeklySummaries(
  items: { url: string; title: string }[],
  summaries: Map<string, string> | null,
): SummaryResolution {
  const ok = new Map<string, string>();
  const missing: SummaryResolution["missing"] = [];
  const invalid: SummaryResolution["invalid"] = [];
  const warnings: SummaryResolution["warnings"] = [];
  for (const it of items) {
    if (!summaries?.has(it.url)) {
      missing.push({ url: it.url, title: it.title });
      continue;
    }
    const s = summaries.get(it.url) ?? "";
    const problems = validateWeeklySummary(it.title, s);
    if (problems.length > 0) invalid.push({ url: it.url, title: it.title, problems });
    else {
      ok.set(it.url, s);
      const w = weeklySummaryWarnings(s);
      if (w.length > 0) warnings.push({ url: it.url, title: it.title, warnings: w });
    }
  }
  const selected = new Set(items.map((it) => it.url));
  const orphans = summaries ? [...summaries.keys()].filter((u) => !selected.has(u)) : [];
  return { ok, missing, invalid, warnings, orphans };
}

/**
 * #11065: lê só o bloco `passes` do arquivo. null se o arquivo não existe ou
 * não é JSON válido — os erros de forma já são reportados por
 * `readWeeklySummaries`, que roda antes no mesmo fluxo.
 */
export function readWeeklySummaryPasses(path: string): WeeklySummaryPasses | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as WeeklySummariesFile;
    return data && typeof data === "object" && data.passes && typeof data.passes === "object" ? data.passes : {};
  } catch {
    return null;
  }
}

/**
 * #11065: avisos (não barram) sobre os passes de Humanizador e Clarice. O
 * preview do Passo 2 imprime estes avisos; o editor decide no gate.
 */
export function weeklySummaryPassWarnings(passes: WeeklySummaryPasses | null): string[] {
  if (passes === null) return [];
  const out: string[] = [];
  if (passes.humanizador !== "ok") {
    out.push("resumos NÃO passaram pelo Humanizador (Passo 2c, #11065) — texto ainda é o do agente");
  }
  if (passes.clarice === "falhou") {
    out.push(`Clarice falhou (${passes.clarice_error ?? "sem detalhe"}) — legenda usa o texto humanizado, sem revisão da Clarice`);
  } else if (passes.clarice !== "ok") {
    out.push("resumos NÃO passaram pela Clarice (Passo 2c, #11065)");
  }
  if (passes.clarice === "ok" && (passes.clarice_skipped ?? 0) > 0) {
    out.push(`${passes.clarice_skipped} sugestão(ões) da Clarice não aplicada(s) (âncora ambígua ou ausente) — confira os resumos`);
  }
  return out;
}
