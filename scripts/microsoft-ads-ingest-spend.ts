/**
 * scripts/microsoft-ads-ingest-spend.ts (#5502)
 *
 * CLI fino em cima de `scripts/lib/microsoft-ads-ingest.ts` (núcleo puro/
 * testável). Busca custo via Reporting API do Microsoft Advertising, agrega
 * por mês e atualiza `data/aquisicao/spend.csv` (#5236) com as linhas do
 * canal "Microsoft Advertising" — mantendo Google Ads/LinkedIn/Beehiiv
 * Boosts e qualquer mês fora do range consultado intocados. Espelha
 * `scripts/google-ads-ingest-spend.ts` (#5237) ponto a ponto.
 *
 * ## Fail-soft — MCP/API indisponível NUNCA quebra o relatório
 *
 * Nenhuma campanha Microsoft Advertising roda ainda (#5493) — sem qualquer
 * variável de ambiente `MICROSOFT_ADS_*` presente, ou com a chamada falhando
 * por qualquer motivo (rede, auth, credencial não emitida), este script
 * imprime um aviso e sai com **exit 0**, deixando `data/aquisicao/spend.csv`
 * como estava — o fallback é o CSV importado manualmente, que
 * `cac-report.ts` já lê e nunca deixa de rodar por causa disto.
 *
 * ## Uso
 *
 *   npx tsx scripts/microsoft-ads-ingest-spend.ts
 *   npx tsx scripts/microsoft-ads-ingest-spend.ts --spend data/aquisicao/spend.csv
 *
 * Requer no ambiente (via `doppler run --` ou `.env`): MICROSOFT_ADS_CLIENT_ID,
 * MICROSOFT_ADS_CLIENT_SECRET, MICROSOFT_ADS_REFRESH_TOKEN,
 * MICROSOFT_ADS_DEVELOPER_TOKEN, MICROSOFT_ADS_CUSTOMER_ID,
 * MICROSOFT_ADS_ACCOUNT_ID — ver docs/microsoft-ads-api-setup.md. **NUNCA
 * aborta se algum faltar** — degrada pro fallback acima, com o(s) nome(s)
 * da(s) variável(is) ausente(s) no aviso.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { readSpendCsv, formatSpendCsv, type SpendRow } from "./lib/aquisicao-spend.ts";
import { runMicrosoftAdsIngest, type MicrosoftAdsAuthConfig } from "./lib/microsoft-ads-ingest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");

const REQUIRED_ENV_VARS = [
  "MICROSOFT_ADS_CLIENT_ID",
  "MICROSOFT_ADS_CLIENT_SECRET",
  "MICROSOFT_ADS_REFRESH_TOKEN",
  "MICROSOFT_ADS_DEVELOPER_TOKEN",
  "MICROSOFT_ADS_CUSTOMER_ID",
  "MICROSOFT_ADS_ACCOUNT_ID",
] as const;

/** Monta a config de auth a partir do ambiente, ou devolve os nomes das
 *  variáveis ausentes — nunca lança. */
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
  console.warn(`[microsoft-ads-ingest-spend] fallback pro CSV manual — ${reason}`);
  console.warn("  spend.csv não foi alterado. Editar manualmente se necessário.");
}

export async function main(): Promise<number> {
  const spendPath = getStringArg(process.argv.slice(2), "spend") ?? DEFAULT_SPEND_CSV_PATH;

  const configResult = authConfigFromEnv();
  if ("missing" in configResult) {
    fallback(`variável(is) de ambiente ausente(s): ${configResult.missing.join(", ")}`);
    return 0;
  }

  const existingRows: SpendRow[] = existsSync(spendPath) ? readSpendCsv(spendPath).rows : [];

  const result = await runMicrosoftAdsIngest(fetch, {
    auth: configResult.auth,
    existingRows,
  });

  if (result.kind === "fallback") {
    fallback(result.reason);
    return 0;
  }

  writeFileSync(spendPath, formatSpendCsv(result.rows), "utf8");
  console.log(
    `[microsoft-ads-ingest-spend] ✔ ${spendPath} atualizado (${result.fetchedRows} linha(s) de relatório agregadas).`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      // Último caminho que escaparia como stack cru — nunca deveria chegar
      // aqui (as duas etapas de rede já são fail-soft), mas mantém a
      // disciplina "nunca quebra o relatório" mesmo diante de um bug aqui.
      fallback(`erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(0);
    });
}
