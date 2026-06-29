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
import { getArg } from "./lib/cli-args.ts";

// import.meta.dirname pode vir undefined em loaders CJS (tsx eval / import
// deep-relative) — fallback pra cwd (scripts rodam da raiz do repo).
const ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..") : process.cwd();
const CHECKPOINT = resolve(
  ROOT,
  "data/clarice-subscribers/.brevo-sync-checkpoint.json",
);
const BATCH = 200; // flush no DB + checkpoint a cada N contatos (durabilidade)
const PAGE_PACING_MS = 250; // pacing leve entre páginas do listing (memória brevo-hourly-ratelimit)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Checkpoint {
  listingComplete: boolean;
  ids: Array<{ id: number; email: string }>;
  doneIds: number[];
}

function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT)) return null;
  try {
    return JSON.parse(readFileSync(CHECKPOINT, "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  writeFileSync(CHECKPOINT, JSON.stringify(cp), "utf8");
}

/** Enumera todos os contatos (id + email) paginando /contacts. Resumível. */
async function enumerateContacts(
  apiKey: string,
  existing: Checkpoint | null,
): Promise<Checkpoint> {
  if (existing?.listingComplete) return existing;
  const ids: Array<{ id: number; email: string }> = existing?.ids ?? [];
  const doneIds = existing?.doneIds ?? [];
  let offset = ids.length;
  for (;;) {
    const { body } = await brevoGet(
      apiKey,
      `/contacts?limit=500&offset=${offset}`,
    );
    const cs = body?.contacts ?? [];
    for (const c of cs)
      ids.push({ id: c.id, email: String(c.email ?? "").toLowerCase() });
    const complete = cs.length < 500;
    // checkpoint POR PÁGINA → se o listing cair no meio (rate-limit), re-rodar
    // retoma de offset=ids.length em vez de re-enumerar do zero.
    saveCheckpoint({ listingComplete: complete, ids, doneIds });
    console.error(`📇 listando contatos… ${ids.length}`);
    if (complete) break;
    offset += 500;
    await sleep(PAGE_PACING_MS);
  }
  return { listingComplete: true, ids, doneIds };
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

  // Fase 1 — enumerar ids (resumível).
  let cp = await enumerateContacts(apiKey, loadCheckpoint());
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
    saveCheckpoint(cp);
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
  if (existsSync(CHECKPOINT)) unlinkSync(CHECKPOINT);

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
