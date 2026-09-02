#!/usr/bin/env node
/**
 * scripts/check-replicated-absence.ts (#7083)
 *
 * CLI fino sobre `scripts/lib/replicated-absence.ts` — ferramenta de
 * investigação ad-hoc pra quando uma sessão está prestes a concluir "esta
 * task/alarme nunca rodou" a partir da ausência de um arquivo em `data/`
 * (junction/symlink compartilhada por OneDrive entre máquinas). Existe pra
 * substituir o raciocínio livre que produziu o erro do #7083 (duas sessões
 * independentes, mesma máquina não-executora, mesma conclusão errada) por
 * um veredito mecânico.
 *
 * Uso:
 *   npx tsx scripts/check-replicated-absence.ts --file data/.foo-issues.json [--executing-machine]
 *
 * `--executing-machine`: passe só quando ESTA máquina é a que roda a
 * task/timer investigado (ex: rodando isto em `helios` pra checar o próprio
 * store de `helios`). Sem a flag (default, e o caso mais comum quando se
 * investiga a partir da máquina do editor), o veredito nunca confirma
 * ausência — só aponta pra checar na máquina executora.
 *
 * Não lê `systemctl`/canário sozinho — se quiser contexto de freshness do
 * sync geral, rode `npx tsx scripts/onedrive-sync-alarm.ts --dry-run`
 * separadamente (este CLI não duplica aquele I/O; ver docstring de
 * `scripts/lib/replicated-absence.ts` pra por que o canário nunca resolve o
 * veredito sozinho de qualquer forma).
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import {
  classifyReplicatedAbsence,
  explainReplicatedAbsenceVerdict,
  isConclusiveNonExecution,
} from "./lib/replicated-absence.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function run(argv: string[], cwd: string = ROOT): { exitCode: number; output: string } {
  const file = getArg(argv, "file");
  if (!file) {
    return { exitCode: 1, output: "uso: npx tsx scripts/check-replicated-absence.ts --file <path> [--executing-machine]" };
  }
  const isExecutingMachine = hasFlag(argv, "executing-machine");
  const absolutePath = resolve(cwd, file);
  const fileExists = existsSync(absolutePath);

  const verdict = classifyReplicatedAbsence({ isExecutingMachine, fileExists });
  const explanation = explainReplicatedAbsenceVerdict(verdict);
  const conclusive = isConclusiveNonExecution(verdict);

  const lines = [
    `arquivo: ${file}`,
    `existe: ${fileExists}`,
    `máquina executora: ${isExecutingMachine}`,
    `veredito: ${verdict}`,
    explanation,
    fileExists || conclusive
      ? ""
      : "NÃO conclua 'nunca rodou' a partir disto — confirme na máquina executora antes de afirmar qualquer coisa.",
  ].filter(Boolean);

  return { exitCode: 0, output: lines.join("\n") };
}

if (isMainModule(import.meta.url)) {
  const { exitCode, output } = run(process.argv.slice(2));
  console.log(output);
  process.exitCode = exitCode;
}
