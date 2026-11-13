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
 *         3 HTTP/timeout/rede/TLS recusado depois das tentativas, 4 I/O, 5 staleness,
 *         6 clarice_unavailable; o motivo sai do `{"failure"}` do stdout do filho e
 *         vai em `reason` no JSON e em `last_reason` no marcador, #12693). Também 3/6
 *         quando a última tentativa falhou por API (3 ou 6) há menos de 20 min
 *         (`recently-attempted`, mesmo exit da tentativa; `--retry-now` tenta
 *         mesmo assim). O marcador continua.
 *   3 — skip recusado (sem snapshot pré-Clarice, ou 02-reviewed.md editado depois dele)
 *   7 — resume não aplicado: 02-reviewed.md mudou durante a chamada da Clarice
 *   8 — resume não aplicado: a Clarice corrigiu o erro intencional declarado, ou
 *       mexeu no reveal da edição anterior a ponto de não dar para restaurá-lo
 *   9 — resume aplicado, mas um passo pós-Clarice que conserta sozinho
 *       (strip-emdashes-reviewed, sync-eia-block, clarice-diff) falhou
 *  10 — resume não aplicado: correção parcial (fallback por parágrafo ou resumo
 *       ilegível do filho); o marcador fica com `reason: "partial"`
 *  11 — resume não aplicado: 02-reviewed.md ausente, ou
 *       `_internal/fact-check-autofix.json`/`_internal/intentional-error.json` ilegível
 *  12 — resume não aplicado: o clarice-correct.ts (ou um passo pós-Clarice)
 *       morreu por signal/erro de spawn, sem exit code
 *  13 — resume aplicado; `verify-clarice-url-stability`/`verify-clarice-coupons`
 *       acharam algo (exit 1): campo `attention` no JSON, levar ao gate
 *       (não auto-restaurar). Exit ≥ 2 desses checks é falha dura (9).
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
  classifyPostSteps,
  clearClaricePending,
  isClaricePending,
  postResumeSteps,
  readClaricePending,
  resumeClarice,
  resumeCommandFor,
  skipClarice,
  type ClariceRunResult,
  type ClariceRunner,
  type PostStepRun,
  type ResumeOutcome,
} from "./lib/clarice-pending.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RESUME_POST_STEP_FAILED_EXIT = 9;
export const RESUME_PARTIAL_EXIT = 10;
export const RESUME_PRECONDITION_EXIT = 11;
export const RESUME_CRASHED_EXIT = 12;
export const RESUME_ATTENTION_EXIT = 13;

/**
 * Roda um script tsx do repo. O stdout do filho é capturado (o `resume` lê o
 * JSON de resumo do clarice-correct.ts) e repassado ao stderr, para o stdout
 * deste CLI ficar só com o JSON final.
 */
export function runTsx(args: string[]): ClariceRunResult {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: ROOT,
    stdio: ["inherit", "pipe", 2],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout ?? "";
  if (stdout) process.stderr.write(stdout);
  return spawnResultToRun(r);
}

/**
 * `status` nulo (morto por signal) ou `error` do spawn não são exit code: viram
 * `crashed`, para nunca passarem por "achado" (exit 1) nem por sucesso.
 */
export function spawnResultToRun(r: {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stdout?: string | null;
}): ClariceRunResult {
  const stdout = r.stdout ?? "";
  if (r.error) return { exitCode: -1, stdout, crashed: `erro de spawn: ${r.error.message}` };
  if (r.status === null) return { exitCode: -1, stdout, crashed: `morto por signal ${r.signal ?? "?"}` };
  return { exitCode: r.status, stdout };
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
      return outcome.exitCode;
    case "crashed":
      return RESUME_CRASHED_EXIT;
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
      return `Clarice falhou de novo (${outcome.reason}); 02-reviewed.md intacto, revisão continua pendente.`;
    case "recently-attempted":
      return (
        `última tentativa às ${outcome.lastAttemptAt} (${outcome.lastOutcome}` +
        `${outcome.lastReason ? `: ${outcome.lastReason}` : ""}), há menos de 20 min; ` +
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
      return `correção parcial ou não verificável (${outcome.detail}). Nada aplicado; marcador mantido (last_outcome partial).`;
    case "crashed":
      return `clarice-correct.ts não terminou (${outcome.message}). Nada aplicado.`;
    case "reviewed-missing":
      return "02-reviewed.md ausente. Nada aplicado.";
    case "protection-unreadable":
      return `proteção do fact-check ilegível (${outcome.message}). Nada aplicado.`;
    default:
      return "";
  }
}

/** Linhas do stderr depois de um resume aplicado: o que o gate precisa mostrar ao editor. */
export function resumedStderrLines(
  protectedSuggestions: Array<{ from: string; to: string }>,
  attention: PostStepRun[],
  hardFailures: PostStepRun[],
): string[] {
  return [
    "[clarice-pending] Clarice aplicada ao 02-reviewed.md e marcador removido. " +
      "Re-renderizar a prévia do gate, como depois de qualquer edição do 02-reviewed.md.",
    ...protectedSuggestions.map(
      (p) =>
        `[clarice-pending] ⚠️ sugestão retida pela proteção do fact-check (não aplicada): ` +
        `${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}. Levar ao gate.`,
    ),
    ...attention.map((s) => `[clarice-pending] ⚠️ ${s.name} achou algo (exit 1): levar ao gate (não auto-restaurar).`),
    ...hardFailures.map(
      (s) => `[clarice-pending] ⚠️ ${s.name} não rodou direito (${s.crashed ?? `exit ${s.exit}`}): rodar à mão antes do gate.`,
    ),
  ];
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
  const steps: PostStepRun[] = postResumeSteps(editionDir).map((s) => {
    const r = runTsx(s.args);
    return { name: s.name, reportOnly: s.reportOnly, exit: r.exitCode, ...(r.crashed ? { crashed: r.crashed } : {}) };
  });
  const { hardFailures, attention } = classifyPostSteps(steps);
  const code = hardFailures.length
    ? RESUME_POST_STEP_FAILED_EXIT
    : attention.length
      ? RESUME_ATTENTION_EXIT
      : 0;
  const result = {
    ...outcome,
    post_steps: steps,
    attention: attention.map((s) => s.name),
    hard_failures: hardFailures.map((s) => s.name),
    exit: code,
  };
  logEvent({
    edition: edition ?? null,
    stage: 4,
    agent: "clarice-pending",
    level: code === 0 && outcome.protectedSuggestions.length === 0 ? "info" : "warn",
    message: "clarice_resume",
    details: result,
  });
  console.log(JSON.stringify(result));
  for (const line of resumedStderrLines(outcome.protectedSuggestions, attention, hardFailures)) console.error(line);
  if (code !== 0) process.exit(code);
}

if (isMainModule(import.meta.url)) main();
