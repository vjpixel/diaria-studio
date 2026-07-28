#!/usr/bin/env node
/**
 * push-link-titles-kv.ts (#4198)
 *
 * Empurra o mapa CONTEÚDO BASE→TÍTULO editorial de um ciclo mensal pro KV do
 * worker `clarice-dashboard`, sob a chave `titulo:{ciclo}` — sibling de
 * `scripts/push-link-sections-kv.ts` (#4184), mesma estrutura, trocando o
 * mapa de SEÇÃO pelo de TÍTULO. Fonte que alimenta o rótulo legível da coluna
 * "Conteúdo" nas tabelas de link do dashboard público
 * (workers/brevo-dashboard/src/render-links.ts) — substitui rótulos opacos
 * derivados de URL (ex: "B0249coGp (link.amazon)") pelo título editorial já
 * escrito em `prioritized.md` (ex: "Como ter acesso à Alexa+").
 *
 * Deliberadamente um script EXPLÍCITO, NUNCA chamado pelo caminho de render
 * do painel (mesma decisão do editor que #4184 já documenta) — o #4186 já
 * documenta que abrir o painel Studio local consome quota Brevo de produção
 * e escreve no KV público sem lock; este recurso novo não deve se somar a
 * esse padrão. O painel Studio NÃO usa este script nem o KV — monta o mesmo
 * mapa em memória, ao vivo, a partir do `prioritized.md` local (ver
 * `scripts/studio-ui/dashboard-clarice.ts::buildLinkTitlesByCycleLocal`).
 *
 * Fonte: `data/monthly/{ciclo}/prioritized.md` (linha `TÍTULO — URL`, ver
 * `scripts/lib/mensal/monthly-link-sections.ts` pro parser
 * `parsePrioritizedUrlTitles`/`buildLinkTitleMap`/`loadLinkTitleMapForCycle`).
 * Sem `utm_term`, sem alterar nenhum link de saída — retroativo de imediato,
 * não depende de reenviar nada.
 *
 * Uso:
 *   npx tsx scripts/push-link-titles-kv.ts --cycle 2606-07 [--dry-run]
 *   npx tsx scripts/push-link-titles-kv.ts --all [--dry-run]
 *
 *   --cycle YYMM-MM   ciclo único a empurrar (ex: 2606-07).
 *   --all             empurra TODOS os ciclos encontrados em data/monthly/
 *                      que tenham prioritized.md (backfill dos ciclos existentes).
 *   --dry-run         computa e imprime o mapa, mas NÃO grava no KV.
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID     obrigatório p/ upload KV
 *   CLOUDFLARE_WORKERS_TOKEN  obrigatório p/ upload KV (permissão Workers KV)
 *
 * Execução real (contra o KV de produção) fica a cargo do editor/coordenador
 * — este script não é chamado automaticamente por nenhum stage do pipeline
 * nem por nenhum outro script. Indo além disso: mesmo depois deste script
 * rodar de verdade, o título só aparece no dashboard AO VIVO depois de
 * `wrangler deploy` do worker `brevo-dashboard` (esta PR só landa o código
 * que LÊ `titulo:{ciclo}` — ver `workers/brevo-dashboard/src/brevo-api.ts::readLinkTitlesByCycle`
 * e o call site em `index.ts`).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { isValidMonthlyCycle } from "./lib/mensal/monthly-paths.ts";
import { loadLinkTitleMapForCycle } from "./lib/mensal/monthly-link-sections.ts";
import { linkTitlesKvKey } from "../workers/brevo-dashboard/src/types.ts";
import { discoverCyclesWithPrioritized } from "./push-link-sections-kv.ts"; // #4198: genérico sobre "tem prioritized.md", reusado tal qual

loadProjectEnv();

export { linkTitlesKvKey };

async function pushCycle(cycle: string, dryRun: boolean): Promise<void> {
  const map: Record<string, string> | null = loadLinkTitleMapForCycle(cycle);
  if (!map) {
    console.warn(`[push-link-titles-kv] ${cycle}: sem prioritized.md (ou data/ inacessível) — pulando.`);
    return;
  }
  const entries = Object.keys(map).length;
  console.log(`[push-link-titles-kv] ${cycle}: ${entries} título(s) mapeado(s).`);
  if (dryRun) {
    console.log(`[push-link-titles-kv] --dry-run (${cycle}):`, JSON.stringify(map, null, 2));
    return;
  }
  const json = JSON.stringify(map);
  await uploadTextToWorkerKV(json, linkTitlesKvKey(cycle), {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
    contentType: "application/json",
  });
  console.log(`[push-link-titles-kv] KV atualizado: ${linkTitlesKvKey(cycle)}.`);
}

async function main(): Promise<void> {
  const dryRun = hasFlag(process.argv, "dry-run");
  const cycleArg = getArg(process.argv, "cycle");
  const all = hasFlag(process.argv, "all");

  if (!cycleArg && !all) {
    console.error(
      "Uso: push-link-titles-kv.ts --cycle YYMM-MM [--dry-run]\n" +
        "  ou: push-link-titles-kv.ts --all [--dry-run]  (backfill dos ciclos existentes)",
    );
    process.exit(2);
    return;
  }

  if (all) {
    const cycles = discoverCyclesWithPrioritized();
    if (cycles.length === 0) {
      console.error("[push-link-titles-kv] nenhum ciclo com prioritized.md encontrado em data/monthly/.");
      process.exit(1);
      return;
    }
    console.log(`[push-link-titles-kv] --all: ${cycles.length} ciclo(s) encontrado(s): ${cycles.join(", ")}`);
    for (const cycle of cycles) {
      await pushCycle(cycle, dryRun);
    }
    return;
  }

  if (!isValidMonthlyCycle(cycleArg)) {
    console.error(`[push-link-titles-kv] --cycle inválido: "${cycleArg}" (esperado YYMM-MM, ex: 2606-07).`);
    process.exit(1);
    return;
  }
  await pushCycle(cycleArg, dryRun);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[push-link-titles-kv] erro:", e);
    process.exit(1);
  });
}
