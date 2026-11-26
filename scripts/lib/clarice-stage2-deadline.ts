/**
 * clarice-stage2-deadline.ts (#14029)
 *
 * Teto de tempo total da Clarice da NEWSLETTER na Etapa 2 (`clarice-correct.ts
 * --deadline-ms`), decidido pelo ping REAL do Stage 0
 * (`preflight-state.json` → `clariceRealProbe`, gravado por
 * `clarice-healthcheck.ts --real-chunk`).
 *
 * - `clariceRealProbe === false` (o chunk de ~1,8 KB não voltou em 60 s):
 *   teto de 90 s. Estourando, o `clarice-correct.ts` sai com exit 6 e a Etapa
 *   2 segue pelo `clarice-pending.ts skip`; a correção fica para o `resume`
 *   do Stage 4, antes do gate. Decisão do editor de 25/11/2026 (#14029): em
 *   novembro, 12 exits 6 consumiram 480 s cada.
 * - `true` ou `null` (nunca sondado, edição antiga, Stage 0 por partes):
 *   teto normal de 480 s (`CLARICE_TOTAL_DEADLINE_MS` de `clarice-correct.ts`).
 * - `preflight-state.json` existe mas está ilegível: teto normal, com
 *   `stateError` preenchido para o chamador avisar (nunca em silêncio).
 *
 * O teto degradado vale SÓ para a newsletter, a única com `clarice-pending
 * resume` no Stage 4. A Clarice do social mantém o teto normal
 * (`CLARICE_NORMAL_DEADLINE_MS`) e, se falhar, a Etapa 2 para com halt.
 * Newsletter e social continuam em série (#4952): este módulo só escolhe o
 * teto, nunca paraleliza.
 *
 * CLI (para o caminho sem `stage-2-run.ts`):
 *   npx tsx scripts/lib/clarice-stage2-deadline.ts --edition-dir {EDITION_DIR}
 *   → {"deadlineMs":90000,"degraded":true,"reason":"...","stateError":null}
 */
import { isMainModule, parseArgs } from "./cli-args.ts";
import { readPreflightStateDetailed, type PreflightState } from "./preflight-state.ts";

/** Teto normal; igual a `CLARICE_TOTAL_DEADLINE_MS` de `scripts/clarice-correct.ts` (teste trava). */
export const CLARICE_NORMAL_DEADLINE_MS = 480_000;
/** Teto da newsletter quando o ping real do Stage 0 falhou (#14029). */
export const CLARICE_DEGRADED_DEADLINE_MS = 90_000;

export interface ClariceStage2Deadline {
  /** Teto da Clarice da newsletter. O social usa sempre `CLARICE_NORMAL_DEADLINE_MS`. */
  deadlineMs: number;
  degraded: boolean;
  reason: string;
  /** Motivo quando `preflight-state.json` existe e não pôde ser lido; `null` no resto. */
  stateError: string | null;
}

export function resolveClariceStage2DeadlineMs(
  state: Pick<PreflightState, "clariceRealProbe">,
  stateError: string | null = null,
): ClariceStage2Deadline {
  if (stateError) {
    return {
      deadlineMs: CLARICE_NORMAL_DEADLINE_MS,
      degraded: false,
      reason: `preflight-state.json ilegível (${stateError}): ping real desconhecido, teto normal de 480 s na newsletter`,
      stateError,
    };
  }
  if (state.clariceRealProbe === false) {
    return {
      deadlineMs: CLARICE_DEGRADED_DEADLINE_MS,
      degraded: true,
      reason:
        "ping real da Clarice falhou no Stage 0 (clariceRealProbe=false): teto de 90 s na Clarice da newsletter; estourando, clarice-pending skip e resume no Stage 4. O social mantém o teto normal de 480 s",
      stateError: null,
    };
  }
  return {
    deadlineMs: CLARICE_NORMAL_DEADLINE_MS,
    degraded: false,
    reason:
      state.clariceRealProbe === true
        ? "ping real da Clarice ok no Stage 0: teto normal de 480 s"
        : "ping real da Clarice não sondado nesta edição: teto normal de 480 s",
    stateError: null,
  };
}

/** Lê o `preflight-state.json` da edição e resolve o teto, propagando arquivo ilegível. */
export function resolveClariceStage2DeadlineForEdition(editionDir: string): ClariceStage2Deadline {
  const { state, error } = readPreflightStateDetailed(editionDir);
  return resolveClariceStage2DeadlineMs(state, error);
}

if (isMainModule(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  const editionDir = parsed.values["edition-dir"];
  if (!editionDir) {
    console.error("uso: clarice-stage2-deadline.ts --edition-dir <dir>");
    process.exit(1);
  }
  const out = resolveClariceStage2DeadlineForEdition(editionDir);
  if (out.stateError) console.error(`AVISO: ${out.reason}`);
  console.log(JSON.stringify(out));
}
