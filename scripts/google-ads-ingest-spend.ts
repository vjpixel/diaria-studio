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
 * Requer no ambiente (via `doppler run --` ou `.env`):
 * GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
 * GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CUSTOMER_ID
 * — ver docs/google-ads-api-setup.md. **NÃO** requer `GOOGLE_PROJECT_ID`, que
 * é do servidor MCP e não deste caminho REST (ver `REQUIRED_ENV_VARS`).
 * **NUNCA aborta se algum faltar** — degrada pro fallback acima, com o(s)
 * nome(s) da(s) variável(is) ausente(s) no aviso.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { readSpendCsv, formatSpendCsv, type SpendRow } from "./lib/aquisicao-spend.ts";
import {
  runGoogleAdsIngest,
  type GoogleAdsAuthConfig,
  type GoogleAdsFailureClass,
} from "./lib/google-ads-ingest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");

/**
 * `GOOGLE_PROJECT_ID` NÃO entra aqui de propósito (corrigido em 17/08/2026).
 * Ele é exigido pelo servidor MCP oficial (`.mcp.json`, caminho ADC), não
 * por esta chamada REST — que autentica com CLIENT_ID/SECRET/REFRESH_TOKEN.
 * Exigi-lo fazia o script cair no fallback com o motivo ENGANOSO
 * "variável de ambiente ausente: GOOGLE_PROJECT_ID" antes de tentar a
 * chamada, escondendo o estado real da API (a var está pendente de sync no
 * Doppler — ver docs/google-ads-api-setup.md).
 */
const REQUIRED_ENV_VARS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_CUSTOMER_ID",
] as const;

/** Monta a config de auth a partir do ambiente, ou devolve os nomes das
 *  variáveis ausentes — nunca lança. Sobre `GOOGLE_PROJECT_ID` NÃO estar
 *  entre elas, ver o comentário de `REQUIRED_ENV_VARS` acima. */
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

/**
 * Reporta a falha de acordo com a classe, para que o caso ESPERADO e o BUG
 * não saiam com a mesma cara (exigência explícita do #5237).
 *
 * **Exit code continua 0 em todas as classes, inclusive `defect`.** A task
 * agendada encadeia `google-ads-ingest-spend.ts && microsoft-ads-ingest-spend.ts`
 * (`docs/scheduled-tasks-registry.md`), então sair não-zero calaria a
 * ingestão do OUTRO canal — o remédio seria pior que a doença. O que
 * distingue um defeito não é o exit code, é o banner: `defect` sai com
 * DEFEITO + instrução de ação, `auth-pending`/`empty` saem como estado
 * normal do dia.
 */
function reportFallback(reason: string, failureClass: GoogleAdsFailureClass): void {
  if (failureClass === "defect") {
    console.error("[google-ads-ingest-spend] ✖ DEFEITO na ingestão — NÃO é indisponibilidade externa.");
    console.error(`  ${reason}`);
    console.error("  A requisição está malformada ou a versão da API morreu; esperar não resolve.");
    console.error("  Corrigir em scripts/lib/google-ads-ingest.ts (query GAQL / apiVersion).");
    return;
  }
  if (failureClass === "empty") {
    console.log("[google-ads-ingest-spend] ✔ API respondeu, sem gasto no período consultado.");
    console.log("  Não é falha: spend.csv fica como está porque não há gasto a registrar.");
    return;
  }
  if (failureClass === "auth-pending") {
    console.warn("[google-ads-ingest-spend] acesso ainda não liberado (Basic Access na fila, #5262).");
  }
  fallback(reason);
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
    reportFallback(result.reason, result.failureClass);
    return 0;
  }

  writeFileSync(spendPath, formatSpendCsv(result.rows), "utf8");
  console.log(
    `[google-ads-ingest-spend] ✔ ${spendPath} atualizado (${result.fetchedRows} linha(s) GAQL agregadas).`,
  );
  // Perda PARCIAL (#5598) já saiu como console.warn de dentro de
  // runGoogleAdsIngest — este eco só garante que o CAMINHO DA CSV também
  // carregue o sinal, pra não ler como "✔ atualizado" limpo em quem só olha
  // o log do CLI (o warn da lib pode ficar longe da linha de sucesso em
  // scrollback/CI).
  if (result.discardedCount > 0) {
    console.warn(
      `[google-ads-ingest-spend] ⚠ ${result.discardedCount} linha(s) descartada(s) por malformação — ${spendPath} pode estar SUBESTIMADO. Ver aviso acima.`,
    );
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      // Último caminho que escaparia como stack cru — nunca deveria chegar
      // aqui (as duas etapas de rede já são fail-soft), mas mantém a
      // disciplina "nunca quebra o relatório" mesmo diante de um bug aqui.
      // `defect`, não `fallback()` puro: por definição, uma exceção que
      // escapou dos dois caminhos fail-soft É um bug nosso, não estado
      // externo esperado — achado do review do PR #5591.
      reportFallback(`erro inesperado: ${e instanceof Error ? e.message : e}`, "defect");
      process.exit(0);
    });
}
