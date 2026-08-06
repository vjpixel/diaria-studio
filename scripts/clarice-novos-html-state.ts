#!/usr/bin/env node
/**
 * clarice-novos-html-state.ts (#4347 Etapa 4 D12; agendamento #4670)
 *
 * CLI fina sobre `scripts/lib/clarice-novos-state.ts` — calcula o SHA-256 do
 * `cloudflare-preview.html` do ciclo resolvido e decide se `--send-test`
 * deve rodar nesta invocação de `clarice-schedule-group.ts` (D12: pular
 * quando idêntico ao da última rodada — o digest mensal muda ~1x/mês, a
 * skill roda ~4×/semana).
 *
 * #4670: o `--finalize` original assumia disparo SEMPRE imediato. Quando o
 * envio do grupo `novos` é AGENDADO (não `--send-now`), `--finalize-scheduled`
 * grava o SHA (mata o `--send-test` redundante) e registra `pendingSend` —
 * SEM somar `sentCount`, porque o disparo ainda não aconteceu. `--reconcile`
 * consulta a Brevo (ao vivo, fora de teste) e resolve `pendingSend` sozinho:
 * confirmado → finaliza; ainda na fila → nada muda; cancelado/status
 * inesperado → limpa sem contar como enviado.
 *
 * Uso:
 *   npx tsx scripts/clarice-novos-html-state.ts --cycle 2606-07
 *     # imprime { htmlSha256, shouldSendTest, previousState }
 *   npx tsx scripts/clarice-novos-html-state.ts --cycle 2606-07 --finalize \
 *     --list-id 123 --campaign-id 456 [--sent-count 87]
 *     # disparo CONFIRMADO — grava o state (lastRunAt=agora, lastHtmlSha256=sha
 *     # atual, sentCount ACUMULADO); limpa pendingSend se o campaignId bater
 *   npx tsx scripts/clarice-novos-html-state.ts --cycle 2606-07 --finalize-scheduled \
 *     --list-id 123 --campaign-id 456 --scheduled-at 2026-08-06T10:00:00-03:00 --sent-count 70
 *     # campanha AGENDADA, disparo ainda não confirmado — grava SHA +
 *     # pendingSend; NÃO soma sentCount
 *   npx tsx scripts/clarice-novos-html-state.ts --reconcile
 *     # consulta a Brevo pro pendingSend (se houver) e resolve sozinho —
 *     # requer BREVO_CLARICE_API_KEY/BREVO_API_KEY; nunca rodado nos testes
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getArg, getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { monthlyDir } from "./lib/mensal/monthly-paths.ts";
import { brevoGetCampaign } from "./lib/brevo-client.ts";
import {
  readNovosState,
  writeNovosState,
  sha256Hex,
  shouldSendTest,
  buildFinalizeScheduledState,
  buildFinalizeState,
  reconcilePendingSend,
} from "./lib/clarice-novos-state.ts";

export function main(argv: string[] = process.argv.slice(2)): void {
  const cycle = getArg(argv, "cycle");
  if (!cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2606-07).");
    process.exit(1);
  }
  // #4347: --data-root é OPCIONAL, uso interno de teste (mesmo padrão do
  // resto do projeto) — substitui a raiz de produção na leitura/escrita do
  // state file (não afeta a resolução do HTML, que segue `monthlyDir`).
  const dataRootArg = getArg(argv, "data-root") || undefined;
  const htmlPath = resolve(monthlyDir(cycle, { allowLegacyFallback: false }), "_internal", "cloudflare-preview.html");
  if (!existsSync(htmlPath)) {
    console.error(`❌ HTML não encontrado: ${htmlPath}`);
    process.exit(1);
  }
  const sha = sha256Hex(readFileSync(htmlPath, "utf8"));

  if (hasFlag(argv, "finalize-scheduled")) {
    let listId: number | undefined;
    let campaignId: number | undefined;
    let scheduledAt: string | undefined;
    let contactCount: number;
    try {
      listId = getIntArg(argv, "list-id", { min: 1 });
      campaignId = getIntArg(argv, "campaign-id", { min: 1 });
      scheduledAt = getStringArg(argv, "scheduled-at", { example: "2026-08-06T10:00:00-03:00" });
      contactCount = getIntArg(argv, "sent-count") ?? 0;
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    }
    if (listId === undefined || campaignId === undefined || !scheduledAt) {
      console.error("--finalize-scheduled requer --list-id, --campaign-id e --scheduled-at.");
      process.exit(1);
    }
    const prev = readNovosState(dataRootArg);
    const state = buildFinalizeScheduledState(prev, {
      htmlSha256: sha,
      cycle,
      listId,
      campaignId,
      scheduledAt,
      contactCount,
    });
    writeNovosState(state, dataRootArg);
    console.error(
      `✓ state gravado (AGENDADO, pendente de confirmação) — campaignId=${campaignId} listId=${listId} ` +
        `scheduledAt=${scheduledAt} contactCount=${contactCount}. Rode --reconcile ou --finalize depois de confirmar o disparo.`,
    );
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (hasFlag(argv, "finalize")) {
    let listIdRaw: number | undefined;
    let campaignIdRaw: number | undefined;
    let sentCountDelta: number;
    try {
      listIdRaw = getIntArg(argv, "list-id", { min: 1 });
      campaignIdRaw = getIntArg(argv, "campaign-id", { min: 1 });
      sentCountDelta = getIntArg(argv, "sent-count") ?? 0;
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    }
    const prev = readNovosState(dataRootArg);
    const state = buildFinalizeState(prev, {
      htmlSha256: sha,
      cycle,
      listId: listIdRaw ?? null,
      campaignId: campaignIdRaw ?? null,
      sentCountDelta,
    });
    writeNovosState(state, dataRootArg);
    console.error(`✓ state gravado — lastCycle=${state.lastCycle} sentCount=${state.sentCount}`);
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  const prev = readNovosState(dataRootArg);
  const send = shouldSendTest(sha, prev);
  console.error(send ? "✓ SHA mudou (ou 1ª rodada) — --send-test deve rodar." : "↷ SHA idêntico à última rodada (D12) — pulando --send-test.");
  console.log(JSON.stringify({ htmlSha256: sha, shouldSendTest: send, previousState: prev }, null, 2));
}

/**
 * `--reconcile` (#4670): consulta a Brevo AO VIVO pro `pendingSend` (se
 * houver) e resolve sozinho — nunca chamado pelos testes deste módulo (só a
 * lógica pura `reconcilePendingSend`, com `fetchStatus` mockado, é testada).
 * Não precisa de `--cycle`/HTML — reconciliação é sobre o estado de ENVIO,
 * não de conteúdo.
 */
export async function runReconcile(argv: string[]): Promise<void> {
  const dataRootArg = getArg(argv, "data-root") || undefined;
  const prev = readNovosState(dataRootArg);
  if (!prev?.pendingSend) {
    console.error("↷ nenhum envio agendado pendente — nada a reconciliar.");
    console.log(JSON.stringify({ action: "no-pending" }, null, 2));
    return;
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY ?? process.env.BREVO_API_KEY ?? "";
  if (!apiKey) {
    console.error("❌ BREVO_CLARICE_API_KEY (ou BREVO_API_KEY) não definido — não é possível reconciliar.");
    process.exit(1);
  }

  const result = await reconcilePendingSend(prev, async (campaignId) => {
    const c = await brevoGetCampaign(apiKey, campaignId);
    return { status: c.status };
  });

  if (result.action !== "no-pending") writeNovosState(result.state, dataRootArg);

  const icon = result.action === "finalized" ? "✓" : result.action === "cancelled" ? "⚠" : "↷";
  console.error(`${icon} ${result.detail}`);
  console.log(JSON.stringify({ action: result.action, state: result.state }, null, 2));
}

if (isMainModule(import.meta.url)) {
  loadProjectEnv();
  if (hasFlag(process.argv.slice(2), "reconcile")) {
    runReconcile(process.argv.slice(2)).catch((e) => {
      console.error("[clarice-novos-html-state] erro na reconciliação:", e);
      process.exit(1);
    });
  } else {
    main();
  }
}
