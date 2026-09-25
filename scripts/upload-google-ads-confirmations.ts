#!/usr/bin/env npx tsx
/**
 * scripts/upload-google-ads-confirmations.ts (#8555)
 *
 * Lote diário: detecta confirmações (DOI) novas no Kit e sobe pro Google Ads
 * como Enhanced Conversion for Leads numa ação de conversão de CONFIRMAÇÃO
 * (`UPLOAD_CLICKS`, secundária), via **Data Manager API**
 * (`POST events:ingest`, `scripts/lib/google-data-manager-sender.ts`). Miolo
 * de detecção em `scripts/lib/google-ads-confirmation-batch.ts` (ver a
 * docstring de lá pra critério de detecção, gclid/hash, janela de 90 dias e
 * idempotência).
 *
 * ## Migração pra Data Manager API (#8555, 24/09/2026)
 *
 * A conta `2369219639` recebe `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` no
 * caminho antigo (`ConversionUploadService.UploadClickConversions`) desde
 * 21/09/2026 — ver `scripts/lib/google-data-manager-sender.ts` pro achado ao
 * vivo completo e o payload verificado. Consequência prática: **este script
 * não usa mais `--customer-id` como parte de um resource name completo**
 * (`customers/X/conversionActions/Y`) — `--customer-id` vira o
 * `operatingAccount.accountId` do Data Manager, e `--conversion-action-id`
 * vira o `productDestinationId` (sempre o id NUMÉRICO da ação; se receber um
 * resource name completo, extrai o id de dentro dele). Também não exige mais
 * `GOOGLE_ADS_DEVELOPER_TOKEN`/`GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
 *
 * ## Ação de destino
 *
 * Tipo `UPLOAD_CLICKS`, categoria `SIGNUP`, SECUNDÁRIA (`primary_for_goal =
 * false`), distinta da ação de CADASTRO. Desde 20/09/2026 é a `7762768203`
 * ("Assinatura Confirmada (upload ECL - #7770)"), reativada de `REMOVED` —
 * o id vive na CONSTANTE TS `GOOGLE_ADS_CONFIRMATION_ACTION_ID`, exportada de
 * `scripts/lib/scheduled-tasks.ts`, e a task diária o passa em
 * `--conversion-action-id`. Este script não tem default.
 *
 * O argumento vence a variável de AMBIENTE `GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID`
 * (fallback pra execução manual); se as duas existirem e divergirem, avisa em
 * stderr em vez de escolher em silêncio. A ação de CADASTRO
 * (`PRIMARY_SIGNUP_ACTION_ID`) é RECUSADA por id: subir confirmação nela
 * contaria o mesmo assinante duas vezes na única meta primária.
 *
 * ## Segurança
 *
 * `--dry-run` é o DEFAULT: só LÊ o roster do Kit e o snapshot local, imprime
 * o plano e os eventos, e não faz chamada de rede nenhuma (nem renova token,
 * nem toca o índice). `--send` envia de verdade (`validateOnly: false`) e
 * grava o índice; `--send --dry-run` juntos = dry-run (sem rede).
 * `--validate-only` chama a API REAL com `validateOnly: true` — smoke test
 * seguro (nada é persistido do lado do Google, nenhuma conversão é contada)
 * que EXIGE `--send` junto (sem `--send`, `--validate-only` é ignorado e o
 * comando continua dry-run/sem rede) e NUNCA grava o índice (nada foi de
 * fato submetido).
 *
 * Pré-condição de dado: precisa de pelo menos 1 snapshot de
 * `scripts/subscriber-state-snapshot.ts` dentro do lookback (default 7 dias,
 * `--lookback-days`). Sem base o script FALHA (exit 1) em vez de assumir
 * "ninguém confirmou".
 *
 * Exit code: 0 = rodada limpa (inclui dry-run/validate-only e "nada a
 * enviar"); 1 = qualquer erro, snapshot base ausente/vazio/suspeito, índice
 * ilegível, ou `failed > 0` / `error` no resumo (falha de envio/chunk).
 *
 * Uso:
 *   npx tsx scripts/upload-google-ads-confirmations.ts --conversion-action-id 123 --customer-id 2369219639
 *   npx tsx scripts/upload-google-ads-confirmations.ts --conversion-action-id 123 --customer-id 2369219639 --send
 *   npx tsx scripts/upload-google-ads-confirmations.ts --conversion-action-id 123 --customer-id 2369219639 --send --validate-only
 *   [--dry-run] [--lookback-days 7] [--snapshot-root <dir>] [--index <path>]
 *
 * Env (`--send`/`--validate-only`): GOOGLE_ADS_CLIENT_ID,
 *   GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID
 *   (ou --customer-id). Sempre: KIT_API_KEY (leitura do roster).
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
import { buildDataManagerIngestPayload, sendDataManagerIngest } from "./lib/google-data-manager-sender.ts";
import {
  DEFAULT_LOOKBACK_DAYS,
  assessBaseSnapshot,
  pickBaseSnapshotDate,
  type ConfirmationRosterEntry,
  runConfirmationBatch,
} from "./lib/google-ads-confirmation-batch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[google-ads-confirmations]";
const DEFAULT_INDEX_PATH = resolve(ROOT, "data/google-ads/_confirmation-conversions-sent.json");
/** Ação de CADASTRO `7418673798` "Assinatura Confirmada" — a ÚNICA primária. Nunca destino do lote. */
export const PRIMARY_SIGNUP_ACTION_ID = "7418673798";
/**
 * Id numérico da ação, de `123` ou de `customers/X/conversionActions/123` — EXATO, nunca por
 * sufixo (um id maior que termine em `7418673798` não pode ser lido como a primária). Qualquer
 * outra forma devolve `null`. Vira o `productDestinationId` do Data Manager (#8555) — a API não
 * usa resource name completo, só o id numérico da ação.
 */
export function actionIdOf(raw: string): string | null {
  const v = raw.trim();
  if (/^\d+$/.test(v)) return v;
  return /^customers\/\d+\/conversionActions\/(\d+)$/.exec(v)?.[1] ?? null;
}

function todayBrtDayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

async function defaultListRoster(): Promise<ConfirmationRosterEntry[]> {
  const config = loadKitConfig(LOG_PREFIX);
  return listAllKitSubscribers(config, { status: "all" });
}

export async function main(
  argv: string[] = process.argv.slice(2),
  fetchFn: typeof fetch = fetch,
  listRoster: () => Promise<ConfirmationRosterEntry[]> = defaultListRoster,
  // #8837: injetável pra testes isolarem process.env do `.env` real da máquina
  // (sem isso, `delete process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID`/
  // `GOOGLE_ADS_CUSTOMER_ID` seguido de `loadProjectEnv` repõe a var de um `.env`
  // que contenha a credencial, e o teste de "--send sem id/customer-id" passa por
  // acidente em vez de exercitar o caminho de falha — mesmo padrão do #8829/#8836).
  envLoader: (root: string) => void = loadProjectEnv,
): Promise<number> {
  envLoader(ROOT);

  const send = hasFlag(argv, "send") && !hasFlag(argv, "dry-run");
  const dryRun = !send;
  // --validate-only só tem efeito junto de --send (rede real, validateOnly:true, índice intocado);
  // sozinho, o comando continua dry-run (sem rede) — nunca vira um 3º modo que chama a API fora do --send.
  const validateOnly = send && hasFlag(argv, "validate-only");
  const lookbackDays = getIntArg(argv, "lookback-days", { min: 1 }) ?? DEFAULT_LOOKBACK_DAYS;
  const snapshotRoot = getStringArg(argv, "snapshot-root") ?? snapshotRootDefault(resolve(ROOT, "data"));
  const indexPath = getStringArg(argv, "index") ?? DEFAULT_INDEX_PATH;
  const customerId = getStringArg(argv, "customer-id") ?? process.env.GOOGLE_ADS_CUSTOMER_ID;
  const actionArg = getStringArg(argv, "conversion-action-id");
  const actionEnv = process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID;
  const actionId = actionArg ?? actionEnv;
  if (actionArg && actionEnv && actionArg.trim() !== actionEnv.trim()) {
    console.error(
      `${LOG_PREFIX} ⚠ --conversion-action-id (${actionArg}) diverge de GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID ` +
        `(${actionEnv}) — usando o ARGUMENTO. Se a env é a intenção, remova o argumento da task.`,
    );
  }
  // A ação de CADASTRO é a única primária: confirmação nela = assinante contado duas vezes
  // no smart bidding (o mesmo erro que a #8572 pagou do lado da Meta). Recusa por id, não só por teste.
  if (actionId && actionIdOf(actionId) === PRIMARY_SIGNUP_ACTION_ID) {
    console.error(
      `${LOG_PREFIX} ✖ ${PRIMARY_SIGNUP_ACTION_ID} é a ação de CADASTRO (única primária) — recusada como destino da ` +
        "confirmação. Use a ação de confirmação SECUNDÁRIA.",
    );
    return 1;
  }

  let productDestinationId = "PENDENTE-CRIAR-ACAO-DE-CONFIRMACAO";
  if (actionId) {
    const resolved = actionIdOf(actionId);
    if (!resolved) {
      console.error(`${LOG_PREFIX} ✖ --conversion-action-id/env inválido: "${actionId}" não é um id numérico nem um resource name reconhecível.`);
      return 1;
    }
    productDestinationId = resolved;
  } else if (send) {
    console.error(
      `${LOG_PREFIX} ✖ --send exige --conversion-action-id (ou GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID): a ação de ` +
        "CONFIRMAÇÃO (UPLOAD_CLICKS, secundária; hoje a 7762768203) — NUNCA a ação de cadastro.",
    );
    return 1;
  } else {
    console.error(`${LOG_PREFIX} ⚠ sem id da ação de confirmação — dry-run usa um placeholder nos eventos.`);
  }
  if (send && !customerId) {
    console.error(`${LOG_PREFIX} ✖ --send exige --customer-id (ou GOOGLE_ADS_CUSTOMER_ID).`);
    return 1;
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

  const roster = await listRoster();
  console.error(`${LOG_PREFIX} roster Kit: ${roster.length} assinante(s).`);

  const baseProblem = assessBaseSnapshot(baseSnapshot.length, roster.length);
  if (baseProblem) {
    console.error(`${LOG_PREFIX} ✖ ${baseProblem} (${baseDate}) — abortando em vez de assumir "ninguém confirmou".`);
    return 1;
  }

  let summary;
  try {
    summary = await runConfirmationBatch({
      roster,
      baseSnapshot,
      baseDate,
      indexPath,
      dryRun,
      persistIndex: !validateOnly,
      sendFn: (events) =>
        sendDataManagerIngest({
          fetchFn,
          env: process.env,
          payload: buildDataManagerIngestPayload(events, {
            customerId: customerId!,
            productDestinationId,
            validateOnly,
          }),
        }),
    });
  } catch (e) {
    console.error(`${LOG_PREFIX} ✖ ${e instanceof Error ? e.message : e}`);
    return 1;
  }

  console.log(JSON.stringify(summary, null, 2));
  if (dryRun) console.error(`${LOG_PREFIX} DRY-RUN — nada foi enviado. Rode com --send para enviar.`);
  else if (validateOnly) console.error(`${LOG_PREFIX} VALIDATE-ONLY — chamada real à API, nada foi persistido no Google; índice NÃO foi gravado.`);
  return summary.failed > 0 || summary.error ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`${LOG_PREFIX} ✖ erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
