#!/usr/bin/env node
/**
 * scripts/subscriber-state-snapshot.ts (#8552)
 *
 * Camada de I/O sobre `scripts/lib/subscriber-state-snapshot.ts` (miolo
 * puro) — grava o snapshot diário `(id, state, created_at)` do roster Kit
 * completo (`status: "all"`) em
 * `data/subscriber-state-snapshots/kit/{AAAA-MM-DD}/subscribers.jsonl`, e
 * imprime um resumo das transições de estado desde o snapshot anterior
 * (quem virou `active` — o insumo direto do escopo 1 da #8543).
 *
 * Guard de publicação (`context/overnight-dispatch-rules.md` item 1): este
 * script só LÊ o roster Kit (`listAllKitSubscribers`), nunca escreve nada
 * na conta Kit — não é um `publish-*`, escrita fica só em `data/` local.
 *
 * Uso:
 *   npx tsx scripts/subscriber-state-snapshot.ts [--date AAAA-MM-DD] [--root <path>] [--dry-run]
 *
 *   --date     data BRT do snapshot (default: hoje, BRT). Só pra reprocessar
 *              um dia perdido — nunca usar pra "consertar" um snapshot já
 *              gravado com dado errado (o arquivo do dia é sobrescrito).
 *   --root     diretório raiz dos snapshots (default: data/subscriber-state-snapshots/kit).
 *   --dry-run  lista o roster e imprime o resumo, mas NÃO grava nada em disco.
 *
 * Requer `KIT_API_KEY` no env (`loadKitConfig`, mesmo fail-fast do resto da
 * camada Kit). Stdout: JSON summary. Stderr: progresso.
 */

import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadKitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import { REATIVAR_CONFIRMOU_VIA_FIELD_NAME } from "./lib/shared/reativar-confirmou-via.ts";
import { KIT_ORIGEM_CADASTRO_FIELD_NAME } from "./lib/shared/kit-signup-origin.ts";
import {
  snapshotRootDefault,
  snapshotJsonlPath,
  serializeSubscriberStateRecords,
  listSubscriberStateSnapshotDates,
  readSubscriberStateSnapshotFile,
  diffSubscriberStateSnapshots,
  newlyActiveSince,
  type SubscriberStateRecord,
} from "./lib/subscriber-state-snapshot.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const LOG_PREFIX = "[subscriber-state-snapshot]";

/** Mesma fórmula de `brtDayKey` usada no resto do domínio — hoje em BRT. */
function todayBrtDayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

export interface SnapshotRunSummary {
  date: string;
  written: boolean;
  count: number;
  previousDate: string | null;
  newlyActiveCount: number;
  newlyActiveIds: number[];
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const date = getArg(argv, "date") || todayBrtDayKey();
  const root = getArg(argv, "root") || snapshotRootDefault(DATA_DIR);
  const isDryRun = hasFlag(argv, "dry-run");

  const config = loadKitConfig(LOG_PREFIX);

  console.error(`${LOG_PREFIX} listando roster Kit completo (status=all)...`);
  const subscribers = await listAllKitSubscribers(config, { status: "all" });
  const records: SubscriberStateRecord[] = subscribers.map((s) => {
    const rec: SubscriberStateRecord = { id: s.id, state: s.state, created_at: s.created_at };
    // #8552 — insumos do relatório de confirmação (só quando preenchidos).
    const via = s.fields?.[REATIVAR_CONFIRMOU_VIA_FIELD_NAME];
    const origem = s.fields?.[KIT_ORIGEM_CADASTRO_FIELD_NAME];
    if (via) rec.confirmou_via = via;
    if (origem) rec.origem = origem;
    return rec;
  });
  console.error(`${LOG_PREFIX} ${records.length} assinante(s) no roster.`);

  const existingDates = listSubscriberStateSnapshotDates(root).filter((d) => d < date);
  const previousDate = existingDates.length > 0 ? existingDates[existingDates.length - 1] : null;
  const previousRecords = previousDate ? readSubscriberStateSnapshotFile(root, previousDate) : [];
  const transitions = diffSubscriberStateSnapshots(previousRecords, records);
  const newlyActive = newlyActiveSince(transitions);

  if (!isDryRun) {
    const dirPath = dirname(snapshotJsonlPath(root, date));
    mkdirSync(dirPath, { recursive: true });
    writeFileAtomic(snapshotJsonlPath(root, date), serializeSubscriberStateRecords(records));
    console.error(`${LOG_PREFIX} snapshot de ${date} gravado (${records.length} linha(s)) em ${snapshotJsonlPath(root, date)}`);
  } else {
    console.error(`${LOG_PREFIX} --dry-run: snapshot NÃO gravado.`);
  }

  const summary: SnapshotRunSummary = {
    date,
    written: !isDryRun,
    count: records.length,
    previousDate,
    newlyActiveCount: newlyActive.length,
    newlyActiveIds: newlyActive.map((t) => t.id),
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`${LOG_PREFIX} erro fatal:`, err);
    process.exitCode = 1;
  });
}
