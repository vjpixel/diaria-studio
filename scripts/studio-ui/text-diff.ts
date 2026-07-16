/**
 * text-diff.ts (#3559)
 *
 * Diff de linhas PURO (sem dependência nova — princípio de custo-zero do
 * CLAUDE.md) usado pelo painel de revisão de conteúdo pra mostrar "o que o
 * editor mudou vs. a versão gerada pelo agente" (#3554 fatia 5, aceite
 * "Diff agente↔editor visível").
 *
 * Algoritmo: LCS (longest common subsequence) linha-a-linha, O(n*m) — os 3
 * arquivos gate-facing (`01-categorized.md`, `02-reviewed.md`, `03-social.md`)
 * são newsletters de algumas centenas de linhas no máximo, então o custo
 * quadrático é irrelevante na prática (não justifica trazer uma lib de diff
 * como `diff`/`fast-diff` pra uma necessidade tão pequena).
 */

export type DiffLineType = "equal" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** Número da linha no lado ORIGINAL (baseline) — `null` para linhas `add`. */
  baselineLine: number | null;
  /** Número da linha no lado ATUAL (current) — `null` para linhas `del`. */
  currentLine: number | null;
}

/**
 * Divide em linhas preservando o array vazio pra string vazia (evita off-by-one
 * de `"".split("\n")` retornar `[""]` — tratamos ausência de conteúdo como 0
 * linhas de diff, não 1 linha vazia espúria).
 */
function toLines(text: string): string[] {
  if (text === "") return [];
  return text.split(/\r\n|\r|\n/);
}

/**
 * Computa o diff linha-a-linha entre `baseline` (versão gerada pelo agente,
 * capturada na 1ª leitura do painel — ver `studio-review.ts:ensureBaseline`)
 * e `current` (conteúdo no disco/editor agora). Retorna o array completo de
 * linhas classificadas (`equal`/`add`/`del`) — `diffIsEmpty` abaixo resume
 * "sem diferenças" pro caller (UI) sem precisar inspecionar o array.
 */
export function diffLines(baseline: string, current: string): DiffLine[] {
  const a = toLines(baseline);
  const b = toLines(current);
  const n = a.length;
  const m = b.length;

  // Tabela LCS clássica: lcs[i][j] = tamanho da LCS de a[i..] e b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "equal", text: a[i], baselineLine: i + 1, currentLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: "del", text: a[i], baselineLine: i + 1, currentLine: null });
      i++;
    } else {
      result.push({ type: "add", text: b[j], baselineLine: null, currentLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "del", text: a[i], baselineLine: i + 1, currentLine: null });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", text: b[j], baselineLine: null, currentLine: j + 1 });
    j++;
  }
  return result;
}

/** `true` quando o diff não tem nenhuma linha `add`/`del` (conteúdo idêntico). */
export function diffIsEmpty(lines: DiffLine[]): boolean {
  return lines.every((l) => l.type === "equal");
}
