#!/usr/bin/env node
/**
 * scripts/subscriber-state-snapshot.ts (#8552)
 *
 * Camada de I/O sobre `scripts/lib/subscriber-state-snapshot.ts` (miolo
 * puro) — grava o snapshot diário `(id, state, created_at)` (+ `confirmou_via`
 * e `origem`, opcionais, lidos de `fields`) do roster Kit
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
 *   --out-root diretório das observações do modo --recent (default: data/subscriber-state-snapshots/kit-recent).
 *   --recent   modo HORÁRIO (#8552 b): só os assinantes criados nas últimas
 *              48h (`created_after` = 3 dias atrás, filtro fino no cliente),
 *              gravados em data/subscriber-state-snapshots/kit-recent/
 *              {AAAA-MM-DDTHHMMZ}.jsonl — insumo da taxa de confirmação em
 *              1h/6h/24h (`scripts/lib/subscriber-hourly-confirmation.ts`).
 *
 * (O modo --recent NÃO lê o form DOI: status=all do form pode devolver a base
 * inteira a cada hora, e a análise horária não usa `doi_form`.)
 * Cruzamento com o form DOI (#8552 a), só no snapshot DIÁRIO: se `platform.config.json` →
 * `kit.doiFormId` existe, o snapshot marca `doi_form: true` em quem está
 * vinculado ao form (`GET /v4/forms/{id}/subscribers?status=all`, só leitura);
 * falha nessa leitura degrada (snapshot sai sem a marca), nunca aborta.
 *
 * Requer `KIT_API_KEY` no env (`loadKitConfig`, mesmo fail-fast do resto da
 * camada Kit). Stdout: JSON summary. Stderr: progresso.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadKitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers, listAllFormSubscribers } from "./lib/kit-subscribers.ts";
import { listSubscribers } from "./lib/kit-client.ts";
import {
  hourlyObservationFileName,
  filterRecent,
  RECENT_LOOKBACK_HOURS,
} from "./lib/subscriber-hourly-confirmation.ts";
import {
  snapshotRootDefault,
  snapshotJsonlPath,
  serializeSubscriberStateRecords,
  toSubscriberStateRecord,
  summarizeFieldCoverage,
  listSubscriberStateSnapshotDates,
  readSubscriberStateSnapshotFile,
  markDoiFormMembership,
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

function readDoiFormId(): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as { kit?: { doiFormId?: string } };
    return cfg.kit?.doiFormId || undefined;
  } catch {
    return undefined;
  }
}

async function doiFormIds(config: ReturnType<typeof loadKitConfig>): Promise<Set<number> | null> {
  const formId = readDoiFormId();
  if (!formId) {
    console.error(`${LOG_PREFIX} kit.doiFormId ausente — snapshot sem participação no form DOI.`);
    return null;
  }
  try {
    const subs = await listAllFormSubscribers(formId, config, { status: "all" });
    console.error(`${LOG_PREFIX} form DOI ${formId}: ${subs.length} assinante(s) vinculado(s).`);
    return new Set(subs.map((s) => s.id));
  } catch (err) {
    console.error(`${LOG_PREFIX} AVISO: falha lendo o form DOI ${formId} (${(err as Error).message}) — snapshot sem doi_form.`);
    return null;
  }
}

/** Modo horário (#8552 b): só cadastros das últimas 48h. */
async function runRecent(config: ReturnType<typeof loadKitConfig>, isDryRun: boolean, rootArg: string | undefined): Promise<void> {
  const now = new Date();
  const createdAfter = new Date(now.getTime() - 72 * 3_600_000).toISOString().slice(0, 10);
  const all: SubscriberStateRecord[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await listSubscribers({ createdAfter, status: "all", perPage: 500, after, config });
    all.push(...page.subscribers.map(toSubscriberStateRecord));
    if (!page.pagination.has_next_page) break;
    if (!page.pagination.end_cursor) throw new Error("paginação sem end_cursor — lista truncada, abortando");
    after = page.pagination.end_cursor;
  }
  const records = filterRecent(all, now, RECENT_LOOKBACK_HOURS);
  // Sem leitura do form aqui (custo): status=all do form pode ser a base
  // inteira a cada hora; a analise horaria nao usa doi_form.
  const out = records;
  const root = rootArg || resolve(DATA_DIR, "subscriber-state-snapshots", "kit-recent");
  const file = resolve(root, hourlyObservationFileName(now));
  if (!isDryRun) {
    mkdirSync(root, { recursive: true });
    writeFileAtomic(file, serializeSubscriberStateRecords(out));
    console.error(`${LOG_PREFIX} observação horária gravada (${out.length} linha(s)) em ${file}`);
  } else {
    console.error(`${LOG_PREFIX} --dry-run: observação horária NÃO gravada (${out.length} linha(s)).`);
  }
  console.log(JSON.stringify({ mode: "recent", written: !isDryRun, count: out.length, file }, null, 2));
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const date = getArg(argv, "date") || todayBrtDayKey();
  const root = getArg(argv, "root") || snapshotRootDefault(DATA_DIR);
  const isDryRun = hasFlag(argv, "dry-run");

  const config = loadKitConfig(LOG_PREFIX);
  if (hasFlag(argv, "recent")) {
    await runRecent(config, isDryRun, getArg(argv, "out-root"));
    return;
  }

  console.error(`${LOG_PREFIX} listando roster Kit completo (status=all)...`);
  const subscribers = await listAllKitSubscribers(config, { status: "all" });
  const formIds = await doiFormIds(config);
  const doiStatus = formIds ? { ok: true, count: formIds.size } : { ok: false };
  const base: SubscriberStateRecord[] = subscribers.map(toSubscriberStateRecord);
  const records = formIds ? markDoiFormMembership(base, formIds) : base;
  console.error(`${LOG_PREFIX} ${records.length} assinante(s) no roster.`);
  const cov = summarizeFieldCoverage(subscribers, records);
  console.error(
    `${LOG_PREFIX} cobertura: fields presente em ${cov.comFields}/${cov.total}, origem ${cov.comOrigem}, confirmou_via ${cov.comConfirmouVia}.`,
  );
  if (cov.total > 0 && cov.comFields === 0) {
    console.error(
      `${LOG_PREFIX} AVISO: 'fields' ausente em TODOS os assinantes da lista — origem/confirmou_via ficarão vazios neste snapshot (relatório por canal/via degrada).`,
    );
  }

  const existingDates = listSubscriberStateSnapshotDates(root).filter((d) => d < date);
  const previousDate = existingDates.length > 0 ? existingDates[existingDates.length - 1] : null;
  const previousRecords = previousDate ? readSubscriberStateSnapshotFile(root, previousDate) : [];
  const transitions = diffSubscriberStateSnapshots(previousRecords, records);
  const newlyActive = newlyActiveSince(transitions);

  if (!isDryRun) {
    const dirPath = dirname(snapshotJsonlPath(root, date));
    mkdirSync(dirPath, { recursive: true });
    writeFileAtomic(snapshotJsonlPath(root, date), serializeSubscriberStateRecords(records));
    writeFileAtomic(resolve(dirPath, "doi-form-status.json"), JSON.stringify(doiStatus) + "\n");
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
