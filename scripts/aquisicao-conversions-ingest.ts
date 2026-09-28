#!/usr/bin/env node
/**
 * scripts/aquisicao-conversions-ingest.ts (#8591)
 *
 * Fecha o item 2 da #8591 ("O lado do painel é manual"). Popula
 * automaticamente `data/aquisicao/painel/{dia}.json` — o MESMO caminho que
 * `aquisicao-reconcile-daily.ts` já lê pra calcular o fator de
 * superestimação — com as conversões diárias que Google Ads e Meta Ads
 * reportam pra ação de CADASTRO, pra ninguém precisar preencher esse
 * arquivo à mão.
 *
 * ## Ação de cadastro por plataforma (decisão do editor, 28/09/2026,
 * `/diaria-desbloqueia`, comentário da issue)
 *
 *   Meta:   `complete_registration` (Graph API `insights.actions`,
 *           `META_COMPLETE_REGISTRATION_ACTION_TYPE` em
 *           `scripts/lib/ads-campaign-economics-fetch.ts`).
 *   Google: a ação PRIMÁRIA de cadastro newsletter — `7418673798
 *           "Assinatura Confirmada"` sob `AW-17790097065`
 *           (`GOOGLE_ADS_REGISTRATION_CONVERSION_ACTION_ID` em
 *           `scripts/lib/google-ads-ingest.ts`; ver
 *           `docs/gtm-signup-tracking-setup.md`) — DISTINTA da ação de
 *           confirmação DOI (`7762768203`, secundária) que
 *           `upload-google-ads-confirmations.ts` (#8555) sobe.
 *
 * ## Fail-soft por canal, nunca por script inteiro
 *
 * Cada canal é buscado independentemente, reusando a MESMA credencial de
 * ambiente que os ingests de gasto vizinhos (`GOOGLE_ADS_*`,
 * `META_ADS_ACCESS_TOKEN`). Credencial ausente ou chamada falhando NUNCA
 * aborta o outro canal nem grava `reported_conversions: 0` — o canal
 * simplesmente fica de fora do `channels` do painel do dia (a mesma
 * distinção que `aquisicao-reconcile.ts` já faz entre "sem-coorte" e "0
 * real": aqui, "sem dado disponível" e "0 relatado pela API" não podem se
 * confundir). Exit sempre 0.
 *
 * Se NENHUM canal produziu dado, nada é escrito — o painel do dia anterior
 * (se existir) não é sobrescrito com um payload vazio, e
 * `aquisicao-reconcile-daily.ts` segue seu caminho normal de "sem painel
 * hoje" (log, sem erro).
 *
 * `cohort_key` gravado é o `utm_source` real que os anúncios do teste 2608
 * escrevem na URL final (`CHANNEL_KEY_SPECS`, `scripts/lib/shared/channel-key-specs.ts`)
 * — `"google-ads"`/`"meta-ads"`, não `"google"`/`"meta"` (aqueles eram só o
 * placeholder do template antes da 1ª semana de campanha confirmar as
 * chaves reais, ver `docs/aquisicao-reconcile-panel-template.json`).
 *
 * Uso:
 *   npx tsx scripts/aquisicao-conversions-ingest.ts                   # dia BRT anterior
 *   npx tsx scripts/aquisicao-conversions-ingest.ts --day AAAA-MM-DD  # override/backfill
 */
import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { brtDateOf, shiftDate } from "./lib/ads-rolling-window.ts";
import type { PanelInput } from "./aquisicao-reconcile.ts";
import {
  metaAdsAuthConfigFromEnv,
  fetchMetaAdsCompleteRegistrationDaily,
} from "./lib/ads-campaign-economics-fetch.ts";
import {
  refreshGoogleAdsAccessToken,
  fetchGoogleAdsSpendRows,
  buildGoogleAdsConversionsQuery,
  aggregateGoogleAdsConversionsByDayWithDiscards,
  GOOGLE_ADS_REGISTRATION_CONVERSION_ACTION_ID,
  type GoogleAdsAuthConfig,
  type GaqlConversionsApiRow,
} from "./lib/google-ads-ingest.ts";

/** Dia BRT a processar por default: o dia ANTERIOR ao instante de execução
 *  — mesma convenção de `aquisicao-reconcile-daily.ts` (roda de manhã sobre
 *  o dia que já fechou). @pure em relação a `now`. */
export function defaultProcessingDay(now: Date): string {
  return shiftDate(brtDateOf(now), -1);
}

const GOOGLE_ADS_REQUIRED_ENV_VARS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_CUSTOMER_ID",
] as const;

/** Mesma leitura de ambiente de `google-ads-ingest-spend.ts`
 *  (`authConfigFromEnv`) — duplicada aqui em vez de importada porque aquela
 *  função não é exportada (é local ao CLI de gasto) e as duas leituras
 *  divergiriam de qualquer forma no dia em que uma delas precisasse de uma
 *  var a mais. */
function googleAdsAuthConfigFromEnv(): { auth: GoogleAdsAuthConfig } | { missing: string[] } {
  const missing = GOOGLE_ADS_REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
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

/** Busca a contagem de conversões do Google Ads pro `day` exato — `null`
 *  quando a credencial está ausente ou a chamada falha (fail-soft, nunca
 *  lança); `0` é um resultado real (API respondeu, sem conversão no dia). */
async function fetchGoogleConversionsForDay(day: string): Promise<number | null> {
  const configResult = googleAdsAuthConfigFromEnv();
  if ("missing" in configResult) {
    console.log(`[aquisicao-conversions-ingest] Google — pulando: variável(is) de ambiente ausente(s): ${configResult.missing.join(", ")}`);
    return null;
  }
  const auth = configResult.auth;
  const tokenResult = await refreshGoogleAdsAccessToken(fetch, auth);
  if ("error" in tokenResult) {
    console.log(`[aquisicao-conversions-ingest] Google — pulando: ${tokenResult.error}`);
    return null;
  }
  // Lookback curto (2 dias) é suficiente — só precisamos do `day` exato;
  // margem de 1 dia cobre a mesma cautela de fuso de `toGaqlDate`
  // (segments.date é calendário DA CONTA, não UTC).
  const now = new Date(`${day}T12:00:00Z`);
  const query = buildGoogleAdsConversionsQuery(now, 2, GOOGLE_ADS_REGISTRATION_CONVERSION_ACTION_ID);
  const result = await fetchGoogleAdsSpendRows<GaqlConversionsApiRow>(fetch, auth, tokenResult.accessToken, query);
  if ("error" in result) {
    console.log(`[aquisicao-conversions-ingest] Google — pulando: ${result.error}`);
    return null;
  }
  const { counts, discardedCount } = aggregateGoogleAdsConversionsByDayWithDiscards(result.rows);
  if (discardedCount > 0) {
    console.log(`[aquisicao-conversions-ingest] Google — ${discardedCount} linha(s) descartada(s) por malformação.`);
  }
  return counts.find((c) => c.date === day)?.count ?? 0;
}

/** Busca a contagem de `complete_registration` do Meta Ads pro `day` exato
 *  — mesma semântica de retorno de `fetchGoogleConversionsForDay`. */
async function fetchMetaConversionsForDay(day: string): Promise<number | null> {
  const authResult = metaAdsAuthConfigFromEnv();
  if ("missing" in authResult) {
    console.log(`[aquisicao-conversions-ingest] Meta — pulando: variável(is) de ambiente ausente(s): ${authResult.missing.join(", ")}`);
    return null;
  }
  const now = new Date(`${day}T12:00:00Z`);
  const result = await fetchMetaAdsCompleteRegistrationDaily(fetch, authResult.auth.accessToken, { now, lookbackDays: 2 });
  if (result.error) {
    console.log(`[aquisicao-conversions-ingest] Meta — pulando: ${result.error}`);
    return null;
  }
  return result.counts.find((c) => c.date === day)?.count ?? 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv).values;
  const day = typeof args.day === "string" && args.day ? args.day : defaultProcessingDay(new Date());

  console.log(`[aquisicao-conversions-ingest] dia ${day}`);

  const [googleCount, metaCount] = await Promise.all([fetchGoogleConversionsForDay(day), fetchMetaConversionsForDay(day)]);

  const channels: PanelInput["channels"] = {};
  if (googleCount !== null) channels.google = { reported_conversions: googleCount, cohort_key: "google-ads" };
  if (metaCount !== null) channels.meta = { reported_conversions: metaCount, cohort_key: "meta-ads" };

  if (Object.keys(channels).length === 0) {
    console.log("[aquisicao-conversions-ingest] nenhum canal produziu dado hoje — painel do dia anterior (se existir) preservado, nada escrito.");
    return 0;
  }

  const panel: PanelInput = { window: { from: day, to: day }, channels };
  const panelPath = resolve("data", "aquisicao", "painel", `${day}.json`);
  mkdirSync(dirname(panelPath), { recursive: true });
  writeFileSync(panelPath, JSON.stringify(panel, null, 2) + "\n");
  console.log(`[aquisicao-conversions-ingest] ${panelPath} gravado — ${Object.keys(channels).join(", ")}`);
  for (const [channel, spec] of Object.entries(channels)) {
    console.log(`  ${channel}: ${spec.reported_conversions} conversões`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(0);
    });
}
