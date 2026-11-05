/**
 * clarice-pending.ts (#12257) — revisão da Clarice pendente na edição.
 *
 * Quando a API da Clarice fica fora do ar por minutos, `clarice-correct.ts`
 * estoura o teto total (`--deadline-ms`) e sai com exit 6 `clarice_unavailable`.
 * Antes do #12257 o Stage 2 terminava sem `02-reviewed.md` nem sentinela, e
 * o único jeito de seguir era reexecutar o stage inteiro (edição 261105:
 * ~15 min e um 2º spawn).
 *
 * Com este módulo o Stage 2 segue sem a Clarice e deixa a revisão como passo
 * retomável:
 *
 * - `skipClarice` grava `02-reviewed.md` a partir do snapshot pré-Clarice
 *   (o texto já humanizado), `[]` em `_internal/02-clarice-suggestions.json`
 *   (aceito por `checkClariceRan`) e o marcador `_internal/02-clarice-pending.json`.
 * - O marcador é o aviso durável: o invariante `clarice-pending` do Stage 4 o
 *   lê e mostra "clarice não rodou" no gate, com o comando de retomada.
 * - `resumeClarice` roda a Clarice sobre o `02-reviewed.md` atual (que pode já
 *   ter edições do gate) e, em sucesso, grava o corrigido e apaga o marcador.
 *
 * Rodar a Clarice depois sobre o `02-reviewed.md` não aplica nada em dobro:
 * enquanto o marcador existe, a Clarice nunca rodou sobre aquele texto.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLARICE_PENDING_REL = join("_internal", "02-clarice-pending.json");
export const PRE_CLARICE_REL = join("_internal", "02-pre-clarice.md");
export const CLARICE_SUGGESTIONS_REL = join("_internal", "02-clarice-suggestions.json");
export const CLARICE_CORRECTED_REL = join("_internal", "02-clarice-corrected.md");
export const REVIEWED_REL = "02-reviewed.md";

export interface ClaricePendingMarker {
  /** Motivo do skip (ex.: `clarice_unavailable`, `rest_exit3`). */
  reason: string;
  /** ISO 8601 do momento do skip. */
  skipped_at: string;
  /** Texto de onde saiu o `02-reviewed.md` (sempre o snapshot pré-Clarice). */
  source: string;
  /** Comando que retoma a revisão da Clarice. */
  resume_command: string;
}

export function claricePendingPath(editionDir: string): string {
  return join(editionDir, CLARICE_PENDING_REL);
}

export function resumeCommandFor(editionDir: string): string {
  return `npx tsx scripts/clarice-pending.ts resume --edition-dir ${editionDir}`;
}

/** Lê o marcador; `null` quando ausente ou ilegível (ilegível conta como ausente só aqui — o invariante acusa à parte). */
export function readClaricePending(editionDir: string): ClaricePendingMarker | null {
  const p = claricePendingPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ClaricePendingMarker;
  } catch {
    return null;
  }
}

/**
 * Segue o Stage 2 sem a Clarice: `02-reviewed.md` = snapshot pré-Clarice,
 * sugestões `[]`, marcador gravado. Lança se o snapshot pré-Clarice não
 * existir (sem ele não há texto humanizado conhecido para publicar nem base
 * para o diff/estabilidade de URL do Stage 2).
 */
export function skipClarice(
  editionDir: string,
  reason: string,
  now: () => Date = () => new Date(),
): ClaricePendingMarker {
  const pre = join(editionDir, PRE_CLARICE_REL);
  if (!existsSync(pre)) {
    throw new Error(
      `snapshot pré-Clarice ausente (${pre}) — sem ele não há texto humanizado para gravar em ${REVIEWED_REL}`,
    );
  }
  copyFileSync(pre, join(editionDir, REVIEWED_REL));
  writeFileSync(join(editionDir, CLARICE_SUGGESTIONS_REL), "[]\n", "utf8");
  const marker: ClaricePendingMarker = {
    reason,
    skipped_at: now().toISOString(),
    source: PRE_CLARICE_REL,
    resume_command: resumeCommandFor(editionDir),
  };
  writeFileSync(claricePendingPath(editionDir), JSON.stringify(marker, null, 2) + "\n", "utf8");
  return marker;
}

/** Roda `clarice-correct.ts` com os argumentos dados e devolve o exit code. */
export type ClariceRunner = (args: string[]) => number;

export type ResumeOutcome =
  | { status: "nothing-pending" }
  | { status: "resumed" }
  | { status: "failed"; exitCode: number };

/**
 * Retoma a revisão: Clarice sobre o `02-reviewed.md` atual. Exit 0 do runner
 * → copia `02-clarice-corrected.md` para `02-reviewed.md` e apaga o marcador.
 * Qualquer outro exit → nada muda no `02-reviewed.md` e o marcador fica.
 */
export function resumeClarice(
  editionDir: string,
  runner: ClariceRunner,
  edition?: string,
): ResumeOutcome {
  if (!existsSync(claricePendingPath(editionDir))) return { status: "nothing-pending" };
  const corrected = join(editionDir, CLARICE_CORRECTED_REL);
  const args = [
    "--in", join(editionDir, REVIEWED_REL),
    "--out", join(editionDir, CLARICE_SUGGESTIONS_REL),
    "--corrected-out", corrected,
    "--retry",
    ...(edition ? ["--edition", edition] : []),
  ];
  const exitCode = runner(args);
  if (exitCode !== 0) return { status: "failed", exitCode };
  copyFileSync(corrected, join(editionDir, REVIEWED_REL));
  rmSync(claricePendingPath(editionDir), { force: true });
  return { status: "resumed" };
}
