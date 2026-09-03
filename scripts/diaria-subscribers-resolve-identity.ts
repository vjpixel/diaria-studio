#!/usr/bin/env node
/**
 * diaria-subscribers-resolve-identity.ts — CLI do #6464 fatia 5 (#6589),
 * endurecido por #7205 (fatia 10 do épico #7163).
 *
 * Roda a resolução de identidade cross-plataforma determinística
 * (`resolveIdentitiesByEmail`) e imprime o relatório de não-casados
 * (`buildUnmatchedReport`) sobre o store unificado
 * (`scripts/lib/diaria-subscribers-db.ts`). Miolo puro em
 * `scripts/lib/diaria-subscribers-identity-resolve.ts` — este arquivo é só
 * I/O (abre o DB, chama as funções, imprime JSON), mesmo papel que
 * `diaria-subscribers-build-db.ts` cumpre pro bootstrap de schema.
 *
 * ## `--dry-run` por padrão (#7205)
 *
 * A operação é DESTRUTIVA e NÃO REVERSÍVEL: `UPDATE subscriber_id` em
 * `identity_alias`/`event`, `DELETE` de `subscription` perdedora em
 * conflito `UNIQUE(subscriber_id, platform)`, `DELETE` do `subscriber`
 * perdedor. Sem `--apply`, este CLI **nunca escreve** — imprime só o PLANO
 * (`planIdentityMerges`, o que fundiria) + o relatório de não-casados no
 * estado ATUAL (pré-merge).
 *
 * Com `--apply`:
 *   1. Conta `identity_alias`/`event` ANTES (`getStoreCounts`).
 *   2. Faz backup do `.db` (`backupStoreFile`) — arquivo
 *      `{dbPath}.backup-{timestamp}` ao lado do original.
 *   3. Roda o merge de verdade (`resolveIdentitiesByEmail`).
 *   4. Conta de novo DEPOIS e roda o guard de conservação
 *      (`checkMergeConservation`) — a soma de aliases e de eventos tem que
 *      bater antes/depois (fusão MOVE linha, nunca perde). Se o guard
 *      falhar, `exitCode = 1` e o motivo vai pro stderr — o backup do passo
 *      2 é a rede de segurança pra restaurar manualmente.
 *
 * Rodar DEPOIS de qualquer ingestão por plataforma (Kit/Brevo/Beehiiv) —
 * idempotente, seguro repetir a cada execução (rodar 2x sem novo dado entre
 * elas não gera merge novo).
 *
 * **A execução `--apply` contra o store REAL de produção é decisão do
 * editor, não deste CLI** — não é chamado com `--apply` automaticamente por
 * nenhuma skill/pipeline; quem decide rodar de verdade roda manualmente.
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-resolve-identity.ts [--db <path>] [--apply]
 *
 * Stdout: JSON. Em dry-run (default): `{ mode: "dry-run", plan,
 * report_before_merge }`. Em `--apply`: `{ mode: "apply", backup,
 * resolution, report, conservation }`. Exit 1 com mensagem clara se `data/`
 * ou o arquivo do store ainda não existirem, em vez do erro nativo opaco de
 * `new DatabaseSync()`.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { DEFAULT_DB_PATH, getStoreCounts, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import {
  resolveIdentitiesByEmail,
  buildUnmatchedReport,
  planIdentityMerges,
  backupStoreFile,
  checkMergeConservation,
} from "./lib/diaria-subscribers-identity-resolve.ts";

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const apply = hasFlag(argv, "apply");
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

  const now = new Date().toISOString();

  if (!apply) {
    const db = openDiariaSubscribersDb(dbPath);
    const plan = planIdentityMerges(db, now);
    const report_before_merge = buildUnmatchedReport(db, now);
    db.close();

    console.log(
      JSON.stringify(
        {
          db: dbPath,
          mode: "dry-run",
          plan,
          report_before_merge,
          note:
            "Nenhuma escrita foi feita. Rode com --apply para fundir de verdade " +
            "(faz backup automático do .db antes de escrever).",
        },
        null,
        2,
      ),
    );
    return;
  }

  // --apply: escreve de verdade. Conta antes, faz backup, funde, conta
  // depois, roda o guard de conservação — nessa ordem, sempre.
  const readDb = openDiariaSubscribersDb(dbPath);
  const before = getStoreCounts(readDb);
  readDb.close();

  const backup = backupStoreFile(dbPath, now);

  const db = openDiariaSubscribersDb(dbPath);
  const resolution = resolveIdentitiesByEmail(db, now);
  const report = buildUnmatchedReport(db, now);
  const after = getStoreCounts(db);
  db.close();

  const conservation = checkMergeConservation(
    { identity_aliases: before.identity_aliases, events: before.events },
    { identity_aliases: after.identity_aliases, events: after.events },
  );

  if (!conservation.ok) {
    console.error(
      `❌ guard de conservação falhou — aliases ${conservation.identity_aliases_before}→` +
        `${conservation.identity_aliases_after}, events ${conservation.events_before}→` +
        `${conservation.events_after}. O store JÁ FOI ESCRITO; restaure a partir do backup ` +
        `em ${backup} se este resultado não for esperado.`,
    );
    process.exitCode = 1;
  }

  console.log(
    JSON.stringify(
      {
        db: dbPath,
        mode: "apply",
        backup,
        resolution,
        report,
        conservation,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
