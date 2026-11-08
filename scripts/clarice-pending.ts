/**
 * clarice-pending.ts (#12257) — CLI da revisão da Clarice pendente.
 *
 * Uso:
 *   # Stage 2, quando clarice-correct.ts sai com exit 6 (clarice_unavailable):
 *   npx tsx scripts/clarice-pending.ts skip --edition-dir data/editions/AAMMDD/ \
 *     --reason clarice_unavailable [--edition AAMMDD] [--force]
 *
 *   # Retomar a revisão quando a API voltar (antes ou durante o gate 4):
 *   npx tsx scripts/clarice-pending.ts resume --edition-dir data/editions/AAMMDD/ \
 *     [--edition AAMMDD] [--accept-intentional-error-change]
 *
 *   # Conferir se há revisão pendente:
 *   npx tsx scripts/clarice-pending.ts status --edition-dir data/editions/AAMMDD/
 *
 * Exit codes:
 *   0 — sucesso (skip gravado; resume concluído ou nada pendente; status lido)
 *   1 — args inválidos
 *   3 — skip recusado (sem snapshot pré-Clarice, ou 02-reviewed.md editado depois dele)
 *   7 — resume não aplicado: 02-reviewed.md mudou durante a chamada da Clarice
 *   8 — resume não aplicado: a Clarice corrigiu o erro intencional declarado
 *   N — resume: o exit code do clarice-correct.ts (o marcador continua)
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
  isClaricePending,
  postResumeSteps,
  readClaricePending,
  resumeClarice,
  skipClarice,
  type ClariceRunner,
} from "./lib/clarice-pending.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Roda um script tsx do repo; stdout do filho vai pro stderr, o stdout deste CLI fica só com o JSON final. */
function runTsx(args: string[]): number {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, stdio: ["inherit", 2, 2] });
  return r.status ?? 1;
}

const spawnClariceCorrect: ClariceRunner = (args) => runTsx(["scripts/clarice-correct.ts", ...args]);

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const editionDirArg = flag(argv, "--edition-dir");
  const edition = flag(argv, "--edition");
  if (!editionDirArg || !["skip", "resume", "status"].includes(cmd ?? "")) {
    console.error(
      "Uso: clarice-pending.ts skip|resume|status --edition-dir <dir> [--reason motivo] [--edition AAMMDD] [--force] [--accept-intentional-error-change]",
    );
    process.exit(1);
  }
  const editionDir = resolve(editionDirArg);

  if (cmd === "status") {
    const marker = readClaricePending(editionDir);
    const pending = isClaricePending(editionDir);
    console.log(JSON.stringify({ pending, marker_valid: marker !== null, marker }));
    return;
  }

  if (cmd === "skip") {
    const reason = flag(argv, "--reason") ?? "clarice_unavailable";
    let marker;
    try {
      marker = skipClarice(editionDir, reason, { force: argv.includes("--force") });
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
    console.log(JSON.stringify({ skipped: true, ...marker }));
    console.error(
      `[clarice-pending] clarice não rodou (${reason}). 02-reviewed.md gravado a partir do texto humanizado. ` +
        `Retomar: ${marker.resume_command}`,
    );
    return;
  }

  const outcome = resumeClarice(editionDir, spawnClariceCorrect, {
    edition,
    acceptIntentionalErrorChange: argv.includes("--accept-intentional-error-change"),
  });
  if (outcome.status === "failed") {
    console.log(JSON.stringify(outcome));
    console.error("[clarice-pending] Clarice falhou de novo; 02-reviewed.md intacto, revisão continua pendente.");
    process.exit(outcome.exitCode);
  }
  if (outcome.status === "reviewed-changed") {
    console.log(JSON.stringify(outcome));
    console.error(
      "[clarice-pending] 02-reviewed.md mudou enquanto a Clarice rodava (edição pelo Studio?). " +
        "Nada aplicado; rode o resume de novo sobre o texto atual.",
    );
    process.exit(7);
  }
  if (outcome.status === "intentional-error-corrected") {
    console.log(JSON.stringify(outcome));
    console.error(
      `[clarice-pending] a Clarice corrigiu o erro intencional ("${outcome.wrongValue}"). Nada aplicado. ` +
        `O texto corrigido está em ${CLARICE_CORRECTED_REL}. Para aplicar mesmo assim e replantar o erro à mão, ` +
        "repita com --accept-intentional-error-change.",
    );
    process.exit(8);
  }
  if (outcome.status === "nothing-pending") {
    console.log(JSON.stringify(outcome));
    return;
  }

  // resumed: passos pós-Clarice do Stage 2 contra o texto pré-resume.
  const steps = postResumeSteps(editionDir).map((s) => ({ name: s.name, reportOnly: s.reportOnly, exit: runTsx(s.args) }));
  const attention = steps.filter((s) => s.exit !== 0);
  console.log(JSON.stringify({ ...outcome, post_steps: steps }));
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
}

if (isMainModule(import.meta.url)) main();
