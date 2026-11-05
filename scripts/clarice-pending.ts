/**
 * clarice-pending.ts (#12257) — CLI da revisão da Clarice pendente.
 *
 * Uso:
 *   # Stage 2, quando clarice-correct.ts sai com exit 6 (clarice_unavailable):
 *   npx tsx scripts/clarice-pending.ts skip --edition-dir data/editions/AAMMDD/ \
 *     --reason clarice_unavailable [--edition AAMMDD]
 *
 *   # Retomar a revisão quando a API voltar (antes ou durante o gate 4):
 *   npx tsx scripts/clarice-pending.ts resume --edition-dir data/editions/AAMMDD/ [--edition AAMMDD]
 *
 *   # Conferir se há revisão pendente:
 *   npx tsx scripts/clarice-pending.ts status --edition-dir data/editions/AAMMDD/
 *
 * Exit codes:
 *   0 — sucesso (skip gravado; resume concluído ou nada pendente; status lido)
 *   1 — args inválidos
 *   3 — skip sem snapshot pré-Clarice
 *   N — resume: o exit code do clarice-correct.ts (o marcador continua)
 *
 * Lógica em `scripts/lib/clarice-pending.ts`.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  readClaricePending,
  resumeClarice,
  skipClarice,
  type ClariceRunner,
} from "./lib/clarice-pending.ts";

const CLARICE_CORRECT = resolve(dirname(fileURLToPath(import.meta.url)), "clarice-correct.ts");

const spawnClariceCorrect: ClariceRunner = (args) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLARICE_CORRECT, ...args], {
    stdio: "inherit",
  });
  return r.status ?? 1;
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const editionDir = flag(argv, "--edition-dir");
  const edition = flag(argv, "--edition");
  if (!editionDir || !["skip", "resume", "status"].includes(cmd ?? "")) {
    console.error(
      "Uso: clarice-pending.ts skip|resume|status --edition-dir <dir> [--reason motivo] [--edition AAMMDD]",
    );
    process.exit(1);
  }

  if (cmd === "status") {
    const marker = readClaricePending(editionDir);
    console.log(JSON.stringify({ pending: marker !== null, marker }));
    return;
  }

  if (cmd === "skip") {
    const reason = flag(argv, "--reason") ?? "clarice_unavailable";
    let marker;
    try {
      marker = skipClarice(editionDir, reason);
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

  const outcome = resumeClarice(editionDir, spawnClariceCorrect, edition);
  console.log(JSON.stringify(outcome));
  if (outcome.status === "failed") process.exit(outcome.exitCode);
  if (outcome.status === "resumed") {
    console.error(
      "[clarice-pending] Clarice aplicada ao 02-reviewed.md e marcador removido. " +
        "Re-renderizar a prévia do gate, como depois de qualquer edição do 02-reviewed.md.",
    );
  }
}

if (isMainModule(import.meta.url)) main();
