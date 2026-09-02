#!/usr/bin/env node
/**
 * diaria-subscribers-ingest-beehiiv.ts (#6464 fatia 3b — #7104)
 *
 * Ingere no store unificado (`scripts/lib/diaria-subscribers-db.ts`) os
 * eventos por assinante × post da Beehiiv, lendo o backup local já drenado
 * pela fatia 1 (`beehiiv-engagement-backup` agent, #6465/#6733):
 * `data/beehiiv-backup/subscriber-engagement/{post_id}.jsonl` + o
 * `manifest.json` irmão (`scripts/lib/beehiiv-engagement-manifest.ts`).
 *
 * **Sem rede** — ao contrário de `diaria-subscribers-ingest-kit.ts`/
 * `-brevo.ts`, este builder nunca chama a API/MCP da Beehiiv; o dado já
 * está em disco no formato certo (ver corpo da issue #7104). Molde exato
 * do par Kit pro resto do desenho (miolo puro separado, manifest próprio
 * retomável, guard anti-fabricação) — só a camada de I/O troca rede por
 * leitura de arquivo.
 *
 * Miolo puro (derivação de eixos, chave natural, guard, escrita
 * idempotente): `scripts/lib/beehiiv-subscribers-ingest.ts`. Este arquivo é
 * só I/O — lê o manifest da fatia 1 + os `.jsonl`, escreve no store, mantém
 * o manifest PRÓPRIO desta ingestão (retomada independente da fatia 1).
 *
 * ## Só posts `status: "ok"` no manifest da fatia 1 entram
 *
 * Um post `pending`/`partial`/`error` na fatia 1 ainda não tem cobertura
 * confirmada — ingerir um JSONL parcial e marcar como concluído aqui
 * esconderia o buraco. Post `not_applicable` (nunca enviado, ver
 * `beehiiv-engagement-manifest.ts`) não tem engajamento a ingerir — esta
 * ingestão marca a entry PRÓPRIA como `ok` com 0 registros, pra não ficar
 * pendente pra sempre esperando um dado que não existe.
 *
 * ## Retomável — `beehiiv-ingest-manifest.json`
 *
 * Mesmo padrão do Kit (`diaria-subscribers-ingest-manifest.ts`, genérico):
 * 1 entry por post_id, status `ok`/`partial`/`error`. Re-rodar só refaz o
 * que ainda não está `ok` — nunca reprocessa um post já confirmado.
 *
 * ## Guard anti-fabricação (#6496)
 *
 * Um post só vira `ok` no manifest desta ingestão se a contagem de
 * registros PROCESSADOS (identidade resolvida) bater exatamente com o
 * `count` que o manifest da fatia 1 registrou pra esse post
 * (`verifyBeehiivIngestion`, `beehiiv-subscribers-ingest.ts`) — divergência
 * marca `partial` (os eventos já processados são gravados mesmo assim,
 * idempotente; a re-rodada seguinte tenta de novo, útil se o backup da
 * fatia 1 for corrigido/reextraído entretanto).
 *
 * ## Identidade
 *
 * `identity_alias.email` é gravado para todo registro com e-mail utilizável
 * (via `ensureSubscriber`) — é o que permite `resolveIdentitiesByEmail`
 * (#6589, `diaria-subscribers-resolve-identity.ts`) fundir a Beehiiv com
 * Kit/Brevo depois, por e-mail canonicalizado. Nenhuma canonicalização é
 * feita AQUI (mesmo desenho do Kit/Brevo) — só trim+lowercase; a fusão
 * cross-plataforma é passo separado, deliberadamente.
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-ingest-beehiiv.ts [--db <p>]
 *     [--manifest <p>] [--source-dir <p>] [--limit N] [--post <post_id>]
 *
 * Sem rede nenhuma — não requer nenhuma API key. Stdout: JSON summary.
 * Stderr: progresso.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { getArg, getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import { ingestPostEngagement, verifyBeehiivIngestion, type BeehiivEngagementRecord } from "./lib/beehiiv-subscribers-ingest.ts";
import {
  type EngagementManifest,
  type EngagementManifestEntry,
} from "./lib/beehiiv-engagement-manifest.ts";
import {
  buildInitialManifest,
  mergeManifestEntries,
  upsertManifestEntry,
  pendingManifestEntries,
  manifestCoverageSummary,
  type IngestManifest,
  type IngestManifestEntry,
} from "./lib/diaria-subscribers-ingest-manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_SOURCE_DIR = resolve(ROOT, "data/beehiiv-backup/subscriber-engagement");
export const DEFAULT_MANIFEST_PATH = resolve(dirname(DEFAULT_DB_PATH), "beehiiv-ingest-manifest.json");

// ---------------------------------------------------------------------------
// Leitura do backup da fatia 1 (manifest.json + {post_id}.jsonl)
// ---------------------------------------------------------------------------

/** Lê o manifest.json da fatia 1 (`beehiiv-engagement-backup`) — `null` se
 *  ausente ou ilegível (backup nunca rodou, ou `data/` ausente). */
export function loadSourceEngagementManifest(sourceDir: string): EngagementManifest | null {
  const path = resolve(sourceDir, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EngagementManifest;
  } catch {
    return null;
  }
}

/** Parseia o JSONL de 1 post — 1 linha = 1 registro cru da MCP (ver
 *  `apply-mcp-subscriber-engagement.ts`, mesmo formato). Linha malformada é
 *  ignorada (contada como registro perdido pelo guard — o count esperado do
 *  manifest não vai bater, então o post não vira `ok` silenciosamente). */
export function readPostRecords(sourceDir: string, postId: string): BeehiivEngagementRecord[] {
  const path = resolve(sourceDir, `${postId}.jsonl`);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const out: BeehiivEngagementRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as BeehiivEngagementRecord);
    } catch {
      // linha corrompida — ignorada, o guard de contagem abaixo detecta o gap.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ingestão de 1 post (fail-soft — nunca lança, vira entry "error")
// ---------------------------------------------------------------------------

export interface PostIngestOutcome {
  entry: IngestManifestEntry;
  eventsNew: number;
  eventsAlreadyKnown: number;
}

/**
 * Ingere 1 post a partir do JSONL local + a entry correspondente do
 * manifest da fatia 1 (já filtrada por `status: "ok"`/`"not_applicable"`
 * pelo chamador — ver `main`). Nunca lança: erro de parse/IO vira entry
 * `"error"`, mesmo padrão fail-soft do Kit/Brevo.
 */
export function ingestOnePost(
  db: DatabaseSync,
  sourceDir: string,
  sourceEntry: Pick<EngagementManifestEntry, "post_id" | "title" | "status" | "count">,
  now: string = new Date().toISOString(),
): PostIngestOutcome {
  const id = sourceEntry.post_id;

  if (sourceEntry.status === "not_applicable") {
    return {
      entry: { id, label: sourceEntry.title, status: "ok", counts: { records: 0 }, fetched_at: now },
      eventsNew: 0,
      eventsAlreadyKnown: 0,
    };
  }

  try {
    const records = readPostRecords(sourceDir, id);
    const result = ingestPostEngagement(db, id, records, now);
    const manifestCount = sourceEntry.count ?? records.length;
    const guard = verifyBeehiivIngestion(result.recordsProcessed, manifestCount);

    return {
      entry: {
        id,
        label: sourceEntry.title,
        status: guard.ok ? "ok" : "partial",
        counts: {
          records_lidos: records.length,
          records_processados: result.recordsProcessed,
          records_sem_identidade: result.recordsSkippedNoIdentity,
          manifest_count: manifestCount,
        },
        fetched_at: now,
        ...(guard.reason ? { error: guard.reason } : {}),
      },
      eventsNew: result.newEvents,
      eventsAlreadyKnown: result.alreadyKnown,
    };
  } catch (e) {
    return {
      entry: { id, label: sourceEntry.title, status: "error", error: e instanceof Error ? e.message : String(e), fetched_at: now },
      eventsNew: 0,
      eventsAlreadyKnown: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Manifest I/O (desta ingestão — separado do manifest da fatia 1)
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const manifestPath = getArg(argv, "manifest") || DEFAULT_MANIFEST_PATH;
  const sourceDir = getArg(argv, "source-dir") || DEFAULT_SOURCE_DIR;
  const limit = getIntArg(argv, "limit", { min: 1 });
  const postFilter = getStringArg(argv, "post");

  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir);
  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot} (ver CLAUDE.md setup, passo 2b)`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const sourceManifest = loadSourceEngagementManifest(sourceDir);
  if (!sourceManifest) {
    console.error(
      `❌ manifest.json da fatia 1 não encontrado/ilegível em ${sourceDir} — ` +
        `rode o agent \`beehiiv-engagement-backup\` primeiro (ver #6465).`,
    );
    process.exitCode = 1;
    return;
  }

  // Só posts com cobertura confirmada (`ok`) ou sem engajamento a drenar
  // (`not_applicable`) entram — `pending`/`partial`/`error` na fatia 1 ainda
  // não têm dado confiável pra ingerir aqui.
  const readySourceEntries = sourceManifest.posts.filter((p) => p.status === "ok" || p.status === "not_applicable");
  console.error(
    `📇 manifest da fatia 1: ${sourceManifest.posts.length} post(s) total, ${readySourceEntries.length} pronto(s) pra ingestão.`,
  );

  let manifest = loadManifest(manifestPath);
  manifest = mergeManifestEntries(
    manifest,
    readySourceEntries.map((p) => ({ id: p.post_id, label: p.title })),
    new Date().toISOString(),
  );
  saveManifest(manifestPath, manifest);

  const byId = new Map(readySourceEntries.map((p) => [p.post_id, p]));
  let pending = pendingManifestEntries(manifest).filter((e) => byId.has(e.id));
  if (postFilter !== undefined) pending = pending.filter((e) => e.id === postFilter);
  if (limit !== undefined) pending = pending.slice(0, limit);

  console.error(`🔎 ${pending.length} post(s) pendente(s) de ${readySourceEntries.length} pronto(s).`);

  const db = openDiariaSubscribersDb(dbPath);
  let eventsNewTotal = 0;
  let eventsAlreadyKnownTotal = 0;
  let processed = 0;

  for (const entry of pending) {
    const sourceEntry = byId.get(entry.id)!;
    const outcome = ingestOnePost(db, sourceDir, sourceEntry);
    manifest = upsertManifestEntry(manifest, outcome.entry);
    saveManifest(manifestPath, manifest); // durável a cada post — retomável em qualquer ponto
    eventsNewTotal += outcome.eventsNew;
    eventsAlreadyKnownTotal += outcome.eventsAlreadyKnown;
    processed++;
    console.error(
      `  …[${processed}/${pending.length}] post ${entry.id} (${outcome.entry.status}) — ` +
        `${outcome.eventsNew} evento(s) novo(s), ${outcome.eventsAlreadyKnown} já conhecido(s)`,
    );
  }

  db.close();

  const coverage = manifestCoverageSummary(manifest);
  console.log(
    JSON.stringify(
      {
        db: dbPath,
        manifest: manifestPath,
        source_dir: sourceDir,
        source_posts_ready: readySourceEntries.length,
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
    console.error(`[diaria-subscribers-ingest-beehiiv] erro fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
