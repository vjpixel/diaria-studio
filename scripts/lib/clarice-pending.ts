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
 *   O `[]` sozinho não distingue "rodou sem sugestões" de "não rodou": quem
 *   precisa da distinção lê o marcador (é o que o invariante do Stage 4 faz).
 * - O marcador é o aviso durável: o invariante `clarice-pending` do Stage 4 o
 *   lê e mostra "clarice não rodou" no gate, com o comando de retomada.
 * - `resumeClarice` roda a Clarice sobre o `02-reviewed.md` atual (que pode já
 *   ter edições do gate) e, em sucesso, grava o corrigido e apaga o marcador.
 *
 * Rodar a Clarice depois sobre o `02-reviewed.md` não aplica nada em dobro:
 * enquanto o marcador existe, a Clarice nunca rodou sobre aquele texto.
 *
 * Diferenças do resume em relação ao fluxo normal do Stage 2, tratadas aqui
 * (review da PR #12291):
 * - O `02-reviewed.md` já passou pelo `render-erro-intencional` e pode ter o
 *   erro intencional plantado. A Clarice tende a corrigi-lo, o que mata o
 *   concurso. Se o `wrong_value` declarado em `_internal/intentional-error.json`
 *   some do texto corrigido, o resume NÃO aplica (`intentional-error-corrected`),
 *   a menos que o chamador aceite explicitamente.
 * - O editor pode salvar o `02-reviewed.md` pelo Studio enquanto a Clarice
 *   roda. O resume confere o hash antes de copiar e não sobrescreve
 *   (`reviewed-changed`).
 * - Os guards pós-Clarice do Stage 2 (travessão, É IA?, estabilidade de URL,
 *   cupons, diff) precisam rodar de novo contra o texto pré-resume, guardado em
 *   `_internal/02-pre-clarice-resume.md`. A lista sai de `postResumeSteps`.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isIntentionalErrorPlaceholder } from "./intentional-errors.ts";

export const CLARICE_PENDING_REL = join("_internal", "02-clarice-pending.json");
export const PRE_CLARICE_REL = join("_internal", "02-pre-clarice.md");
export const PRE_RESUME_REL = join("_internal", "02-pre-clarice-resume.md");
export const CLARICE_SUGGESTIONS_REL = join("_internal", "02-clarice-suggestions.json");
export const CLARICE_CORRECTED_REL = join("_internal", "02-clarice-corrected.md");
export const INTENTIONAL_ERROR_REL = join("_internal", "intentional-error.json");
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

function isMarker(v: unknown): v is ClaricePendingMarker {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.reason === "string" &&
    typeof m.skipped_at === "string" &&
    typeof m.source === "string" &&
    typeof m.resume_command === "string"
  );
}

/**
 * Lê o marcador. `null` quando ausente, ilegível ou sem os campos esperados.
 * Para saber se há revisão pendente, usar `isClaricePending` (existência do
 * arquivo): um marcador malformado continua sendo pendência.
 */
export function readClaricePending(editionDir: string): ClaricePendingMarker | null {
  const p = claricePendingPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    return isMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Há revisão da Clarice pendente? (o arquivo existe, legível ou não) */
export function isClaricePending(editionDir: string): boolean {
  return existsSync(claricePendingPath(editionDir));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Segue o Stage 2 sem a Clarice: `02-reviewed.md` = snapshot pré-Clarice,
 * sugestões `[]`, marcador gravado. Lança se o snapshot pré-Clarice não
 * existir (sem ele não há texto humanizado conhecido para publicar nem base
 * para o diff/estabilidade de URL do Stage 2).
 *
 * Recusa (lança) quando `02-reviewed.md` já existe, difere do snapshot e é
 * mais novo que ele: é o caso de alguém rodar `skip` de novo depois de editar
 * o reviewed no gate, e a cópia apagaria a edição. No fluxo do exit 6 isso não
 * acontece, porque o snapshot é gravado logo antes da Clarice e um reviewed de
 * rodada anterior é mais velho. `force` desliga a recusa.
 */
export function skipClarice(
  editionDir: string,
  reason: string,
  opts: { now?: () => Date; force?: boolean } = {},
): ClaricePendingMarker {
  const now = opts.now ?? (() => new Date());
  const pre = join(editionDir, PRE_CLARICE_REL);
  if (!existsSync(pre)) {
    throw new Error(
      `snapshot pré-Clarice ausente (${pre}) — sem ele não há texto humanizado para gravar em ${REVIEWED_REL}`,
    );
  }
  const reviewed = join(editionDir, REVIEWED_REL);
  if (
    !opts.force &&
    existsSync(reviewed) &&
    statSync(reviewed).mtimeMs > statSync(pre).mtimeMs &&
    sha256(reviewed) !== sha256(pre)
  ) {
    throw new Error(
      `${REVIEWED_REL} foi editado depois do snapshot pré-Clarice; o skip o sobrescreveria. ` +
        "Para retomar a revisão, use `resume`. Para descartar a edição, repita com --force.",
    );
  }
  copyFileSync(pre, reviewed);
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
  | { status: "resumed"; preResume: string }
  | { status: "failed"; exitCode: number }
  | { status: "reviewed-changed" }
  | { status: "intentional-error-corrected"; wrongValue: string };

/** `wrong_value` declarado (não placeholder) em `_internal/intentional-error.json`, ou `null`. */
export function readDeclaredWrongValue(editionDir: string): string | null {
  const p = join(editionDir, INTENTIONAL_ERROR_REL);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { wrong_value?: unknown };
    const w = typeof j.wrong_value === "string" ? j.wrong_value.trim() : "";
    return w && !isIntentionalErrorPlaceholder(w) ? w : null;
  } catch {
    return null;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Retoma a revisão: Clarice sobre o `02-reviewed.md` atual. Antes de chamar,
 * guarda o texto em `_internal/02-pre-clarice-resume.md` (base dos guards
 * pós-resume). Só copia `02-clarice-corrected.md` para `02-reviewed.md` e
 * apaga o marcador quando: o runner sai 0, o `02-reviewed.md` não mudou durante
 * a chamada e o erro intencional declarado continua no texto (ou
 * `acceptIntentionalErrorChange`). Em qualquer outro caso nada muda no
 * `02-reviewed.md` e o marcador fica.
 */
export function resumeClarice(
  editionDir: string,
  runner: ClariceRunner,
  opts: { edition?: string; acceptIntentionalErrorChange?: boolean } = {},
): ResumeOutcome {
  if (!isClaricePending(editionDir)) return { status: "nothing-pending" };
  const reviewed = join(editionDir, REVIEWED_REL);
  const preResume = join(editionDir, PRE_RESUME_REL);
  copyFileSync(reviewed, preResume);
  const hashBefore = sha256(reviewed);
  const corrected = join(editionDir, CLARICE_CORRECTED_REL);
  const args = [
    "--in", preResume,
    "--out", join(editionDir, CLARICE_SUGGESTIONS_REL),
    "--corrected-out", corrected,
    "--retry",
    ...(opts.edition ? ["--edition", opts.edition] : []),
  ];
  const exitCode = runner(args);
  if (exitCode !== 0) return { status: "failed", exitCode };
  if (!existsSync(reviewed) || sha256(reviewed) !== hashBefore) return { status: "reviewed-changed" };

  const wrongValue = readDeclaredWrongValue(editionDir);
  if (wrongValue && !opts.acceptIntentionalErrorChange) {
    const before = countOccurrences(readFileSync(preResume, "utf8"), wrongValue);
    const after = countOccurrences(readFileSync(corrected, "utf8"), wrongValue);
    if (before > 0 && after < before) return { status: "intentional-error-corrected", wrongValue };
  }

  copyFileSync(corrected, reviewed);
  rmSync(claricePendingPath(editionDir), { force: true });
  return { status: "resumed", preResume: PRE_RESUME_REL };
}

/**
 * Passos que o Stage 2 roda depois de qualquer passada da Clarice
 * (`.claude/agents/orchestrator-stage-2.md` §2b, pós-Clarice), na mesma ordem,
 * com o texto pré-resume como base. Os dois primeiros consertam sozinhos; os
 * dois `verify-*` só reportam (exit 1 = levar ao gate, nunca auto-restaurar);
 * o último regera o diff que o gate mostra.
 */
export function postResumeSteps(editionDir: string): Array<{ name: string; args: string[]; reportOnly: boolean }> {
  const pre = join(editionDir, PRE_RESUME_REL);
  const reviewed = join(editionDir, REVIEWED_REL);
  return [
    { name: "strip-emdashes-reviewed", args: ["scripts/strip-emdashes-reviewed.ts", "--edition-dir", editionDir], reportOnly: false },
    { name: "sync-eia-block", args: ["scripts/sync-eia-block.ts", "--edition-dir", editionDir], reportOnly: false },
    { name: "verify-clarice-url-stability", args: ["scripts/verify-clarice-url-stability.ts", "--pre", pre, "--post", reviewed], reportOnly: true },
    { name: "verify-clarice-coupons", args: ["scripts/verify-clarice-coupons.ts", "--pre", pre, "--post", reviewed], reportOnly: true },
    {
      name: "clarice-diff",
      args: ["scripts/clarice-diff.ts", pre, reviewed, join(editionDir, "_internal", "02-clarice-diff.md")],
      reportOnly: false,
    },
  ];
}
