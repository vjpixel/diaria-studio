#!/usr/bin/env npx tsx
/**
 * scripts/google-ads-set-conversion-primary.ts (#8574)
 *
 * Rebaixa (ou promove) `primary_for_goal` de uma `conversion_action` via
 * Google Ads REST API — mutação estreita (só esse campo, `updateMask`
 * restrito) num único recurso já identificado.
 *
 * ## Contexto
 *
 * Decisão do editor (20/09/2026, autorizada em 28/09/2026 via
 * `/diaria-desbloqueia` — comentário na issue e
 * `scripts/lib/issue-decisions.ts --issue 8574`): rebaixar a ação
 * `7758161410` ("Cadastro newsletter (recuperação #7770)") de
 * `primary_for_goal=true` pra `false`, só depois do fim da janela do teste
 * 2608 (27/09/2026) — a ação sustenta ~1 conversão em 30 dias (não carrega
 * peso no lance inteligente), mas mexer nos objetivos primários da conta
 * DURANTE o teste contaminaria a comparação entre braços.
 *
 * ## Segurança
 *
 *   - `--dry-run` é o DEFAULT: lê o estado atual, decide se mudaria algo, e
 *     IMPRIME o plano — nenhuma chamada de mutação acontece. Só `--send`
 *     muta de verdade.
 *   - A leitura (antes E depois) sempre acontece, inclusive em `--send`
 *     (#573 — nunca confiar só no HTTP 2xx da mutação; reler confirma).
 *   - Registro em `data/aquisicao/teste-2608/edicoes.jsonl` só acontece
 *     quando a mutação de fato mudou algo (`--send` + estado != alvo) — via
 *     `scripts/ads-registrar-edicao.ts` (tipo `conversion-action-secundaria`,
 *     ver `scripts/lib/ads-rolling-window.ts`). Idempotente: rodar de novo
 *     com o mesmo alvo depois de já convergido não grava linha nova (nada
 *     mudou).
 *
 * ## Uso
 *
 *   npx tsx scripts/google-ads-set-conversion-primary.ts \
 *     --conversion-action-id 7758161410 --target false
 *     # dry-run — lê o estado atual, imprime o plano, não muta
 *
 *   doppler run -- npx tsx scripts/google-ads-set-conversion-primary.ts \
 *     --conversion-action-id 7758161410 --target false --send
 *     # muta de verdade — requer as env vars GOOGLE_ADS_* (ver
 *     # docs/google-ads-api-setup.md) e --customer-id (ou
 *     # GOOGLE_ADS_CUSTOMER_ID) pra montar o resource name.
 *
 * Requer no ambiente, só quando `--send`:
 *   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,
 *   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID,
 *   GOOGLE_ADS_CUSTOMER_ID (ou `--customer-id`)
 */

import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  buildConversionActionReadQuery,
  parseConversionActionRow,
  decidePrimaryForGoalChange,
  buildSetPrimaryForGoalPayload,
  type ConversionActionApiRow,
  type ConversionActionState,
} from "./lib/google-ads-conversion-action.ts";
import { refreshGoogleAdsAccessToken, postGoogleAdsWithLoginRetry, DEFAULT_API_VERSION } from "./lib/google-ads-ingest.ts";
import { authConfigFromEnv } from "./lib/google-ads-conversion-sender.ts";
import { main as registrarEdicaoMain } from "./ads-registrar-edicao.ts";

const DEFAULT_CONVERSION_ACTION_ID = "7758161410";

/** Lê o estado atual da `conversion_action` via `googleAds:search`. Nunca
 *  lança — falha de rede/auth/parse vira `{ error }`. */
async function readConversionActionState(
  fetchFn: typeof fetch,
  auth: Parameters<typeof postGoogleAdsWithLoginRetry>[1] & { apiVersion?: string },
  accessToken: string,
  conversionActionId: string,
): Promise<{ state: ConversionActionState | null } | { error: string }> {
  const apiVersion = auth.apiVersion ?? DEFAULT_API_VERSION;
  const customerId = auth.customerId.replace(/[^0-9]/g, "");
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`;
  const query = buildConversionActionReadQuery(conversionActionId);

  const attempt = await postGoogleAdsWithLoginRetry(fetchFn, auth, accessToken, url, JSON.stringify({ query }), "conversionAction:search");
  if ("networkError" in attempt) return { error: attempt.networkError };
  const { res, text } = attempt;
  if (!res.ok) return { error: `googleAds:search respondeu HTTP ${res.status}: ${text.slice(0, 600)}` };

  let payload: { results?: ConversionActionApiRow[] };
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: `googleAds:search respondeu corpo não-JSON (HTTP ${res.status})` };
  }
  return { state: parseConversionActionRow(payload.results ?? []) };
}

export async function main(argv: string[] = process.argv.slice(2), fetchFn: typeof fetch = fetch): Promise<number> {
  loadProjectEnv();

  const conversionActionId = getStringArg(argv, "conversion-action-id", { example: DEFAULT_CONVERSION_ACTION_ID }) ?? DEFAULT_CONVERSION_ACTION_ID;
  const targetRaw = getStringArg(argv, "target", { example: "false" }) ?? "false";
  if (targetRaw !== "true" && targetRaw !== "false") {
    console.error(`[google-ads-set-conversion-primary] ✖ --target precisa ser "true" ou "false", recebido: "${targetRaw}"`);
    return 1;
  }
  const target = targetRaw === "true";
  const send = hasFlag(argv, "send");
  const customerId = getStringArg(argv, "customer-id", { example: "2369219639" }) ?? process.env.GOOGLE_ADS_CUSTOMER_ID;
  const skipRegistro = hasFlag(argv, "skip-registro");
  const edicoesPath = getStringArg(argv, "edicoes-path", { example: "data/aquisicao/teste-2608/edicoes.jsonl" });

  if (!customerId) {
    console.error("[google-ads-set-conversion-primary] ✖ --customer-id (ou GOOGLE_ADS_CUSTOMER_ID no ambiente) é obrigatório.");
    return 1;
  }

  const configResult = authConfigFromEnv(process.env, customerId);
  if ("missing" in configResult) {
    console.error(
      `[google-ads-set-conversion-primary] ✖ variáveis de ambiente ausentes: ${configResult.missing.join(", ")}. ` +
        "Rode via `doppler run -- npx tsx ...` ou preencha .env (ver docs/google-ads-api-setup.md).",
    );
    return 1;
  }
  const { auth } = configResult;

  const tokenResult = await refreshGoogleAdsAccessToken(fetchFn, auth);
  if ("error" in tokenResult) {
    console.error(`[google-ads-set-conversion-primary] ✖ falha ao renovar access token: ${tokenResult.error}`);
    return 1;
  }

  console.log(`[google-ads-set-conversion-primary] lendo estado atual da conversion_action ${conversionActionId}...`);
  const before = await readConversionActionState(fetchFn, auth, tokenResult.accessToken, conversionActionId);
  if ("error" in before) {
    console.error(`[google-ads-set-conversion-primary] ✖ falha ao ler estado atual: ${before.error}`);
    return 1;
  }
  if (!before.state) {
    console.error(`[google-ads-set-conversion-primary] ✖ conversion_action ${conversionActionId} não encontrada na conta ${customerId}.`);
    return 1;
  }

  console.log(
    `[google-ads-set-conversion-primary] ANTES: "${before.state.name}" (${before.state.resourceName}) — ` +
      `primary_for_goal=${before.state.primaryForGoal}`,
  );

  const decision = decidePrimaryForGoalChange(before.state.primaryForGoal, target);
  console.log(`[google-ads-set-conversion-primary] ${decision.message}`);

  if (!decision.needsChange) {
    console.log("[google-ads-set-conversion-primary] nada a fazer — estado já convergido, nenhuma chamada de mutação necessária.");
    return 0;
  }

  const payload = buildSetPrimaryForGoalPayload(before.state.resourceName, target);

  if (!send) {
    console.log("[google-ads-set-conversion-primary] DRY-RUN (default) — nenhuma chamada de mutação foi feita. Payload que seria enviado:");
    console.log(JSON.stringify(payload, null, 2));
    console.log("[google-ads-set-conversion-primary] rode de novo com --send (via `doppler run --`) para mutar de verdade.");
    return 0;
  }

  const apiVersion = auth.apiVersion ?? DEFAULT_API_VERSION;
  const mutateUrl = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId.replace(/[^0-9]/g, "")}/conversionActions:mutate`;
  console.log("[google-ads-set-conversion-primary] enviando mutação...");
  const mutateAttempt = await postGoogleAdsWithLoginRetry(fetchFn, auth, tokenResult.accessToken, mutateUrl, JSON.stringify(payload), "conversionActions:mutate");
  if ("networkError" in mutateAttempt) {
    console.error(`[google-ads-set-conversion-primary] ✖ falha de rede na mutação: ${mutateAttempt.networkError}`);
    return 1;
  }
  if (!mutateAttempt.res.ok) {
    console.error(`[google-ads-set-conversion-primary] ✖ conversionActions:mutate respondeu HTTP ${mutateAttempt.res.status}: ${mutateAttempt.text.slice(0, 1000)}`);
    return 1;
  }
  console.log(`[google-ads-set-conversion-primary] ✔ mutação aceita: ${mutateAttempt.text.slice(0, 500)}`);

  // Reler pra confirmar — nunca confiar só no HTTP 2xx (#573).
  console.log("[google-ads-set-conversion-primary] relendo estado pra confirmar...");
  const after = await readConversionActionState(fetchFn, auth, tokenResult.accessToken, conversionActionId);
  if ("error" in after) {
    console.error(`[google-ads-set-conversion-primary] ⚠ mutação aceita, mas releitura de confirmação falhou: ${after.error}`);
    return 1;
  }
  if (!after.state) {
    console.error("[google-ads-set-conversion-primary] ⚠ mutação aceita, mas a releitura não encontrou mais a ação (inesperado).");
    return 1;
  }
  console.log(`[google-ads-set-conversion-primary] DEPOIS: primary_for_goal=${after.state.primaryForGoal}`);

  if (after.state.primaryForGoal !== target) {
    console.error(
      `[google-ads-set-conversion-primary] ✖ INCONSISTÊNCIA: a API aceitou a mutação, mas a releitura mostra primary_for_goal=` +
        `${after.state.primaryForGoal}, esperado ${target}. Não registrando em edicoes.jsonl — investigar antes de confiar no resultado.`,
    );
    return 1;
  }

  console.log(`[google-ads-set-conversion-primary] ✔ confirmado: ${before.state.primaryForGoal} → ${after.state.primaryForGoal}`);

  if (skipRegistro) {
    console.log("[google-ads-set-conversion-primary] --skip-registro passado — não registrando em edicoes.jsonl.");
    return 0;
  }

  // Registro in-process (import direto, não child process) — `main` de
  // `ads-registrar-edicao.ts` é síncrono e só faz `appendFileSync`.
  const registroCode = registrarEdicaoMain([
    "--braco",
    "Google Ads (teste 2608)",
    "--tipo",
    "conversion-action-secundaria",
    "--origem",
    "agente",
    "--issue",
    "8574",
    "--conversion-action",
    conversionActionId,
    "--motivo",
    `primary_for_goal ${before.state.primaryForGoal} -> ${after.state.primaryForGoal}, autorizado pelo editor em 28/09/2026 (janela do teste 2608 ja fechada)`,
    ...(edicoesPath ? ["--edicoes-path", edicoesPath] : []),
  ]);
  if (registroCode !== 0) {
    console.error(
      "[google-ads-set-conversion-primary] ⚠ mutação e confirmação OK, mas o registro em edicoes.jsonl falhou (ver mensagem acima). " +
        "Registrar manualmente: npx tsx scripts/ads-registrar-edicao.ts --braco 'Google Ads (teste 2608)' --tipo conversion-action-secundaria --origem agente --issue 8574",
    );
    return 1;
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[google-ads-set-conversion-primary] ✖ erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
