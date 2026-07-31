#!/usr/bin/env node
/**
 * clarice-novos-html-state.ts (#4347 Etapa 4, D12)
 *
 * CLI fina sobre `scripts/lib/clarice-novos-state.ts` — calcula o SHA-256 do
 * `cloudflare-preview.html` do ciclo resolvido e decide se `--send-test`
 * deve rodar nesta invocação de `clarice-schedule-group.ts` (D12: pular
 * quando idêntico ao da última rodada — o digest mensal muda ~1x/mês, a
 * skill roda ~4×/semana).
 *
 * Uso:
 *   npx tsx scripts/clarice-novos-html-state.ts --cycle 2606-07
 *     # imprime { htmlSha256, shouldSendTest, previousState }
 *   npx tsx scripts/clarice-novos-html-state.ts --cycle 2606-07 --finalize \
 *     --list-id 123 --campaign-id 456 [--sent-count 87]
 *     # grava o state (lastRunAt=agora, lastHtmlSha256=sha atual, sentCount
 *     # ACUMULADO — soma sent-count desta rodada ao total anterior)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { monthlyDir } from "./lib/mensal/monthly-paths.ts";
import { readNovosState, writeNovosState, sha256Hex, shouldSendTest, type NovosState } from "./lib/clarice-novos-state.ts";

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

  if (hasFlag(argv, "finalize")) {
    const listIdRaw = getArg(argv, "list-id");
    const campaignIdRaw = getArg(argv, "campaign-id");
    const sentCountRaw = getArg(argv, "sent-count");
    const prev = readNovosState(dataRootArg);
    const listId = listIdRaw ? Number(listIdRaw) : NaN;
    const campaignId = campaignIdRaw ? Number(campaignIdRaw) : NaN;
    const state: NovosState = {
      lastRunAt: new Date().toISOString(),
      lastHtmlSha256: sha,
      lastCycle: cycle,
      lastListId: Number.isFinite(listId) ? listId : (prev?.lastListId ?? null),
      lastCampaignId: Number.isFinite(campaignId) ? campaignId : (prev?.lastCampaignId ?? null),
      sentCount: (prev?.sentCount ?? 0) + (sentCountRaw ? Number(sentCountRaw) || 0 : 0),
    };
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

if (isMainModule(import.meta.url)) {
  main();
}
