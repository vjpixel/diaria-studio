#!/usr/bin/env node
/**
 * diaria-subscribers-ingest-kit-webhooks.ts (#10648)
 *
 * Puxa os eventos de webhook do Kit (cancelamento, clique, bounce,
 * reclamação, ativação, com horário) gravados pelo Worker `kit-events` e
 * grava em `kit_webhook_event` no `diaria-subscribers-db`. Incremental: pede
 * só o que chegou depois do último evento ingerido (com margem, ver
 * `KIT_WEBHOOK_SINCE_SAFETY_MS`); com a tabela vazia, pede tudo.
 *
 * Só lê o NOSSO Worker — nenhuma chamada ao Kit.
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-ingest-kit-webhooks.ts [--write] [--since ISO] [--all] [--db PATH]
 *
 * Sem `--write` só lê o Worker e imprime a contagem (dry-run), mesma convenção
 * de `diaria-subscribers-ingest-kit.ts`: só a task agendada passa `--write`, o
 * que mantém um escritor único no banco (#10746). `--dry-run` segue aceito.
 *
 * Config (.env): `KIT_EVENTS_URL` (base do Worker, ex.
 * https://kit-events.<conta>.workers.dev) e `KIT_EVENTS_READ_TOKEN` (mesmo
 * valor do secret `EVENTS_READ_TOKEN` do Worker). O canal está ligado desde
 * 21/10/2026: sem os dois, `--write` (a task agendada) sai 1 para o alarme de
 * units falhas avisar (#10788); o dry-run manual só avisa e sai 0.
 *
 * Leitura de 1 pessoa: `findSubscriberIdsByEmail` +
 * `getKitWebhookEventsForSubscriber` (diaria-subscribers-db.ts).
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import { detectSiblingConflictFiles } from "./diaria-subscribers-ingest-kit.ts";
import {
  fetchKitWebhookEvents,
  incrementalSinceFromDb,
  ingestKitWebhookEvents,
} from "./lib/kit-webhook-events-ingest.ts";

export async function main(
  argv: string[] = process.argv.slice(2),
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (env === process.env) loadProjectEnv();
  const baseUrl = (env.KIT_EVENTS_URL ?? "").trim();
  const token = (env.KIT_EVENTS_READ_TOKEN ?? "").trim();
  const shouldWrite = hasFlag(argv, "write") && !hasFlag(argv, "dry-run");
  if (!baseUrl || !token) {
    const missing = [!baseUrl && "KIT_EVENTS_URL", !token && "KIT_EVENTS_READ_TOKEN"].filter(Boolean).join(", ");
    // #10788: o canal está ligado desde 21/10/2026 e a task agendada é o
    // único caller com `--write`. Ali, var ausente é regressão de config
    // (`sync-env` com vault incompleto, máquina nova): sair 0 deixava o passo
    // no-op todo dia sem alarme, com os eventos acumulando no KV sem TTL.
    // Exit 1 deixa a unit failed e o alarme de units falhas avisa. Rodada
    // manual sem `--write` (clone novo, sessão sem .env) segue só avisando.
    if (shouldWrite) {
      console.error(
        `❌ ${missing} ausente(s) no ambiente — o canal kit-events está ligado (workers/kit-events/README.md), então a ingestão com --write não pode virar no-op. Rodar \`npm run sync-env\` ou conferir o .env.`,
      );
      return 1;
    }
    console.error(`⚠️  ${missing} ausente(s) — dry-run sem leitura do Worker kit-events. Nada a fazer.`);
    return 0;
  }

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const dbDir = dirname(dbPath);
  if (!existsSync(dirname(dbDir))) {
    console.error(`❌ data/ não existe: ${dirname(dbDir)} (ver docs/setup.md)`);
    return 1;
  }
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  // Escritor único (#10746): cópia de conflito do OneDrive ao lado do banco
  // indica que outra máquina gravou nele. Mesmo guard do roster.
  if (shouldWrite) {
    const conflicts = detectSiblingConflictFiles(readdirSync(dbDir), basename(dbPath));
    if (conflicts.length > 0) {
      console.error(`❌ cópias de conflito do OneDrive em ${dbDir}: ${conflicts.join(", ")} — abortando a escrita (escritor único).`);
      return 1;
    }
  }

  const db = openDiariaSubscribersDb(dbPath);
  try {
    const explicitSince = getArg(argv, "since");
    if (explicitSince && Number.isNaN(Date.parse(explicitSince))) {
      console.error(`❌ --since inválido: ${explicitSince}`);
      return 1;
    }
    const since = hasFlag(argv, "all") ? null : explicitSince || incrementalSinceFromDb(db);
    const fetched = await fetchKitWebhookEvents(baseUrl, token, since, fetchImpl);
    if (!fetched.ok) {
      console.error(`❌ leitura do Worker kit-events falhou: ${fetched.error}`);
      return 1;
    }
    if (fetched.malformed > 0) {
      console.error(`⚠️  ${fetched.malformed} evento(s) fora do contrato ignorado(s).`);
    }
    if (!shouldWrite) {
      console.log(JSON.stringify({ since, fetched: fetched.events.length, dry_run: true }));
      return 0;
    }
    const result = ingestKitWebhookEvents(db, fetched.events);
    console.log(
      JSON.stringify({
        since,
        fetched: fetched.events.length,
        new_events: result.newEvents,
        already_known: result.alreadyKnown,
        retry_duplicates: result.retryDuplicates,
      }),
    );
    return 0;
  } finally {
    db.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`❌ ${(err as Error).stack ?? err}`);
      process.exitCode = 1;
    },
  );
}
