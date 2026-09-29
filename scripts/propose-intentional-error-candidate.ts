#!/usr/bin/env tsx
/**
 * scripts/propose-intentional-error-candidate.ts (#8592)
 *
 * CLI do gerador determinístico de candidato de erro intencional
 * (`scripts/lib/propose-intentional-error-candidate.ts`). Lê `02-reviewed.md`
 * de uma edição e imprime um candidato pronto pra aceite em 1 clique — ou
 * `candidate: null` quando nenhuma seção secundária menciona uma entidade do
 * catálogo #5742.
 *
 * **Nunca escreve nada em disco.** Só leitura + stdout. Quem decide gravar
 * `_internal/intentional-error.json` (após aceite do editor no gate do
 * Stage 4) é o orchestrator, no chat — este script só monta a proposta.
 *
 * Uso:
 *   npx tsx scripts/propose-intentional-error-candidate.ts --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/propose-intentional-error-candidate.ts --md data/editions/AAMMDD/02-reviewed.md
 *
 * Stdout: JSON `{ candidate: IntentionalErrorCandidate | null }`.
 * Exit codes: 0 = leu com sucesso (candidato encontrado ou não — ambos são
 * saídas válidas, "sem candidato" não é erro); 2 = uso inválido ou arquivo
 * `02-reviewed.md` inexistente.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { proposeIntentionalErrorCandidate } from "./lib/propose-intentional-error-candidate.ts";

export function main(argv: string[] = process.argv.slice(2)): number {
  const values = parseArgs(argv);
  const mdPath = values["md"] ?? (values["edition-dir"] ? join(values["edition-dir"], "02-reviewed.md") : undefined);

  if (!mdPath) {
    console.error(
      "Uso: npx tsx scripts/propose-intentional-error-candidate.ts --edition-dir data/editions/AAMMDD/ | --md <path>",
    );
    return 2;
  }
  if (!existsSync(mdPath)) {
    console.error(`propose-intentional-error-candidate: ${mdPath} não existe`);
    return 2;
  }

  const md = readFileSync(mdPath, "utf8");
  const candidate = proposeIntentionalErrorCandidate(md);
  console.log(JSON.stringify({ candidate }, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
