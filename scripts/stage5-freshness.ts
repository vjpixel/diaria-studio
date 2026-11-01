/**
 * stage5-freshness.ts (#11698) — CLI. Lógica em `scripts/lib/stage5-freshness.ts`.
 *
 * Uso (Stage 5 §5a, antes de qualquer escrita/dispatch):
 *   npx tsx scripts/stage5-freshness.ts check --edition-dir DIR [--edition AAMMDD] [--force]
 *
 * Exit 0 = conteúdo local bate com o aprovado no gate 4 (ou sentinel legado,
 * anterior a `OUTPUT_HASHES_REQUIRED_SINCE`, com aviso) · 4 = possivelmente defasado (halt: aguardar o sync do OneDrive)
 * · 2 = uso inválido. Exceção de leitura (arquivo sumindo no meio do sync)
 * vira exit 4, nunca "sem problemas". Stdout: JSON com `verification`,
 * `problems` (tipados por `kind`) e `warnings`; stderr: uma linha por problema
 * com a ação do tipo (`STAGE5_PROBLEM_ACTIONS`).
 *
 * `--force` (só com confirmação do editor, ex.: ajuste feito no Studio depois
 * do gate 4): sai 0 e registra o override em `data/run-log.jsonl` (`level:
 * warn`, `message: stage5_freshness_forced`, problemas em `details`).
 * Só lê a edição; a única escrita é esse evento de override.
 */
import { basename, resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  STAGE5_PROBLEM_ACTIONS,
  checkStage5Freshness,
  type Stage5FreshnessResult,
  type Stage5Problem,
} from "./lib/stage5-freshness.ts";

/** Uma linha por problema, com o tipo e a ação daquele tipo. */
export function describeProblems(problems: Stage5Problem[]): string {
  return problems.map((p) => `[${p.kind}] ${p.message} → ${STAGE5_PROBLEM_ACTIONS[p.kind]}`).join("; ");
}

export interface FreshnessCliOpts {
  /** Raiz para resolver o run-log (default cwd). Injetável em teste. */
  logRoot?: string;
}

/** Roda a checagem e devolve o exit code (sem `process.exit`, para teste). */
export function runStage5Freshness(argv: string[], opts: FreshnessCliOpts = {}): number {
  const { positional, values, flags } = parseArgs(argv);
  if (positional[0] !== "check" || !values["edition-dir"]) {
    console.error("Uso: stage5-freshness.ts check --edition-dir DIR [--edition AAMMDD] [--force]");
    return 2;
  }
  const dir = resolve(values["edition-dir"]);
  let r: Stage5FreshnessResult;
  try {
    r = checkStage5Freshness(dir);
  } catch (e) {
    r = {
      ok: false,
      verification: "verified",
      problems: [
        {
          kind: "sentinel_unreadable",
          message: `erro ao ler a edição (arquivo sumindo no meio do sync?): ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
      warnings: [],
    };
  }
  console.log(JSON.stringify(r));
  for (const w of r.warnings) console.error(`[stage5-freshness] aviso: ${w}`);
  if (r.ok) return 0;
  if (flags.has("force")) {
    const dirName = basename(dir);
    const logged = logEvent(
      {
        edition: values.edition ?? (/^\d{6}$/.test(dirName) ? dirName : null),
        stage: 5,
        agent: "stage5-freshness",
        level: "warn",
        message: "stage5_freshness_forced",
        details: { edition_dir: dir, kinds: [...new Set(r.problems.map((p) => p.kind))], problems: r.problems },
      },
      opts.logRoot,
    );
    console.error(
      `[stage5-freshness] --force: override com problemas (${describeProblems(r.problems)})` +
        (logged ? " — registrado no run-log." : " — ATENÇÃO: falha ao registrar no run-log, override sem rastro durável."),
    );
    return 0;
  }
  console.error(
    `[stage5-freshness] edição possivelmente defasada neste host — não despachar: ${describeProblems(r.problems)}. --force (qualquer tipo) só com confirmação do editor.`,
  );
  return 4;
}

if (isMainModule(import.meta.url)) process.exitCode = runStage5Freshness(process.argv.slice(2));
