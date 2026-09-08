/**
 * kit-clicks-enrich.ts (#7600)
 *
 * Substitui o agent `kit-clicks-enricher` (MCP `get_link_clicks_for_a_broadcast`)
 * — aposentado nesta mesma unidade. O downgrade do plano Kit pro free (#7365)
 * fez todo `mcp__kit__*` ser recusado por gate de plano pago; o REST
 * equivalente (`GET /broadcasts/{id}/clicks`, já exposto por
 * `getBroadcastClicks` em `scripts/lib/kit-client.ts`) funciona normalmente
 * no free, confirmado ao vivo na própria issue. Este script drena um lote de
 * broadcasts via REST, num único processo Node headless — sem dependência de
 * MCP, sem subagent.
 *
 * Grava no MESMO formato que `apply-mcp-kit-clicks.ts` já espera
 * (`data/kit-cache/posts/kit_{id8}.json`) — reusa `applyKitClicks` como
 * função importada (não spawna subprocesso), só troca a FONTE do dado (REST
 * em vez de payload colado via stdin pela MCP).
 *
 * NÃO confundir com `kit-sync.ts` (#7570), que escreve em
 * `data/kit-cache/broadcasts/` — cache DIFERENTE, consumido por
 * `loadKitCache`/`edition-cache-reader.ts` (CTR comportamental, audience
 * profile, carrossel semanal). Este script alimenta especificamente
 * `data/kit-cache/posts/`, que só `monthly-click-sections.ts` lê (Use
 * Melhor/Radar do digest mensal) — os dois caches coexistem de propósito
 * (ver o comentário em `monthly-click-sections.ts` linha ~321: "NÃO o reusa
 * de propósito").
 *
 * Uso:
 *   # lista explícita de broadcast ids (== id8 pro Kit, sem truncamento —
 *   # ver docstring de apply-mcp-kit-clicks.ts)
 *   npx tsx scripts/kit-clicks-enrich.ts --broadcast-ids 25654292,25623204
 *
 *   # deriva a lista a partir de data/monthly/{cycle}/raw-posts/post_{id8}_*.txt
 *   npx tsx scripts/kit-clicks-enrich.ts --cycle 2605-06
 *
 *   npx tsx scripts/kit-clicks-enrich.ts --cycle 2605-06 --append
 *
 * Env: KIT_API_KEY obrigatório (via KitConfig/kit-config.ts).
 *
 * Rate limit (#6047, mesmo padrão de kit-sync.ts): auto-espaçamento de
 * `RATE_LIMIT_DELAY_MS` entre cada chamada REST (broadcast e página de
 * clicks) — nunca em paralelo.
 *
 * Output (stdout): JSON `{ processed, ok, fail, total_links_applied,
 * failed_broadcasts }` — mesmo shape que o agent aposentado devolvia, pra
 * qualquer chamador que já parseie esse formato não precisar mudar.
 * Stderr: progresso humano, uma linha por broadcast (`ok`/`fail`).
 *
 * Exit codes: 0 = sucesso parcial-ou-total (broadcasts individuais que
 * falharam ficam em `failed_broadcasts`, não abortam o lote — mesma
 * disciplina fail-soft por-item do agent original e do `kit-sync.ts`);
 * 1 = erro fatal fora do loop (args inválidos, KIT_API_KEY ausente, nenhum
 * broadcast a processar).
 */

import "dotenv/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, existsSync } from "node:fs";
import { getBroadcastClicks, type KitBroadcastClick } from "./lib/kit-client.ts";
import { loadKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { applyKitClicks, EmptyReplaceGuardError, type ApplyKitResult } from "./apply-mcp-kit-clicks.ts";
import { monthlyDir } from "./lib/mensal/monthly-paths.ts";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Mesmo espaçamento medido no #6047 e já usado por kit-sync.ts. */
export const RATE_LIMIT_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Deriva a lista de broadcast ids (== id8, sem truncamento) a partir dos
 * arquivos `post_{id8}_{AAMMDD}.txt` já baixados por `fetch-monthly-posts.ts`
 * pra um ciclo. Pure-ish (só lê o filesystem) — separada pra ser testável
 * sem precisar de um diretório real via injeção de `rawPostsDir`.
 */
export function deriveBroadcastIdsFromCycle(cycle: string, rawPostsDirOverride?: string): string[] {
  const rawPostsDir = rawPostsDirOverride ?? resolve(monthlyDir(cycle), "raw-posts");
  if (!existsSync(rawPostsDir)) return [];
  const ids = new Set<string>();
  for (const entry of readdirSync(rawPostsDir)) {
    const m = /^post_(\d+)_\d+\.txt$/.exec(entry);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort();
}

export interface EnrichOneResult {
  id8: string;
  ok: boolean;
  links_applied: number;
  fail_reason?: "guard-empty-replace" | "fetch-error";
}

/**
 * Busca (paginado) e aplica os clicks de UM broadcast. Injeta `fetchClicks`
 * e `applyFn` pra testes não precisarem de rede nem tocar disco real.
 */
export async function enrichOneBroadcast(
  id8: string,
  opts: {
    config?: KitConfig;
    append: boolean;
    postsDir?: string;
    fetchClicks?: typeof getBroadcastClicks;
    applyFn?: typeof applyKitClicks;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<EnrichOneResult> {
  const fetchClicks = opts.fetchClicks ?? getBroadcastClicks;
  const applyFn = opts.applyFn ?? applyKitClicks;
  const sleepFn = opts.sleepFn ?? sleep;
  const broadcastId = Number(id8);

  const allClicks: KitBroadcastClick[] = [];
  let after: string | undefined;
  let firstPage = true;
  while (true) {
    if (!firstPage) await sleepFn(RATE_LIMIT_DELAY_MS);
    firstPage = false;
    let page: Awaited<ReturnType<typeof getBroadcastClicks>>;
    try {
      page = await fetchClicks(broadcastId, { perPage: 100, after, config: opts.config });
    } catch (e) {
      return { id8, ok: false, links_applied: 0, fail_reason: "fetch-error" };
    }
    allClicks.push(...page.clicks);
    if (!page.pagination.has_next_page) break;
    after = page.pagination.end_cursor ?? undefined;
    if (!after) break;
  }

  let applied: ApplyKitResult;
  try {
    applied = applyFn(JSON.stringify({ clicks: allClicks }), {
      id8,
      append: opts.append,
      postsDir: opts.postsDir,
    });
  } catch (e) {
    if (e instanceof EmptyReplaceGuardError) {
      return { id8, ok: false, links_applied: 0, fail_reason: "guard-empty-replace" };
    }
    throw e;
  }

  return { id8, ok: true, links_applied: applied.after_count };
}

export interface EnrichBatchResult {
  processed: number;
  ok: number;
  fail: number;
  total_links_applied: number;
  failed_broadcasts: string[];
}

export async function enrichBatch(
  ids: string[],
  opts: {
    config?: KitConfig;
    append: boolean;
    postsDir?: string;
    fetchClicks?: typeof getBroadcastClicks;
    applyFn?: typeof applyKitClicks;
    sleepFn?: (ms: number) => Promise<void>;
    onProgress?: (line: string) => void;
  },
): Promise<EnrichBatchResult> {
  const sleepFn = opts.sleepFn ?? sleep;
  const result: EnrichBatchResult = { processed: 0, ok: 0, fail: 0, total_links_applied: 0, failed_broadcasts: [] };

  for (let i = 0; i < ids.length; i++) {
    if (i > 0) await sleepFn(RATE_LIMIT_DELAY_MS);
    const one = await enrichOneBroadcast(ids[i], opts);
    result.processed++;
    if (one.ok) {
      result.ok++;
      result.total_links_applied += one.links_applied;
      opts.onProgress?.(`ok ${i + 1}/${ids.length} kit_${one.id8} → ${one.links_applied} links`);
    } else {
      result.fail++;
      result.failed_broadcasts.push(one.id8);
      opts.onProgress?.(`fail ${i + 1}/${ids.length} kit_${one.id8} → ${one.fail_reason}`);
    }
  }

  return result;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const idsIdx = argv.indexOf("--broadcast-ids");
  const cycleIdx = argv.indexOf("--cycle");
  const append = argv.includes("--append");

  let ids: string[];
  if (idsIdx !== -1 && argv[idsIdx + 1]) {
    ids = argv[idsIdx + 1].split(",").map((s) => s.trim()).filter(Boolean);
  } else if (cycleIdx !== -1 && argv[cycleIdx + 1]) {
    ids = deriveBroadcastIdsFromCycle(argv[cycleIdx + 1]);
  } else {
    console.error(
      "uso: kit-clicks-enrich.ts (--broadcast-ids id1,id2,... | --cycle YYMM-MM) [--append]",
    );
    process.exit(1);
    return;
  }

  if (ids.length === 0) {
    console.error("[kit-clicks-enrich] nenhum broadcast a processar (lista vazia)");
    process.exit(1);
    return;
  }

  // loadKitConfig já escreve em stderr + process.exit(2) se KIT_API_KEY
  // estiver ausente (ver scripts/lib/kit-config.ts) — não precisa de
  // try/catch aqui.
  const config = loadKitConfig("[kit-clicks-enrich]");

  const result = await enrichBatch(ids, {
    config,
    append,
    onProgress: (line) => process.stderr.write(`${line}\n`),
  });

  console.log(JSON.stringify(result));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
