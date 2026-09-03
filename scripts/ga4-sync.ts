#!/usr/bin/env node
/**
 * scripts/ga4-sync.ts (#5248)
 *
 * Ingestão da Google Analytics Data API (GA4) — a única fonte de
 * comportamento PÓS-CLIQUE na home hospedada `diar.ia.br` (custom hostname
 * da Beehiiv, fora da zona Cloudflare — `scripts/lib/shared/ai-referrer-log.ts`
 * cobre citação por IA via header Referer nos Workers de curadoria, mas não
 * alcança a home). Decisão do editor (14/08/2026, #5248): consertar e
 * ingerir, não aposentar.
 *
 * Puxa 4 relatórios da propriedade configurada em `GA4_PROPERTY_ID`:
 *   - `overview`: sessions, screenPageViews, engagedSessions, averageSessionDuration
 *     por dia (dimension `date`), sobre a janela `--days`.
 *   - `top-pages`: screenPageViews por `pagePath` (top N por pageviews) na
 *     mesma janela — é o relatório que dá comportamento pós-clique de fato
 *     (o que o visitante lê depois de chegar).
 *   - `channel` (#7184, fatia 12 do épico #7172): sessions por
 *     `date`/`sessionSource`/`sessionMedium`/`sessionCampaignName`/`hostName`
 *     — o TOPO de funil (visita) que estava sendo descartado na coleta.
 *     `hostName` é obrigatório: a propriedade cobre o Vigil.ia.br inteiro
 *     (eia./livros./cursos./arquivo./especial./poll.diaria.workers.dev), e
 *     sem ele a `/` do apex funde com a `/` dos outros Workers. A allowlist
 *     de host que serve o cadastro da diária é aplicada NA LEITURA, por
 *     `scripts/lib/metrics/ga4-channel.ts` — este script só coleta.
 *   - `channel-group`: sessions por `date`/`sessionDefaultChannelGroup` — o
 *     agrupamento heurístico do próprio Google, coluna de CONFERÊNCIA ao
 *     lado da classificação de `channel` (nunca a fonte da classificação —
 *     ver docstring de `ga4-channel.ts` pro porquê ele diverge da taxonomia
 *     de 5 classes do projeto).
 *
 * Salva snapshot em `data/ga4-cache/{YYYY-MM-DD}.json` (timestamp da
 * execução) + `data/ga4-cache/latest.json` (sempre sobrescrito — ponteiro
 * pro snapshot mais recente, mesmo padrão de `data/beehiiv-cache/`).
 *
 * FAIL-SOFT explícito (a credencial/propriedade ainda não existe nesta
 * sessão — configuração é ação de painel do editor, ver
 * docs/ga4-data-api-setup.md): `GA4_PROPERTY_ID` ausente ou credencial OAuth
 * ausente/sem o scope `analytics.readonly` terminam com mensagem que aponta
 * pro doc de setup, nunca uma stack trace genérica. Exit codes:
 *   0 = sucesso
 *   1 = erro de API/IO (rede, resposta inesperada)
 *   2 = config ausente (property ID ou credencial OAuth)
 *
 * Uso:
 *   npx tsx scripts/ga4-sync.ts                  # janela padrão (7 dias)
 *   npx tsx scripts/ga4-sync.ts --days 30
 *   npx tsx scripts/ga4-sync.ts --dry-run         # monta os relatórios, não chama a API
 *
 * Env:
 *   GA4_PROPERTY_ID   obrigatório — Property ID NUMÉRICO (ex: 123456789),
 *                     não o Measurement ID (G-XXXXXXX). Ver docs/ga4-data-api-setup.md.
 *   data/.credentials.json  com o scope `analytics.readonly` — ver scripts/oauth-setup.ts.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { gFetch, GoogleAuthError } from "./google-auth.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getIntArg, isMainModule } from "./lib/cli-args.ts";
import {
  resolveGa4PropertyId,
  runGa4Report,
  extractReportRows,
  Ga4ConfigError,
  type Ga4RunReportRequest,
  type Ga4FlatRow,
  type Ga4FetchImpl,
} from "./lib/ga4-client.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = resolve(ROOT, "data/ga4-cache");
const DEFAULT_WINDOW_DAYS = 7;
const TOP_PAGES_LIMIT = 25;

/**
 * Teto de linhas do relatório FINO (`channel` — #7184, fatia 12 do épico
 * #7172): 5 dimensões (`date`,`sessionSource`,`sessionMedium`,
 * `sessionCampaignName`,`hostName`), cardinalidade bem mais alta que
 * `topPages` (1 dimensão). 10k cobre folgado a combinatória real da
 * propriedade — efeito de cota: cada `runReport` conta 1 contra o teto
 * diário de `properties.runReport` da Data API (cota gratuita generosa,
 * ver `describeGa4Failure` 429); o custo por chamada não escala com
 * `limit`, só o tamanho da resposta.
 */
const CHANNEL_REPORT_LIMIT = 10_000;

/**
 * Teto de linhas do relatório de CONFERÊNCIA (`channelGroup` —
 * `sessionDefaultChannelGroup`, ~10 grupos possíveis × dias da janela).
 * Bem menor que `CHANNEL_REPORT_LIMIT` porque a cardinalidade é baixa por
 * desenho (é o agrupamento heurístico do próprio Google).
 */
const CHANNEL_GROUP_REPORT_LIMIT = 1_000;

export interface Ga4Snapshot {
  fetched_at: string;
  property_id: string;
  window_days: number;
  overview: Ga4FlatRow[];
  top_pages: Ga4FlatRow[];
  /** Relatório FINO — o que classifica sessões nas 5 classes de F1 via
   *  `scripts/lib/metrics/ga4-channel.ts` (#7184). */
  channel: Ga4FlatRow[];
  /** Relatório de CONFERÊNCIA (`sessionDefaultChannelGroup`, agrupamento
   *  heurístico do Google) — exibido ao lado, NUNCA usado para classificar
   *  (#7184, ver docstring de `ga4-channel.ts` pro porquê ele diverge). */
  channel_group: Ga4FlatRow[];
}

/** Monta os 4 requests desta ingestão (puro — testável sem rede). */
export function buildSyncRequests(
  propertyId: string,
  windowDays: number,
): Record<"overview" | "topPages" | "channel" | "channelGroup", Ga4RunReportRequest> {
  const dateRanges = [{ startDate: `${windowDays}daysAgo`, endDate: "yesterday" }];
  return {
    overview: {
      propertyId,
      dimensions: ["date"],
      metrics: ["sessions", "screenPageViews", "engagedSessions", "averageSessionDuration"],
      dateRanges,
    },
    topPages: {
      propertyId,
      dimensions: ["pagePath"],
      metrics: ["screenPageViews", "averageSessionDuration"],
      dateRanges,
      limit: TOP_PAGES_LIMIT,
    },
    // #7184 — relatório fino: o que classifica sessões nas 5 classes de F1
    // (scripts/lib/metrics/ga4-channel.ts). hostName é obrigatório aqui —
    // sem ele a `/` do apex funde com a `/` de todos os outros Workers da
    // mesma propriedade GA4 (516813959 cobre o Vigil.ia.br inteiro).
    channel: {
      propertyId,
      dimensions: ["date", "sessionSource", "sessionMedium", "sessionCampaignName", "hostName"],
      metrics: ["sessions"],
      dateRanges,
      limit: CHANNEL_REPORT_LIMIT,
    },
    // #7184 — relatório de conferência, exibido ao lado (nunca usado para
    // classificar — ver docstring de ga4-channel.ts).
    channelGroup: {
      propertyId,
      dimensions: ["date", "sessionDefaultChannelGroup"],
      metrics: ["sessions"],
      dateRanges,
      limit: CHANNEL_GROUP_REPORT_LIMIT,
    },
  };
}

async function fetchSnapshot(propertyId: string, windowDays: number, fetchImpl: Ga4FetchImpl): Promise<Ga4Snapshot> {
  const requests = buildSyncRequests(propertyId, windowDays);
  const [overviewRes, topPagesRes, channelRes, channelGroupRes] = await Promise.all([
    runGa4Report(requests.overview, fetchImpl),
    runGa4Report(requests.topPages, fetchImpl),
    runGa4Report(requests.channel, fetchImpl),
    runGa4Report(requests.channelGroup, fetchImpl),
  ]);
  return {
    fetched_at: new Date().toISOString(),
    property_id: propertyId,
    window_days: windowDays,
    overview: extractReportRows(overviewRes),
    top_pages: extractReportRows(topPagesRes),
    channel: extractReportRows(channelRes),
    channel_group: extractReportRows(channelGroupRes),
  };
}

function saveSnapshot(snapshot: Ga4Snapshot): { datedPath: string; latestPath: string } {
  mkdirSync(CACHE_DIR, { recursive: true });
  const dateStr = snapshot.fetched_at.slice(0, 10);
  const datedPath = resolve(CACHE_DIR, `${dateStr}.json`);
  const latestPath = resolve(CACHE_DIR, "latest.json");
  const json = JSON.stringify(snapshot, null, 2);
  writeFileSync(datedPath, json, "utf8");
  writeFileSync(latestPath, json, "utf8");
  return { datedPath, latestPath };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  let days: number;
  try {
    days = getIntArg(argv, "days", { min: 1 }) ?? DEFAULT_WINDOW_DAYS;
  } catch (e) {
    console.error(`[ga4-sync] ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }

  let propertyId: string;
  try {
    propertyId = resolveGa4PropertyId();
  } catch (e) {
    if (e instanceof Ga4ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }

  if (dryRun) {
    const requests = buildSyncRequests(propertyId, days);
    console.log(JSON.stringify({ dry_run: true, property_id: propertyId, window_days: days, requests }, null, 2));
    return;
  }

  let snapshot: Ga4Snapshot;
  try {
    snapshot = await fetchSnapshot(propertyId, days, gFetch);
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      console.error(`[ga4-sync] ${e.message}`);
      process.exit(2);
    }
    console.error(`[ga4-sync] falha na ingestão: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const { datedPath, latestPath } = saveSnapshot(snapshot);
  console.log(
    JSON.stringify(
      {
        ok: true,
        property_id: propertyId,
        window_days: days,
        overview_rows: snapshot.overview.length,
        top_pages_rows: snapshot.top_pages.length,
        channel_rows: snapshot.channel.length,
        channel_group_rows: snapshot.channel_group.length,
        saved_to: [datedPath, latestPath],
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[ga4-sync] erro fatal: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
