/**
 * lint-density.ts (#5926, guardrail de densidade para leitor nível 2)
 *
 * Mede densidade de referência num `.md` ou `.html`: frases longas, nomes
 * próprios no corpo, siglas em caixa alta, estatísticas soltas. Tetos escalados
 * por `palavras/2000` — um artigo longo tolera mais nomes/stats absolutos, mas
 * a densidade relativa é constante.
 *
 * Advisory por padrão (exit 0); `--strict` devolve exit 1 acima do teto.
 * Uso:
 *   npx tsx scripts/lint-density.ts --file data/monthly/$CYCLE/draft.md
 *   npx tsx scripts/lint-density.ts --file draft.html --strict
 *   npx tsx scripts/lint-density.ts --file draft.md --json
 *
 * O script exporta funções puras (sem process.exit) para testes. O `main()`
 * — guardado por `isMainModule` — é o único que lida com I/O e exit codes.
 *
 * #5321 ("Perguntar é exceção"): não há CLI interativa, não há perguntas.
 * O output final SEMPRE inclui a linha fixa:
 *   "o mecanismo aparece num EXEMPLO concreto, ou só é explicado?"
 * — que é pergunta obrigatória do editor, não métrica automática.
 */

import { readFileSync, existsSync } from "node:fs";
import { stripHtml } from "./lib/strip-html.ts";
import { isMainModule, hasFlag, getArg } from "./lib/cli-args.ts";

// ── Allowlist de produtos/brands conhecidos (não contam como nome próprio) ───

export const KNOWN_PRODUCTS: ReadonlySet<string> = new Set([
  "ChatGPT", "Claude", "Gemini", "Anthropic", "OpenAI", "Google", "Microsoft",
  "Apple", "Meta", "Amazon", "DeepSeek", "xAI", "Perplexity", "X.ai",
  "Hugging Face", "NVIDIA", "Mistral", "Cohere", "Stability AI", "Midjourney",
  "Runway", "ElevenLabs", "OpenRouter", "Beehiiv", "Clarice", "LinkedIn",
  "Facebook", "Instagram", "Twitter", "Threads", "Slack", "Notion",
  "GitHub", "Netflix", "Spotify", "Adobe", "Salesforce",
]);

// ── Siglas excluídas do count (acrônimos de uso universal) ────────────────────

export const EXCLUDED_ACRONYMS: ReadonlySet<string> = new Set([
  "IA", "EUA", "ONU", "PT-BR", "PT",
  // GPT-N é tratado via regex (GPT-4, GPT-3, etc. — "GPT" isolado desconsiderado)
]);

// ── Stopwords que não contam como nomes próprios mesmo sendo capitalizadas ───

const STOPWORDS: ReadonlySet<string> = new Set([
  "O", "A", "Os", "As", "Um", "Uma", "Uns", "Umas", "E", "Ou", "Mas",
  "Se", "Porque", "Pelo", "Pela", "Pelos", "Pelas", "Do", "Da", "Dos", "Das",
  "De", "Em", "No", "Na", "Nos", "Nas", "Com", "Por", "Para", "Desde", "Até",
  "Sobre", "Entre", "Sem", "Sob", "Como", "Qual", "Quando", "Onde",
  "Portanto", "Entretanto", "Contudo", "Todavia", "Enquanto", "Assim",
  "Conforme", "Segundo", "Através", "Durante", "Após", "Antes", "Depois",
  "Ainda", "Também", "Tão", "Tanto", "Quanto", "Este", "Esta", "Estes", "Estas",
  "Esse", "Essa", "Esses", "Essas", "Aquele", "Aquela", "Aqueles", "Aquelas",
  "Outro", "Outra", "Outros", "Outras", "Tal", "Tais", "Cada", "Todo", "Toda",
  "Todos", "Todas", "Nenhum", "Nenhuma",
]);

// ── Thresholds base (para 2000 palavras) ──────────────────────────────────────

export interface Thresholds {
  longPhrases: number;     // frases > 30 palavras
  properNouns: number;     // nomes próprios no corpo
  acronyms: number;        // siglas em caixa alta
  statistics: number;       // estatísticas soltas
}

/** Base thresholds para 2000 palavras. Escalados linearmente */
export const BASE_THRESHOLDS: Thresholds = {
  longPhrases: 3,
  properNouns: 2,
  acronyms: 1,
  statistics: 3,
};

/** Computa tetos escalados pelo tamanho do texto (wordCount/2000, ceil). */
export function computeThresholds(wordCount: number): Thresholds {
  const mult = wordCount / 2000;
  return {
    longPhrases: Math.max(1, Math.ceil(BASE_THRESHOLDS.longPhrases * mult)),
    properNouns: Math.max(1, Math.ceil(BASE_THRESHOLDS.properNouns * mult)),
    acronyms: Math.max(1, Math.ceil(BASE_THRESHOLDS.acronyms * mult)),
    statistics: Math.max(1, Math.ceil(BASE_THRESHOLDS.statistics * mult)),
  };
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface LongPhraseResult {
  count: number;
  longest: string;
  longestWordCount: number;
  threshold: number;
}

export interface ProperNounResult {
  count: number;
  examples: string[];
  threshold: number;
}

export interface AcronymResult {
  count: number;
  examples: string[];
  threshold: number;
}

export interface StatisticResult {
  count: number;
  examples: string[];
  threshold: number;
}

export interface LintMetrics {
  wordCount: number;
  thresholds: Thresholds;
  longPhrases: LongPhraseResult;
  properNouns: ProperNounResult;
  acronyms: AcronymResult;
  statistics: StatisticResult;
  withinThresholds: boolean;
  exceeded: string[];
}

// ── Prose extraction ──────────────────────────────────────────────────────────

/** Remove blocos <style>, <script> incluindo JSON-LD, e tags HTML remanescentes. */
export function stripHtmlAdvanced(html: string): string {
  let text = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n\n")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n\n");
  // stripHtml preserva hrefs e normaliza quebras de bloco
  return stripHtml(text);
}

/** Remove code blocks markdown (```...```). */
function stripCodeBlocks(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "");
}

/** Remove seção de fontes (## Fontes, ### Referências, etc.) até o fim do doc.
 * Nomes de autor/institution na fonte não contam como "no corpo" (#5926). */
function removeSourcesSection(text: string): string {
  const sourcesHeading = /(?:\n##?\s+(?:fontes?|referências?|bibliography)\b)/i;
  const idx = text.search(sourcesHeading);
  if (idx !== -1) return text.slice(0, idx);
  return text;
}

/** Remove headings markdown inteiramente (## Destaque 1 | TEMA → linha removida).
 * Preserva o conteúdo das seções, só descarta os cabeçalhos. */
function removeHeadings(md: string): string {
  return md.replace(/^#{1,6}\s+.*$/gm, "");
}

/** Remove marcação markdown (bold, itálico, links, bullets) preservando texto. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")       // bold
    .replace(/\*([^*]+)\*/g, "$1")           // itálico
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // links: keep anchor, drop URL
    .replace(/^\s*[-*•]\s+/gm, "")            // bullets
    .replace(/^\s*\d+\.\s+/gm, "")            // numbered lists
    .replace(/^\s*>\s+/gm, "")                // blockquotes
    .replace(/!\s*$/gm, "");                  // standalone !
}

/** Extrai a prosa do texto — funciona para .md e .html. */
export function extractProse(text: string): string {
  const looksLikeHtml = /<\s*(?:html|body|head|div|p|span|style|script)\b/i.test(text);
  let prose = looksLikeHtml ? stripHtmlAdvanced(text) : text;

  if (!looksLikeHtml) {
    prose = stripCodeBlocks(prose);
  }

  // Remove seção de fontes
  prose = removeSourcesSection(prose);

  // Remove headings (antes de stripMarkdown, senão o texto do header vira prosa)
  prose = removeHeadings(prose);

  // Strip markdown formatting
  prose = stripMarkdown(prose);

  // Colapsa whitespace
  prose = prose.replace(/\n{3,}/g, "\n\n").trim();

  return prose;
}

// ── Sentence splitting ────────────────────────────────────────────────────────

/** Divide texto em frases (português). Protege abreviações comuns e decimais. */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\b(p\.?ex\.?|e\.?g\.?|etc\.?|sr\.?|sra\.?|dr\.?|dra\.?|prof\.?|profa\.?|srta\.?\.?)/gi, "$1___")
    .replace(/(\d)\.(\d)/g, "$1___.$2"); // protege decimal 3.14

  const parts = protectedText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/___\./g, ".").replace(/___/g, ""))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return parts;
}

// ── Word counting ─────────────────────────────────────────────────────────────

export function countWords(text: string): number {
  const cleaned = text.replace(/[^\p{L}\p{N}\s'-]/gu, " ");
  const words = cleaned.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

const NON_WORD_CHARS = /[.,;:!?()[\]{}'\"]+/g;

/** Frases com mais de `limit` palavras (default 30) + a maior frase encontrada. */
export function measureLongPhrases(sentences: string[], limit = 30, threshold: number = 3): LongPhraseResult {
  let count = 0;
  let longest = "";
  let longestWordCount = 0;

  for (const s of sentences) {
    const words = s.replace(/[^\p{L}\p{N}\s'-]/gu, " ").trim().split(/\s+/).filter((w) => w.length > 0);
    const wc = words.length;
    if (wc > limit) count++;
    if (wc > longestWordCount) {
      longestWordCount = wc;
      longest = s.slice(0, 200) + (s.length > 200 ? "…" : "");
    }
  }

  return { count, longest, longestWordCount, threshold };
}

/** Nomes próprios (palavras capitalizadas) que NÃO abrem frase. */
export function measureProperNouns(sentences: string[], threshold: number = 2): ProperNounResult {
  const examples = new Set<string>();

  for (const s of sentences) {
    const words = s.trim().split(/\s+/);
    for (let j = 1; j < words.length; j++) {
      const raw = words[j].replace(NON_WORD_CHARS, "").trim();
      if (raw.length < 3) continue;
      // must start with a capital letter (Unicode uppercase)
      if (!/^\p{Lu}/u.test(raw)) continue;
      if (STOPWORDS.has(raw)) continue;
      if (KNOWN_PRODUCTS.has(raw)) continue;
      // skip "GPT-N" style
      if (/^GPT-\d/.test(raw)) continue;
      // skip pure acronyms (all caps, 2+ letter) — handled by measureAcronyms
      if (/^[A-Z]{2,}$/.test(raw)) continue;
      // skip if it's part of a known product name (e.g. "AI" from "OpenAI")
      // — already covered by KNOWN_PRODUCTS check above
      examples.add(raw);
    }
  }

  return {
    count: examples.size,
    examples: Array.from(examples).slice(0, 15),
    threshold,
  };
}

/** Siglas em caixa alta (2+ letras), excluindo GPT-N, EUA, ONU, IA, allowlist. */
export function measureAcronyms(sentences: string[], threshold: number = 1): AcronymResult {
  const examples = new Map<string, number>();
  const acronymRe = /\b([A-Z]{2,})\b/g;

  for (const s of sentences) {
    for (const m of s.matchAll(acronymRe)) {
      const acr = m[1];
      if (EXCLUDED_ACRONYMS.has(acr)) continue;
      // skip GPT-N pattern: se "GPT-" aparece logo depois, não contar "GPT" isolado
      const afterMatch = s.slice(m.index + acr.length, m.index + acr.length + 2);
      if (acr === "GPT" && afterMatch.startsWith("-")) continue;
      // skip if preceded by a word char (part of larger camelCase)
      const beforeMatch = s.slice(Math.max(0, m.index - 1), m.index);
      if (beforeMatch && /\p{L}/u.test(beforeMatch)) continue;
      examples.set(acr, (examples.get(acr) ?? 0) + 1);
    }
  }

  return {
    count: examples.size,
    examples: Array.from(examples.keys()).slice(0, 15),
    threshold,
  };
}

/** Estatísticas soltas: percentuais, "N pontos percentuais", números com unidade sem fonte. */
export function measureStatistics(sentences: string[], threshold: number = 3): StatisticResult {
  const examples = new Set<string>();
  const joined = sentences.join(" ");

  // Percentuais: 42%, 42 por cento, 42,5%
  const pctRe = /\b(\d{1,3}(?:[,.]\d+)?)\s*(%|por\s*cento|porcento)/gi;
  for (const m of joined.matchAll(pctRe)) {
    examples.add(`% ${m[0]}`);
  }

  // "N pontos percentuais" / "Npp"
  const ppRe = /\b(\d+)\s*(pontos?\s+percentuais?|pp)\b/gi;
  for (const m of joined.matchAll(ppRe)) {
    examples.add(`pp ${m[0]}`);
  }

  // "N em cada M" — sem fonte inline (número solto sem atribuição)
  const ratioRe = /\b(\d+)\s+em\s+cada\s+\d+\b/gi;
  for (const m of joined.matchAll(ratioRe)) {
    examples.add(`ratio ${m[0]}`);
  }

  return {
    count: examples.size,
    examples: Array.from(examples).slice(0, 15),
    threshold,
  };
}

// ── Main orchestration ────────────────────────────────────────────────────────

export function runLint(text: string): LintMetrics {
  const prose = extractProse(text);
  const wordCount = countWords(prose);
  const sentences = splitSentences(prose);
  const thresholds = computeThresholds(wordCount);

  const longPhrases = measureLongPhrases(sentences, 30, thresholds.longPhrases);
  const properNouns = measureProperNouns(sentences, thresholds.properNouns);
  const acronyms = measureAcronyms(sentences, thresholds.acronyms);
  const statistics = measureStatistics(sentences, thresholds.statistics);

  const exceeded: string[] = [];
  if (longPhrases.count > thresholds.longPhrases) exceeded.push("longPhrases");
  if (properNouns.count > thresholds.properNouns) exceeded.push("properNouns");
  if (acronyms.count > thresholds.acronyms) exceeded.push("acronyms");
  if (statistics.count > thresholds.statistics) exceeded.push("statistics");

  return {
    wordCount,
    thresholds,
    longPhrases,
    properNouns,
    acronyms,
    statistics,
    withinThresholds: exceeded.length === 0,
    exceeded,
  };
}

// ── Output ────────────────────────────────────────────────────────────────────

export function formatResults(metrics: LintMetrics, filePath: string, strict: boolean): string {
  const lines: string[] = [];
  const flag = strict ? "[STRICT]" : "[advisory]";
  lines.push(`📊 lint-density ${flag} — ${filePath}`);
  const multLabel = (metrics.wordCount / 2000).toFixed(2);
  lines.push(`   Palavras: ${metrics.wordCount} (${multLabel}× base)`);
  lines.push("");

  const rows = [
    { label: "Frases > 30 palavras", value: metrics.longPhrases.count, threshold: metrics.thresholds.longPhrases, extra: `maior: ${metrics.longPhrases.longestWordCount} pal.` },
    { label: "Nomes próprios no corpo", value: metrics.properNouns.count, threshold: metrics.thresholds.properNouns, extra: metrics.properNouns.examples.slice(0, 5).join(", ") || "nenhum" },
    { label: "Siglas em caixa alta", value: metrics.acronyms.count, threshold: metrics.thresholds.acronyms, extra: metrics.acronyms.examples.slice(0, 5).join(", ") || "nenhuma" },
    { label: "Estatísticas soltas", value: metrics.statistics.count, threshold: metrics.thresholds.statistics, extra: metrics.statistics.examples.slice(0, 5).join(", ") || "nenhuma" },
  ];

  for (const r of rows) {
    const status = r.value <= r.threshold ? "✓" : "⚠ EXCEDE";
    const extra = r.extra ? `  (${r.extra})` : "";
    lines.push(`  ${r.label}: ${r.value} / ${r.threshold}  ${status}${extra}`);
  }

  lines.push("");
  lines.push(`💡 Teto escalado por palavras/2000. Advisory por padrão; --strict falha acima do teto.`);
  lines.push("");
  lines.push(`💭 o mecanismo aparece num EXEMPLO concreto, ou só é explicado?`);

  if (!metrics.withinThresholds && strict) {
    lines.push("");
    lines.push(`❌ FALHA (--strict): ${metrics.exceeded.join(", ")} excedeu o teto.`);
  }

  return lines.join("\n");
}

export function formatJson(metrics: LintMetrics, filePath: string): string {
  return JSON.stringify({ file: filePath, strict: metrics.withinThresholds, metrics }, null, 2);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  const filePath = getArg(argv, "file") || getArg(argv, "f");
  const strict = hasFlag(argv, "strict");
  const json = hasFlag(argv, "json") || getArg(argv, "format") === "json";

  if (!filePath) {
    console.error("Uso: npx tsx scripts/lint-density.ts --file <caminho> [--strict] [--json]");
    process.exit(2);
  }
  if (!existsSync(filePath)) {
    console.error(`[lint-density] Arquivo não encontrado: ${filePath}`);
    process.exit(2);
  }

  const text = readFileSync(filePath, "utf8");
  const metrics = runLint(text);

  if (json) {
    console.log(formatJson(metrics, filePath));
  } else {
    console.log(formatResults(metrics, filePath, strict));
  }

  if (strict && !metrics.withinThresholds) {
    process.exit(1);
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
