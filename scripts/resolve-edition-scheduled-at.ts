#!/usr/bin/env node
/**
 * scripts/resolve-edition-scheduled-at.ts (#8207 item 1/4)
 *
 * Wrapper CLI fino de `scripts/lib/edition-scheduled-at.ts::resolveEditionScheduledAt`
 * — imprime só o ISO 8601 UTC no stdout, pra `.claude/agents/orchestrator-stage-6.md`
 * chamar nos DOIS ramos do gate (`sim` default e `sim HH:MM`) com o MESMO
 * comando, em vez de duas rotas de cálculo divergentes (a causa raiz do
 * #8207: o ramo `sim HH:MM` resolvia "amanhã" em prosa livre, contra o
 * relógio, em vez da data da edição).
 *
 * Uso:
 *   npx tsx scripts/resolve-edition-scheduled-at.ts --aammdd 260917 [--hhmm 06:00]
 *
 * Exit codes:
 *   0 — ISO impresso no stdout
 *   1 — uso/erro (args ausentes, AAMMDD/HH:MM inválidos)
 */
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionScheduledAt, DEFAULT_EDITION_SCHEDULE_HHMM } from "./lib/edition-scheduled-at.ts";

export function main(): void {
  const argv = process.argv.slice(2);
  const aammdd = getStringArg(argv, "aammdd");
  const hhmm = getStringArg(argv, "hhmm") ?? DEFAULT_EDITION_SCHEDULE_HHMM;
  if (!aammdd) {
    process.stderr.write(
      "uso: npx tsx scripts/resolve-edition-scheduled-at.ts --aammdd <AAMMDD> [--hhmm HH:MM]\n",
    );
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(resolveEditionScheduledAt(aammdd, hhmm));
  } catch (e) {
    process.stderr.write(`[resolve-edition-scheduled-at] ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
