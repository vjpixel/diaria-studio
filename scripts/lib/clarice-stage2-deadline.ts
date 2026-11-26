/**
 * clarice-stage2-deadline.ts (#14029)
 *
 * Teto de tempo total da Clarice na Etapa 2 (`clarice-correct.ts
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
 *
 * Newsletter e social continuam em série (#4952): este módulo só escolhe o
 * teto, nunca paraleliza.
 *
 * CLI (para o caminho sem `stage-2-run.ts`):
 *   npx tsx scripts/lib/clarice-stage2-deadline.ts --edition-dir {EDITION_DIR}
 *   → {"deadlineMs":90000,"degraded":true,"reason":"..."}
 */
import { isMainModule, parseArgs } from "./cli-args.ts";
import { readPreflightState, type PreflightState } from "./preflight-state.ts";

/** Teto normal; igual a `CLARICE_TOTAL_DEADLINE_MS` de `scripts/clarice-correct.ts` (teste trava). */
export const CLARICE_NORMAL_DEADLINE_MS = 480_000;
/** Teto quando o ping real do Stage 0 falhou (#14029). */
export const CLARICE_DEGRADED_DEADLINE_MS = 90_000;

export interface ClariceStage2Deadline {
  deadlineMs: number;
  degraded: boolean;
  reason: string;
}

export function resolveClariceStage2DeadlineMs(
  state: Pick<PreflightState, "clariceRealProbe">,
): ClariceStage2Deadline {
  if (state.clariceRealProbe === false) {
    return {
      deadlineMs: CLARICE_DEGRADED_DEADLINE_MS,
      degraded: true,
      reason: "ping real da Clarice falhou no Stage 0 (clariceRealProbe=false): teto de 90 s, estourando vai para clarice-pending skip",
    };
  }
  return {
    deadlineMs: CLARICE_NORMAL_DEADLINE_MS,
    degraded: false,
    reason:
      state.clariceRealProbe === true
        ? "ping real da Clarice ok no Stage 0: teto normal de 480 s"
        : "ping real da Clarice não sondado nesta edição: teto normal de 480 s",
  };
}

if (isMainModule(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  const editionDir = parsed.values["edition-dir"];
  if (!editionDir) {
    console.error("uso: clarice-stage2-deadline.ts --edition-dir <dir>");
    process.exit(1);
  }
  console.log(JSON.stringify(resolveClariceStage2DeadlineMs(readPreflightState(editionDir))));
}
