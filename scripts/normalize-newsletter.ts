/**
 * normalize-newsletter.ts (#157)
 *
 * Pós-processador defensivo do output do writer (Stage 2). Corrige
 * formato quando o LLM concatena elementos numa linha única que o
 * template exige separados.
 *
 * Bugs cobertos:
 *
 * 1. Cabeçalho de destaque + 3 títulos colados:
 *    "DESTAQUE 1 | GEOPOLÍTICA Brasil... EUA... Pacotes..."
 *    →
 *    "DESTAQUE 1 | GEOPOLÍTICA\nBrasil...\nEUA...\nPacotes..."
 *
 * 2. Item de seção (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS) com
 *    título + descrição + URL na mesma linha:
 *    "Título qualquer Descrição em 1 frase. [https://x](https://x)"
 *    →
 *    "Título qualquer\nDescrição em 1 frase.\nhttps://x"
 *
 * Heurística conservadora — só reformata quando o pattern é claro;
 * caso ambíguo, deixa como está e sinaliza warning.
 *
 * Uso:
 *   npx tsx scripts/normalize-newsletter.ts \
 *     --in <md-path> \
 *     --out <md-path>
 *
 * Output JSON em stderr: { highlight_headers_split, section_items_split, warnings[] }.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface NormalizeReport {
  highlight_headers_split: number;
  section_items_split: number;
  warnings: string[];
}

const TITLE_MAX_CHARS = 52;
const TITLE_TOLERANCE = 60; // pequena folga; títulos válidos podem chegar a ~52

/**
 * Quebra "DESTAQUE N | CATEGORIA <título1> <título2> <título3>" em 4 linhas
 * separadas. Retorna a linha original se não detectar concatenação.
 *
 * Heurística: se a linha começa com "DESTAQUE N | CAT " e tem texto extra,
 * tenta dividir esse extra em 3 títulos por largura/pontuação.
 */
export function splitConcatenatedHighlightHeader(
  line: string,
): { lines: string[]; split: boolean } {
  const m = line.match(/^(DESTAQUE\s+\d+\s*\|\s*[A-ZÁ-Ú0-9 ]+?)\s+(.+)$/);
  if (!m) return { lines: [line], split: false };
  const header = m[1].trim();
  const rest = m[2].trim();
  if (!rest) return { lines: [line], split: false };

  // Tentar dividir o rest em 3 títulos. Estratégia: greedy split por largura.
  // Cada título deve ter palavras inteiras + ≤ TITLE_TOLERANCE chars.
  const words = rest.split(/\s+/);
  const titles: string[] = [];
  let current: string[] = [];
  for (const w of words) {
    const candidate = [...current, w].join(" ");
    if (
      candidate.length > TITLE_TOLERANCE &&
      current.length > 0 &&
      titles.length < 2
    ) {
      titles.push(current.join(" "));
      current = [w];
    } else {
      current.push(w);
    }
  }
  if (current.length > 0) titles.push(current.join(" "));

  // Só aceita split se chegou a exatamente 3 títulos plausíveis.
  if (titles.length !== 3) return { lines: [line], split: false };
  if (titles.some((t) => t.length === 0)) return { lines: [line], split: false };

  return { lines: [header, ...titles], split: true };
}

/**
 * Quebra item de seção concatenado.
 * Input típico: "Título Descrição em 1 frase. [https://...](https://...)"
 * Output: 3 linhas { título, descrição, url }.
 *
 * Heurística:
 *  1. Extrair URL (markdown link [url](url) OU bare url no fim)
 *  2. Texto antes do URL: separar em título + descrição usando
 *     último "." antes do URL (descrição é a última frase)
 *  3. Sem "." → não consegue separar título e descrição; emite warning
 *     mas retorna linha original (não destrói conteúdo)
 */
export function splitConcatenatedSectionItem(
  line: string,
): { lines: string[]; split: boolean; warning?: string } {
  // Caso A: markdown link [url](url) no fim
  const mdLinkMatch = line.match(/^(.+?)\s*\[([^\]]+)\]\(\2\)\s*$/);
  // Caso B: bare URL no fim
  const bareUrlMatch = line.match(/^(.+?)\s+(https?:\/\/\S+)\s*$/);

  let textBefore: string;
  let url: string;

  if (mdLinkMatch) {
    textBefore = mdLinkMatch[1].trim();
    url = mdLinkMatch[2].trim();
  } else if (bareUrlMatch) {
    textBefore = bareUrlMatch[1].trim();
    url = bareUrlMatch[2].trim();
  } else {
    return { lines: [line], split: false };
  }

  // Se não tem texto antes da URL → linha tem só URL, sem concat. Não tocar.
  if (!textBefore) return { lines: [line], split: false };

  // Tentar separar título + descrição usando último ". " no textBefore
  const lastPeriodIdx = textBefore.lastIndexOf(". ");
  if (lastPeriodIdx === -1) {
    // Não dá pra separar título de descrição com confiança.
    // Caso B (bare url) — a linha já tem texto + url; ainda quebra em 2 linhas
    // (texto / url). Caso A — converte markdown link em URL bare e quebra.
    return {
      lines: [textBefore, url],
      split: true,
      warning: `não consegui separar título de descrição (sem ponto): "${line.slice(0, 80)}..."`,
    };
  }

  const title = textBefore.slice(0, lastPeriodIdx + 1).trim();
  const description = textBefore.slice(lastPeriodIdx + 1).trim();

  // Se title fica muito curto (<5 chars) ou muito longo (>120), fallback
  if (title.length < 5 || title.length > 120) {
    return {
      lines: [textBefore, url],
      split: true,
      warning: `split heurístico produziu título estranho (${title.length} chars), preservei texto+url separados`,
    };
  }

  return { lines: [title, description, url], split: true };
}

const SECTION_HEADERS = [
  "LANÇAMENTOS",
  "LANCAMENTOS",
  "PESQUISAS",
  "OUTRAS NOTÍCIAS",
  "OUTRAS NOTICIAS",
  "NOTÍCIAS",
  "NOTICIAS",
];

function isSectionHeader(line: string): boolean {
  const trimmed = line.trim();
  return SECTION_HEADERS.some((h) => trimmed === h);
}

function isHighlightHeader(line: string): boolean {
  return /^DESTAQUE\s+\d+\s*\|/.test(line.trim());
}

function looksLikeUrl(line: string): boolean {
  return /https?:\/\//.test(line);
}

export function normalizeNewsletter(text: string): {
  text: string;
  report: NormalizeReport;
} {
  const lines = text.split("\n");
  const out: string[] = [];
  const report: NormalizeReport = {
    highlight_headers_split: 0,
    section_items_split: 0,
    warnings: [],
  };

  // Track section context — quando estamos dentro de LANÇAMENTOS/PESQUISAS/etc,
  // tentar split de items concatenados. Em DESTAQUE bodies, NÃO mexer (o LLM
  // pode ter URL no meio do parágrafo legitimamente — fora de escopo).
  let inSection: "highlight" | "section" | null = null;

  for (const raw of lines) {
    const line = raw;

    if (isHighlightHeader(line)) {
      const r = splitConcatenatedHighlightHeader(line);
      if (r.split) {
        report.highlight_headers_split++;
        out.push(...r.lines);
      } else {
        out.push(line);
      }
      inSection = "highlight";
      continue;
    }

    if (isSectionHeader(line)) {
      inSection = "section";
      out.push(line);
      continue;
    }

    if (line.trim() === "---") {
      // Reset section tracking em separadores (evita inferência cross-section).
      out.push(line);
      continue;
    }

    if (inSection === "section" && looksLikeUrl(line) && line.trim().length > 0) {
      // Detecta item concat: linha que tem texto + URL juntos
      const hasTextBeforeUrl = !/^\s*(\[?https?:\/\/|https?:\/\/)/.test(line);
      if (hasTextBeforeUrl) {
        const r = splitConcatenatedSectionItem(line);
        if (r.split) {
          report.section_items_split++;
          if (r.warning) report.warnings.push(r.warning);
          out.push(...r.lines);
        } else {
          out.push(line);
        }
        continue;
      }
    }

    out.push(line);
  }

  return { text: out.join("\n"), report };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error("Uso: normalize-newsletter.ts --in <md-path> --out <md-path>");
    process.exit(1);
  }
  const inPath = resolve(ROOT, args.in);
  const outPath = resolve(ROOT, args.out);
  const text = readFileSync(inPath, "utf8");
  const result = normalizeNewsletter(text);
  writeFileSync(outPath, result.text, "utf8");
  console.error(JSON.stringify(result.report, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
