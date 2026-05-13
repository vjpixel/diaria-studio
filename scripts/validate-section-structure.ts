#!/usr/bin/env tsx
/**
 * validate-section-structure.ts (#1205)
 *
 * Compara a estrutura de seções de 2 versões de um MD pra garantir que um
 * passo de "edição cirúrgica" (ex: title-picker) preservou ordem + presença
 * de todas as seções fixas.
 *
 * Caso 260517 (real): title-picker removeu o separador `---` entre
 * OUTRAS NOTÍCIAS e SORTEIO + moveu ERRO INTENCIONAL pro final do arquivo
 * (depois de PARA ENCERRAR). Pixel só pegou porque eu rodei lints depois
 * e o intro-count falhou — sem o lint, teria publicado quebrado.
 *
 * Estratégia: extrair "structural fingerprint" de cada MD — sequência de
 * (heading | section-delim | ---) — e comparar. Diff = abort.
 *
 * Uso:
 *   npx tsx scripts/validate-section-structure.ts \
 *     --before <path/to/before.md> --after <path/to/after.md>
 *
 * Exit codes:
 *   0 → estrutura preservada (ok)
 *   1 → estrutura mudou (diff abaixo)
 *   2 → erro de uso / arquivo ausente
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface StructureToken {
  kind: "header" | "separator";
  label: string; // texto do header ou '---'
  line: number;
}

/**
 * Extrai a "structural fingerprint" — tokens que importam pra ordem:
 *   - separators `---` em linha própria
 *   - headers reconhecidos: `DESTAQUE N | ...`, `É IA?`, `LANÇAMENTOS`,
 *     `PESQUISAS`, `OUTRAS NOTÍCIAS`, `🎁 SORTEIO`, `🙋🏼‍♀️ PARA ENCERRAR`,
 *     `ERRO INTENCIONAL`, e variantes com `**` ou frontmatter prefix.
 *
 * Headers normalizados pra string canônica (lowercase, sem **, sem emojis).
 */
const HEADER_PATTERNS: Array<{ re: RegExp; canonical: string }> = [
  { re: /^\*{0,2}DESTAQUE\s+(\d+)\s*\|/i, canonical: "destaque-$1" },
  { re: /^\*{0,2}(?:## )?É IA\?\*{0,2}\s*$/i, canonical: "é-ia" },
  { re: /^\*{0,2}LAN[ÇC]AMENTOS\*{0,2}\s*$/i, canonical: "lancamentos" },
  { re: /^\*{0,2}PESQUISAS\*{0,2}\s*$/i, canonical: "pesquisas" },
  { re: /^\*{0,2}OUTRAS\s+NOT[ÍI]CIAS\*{0,2}\s*$/i, canonical: "outras-noticias" },
  { re: /^\*{0,2}🎁?\s*SORTEIO\*{0,2}\s*$/i, canonical: "sorteio" },
  { re: /^\*{0,2}🙋🏼‍♀️?\s*PARA\s+ENCERRAR\*{0,2}\s*$/i, canonical: "para-encerrar" },
  { re: /^\*{0,2}ERRO\s+INTENCIONAL\*{0,2}\s*$/i, canonical: "erro-intencional" },
];

export function extractStructure(md: string): StructureToken[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const tokens: StructureToken[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---") {
      tokens.push({ kind: "separator", label: "---", line: i + 1 });
      continue;
    }
    for (const pat of HEADER_PATTERNS) {
      const m = t.match(pat.re);
      if (m) {
        // Substituir $1, $2 no canonical com captures
        let label = pat.canonical;
        for (let g = 1; g < m.length; g++) {
          label = label.replace(`$${g}`, m[g]);
        }
        tokens.push({ kind: "header", label, line: i + 1 });
        break;
      }
    }
  }
  return tokens;
}

export interface StructureDiff {
  ok: boolean;
  before_count: number;
  after_count: number;
  changes: Array<{
    type: "removed" | "added" | "reordered";
    detail: string;
  }>;
}

export function diffStructure(before: StructureToken[], after: StructureToken[]): StructureDiff {
  const beforeSeq = before.map((t) => t.label).join(" / ");
  const afterSeq = after.map((t) => t.label).join(" / ");
  const changes: StructureDiff["changes"] = [];

  if (beforeSeq === afterSeq) {
    return {
      ok: true,
      before_count: before.length,
      after_count: after.length,
      changes: [],
    };
  }

  // Diff básico: contagem de cada label
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  for (const t of before) beforeCounts.set(t.label, (beforeCounts.get(t.label) ?? 0) + 1);
  for (const t of after) afterCounts.set(t.label, (afterCounts.get(t.label) ?? 0) + 1);

  // Labels removidos (em before mas não em after, ou em quantidade menor)
  for (const [label, bc] of beforeCounts) {
    const ac = afterCounts.get(label) ?? 0;
    if (ac < bc) {
      changes.push({
        type: "removed",
        detail: `${label}: ${bc} → ${ac} (${bc - ac} removido${bc - ac > 1 ? "s" : ""})`,
      });
    }
  }
  // Labels adicionados
  for (const [label, ac] of afterCounts) {
    const bc = beforeCounts.get(label) ?? 0;
    if (ac > bc) {
      changes.push({
        type: "added",
        detail: `${label}: ${bc} → ${ac} (${ac - bc} adicionado${ac - bc > 1 ? "s" : ""})`,
      });
    }
  }

  // Se contagens batem mas sequência difere = reorder
  if (changes.length === 0) {
    changes.push({
      type: "reordered",
      detail: `seções com mesmas contagens mas ordem diferente.\n  antes: ${beforeSeq}\n  depois: ${afterSeq}`,
    });
  }

  return {
    ok: false,
    before_count: before.length,
    after_count: after.length,
    changes,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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
  if (!args.before || !args.after) {
    console.error("Uso: validate-section-structure.ts --before <path.md> --after <path.md>");
    process.exit(2);
  }
  const beforePath = resolve(args.before);
  const afterPath = resolve(args.after);
  if (!existsSync(beforePath)) {
    console.error(`Arquivo não existe: ${beforePath}`);
    process.exit(2);
  }
  if (!existsSync(afterPath)) {
    console.error(`Arquivo não existe: ${afterPath}`);
    process.exit(2);
  }
  const beforeMd = readFileSync(beforePath, "utf8");
  const afterMd = readFileSync(afterPath, "utf8");
  const before = extractStructure(beforeMd);
  const after = extractStructure(afterMd);
  const diff = diffStructure(before, after);

  console.log(JSON.stringify(diff, null, 2));

  if (!diff.ok) {
    console.error(`\n❌ Estrutura de seções mudou (#1205):`);
    for (const c of diff.changes) {
      console.error(`  [${c.type}] ${c.detail}`);
    }
    console.error(`\n  Antes: ${before.length} tokens`);
    console.error(`  Depois: ${after.length} tokens`);
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (/\/scripts\/validate-section-structure\.ts$/.test(_argv1)) {
  main();
}
