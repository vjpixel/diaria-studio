#!/usr/bin/env node
/**
 * diaria-subscribers-ingest-kit.ts (#6464 fatia 3 — #6586)
 *
 * Ingere no store unificado (`scripts/lib/diaria-subscribers-db.ts`) os
 * eventos por assinante × broadcast do Kit — os 4 eixos que
 * `POST /v4/subscribers/filter` expõe: `sent`, `delivered`, `opens`,
 * `clicks` (identidade real, não só contagem — o único endpoint do Kit que
 * devolve QUEM). Reusa `fetchAudience`/`drainPages`/`todasOuNenhuma`, já
 * endurecidos em `scripts/kit-provider-split.ts` (envelope 2xx malformado
 * tratado como erro, nunca fim-de-lista silencioso; `Promise.allSettled`
 * reporta TODAS as falhas concorrentes, não só a 1ª).
 *
 * Miolo puro (mapeamento eixo→evento, chave natural, guard anti-fabricação,
 * escrita idempotente): `scripts/lib/kit-subscribers-ingest.ts`. Este
 * arquivo é só a camada de I/O — fetch real + persistência do manifest.
 *
 * ## Retomável — `kit-ingest-manifest.json`
 *
 * Mesmo padrão de `apply-mcp-subscriber-engagement.ts` (#6465): 1 entry por
 * broadcast, status `ok`/`partial`/`error`. Re-rodar só refaz o que ainda
 * não está `ok` — nunca reprocessa um broadcast já confirmado. Só broadcasts
 * `status: "completed"` (efetivamente enviados) entram na enumeração — um
 * rascunho/agendado não tem audiência real pra ingerir ainda.
 *
 * ## Guard anti-fabricação (#6496)
 *
 * Um broadcast só vira `ok` no manifest se a contagem do eixo `sent`
 * ingerida bater exatamente com `stats.recipients` do próprio Kit
 * (`verifyKitIngestion`, `kit-subscribers-ingest.ts`) — divergência marca
 * `partial` (os eventos já coletados são gravados mesmo assim, idempotente;
 * a re-rodada seguinte tenta de novo).
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-ingest-kit.ts [--db <p>] [--manifest <p>]
 *     [--limit N] [--broadcast <id>]
 *
 * Requer `KIT_API_KEY` no env (`resolveKitConfig`, lança se ausente — mesmo
 * fail-fast do resto da camada Kit). Stdout: JSON summary. Stderr: progresso.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getArg, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { listBroadcasts, getBroadcastStats, type KitBroadcastSummary, type KitBroadcastStats } from "./lib/kit-client.ts";
import { fetchAudience, todasOuNenhuma, type BroadcastAudience, type DrainResult } from "./kit-provider-split.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import { ingestBroadcastAudience, verifyKitIngestion } from "./lib/kit-subscribers-ingest.ts";
import {
  buildInitialManifest,
  mergeManifestEntries,
  upsertManifestEntry,
  pendingManifestEntries,
  manifestCoverageSummary,
  type IngestManifest,
  type IngestManifestEntry,
} from "./lib/diaria-subscribers-ingest-manifest.ts";

export const DEFAULT_MANIFEST_PATH = resolve(dirname(DEFAULT_DB_PATH), "kit-ingest-manifest.json");

/** Pacing entre broadcasts — mesma ordem de grandeza medida no #6047
 *  (endpoints singulares do Kit toleram só dezenas de chamadas sequenciais
 *  sem espaçamento antes de 429). Cada broadcast já dispara 5 chamadas
 *  concorrentes (4 eixos + stats); a pausa é ENTRE broadcasts, não dentro. */
export const BROADCAST_PACING_MS = 350;

// ---------------------------------------------------------------------------
// Dependências injetáveis (produção = real; teste = fixture)
// ---------------------------------------------------------------------------

export interface KitIngestDeps {
  listAllBroadcasts: () => Promise<KitBroadcastSummary[]>;
  fetchAudience: (broadcastId: number, axis: BroadcastAudience) => Promise<DrainResult>;
  getBroadcastStats: (id: number) => Promise<KitBroadcastStats>;
  sleep: (ms: number) => Promise<void>;
}

/** Pagina `GET /broadcasts?status=completed` até o fim — só broadcasts
 *  efetivamente enviados têm audiência real pra ingerir. */
async function listAllCompletedBroadcasts(): Promise<KitBroadcastSummary[]> {
  const out: KitBroadcastSummary[] = [];
  let after: string | undefined;
  for (;;) {
    const { broadcasts, pagination } = await listBroadcasts({ status: "completed", perPage: 100, after });
    out.push(...broadcasts);
    if (!pagination.has_next_page || !pagination.end_cursor) break;
    after = pagination.end_cursor;
  }
  return out;
}

export function makeRealKitIngestDeps(): KitIngestDeps {
  return {
    listAllBroadcasts: listAllCompletedBroadcasts,
    fetchAudience,
    getBroadcastStats,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
}

// ---------------------------------------------------------------------------
// Ingestão de 1 broadcast (fail-soft — nunca lança, vira entry "error")
// ---------------------------------------------------------------------------

export interface BroadcastIngestOutcome {
  entry: IngestManifestEntry;
  eventsNew: number;
  eventsAlreadyKnown: number;
}

/**
 * Ingerir 1 broadcast: fetch dos 4 eixos + stats (concorrente, via
 * `todasOuNenhuma` — nomeia TODAS as falhas se mais de uma coleta cair
 * junto), escreve no DB via `ingestBroadcastAudience` por eixo, aplica o
 * guard anti-fabricação, devolve a entry pronta pro manifest.
 *
 * NUNCA lança — uma falha de fetch (rede, 429 esgotado, envelope malformado)
 * vira `status: "error"` na entry, e o broadcast volta em
 * `pendingManifestEntries` na próxima rodada. Mesmo padrão fail-soft
 * por-unidade de `apply-mcp-subscriber-engagement.ts` (#6465).
 */
export async function ingestOneBroadcast(
  db: DatabaseSync,
  broadcast: Pick<KitBroadcastSummary, "id" | "subject" | "published_at" | "send_at">,
  deps: Pick<KitIngestDeps, "fetchAudience" | "getBroadcastStats">,
  now: string = new Date().toISOString(),
): Promise<BroadcastIngestOutcome> {
  const id = String(broadcast.id);
  // #6586: `/subscribers/filter` não devolve timestamp por assinante — a
  // precisão de "quando" fica no nível do broadcast, não do evento.
  const ts = broadcast.published_at ?? broadcast.send_at ?? now;

  let sent: DrainResult, delivered: DrainResult, opens: DrainResult, clicks: DrainResult, stats: KitBroadcastStats;
  try {
    [sent, delivered, opens, clicks, stats] = await todasOuNenhuma<
      [DrainResult, DrainResult, DrainResult, DrainResult, KitBroadcastStats]
    >([
      deps.fetchAudience(broadcast.id, "sent"),
      deps.fetchAudience(broadcast.id, "delivered"),
      deps.fetchAudience(broadcast.id, "opens"),
      deps.fetchAudience(broadcast.id, "clicks"),
      deps.getBroadcastStats(broadcast.id),
    ]);
  } catch (e) {
    return {
      entry: {
        id,
        label: broadcast.subject,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        fetched_at: now,
      },
      eventsNew: 0,
      eventsAlreadyKnown: 0,
    };
  }

  const axes: Array<[BroadcastAudience, DrainResult]> = [
    ["sent", sent],
    ["delivered", delivered],
    ["opens", opens],
    ["clicks", clicks],
  ];
  let eventsNew = 0;
  let eventsAlreadyKnown = 0;
  const counts: Record<string, number> = {};
  for (const [axis, result] of axes) {
    const r = ingestBroadcastAudience(db, broadcast.id, axis, result.emails, ts, now);
    eventsNew += r.newEvents;
    eventsAlreadyKnown += r.alreadyKnown;
    counts[axis] = result.emails.length;
  }
  counts.recipients_reportados = stats.recipients;

  const guard = verifyKitIngestion(sent.emails.length, stats.recipients);
  return {
    entry: {
      id,
      label: broadcast.subject,
      status: guard.ok ? "ok" : "partial",
      counts,
      fetched_at: now,
      ...(guard.reason ? { error: guard.reason } : {}),
    },
    eventsNew,
    eventsAlreadyKnown,
  };
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

function loadManifest(path: string): IngestManifest {
  if (!existsSync(path)) return buildInitialManifest(new Date().toISOString());
  try {
    return JSON.parse(readFileSync(path, "utf8")) as IngestManifest;
  } catch {
    return buildInitialManifest(new Date().toISOString());
  }
}

function saveManifest(path: string, manifest: IngestManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(manifest, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(
  argv: string[] = process.argv.slice(2),
  // Injetável (#6586 self-review): permite testar `main()` ponta-a-ponta
  // com fixtures, sem rede real — produção nunca passa isto, cai no default.
  deps: KitIngestDeps = makeRealKitIngestDeps(),
): Promise<void> {
  loadProjectEnv();

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const manifestPath = getArg(argv, "manifest") || DEFAULT_MANIFEST_PATH;
  const limit = getIntArg(argv, "limit", { min: 1 });
  const broadcastFilter = getIntArg(argv, "broadcast", { min: 1 });

  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir);
  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot} (ver CLAUDE.md setup, passo 2b)`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  console.error("📇 listando broadcasts completados do Kit…");
  const broadcasts = await deps.listAllBroadcasts();
  console.error(`  …${broadcasts.length} broadcast(s) completados.`);

  let manifest = loadManifest(manifestPath);
  manifest = mergeManifestEntries(
    manifest,
    broadcasts.map((b) => ({ id: String(b.id), label: b.subject })),
    new Date().toISOString(),
  );
  saveManifest(manifestPath, manifest);

  const byId = new Map(broadcasts.map((b) => [String(b.id), b]));
  let pending = pendingManifestEntries(manifest).filter((e) => byId.has(e.id));
  if (broadcastFilter !== undefined) pending = pending.filter((e) => e.id === String(broadcastFilter));
  if (limit !== undefined) pending = pending.slice(0, limit);

  console.error(`🔎 ${pending.length} broadcast(s) pendente(s) de ${broadcasts.length} total.`);

  const db = openDiariaSubscribersDb(dbPath);
  let eventsNewTotal = 0;
  let eventsAlreadyKnownTotal = 0;
  let processed = 0;

  for (const entry of pending) {
    const broadcast = byId.get(entry.id)!;
    const outcome = await ingestOneBroadcast(db, broadcast, deps);
    manifest = upsertManifestEntry(manifest, outcome.entry);
    saveManifest(manifestPath, manifest); // durável a cada broadcast — retomável em qualquer ponto
    eventsNewTotal += outcome.eventsNew;
    eventsAlreadyKnownTotal += outcome.eventsAlreadyKnown;
    processed++;
    console.error(
      `  …[${processed}/${pending.length}] broadcast ${entry.id} (${outcome.entry.status}) — ` +
        `${outcome.eventsNew} evento(s) novo(s), ${outcome.eventsAlreadyKnown} já conhecido(s)`,
    );
    if (processed < pending.length) await deps.sleep(BROADCAST_PACING_MS);
  }

  db.close();

  const coverage = manifestCoverageSummary(manifest);
  console.log(
    JSON.stringify(
      {
        db: dbPath,
        manifest: manifestPath,
        broadcasts_total: broadcasts.length,
        processed_this_run: processed,
        events_new: eventsNewTotal,
        events_already_known: eventsAlreadyKnownTotal,
        coverage,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[diaria-subscribers-ingest-kit] erro fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
