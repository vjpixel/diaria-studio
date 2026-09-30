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
 * (#9101) Filtro de repetição: lê `data/intentional-errors.jsonl` (override
 * `--jsonl <path>`; ausente = sem filtro, fail-soft) e descarta grafia já usada
 * / entidade usada nos últimos `--window-days` (default 30) antes de `--edition`
 * (default: basename de `--edition-dir`).
 *
 * Stdout: JSON `{ candidate: IntentionalErrorCandidate | null }`.
 * Exit codes: 0 = leu com sucesso (candidato encontrado ou não — ambos são
 * saídas válidas, "sem candidato" não é erro); 2 = uso inválido ou arquivo
 * `02-reviewed.md` inexistente.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { proposeIntentionalErrorCandidate } from "./lib/propose-intentional-error-candidate.ts";
import { loadIntentionalErrors } from "./lib/intentional-errors.ts";
import { intentionalErrorsJsonlPathForEditionDir } from "./lib/intentional-error-repeat.ts";

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
  // #9101 — histórico fail-soft (arquivo ausente = lista vazia = sem filtro).
  const editionDirArg = values["edition-dir"]?.replace(/[\\/]+$/, "");
  // --edition-dir fora de `.../editions/` (fixture) → sem histórico, nunca o `data/` do cwd.
  const jsonlPath =
    values["jsonl"] ??
    (editionDirArg ? intentionalErrorsJsonlPathForEditionDir(editionDirArg) : join("data", "intentional-errors.jsonl"));
  const edition = values["edition"] ?? (editionDirArg ? basename(editionDirArg) : "");
  const windowDays = values["window-days"] ? Number(values["window-days"]) : undefined;
  const candidate = proposeIntentionalErrorCandidate(md, {
    history: jsonlPath ? loadIntentionalErrors(jsonlPath) : [],
    edition,
    windowDays: windowDays !== undefined && Number.isFinite(windowDays) ? windowDays : undefined,
  });
  console.log(JSON.stringify({ candidate }, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
