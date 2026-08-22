/**
 * scripts/microsoft-ads-editorial-reasons.ts (#5878)
 *
 * CLI fino sobre `scripts/lib/microsoft-ads-editorial-reasons.ts`. Captura
 * motivos de rejeição editorial de assets via Campaign Management API v13 (SOAP)
 * e grava em `data/microsoft-ads/editorial-reasons-{YYYY-MM-DD}.json`.
 *
 * ## Fail-soft
 *
 * Sem as env vars `MICROSOFT_ADS_*`, falha de rede, ou SOAP Fault →
 * `console.warn` + exit 0. O script nunca quebra o cron diário nem lança
 * stack cru — a ausência de credencial é o estado esperado até que a conta
 * Microsoft gere assets rejeitáveis.
 *
 * ## Uso
 *
 *   npx tsx scripts/microsoft-ads-editorial-reasons.ts
 *   npx tsx scripts/microsoft-ads-editorial-reasons.ts --asset-group-id 12345
 *   npx tsx scripts/microsoft-ads-editorial-reasons.ts --output data/microsoft-ads/custom.json
 *
 * Requer no ambiente (via `doppler run --` ou `.env`): as 6 vars de
 * `MICROSOFT_ADS_*` — ver docs/microsoft-ads-api-setup.md. NUNCA aborta se
 * alguma faltar.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import {
  fetchAssetGroupEditorialReasons,
  type MicrosoftAdsAuthConfig,
} from "./lib/microsoft-ads-editorial-reasons.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUTPUT_DIR = resolve(ROOT, "data", "microsoft-ads");

const REQUIRED_ENV_VARS = [
  "MICROSOFT_ADS_CLIENT_ID",
  "MICROSOFT_ADS_CLIENT_SECRET",
  "MICROSOFT_ADS_REFRESH_TOKEN",
  "MICROSOFT_ADS_DEVELOPER_TOKEN",
  "MICROSOFT_ADS_CUSTOMER_ID",
  "MICROSOFT_ADS_ACCOUNT_ID",
] as const;

/** Asset group ID do "diar.ia.br - 4 conceitos" (campanha PMax teste 2608).
 *  Default conhecido porque é o único asset group com assets Microsoft. */
const DEFAULT_ASSET_GROUP_ID = "1187474912702110";

function authConfigFromEnv(): { auth: MicrosoftAdsAuthConfig } | { missing: string[] } {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) return { missing };
  return {
    auth: {
      clientId: process.env.MICROSOFT_ADS_CLIENT_ID!,
      clientSecret: process.env.MICROSOFT_ADS_CLIENT_SECRET!,
      refreshToken: process.env.MICROSOFT_ADS_REFRESH_TOKEN!,
      developerToken: process.env.MICROSOFT_ADS_DEVELOPER_TOKEN!,
      customerId: process.env.MICROSOFT_ADS_CUSTOMER_ID!,
      accountId: process.env.MICROSOFT_ADS_ACCOUNT_ID!,
    },
  };
}

function fallback(reason: string): void {
  console.warn(`[microsoft-ads-editorial-reasons] fallback — ${reason}`);
  console.warn("  editorial-reasons.json não foi atualizado. Verifique as credenciais no Doppler.");
}

function formatDateBR(date: Date): string {
  // YYYY-MM-DD no timezone do servidor (UTC no Helios)
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function main(): Promise<number> {
  const assetGroupId =
    getStringArg(process.argv.slice(2), "asset-group-id") ?? DEFAULT_ASSET_GROUP_ID;
  const outputOverride = getStringArg(process.argv.slice(2), "output");
  const now = new Date();

  const configResult = authConfigFromEnv();
  if ("missing" in configResult) {
    fallback(`variável(is) de ambiente ausente(s): ${configResult.missing.join(", ")}`);
    return 0;
  }

  const result = await fetchAssetGroupEditorialReasons(fetch, configResult.auth, {
    assetGroupId,
  });

  if (!result.ok) {
    fallback(result.error);
    return 0;
  }

  if (result.count === 0) {
    console.log(
      `[microsoft-ads-editorial-reasons] asset group ${assetGroupId}: 0 motivo(s) editorial — nada rejeitado.`,
    );
    // Ainda grava um snapshot vazio pra marcar que a verificação rodou
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
    return 0;
  }

  const summary = result.reasons
    .map((r) => `  - [${r.reasonCode}] ${r.location}: "${r.term}" (${r.publisherCountries}) [${r.appealStatus}]`)
    .join("\n");

  console.log(
    `[microsoft-ads-editorial-reasons] ✔ ${outputPath} (${result.count} motivo(s) capturado(s) para asset group ${assetGroupId})`,
  );
  if (result.reasons.length > 0) {
    console.log(summary);
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      fallback(`erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(0);
    });
}
