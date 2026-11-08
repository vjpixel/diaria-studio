/**
 * clarice-pending.ts (#12257) — CLI da revisão da Clarice pendente.
 *
 * Uso:
 *   # Stage 2, quando clarice-correct.ts sai com exit 6 (clarice_unavailable),
 *   # ou no skip consciente aprovado pelo editor (#2320):
 *   npx tsx scripts/clarice-pending.ts skip --edition-dir data/editions/AAMMDD/ \
 *     --reason clarice_unavailable [--edition AAMMDD] [--force]
 *
 *   # Stage 2, quando a Clarice roda com sucesso num rerun (apaga o marcador):
 *   npx tsx scripts/clarice-pending.ts clear --edition-dir data/editions/AAMMDD/
 *
 *   # Retomar a revisão (início do Stage 4, antes do fact-check e dos lints):
 *   npx tsx scripts/clarice-pending.ts resume --edition-dir data/editions/AAMMDD/ \
 *     [--edition AAMMDD] [--accept-intentional-error-change] [--retry-now]
 *
 *   # Conferir se há revisão pendente:
 *   npx tsx scripts/clarice-pending.ts status --edition-dir data/editions/AAMMDD/
 *
 * O `resume` chama `clarice-correct.ts` e pode levar até o teto dele (8 min):
 * chamar a Bash tool com `timeout: 600000`.
 *
 * Exit codes:
 *   0 — sucesso (skip gravado; clear feito; resume concluído ou nada pendente; status lido)
 *   1 — args inválidos
 *   2-6 — resume: exit do clarice-correct.ts, repassado (2 sem CLARICE_API_KEY,
 *         3 HTTP/timeout, 4 I/O, 5 staleness, 6 clarice_unavailable). Também 6
 *         quando a última tentativa falhou há menos de 20 min (`recently-attempted`;
 *         `--retry-now` tenta mesmo assim). O marcador continua.
 *   3 — skip recusado (sem snapshot pré-Clarice, ou 02-reviewed.md editado depois dele)
 *   7 — resume não aplicado: 02-reviewed.md mudou durante a chamada da Clarice
 *   8 — resume não aplicado: a Clarice corrigiu o erro intencional declarado, ou
 *       mexeu no reveal da edição anterior a ponto de não dar para restaurá-lo
 *   9 — resume aplicado, mas um passo pós-Clarice que conserta sozinho
 *       (strip-emdashes-reviewed, sync-eia-block, clarice-diff) falhou
 *  10 — resume não aplicado: correção parcial (fallback por parágrafo ou resumo
 *       ilegível do filho); o marcador fica com `reason: "partial"`
 *  11 — resume não aplicado: 02-reviewed.md ausente ou
 *       `_internal/fact-check-autofix.json` ilegível
 *
 * Depois de um resume aplicado, roda os passos pós-Clarice do Stage 2
 * (`postResumeSteps`): travessão, É IA?, estabilidade de URL, cupons e diff.
 * Os `verify-*` só reportam; exit 1 deles vira aviso para o gate, não falha.
 *
 * Lógica em `scripts/lib/clarice-pending.ts`.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  CLARICE_CORRECTED_REL,
  clearClaricePending,
  isClaricePending,
  postResumeSteps,
  readClaricePending,
  resumeClarice,
  resumeCommandFor,
  skipClarice,
  type ClariceRunner,
  type ResumeOutcome,
} from "./lib/clarice-pending.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RESUME_POST_STEP_FAILED_EXIT = 9;
export const RESUME_PARTIAL_EXIT = 10;
export const RESUME_PRECONDITION_EXIT = 11;

/**
 * Roda um script tsx do repo. O stdout do filho é capturado (o `resume` lê o
 * JSON de resumo do clarice-correct.ts) e repassado ao stderr, para o stdout
 * deste CLI ficar só com o JSON final.
 */
function runTsx(args: string[]): { exitCode: number; stdout: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: ROOT,
    stdio: ["inherit", "pipe", 2],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout ?? "";
  if (stdout) process.stderr.write(stdout);
  return { exitCode: r.status ?? 1, stdout };
}

const spawnClariceCorrect: ClariceRunner = (args) => runTsx(["scripts/clarice-correct.ts", ...args]);

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

/** Exit code do `resume` para cada desfecho que não aplica nada. */
export function resumeExitCode(outcome: ResumeOutcome): number {
  switch (outcome.status) {
    case "nothing-pending":
    case "resumed":
      return 0;
    case "failed":
      return outcome.exitCode;
    case "recently-attempted":
      return 6;
    case "reviewed-changed":
      return 7;
    case "intentional-error-corrected":
    case "reveal-changed":
      return 8;
    case "partial":
      return RESUME_PARTIAL_EXIT;
    case "reviewed-missing":
    case "protection-unreadable":
      return RESUME_PRECONDITION_EXIT;
  }
}

function resumeMessage(outcome: ResumeOutcome): string {
  switch (outcome.status) {
    case "failed":
      return "Clarice falhou de novo; 02-reviewed.md intacto, revisão continua pendente.";
    case "recently-attempted":
      return (
        `última tentativa às ${outcome.lastAttemptAt} (${outcome.lastAttemptOutcome ?? "?"}), há menos de 20 min; ` +
        "não tentei de novo. Revisão continua pendente (--retry-now tenta mesmo assim)."
      );
    case "reviewed-changed":
      return "02-reviewed.md mudou enquanto a Clarice rodava (edição pelo Studio?). Nada aplicado; rode o resume de novo sobre o texto atual.";
    case "intentional-error-corrected":
      return (
        `a Clarice corrigiu o erro intencional ("${outcome.wrongValue}"). Nada aplicado. ` +
        `O texto corrigido está em ${CLARICE_CORRECTED_REL}. Para aplicar mesmo assim e replantar o erro à mão, ` +
        "repita com --accept-intentional-error-change."
      );
    case "reveal-changed":
      return `a Clarice mexeu no reveal da edição anterior ("Na última edição, …") e não deu para restaurá-lo. Nada aplicado; o corrigido está em ${CLARICE_CORRECTED_REL}.`;
    case "partial":
      return "a Clarice não corrigiu o texto inteiro (fallback por parágrafo ou resumo ilegível). Nada aplicado; marcador com reason partial.";
    case "reviewed-missing":
      return "02-reviewed.md ausente. Nada aplicado.";
    case "protection-unreadable":
      return `proteção do fact-check ilegível (${outcome.message}). Nada aplicado.`;
    default:
      return "";
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const editionDirArg = flag(argv, "--edition-dir");
  const edition = flag(argv, "--edition");
  if (!editionDirArg || !["skip", "resume", "status", "clear"].includes(cmd ?? "")) {
    console.error(
      "Uso: clarice-pending.ts skip|resume|status|clear --edition-dir <dir> [--reason motivo] [--edition AAMMDD] [--force] [--accept-intentional-error-change] [--retry-now]",
    );
    process.exit(1);
  }
  const editionDir = resolve(editionDirArg);

  if (cmd === "status") {
    const marker = readClaricePending(editionDir);
    const pending = isClaricePending(editionDir);
    console.log(
      JSON.stringify({
        pending,
        marker_valid: marker !== null,
        marker,
        ...(pending ? { resume_command: resumeCommandFor(editionDir, marker?.edition ?? edition) } : {}),
      }),
    );
    return;
  }

  if (cmd === "clear") {
    const had = clearClaricePending(editionDir);
    if (had) {
      logEvent({
        edition: edition ?? null,
        stage: 2,
        agent: "clarice-pending",
        level: "info",
        message: "clarice_pending_cleared",
        details: { reason: "clarice_ran_on_rerun" },
      });
    }
    console.log(JSON.stringify({ cleared: had }));
    return;
  }

  if (cmd === "skip") {
    const reason = flag(argv, "--reason") ?? "clarice_unavailable";
    let marker;
    try {
      marker = skipClarice(editionDir, reason, { force: argv.includes("--force"), edition: edition ?? null });
    } catch (e) {
      console.error(`[clarice-pending] ${(e as Error).message}`);
      process.exit(3);
    }
    // Mesmo evento do skip consciente (#2320) — `collect-edition-signals.ts`
    // (`signalsFromClariceSkips`) já conta a frequência por ele.
    logEvent({
      edition: edition ?? null,
      stage: 2,
      agent: "clarice-pending",
      level: "warn",
      message: "clarice_skip",
      details: { reason, stage: 2, resumable: true },
    });
    const resume = resumeCommandFor(editionDirArg, edition);
    console.log(JSON.stringify({ skipped: true, ...marker, resume_command: resume }));
    console.error(
      `[clarice-pending] clarice não rodou (${reason}). 02-reviewed.md gravado a partir do texto humanizado. ` +
        `Retomar: ${resume}`,
    );
    return;
  }

  const outcome = resumeClarice(editionDir, spawnClariceCorrect, {
    edition,
    acceptIntentionalErrorChange: argv.includes("--accept-intentional-error-change"),
    retryNow: argv.includes("--retry-now"),
    warn: (msg) => console.error(`[clarice-pending] ⚠️ ${msg}`),
  });

  if (outcome.status !== "resumed") {
    const code = resumeExitCode(outcome);
    if (outcome.status !== "nothing-pending") {
      logEvent({
        edition: edition ?? null,
        stage: 4,
        agent: "clarice-pending",
        level: "warn",
        message: "clarice_resume",
        details: { ...outcome, exit: code },
      });
      console.error(`[clarice-pending] ${resumeMessage(outcome)}`);
    }
    console.log(JSON.stringify({ ...outcome, exit: code }));
    if (code !== 0) process.exit(code);
    return;
  }

  // resumed: passos pós-Clarice do Stage 2 contra o texto pré-resume.
  const steps = postResumeSteps(editionDir).map((s) => ({
    name: s.name,
    reportOnly: s.reportOnly,
    exit: runTsx(s.args).exitCode,
  }));
  const attention = steps.filter((s) => s.exit !== 0);
  const hardFailure = attention.some((s) => !s.reportOnly);
  const code = hardFailure ? RESUME_POST_STEP_FAILED_EXIT : 0;
  logEvent({
    edition: edition ?? null,
    stage: 4,
    agent: "clarice-pending",
    level: attention.length ? "warn" : "info",
    message: "clarice_resume",
    details: { ...outcome, post_steps: steps, exit: code },
  });
  console.log(JSON.stringify({ ...outcome, post_steps: steps, exit: code }));
  console.error(
    "[clarice-pending] Clarice aplicada ao 02-reviewed.md e marcador removido. " +
      "Re-renderizar a prévia do gate, como depois de qualquer edição do 02-reviewed.md.",
  );
  for (const s of attention) {
    console.error(
      s.reportOnly
        ? `[clarice-pending] ⚠️ ${s.name} saiu ${s.exit}: levar ao gate (não auto-restaurar).`
        : `[clarice-pending] ⚠️ ${s.name} falhou (exit ${s.exit}): rodar à mão antes do gate.`,
    );
  }
  if (code !== 0) process.exit(code);
}

if (isMainModule(import.meta.url)) main();
