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
 *   2 — horário resolvido já no passado (ou < 15 min à frente, #11689): stdout
 *       vazio, stderr traz o próximo horário viável. O gate NÃO muda o horário
 *       sozinho: mostra o aviso e o editor responde `ok HH:MM`.
 *
 * `--now <ISO>` injeta o relógio (testes).
 */
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionScheduledAt, checkScheduledAtNotPast, DEFAULT_EDITION_SCHEDULE_HHMM } from "./lib/edition-scheduled-at.ts";

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
    const iso = resolveEditionScheduledAt(aammdd, hhmm);
    const nowArg = getStringArg(argv, "now");
    const check = checkScheduledAtNotPast(iso, nowArg ? new Date(nowArg) : new Date());
    if (!check.ok) {
      process.stderr.write(
        `[resolve-edition-scheduled-at] PASSADO: ${check.reason}\n` +
          `next_viable=${check.nextViable} next_viable_brt=${check.nextViableBrt}\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.stdout.write(iso);
  } catch (e) {
    process.stderr.write(`[resolve-edition-scheduled-at] ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
