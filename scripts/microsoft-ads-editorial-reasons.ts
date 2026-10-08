/**
 * scripts/microsoft-ads-editorial-reasons.ts (#5878, #9091)
 *
 * CLI fino sobre `scripts/lib/microsoft-ads-editorial-reasons.ts`. Captura
 * motivos de rejeição editorial de assets via Campaign Management API v13 (SOAP)
 * e grava em `data/microsoft-ads/editorial-reasons-{YYYY-MM-DD}.json`.
 *
 * ## Contrato de saída (#9091 — alinhado aos ingests de gasto, #9012/#9071)
 *
 * - **Falha real → exit `SPEND_INGEST_FAILURE_EXIT_CODE` (não-zero)**:
 *   credencial ausente, API indisponível depois de esgotar o retry, SOAP
 *   Fault, falha escrevendo o snapshot, erro inesperado. A unit systemd
 *   aparece `failed` em vez de "sucesso" silencioso — antes do #9091 tudo
 *   isso saía com exit 0 e a falha só existia no log.
 * - **Caso vazio legítimo → exit 0**: a API respondeu e não há nenhum motivo
 *   editorial (nada rejeitado). O snapshot vazio ainda é gravado, pra marcar
 *   que a verificação rodou.
 * - **Retry de rede**: toda requisição (token OAuth + POST SOAP) passa por
 *   `withFetchRetry` com `SPEND_INGEST_FETCH_RETRY`, e o mesmo critério de
 *   status retentável do ingest Microsoft (`isMicrosoftAdsRetriableStatus`:
 *   5xx exceto 500, que é SOAP Fault determinístico).
 *
 * Nada aqui é consumido no caminho crítico do relatório — o exit não-zero é
 * só observabilidade.
 *
 * ## Credencial
 *
 * Reusa `authConfigFromEnv` de `scripts/microsoft-ads-ingest-spend.ts` (#9091):
 * `MICROSOFT_ADS_DEVELOPER_TOKEN`/`_CUSTOMER_ID`/`_ACCOUNT_ID` + UM dos 2
 * caminhos de identidade — Google (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
 * `MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN`, o que funciona pra conta em uso, #5928)
 * ou Azure AD (`MICROSOFT_ADS_CLIENT_ID`/`MICROSOFT_ADS_REFRESH_TOKEN`). Antes,
 * este CLI exigia só as 6 vars Azure AD — o caminho Google (já suportado pela
 * lib desde o #7504) nunca era montado a partir do ambiente. Ver
 * docs/microsoft-ads-api-setup.md.
 *
 * ## Uso
 *
 *   npx tsx scripts/microsoft-ads-editorial-reasons.ts
 *   npx tsx scripts/microsoft-ads-editorial-reasons.ts --asset-group-id 12345
 *   npx tsx scripts/microsoft-ads-editorial-reasons.ts --output data/microsoft-ads/custom.json
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { withFetchRetry } from "./lib/fetch-retry.ts";
import { SPEND_INGEST_FAILURE_EXIT_CODE, spendIngestRetryOptions } from "./lib/spend-ingest.ts";
import { fetchAssetGroupEditorialReasons, type FetchLike } from "./lib/microsoft-ads-editorial-reasons.ts";
import { authConfigFromEnv, isMicrosoftAdsRetriableStatus } from "./microsoft-ads-ingest-spend.ts";

// #1219 — carrega .env antes de ler process.env (`override: false`, nunca
// pisa em env já setado por `doppler run --`). O caminho Google lê
// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.
loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUTPUT_DIR = resolve(ROOT, "data", "microsoft-ads");

/** Asset group ID do "diar.ia.br - 4 conceitos" (campanha PMax teste 2608).
 *  Default conhecido porque é o único asset group com assets Microsoft. */
const DEFAULT_ASSET_GROUP_ID = "1187474912702110";

function fallback(reason: string): void {
  console.warn(`[microsoft-ads-editorial-reasons] falha — ${reason}`);
  console.warn("  editorial-reasons.json não foi atualizado.");
}

export interface EditorialReasonsCliOptions {
  /** Injetável só pra teste (default `fetch` global). */
  fetchImpl?: FetchLike;
  /** Injetável só pra teste — substitui o backoff do retry. */
  sleep?: (ms: number) => Promise<void>;
  /** Injetável só pra teste (default `new Date()`). */
  now?: Date;
}

function formatDateBR(date: Date): string {
  // YYYY-MM-DD no timezone do servidor (UTC no 300)
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  opts: EditorialReasonsCliOptions = {},
): Promise<number> {
  const assetGroupId = getStringArg(argv, "asset-group-id") ?? DEFAULT_ASSET_GROUP_ID;
  const outputOverride = getStringArg(argv, "output");
  const now = opts.now ?? new Date();

  const configResult = authConfigFromEnv();
  if ("missing" in configResult) {
    fallback(`variável(is) de ambiente ausente(s): ${configResult.missing.join(", ")}`);
    return SPEND_INGEST_FAILURE_EXIT_CODE;
  }

  // Qual identidade foi RESOLVIDA — logada em toda saída, mesmo critério do
  // ingest de gasto (#5928): com os 2 caminhos configurados, Google vence.
  const identityProvider = configResult.auth.googleRefreshToken ? "Google" : "AzureAd";

  const retryingFetch = withFetchRetry(opts.fetchImpl ?? fetch, {
    ...spendIngestRetryOptions(opts.sleep),
    isRetriableStatus: isMicrosoftAdsRetriableStatus,
  });

  const result = await fetchAssetGroupEditorialReasons(retryingFetch, configResult.auth, {
    assetGroupId,
  });

  if (!result.ok) {
    fallback(`[identidade: ${identityProvider}] ${result.error}`);
    return SPEND_INGEST_FAILURE_EXIT_CODE;
  }

  if (result.count === 0) {
    console.log(
      `[microsoft-ads-editorial-reasons] asset group ${assetGroupId}: 0 motivo(s) editorial — nada rejeitado.`,
    );
    // Caso vazio legítimo (exit 0) — ainda grava um snapshot vazio pra marcar que a verificação rodou
  }

  const outputPath =
    outputOverride ??
    resolve(DEFAULT_OUTPUT_DIR, `editorial-reasons-${formatDateBR(now)}.json`);

  const payload = {
    capturedAt: now.toISOString(),
    source: result.source,
    assetGroupId,
    accountId: configResult.auth.accountId,
    customerId: configResult.auth.customerId,
    count: result.count,
    reasons: result.reasons,
  };

  try {
    if (!existsSync(dirname(outputPath))) {
      mkdirSync(dirname(outputPath), { recursive: true });
    }
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
  } catch (e) {
    fallback(`falha escrevendo ${outputPath}: ${e instanceof Error ? e.message : e}`);
    return SPEND_INGEST_FAILURE_EXIT_CODE;
  }

  const summary = result.reasons
    .map((r) => `  - [${r.reasonCode}] ${r.location}: "${r.term}" (${r.publisherCountries}) [${r.appealStatus}]`)
    .join("\n");

  console.log(
    `[microsoft-ads-editorial-reasons] ✔ ${outputPath} via identidade ${identityProvider} (${result.count} motivo(s) capturado(s) para asset group ${assetGroupId})`,
  );
  if (result.reasons.length > 0) {
    console.log(summary);
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, {
    onError: (e) => {
      fallback(`erro inesperado: ${e instanceof Error ? e.message : e}`);
    },
    errorCode: SPEND_INGEST_FAILURE_EXIT_CODE,
  });
}
