#!/usr/bin/env node
/**
 * scripts/task-registry-prose-drift-check.ts (#6105 item 2)
 *
 * Drift-check entre a PROSA do registro (`docs/scheduled-tasks-registry.md`)
 * e o estado real do systemd `--user`. O comparador executável do #5607
 * (`task-never-armed-alarm.ts`) cruza o registro TIPADO contra o systemd;
 * quem mentiu no achado da #6105 foi a PROSA do `.md` (entrada de
 * `Diaria-Onboarding-Welcome-Run` dizia "não armada" com o timer
 * `enabled / active`) — e é o `.md` que o CLAUDE.md manda ler.
 *
 * SÓ LEITURA: `systemctl --user list-timers --all` — nunca muta systemd
 * (mesmo guard do task-never-armed-alarm.ts). Máquina sem systemctl
 * (`unknown`): sai limpo com aviso honesto, nunca alarme falso.
 *
 * Uso:
 *   npx tsx scripts/task-registry-prose-drift-check.ts            # avalia + imprime
 *   npx tsx scripts/task-registry-prose-drift-check.ts --json     # saída programática
 *
 * Exit codes: 0 = sem drift (ou nada verificável); 1 = drift encontrado.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag } from "./lib/cli-args.ts";
import { unitBaseName } from "./lib/systemd-units.ts";
import { parseSystemctlListTimersOutput } from "./lib/task-never-armed-alarm.ts";
import {
  evaluateProseDrift,
  type RealArmedState,
} from "./lib/task-registry-prose-drift.ts";
import { listScheduledTaskNames } from "./lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROSE_PATH = join(ROOT, "docs", "scheduled-tasks-registry.md");
const LOG_PREFIX = "[task-registry-prose-drift]";

function readArmedTimerUnits(): string[] | null {
  try {
    const out = execFileSync(
      "systemctl",
      ["--user", "list-timers", "--all", "--plain", "--no-legend"],
      { encoding: "utf8", timeout: 15_000 },
    );
    return parseSystemctlListTimersOutput(out);
  } catch {
    return null;
  }
}

const prose = readFileSync(PROSE_PATH, "utf8");
const taskNames = listScheduledTaskNames();
const armedUnits = readArmedTimerUnits();

if (armedUnits === null) {
  console.log(
    `${LOG_PREFIX} systemctl --user indisponível nesta máquina — nada verificável aqui (fail-soft honesto, mesmo padrão do #5607).`,
  );
  process.exit(0);
}

const armedSet = new Set(armedUnits);
const realByTask = new Map<string, RealArmedState>(
  taskNames.map((name) => [name, armedSet.has(unitBaseName(name)) ? "armed" : "not-armed"]),
);

const evaluation = evaluateProseDrift(prose, taskNames, realByTask);

if (hasFlag(process.argv, "--json")) {
  console.log(JSON.stringify(evaluation, null, 2));
} else {
  console.log(
    `${LOG_PREFIX} ${evaluation.checked} afirmação(ões) de arme verificadas na prosa; ${evaluation.unverifiable.length} não verificável(is) nesta máquina.`,
  );
  if (evaluation.findings.length === 0) {
    console.log(`${LOG_PREFIX} prosa × systemd: sem drift.`);
  } else {
    for (const f of evaluation.findings) {
      console.log(
        `${LOG_PREFIX} DRIFT: ${f.task} — prosa diz "${f.claim}" (linha ${f.line}) mas systemd real = "${f.real}". Corrigir a entrada em docs/scheduled-tasks-registry.md (ou armar/desarmar o timer — ação manual do editor).`,
      );
    }
  }
}

process.exit(evaluation.findings.length > 0 ? 1 : 0);
