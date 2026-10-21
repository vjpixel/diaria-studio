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
 *   npx tsx scripts/diaria-subscribers-ingest-kit-webhooks.ts [--since ISO] [--all] [--dry-run] [--db PATH]
 *
 * Config (.env): `KIT_EVENTS_URL` (base do Worker, ex.
 * https://kit-events.<conta>.workers.dev) e `KIT_EVENTS_READ_TOKEN` (mesmo
 * valor do secret `EVENTS_READ_TOKEN` do Worker). Sem os dois, sai 0 com
 * aviso: o canal ainda não foi ligado (ver workers/kit-events/README.md), o
 * que não é falha desta execução.
 *
 * Leitura de 1 pessoa: `findSubscriberIdsByEmail` +
 * `getKitWebhookEventsForSubscriber` (diaria-subscribers-db.ts).
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
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
  if (!baseUrl || !token) {
    console.error(
      "ℹ️  KIT_EVENTS_URL/KIT_EVENTS_READ_TOKEN ausentes — Worker kit-events ainda não ligado (workers/kit-events/README.md). Nada a fazer.",
    );
    return 0;
  }

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const dbDir = dirname(dbPath);
  if (!existsSync(dirname(dbDir))) {
    console.error(`❌ data/ não existe: ${dirname(dbDir)} (ver docs/setup.md)`);
    return 1;
  }
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

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
    if (hasFlag(argv, "dry-run")) {
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
