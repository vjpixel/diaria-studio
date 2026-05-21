#!/usr/bin/env tsx
/**
 * lint-humanized-output.ts (#1439)
 *
 * Compara o output do humanizador (skill `humanizador`) contra o input
 * pre-humanizador pra detectar regressões estruturais — o humanizador é
 * LLM-driven e às vezes "limpa" markdown técnico que precisa ser preservado
 * literal:
 *
 *   1. Trailing whitespace de 2 espaços (forçar `<br>` em renderer Beehiiv/Drive)
 *   2. Aninhação `**[Title](url)**` (vs `[**Title**](url)` que é equivalente
 *      em renderização mas pode confundir parsers downstream que assumem o
 *      formato canônico do writer)
 *   3. Frontmatter YAML / HTML comments
 *   4. Section headers fixos (`**🚀 LANÇAMENTOS**`, `**🎁 SORTEIO**`, etc.)
 *
 * Caso real 260521:
 *   - `_internal/02-draft.md` (writer): 16 linhas com trailing `  `
 *   - `_internal/02-humanized.md` (humanizador): 9 linhas (perdeu 7)
 *   - `02-reviewed.md` final: 1 linha (perdeu mais 8 pós-Clarice)
 *
 * Resultado: títulos+descrições das seções LANÇAMENTOS/PESQUISAS/OUTRAS
 * NOTÍCIAS colapsaram em parágrafo único no renderer.
 *
 * Uso:
 *   npx tsx scripts/lint-humanized-output.ts \
 *     --pre data/editions/260521/_internal/02-normalized.md \
 *     --post data/editions/260521/_internal/02-humanized.md
 *     [--max-trailing-loss 2]
 *     [--max-bold-link-nesting-loss 1]
 *
 * Exit codes:
 *   0 — output OK (ou loss dentro da tolerância)
 *   1 — regressão estrutural detectada
 *   2 — erro de uso (args / arquivo ausente)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface HumanizerMetrics {
  /** Linhas terminadas em `  ` (2 espaços trailing → markdown `<br>`) */
  trailing_2space_lines: number;
  /** Ocorrências de `**[Title](url)**` (bold envolvendo link como um todo) */
  bold_link_nesting: number;
  /** Ocorrências de `[**Title**](url)` (bold dentro do link) — formato alternativo */
  link_with_inner_bold: number;
  /** Tem frontmatter YAML? */
  has_frontmatter: boolean;
  /** Section headers fixos: `**SORTEIO**`, `**ASSINE**`, `**ERRO INTENCIONAL**`, etc. */
  fixed_section_headers: number;
  /** Section headers principais: `**🚀 LANÇAMENTOS**`, `**🔬 PESQUISAS**`, `**📰 OUTRAS NOTÍCIAS**` */
  main_section_headers: number;
}

const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*$/m;
const BOLD_LINK_NESTING_RE = /\*\*\[[^\]]+?\]\([^)]+?\)\*\*/g;
const LINK_WITH_INNER_BOLD_RE = /\[\*\*[^*]+?\*\*\]\([^)]+?\)/g;
const FIXED_SECTION_HEADER_RE =
  /^\*\*[^\n\[]*?(?:SORTEIO|PARA ENCERRAR|ERRO INTENCIONAL|ASSINE|TÍTULO|SUBTÍTULO)[^\n]*\*\*\s*$/gim;
const MAIN_SECTION_HEADER_RE =
  /^\*\*[^\n\[]*?(?:LAN[ÇC]AMENTOS?|PESQUISAS?|OUTRAS\s+NOT[ÍI]CIAS?)[^\n]*\*\*\s*$/gim;

/**
 * Pure: extrai métricas estruturais de um markdown.
 */
export function computeHumanizerMetrics(md: string): HumanizerMetrics {
  return {
    trailing_2space_lines: (md.match(/  $/gm) ?? []).length,
    bold_link_nesting: (md.match(BOLD_LINK_NESTING_RE) ?? []).length,
    link_with_inner_bold: (md.match(LINK_WITH_INNER_BOLD_RE) ?? []).length,
    has_frontmatter: FRONTMATTER_RE.test(md),
    fixed_section_headers: (md.match(FIXED_SECTION_HEADER_RE) ?? []).length,
    main_section_headers: (md.match(MAIN_SECTION_HEADER_RE) ?? []).length,
  };
}

export interface RegressionReport {
  ok: boolean;
  violations: string[];
  metrics: { pre: HumanizerMetrics; post: HumanizerMetrics };
}

export interface CompareOptions {
  /** Tolerância de linhas trailing 2-space perdidas. Default 2. */
  max_trailing_loss?: number;
  /** Tolerância de aninhações bold-link perdidas. Default 1. */
  max_bold_link_nesting_loss?: number;
}

/**
 * Pure: compara métricas pre vs post-humanizador e retorna violações.
 *
 * Critérios (cada um vira violation se quebrado):
 *   1. Trailing 2-space count não pode cair mais que `max_trailing_loss`
 *      (humanizador removendo `  ` força colapso de parágrafos no renderer)
 *   2. Frontmatter presente no pre tem que estar no post
 *   3. Cada section header fixo do pre tem que estar no post (literal preservation)
 *   4. Cada main section header do pre tem que estar no post
 *   5. Total de bold-link nesting + link-with-inner-bold deve ser preservado
 *      (writer escreve `**[X](url)**`; humanizador às vezes vira `[**X**](url)`
 *      — equivalente mas indica mudança de aninhação que pode quebrar parsers)
 */
export function compareHumanizerOutput(
  pre: string,
  post: string,
  opts: CompareOptions = {},
): RegressionReport {
  const maxTrailingLoss = opts.max_trailing_loss ?? 2;
  const maxBoldLinkNestingLoss = opts.max_bold_link_nesting_loss ?? 1;

  const preMetrics = computeHumanizerMetrics(pre);
  const postMetrics = computeHumanizerMetrics(post);
  const violations: string[] = [];

  const trailingLoss = preMetrics.trailing_2space_lines - postMetrics.trailing_2space_lines;
  if (trailingLoss > maxTrailingLoss) {
    violations.push(
      `trailing-whitespace-loss: pre=${preMetrics.trailing_2space_lines} post=${postMetrics.trailing_2space_lines} (perdeu ${trailingLoss}; tolerância ${maxTrailingLoss}). Linhas com trailing 2 espaços viram <br> no renderer; sem elas, título e descrição colam em parágrafo único.`,
    );
  }

  if (preMetrics.has_frontmatter && !postMetrics.has_frontmatter) {
    violations.push(
      "frontmatter-loss: YAML frontmatter presente no input desapareceu no output (humanizador removeu o bloco `---...---`).",
    );
  }

  if (postMetrics.fixed_section_headers < preMetrics.fixed_section_headers) {
    violations.push(
      `fixed-section-header-loss: pre=${preMetrics.fixed_section_headers} post=${postMetrics.fixed_section_headers}. Headers fixos (SORTEIO/PARA ENCERRAR/ERRO INTENCIONAL/ASSINE/TÍTULO/SUBTÍTULO) precisam ficar literal.`,
    );
  }

  if (postMetrics.main_section_headers < preMetrics.main_section_headers) {
    violations.push(
      `main-section-header-loss: pre=${preMetrics.main_section_headers} post=${postMetrics.main_section_headers}. Headers principais (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS) precisam ficar literal.`,
    );
  }

  // Aninhação bold-link: contar total combinado (ambos formatos) — humanizador
  // pode converter um pro outro sem regredir o renderer.
  const preTotal = preMetrics.bold_link_nesting + preMetrics.link_with_inner_bold;
  const postTotal = postMetrics.bold_link_nesting + postMetrics.link_with_inner_bold;
  if (preTotal - postTotal > maxBoldLinkNestingLoss) {
    violations.push(
      `bold-link-nesting-loss: pre=${preTotal} post=${postTotal} (perdeu ${preTotal - postTotal}; tolerância ${maxBoldLinkNestingLoss}). Aninhação bold+link de títulos de seção foi removida — quebra título de item.`,
    );
  }

  return {
    ok: violations.length === 0,
    violations,
    metrics: { pre: preMetrics, post: postMetrics },
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pre || !args.post) {
    console.error(
      "Uso: lint-humanized-output.ts --pre <md> --post <md> [--max-trailing-loss N] [--max-bold-link-nesting-loss N]",
    );
    process.exit(2);
  }
  const prePath = resolve(args.pre);
  const postPath = resolve(args.post);
  if (!existsSync(prePath)) {
    console.error(`Arquivo pre não existe: ${prePath}`);
    process.exit(2);
  }
  if (!existsSync(postPath)) {
    console.error(`Arquivo post não existe: ${postPath}`);
    process.exit(2);
  }
  const pre = readFileSync(prePath, "utf8");
  const post = readFileSync(postPath, "utf8");

  const opts: CompareOptions = {};
  if (args["max-trailing-loss"]) {
    opts.max_trailing_loss = Number(args["max-trailing-loss"]);
  }
  if (args["max-bold-link-nesting-loss"]) {
    opts.max_bold_link_nesting_loss = Number(args["max-bold-link-nesting-loss"]);
  }

  const report = compareHumanizerOutput(pre, post, opts);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}` ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  main();
}
