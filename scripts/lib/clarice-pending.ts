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
 * - `skipClarice` grava o marcador `_internal/02-clarice-pending.json`
 *   PRIMEIRO e só então `02-reviewed.md` a partir do snapshot pré-Clarice (o
 *   texto já humanizado) e `[]` em `_internal/02-clarice-suggestions.json`
 *   (aceito por `checkClariceRan`). Marcador primeiro porque um crash no meio
 *   deixaria texto sem Clarice e sem aviso. O `[]` sozinho não distingue
 *   "rodou sem sugestões" de "não rodou": quem precisa da distinção lê o
 *   marcador (é o que os invariantes dos Stages 4 e 5 fazem).
 * - `clearClaricePending` apaga o marcador quando a Clarice roda com sucesso
 *   num rerun do Stage 2.
 * - `resumeClarice` roda a Clarice sobre o `02-reviewed.md` atual (que pode já
 *   ter edições do gate) e, em sucesso COMPLETO, grava o corrigido e apaga o
 *   marcador.
 *
 * Rodar a Clarice depois sobre o `02-reviewed.md` não aplica nada em dobro:
 * enquanto o marcador existe, a Clarice nunca rodou sobre aquele texto.
 *
 * Diferenças do resume em relação ao fluxo normal do Stage 2, tratadas aqui
 * (reviews das PRs #12291 e #12440). Na dúvida, o marcador fica (fail-closed):
 * - Correção parcial não conta: o resume chama a Clarice sem o fallback por
 *   parágrafo e, se o resumo do filho ainda acusar fallback ou parágrafo
 *   falho (ou não vier legível), nada é aplicado e o marcador fica com
 *   `reason: "partial"`.
 * - O `02-reviewed.md` já passou pelo `render-erro-intencional` e pode ter o
 *   erro intencional plantado. A Clarice tende a corrigi-lo, o que mata o
 *   concurso. Se o `wrong_value` declarado em `_internal/intentional-error.json`
 *   some do texto corrigido, o resume NÃO aplica (`intentional-error-corrected`),
 *   a menos que o chamador aceite explicitamente.
 * - O reveal da edição anterior (`Na última edição, …`) cita de propósito o
 *   valor errado antigo. No fluxo normal ele entra depois da Clarice; aqui as
 *   linhas são restauradas verbatim no texto corrigido (`restoreRevealLines`),
 *   e o resume recusa (`reveal-changed`) se não conseguir casá-las.
 * - Se o fact-check do Stage 4 já rodou (`_internal/fact-check-autofix.json`),
 *   aplica-se a mesma proteção do #11798 (`filterClariceSuggestions` com os
 *   trechos corrigidos + verbos condicionais): havendo sugestão retida, o
 *   texto final sai das sugestões mantidas aplicadas uma a uma
 *   (`applyClariceSuggestions`), não do corrigido da Clarice.
 * - O editor pode salvar o `02-reviewed.md` pelo Studio enquanto a Clarice
 *   roda. O resume confere o hash antes de copiar e não sobrescreve
 *   (`reviewed-changed`).
 * - As sugestões vão para um arquivo temporário e só são promovidas a
 *   `_internal/02-clarice-suggestions.json` junto com o texto corrigido.
 * - Tentativa que falha marca `last_attempt_at` no marcador; outra tentativa
 *   dentro de `RESUME_COOLDOWN_MS` é pulada (`recently-attempted`) para não
 *   gastar mais 8 min a cada volta ao gate.
 * - Os guards pós-Clarice do Stage 2 (travessão, É IA?, estabilidade de URL,
 *   cupons, diff) precisam rodar de novo contra o texto pré-resume, guardado em
 *   `_internal/02-pre-clarice-resume.md`. A lista sai de `postResumeSteps`.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyClariceSuggestions, type ClariceSuggestion } from "../clarice-apply.ts";
import { filterClariceSuggestions } from "./clarice-suggestion-guard.ts";
import { readFactCheckProtection } from "./fact-check-protection.ts";
import { isIntentionalErrorPlaceholder } from "./intentional-errors.ts";

export const CLARICE_PENDING_REL = join("_internal", "02-clarice-pending.json");
export const PRE_CLARICE_REL = join("_internal", "02-pre-clarice.md");
export const PRE_RESUME_REL = join("_internal", "02-pre-clarice-resume.md");
export const CLARICE_SUGGESTIONS_REL = join("_internal", "02-clarice-suggestions.json");
export const RESUME_SUGGESTIONS_TMP_REL = join("_internal", "02-clarice-suggestions.resume.tmp.json");
export const CLARICE_CORRECTED_REL = join("_internal", "02-clarice-corrected.md");
export const INTENTIONAL_ERROR_REL = join("_internal", "intentional-error.json");
export const NORMALIZED_REL = join("_internal", "02-normalized.md");
export const REVIEWED_REL = "02-reviewed.md";

/** Janela em que uma tentativa de resume que falhou não é repetida sem `retryNow`. */
export const RESUME_COOLDOWN_MS = 20 * 60_000;

export interface ClaricePendingMarker {
  /** Motivo do skip (ex.: `clarice_unavailable`, `rest_exit3_editor_approved`, `partial`). */
  reason: string;
  /** ISO 8601 do momento do skip. */
  skipped_at: string;
  /** Texto de onde saiu o `02-reviewed.md` (sempre o snapshot pré-Clarice). */
  source: string;
  /** Edição AAMMDD, quando conhecida (vai no comando de retomada). */
  edition?: string | null;
  /** ISO 8601 da última tentativa de resume que não aplicou nada. */
  last_attempt_at?: string;
  /** Desfecho dessa tentativa (`failed:6`, `partial`, ...). */
  last_attempt_outcome?: string;
}

export function claricePendingPath(editionDir: string): string {
  return join(editionDir, CLARICE_PENDING_REL);
}

/** Comando de retomada. Derivado na leitura (nunca persistido), com `--edition` quando conhecida. */
export function resumeCommandFor(editionDir: string, edition?: string | null): string {
  return `npx tsx scripts/clarice-pending.ts resume --edition-dir ${editionDir}${edition ? ` --edition ${edition}` : ""}`;
}

function isMarker(v: unknown): v is ClaricePendingMarker {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return typeof m.reason === "string" && typeof m.skipped_at === "string" && typeof m.source === "string";
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

function writeMarker(editionDir: string, marker: ClaricePendingMarker): void {
  writeFileSync(claricePendingPath(editionDir), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

/** Apaga o marcador (a Clarice rodou com sucesso num rerun do Stage 2). Devolve se havia marcador. */
export function clearClaricePending(editionDir: string): boolean {
  const had = isClaricePending(editionDir);
  rmSync(claricePendingPath(editionDir), { force: true });
  return had;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Segue o Stage 2 sem a Clarice: marcador gravado, `02-reviewed.md` =
 * snapshot pré-Clarice, sugestões `[]`. Lança se o snapshot pré-Clarice não
 * existir (sem ele não há texto humanizado conhecido para publicar nem base
 * para o diff/estabilidade de URL do Stage 2).
 *
 * Recusa (lança) quando `02-reviewed.md` já existe, difere do snapshot e é
 * mais novo que ele: é o caso de alguém rodar `skip` de novo depois de editar
 * o reviewed no gate, e a cópia apagaria a edição. No fluxo do exit 6 isso não
 * acontece, porque o snapshot é gravado logo antes da Clarice e um reviewed de
 * rodada anterior é mais velho. `force` desliga a recusa.
 *
 * As recusas vêm antes de qualquer escrita; depois delas o marcador é a
 * PRIMEIRA escrita, para que um crash no meio nunca deixe o texto sem Clarice
 * sem o aviso.
 */
export function skipClarice(
  editionDir: string,
  reason: string,
  opts: { now?: () => Date; force?: boolean; edition?: string | null } = {},
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
  const marker: ClaricePendingMarker = {
    reason,
    skipped_at: now().toISOString(),
    source: PRE_CLARICE_REL,
    edition: opts.edition ?? null,
  };
  writeMarker(editionDir, marker);
  copyFileSync(pre, reviewed);
  writeFileSync(join(editionDir, CLARICE_SUGGESTIONS_REL), "[]\n", "utf8");
  return marker;
}

/**
 * Roda `clarice-correct.ts` com os argumentos dados. Devolve o exit code e o
 * stdout do filho (o JSON de resumo da última linha). Um número puro equivale
 * a `{ exitCode, stdout: "" }`.
 */
export type ClariceRunner = (args: string[]) => number | { exitCode: number; stdout: string };

export type ResumeOutcome =
  | { status: "nothing-pending" }
  | { status: "resumed"; preResume: string; protectedDropped: number; applyMode: "corrected" | "filtered-suggestions" }
  | { status: "failed"; exitCode: number }
  | { status: "partial"; summary: Record<string, unknown> | null }
  | { status: "reviewed-missing" }
  | { status: "protection-unreadable"; message: string }
  | { status: "recently-attempted"; lastAttemptAt: string; lastAttemptOutcome: string | null }
  | { status: "reviewed-changed" }
  | { status: "reveal-changed" }
  | { status: "intentional-error-corrected"; wrongValue: string };

/**
 * `wrong_value` declarado (não placeholder) em `_internal/intentional-error.json`,
 * ou `null`. `warn` recebe o motivo quando o arquivo existe mas não dá para
 * usar (ilegível), para o resume não seguir calado sem a proteção.
 */
export function readDeclaredWrongValue(editionDir: string, warn?: (msg: string) => void): string | null {
  const p = join(editionDir, INTENTIONAL_ERROR_REL);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { wrong_value?: unknown };
    const w = typeof j.wrong_value === "string" ? j.wrong_value.trim() : "";
    return w && !isIntentionalErrorPlaceholder(w) ? w : null;
  } catch (e) {
    warn?.(`${INTENTIONAL_ERROR_REL} ilegível (${(e as Error).message}): o erro intencional não foi conferido`);
    return null;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

const REVEAL_LINE = /^\s*Na\s+[úu]ltima\s+edi[çc][ãa]o\b/i;

/**
 * Restaura verbatim, no texto corrigido, as linhas do reveal da edição
 * anterior (`Na última edição, …`) do texto pré-resume, casando por ordem.
 * `null` quando o número dessas linhas mudou (a Clarice mexeu no começo da
 * frase ou juntou parágrafos): aí não há como restaurar com segurança.
 */
export function restoreRevealLines(pre: string, corrected: string): string | null {
  const preReveals = pre.split("\n").filter((l) => REVEAL_LINE.test(l));
  if (preReveals.length === 0) return corrected;
  const lines = corrected.split("\n");
  const idx = lines.flatMap((l, i) => (REVEAL_LINE.test(l) ? [i] : []));
  if (idx.length !== preReveals.length) return null;
  idx.forEach((i, k) => {
    lines[i] = preReveals[k];
  });
  return lines.join("\n");
}

/** JSON de resumo do `clarice-correct.ts` (última linha do stdout que é um objeto). */
function parseRunnerSummary(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const l of lines) {
    try {
      const v: unknown = JSON.parse(l);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* linha que não é JSON */
    }
  }
  return null;
}

function isCompleteSummary(s: Record<string, unknown> | null): boolean {
  if (!s) return false;
  const fallback = s.chunks_used_paragraph_fallback;
  const failed = s.paragraphs_failed;
  return (fallback === undefined || fallback === 0) && (failed === undefined || failed === 0);
}

/**
 * Retoma a revisão: Clarice sobre o `02-reviewed.md` atual. Antes de chamar,
 * guarda o texto em `_internal/02-pre-clarice-resume.md` (base dos guards
 * pós-resume). Só grava `02-reviewed.md`, promove as sugestões e apaga o
 * marcador quando: o runner sai 0 com resumo completo (sem fallback por
 * parágrafo), o `02-reviewed.md` não mudou durante a chamada, o reveal da
 * edição anterior foi restaurado e o erro intencional declarado continua no
 * texto (ou `acceptIntentionalErrorChange`). Em qualquer outro caso nada muda
 * no `02-reviewed.md` e o marcador fica.
 */
export function resumeClarice(
  editionDir: string,
  runner: ClariceRunner,
  opts: {
    edition?: string;
    acceptIntentionalErrorChange?: boolean;
    retryNow?: boolean;
    now?: () => Date;
    warn?: (msg: string) => void;
  } = {},
): ResumeOutcome {
  if (!isClaricePending(editionDir)) return { status: "nothing-pending" };
  const now = opts.now ?? (() => new Date());
  const warn = opts.warn ?? (() => {});
  const marker = readClaricePending(editionDir);

  if (!opts.retryNow && marker?.last_attempt_at) {
    const last = Date.parse(marker.last_attempt_at);
    if (Number.isFinite(last) && now().getTime() - last < RESUME_COOLDOWN_MS) {
      return {
        status: "recently-attempted",
        lastAttemptAt: marker.last_attempt_at,
        lastAttemptOutcome: marker.last_attempt_outcome ?? null,
      };
    }
  }

  const reviewed = join(editionDir, REVIEWED_REL);
  if (!existsSync(reviewed)) return { status: "reviewed-missing" };

  let protection;
  try {
    protection = readFactCheckProtection(editionDir);
  } catch (e) {
    return { status: "protection-unreadable", message: (e as Error).message };
  }

  const recordAttempt = (outcome: string, reason?: string): void => {
    const base: ClaricePendingMarker = marker ?? {
      reason: "motivo ilegível no marcador",
      skipped_at: now().toISOString(),
      source: PRE_CLARICE_REL,
    };
    writeMarker(editionDir, {
      ...base,
      ...(reason ? { reason } : {}),
      edition: base.edition ?? opts.edition ?? null,
      last_attempt_at: now().toISOString(),
      last_attempt_outcome: outcome,
    });
  };

  const preResume = join(editionDir, PRE_RESUME_REL);
  copyFileSync(reviewed, preResume);
  const hashBefore = sha256(reviewed);
  const corrected = join(editionDir, CLARICE_CORRECTED_REL);
  const tmpSuggestions = join(editionDir, RESUME_SUGGESTIONS_TMP_REL);
  rmSync(tmpSuggestions, { force: true });
  const args = [
    "--in", preResume,
    "--out", tmpSuggestions,
    "--corrected-out", corrected,
    "--retry",
    // Sem o fallback por parágrafo: ele sai 0 com parágrafos sem correção.
    "--no-paragraph-fallback",
    ...(opts.edition ? ["--edition", opts.edition] : []),
  ];
  const raw = runner(args);
  const { exitCode, stdout } = typeof raw === "number" ? { exitCode: raw, stdout: "" } : raw;
  if (exitCode !== 0) {
    recordAttempt(`failed:${exitCode}`);
    return { status: "failed", exitCode };
  }
  const summary = parseRunnerSummary(stdout);
  if (!isCompleteSummary(summary) || !existsSync(tmpSuggestions) || !existsSync(corrected)) {
    recordAttempt("partial", "partial");
    return { status: "partial", summary };
  }
  if (!existsSync(reviewed) || sha256(reviewed) !== hashBefore) return { status: "reviewed-changed" };

  const preText = readFileSync(preResume, "utf8");
  let finalText = readFileSync(corrected, "utf8");
  let protectedDropped = 0;
  let applyMode: "corrected" | "filtered-suggestions" = "corrected";
  if (protection.present) {
    const suggestions = JSON.parse(readFileSync(tmpSuggestions, "utf8")) as ClariceSuggestion[];
    const { kept, dropped } = filterClariceSuggestions(suggestions, {
      correctedTexts: protection.correctedTexts,
      protectConditional: true,
    });
    protectedDropped = dropped.filter((d) => d.reason === "fact_check_protected").length;
    if (protectedDropped > 0) {
      finalText = applyClariceSuggestions(preText, kept).patched;
      applyMode = "filtered-suggestions";
    }
  }

  const restored = restoreRevealLines(preText, finalText);
  if (restored === null) return { status: "reveal-changed" };
  finalText = restored;

  const wrongValue = readDeclaredWrongValue(editionDir, warn);
  if (wrongValue) {
    const before = countOccurrences(preText, wrongValue);
    if (before === 0) {
      warn(`o erro intencional declarado ("${wrongValue}") não aparece no ${REVIEWED_REL}: nada a proteger`);
    } else if (!opts.acceptIntentionalErrorChange && countOccurrences(finalText, wrongValue) < before) {
      return { status: "intentional-error-corrected", wrongValue };
    }
  }

  writeFileSync(reviewed, finalText, "utf8");
  renameSync(tmpSuggestions, join(editionDir, CLARICE_SUGGESTIONS_REL));
  rmSync(claricePendingPath(editionDir), { force: true });
  return { status: "resumed", preResume: PRE_RESUME_REL, protectedDropped, applyMode };
}

/**
 * Passos que o Stage 2 roda depois de qualquer passada da Clarice
 * (`.claude/agents/orchestrator-stage-2.md` §2b), com o texto pré-resume como
 * base. Mesma ordem do Stage 2 para travessão, É IA?, URL e cupons; o diff,
 * que no Stage 2 vem antes do strip, aqui vai por último para mostrar o texto
 * final. Os dois primeiros consertam sozinhos; os dois `verify-*` só reportam
 * (exit 1 = levar ao gate, nunca auto-restaurar); o diff leva o
 * `02-normalized.md` como 4º argumento quando existe (sinaliza reversão do
 * humanizador, #3929).
 */
export function postResumeSteps(editionDir: string): Array<{ name: string; args: string[]; reportOnly: boolean }> {
  const pre = join(editionDir, PRE_RESUME_REL);
  const reviewed = join(editionDir, REVIEWED_REL);
  const normalized = join(editionDir, NORMALIZED_REL);
  return [
    { name: "strip-emdashes-reviewed", args: ["scripts/strip-emdashes-reviewed.ts", "--edition-dir", editionDir], reportOnly: false },
    { name: "sync-eia-block", args: ["scripts/sync-eia-block.ts", "--edition-dir", editionDir], reportOnly: false },
    { name: "verify-clarice-url-stability", args: ["scripts/verify-clarice-url-stability.ts", "--pre", pre, "--post", reviewed], reportOnly: true },
    { name: "verify-clarice-coupons", args: ["scripts/verify-clarice-coupons.ts", "--pre", pre, "--post", reviewed], reportOnly: true },
    {
      name: "clarice-diff",
      args: [
        "scripts/clarice-diff.ts",
        pre,
        reviewed,
        join(editionDir, "_internal", "02-clarice-diff.md"),
        ...(existsSync(normalized) ? [normalized] : []),
      ],
      reportOnly: false,
    },
  ];
}
