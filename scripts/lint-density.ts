/**
 * lint-density.ts (#5926, guardrail de densidade de referência pro artigo especial)
 *
 * Mede densidade de referência num `.md` ou `.html` e imprime uma tabela com
 * tetos (escalados por `palavras/2000`). Extrai só prosa: ignora `<style>`,
 * `<script>`, JSON-LD, a lista de Fontes e infográficos duplicados.
 *
 * Métricas:
 * - frases > 30 palavras e a maior frase
 * - nomes próprios que não abrem frase (heurística de capitalização, com
 *   allowlist de produtos/brand que o leitor conhece: ChatGPT, Claude, Gemini,
 *   Anthropic…)
 * - siglas em caixa alta (excluindo GPT-N, EUA, ONU, IA, etc.)
 * - percentuais e "N pontos percentuais"
 * - uma linha final fixa: "o mecanismo aparece num EXEMPLO concreto, ou só é
 *   explicado?" — isso nenhum regex mede, então vira pergunta obrigatória no output.
 *
 * Uso:
 *   npx tsx scripts/lint-density.ts --file data/monthly/2605/draft.md
 *   npx tsx scripts/lint-density.ts --file path/to/article.html --strict
 *
 *   --file   (obrigatório) path do .md ou .html a analisar
 *   --strict (opcional)   exit 1 quando algum teto for excedido
 *
 * Exit codes:
 *   0  ok (warnings acima do teto só disparam exit 1 com --strict)
 *   1  teto excedido (--strict)
 *   2  erro de I/O (--file ausente ou arquivo não encontrado)
 */

import { readFileSync } from "node:fs";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

/** Produtos/brand names que o leitor conhece — NÃO contam como "densidade". */
const PROPER_NAME_ALLOWLIST = new Set([
  "ChatGPT", "Claude", "Gemini", "Anthropic", "OpenAI", "Google",
  "Microsoft", "Meta", "Amazon", "Apple", "DeepSeek", "xAI",
  "Grok", "Perplexity", "Copilot", "Bard", "GPT",
]);

/** Siglas/técnicas em caixa alta que não contam como densidade. */
const ACRONYM_EXCLUSIONS = new Set([
  "GPT-4", "GPT-3", "GPT-N", "GPT-5",
  "EUA", "ONU", "IA",
  "HTML", "CSS", "API", "URL", "HTTP", "HTTPS", "KV",
  "JSON", "CSV", "XML", "SQL", "REST", "CRUD",
  "SEO", "UI", "UX", "SDK", "CLI", "MCP",
]);

export interface DensityMetrics {
  wordCount: number;
  longPhraseCount: number;
  longestPhraseWords: number;
  properNameCount: number;
  acronymCount: number;
  statCount: number;
}

/** Thresholds de referência (como no benchmark Superinteressante). */
const BASE_THRESHOLDS = {
  longPhrase: 2,
  properName: 0,
  acronym: 1,
  stat: 3,
};

const WORDS_PER_SCALE = 2000;

/**
 * Ajusta o texto HTML: remove <style>, <script> (incl. JSON-LD), extrai só
 * prosa do markdown ou do HTML. Remove a seção de Fontes se presente.
 * Função pura — recebe texto bruto e o nome do arquivo (pra detectar .html).
 */
export function extractProse(raw: string, filename: string): string {
  let text = raw;

  // NOTA: remover a seção de Fontes ANTES de stripar markdown — senão o `##`
  // do título "## Fontes" vira espaço e o regex de heading não casa.
  text = text.replace(
    /(?:\n|^)(?:##?\s*(?:Fontes|Sources|Referências|REFERÊNCIAS)\b)[\s\S]*$/i,
    "\n",
  );

  if (filename.endsWith(".html")) {
    // #4505: remover JSON-LD (script[type=application/ld+json]) e outros scripts
    text = text.replace(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
      "",
    );
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  }

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Markdown: remover imagens ANTES de extrair link text (senão o `!` fica sobrando)
  text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  // Extrai texto âncora de links [texto](url)
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Strip formatting restante
  text = text.replace(/[#>`*~_]{1,3}/g, " ");

  return text.replace(/\s+/g, " ").trim();
}

/** Divide em sentenças. Usa . ! ? como delimitadores. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[.!?]+\s*$/, "").trim())
    .filter((s) => s.length > 0);
}

/** Conta palavras numa string. */
function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/**
 * Pure: mede a densidade do texto extraído (próprio do texto bruto, sem I/O).
 * Recebe o texto já extraído como prosa (ver extractProse).
 */
export function measureDensity(prose: string): DensityMetrics {
  const sentences = splitSentences(prose);
  const wordCount = countWords(prose);

  // --- Frases > 30 palavras ---
  let longPhraseCount = 0;
  let longestPhraseWords = 0;
  for (const s of sentences) {
    const w = countWords(s);
    if (w > 30) longPhraseCount++;
    if (w > longestPhraseWords) longestPhraseWords = w;
  }

  // --- Nomes próprios que não abrem frase ---
  let properNameCount = 0;
  const wordRe = /\b\w+\b/g;
  for (const s of sentences) {
    const words = s.match(wordRe) ?? [];
    // Primeira palavra de cada frase abre a frase — não conta.
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!;
      // Capitalizada, não all-caps (acrônimo), e não na allowlist de produtos
      if (
        /^[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÑ][a-záéíóúâêîôûãõñç]+/.test(w) &&
        !/^[^A-Z]*[a-z]/.test(w) && // garante mixed-case, não all-caps
        !PROPER_NAME_ALLOWLIST.has(w)
      ) {
        properNameCount++;
      }
    }
  }

  // --- Siglas em caixa alta ---
  const acronymRe = /\b[A-Z]{2,}(?:-\d)?\b/g;
  let acronymCount = 0;
  let m: RegExpExecArray | null;
  while ((m = acronymRe.exec(prose)) !== null) {
    const up = m[0].toUpperCase();
    if (!ACRONYM_EXCLUSIONS.has(up)) {
      acronymCount++;
    }
  }

  // --- Percentuais e "N pontos percentuais" ---
  const percentRe = /\b\d+(?:[,.]\d+)?\s*%|ponto?s?\s*percentuais?/gi;
  let statCount = 0;
  while ((m = percentRe.exec(prose)) !== null) {
    statCount++;
  }

  return {
    wordCount,
    longPhraseCount,
    longestPhraseWords,
    properNameCount,
    acronymCount,
    statCount,
  };
}

/**
 * Calcula o threshold escalado: base * ceil(wordCount / WORDS_PER_SCALE).
 * Garante no mínimo 1 (mesmo texto muito curto pega o teto base).
 */
export function scaledThreshold(base: number, wordCount: number): number {
  const scale = Math.max(1, Math.ceil(wordCount / WORDS_PER_SCALE));
  return base * scale;
}

/** Resultado formatado para impressão. */
export interface LintDensityReport {
  metrics: DensityMetrics;
  thresholds: {
    longPhrase: number;
    properName: number;
    acronym: number;
    stat: number;
  };
  violations: string[];
  hasViolations: boolean;
}

/**
 * Pure: produz o relatório de densidade a partir do texto extraído.
 * Separado de main() para testes sem I/O.
 */
export function lintDensity(prose: string): LintDensityReport {
  const metrics = measureDensity(prose);
  const thresholds = {
    longPhrase: scaledThreshold(BASE_THRESHOLDS.longPhrase, metrics.wordCount),
    properName: scaledThreshold(BASE_THRESHOLDS.properName, metrics.wordCount),
    acronym: scaledThreshold(BASE_THRESHOLDS.acronym, metrics.wordCount),
    stat: scaledThreshold(BASE_THRESHOLDS.stat, metrics.wordCount),
  };

  const violations: string[] = [];
  if (metrics.longPhraseCount > thresholds.longPhrase) {
    violations.push(
      `frases > 30 palavras: ${metrics.longPhraseCount} (teto ${thresholds.longPhrase}, maior frase ${metrics.longestPhraseWords})`,
    );
  }
  if (metrics.properNameCount > thresholds.properName) {
    violations.push(
      `nomes próprios que não abrem frase: ${metrics.properNameCount} (teto ${thresholds.properName})`,
    );
  }
  if (metrics.acronymCount > thresholds.acronym) {
    violations.push(
      `siglas em caixa alta: ${metrics.acronymCount} (teto ${thresholds.acronym})`,
    );
  }
  if (metrics.statCount > thresholds.stat) {
    violations.push(
      `percentuais / "pontos percentuais": ${metrics.statCount} (teto ${thresholds.stat})`,
    );
  }

  return {
    metrics,
    thresholds,
    violations,
    hasViolations: violations.length > 0,
  };
}

/** Imprime a tabela de densidade no console. */
export function printDensityReport(report: LintDensityReport, strict: boolean): void {
  const { metrics, thresholds } = report;
  const wordScale = Math.max(1, Math.ceil(metrics.wordCount / WORDS_PER_SCALE));

  console.log(`[lint-density] ${metrics.wordCount} palavras (escala ×${wordScale} a cada ${WORDS_PER_SCALE} palavras)`);
  console.log("┌────────────────────────────────────────────────┬─────┬─────┐");
  console.log("│ Métrica                                      │   N │ Teto│");
  console.log("├────────────────────────────────────────────────┼─────┼─────┤");
  console.log(`│ Frases > 30 palavras (maior=${metrics.longestPhraseWords}) │ ${String(metrics.longPhraseCount).padStart(3)} │ ${String(thresholds.longPhrase).padStart(3)} │`);
  console.log(`│ Nomes próprios que não abrem frase             │ ${String(metrics.properNameCount).padStart(3)} │ ${String(thresholds.properName).padStart(3)} │`);
  console.log(`│ Siglas em caixa alta                           │ ${String(metrics.acronymCount).padStart(3)} │ ${String(thresholds.acronym).padStart(3)} │`);
  console.log(`│ Percentuais / "pontos percentuais"             │ ${String(metrics.statCount).padStart(3)} │ ${String(thresholds.stat).padStart(3)} │`);
  console.log("└────────────────────────────────────────────────┴─────┴─────┘");

  if (report.hasViolations) {
    console.log("\n⚠ Violações de densidade:");
    for (const v of report.violations) {
      console.log(`  • ${v}`);
    }
  } else {
    console.log("\n✓ densidade dentro dos tetos (ou --strict não foi passado).");
  }

  // Linha final fixa — nenhum regex mede se o mecanismo aparece num exemplo
  console.log("\n❓ o mecanismo aparece num EXEMPLO concreto, ou só é explicado?");

  if (report.hasViolations && strict) {
    console.error("\n[lint-density] --strict: densidade acima do teto — revisar antes de publicar.");
    process.exit(1);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const file = args.values["file"];
  const strict = args.flags.has("strict");

  if (!file) {
    console.error("Uso: npx tsx scripts/lint-density.ts --file <path> [--strict]");
    process.exit(2);
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`[lint-density] Erro lendo ${file}: ${(e as Error).message}`);
    process.exit(2);
  }

  const prose = extractProse(raw, file);
  const report = lintDensity(prose);
  printDensityReport(report, strict);
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
