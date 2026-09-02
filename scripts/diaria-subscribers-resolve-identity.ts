#!/usr/bin/env node
/**
 * diaria-subscribers-resolve-identity.ts — CLI do #6464 fatia 5 (#6589).
 *
 * Roda a resolução de identidade cross-plataforma determinística
 * (`resolveIdentitiesByEmail`) e imprime o relatório de não-casados
 * (`buildUnmatchedReport`) sobre o store unificado
 * (`scripts/lib/diaria-subscribers-db.ts`). Miolo puro em
 * `scripts/lib/diaria-subscribers-identity-resolve.ts` — este arquivo é só
 * I/O (abre o DB, chama as duas funções, imprime JSON), mesmo papel que
 * `diaria-subscribers-build-db.ts` cumpre pro bootstrap de schema.
 *
 * Rodar DEPOIS de qualquer ingestão por plataforma (`diaria-subscribers-
 * ingest-kit.ts`, `diaria-subscribers-ingest-brevo.ts`, e futuramente
 * Beehiiv) — idempotente, seguro repetir a cada execução.
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-resolve-identity.ts [--db <path>]
 *
 * Stdout: JSON com o resumo da resolução (quantos subscribers foram
 * fundidos) + o relatório de não-casados por plataforma. Exit 1 com
 * mensagem clara se `data/` ou o arquivo do store ainda não existirem, em
 * vez do erro nativo opaco de `new DatabaseSync()`.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import {
  resolveIdentitiesByEmail,
  buildUnmatchedReport,
} from "./lib/diaria-subscribers-identity-resolve.ts";

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir); // data/

  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot}`);
    console.error(
      "   (data/ mora no OneDrive como junction — ver CLAUDE.md setup, passo 2b)",
    );
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbPath)) {
    console.error(`❌ store ainda não existe: ${dbPath}`);
    console.error(
      "   (rode a ingestão de alguma plataforma primeiro — diaria-subscribers-ingest-kit.ts / -brevo.ts)",
    );
    process.exitCode = 1;
    return;
  }

  const db = openDiariaSubscribersDb(dbPath);
  const now = new Date().toISOString();
  const resolution = resolveIdentitiesByEmail(db, now);
  const report = buildUnmatchedReport(db, now);
  db.close();

  console.log(
    JSON.stringify(
      {
        db: dbPath,
        resolution,
        report,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
