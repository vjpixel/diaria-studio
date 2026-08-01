#!/usr/bin/env node
/**
 * push-link-sections-kv.ts (#4184)
 *
 * Empurra o mapa CONTEÚDO→SEÇÃO editorial (Destaques/Use Melhor/Radar) de um
 * ciclo mensal pro KV do worker `clarice-dashboard`, sob a chave `secao:{ciclo}`
 * — fonte que alimenta a coluna "Seção" nas tabelas de link do dashboard
 * público (workers/brevo-dashboard/src/render-links.ts).
 *
 * Deliberadamente um script EXPLÍCITO, NUNCA chamado pelo caminho de render
 * do painel (decisão do editor, #4184) — o #4186 já documenta que abrir o
 * painel Studio local consome quota Brevo de produção e escreve no KV
 * público sem lock; este recurso novo não deve se somar a esse padrão. O
 * painel Studio NÃO usa este script nem o KV — monta o mesmo mapa em
 * memória, ao vivo, a partir do `prioritized.md` local (ver
 * `scripts/studio-ui/dashboard-clarice.ts`).
 *
 * #4405: desde este PR, `.claude/skills/diaria-mensal/SKILL.md` (Etapa 5 —
 * Publicação) chama este script como parte do pipeline, fail-soft (warning,
 * nunca bloqueia o envio) — não contradiz o parágrafo acima: o proibido é o
 * caminho de RENDER do painel, este é um passo explícito de PIPELINE (só
 * roda quando o editor de fato publica um ciclo). Sem isso, todo ciclo novo
 * nascia com a coluna "Seção" vazia até alguém lembrar de rodar `--all`
 * manualmente (RC4 do #4405).
 *
 * Fonte: `data/monthly/{ciclo}/prioritized.md` (`## Destaques` / `## Use Melhor` /
 * `## Radar`) — ver `scripts/lib/mensal/monthly-link-sections.ts` pro parser.
 * Sem `utm_term`, sem alterar nenhum link de saída — retroativo de imediato,
 * não depende de reenviar nada.
 *
 * Uso:
 *   npx tsx scripts/push-link-sections-kv.ts --cycle 2606-07 [--dry-run]
 *   npx tsx scripts/push-link-sections-kv.ts --all [--dry-run]
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
 * Execução real (contra o KV de produção) — desde #4405, chamado
 * automaticamente pela Etapa 5 (Publicação) de `/diaria-mensal`, fail-soft
 * (ver nota #4405 acima); fora desse pipeline, fica a cargo do
 * editor/coordenador rodar manualmente (ex: backfill via `--all`).
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { MONTHLY_BASE, isValidMonthlyCycle } from "./lib/mensal/monthly-paths.ts";
import { loadLinkSectionMapForCycle } from "./lib/mensal/monthly-link-sections.ts";
import { linkSectionsKvKey } from "../workers/brevo-dashboard/src/types.ts";
import type { LinkSectionMap } from "./lib/dashboard-kv-types.ts";

loadProjectEnv();

export { linkSectionsKvKey };

/**
 * Ciclos candidatos ao `--all`: subpastas de `baseDir` (default
 * `data/monthly/`) no formato `YYMM-MM` que tenham `prioritized.md`.
 * Fail-soft: `baseDir` inacessível (sessão cloud sem o junction OneDrive,
 * #2643) retorna `[]`, nunca lança. `baseDir` é injetável pra teste (nunca
 * precisa apontar pra `data/` real).
 */
export function discoverCyclesWithPrioritized(baseDir: string = MONTHLY_BASE): string[] {
  try {
    if (!existsSync(baseDir)) return [];
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidMonthlyCycle(d.name))
      .map((d) => d.name)
      .filter((cycle) => existsSync(join(baseDir, cycle, "prioritized.md")))
      .sort();
  } catch {
    return [];
  }
}

async function pushCycle(cycle: string, dryRun: boolean): Promise<void> {
  const map: LinkSectionMap | null = loadLinkSectionMapForCycle(cycle);
  if (!map) {
    console.warn(`[push-link-sections-kv] ${cycle}: sem prioritized.md (ou data/ inacessível) — pulando.`);
    return;
  }
  const entries = Object.keys(map).length;
  console.log(`[push-link-sections-kv] ${cycle}: ${entries} conteúdo(s) mapeado(s).`);
  if (dryRun) {
    console.log(`[push-link-sections-kv] --dry-run (${cycle}):`, JSON.stringify(map, null, 2));
    return;
  }
  const json = JSON.stringify(map);
  await uploadTextToWorkerKV(json, linkSectionsKvKey(cycle), {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
    contentType: "application/json",
  });
  console.log(`[push-link-sections-kv] KV atualizado: ${linkSectionsKvKey(cycle)}.`);
}

async function main(): Promise<void> {
  const dryRun = hasFlag(process.argv, "dry-run");
  const cycleArg = getArg(process.argv, "cycle");
  const all = hasFlag(process.argv, "all");

  if (!cycleArg && !all) {
    console.error(
      "Uso: push-link-sections-kv.ts --cycle YYMM-MM [--dry-run]\n" +
        "  ou: push-link-sections-kv.ts --all [--dry-run]  (backfill dos ciclos existentes)",
    );
    process.exit(2);
    return;
  }

  if (all) {
    const cycles = discoverCyclesWithPrioritized();
    if (cycles.length === 0) {
      console.error("[push-link-sections-kv] nenhum ciclo com prioritized.md encontrado em data/monthly/.");
      process.exit(1);
      return;
    }
    console.log(`[push-link-sections-kv] --all: ${cycles.length} ciclo(s) encontrado(s): ${cycles.join(", ")}`);
    for (const cycle of cycles) {
      await pushCycle(cycle, dryRun);
    }
    return;
  }

  if (!isValidMonthlyCycle(cycleArg)) {
    console.error(`[push-link-sections-kv] --cycle inválido: "${cycleArg}" (esperado YYMM-MM, ex: 2606-07).`);
    process.exit(1);
    return;
  }
  await pushCycle(cycleArg, dryRun);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[push-link-sections-kv] erro:", e);
    process.exit(1);
  });
}
