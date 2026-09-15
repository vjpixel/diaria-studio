#!/usr/bin/env node
/**
 * scripts/clarice-backfill-campaigns.ts (#8115, Fatia B do #6720)
 *
 * "Totais por mês" no painel Clarice (`workers/brevo-dashboard`) só enxerga
 * as `CAMPAIGNS_FETCH_LIMIT` (100) campanhas `sent` mais recentes — teto da
 * própria API Brevo (`/v3/emailCampaigns` rejeita `limit > 100`). Meses mais
 * antigos que ~3 semanas de cadência atual aparecem incompletos ou somem da
 * tabela (aviso "(parcial — janela de 100 campanhas)", #3080).
 *
 * Este script faz o BACKFILL throttled/retomável do histórico ALÉM dessa
 * janela, direto no KV de PRODUÇÃO do Worker (`STATS_CACHE`, namespace
 * `2f87d65d735c499ab8f465774d0167e2`), reusando o miolo pure/testável de
 * `runCampaignsBackfillBatch` (`workers/brevo-dashboard/src/brevo-api.ts`):
 *
 *   1. Mede o total de campanhas `sent` na conta (1 GET barato, `limit=1`).
 *   2. Avança um CURSOR retomável por offset (persistido em
 *      `dash:campaigns:backfill-cursor` no KV), buscando um lote pequeno
 *      por invocação (default 20 campanhas) além da janela ao vivo.
 *   3. Pra cada campanha IMUTÁVEL (>7 dias, `isImmutableCampaign`) ainda sem
 *      stats cacheados, faz 1 GET de `globalStats` e grava em `stats:{id}`
 *      — MESMA chave sem TTL que `fetchRecentCampaigns` já usa pra
 *      campanhas imutáveis dentro da janela. Custo pago 1x por campanha;
 *      uma 2ª invocação sobre a mesma faixa de offset não refaz o GET.
 *   4. Registra metadado mínimo (id, nome, sentDate, listas) em
 *      `dash:campaigns:archive-index` — é esse índice que lista QUAIS
 *      campanhas existem fora da janela ao vivo (sem ele, `stats:{id}`
 *      sozinho não tem como ser descoberto por id).
 *
 * **Integração no RENDER de "Totais por mês" (ler o índice + `stats:{id}`
 * históricos e combinar com a janela ao vivo, removendo o rótulo "parcial"
 * quando completo) é o PRÓXIMO PASSO, fora do escopo desta fatia** — ver
 * `REFS #8115` no PR que introduziu este script. Esta fatia entrega medição
 * + paginação + persistência do backfill; o consumo no dashboard fica pro
 * PR seguinte.
 *
 * **Gate de rate limit — OBRIGATÓRIO, nunca pulado.** As chamadas usam
 * `BREVO_CLARICE_API_KEY`, a MESMA credencial da conta Clarice compartilhada
 * com o envio diário e `clarice-novos` (100 req/HORA por CONTA, não por key
 * — #5215/#5219, `docs/brevo-rate-limits.md`). Por isso este script chama
 * `assertCampaignQuotaHeadroom` (mesma reserva de 30 que `dashboard-clarice.ts`
 * usa, #5697/#6029) ANTES de qualquer request — se a cota horária observada
 * estiver abaixo da reserva, aborta sem gastar nada, deixando o balde
 * inteiro pro envio real. `runCampaignsBackfillBatch` em si NÃO faz essa
 * checagem (roda também dentro do Worker Cloudflare, sem `node:fs` — ver o
 * comentário no topo da seção #8115 em `brevo-api.ts`); é responsabilidade
 * de quem chama, e este script é o único caller hoje.
 *
 * Uso:
 *   npx tsx scripts/clarice-backfill-campaigns.ts                # 1 batch (20 campanhas)
 *   npx tsx scripts/clarice-backfill-campaigns.ts --batch-size 10
 *   npx tsx scripts/clarice-backfill-campaigns.ts --dry-run       # só mede o total, não gasta quota de stats nem escreve
 *
 * Idempotente/retomável: sem varredura completa obrigatória — pode ser
 * chamado repetidamente (cron futuro, ou manualmente) sem duplicar trabalho
 * nem estourar o rate limit. Rodar de novo continua do offset salvo no KV.
 *
 * Requer: `BREVO_CLARICE_API_KEY` (envio Brevo da conta Clarice) e
 * `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN` (acesso ao KV real via
 * `RemoteKvNamespace` — mesmas credenciais usadas por outros scripts que
 * leem/escrevem o KV de produção, ex: `readKvTabs` em `dashboard-clarice.ts`).
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { hasFlag, isMainModule, getIntArg } from "./lib/cli-args.ts";
import {
  runCampaignsBackfillBatch,
  fetchCampaignsCount,
  setCampaignQuotaStateObserver,
  CAMPAIGNS_FETCH_LIMIT,
} from "../workers/brevo-dashboard/src/brevo-api.ts";
import { createRemoteKvNamespace } from "./lib/cloudflare-kv-upload.ts";
import {
  assertCampaignQuotaHeadroom,
  BrevoCampaignQuotaLowError,
  recordCampaignQuotaRemaining,
} from "./lib/brevo-rate-state.ts";
import type { Env } from "../workers/brevo-dashboard/src/types.ts";

const LOG_PREFIX = "[clarice-backfill-campaigns]";

/** Namespace `STATS_CACHE` do Worker `clarice-dashboard` — ver
 * `workers/brevo-dashboard/wrangler.toml`. MESMO namespace que
 * `fetchRecentCampaigns` lê/escreve em produção. */
export const STATS_CACHE_KV_NAMESPACE_ID = "2f87d65d735c499ab8f465774d0167e2";

/** Mesma reserva usada por `dashboard-clarice.ts` (`CAMPAIGNS_FETCH_RESERVE`,
 * #5697/#6029) — 30 de headroom mínimo antes de gastar quota num sweep. */
export const CAMPAIGNS_FETCH_RESERVE = 30;

/** Default de campanhas processadas por invocação — pequeno de propósito
 * (issue #8115: "N campanhas por invocação, nunca uma varredura completa"). */
export const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 50; // mesmo teto de página que a API Brevo aceita

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const batchSize = getIntArg(argv, "batch-size", { min: 1, max: MAX_BATCH_SIZE }) ?? DEFAULT_BATCH_SIZE;

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error(`${LOG_PREFIX} BREVO_CLARICE_API_KEY ausente no ambiente/.env — abortando.`);
    process.exitCode = 1;
    return;
  }

  // #6029/#5697: ponte brevoFetch → data/brevo-rate-state.json, mesmo padrão
  // de dashboard-clarice.ts — toda resposta da família /emailCampaigns* que
  // ESTE processo observar atualiza o estado de cota compartilhado.
  setCampaignQuotaStateObserver((remaining, limit) => {
    if (remaining == null) return;
    recordCampaignQuotaRemaining(remaining, limit ?? undefined);
  });

  try {
    assertCampaignQuotaHeadroom(CAMPAIGNS_FETCH_RESERVE);
  } catch (e) {
    if (e instanceof BrevoCampaignQuotaLowError) {
      console.warn(
        `${LOG_PREFIX} cota Brevo baixa (remaining=${e.remaining} < ${e.minRemaining}) — ` +
          `pulando esta rodada de backfill sem gastar quota (o envio real tem prioridade).`,
      );
      return;
    }
    throw e;
  }

  const kv = createRemoteKvNamespace(STATS_CACHE_KV_NAMESPACE_ID);
  if (!kv) {
    console.error(
      `${LOG_PREFIX} CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN ausentes — sem acesso ao KV de ` +
        `produção do painel Clarice, abortando (nenhuma chamada Brevo foi feita).`,
    );
    process.exitCode = 1;
    return;
  }

  const env = { BREVO_API_KEY: apiKey, STATS_CACHE: kv } as unknown as Env;

  if (dryRun) {
    const count = await fetchCampaignsCount(env);
    console.log(
      `${LOG_PREFIX} --dry-run: ${count ?? "desconhecido (GET falhou)"} campanhas 'sent' na conta; ` +
        `a janela ao vivo do painel cobre as ${CAMPAIGNS_FETCH_LIMIT} mais recentes — nenhum GET de ` +
        `stats nem write no KV foram feitos.`,
    );
    return;
  }

  const result = await runCampaignsBackfillBatch(env, { batchSize });
  console.log(
    `${LOG_PREFIX} offset=${result.cursor.offset}/${result.cursor.totalCount ?? "?"} ` +
      `escaneadas=${result.scanned} stats-novos=${result.statsFetched} já-cacheadas=${result.alreadyCached} ` +
      `mutáveis-puladas=${result.skippedMutable} done=${result.cursor.done} (requests Brevo=${result.requestsUsed})`,
  );
  if (result.cursor.done) {
    console.log(`${LOG_PREFIX} backfill completo — nenhuma campanha histórica pendente no momento.`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} falhou:`, e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
