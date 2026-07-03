#!/usr/bin/env node
/**
 * clarice-sync-brevo.ts — sincroniza engajamento/supressão do Brevo pro store
 * único de usuários da Clarice (#2647 follow-up). Fecha o gap que deixava
 * `send_eligible` não-autoritativo (descadastro/bounce ficavam no default).
 *
 * Por contato (GET /contacts/{id}): opens/clicks/sends, hard/soft bounces,
 * unsub, complaints, last_*_at, blacklist, RECENCY_QUARTIL, listIds, timestamps.
 * Parsing puro em `lib/brevo-stats.ts`; upsert em `lib/clarice-db.ts`.
 *
 * ⚠️ PESADO + RATE-LIMITED: a base toda são dezenas de milhares de contatos =
 * 1 GET por contato. A Brevo tem limite HORÁRIO (memória `brevo-hourly-ratelimit`)
 * — o `brevoGet` reusado respeita `Retry-After`, mas um run completo pode esgotar
 * a cota. Por isso o run é **checkpoint-resumável**: o progresso é durável no
 * próprio DB (upsert incremental em transações de BATCH) + um checkpoint de ids
 * já processados. Se cair (rate-limit/Ctrl+C), re-rodar continua de onde parou.
 *
 * Uso:
 *   npx tsx scripts/clarice-sync-brevo.ts [--db <p>] [--concurrency N] [--limit N]
 *   (--limit: processa só os N primeiros contatos — sync parcial / teste)
 *
 * INCREMENTAL (#2928): --incremental sincroniza SÓ os contatos modificados desde
 * o último sync (deriva de MAX(brevo_modified_at) − 5min), via `modifiedSince` da
 * Brevo → uma fração das chamadas, sem hammering do teto horário. --modified-since
 * <ISO> força uma data explícita. Sem nenhum dos dois = full (comportamento antigo).
 *
 * Requer BREVO_CLARICE_API_KEY no env. Stdout: JSON summary. Stderr: progresso.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoGet } from "./lib/brevo-client.ts";
import { pool } from "./lib/pool.ts";
import { parseBrevoContact } from "./lib/brevo-stats.ts";
import {
  openClariceDb,
  makeBrevoUpsert,
  recomputeDerived,
  DEFAULT_DB_PATH,
} from "./lib/clarice-db.ts";
import { getArg, hasFlag } from "./lib/cli-args.ts";

// import.meta.dirname pode vir undefined em loaders CJS (tsx eval / import
// deep-relative) — fallback pra cwd (scripts rodam da raiz do repo).
const ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..") : process.cwd();
const CHECKPOINT = resolve(
  ROOT,
  "data/clarice-subscribers/.brevo-sync-checkpoint.json",
);
// #2928: checkpoint SEPARADO pro incremental — enumera um conjunto diferente
// (só os mudados), não pode clobberar o resume do full.
const CHECKPOINT_INC = resolve(
  ROOT,
  "data/clarice-subscribers/.brevo-sync-checkpoint-inc.json",
);
const BATCH = 200; // flush no DB + checkpoint a cada N contatos (durabilidade)
const PAGE_PACING_MS = 250; // pacing leve entre páginas do listing (memória brevo-hourly-ratelimit)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Checkpoint {
  listingComplete: boolean;
  ids: Array<{ id: number; email: string }>;
  doneIds: number[];
  // #2928: qual modifiedSince gerou esta enumeração (null = full). Resume só é
  // válido pra mesma data; datas/modos diferentes descartam o checkpoint.
  modifiedSince?: string | null;
}

function loadCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: Checkpoint, path: string): void {
  writeFileSync(path, JSON.stringify(cp), "utf8");
}

/**
 * #2928: path do listing de contatos (limit 500 + offset), com `modifiedSince`
 * opcional encodado. Pure/testável.
 */
export function contactsListPath(offset: number, modifiedSince: string | null): string {
  const since = modifiedSince ? `&modifiedSince=${encodeURIComponent(modifiedSince)}` : "";
  return `/contacts?limit=500&offset=${offset}${since}`;
}

/**
 * #2928: deriva o `modifiedSince` do incremental a partir de MAX(brevo_modified_at)
 * menos um buffer (default 5min, pra não perder contatos na fronteira do último
 * sync). Devolve ISO UTC, ou null se a data for ausente/inválida (→ cai pra full).
 * Pure/testável.
 */
export function deriveIncrementalSince(
  maxBrevoModifiedAt: string | null | undefined,
  bufferMs = 5 * 60_000,
): string | null {
  if (!maxBrevoModifiedAt) return null;
  const t = new Date(maxBrevoModifiedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - bufferMs).toISOString();
}

/**
 * Enumera contatos (id + email) paginando /contacts. Resumível.
 * #2928: com `modifiedSince` (ISO), enumera SÓ os contatos modificados desde
 * então (Brevo `modifiedSince`) — o incremental. null = full.
 */
async function enumerateContacts(
  apiKey: string,
  existing: Checkpoint | null,
  modifiedSince: string | null,
  checkpointPath: string,
): Promise<Checkpoint> {
  if (existing?.listingComplete) return existing;
  const ids: Array<{ id: number; email: string }> = existing?.ids ?? [];
  const doneIds = existing?.doneIds ?? [];
  let offset = ids.length;
  for (;;) {
    const { body } = await brevoGet(apiKey, contactsListPath(offset, modifiedSince));
    const cs = body?.contacts ?? [];
    for (const c of cs)
      ids.push({ id: c.id, email: String(c.email ?? "").toLowerCase() });
    const complete = cs.length < 500;
    // checkpoint POR PÁGINA → se o listing cair no meio (rate-limit), re-rodar
    // retoma de offset=ids.length em vez de re-enumerar do zero.
    saveCheckpoint({ listingComplete: complete, ids, doneIds, modifiedSince }, checkpointPath);
    console.error(`📇 listando contatos${modifiedSince ? " (incremental)" : ""}… ${ids.length}`);
    if (complete) break;
    offset += 500;
    await sleep(PAGE_PACING_MS);
  }
  return { listingComplete: true, ids, doneIds, modifiedSince };
}


export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  loadProjectEnv();
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("❌ BREVO_CLARICE_API_KEY ausente no env.");
    process.exit(1);
  }

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const concurrency = Number(getArg(argv, "concurrency")) || 4;
  const limitArg = Number(getArg(argv, "limit")) || 0;

  const db = openClariceDb(dbPath);
  const upsertBrevo = makeBrevoUpsert(db);

  // #2928: modo incremental — --modified-since <ISO> explícito, ou --incremental
  // deriva de MAX(brevo_modified_at) − 5min (buffer contra perder a fronteira).
  const explicitSince = getArg(argv, "modified-since");
  let modifiedSince: string | null = explicitSince || null;
  if (!modifiedSince && hasFlag(argv, "incremental")) {
    const row = db
      .prepare("SELECT MAX(brevo_modified_at) AS m FROM clarice_users")
      .get() as { m: string | null };
    modifiedSince = deriveIncrementalSince(row?.m);
    if (modifiedSince) {
      console.error(`⏩ incremental: modifiedSince=${modifiedSince} (MAX(brevo_modified_at) − 5min)`);
    } else {
      console.error("⚠️  --incremental mas store sem brevo_modified_at — caindo pra sync FULL.");
    }
  }
  const checkpointPath = modifiedSince ? CHECKPOINT_INC : CHECKPOINT;

  // Fase 1 — enumerar ids (resumível). Checkpoint de outra data/modo → descarta.
  let loaded = loadCheckpoint(checkpointPath);
  if (loaded && (loaded.modifiedSince ?? null) !== modifiedSince) {
    console.error("ℹ️  checkpoint de outra data/modo — recomeçando enumeração.");
    loaded = null;
  }
  let cp = await enumerateContacts(apiKey, loaded, modifiedSince, checkpointPath);
  const done = new Set<number>(cp.doneIds);
  let pending = cp.ids.filter((c) => c.id && c.email && !done.has(c.id));
  if (limitArg > 0) pending = pending.slice(0, limitArg);
  console.error(
    `🔎 ${cp.ids.length} contatos · ${done.size} já feitos · ${pending.length} a processar`,
  );

  // Fase 2 — per-id GET + parse + upsert, em batches transacionais duráveis.
  let buffer: Array<{ id: number; cols: ReturnType<typeof parseBrevoContact> }> =
    [];
  let processed = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    db.exec("BEGIN");
    try {
      for (const b of batch) upsertBrevo(b.cols);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      // batch NÃO entra em done → re-run re-busca (idempotente). Não re-bufferiza
      // pra não arriscar loop no mesmo erro persistente.
      throw e;
    }
    // done/checkpoint só APÓS o COMMIT durável (senão um COMMIT que falha deixaria
    // ids "feitos" sem linha no DB).
    for (const b of batch) done.add(b.id);
    cp.doneIds = [...done];
    saveCheckpoint(cp, checkpointPath);
  };

  try {
    await pool(pending, concurrency, async (c) => {
      const { body } = await brevoGet(apiKey, `/contacts/${c.id}`);
      // 404 (sumiu entre listar e buscar) → body {} → parse vira tudo-zero; marca
      // como done mesmo assim pra não re-tentar em loop.
      buffer.push({ id: c.id, cols: parseBrevoContact(body) });
      processed++;
      if (buffer.length >= BATCH) flush();
      if (processed % BATCH === 0)
        console.error(`  …${processed}/${pending.length}`);
    });
    flush();
  } catch (e) {
    // persiste o que já veio antes de abortar; um flush que TAMBÉM falhe não pode
    // escapar daqui (senão db.close()/exit 2 não rodam → exit 1 com stack).
    try {
      flush();
    } catch (flushErr) {
      console.error(`⚠️  flush final falhou: ${(flushErr as Error).message}`);
    }
    console.error(
      `⚠️  sync interrompido (${(e as Error).message}). ${done.size}/${cp.ids.length} ` +
        `salvos no DB + checkpoint. Re-rode pra continuar de onde parou.`,
    );
    db.close();
    process.exit(2);
  }

  // Concluído: recompute global + limpa checkpoint.
  console.error(`⚙️  recomputando derivados (send_eligible + priority_points)…`);
  const derived = recomputeDerived(db);
  if (existsSync(checkpointPath)) unlinkSync(checkpointPath);

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM clarice_users").get() as { n: number }
  ).n;
  const suppressed = (
    db
      .prepare("SELECT COUNT(*) AS n FROM clarice_users WHERE send_eligible = 0")
      .get() as { n: number }
  ).n;
  db.close();

  console.log(
    JSON.stringify(
      {
        db: dbPath,
        mode: modifiedSince ? "incremental" : "full",
        modified_since: modifiedSince,
        contacts_listed: cp.ids.length,
        contacts_synced: processed,
        users_total: total,
        suppressed,
        derived_recomputed: derived,
        brevo_synced: true,
      },
      null,
      2,
    ),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
