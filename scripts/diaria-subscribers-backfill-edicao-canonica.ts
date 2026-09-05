#!/usr/bin/env node
/**
 * diaria-subscribers-backfill-edicao-canonica.ts (#7204, fatia 9 do épico
 * #7163 — follow-up pós-#7249).
 *
 * Popula `event.edicao_canonica` (coluna adicionada em
 * `diaria-subscribers-db.ts` via `EVENT_MIGRATION_COLUMNS`) a partir do
 * timestamp JÁ GRAVADO no `event` — nunca chama nenhuma API, nunca reingere
 * nada (`backfillCanonicalEdicaoColumn`, `diaria-subscribers-edicao-
 * canonica.ts`). Só um `UPDATE` por `(platform, edicao)` resolvido pelo mapa
 * canônico (MIN(ts) entre `delivered`/`sent` do grupo) — mesmo miolo que
 * `summarizeStoreLeitoresCanonicalDedup` já usa em memória, agora também
 * persistido em coluna pra permitir `COUNT(DISTINCT edicao_canonica)` direto
 * em SQL sem depender de recomputar o mapa em TS toda vez.
 *
 * ## `--dry-run` por padrão (mesmo padrão de `diaria-subscribers-resolve-
 * identity.ts`, #7205)
 *
 * A operação em si é aditiva/corretiva (só `UPDATE` de 1 coluna, nunca
 * `INSERT`/`DELETE`) — mas ainda assim segue a mesma disciplina de backup +
 * guard de conservação de qualquer escrita real contra o store de produção:
 *
 *   - Sem `--apply`: só relata quantos grupos o mapa canônico resolve e
 *     quantas linhas SERIAM atualizadas (roda `backfillCanonicalEdicaoColumn`
 *     contra uma CÓPIA em memória do estado atual — nunca escreve no `.db`
 *     real).
 *   - Com `--apply`: conta linhas de `event` ANTES → backup (`backupStoreFile`,
 *     `{dbPath}.backup-{timestamp}`) → roda o backfill de verdade → conta
 *     DEPOIS → guard de conservação (`COUNT(*)` de `event` tem que bater
 *     antes/depois — um backfill de coluna NUNCA insere/apaga linha; se
 *     divergir, é sinal de bug grave, `exitCode = 1` com o caminho do backup
 *     pra restaurar).
 *
 * Idempotente — rodar 2x sem evento novo entre as execuções atualiza 0
 * linhas na 2ª. Seguro rodar repetidamente após qualquer ingestão
 * (Kit/Brevo/Beehiiv) — é exatamente isso que os 3 CLIs de ingestão passam a
 * fazer automaticamente como último passo (fail-soft: falha no backfill
 * nunca aborta a ingestão que já rodou).
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-backfill-edicao-canonica.ts [--db <path>] [--apply]
 *
 * Stdout: JSON. Dry-run: `{ mode: "dry-run", groups_resolved, rows_would_update,
 * distinct_edicao_before, distinct_edicao_canonica_would_be }`. Apply:
 * `{ mode: "apply", backup, groups_resolved, rows_updated, events_before,
 * events_after, conservation, distinct_edicao_before, distinct_edicao_canonica_after }`.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import { backfillCanonicalEdicaoColumn } from "./lib/diaria-subscribers-edicao-canonica.ts";
import { backupStoreFile } from "./lib/diaria-subscribers-identity-resolve.ts";

/** `COUNT(DISTINCT platform || '::' || edicao)` — mesma dupla contagem que
 *  motivou a issue, medida direto em SQL pra reportar antes/depois. */
function countDistinctNativeEdicao(db: DatabaseSync): number {
  return (
    db
      .prepare(
        `SELECT COUNT(DISTINCT platform || '::' || edicao) AS n FROM event WHERE edicao IS NOT NULL AND edicao != ''`,
      )
      .get() as { n: number }
  ).n;
}

/** `COUNT(DISTINCT COALESCE(edicao_canonica, platform || '::' || edicao))` —
 *  o número que `edicao_canonica` (depois de backfilled) permite calcular
 *  direto em SQL: pares resolvidos colapsam pra 1 chave por AAMMDD; pares
 *  ainda não resolvidos (sem delivered/sent) caem no fallback nativo, nunca
 *  fundidos por acidente. */
function countDistinctCanonicalOrFallback(db: DatabaseSync): number {
  return (
    db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(edicao_canonica, platform || '::' || edicao)) AS n
         FROM event WHERE edicao IS NOT NULL AND edicao != ''`,
      )
      .get() as { n: number }
  ).n;
}

function countEvents(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM event").get() as { n: number }).n;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const apply = hasFlag(argv, "apply");
  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir); // data/

  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot}`);
    console.error("   (data/ mora no OneDrive como junction — ver CLAUDE.md setup, passo 2b)");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbPath)) {
    console.error(`❌ store ainda não existe: ${dbPath}`);
    console.error("   (rode a ingestão de alguma plataforma primeiro — diaria-subscribers-ingest-kit.ts / -brevo.ts / -beehiiv.ts)");
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();

  if (!apply) {
    // Dry-run: abre o `.db` real (leitura), mas SQLite não tem transação
    // implícita — rodar o backfill de verdade e depois fazer ROLLBACK é o
    // jeito de medir "quantas linhas seriam atualizadas" sem persistir nada,
    // sem duplicar a query do backfill num modo "só contar".
    const db = openDiariaSubscribersDb(dbPath);
    const distinctBefore = countDistinctNativeEdicao(db);
    db.exec("BEGIN");
    const result = backfillCanonicalEdicaoColumn(db);
    const distinctWouldBe = countDistinctCanonicalOrFallback(db);
    db.exec("ROLLBACK");
    db.close();

    console.log(
      JSON.stringify(
        {
          db: dbPath,
          mode: "dry-run",
          groups_resolved: result.groupsResolved,
          rows_would_update: result.rowsUpdated,
          distinct_edicao_before: distinctBefore,
          distinct_edicao_canonica_would_be: distinctWouldBe,
          note:
            "Nenhuma escrita foi feita (ROLLBACK). Rode com --apply para gravar de verdade " +
            "(faz backup automático do .db antes de escrever).",
        },
        null,
        2,
      ),
    );
    return;
  }

  // --apply: conta antes, backup, roda de verdade, conta depois, guard de
  // conservação — mesma ordem de diaria-subscribers-resolve-identity.ts.
  const readDb = openDiariaSubscribersDb(dbPath);
  const eventsBefore = countEvents(readDb);
  const distinctBefore = countDistinctNativeEdicao(readDb);
  readDb.close();

  const backup = backupStoreFile(dbPath, now);

  const db = openDiariaSubscribersDb(dbPath);
  const result = backfillCanonicalEdicaoColumn(db);
  const eventsAfter = countEvents(db);
  const distinctCanonicalAfter = countDistinctCanonicalOrFallback(db);
  db.close();

  const conservation = {
    ok: eventsBefore === eventsAfter,
    events_before: eventsBefore,
    events_after: eventsAfter,
  };

  if (!conservation.ok) {
    console.error(
      `❌ guard de conservação falhou — event ${eventsBefore}→${eventsAfter} (um backfill de coluna NUNCA ` +
        `deveria inserir/apagar linha). O store JÁ FOI ESCRITO; restaure a partir do backup em ${backup} ` +
        `se este resultado não for esperado.`,
    );
    process.exitCode = 1;
  }

  console.log(
    JSON.stringify(
      {
        db: dbPath,
        mode: "apply",
        backup,
        groups_resolved: result.groupsResolved,
        rows_updated: result.rowsUpdated,
        distinct_edicao_before: distinctBefore,
        distinct_edicao_canonica_after: distinctCanonicalAfter,
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
