/**
 * stale-edition-guard.ts (#11690) — CLI. Lógica em `scripts/lib/stale-edition-guard.ts`.
 *
 * Uso (antes de re-rodar um stage porque o sentinel dele/do anterior sumiu):
 *   npx tsx scripts/stale-edition-guard.ts check --edition-dir DIR --step N [--outputs-missing] [--edition AAMMDD]
 * `--force` (só com confirmação do editor): sai 0 e registra o override em
 * `data/run-log.jsonl` (`level: warn`, `message: stale_edition_guard_forced`,
 * com os sinais em `details`, #11714). `--edition` default = nome do
 * diretório quando ele é um AAMMDD.
 * Exit 0 sem sinais · 4 outro host possivelmente à frente (halt: aguardar sync OneDrive).
 * Qualquer outra saída (2 uso inválido, crash do tsx/exceção) NÃO é "sem sinais":
 * o caller trata exit ≠ 0 como halt (#11690).
 * Só lê a edição; nunca escreve nela. A única escrita é o evento de override
 * no run-log, e só com `--force` e sinais presentes.
 */
import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionLockUnreadable, readEditionLock } from "./lib/edition-lock.ts";
import { sentinelExists } from "./lib/pipeline-state.ts";
import { findNewestFile, formatNewestFileEvidence } from "./lib/sentinel-absence-hint.ts";
import { logEvent } from "./lib/run-log.ts";
import { assessStaleEdition, describeSignals } from "./lib/stale-edition-guard.ts";

export interface GuardCliOpts {
  /** Raiz para resolver o run-log (default cwd). Injetável em teste. */
  logRoot?: string;
  host?: string;
  now?: number;
}

/** Roda o guard e devolve o exit code (sem `process.exit`, para teste). */
export function runStaleEditionGuard(argv: string[], opts: GuardCliOpts = {}): number {
  const { positional, values, flags } = parseArgs(argv);
  const step = Number(values.step);
  if (positional[0] !== "check" || !values["edition-dir"] || !Number.isInteger(step)) {
    console.error("Uso: stale-edition-guard.ts check --edition-dir DIR --step N [--outputs-missing] [--edition AAMMDD] [--force]");
    return 2;
  }
  const dir = resolve(values["edition-dir"]);
  const sentinelSteps = [1, 2, 3, 4, 5, 6].filter((n) => sentinelExists(dir, n));
  const outputsMissing = flags.has("outputs-missing");
  const verdict = assessStaleEdition({
    step,
    sentinelSteps,
    lock: readEditionLock(dir),
    localHost: opts.host ?? hostname(),
    outputsMissing,
    lockUnreadable: editionLockUnreadable(dir),
    now: opts.now,
  });
  console.log(JSON.stringify(verdict));
  if (!verdict.ok && flags.has("force")) {
    const described = describeSignals(verdict.signals);
    const dirName = basename(dir);
    const edition = values.edition ?? (/^\d{6}$/.test(dirName) ? dirName : null);
    // Registro durável do override (#11714): sem ele, um clobber depois do
    // --force não deixa rastro de que o guard foi furado nem de quais sinais havia.
    const logged = logEvent(
      {
        edition,
        stage: step,
        agent: "stale-edition-guard",
        level: "warn",
        message: "stale_edition_guard_forced",
        details: {
          step,
          outputs_missing: outputsMissing,
          host: opts.host ?? hostname(),
          edition_dir: dir,
          signals: verdict.signals,
          described,
        },
      },
      opts.logRoot,
    );
    console.error(
      `[stale-edition-guard] --force: override com sinais (${described})` +
        (logged ? " — registrado no run-log." : " — ATENÇÃO: falha ao registrar no run-log, override sem rastro durável."),
    );
    return 0;
  }
  if (!verdict.ok) {
    // #11729: a idade do arquivo mais recente da edição aqui ajuda o editor a
    // decidir entre "o sync não chegou" e "a outra sessão morreu".
    const evidence = formatNewestFileEvidence(findNewestFile(dir), opts.now ?? Date.now());
    console.error(
      `[stale-edition-guard] data/ possivelmente defasado — outra máquina parece estar à frente (${describeSignals(verdict.signals)}). ${evidence} Aguardar o sync do OneDrive e tentar de novo; não re-rodar o stage. Se a outra sessão morreu (trava órfã), ou o tombstone de aprovação ficou para trás porque o sentinel/outputs foram removidos de propósito, o editor confirma e re-roda o guard com --force.`,
    );
    return 4;
  }
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = runStaleEditionGuard(process.argv.slice(2));
