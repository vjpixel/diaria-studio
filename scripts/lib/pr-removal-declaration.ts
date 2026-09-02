/**
 * scripts/lib/pr-removal-declaration.ts (#7115)
 *
 * "Com a fatia 1 [#7113] medindo a razão adição:remoção, falta a resposta.
 * Hoje um PR pode adicionar 3.000 linhas sem que nada no fluxo pergunte o
 * que sai em troca." Este módulo implementa a regra: PR cujo diff
 * ultrapassa um limiar de ADIÇÕES precisa declarar, no corpo, o que remove
 * — ou por que legitimamente não remove nada.
 *
 * Mesmo padrão já usado pelo marcador `no-regression-test: <razão>` (#3327
 * Rec 7, `context/overnight-dispatch-rules.md` item 6): um marcador textual
 * simples no PR body, checável por regex, sem exigir nenhuma UI/label nova.
 * `feature nova é resposta válida; "não pensei nisso" não é` — o guard não
 * julga a QUALIDADE da declaração (isso é humano/review), só a PRESENÇA.
 */
import { diffRatio, type DiffLineStats } from "./diff-line-stats.ts";

/**
 * Limiar de LINHAS ADICIONADAS acima do qual o PR precisa declarar
 * remoção. Mesma ordem de grandeza de `EFFORT_DIFF_LINE_THRESHOLD` (500,
 * `.claude/hooks/pr-create-review.mjs`) — não importado de lá de propósito
 * (aquele mede diff TOTAL pra decidir effort de review, medida diferente
 * de "só adições" — acoplar os dois faria uma recalibração de review effort
 * mudar silenciosamente este gate). Constante isolada e nomeada pra
 * facilitar recalibração independente, mesmo espírito de
 * `ROUND_DIFF_RATIO_ALARM_THRESHOLD` (#7113) — decisão provisória do
 * editor, reversível numa linha.
 */
export const REMOVAL_DECLARATION_ADDED_LINES_THRESHOLD = 500;

const MARKER_RE = /removal-declaration:\s*([^\n]{10,})/i;

/** Pura — `true` se o body contém o marcador `removal-declaration:` com
 * pelo menos 10 chars de conteúdo depois (mesmo piso de
 * `justificationInBody` em `check-pr-bugfix.ts` pra `no-regression-test:`). */
export function hasRemovalDeclaration(body: string): boolean {
  return MARKER_RE.test(body);
}

/** Pura — o PR precisa declarar remoção quando `added` ultrapassa o
 * limiar. Só `added` importa (não `net`/`ratio`) — um PR que adiciona muito
 * E remove muito ainda merece a pergunta "o resto do que adicionou tinha
 * como vir com menos". */
export function needsRemovalDeclaration(
  added: number,
  threshold: number = REMOVAL_DECLARATION_ADDED_LINES_THRESHOLD,
): boolean {
  return added > threshold;
}

export type RemovalDeclarationStatus = "not-required" | "ok" | "missing";

export interface RemovalDeclarationEvaluation {
  status: RemovalDeclarationStatus;
  addedLines: number;
  removedLines: number;
  ratio: number | null;
  threshold: number;
}

/** Pura — decide o veredito completo a partir de stats de diff já
 * calculados + o body do PR. */
export function evaluateRemovalDeclaration(
  stats: DiffLineStats,
  body: string,
  threshold: number = REMOVAL_DECLARATION_ADDED_LINES_THRESHOLD,
): RemovalDeclarationEvaluation {
  const base = {
    addedLines: stats.added,
    removedLines: stats.removed,
    ratio: diffRatio(stats.added, stats.removed),
    threshold,
  };
  if (!needsRemovalDeclaration(stats.added, threshold)) {
    return { ...base, status: "not-required" };
  }
  return { ...base, status: hasRemovalDeclaration(body) ? "ok" : "missing" };
}

/** Mensagem acionável usada pelo guard quando `status === "missing"`. */
export function missingRemovalDeclarationMessage(evaluation: RemovalDeclarationEvaluation): string {
  return (
    `[#7115] PR adiciona ${evaluation.addedLines} linhas (limiar: ${evaluation.threshold}) sem declarar o que ` +
    `remove. Adicione ao corpo do PR:\n` +
    `  removal-declaration: <o que este PR remove> — ou por que legitimamente não remove nada\n` +
    `("feature nova" é resposta válida; "não pensei nisso" não é.)`
  );
}
