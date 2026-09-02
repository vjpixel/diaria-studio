/**
 * scripts/lib/diff-line-stats.ts (#7112, fatia comum de #7113/#7115)
 *
 * Helper PURO compartilhado: parseia `git diff --numstat` e deriva a razão
 * adição:remoção de um diff. Extraído porque #7113 (medir a razão por
 * rodada autônoma) e #7115 (exigir que PR grande declare o que remove) as
 * duas precisam da MESMA aritmética — em vez de cada issue duplicar o
 * parser/cálculo, este módulo é a fonte única.
 *
 * `getDiffLineStats` é a única função com I/O (spawna `git`); todo o resto
 * é puro (string/número → string/número), testável com fixture sintética
 * sem precisar de um repo git real — exatamente o requisito de teste de
 * #7113 ("dado sintético; sem bater em git real").
 */
import { spawnSync } from "node:child_process";

export interface DiffLineStats {
  /** Arquivos tocados (inclui binários, que não contam pra added/removed). */
  files: number;
  added: number;
  removed: number;
}

/**
 * Parseia a saída de `git diff --numstat` (formato `{added}\t{removed}\t{path}`
 * por linha; arquivo binário vem como `-\t-\t{path}`, tratado como 0/0 mas
 * ainda soma em `files`). Linhas vazias são ignoradas.
 */
export function parseNumstat(output: string): DiffLineStats {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addedStr, removedStr] = parts;
    files += 1;
    if (addedStr !== "-") added += Number.parseInt(addedStr, 10) || 0;
    if (removedStr !== "-") removed += Number.parseInt(removedStr, 10) || 0;
  }
  return { files, added, removed };
}

/**
 * Razão adição:remoção (`added / removed`). `null` quando `removed === 0`
 * (razão indefinida — "sem remoções", nunca `Infinity` silencioso que
 * quebra formatação/comparação a jusante).
 */
export function diffRatio(added: number, removed: number): number | null {
  if (removed <= 0) return null;
  return added / removed;
}

/** Líquido de linhas (`added - removed`) — pode ser negativo (PR que remove mais do que adiciona). */
export function diffNet(added: number, removed: number): number {
  return added - removed;
}

/**
 * Formata a razão pra exibição humana (relatório/issue). `null` com
 * `added > 0` vira `"sem remoções"` (não "Infinity:1"); `null` com
 * `added === 0` vira `"0:0"` (diff vazio).
 */
export function formatRatio(ratio: number | null, added: number): string {
  if (ratio === null) return added > 0 ? "sem remoções" : "0:0";
  return `${ratio.toFixed(1)}:1`;
}

/**
 * I/O: roda `git diff --numstat {baseRef}..{headRef}` e parseia o
 * resultado. Lança se o `git` falhar (refs inexistentes, não é um repo)
 * — o caller decide como degradar (ver `measure-round-diff-stats.ts` e
 * `check-pr-removal-declaration.ts`).
 */
export function getDiffLineStats(
  baseRef: string,
  headRef: string,
  opts: { cwd?: string; spawnFn?: typeof spawnSync } = {},
): DiffLineStats {
  const spawnFn = opts.spawnFn ?? spawnSync;
  const r = spawnFn("git", ["diff", "--numstat", `${baseRef}..${headRef}`], {
    encoding: "utf8",
    cwd: opts.cwd,
  });
  if (r.status !== 0) {
    throw new Error(`git diff --numstat ${baseRef}..${headRef} falhou: ${r.stderr || `exit ${r.status}`}`);
  }
  return parseNumstat(r.stdout ?? "");
}
