/**
 * scripts/microsoft-ads-ingest-spend.ts (#5502, #5928)
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
 * Sem qualquer variável de ambiente `MICROSOFT_ADS_*`/`GOOGLE_*` presente,
 * ou com a chamada falhando por qualquer motivo (rede, auth, credencial não
 * emitida), este script imprime um aviso e sai com **exit 0**, deixando
 * `data/aquisicao/spend.csv` como estava — o fallback é o CSV importado
 * manualmente, que `cac-report.ts` já lê e nunca deixa de rodar por causa
 * disto. **Zero gasto no período consultado também é fail-soft (não erro)**
 * — a conta em uso não teve nenhum gasto histórico até 22/08/2026 (validado
 * ao vivo), então rodar isto hoje legitimamente não muda `spend.csv`.
 *
 * ## Uso
 *
 *   npx tsx scripts/microsoft-ads-ingest-spend.ts
 *   npx tsx scripts/microsoft-ads-ingest-spend.ts --spend data/aquisicao/spend.csv
 *
 * Requer no ambiente (via `doppler run --` ou `.env`) SEMPRE:
 * `MICROSOFT_ADS_DEVELOPER_TOKEN`, `MICROSOFT_ADS_CUSTOMER_ID`,
 * `MICROSOFT_ADS_ACCOUNT_ID` — mais UM dos 2 caminhos de identidade:
 *
 * - **Google** (#5928, o que FUNCIONA pra conta em uso hoje):
 *   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (reusa o client OAuth já
 *   existente do repo) + `MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN`.
 * - **Azure AD** (default histórico #5502, vale pra outra conta que não
 *   tenha sido criada via "Sign in with Google"): `MICROSOFT_ADS_CLIENT_ID`
 *   + `MICROSOFT_ADS_REFRESH_TOKEN`.
 *
 * Ver `docs/microsoft-ads-api-setup.md`. **NUNCA aborta se algum faltar** —
 * degrada pro fallback acima, com o(s) nome(s) da(s) variável(is)
 * ausente(s) no aviso.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { readSpendCsv, formatSpendCsv, type SpendRow } from "./lib/aquisicao-spend.ts";
import { runMicrosoftAdsIngest, type MicrosoftAdsAuthConfig } from "./lib/microsoft-ads-ingest.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

// #1219 — carrega .env antes de ler process.env. Passou a ser exigido aqui
// desde #5928: o caminho Google reusa `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
// (test/env-loading-invariant.test.ts trava isso pra qualquer script que
// leia esses 2 nomes). `override: false` — nunca pisa em env já setado
// (ex: por `doppler run --`).
loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");

/** Sempre exigidas, independente de qual identity provider a conta usa. */
const ALWAYS_REQUIRED_ENV_VARS = ["MICROSOFT_ADS_DEVELOPER_TOKEN", "MICROSOFT_ADS_CUSTOMER_ID", "MICROSOFT_ADS_ACCOUNT_ID"] as const;
/** Caminho Azure AD (default histórico, #5502) — vale pra qualquer conta
 *  Microsoft Advertising que NÃO tenha sido criada via "Sign in with
 *  Google". */
const AZURE_AD_ENV_VARS = ["MICROSOFT_ADS_CLIENT_ID", "MICROSOFT_ADS_REFRESH_TOKEN"] as const;
/**
 * Caminho Google OAuth (#5928, validado ao vivo em 22/08/2026) — exigido
 * pra ESTA conta (criada via "Sign in with Google", rejeita token Azure
 * AD). Reusa o client OAuth "Desktop app" já existente do repo
 * (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, mesmo usado por
 * `oauth-setup.ts` pra Drive/Gmail/GSC/etc — o scope `profile email` que
 * este fluxo pede é não-sensível e não exige nenhum client OAuth dedicado)
 * — só `MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN` é específico deste uso.
 */
const GOOGLE_IDENTITY_ENV_VARS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN"] as const;

/**
 * Monta a config de auth a partir do ambiente, ou devolve os nomes das
 * variáveis ausentes — nunca lança. Google tem prioridade quando os 3 vars
 * de `GOOGLE_IDENTITY_ENV_VARS` estão presentes (é o único caminho que
 * FUNCIONA pra conta em uso hoje — `refreshMicrosoftAdsAccessToken` também
 * prioriza Google quando `googleRefreshToken` está setado, mesmo critério);
 * Azure AD é o fallback pra qualquer outra conta. Falta de AMBOS os
 * caminhos (não só de um) é reportada como "missing" — com os 2 conjuntos
 * concatenados (não só o do Google), pra quem está configurando Azure AD
 * (ex: outra conta) também ver o que falta do LADO DELE, não só do Google.
 * Exportada pra teste direto (`test/microsoft-ads-ingest-spend.test.ts`) —
 * a lógica de prioridade/fallback é nova nesta PR (#5928), diferente do
 * check flat "tudo obrigatório" que `google-ads-ingest-spend.ts` tem.
 */
export function authConfigFromEnv(): { auth: MicrosoftAdsAuthConfig } | { missing: string[] } {
  const missingAlways = ALWAYS_REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  const missingGoogle = GOOGLE_IDENTITY_ENV_VARS.filter((name) => !process.env[name]);
  const missingAzure = AZURE_AD_ENV_VARS.filter((name) => !process.env[name]);

  if (missingAlways.length > 0) return { missing: missingAlways };
  if (missingGoogle.length > 0 && missingAzure.length > 0) {
    // Nenhum dos 2 caminhos está completo — reporta os 2 conjuntos de
    // variáveis ausentes, não só o do Google, senão quem está tentando
    // configurar Azure AD (a única opção pra uma conta SEM vínculo Google)
    // não vê o que falta do lado dele.
    return { missing: [...missingGoogle, ...missingAzure] };
  }

  return {
    auth: {
      clientId: process.env.MICROSOFT_ADS_CLIENT_ID,
      refreshToken: process.env.MICROSOFT_ADS_REFRESH_TOKEN,
      developerToken: process.env.MICROSOFT_ADS_DEVELOPER_TOKEN!,
      customerId: process.env.MICROSOFT_ADS_CUSTOMER_ID!,
      accountId: process.env.MICROSOFT_ADS_ACCOUNT_ID!,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      googleRefreshToken: process.env.MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN,
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

  // Qual identity provider foi RESOLVIDO (não necessariamente o que
  // funcionou — a chamada real ainda pode falhar) — logado em toda saída
  // (sucesso ou fallback) pra nunca deixar implícito qual credencial rodou.
  // Google tem prioridade (mesmo critério de `refreshMicrosoftAdsAccessToken`
  // e de `authConfigFromEnv` acima) — #5928, achado do review: sem isso, um
  // operador não tinha como saber se o gasto importado veio da conta certa
  // caso os 2 caminhos estivessem configurados ao mesmo tempo.
  const identityProvider = configResult.auth.googleRefreshToken ? "Google" : "AzureAd";

  const existingRows: SpendRow[] = existsSync(spendPath) ? readSpendCsv(spendPath).rows : [];

  const result = await runMicrosoftAdsIngest(fetch, {
    auth: configResult.auth,
    existingRows,
  });

  if (result.kind === "fallback") {
    fallback(`[identidade: ${identityProvider}] ${result.reason}`);
    return 0;
  }

  writeFileSync(spendPath, formatSpendCsv(result.rows), "utf8");
  console.log(
    `[microsoft-ads-ingest-spend] ✔ ${spendPath} atualizado via identidade ${identityProvider} (${result.fetchedRows} linha(s) de relatório agregadas).`,
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
