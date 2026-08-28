#!/usr/bin/env node
/**
 * diaria-subscribers-build-db.ts — bootstrap/CLI do store histórico
 * centrado no assinante (#6464 fatia 2 — #6585).
 *
 * Esta issue entrega o ESQUEMA + as primitivas idempotentes
 * (`scripts/lib/diaria-subscribers-db.ts`) que os builders POR PLATAFORMA
 * vão consumir — ingestão real do Kit (fatia 3) e do Brevo (fatia 4) ainda
 * não existe aqui, de propósito (fora do escopo desta issue; as duas fatias
 * rodam em ordem indeterminada e escrevem no MESMO store via as mesmas
 * primitivas: `ensureSubscriber`/`upsertSubscription`/`recordEvent`).
 *
 * Rodar este script hoje garante/migra o schema e imprime um summary de
 * contagens (útil pra confirmar que o store está pronto pras fatias
 * seguintes escreverem nele) — mesmo papel de bootstrap que
 * `clarice-db-summary.ts` cumpre pro `clarice-users.db`, sem o passo de
 * ingestão (que aqui ainda não existe).
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-build-db.ts [--db <path>]
 *
 * Stdout: JSON summary. Exit 1 com mensagem clara se `data/` (a junction do
 * OneDrive) não existir — mesmo padrão de `clarice-build-db.ts` — em vez do
 * erro nativo opaco de `new DatabaseSync()` num diretório inexistente.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import {
  DEFAULT_DB_PATH,
  getStoreCounts,
  openDiariaSubscribersDb,
} from "./lib/diaria-subscribers-db.ts";

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir); // data/

  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot}`);
    console.error(
      "   (data/ mora no OneDrive como junction — ver CLAUDE.md setup, passo 2b)",
    );
    process.exit(1);
  }
  // data/diaria-subscribers/ pode não existir ainda mesmo com data/
  // presente (1ª execução) — este subdiretório é NOVO e específico deste
  // store, então criá-lo aqui é seguro (diferente de data/ em si, que é a
  // junction e nunca deve ser criada por um script).
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const db = openDiariaSubscribersDb(dbPath);
  const counts = getStoreCounts(db);
  db.close();

  const payload = {
    generated_at: new Date().toISOString(),
    db_path: dbPath,
    ...counts,
  };
  console.log(JSON.stringify(payload, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
