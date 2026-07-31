#!/usr/bin/env node
/**
 * clarice-check-derived-stale.ts (#4347 Etapa 4, Passo 0)
 *
 * Wrapper CLI fino sobre `isDerivedStale` (scripts/lib/clarice-db.ts) — até
 * aqui só era consultado inline (abort em `clarice-build-segment.ts --group
 * engajados`, #4205; warning não-fatal em `clarice-build-waves-store.ts`). A
 * skill `/diaria-clarice-novos` precisa checar o MESMO sinal no
 * preflight (Passo 0) ANTES de gastar Stripe/MV/tempo montando uma rodada
 * sobre um store cujos campos derivados (`send_eligible`/`priority_points`)
 * podem estar desatualizados em relação ao último sync do Brevo.
 *
 * Uso:
 *   npx tsx scripts/clarice-check-derived-stale.ts [--db path]
 *   # imprime "stale" ou "fresh" em stdout (exit 0 sempre — mesmo padrão de
 *   # exec-mode.ts/studio-chat-enabled.ts: o CALLER decide o que fazer)
 */
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { openClariceDb, isDerivedStale, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";

export function checkDerivedStale(dbPath: string = DEFAULT_DB_PATH): "stale" | "fresh" {
  const db = openClariceDb(dbPath);
  try {
    return isDerivedStale(db) ? "stale" : "fresh";
  } finally {
    db.close();
  }
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  console.log(checkDerivedStale(dbPath));
}

if (isMainModule(import.meta.url)) {
  main();
}
