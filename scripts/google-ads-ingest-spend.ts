/**
 * scripts/google-ads-ingest-spend.ts (#5237)
 *
 * CLI fino em cima de `scripts/lib/google-ads-ingest.ts` (núcleo puro/
 * testável). Busca custo por dia via GAQL na Google Ads API, agrega por mês
 * e atualiza `data/aquisicao/spend.csv` (#5236) com as linhas do canal
 * "Google Ads" — mantendo LinkedIn/Beehiiv Boosts e qualquer mês fora do
 * range consultado intocados.
 *
 * ## Fail-soft (item 5 do checklist #5237) — MCP/API indisponível NUNCA
 * quebra o relatório
 *
 * Hoje o developer token está no nível "Conta de teste" (Basic Access em
 * fila, #5262/#5237) — toda chamada de produção falha com
 * `DEVELOPER_TOKEN_NOT_APPROVED`. Esse é o caso comum, não uma exceção: sem
 * qualquer variável de ambiente `GOOGLE_ADS_*` presente, ou com a chamada
 * falhando por qualquer motivo (rede, auth, quota), este script imprime um
 * aviso e sai com **exit 0**, deixando `data/aquisicao/spend.csv` como
 * estava — o fallback é o CSV importado manualmente (`seed-spend-csv.ts` /
 * edição direta), que `cac-report.ts` já lê e nunca deixa de rodar por
 * causa disto.
 *
 * ## Uso
 *
 *   npx tsx scripts/google-ads-ingest-spend.ts
 *   npx tsx scripts/google-ads-ingest-spend.ts --spend data/aquisicao/spend.csv
 *
 * Requer no ambiente (via `doppler run --` ou `.env`): GOOGLE_PROJECT_ID,
 * GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
 * GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CUSTOMER_ID
 * — ver docs/google-ads-api-setup.md. **NUNCA aborta se algum faltar** —
 * degrada pro fallback acima, com o(s) nome(s) da(s) variável(is) ausente(s)
 * no aviso.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { readSpendCsv, formatSpendCsv, type SpendRow } from "./lib/aquisicao-spend.ts";
import { runGoogleAdsIngest, type GoogleAdsAuthConfig } from "./lib/google-ads-ingest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");

const REQUIRED_ENV_VARS = [
  "GOOGLE_PROJECT_ID",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_CUSTOMER_ID",
] as const;

/** Monta a config de auth a partir do ambiente, ou devolve os nomes das
 *  variáveis ausentes — nunca lança. `GOOGLE_PROJECT_ID` é exigido pelo
 *  MCP oficial (`.mcp.json`) mas não é usado nesta chamada REST direta;
 *  ainda assim checado aqui porque sua ausência é o mesmo sinal de setup
 *  incompleto que os demais. */
function authConfigFromEnv(): { auth: GoogleAdsAuthConfig } | { missing: string[] } {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) return { missing };

  return {
    auth: {
      clientId: process.env.GOOGLE_ADS_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
      refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
      developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
      loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!,
      customerId: process.env.GOOGLE_ADS_CUSTOMER_ID!,
      apiVersion: process.env.GOOGLE_ADS_API_VERSION,
    },
  };
}

function fallback(reason: string): void {
  console.warn(`[google-ads-ingest-spend] fallback pro CSV manual — ${reason}`);
  console.warn("  spend.csv não foi alterado. Editar manualmente ou rodar seed-spend-csv.ts se necessário.");
}

export async function main(): Promise<number> {
  const spendPath = getStringArg(process.argv.slice(2), "spend") ?? DEFAULT_SPEND_CSV_PATH;

  const configResult = authConfigFromEnv();
  if ("missing" in configResult) {
    fallback(`variável(is) de ambiente ausente(s): ${configResult.missing.join(", ")}`);
    return 0;
  }

  const existingRows: SpendRow[] = existsSync(spendPath) ? readSpendCsv(spendPath).rows : [];

  const result = await runGoogleAdsIngest(fetch, {
    auth: configResult.auth,
    existingRows,
  });

  if (result.kind === "fallback") {
    fallback(result.reason);
    return 0;
  }

  writeFileSync(spendPath, formatSpendCsv(result.rows), "utf8");
  console.log(
    `[google-ads-ingest-spend] ✔ ${spendPath} atualizado (${result.fetchedRows} linha(s) GAQL agregadas).`,
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
