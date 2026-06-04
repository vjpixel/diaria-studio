/**
 * singularize-md-sections.ts (#1324)
 *
 * Lê um MD da newsletter (pós-writer, pós-normalize), conta items em cada
 * seção secundária (LANÇAMENTOS, RADAR, USE MELHOR, VÍDEOS + aliases legacy
 * PESQUISAS/OUTRAS NOTÍCIAS), e re-escreve o header com o nome correto
 * (singular quando N=1) + emoji prefix canônico (#1328).
 *
 * Idempotente: rodar 2x não muda nada (idempotência preservada via
 * `displaySectionName` que normaliza o prefix).
 *
 * Uso:
 *   npx tsx scripts/singularize-md-sections.ts --md data/editions/AAMMDD/02-reviewed.md
 *
 * Output: sobrescreve o arquivo em-place. Stdout: JSON resumo
 *   { changed: boolean, sections: [{ name, before, after, count }] }
 *
 * Roda no Stage 2 pós-normalize, antes do humanizador (ver
 * orchestrator-stage-2.md § 2c).
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  displaySectionName,
  stripEmojiPrefix,
  sectionHeaderRegex,
  ALL_SECTION_NAMES_PATTERN,
  SECTION_EMOJI_PREFIX,
} from "./lib/section-naming.ts";

interface SectionMutation {
  name: string;
  before: string;
  after: string;
  count: number;
}

interface SingularizeResult {
  changed: boolean;
  sections: SectionMutation[];
}

/**
 * Regex pra match do header de seção secundária. Aceita:
 *   - `**LANÇAMENTOS**`
 *   - `**🚀 LANÇAMENTOS**` (emoji prefix existente)
 *   - `**LANÇAMENTO**` (já singular)
 *   - `**🚀 LANÇAMENTO**`
 *
 * #1691: inclui RADAR (#1569), USE MELHOR (#1568) e VÍDEOS (#1674) — antes
 * faltavam, então um `**📺 VÍDEOS**` com 1 item nunca singularizava pra VÍDEO.
 * `V[ÍI]DEOS?` espelha o render-newsletter-html (compat sem acento).
 *
 * Capture group 1 = full header text (entre os `**`), inclui emoji se
 * presente.
 */
// #1737: pattern de nomes + emoji prefix vêm de section-naming.ts (fonte única).
// `bold:"required"` + `capture:"with-emoji"` preservam a forma de antes (`**...**`
// obrigatório, grupo 1 = emoji+nome pra displaySectionName). ALL_SECTION_NAMES_PATTERN
// é superset do anterior (cobre `OUTRA NOTÍCIA` via `OUTRAS?\s+NOT[ÍI]CIAS?`).
const SECTION_HEADER_REGEX = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, {
  bold: "required",
  capture: "with-emoji",
  flags: "u",
});

// Boundary genérico "próximo header em UPPERCASE" (não só seções conhecidas) —
// usa o emoji prefix canônico (#1737), nome em maiúsculas acentuadas.
const NEXT_UPPERCASE_HEADER_RE = new RegExp(
  String.raw`^\*\*${SECTION_EMOJI_PREFIX}[A-ZÀ-Ú][A-ZÀ-Ú ]*\*\*$`,
  "u",
);

/**
 * Conta itens da seção lendo linhas até o próximo header de seção (---,
 * outro `**...**` em UPPERCASE) ou fim do texto. Conta linhas que matcham
 * `**[Título](URL)**` — ou seja, primeira linha de cada item.
 */
function countItemsAfter(lines: string[], startIdx: number): number {
  let count = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    // Stop em separator ou próximo header em uppercase.
    // #1691: o char-class antigo `[A-Z🚀🔬📰 ]` (a) não tinha 📡/🛠️/📺 (boundary
    // de RADAR/USE MELHOR/VÍDEOS), e (b) nem casava nomes acentuados (Ç em
    // LANÇAMENTOS, Í em VÍDEOS) — usar emoji prefix opcional (range Unicode) +
    // uppercase acentuado cobre todos sem listar emoji a emoji.
    if (line.trim() === "---") break;
    if (NEXT_UPPERCASE_HEADER_RE.test(line.trim()) && i > startIdx) break;
    // Item começa com `**[`
    if (/^\*\*\[/.test(line.trim())) count++;
  }
  return count;
}

export function singularizeMdSections(md: string): {
  out: string;
  result: SingularizeResult;
} {
  const lines = md.split(/\r?\n/);
  const sections: SectionMutation[] = [];
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(SECTION_HEADER_REGEX);
    if (!match) continue;

    const original = match[1]; // inclui emoji prefix se presente
    const count = countItemsAfter(lines, i + 1);
    if (count === 0) continue; // seção vazia: deixa intocada

    const updated = displaySectionName(original, count);
    // stripEmojiPrefix(original) e stripEmojiPrefix(updated) — comparação
    // sem ambiguidade no espaçamento
    if (original === updated) continue;
    if (
      stripEmojiPrefix(original) === stripEmojiPrefix(updated) &&
      original.startsWith(updated.split(" ")[0])
    ) {
      // edge case: só mudou emoji mas nome continua igual — atualizar
    }

    lines[i] = line.replace(SECTION_HEADER_REGEX, `**${updated}**`);
    sections.push({ name: stripEmojiPrefix(original), before: original, after: updated, count });
    changed = true;
  }

  return {
    out: lines.join("\n"),
    result: { changed, sections },
  };
}

interface CliArgs {
  md: string;
}

function parseArgs(argv: string[]): CliArgs | null {
  let md = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--md" && argv[i + 1]) { md = argv[++i]; }
  }
  if (!md) return null;
  return { md };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Uso: singularize-md-sections.ts --md <path>");
    process.exit(1);
  }
  const md = readFileSync(args.md, "utf8");
  const { out, result } = singularizeMdSections(md);
  if (result.changed) {
    writeFileSync(args.md, out, "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
