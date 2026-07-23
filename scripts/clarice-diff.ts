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
 *   npx tsx scripts/clarice-diff.ts <original.md> <reviewed.md> <diff.md> [pre-humanizer.md]
 *
 * `[pre-humanizer.md]` é opcional (#3929) — quando fornecido (o texto ANTES do
 * Humanizador, ex: `02-normalized.md` / `03-social-pre-humanizador.md`), cada
 * alteração é checada contra esse baseline para detectar REVERSÕES: a Clarice
 * (`original` aqui já é pós-Humanizador) tem precedência sobre o Humanizador
 * por decisão editorial (#3929) — quando a correção da Clarice move o texto de
 * volta pra perto da versão pré-Humanizador, isso é sinalizado explicitamente
 * no diff (`⚠️ REVERTE HUMANIZADOR`) pra o editor decidir com contexto, em vez
 * de ficar indistinguível de uma correção gramatical comum.
 *
 * Saída: arquivo markdown com as alterações e um resumo de contagem.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isMainModule } from "./lib/cli-args.ts";

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
  /**
   * #3929: true quando `after` (correção da Clarice) reverte uma edição do
   * Humanizador de volta pra (perto de) o texto pré-Humanizador. Calculado só
   * quando um texto pré-Humanizador é fornecido — ver `annotateReversions`.
   * Ausente (undefined) quando não computado (comportamento pré-#3929).
   */
  reversion?: boolean;
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

/**
 * #3929: marca quais `changes` (edits — before E after não-vazios) são
 * reversões de edições do Humanizador pela Clarice — quando `after` (o texto
 * que a Clarice produziu) fica MAIS parecido com o parágrafo PRÉ-Humanizador
 * do que `before` (o texto que o Humanizador tinha produzido, e que a Clarice
 * recebeu como input) estava. Isso indica que a Clarice desfez, total ou
 * parcialmente, uma mudança estilística do Humanizador.
 *
 * `preHumanizerParas` deve estar alinhado por ÍNDICE com o array de parágrafos
 * "antes" usado para gerar `changes` (`c.index`) — ambos originam do mesmo
 * ponto do pipeline (texto pré-Humanizador vs pós-Humanizador/pré-Clarice),
 * então a contagem de parágrafos tende a ser estável (Humanizador tipicamente
 * não adiciona/remove parágrafos, só reescreve). Quando o índice não existe no
 * array pré-Humanizador (estrutura divergiu), a entry fica sem marcação —
 * best-effort, não trava o diff.
 *
 * Margem de 0.05 na comparação de similaridade evita ruído: só marca reversão
 * quando o texto da Clarice se aproxima SENSIVELMENTE mais do pré-Humanizador
 * do que o texto do Humanizador já estava — uma correção pontual que por acaso
 * também aparece no pré-Humanizador (ex: mesma pontuação comum) não deve gerar
 * falso positivo.
 */
export function annotateReversions(
  changes: DiffEntry[],
  preHumanizerParas: string[],
): DiffEntry[] {
  return changes.map((c) => {
    if (!c.before || !c.after) return c; // add/remove puro — não há "reversão" de estilo
    const pre = preHumanizerParas[c.index];
    if (pre === undefined) return c;
    if (c.before === pre) return c; // Humanizador não tocou este parágrafo — nada a reverter
    const simBeforeToPre = similarity(c.before, pre);
    const simAfterToPre = similarity(c.after, pre);
    if (simAfterToPre > simBeforeToPre + 0.05) {
      return { ...c, reversion: true };
    }
    return c;
  });
}

function formatDiff(changes: DiffEntry[], origPath: string, reviewedPath: string): string {
  const reversionCount = changes.filter((c) => c.reversion).length;
  const lines: string[] = [
    `# Revisão Clarice`,
    ``,
    `**Original:** \`${origPath}\`  `,
    `**Revisado:** \`${reviewedPath}\`  `,
    `**Alterações:** ${changes.length}`,
    ...(reversionCount > 0
      ? [`**Reversões do Humanizador:** ${reversionCount} ⚠️ (#3929 — Clarice desfez uma edição de estilo do Humanizador; confira antes de aprovar)`]
      : []),
    ``,
    `---`,
    ``,
  ];

  changes.forEach((c, i) => {
    lines.push(`### Alteração ${i + 1}${c.reversion ? " ⚠️ REVERTE HUMANIZADOR" : ""}`);
    lines.push(``);
    if (c.reversion) {
      lines.push(
        `> ⚠️ Esta correção da Clarice reverte (total ou parcialmente) uma edição do Humanizador — o texto volta a ficar parecido com a versão pré-Humanizador (#3929).`,
      );
      lines.push(``);
    }

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
  const [origPath, reviewedPath, outPath, preHumanizerPath] = process.argv.slice(2);

  if (!origPath || !reviewedPath || !outPath) {
    console.error("Uso: clarice-diff.ts <original.md> <reviewed.md> <diff.md> [pre-humanizer.md]");
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
  let changes = alignParagraphs(origParas, revParas);

  // #3929: com o pré-Humanizador disponível, marcar quais alterações da
  // Clarice revertem uma edição do Humanizador — visibilidade explícita pro
  // editor no gate (em vez de indistinguível de uma correção gramatical comum).
  if (preHumanizerPath && existsSync(preHumanizerPath)) {
    const preHumanizerParas = splitParagraphs(readFileSync(preHumanizerPath, "utf8"));
    changes = annotateReversions(changes, preHumanizerParas);
  }

  const diffMd = formatDiff(changes, origPath, reviewedPath);
  writeFileSync(outPath, diffMd, "utf8");
  const reversionCount = changes.filter((c) => c.reversion).length;
  console.error(
    `clarice-diff: ${changes.length} alteração(ões)${reversionCount > 0 ? ` (${reversionCount} reversão(ões) do Humanizador)` : ""} → ${outPath}`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
