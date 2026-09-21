#!/usr/bin/env npx tsx
/**
 * scripts/meta-capi-confirmations-send.ts (#8543, lado Meta)
 *
 * Lote diário: detecta confirmações (DOI) novas no Kit e sobe pra Meta
 * Conversions API como evento SECUNDÁRIO (`SubscriptionConfirmed` por padrão,
 * nunca `CompleteRegistration`). Generaliza `scripts/meta-capi-batch-send.ts`
 * (#5504) — critério de detecção, click id/fbc, janela de 7 dias, índice e
 * decisões estão em `scripts/lib/meta-capi-confirmation-batch.ts`.
 *
 * `--dry-run` é o DEFAULT (só LÊ o roster do Kit e o snapshot local, imprime o
 * resumo). Só `--send` envia de verdade; sem `META_CAPI_ACCESS_TOKEN` o `--send`
 * vira dry-run efetivo. Precisa de snapshot de `subscriber-state-snapshot.ts`
 * dentro do lookback; sem base FALHA (exit 1).
 *
 * Uso:
 *   npx tsx scripts/meta-capi-confirmations-send.ts
 *   npx tsx scripts/meta-capi-confirmations-send.ts --send [--test-event-code CODE]
 *   [--event-name SubscriptionConfirmed] [--window-days 7] [--lookback-days 7]
 *   [--require-click-id] [--limit N] [--snapshot-root <dir>] [--index <path>]
 *
 * Env: KIT_API_KEY (roster), META_CAPI_ACCESS_TOKEN (só --send).
 * Stdout: JSON do resumo. Exit 0 ok, 1 erro/base ausente/falhas de envio.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadKitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import {
  snapshotRootDefault,
  listSubscriberStateSnapshotDates,
  readSubscriberStateSnapshotFile,
} from "./lib/subscriber-state-snapshot.ts";
import {
  DEFAULT_LOOKBACK_DAYS,
  assessBaseSnapshot,
  pickBaseSnapshotDate,
  type ConfirmationRosterEntry,
} from "./lib/google-ads-confirmation-batch.ts";
import {
  META_CONFIRMATION_DEFAULT_WINDOW_DAYS,
  runMetaConfirmationBatch,
  type MetaSendFn,
} from "./lib/meta-capi-confirmation-batch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[meta-capi-confirmations]";
export const DEFAULT_META_CONFIRMATION_INDEX_PATH = resolve(ROOT, "data/meta-capi/_confirmation-sent.json");

function todayBrtDayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

async function defaultListRoster(): Promise<ConfirmationRosterEntry[]> {
  return listAllKitSubscribers(loadKitConfig(LOG_PREFIX), { status: "all" });
}

export async function main(
  argv: string[] = process.argv.slice(2),
  listRoster: () => Promise<ConfirmationRosterEntry[]> = defaultListRoster,
  sendFn?: MetaSendFn,
): Promise<number> {
  loadProjectEnv(ROOT);
  const dryRun = !(hasFlag(argv, "send") && !hasFlag(argv, "dry-run"));
  const lookbackDays = getIntArg(argv, "lookback-days", { min: 1 }) ?? DEFAULT_LOOKBACK_DAYS;
  const windowDays = getIntArg(argv, "window-days", { min: 1 }) ?? META_CONFIRMATION_DEFAULT_WINDOW_DAYS;
  const limit = getIntArg(argv, "limit", { min: 0 });
  const snapshotRoot = getStringArg(argv, "snapshot-root") ?? snapshotRootDefault(resolve(ROOT, "data"));
  const indexPath = getStringArg(argv, "index") ?? DEFAULT_META_CONFIRMATION_INDEX_PATH;

  const todayKey = todayBrtDayKey();
  const baseDate = pickBaseSnapshotDate(listSubscriberStateSnapshotDates(snapshotRoot), todayKey, lookbackDays);
  if (!baseDate) {
    console.error(
      `${LOG_PREFIX} ✖ nenhum snapshot em ${snapshotRoot} dentro dos últimos ${lookbackDays} dia(s) antes de ${todayKey} — ` +
        "rode scripts/subscriber-state-snapshot.ts primeiro. Sem base não dá pra saber quem confirmou.",
    );
    return 1;
  }
  const baseSnapshot = readSubscriberStateSnapshotFile(snapshotRoot, baseDate);
  const roster = await listRoster();
  console.error(`${LOG_PREFIX} base = snapshot ${baseDate} (${baseSnapshot.length} linha(s)); roster Kit: ${roster.length}.`);
  const problem = assessBaseSnapshot(baseSnapshot.length, roster.length);
  if (problem) {
    console.error(`${LOG_PREFIX} ✖ ${problem} (${baseDate}) — abortando em vez de assumir "ninguém confirmou".`);
    return 1;
  }

  let summary;
  try {
    summary = await runMetaConfirmationBatch({
      roster,
      baseSnapshot,
      baseDate,
      indexPath,
      dryRun,
      eventName: getStringArg(argv, "event-name"),
      windowDays,
      requireClickId: hasFlag(argv, "require-click-id"),
      limit,
      testEventCode: getStringArg(argv, "test-event-code"),
      sendFn,
    });
  } catch (e) {
    console.error(`${LOG_PREFIX} ✖ ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (dryRun) console.error(`${LOG_PREFIX} DRY-RUN — nada foi enviado. Rode com --send para enviar.`);
  // #8616 item 1: `--send` sem token não pode "passar" em exit 0 — a task
  // agendada rodaria todo dia sem enviar nada e sem nenhum alarme disparar.
  if (!dryRun && summary.effectiveDryRun) {
    console.error(
      `${LOG_PREFIX} ✖ --send pedido mas META_CAPI_ACCESS_TOKEN ausente — rodou em dry-run efetivo, nada foi enviado. ` +
        "Tratando como falha (exit 1) para não mascarar isso numa task agendada.",
    );
    return 1;
  }
  return summary.failed > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`${LOG_PREFIX} ✖ erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
