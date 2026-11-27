/**
 * prune-reports-registry.ts (#4666)
 *
 * Ação de manutenção ONE-OFF, manual — reescreve somente o índice do host
 * local (`data/reports/index.{host}.jsonl`), removendo duplicatas por id e
 * linhas corrompidas. Ver `pruneReportsRegistry` em
 * `scripts/lib/reports-registry.ts` pra semântica exata e por que isto
 * NÃO precisa rodar em uso normal — a partir de #4666 `registerReport` já faz
 * upsert na escrita, então o arquivo nunca mais acumula uma duplicata nova.
 * Este script existe só pra limpar o histórico anterior ao fix (ex:
 * `clarice-novos-novos-260805`, o caso que abriu a issue).
 *
 * `local` — precisa do junction `data/` (OneDrive), não roda numa sessão
 * cloud/worktree fresco sem ele (idêntico a `pruneReportsRegistry`: registry
 * ausente é tratado como no-op, `ok: true` com tudo zerado, nunca erro).
 *
 * Uso: npx tsx scripts/prune-reports-registry.ts
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { pruneReportsRegistry } from "./lib/reports-registry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main(): void {
  const result = pruneReportsRegistry(ROOT);
  if (!result.ok) {
    console.error(`[prune-reports-registry] falha: ${result.error}`);
    process.exit(1);
  }
  console.log(
    `[prune-reports-registry] ${result.linesBefore} linha(s) -> ${result.linesAfter} linha(s) ` +
      `(${result.removedDuplicates} duplicata(s) removida(s), ${result.removedCorrupted} corrompida(s) removida(s); ` +
      `${result.remoteDuplicates} duplicata(s) em outros índices preservados)`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
