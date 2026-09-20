#!/usr/bin/env npx tsx
/**
 * scripts/upload-google-ads-confirmations.ts (#8555)
 *
 * Lote diário: detecta confirmações (DOI) novas no Kit e sobe pro Google Ads
 * como Enhanced Conversion for Leads numa ação de conversão de CONFIRMAÇÃO
 * (`UPLOAD_CLICKS`, secundária). Miolo em
 * `scripts/lib/google-ads-confirmation-batch.ts` (ver a docstring de lá pra
 * critério de detecção, gclid/hash, janela de 90 dias e idempotência).
 *
 * ## Pré-requisito (ação do editor, NÃO feita por este script)
 *
 * Criar (ou reativar) a ação de conversão de CONFIRMAÇÃO no Google Ads:
 * tipo `UPLOAD_CLICKS`, categoria `SIGNUP`, SECUNDÁRIA (`primary_for_goal =
 * false`), distinta da `7754941100` (cadastro). A `7762768203` ("Assinatura
 * Confirmada (upload ECL - #7770)") existe `REMOVED` — recriar ou reativar.
 * O id resultante vai em `--conversion-action-id` ou em
 * `GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID` (Doppler). Sem default.
 *
 * ## Segurança
 *
 * `--dry-run` é o DEFAULT: só LÊ o roster do Kit e o snapshot local, imprime
 * o plano e o payload, e não faz chamada de escrita nenhuma (nem renova
 * token, nem toca o índice). Só `--send` envia de verdade; `--send --dry-run`
 * juntos = dry-run.
 *
 * Pré-condição de dado: precisa de pelo menos 1 snapshot de
 * `scripts/subscriber-state-snapshot.ts` dentro do lookback (default 7 dias,
 * `--lookback-days`). Sem base o script FALHA (exit 1) em vez de assumir
 * "ninguém confirmou".
 *
 * Uso:
 *   npx tsx scripts/upload-google-ads-confirmations.ts --conversion-action-id 123 --customer-id 2369219639
 *   npx tsx scripts/upload-google-ads-confirmations.ts --conversion-action-id 123 --customer-id 2369219639 --send
 *   [--dry-run] [--lookback-days 7] [--snapshot-root <dir>] [--index <path>]
 *
 * Env (`--send`): GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
 *   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_DEVELOPER_TOKEN,
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CUSTOMER_ID (ou --customer-id).
 *   Sempre: KIT_API_KEY (leitura do roster).
 * Stdout: JSON do resumo. Stderr: progresso. Exit 0 ok, 1 erro.
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
import { resolveActionResourceName, sendConversionPayload } from "./lib/google-ads-conversion-sender.ts";
import {
  DEFAULT_LOOKBACK_DAYS,
  pickBaseSnapshotDate,
  runConfirmationBatch,
} from "./lib/google-ads-confirmation-batch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[google-ads-confirmations]";
const DEFAULT_INDEX_PATH = resolve(ROOT, "data/google-ads/_confirmation-conversions-sent.json");
/** Placeholder só usado em dry-run sem id de ação (nunca chega à API). */
const DRY_RUN_PLACEHOLDER_ACTION = "customers/0/conversionActions/PENDENTE-CRIAR-ACAO-DE-CONFIRMACAO";

function todayBrtDayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

export async function main(argv: string[] = process.argv.slice(2), fetchFn: typeof fetch = fetch): Promise<number> {
  loadProjectEnv(ROOT);

  const send = hasFlag(argv, "send") && !hasFlag(argv, "dry-run");
  const dryRun = !send;
  const lookbackDays = getIntArg(argv, "lookback-days", { min: 1 }) ?? DEFAULT_LOOKBACK_DAYS;
  const snapshotRoot = getStringArg(argv, "snapshot-root") ?? snapshotRootDefault(resolve(ROOT, "data"));
  const indexPath = getStringArg(argv, "index") ?? DEFAULT_INDEX_PATH;
  const customerId = getStringArg(argv, "customer-id") ?? process.env.GOOGLE_ADS_CUSTOMER_ID;
  const actionId =
    getStringArg(argv, "conversion-action-id") ?? process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID;

  let conversionActionResourceName = DRY_RUN_PLACEHOLDER_ACTION;
  if (actionId) {
    const resolved = resolveActionResourceName(actionId, customerId);
    if (!resolved.ok) {
      console.error(`${LOG_PREFIX} ✖ ${resolved.error}`);
      return 1;
    }
    conversionActionResourceName = resolved.resourceName;
  } else if (send) {
    console.error(
      `${LOG_PREFIX} ✖ --send exige --conversion-action-id (ou GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID): a ação de ` +
        "CONFIRMAÇÃO (UPLOAD_CLICKS, secundária) ainda precisa ser criada pelo editor — NÃO reusar a de cadastro (7754941100).",
    );
    return 1;
  } else {
    console.error(`${LOG_PREFIX} ⚠ sem id da ação de confirmação — dry-run usa um placeholder no payload.`);
  }

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
  console.error(`${LOG_PREFIX} base = snapshot ${baseDate} (${baseSnapshot.length} linha(s)).`);

  const config = loadKitConfig(LOG_PREFIX);
  const roster = await listAllKitSubscribers(config, { status: "all" });
  console.error(`${LOG_PREFIX} roster Kit: ${roster.length} assinante(s).`);

  const summary = await runConfirmationBatch({
    roster,
    baseSnapshot,
    indexPath,
    conversionActionResourceName,
    dryRun,
    sendFn: (payload) => sendConversionPayload({ fetchFn, env: process.env, customerId, payload }),
  });

  console.log(JSON.stringify(summary, null, 2));
  if (dryRun) console.error(`${LOG_PREFIX} DRY-RUN — nada foi enviado. Rode com --send para enviar.`);
  return summary.error && summary.sent === 0 && summary.toSend > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`${LOG_PREFIX} ✖ erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
