#!/usr/bin/env node
/**
 * scripts/verify-clarice-monthly-coverage.ts (#9837)
 *
 * Verifica, SÓ COM LEITURA, se "Totais por mês" do painel Clarice cobre toda
 * campanha `sent` da conta: por mês, contagem e 1º/último envio do agregado
 * do painel contra `GET /v3/emailCampaigns?status=sent` da Brevo. É a
 * verificação por script que a "Definição de feito" da #9837 pede no lugar
 * de inspeção visual da tabela.
 *
 * Fontes (nenhuma escrita em lugar nenhum):
 *   - Brevo (`BREVO_CLARICE_API_KEY`): listagem completa paginada de 100 em
 *     100 — ~4 requests na conta Clarice (100 req/HORA por conta, #5215).
 *     Antes de gastar, `assertCampaignQuotaHeadroom` com a mesma reserva de
 *     30 do backfill: cota baixa → sai com 2 sem chamar nada.
 *   - KV de produção do painel (`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN`):
 *     `dash:campaigns:archive-index` + existência de `stats:{id}` por
 *     entrada (o render descarta entrada sem stats). Leitura via
 *     `getTextFromWorkerKV`, que LANÇA em erro — ao contrário do
 *     `RemoteKvNamespace.get` fail-soft, que transformaria uma falha de
 *     leitura em "sem stats" e inventaria divergência.
 *
 * A composição painel = janela ao vivo (as 100 mais recentes da MESMA
 * listagem) + arquivo com stats replica `renderDashboardHtml` →
 * `aggregateByMonth`; ver `scripts/lib/clarice-monthly-coverage.ts`.
 *
 * Uso:
 *   npx tsx scripts/verify-clarice-monthly-coverage.ts          # relatório em texto
 *   npx tsx scripts/verify-clarice-monthly-coverage.ts --json   # resultado estruturado
 *
 * Saída: 0 = todo mês bate; 1 = divergência; 2 = não deu pra verificar
 * (credencial ausente, cota baixa, erro de rede) — nunca vira "ok".
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  fetchCampaignsListPage,
  mapLimit,
  setCampaignQuotaStateObserver,
  CAMPAIGNS_ARCHIVE_INDEX_KV_KEY,
  CAMPAIGNS_FETCH_LIMIT,
} from "../workers/brevo-dashboard/src/brevo-api.ts";
import type { Env } from "../workers/brevo-dashboard/src/types.ts";
import { getTextFromWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import {
  assertCampaignQuotaHeadroom,
  BrevoCampaignQuotaLowError,
  recordCampaignQuotaRemaining,
} from "./lib/brevo-rate-state.ts";
import {
  buildDashboardCoverage,
  compareMonthlyCoverage,
  formatMonthlyCoverageReport,
  type CoverageCampaign,
} from "./lib/clarice-monthly-coverage.ts";
import { STATS_CACHE_KV_NAMESPACE_ID, CAMPAIGNS_FETCH_RESERVE } from "./clarice-backfill-campaigns.ts";

const LOG_PREFIX = "[verify-clarice-monthly-coverage]";
const PAGE_SIZE = 100;
/** Teto de páginas (10k campanhas) — guarda contra loop se a API devolver
 * `count` absurdo. */
const MAX_PAGES = 100;
const KV_CONCURRENCY = 8;

/** Lista TODAS as campanhas `sent` (mais recente primeiro). Exportada pra teste. */
export async function fetchAllSentCampaigns(
  env: Env,
  fetchPage: typeof fetchCampaignsListPage = fetchCampaignsListPage,
): Promise<CoverageCampaign[]> {
  const out: CoverageCampaign[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const res = await fetchPage(env, { limit: PAGE_SIZE, offset });
    for (const c of res.campaigns) out.push({ id: c.id, sentDate: c.sentDate ?? null });
    if (res.campaigns.length < PAGE_SIZE) return out;
    if (res.count != null && offset + PAGE_SIZE >= res.count) return out;
  }
  throw new Error(`listagem passou de ${MAX_PAGES} páginas — abortando em vez de verificar uma lista truncada`);
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = hasFlag(argv, "json");

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN;
  if (!apiKey || !accountId || !token) {
    console.error(
      `${LOG_PREFIX} não dá pra verificar: falta ${[
        !apiKey && "BREVO_CLARICE_API_KEY",
        !accountId && "CLOUDFLARE_ACCOUNT_ID",
        !token && "CLOUDFLARE_WORKERS_TOKEN",
      ].filter(Boolean).join(", ")} no ambiente/.env.`,
    );
    process.exitCode = 2;
    return;
  }

  setCampaignQuotaStateObserver((remaining, limit) => {
    if (remaining == null) return;
    recordCampaignQuotaRemaining(remaining, limit ?? undefined);
  });
  try {
    assertCampaignQuotaHeadroom(CAMPAIGNS_FETCH_RESERVE);
  } catch (e) {
    if (e instanceof BrevoCampaignQuotaLowError) {
      console.error(`${LOG_PREFIX} cota Brevo baixa (remaining=${e.remaining} < ${e.minRemaining}) — não verifiquei nada.`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }

  const env = { BREVO_API_KEY: apiKey } as unknown as Env;
  const kvCfg = { accountId, token, kvNamespaceId: STATS_CACHE_KV_NAMESPACE_ID };

  let listing: CoverageCampaign[];
  let archiveIndex: CoverageCampaign[];
  let idsWithStats: Set<number>;
  try {
    listing = await fetchAllSentCampaigns(env);
    const rawIndex = await getTextFromWorkerKV(CAMPAIGNS_ARCHIVE_INDEX_KV_KEY, kvCfg);
    const parsed: unknown = rawIndex ? JSON.parse(rawIndex) : [];
    if (!Array.isArray(parsed)) throw new Error(`${CAMPAIGNS_ARCHIVE_INDEX_KV_KEY} não é array`);
    archiveIndex = (parsed as Array<{ id: number; sentDate: string | null }>).map((a) => ({ id: a.id, sentDate: a.sentDate ?? null }));
    const present = await mapLimit(archiveIndex, KV_CONCURRENCY, async (a) =>
      (await getTextFromWorkerKV(`stats:${a.id}`, kvCfg)) != null ? a.id : null,
    );
    idsWithStats = new Set(present.filter((id): id is number => id != null));
  } catch (e) {
    console.error(`${LOG_PREFIX} não dá pra verificar (leitura falhou):`, e instanceof Error ? e.message : e);
    process.exitCode = 2;
    return;
  }

  const dashboard = buildDashboardCoverage(listing, archiveIndex, idsWithStats, CAMPAIGNS_FETCH_LIMIT);
  const result = compareMonthlyCoverage(listing, dashboard.campaigns);

  if (asJson) {
    console.log(JSON.stringify({ ...result, archivedWithoutStats: dashboard.archivedWithoutStats, brevoTotal: listing.length }, null, 2));
  } else {
    console.log(`${LOG_PREFIX} ${listing.length} campanhas sent na Brevo; janela ao vivo ${CAMPAIGNS_FETCH_LIMIT}; ${archiveIndex.length} no índice de arquivo.`);
    console.log(formatMonthlyCoverageReport(result, { archivedWithoutStats: dashboard.archivedWithoutStats }));
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} falhou:`, e instanceof Error ? e.message : e);
    process.exitCode = 2;
  });
}
