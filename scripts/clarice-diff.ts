/**
 * clarice-diff.ts
 *
 * Gera um diff legível (para o editor humano) entre o rascunho original
 * e o texto revisado pela Clarice.
 *
 * Estratégia: comparação em nível de parágrafo (split por \n\n).
 * Parágrafos idênticos são omitidos; os alterados aparecem como Antes/Depois.
 *
 * Uso:
 *   npx tsx scripts/clarice-diff.ts <original.md> <reviewed.md> <diff.md>
 *
 * Saída: arquivo markdown com as alterações e um resumo de contagem.
 */

import { readFileSync, writeFileSync } from "node:fs";

export function splitParagraphs(text: string): string[] {
  return text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
}

/**
 * Levenshtein distance (character-level) — usada para confirmar que parágrafos
 * com estrutura muito similar pertencem ao mesmo "slot" mesmo se o diff por
 * índice divergir levemente.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[n];
}

export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // For long paragraphs, use a char-sample heuristic to avoid O(n²) on huge texts
  if (maxLen > 2000) {
    const sample = 400;
    const aS = a.slice(0, sample) + a.slice(-sample);
    const bS = b.slice(0, sample) + b.slice(-sample);
    return 1 - levenshtein(aS, bS) / (aS.length * 2);
  }
  return 1 - levenshtein(a, b) / maxLen;
}

export interface DiffEntry {
  before: string;
  after: string;
  index: number;
}

export function alignParagraphs(origParas: string[], revParas: string[]): DiffEntry[] {
  const changes: DiffEntry[] = [];
  const maxLen = Math.max(origParas.length, revParas.length);

  let oi = 0, ri = 0;
  while (oi < origParas.length || ri < revParas.length) {
    const orig = origParas[oi];
    const rev = revParas[ri];

    if (orig === undefined) {
      // Paragraph added in revision
      changes.push({ before: "", after: rev, index: ri });
      ri++;
      continue;
    }
    if (rev === undefined) {
      // Paragraph removed in revision
      changes.push({ before: orig, after: "", index: oi });
      oi++;
      continue;
    }
    if (orig === rev) {
      oi++; ri++;
      continue;
    }

    // Check if this looks like an edit of the same paragraph (high similarity)
    const sim = similarity(orig, rev);
    if (sim > 0.4) {
      changes.push({ before: orig, after: rev, index: oi });
      oi++; ri++;
    } else {
      // Could be insertion/deletion — peek ahead to decide
      const nextOrigSim = oi + 1 < origParas.length ? similarity(origParas[oi + 1], rev) : 0;
      const nextRevSim = ri + 1 < revParas.length ? similarity(orig, revParas[ri + 1]) : 0;
      if (nextOrigSim > nextRevSim && nextOrigSim > 0.6) {
        // orig[oi] was deleted
        changes.push({ before: orig, after: "", index: oi });
        oi++;
      } else if (nextRevSim > 0.6) {
        // rev[ri] was inserted
        changes.push({ before: "", after: rev, index: ri });
        ri++;
      } else {
        // Treat as edit
        changes.push({ before: orig, after: rev, index: oi });
        oi++; ri++;
      }
    }
  }

  return changes;
}

function formatDiff(changes: DiffEntry[], origPath: string, reviewedPath: string): string {
  const lines: string[] = [
    `# Revisão Clarice`,
    ``,
    `**Original:** \`${origPath}\`  `,
    `**Revisado:** \`${reviewedPath}\`  `,
    `**Alterações:** ${changes.length}`,
    ``,
    `---`,
    ``,
  ];

  changes.forEach((c, i) => {
    lines.push(`### Alteração ${i + 1}`);
    lines.push(``);

    if (c.before && c.after) {
      lines.push(`**Antes:**`);
      lines.push(`> ${c.before.replace(/\n/g, "\n> ")}`);
      lines.push(``);
      lines.push(`**Depois:**`);
      lines.push(`> ${c.after.replace(/\n/g, "\n> ")}`);
    } else if (!c.before) {
      lines.push(`**Adicionado:**`);
      lines.push(`> ${c.after.replace(/\n/g, "\n> ")}`);
    } else {
      lines.push(`**Removido:**`);
      lines.push(`> ${c.before.replace(/\n/g, "\n> ")}`);
    }

    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  });

  if (changes.length === 0) {
    lines.push(`_Nenhuma alteração encontrada — Clarice não fez mudanças._`);
  }

  return lines.join("\n");
}

function main() {
  const [origPath, reviewedPath, outPath] = process.argv.slice(2);

  if (!origPath || !reviewedPath || !outPath) {
    console.error("Uso: clarice-diff.ts <original.md> <reviewed.md> <diff.md>");
    process.exit(1);
  }

  const orig = readFileSync(origPath, "utf8");
  const reviewed = readFileSync(reviewedPath, "utf8");

  if (orig === reviewed) {
    const noChanges = formatDiff([], origPath, reviewedPath);
    writeFileSync(outPath, noChanges, "utf8");
    console.error(`clarice-diff: sem alterações → ${outPath}`);
    return;
  }

  const origParas = splitParagraphs(orig);
  const revParas = splitParagraphs(reviewed);
  const changes = alignParagraphs(origParas, revParas);

  const diffMd = formatDiff(changes, origPath, reviewedPath);
  writeFileSync(outPath, diffMd, "utf8");
  console.error(`clarice-diff: ${changes.length} alteração(ões) → ${outPath}`);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
