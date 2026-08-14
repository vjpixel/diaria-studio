#!/usr/bin/env node
/**
 * push-clarice-hour-test-kv.ts (#5189)
 *
 * Empurra o estado (janela ativa) do teste de HORÁRIO da onda ramp-warm
 * (`data/clarice-hour-test.json`, `scripts/lib/clarice-hour-test.ts`) pro KV
 * do worker `brevo-dashboard`, sob a chave singleton `HOUR_TEST_KV_KEY`
 * (`clarice:hourtest:state`) — fonte que `aggregateHourTest`
 * (workers/brevo-dashboard/src/sections-core.ts) usa pra escopar a leitura à
 * janela do teste ATIVO/mais recente, em vez de acumular TODA a história de
 * campanhas H0N já enviadas.
 *
 * Bug que isto fecha (#5189, achado no self-review do #5188/#5154): sem uma
 * janela conhecida pelo Worker, encerrar o teste e reabri-lo no futuro
 * reusando as mesmas horas (ex: H06/H10 de novo, em outro ciclo mensal)
 * misturaria os dois testes na leitura do dashboard, sem nenhum sinal — o
 * naming da campanha (`Clarice {yymm} grupo:{key}-H{HH}`) só carrega o ciclo
 * DIÁRIO "yymm", não um identificador de janela de teste.
 *
 * Diferente de `push-link-sections-kv.ts` (script EXPLÍCITO, nunca chamado
 * automaticamente pelo caminho de render nem de escrita — decisão do editor,
 * #4184), este É chamado automaticamente por `clarice-hour-test.ts` sempre
 * que o estado muda (`--start`/`--close`), fail-soft (nunca bloqueia a
 * escrita LOCAL, que é a fonte de verdade) — mesmo racional de
 * `close-poll.ts` chamando `sync-intentional-error.ts` internamente (#3210):
 * o estado precisa chegar no Worker o quanto antes, sem depender de o editor
 * lembrar de um passo manual extra (a issue #5189 pede explicitamente que o
 * mecanismo já exista ANTES do teste rodar de verdade pela 1ª vez).
 *
 * Uso (manual — ex: backfill depois de editar `data/clarice-hour-test.json`
 * à mão, ou se o push automático de `clarice-hour-test.ts` falhou):
 *   npx tsx scripts/push-clarice-hour-test-kv.ts [--dry-run]
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID     obrigatório p/ upload KV
 *   CLOUDFLARE_WORKERS_TOKEN  obrigatório p/ upload KV (permissão Workers KV)
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { readClariceHourTestState, toHourTestKvState } from "./lib/clarice-hour-test.ts";
import { HOUR_TEST_KV_KEY } from "../workers/brevo-dashboard/src/types.ts";

loadProjectEnv();

export { HOUR_TEST_KV_KEY };

/**
 * Lê o estado LOCAL (`data/clarice-hour-test.json`, via
 * `readClariceHourTestState` — fail-soft, nunca lança) e empurra a projeção
 * slim (`toHourTestKvState`) pro KV. `--dry-run` computa e imprime, mas NÃO
 * grava. Exportada pra ser chamada tanto pela CLI abaixo quanto,
 * fail-soft, pelo CLI de `clarice-hour-test.ts` (`--start`/`--close`).
 */
export async function pushClariceHourTestState(rootDir: string, dryRun: boolean): Promise<void> {
  const state = readClariceHourTestState(rootDir);
  const payload = toHourTestKvState(state);
  const armsLabel = payload.status !== "inativo" ? ` (braços ${payload.hoursBrt.join(",")})` : "";
  console.log(`[push-clarice-hour-test-kv] estado: ${payload.status}${armsLabel}.`);
  const json = JSON.stringify(payload);
  if (dryRun) {
    console.log(`[push-clarice-hour-test-kv] --dry-run:`, json);
    return;
  }
  await uploadTextToWorkerKV(json, HOUR_TEST_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
    contentType: "application/json",
  });
  console.log(`[push-clarice-hour-test-kv] KV atualizado: ${HOUR_TEST_KV_KEY}.`);
}

if (isMainModule(import.meta.url)) {
  const dryRun = hasFlag(process.argv, "dry-run");
  pushClariceHourTestState(process.cwd(), dryRun).catch((e) => {
    console.error("[push-clarice-hour-test-kv] erro:", e);
    process.exit(1);
  });
}
