#!/usr/bin/env node
/**
 * diaria-subscribers-ingest-brevo.ts (#6464 fatia 4 — #6587)
 *
 * Ingere no store unificado (`scripts/lib/diaria-subscribers-db.ts`) os
 * eventos por contato das DUAS contas Brevo — tenants distintos, quota
 * independente (ver `docs/brevo-rate-limits.md`):
 *   - `brevo_diaria`  — canal diária do editor (`BREVO_DIARIA_API_KEY`).
 *   - `brevo_clarice` — base de reativação da Clarice (`BREVO_CLARICE_API_KEY`).
 *
 * Copia o PADRÃO de `clarice-sync-brevo.ts` (enumerar contatos paginado,
 * `GET /contacts/{id}` por contato, checkpoint resumível) — não o destino:
 * aqui o alvo é o `event` genérico do épico #6464, não `clarice_users`. A
 * fonte é `/v3/contacts/*` (36.000 RPH — folgado, ver docs acima), nunca a
 * família `/v3/emailCampaigns*` (100 RPH apertado) — esta ingestão NUNCA
 * lista/lê campanhas, só contatos, então não compete pela cota apertada com
 * `clarice-schedule-ramp.ts`/`clarice-plan-wave.ts` nem com o dashboard.
 *
 * Miolo puro (parsing de `contact.statistics` → eventos, mapeamento pro
 * vocabulário do store, chave natural, escrita idempotente):
 * `scripts/lib/brevo-subscribers-ingest.ts` + `scripts/lib/brevo-stats.ts`
 * (`extractContactEvents`). Este arquivo é só a camada de I/O.
 *
 * ## Pacing + retomada após 429 (#6587 critério de pronto)
 *
 * `brevoGet` (`lib/brevo-client.ts`) já retenta 429/5xx honrando
 * `Retry-After`/`x-sib-ratelimit-reset` com backoff, e desiste cedo se o
 * `Retry-After` real exceder o orçamento por tentativa (nunca dorme um
 * teto sabendo de antemão que vai falhar de novo — mesma disciplina de
 * `clarice-sync-brevo.ts`). Quando o orçamento estoura mesmo assim, o erro
 * sobe, o checkpoint (já salvo incrementalmente) preserva o progresso, e
 * `db.close()` roda antes do processo terminar — re-rodar continua de onde
 * parou, sem duplicar (idempotência vem de `recordEvent`'s `INSERT OR
 * IGNORE` + a chave natural que embute `ts`, ver `buildBrevoEventExternalId`).
 *
 * ## Escopo desta versão — full sync, sem incremental
 *
 * Ao contrário de `clarice-sync-brevo.ts` (que tem `--incremental` +
 * catch-up de opens via export de campanha), esta 1ª versão sempre faz
 * FULL enumeration — decisão explícita pra caber no orçamento desta issue
 * (#6587 não pede incremental). O checkpoint já torna o full resumível
 * entre execuções; adicionar `--incremental` fica pra uma issue futura, se
 * o volume da conta `brevo_clarice` (~435k contatos) tornar o full
 * recorrente caro demais.
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-ingest-brevo.ts [--db <p>]
 *     [--account brevo_diaria|brevo_clarice] [--limit N] [--concurrency N]
 *
 * Sem `--account`, roda as DUAS contas em sequência (nunca em paralelo —
 * evita competir consigo mesma por I/O local, e mantém o log legível).
 * Conta cuja API key não está no env é PULADA com warning (fail-soft — a
 * outra conta segue normalmente).
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getArg, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoGet } from "./lib/brevo-client.ts";
import { pool } from "./lib/pool.ts";
import { contactsListPath } from "./clarice-sync-brevo.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import { ingestBrevoContact, type BrevoAccountPlatform } from "./lib/brevo-subscribers-ingest.ts";
import {
  buildInitialManifest,
  upsertManifestEntry,
  type IngestManifest,
} from "./lib/diaria-subscribers-ingest-manifest.ts";

export const DEFAULT_MANIFEST_PATH = resolve(dirname(DEFAULT_DB_PATH), "brevo-ingest-manifest.json");

/** As 2 contas Brevo reais — env var da key + platform de destino no store. */
export const BREVO_ACCOUNTS: Array<{ platform: BrevoAccountPlatform; apiKeyEnv: string }> = [
  { platform: "brevo_diaria", apiKeyEnv: "BREVO_DIARIA_API_KEY" },
  { platform: "brevo_clarice", apiKeyEnv: "BREVO_CLARICE_API_KEY" },
];

/** Pacing entre páginas do listing — mesmo valor de `clarice-sync-brevo.ts`
 *  (`PAGE_PACING_MS`), memória `brevo-hourly-ratelimit`. */
const PAGE_PACING_MS = 250;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A cada N contatos, persiste o checkpoint em disco (durabilidade sem pagar
 *  o custo de 1 write por contato). */
const CHECKPOINT_FLUSH_EVERY = 50;

// ---------------------------------------------------------------------------
// Checkpoint por conta (mesmo padrão de `clarice-sync-brevo.ts::Checkpoint`,
// adaptado — só full, sem `modifiedSince`).
// ---------------------------------------------------------------------------

export interface BrevoIngestCheckpoint {
  listingComplete: boolean;
  ids: Array<{ id: number; email: string }>;
  doneIds: number[];
}

export function checkpointPathForAccount(dbPath: string, platform: BrevoAccountPlatform): string {
  return resolve(dirname(dbPath), `.brevo-ingest-checkpoint-${platform}.json`);
}

function loadCheckpoint(path: string): BrevoIngestCheckpoint | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BrevoIngestCheckpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: BrevoIngestCheckpoint, path: string): void {
  writeFileAtomic(path, JSON.stringify(cp));
}

/** Enumera contatos (id + email) via `/contacts`, paginado, resumível —
 *  reusa `contactsListPath` de `clarice-sync-brevo.ts` (mesmo formato de
 *  paginação `limit=500&offset=N`, sem `modifiedSince` — full sempre aqui). */
async function enumerateContacts(
  apiKey: string,
  existing: BrevoIngestCheckpoint | null,
  checkpointPath: string,
): Promise<BrevoIngestCheckpoint> {
  if (existing?.listingComplete) return existing;
  const ids: Array<{ id: number; email: string }> = existing?.ids ?? [];
  const doneIds = existing?.doneIds ?? [];
  let offset = ids.length;
  for (;;) {
    const { body } = await brevoGet(apiKey, contactsListPath(offset, null));
    const cs = (body?.contacts ?? []) as Array<{ id: number; email?: string }>;
    for (const c of cs) ids.push({ id: c.id, email: String(c.email ?? "").toLowerCase() });
    const complete = cs.length < 500;
    saveCheckpoint({ listingComplete: complete, ids, doneIds }, checkpointPath);
    console.error(`  📇 listando contatos… ${ids.length}`);
    if (complete) break;
    offset += 500;
    await sleep(PAGE_PACING_MS);
  }
  return { listingComplete: true, ids, doneIds };
}

// ---------------------------------------------------------------------------
// Ingestão de 1 conta
// ---------------------------------------------------------------------------

export interface AccountIngestResult {
  platform: BrevoAccountPlatform;
  contactsListed: number;
  contactsProcessed: number;
  contactsFailed: number;
  eventsNew: number;
  eventsAlreadyKnown: number;
  eventsSkippedNoTimestamp: number;
}

export interface AccountIngestDeps {
  fetchContact: (apiKey: string, id: number) => Promise<Record<string, any>>;
}

function makeRealDeps(): AccountIngestDeps {
  return {
    fetchContact: async (apiKey, id) => {
      const { body } = await brevoGet(apiKey, `/contacts/${id}`);
      return body;
    },
  };
}

/**
 * Ingere 1 conta Brevo inteira: enumera contatos (resumível), busca cada um
 * (`concurrency` em paralelo, mesmo padrão de `clarice-sync-brevo.ts`) e
 * grava via `ingestBrevoContact`. Checkpoint por-contato (`doneIds`) garante
 * que uma interrupção (rate-limit, Ctrl+C) não perde progresso — re-rodar
 * pula quem já está `doneIds` e continua o resto.
 */
export async function ingestAccount(
  db: DatabaseSync,
  apiKey: string,
  platform: BrevoAccountPlatform,
  dbPath: string,
  opts: { concurrency?: number; limit?: number; deps?: AccountIngestDeps } = {},
): Promise<AccountIngestResult> {
  const concurrency = opts.concurrency ?? 4;
  const deps = opts.deps ?? makeRealDeps();
  const checkpointPath = checkpointPathForAccount(dbPath, platform);

  let loaded = loadCheckpoint(checkpointPath);
  const cp = await enumerateContacts(apiKey, loaded, checkpointPath);
  const done = new Set<number>(cp.doneIds);
  let pending = cp.ids.filter((c) => c.id && !done.has(c.id));
  if (opts.limit && opts.limit > 0) pending = pending.slice(0, opts.limit);

  console.error(`  🔎 ${cp.ids.length} contato(s) · ${done.size} já feito(s) · ${pending.length} a processar`);

  let contactsProcessed = 0;
  let contactsFailed = 0;
  let eventsNew = 0;
  let eventsAlreadyKnown = 0;
  let eventsSkippedNoTimestamp = 0;
  let sinceFlush = 0;

  await pool(pending, concurrency, async (c) => {
    try {
      const contact = await deps.fetchContact(apiKey, c.id);
      const result = ingestBrevoContact(db, platform, c.id, contact);
      eventsNew += result.newEvents;
      eventsAlreadyKnown += result.alreadyKnown;
      eventsSkippedNoTimestamp += result.skippedNoTimestamp;
      contactsProcessed++;
    } catch (e) {
      contactsFailed++;
      console.error(`  ⚠️  contato ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
      return; // não marca done — re-rodar tenta de novo
    }
    done.add(c.id);
    sinceFlush++;
    if (sinceFlush >= CHECKPOINT_FLUSH_EVERY) {
      sinceFlush = 0;
      saveCheckpoint({ listingComplete: true, ids: cp.ids, doneIds: [...done] }, checkpointPath);
    }
  });
  saveCheckpoint({ listingComplete: true, ids: cp.ids, doneIds: [...done] }, checkpointPath);

  // Enumeração + processamento completos, nada pendente → limpa o
  // checkpoint (mesmo padrão de `clarice-sync-brevo.ts`: uma rodada futura
  // recomeça a enumeração do zero, o que é OK — os EVENTOS já gravados
  // seguem intocados via idempotência do `recordEvent`).
  if (done.size >= cp.ids.length && existsSync(checkpointPath)) {
    try {
      unlinkSync(checkpointPath);
    } catch {
      /* não-bloqueante */
    }
  }

  return {
    platform,
    contactsListed: cp.ids.length,
    contactsProcessed,
    contactsFailed,
    eventsNew,
    eventsAlreadyKnown,
    eventsSkippedNoTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Manifest (resumo por CONTA — o progresso granular fica no checkpoint acima)
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
  loadProjectEnv();

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const manifestPath = getArg(argv, "manifest") || DEFAULT_MANIFEST_PATH;
  const accountFilter = getArg(argv, "account");
  const limit = getIntArg(argv, "limit", { min: 1 });
  const concurrency = getIntArg(argv, "concurrency", { min: 1 }) ?? 4;

  if (accountFilter && !BREVO_ACCOUNTS.some((a) => a.platform === accountFilter)) {
    console.error(`❌ --account inválido: "${accountFilter}" (esperado: brevo_diaria | brevo_clarice)`);
    process.exitCode = 1;
    return;
  }

  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir);
  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot} (ver CLAUDE.md setup, passo 2b)`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = openDiariaSubscribersDb(dbPath);
  let manifest = loadManifest(manifestPath);
  const results: AccountIngestResult[] = [];

  const accounts = accountFilter ? BREVO_ACCOUNTS.filter((a) => a.platform === accountFilter) : BREVO_ACCOUNTS;

  for (const account of accounts) {
    const apiKey = process.env[account.apiKeyEnv];
    if (!apiKey) {
      console.error(`⚠️  ${account.apiKeyEnv} ausente no env — pulando conta ${account.platform}.`);
      manifest = upsertManifestEntry(manifest, {
        id: account.platform,
        status: "error",
        error: `${account.apiKeyEnv} ausente no env`,
        fetched_at: new Date().toISOString(),
      });
      saveManifest(manifestPath, manifest);
      continue;
    }
    console.error(`🔄 ingerindo conta ${account.platform}…`);
    try {
      const result = await ingestAccount(db, apiKey, account.platform, dbPath, { concurrency, limit });
      results.push(result);
      manifest = upsertManifestEntry(manifest, {
        id: account.platform,
        status: result.contactsFailed > 0 ? "partial" : "ok",
        counts: {
          contacts_listed: result.contactsListed,
          contacts_processed: result.contactsProcessed,
          contacts_failed: result.contactsFailed,
          events_new: result.eventsNew,
        },
        fetched_at: new Date().toISOString(),
      });
      console.error(
        `  ✅ ${account.platform}: ${result.contactsProcessed}/${result.contactsListed} contato(s) · ` +
          `${result.eventsNew} evento(s) novo(s) · ${result.contactsFailed} falha(s)`,
      );
    } catch (e) {
      console.error(`  ⚠️  ${account.platform} interrompida: ${e instanceof Error ? e.message : String(e)}. Re-rode pra continuar de onde parou.`);
      manifest = upsertManifestEntry(manifest, {
        id: account.platform,
        status: "partial",
        error: e instanceof Error ? e.message : String(e),
        fetched_at: new Date().toISOString(),
      });
    }
    saveManifest(manifestPath, manifest);
  }

  db.close();

  console.log(
    JSON.stringify(
      {
        db: dbPath,
        manifest: manifestPath,
        accounts: results,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[diaria-subscribers-ingest-brevo] erro fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
