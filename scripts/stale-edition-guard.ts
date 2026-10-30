/**
 * stale-edition-guard.ts (#11690) — CLI. Lógica em `scripts/lib/stale-edition-guard.ts`.
 *
 * Uso (antes de re-rodar um stage porque o sentinel dele/do anterior sumiu):
 *   npx tsx scripts/stale-edition-guard.ts check --edition-dir DIR --step N
 * Exit 0 sem sinais · 4 outro host possivelmente à frente (halt: aguardar sync OneDrive).
 * Só lê; nunca escreve em data/.
 */
import { hostname } from "node:os";
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { readEditionLock } from "./lib/edition-lock.ts";
import { sentinelExists } from "./lib/pipeline-state.ts";
import { assessStaleEdition, describeSignals } from "./lib/stale-edition-guard.ts";

function main(): void {
  const { positional, values } = parseArgs(process.argv.slice(2));
  const step = Number(values.step);
  if (positional[0] !== "check" || !values["edition-dir"] || !Number.isInteger(step)) {
    console.error("Uso: stale-edition-guard.ts check --edition-dir DIR --step N");
    process.exit(2);
  }
  const dir = resolve(values["edition-dir"]);
  const sentinelSteps = [1, 2, 3, 4, 5, 6].filter((n) => sentinelExists(dir, n));
  const verdict = assessStaleEdition({
    step,
    sentinelSteps,
    lock: readEditionLock(dir),
    localHost: hostname(),
  });
  console.log(JSON.stringify(verdict));
  if (!verdict.ok) {
    console.error(
      `[stale-edition-guard] data/ possivelmente defasado — outra máquina parece estar à frente (${describeSignals(verdict.signals)}). Aguardar o sync do OneDrive e tentar de novo; não re-rodar o stage.`,
    );
    process.exit(4);
  }
}

if (isMainModule(import.meta.url)) main();
