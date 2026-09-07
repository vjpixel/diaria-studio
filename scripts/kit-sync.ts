/**
 * kit-sync.ts (#7570)
 *
 * Popula `data/kit-cache/broadcasts/` com 1 JSON por broadcast (detalhe +
 * stats + clicks) — o escritor do lado Kit que `scripts/lib/shared/
 * edition-cache-reader.ts::loadKitCache` já sabia ler desde #6185/#6187, mas
 * que nunca existiu até esta unidade. Espelho de `beehiiv-sync.ts`, mas mais
 * simples: a API v4 do Kit expõe clicks por link (`getBroadcastClicks`) e
 * stats agregado (`getBroadcastStats`) via **REST comum** — diferente da
 * Beehiiv, onde per-link clicks só existem via MCP (`list_post_clicks`,
 * só chamável do top-level Claude), daí o agente `beehiiv-clicks-enricher`
 * e a dança de "manifest + dispatch de subagent" em `stage-0-run.ts`. Este
 * script não precisa de nada disso: busca clicks/stats direto, num único
 * processo Node, sem 2ª fase.
 *
 * ## Achado ao vivo que motivou (260907, issue #7570)
 *
 * `/diaria-instagram-semanal` (modo `clicked`) abortou porque a edição
 * 260904 tinha sido publicada — só que via Kit, não Beehiiv (a diária
 * migrou o ENVIO pro Kit em #7388, 04/09/2026) — e `data/kit-cache/
 * broadcasts/` estava (e sempre esteve) vazio. `build-link-ctr.ts` também
 * já lê esse diretório pro CTR comportamental/audience profile — o gap não
 * era só do carrossel semanal.
 *
 * ## Janela de refresh de clicks (`KIT_REFRESH_WINDOW_DAYS`)
 *
 * Diferente da Beehiiv (onde `MIN_AGE_DAYS_FOR_CLICKS` faz o INVERSO — só
 * busca clicks depois que o post "esfria", porque a busca é cara/assíncrona
 * via MCP), aqui a busca é barata (REST síncrono) e o problema é o oposto:
 * clicks continuam subindo por alguns dias após o envio, então um broadcast
 * `completed` recente precisa ser RE-buscado a cada sync até estabilizar.
 * `needsKitUpdate` refetch todo broadcast `completed`/`aborted` mais novo
 * que `KIT_REFRESH_WINDOW_DAYS` dias (14 — dobro do `MIN_AGE_DAYS_FOR_CLICKS`
 * da Beehiiv, folga arbitrária mas barata: cadência diária da diária nunca
 * produz mais que ~14 broadcasts nessa janela). Broadcasts mais velhos que
 * já estão em cache são tratados como estáveis e não são re-buscados —
 * `--full` ignora essa otimização e refetch tudo.
 *
 * ## Auto-espaçamento entre chamadas (#6047)
 *
 * `kit-client.ts` documenta que endpoints singulares toleram só dezenas de
 * chamadas sequenciais antes de 429 — `fetchWithRetry` absorve um blip
 * isolado, mas não é mecanismo geral de rate-limit. Este script se
 * auto-espaça (`RATE_LIMIT_DELAY_MS` entre cada broadcast que precisa de
 * update — 3 chamadas por broadcast: detail + clicks + stats), mesmo padrão
 * de `beehiiv-sync.ts`.
 *
 * Uso:
 *   npx tsx scripts/kit-sync.ts              # incremental (default)
 *   npx tsx scripts/kit-sync.ts --full       # re-fetch todos (ignora cache)
 *   npx tsx scripts/kit-sync.ts --dry-run    # só lista o que faria
 *
 * Env:
 *   KIT_API_KEY    obrigatório
 *   KIT_API_URL    opcional — override para tests
 *
 * Output (stdout): JSON `{ mode, broadcasts_fetched, broadcasts_skipped,
 *   broadcasts_total, dry_run }`. Stderr: progresso humano.
 *
 * Exit codes: 0=sucesso, 1=erro API/IO, 2=config inválida (KIT_API_KEY ausente).
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKitConfig, type KitConfig } from "./lib/kit-config.ts";
import {
  listBroadcasts,
  getBroadcast,
  getBroadcastClicks,
  getBroadcastStats,
  type KitBroadcastSummary,
} from "./lib/kit-client.ts";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = resolve(ROOT, "data/kit-cache");
const BROADCASTS_DIR = resolve(CACHE_DIR, "broadcasts");
const BROADCASTS_INDEX = resolve(BROADCASTS_DIR, "index.json");

const RATE_LIMIT_DELAY_MS = 350; // mesmo espaçamento medido no #6047 (import de subscribers)

/** Ver docstring do módulo — janela em que um broadcast `completed`/`aborted`
 *  continua sendo re-buscado a cada sync (clicks ainda subindo). */
export const KIT_REFRESH_WINDOW_DAYS = 14;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDirs(): void {
  mkdirSync(BROADCASTS_DIR, { recursive: true });
}

interface BroadcastIndexEntry {
  id: number;
  subject: string;
  status: KitBroadcastSummary["status"];
  published_at: string | null;
  send_at: string | null;
}

function loadIndex(): BroadcastIndexEntry[] {
  if (!existsSync(BROADCASTS_INDEX)) return [];
  try {
    return JSON.parse(readFileSync(BROADCASTS_INDEX, "utf8")) as BroadcastIndexEntry[];
  } catch {
    return [];
  }
}

function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

const TERMINAL_STATUSES: ReadonlySet<KitBroadcastSummary["status"]> = new Set(["completed", "aborted"]);

/**
 * Decide se precisa re-buscar detail+clicks+stats de um broadcast.
 *
 * Pure function — separada pra testes unitários (mesmo padrão de
 * `needsUpdate` em `beehiiv-sync.ts`).
 *
 * - `--full`: sempre `true`.
 * - Ausente do cache: sempre `true` (broadcast novo).
 * - Status ainda não-terminal (`draft`/`scheduled`/`sending`): sempre
 *   `true` — o estado pode mudar a qualquer momento.
 * - Status terminal (`completed`/`aborted`) sem data confiável
 *   (`published_at`/`send_at` ambos ausentes): `true` — sem data pra medir
 *   idade, mais seguro refetch do que assumir estável.
 * - Status terminal com data: `true` só se mais novo que
 *   `KIT_REFRESH_WINDOW_DAYS` dias (clicks ainda podem estar subindo).
 */
export function needsKitUpdate(
  summary: Pick<KitBroadcastSummary, "id" | "status" | "published_at" | "send_at">,
  cachedIds: ReadonlySet<number>,
  opts: { full?: boolean; now?: Date } = {},
): boolean {
  if (opts.full) return true;
  if (!cachedIds.has(summary.id)) return true;
  if (!TERMINAL_STATUSES.has(summary.status)) return true;
  const anchor = summary.published_at ?? summary.send_at;
  if (!anchor) return true;
  const anchorMs = Date.parse(anchor);
  if (Number.isNaN(anchorMs)) return true;
  const ageDays = ((opts.now ?? new Date()).getTime() - anchorMs) / (24 * 60 * 60 * 1000);
  return ageDays < KIT_REFRESH_WINDOW_DAYS;
}

export interface KitSyncResult {
  mode: "bootstrap" | "incremental" | "full";
  broadcasts_fetched: number;
  broadcasts_skipped: number;
  broadcasts_total: number;
  dry_run: boolean;
}

export interface KitSyncOpts {
  full: boolean;
  dryRun: boolean;
  /** Override config carregada — para tests. */
  configOverride?: KitConfig;
}

export async function syncKit(opts: KitSyncOpts): Promise<KitSyncResult> {
  const config = opts.configOverride ?? loadKitConfig("[kit-sync]");
  ensureDirs();

  const cachedIndex = loadIndex();
  const cachedIds = new Set(cachedIndex.map((e) => e.id));
  const isBootstrap = cachedIndex.length === 0;
  const mode: KitSyncResult["mode"] = opts.full ? "full" : isBootstrap ? "bootstrap" : "incremental";

  process.stderr.write(`[kit-sync] mode=${mode}\n`);

  const newIndex: BroadcastIndexEntry[] = [];
  let fetched = 0;
  let skipped = 0;
  let after: string | undefined;
  let pageNum = 0;

  while (true) {
    pageNum++;
    process.stderr.write(`[kit-sync] listing page ${pageNum}\n`);
    const { broadcasts, pagination } = await listBroadcasts({ perPage: 100, after, config });

    let allSkipped = true;
    for (const s of broadcasts) {
      const indexEntry: BroadcastIndexEntry = {
        id: s.id,
        subject: s.subject,
        status: s.status,
        published_at: s.published_at,
        send_at: s.send_at,
      };
      newIndex.push(indexEntry);

      if (!needsKitUpdate(s, cachedIds, { full: opts.full })) {
        skipped++;
        continue;
      }
      allSkipped = false;

      if (opts.dryRun) {
        process.stderr.write(`  [dry-run] would fetch ${s.id} — ${s.subject}\n`);
        fetched++;
        continue;
      }

      await sleep(RATE_LIMIT_DELAY_MS);
      try {
        const detail = await getBroadcast(s.id, config);
        await sleep(RATE_LIMIT_DELAY_MS);
        const { clicks } = await getBroadcastClicks(s.id, { perPage: 100, config });
        await sleep(RATE_LIMIT_DELAY_MS);
        const stats = await getBroadcastStats(s.id, config);

        const raw = {
          id: detail.id,
          publication_id: detail.publication_id,
          subject: detail.subject,
          send_at: detail.send_at,
          status: detail.status,
          public: detail.public,
          published_at: detail.published_at,
          created_at: detail.created_at,
          preview_text: detail.preview_text,
          description: detail.description,
          thumbnail_alt: detail.thumbnail_alt,
          thumbnail_url: detail.thumbnail_url,
          public_url: detail.public_url,
          content: detail.content,
          clicks,
          stats,
        };
        atomicWrite(
          resolve(BROADCASTS_DIR, `${s.id}.json`),
          JSON.stringify({ ...raw, _synced_at: new Date().toISOString() }, null, 2),
        );
        fetched++;
        process.stderr.write(`  ↓ ${s.id} — ${s.subject.slice(0, 60)}\n`);
      } catch (e) {
        process.stderr.write(`  ! fetch failed for ${s.id}: ${e instanceof Error ? e.message : e}\n`);
        skipped++;
      }
    }

    // Incremental shortcut: se a página inteira já está estável, parar de
    // paginar (mesmo padrão de beehiiv-sync.ts — assume ordem newest-first,
    // confirmado ao vivo contra `listBroadcasts`/`list_broadcasts`).
    if (!opts.full && allSkipped && pageNum > 1) {
      process.stderr.write(`[kit-sync] página ${pageNum} toda estável — parando incremental\n`);
      for (const entry of cachedIndex) {
        if (!newIndex.find((p) => p.id === entry.id)) newIndex.push(entry);
      }
      break;
    }

    if (!pagination.has_next_page) break;
    after = pagination.end_cursor ?? undefined;
    if (!after) break;
  }

  newIndex.sort((a, b) => {
    const da = a.published_at ?? a.send_at;
    const db = b.published_at ?? b.send_at;
    return (db ? Date.parse(db) : 0) - (da ? Date.parse(da) : 0);
  });

  if (!opts.dryRun) {
    atomicWrite(BROADCASTS_INDEX, JSON.stringify(newIndex, null, 2));
  }

  return {
    mode,
    broadcasts_fetched: fetched,
    broadcasts_skipped: skipped,
    broadcasts_total: newIndex.length,
    dry_run: opts.dryRun,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: KitSyncOpts = {
    full: argv.includes("--full"),
    dryRun: argv.includes("--dry-run"),
  };
  const result = await syncKit(opts);
  console.log(JSON.stringify(result));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
