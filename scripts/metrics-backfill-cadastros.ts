#!/usr/bin/env node
/**
 * scripts/metrics-backfill-cadastros.ts (#7179, F7 do épico #7172)
 *
 * CLI de I/O do backfill histórico de cadastros Beehiiv — miolo puro em
 * `scripts/lib/metrics/beehiiv-backfill.ts` (`@pure`). Lê os snapshots
 * locais de `data/beehiiv-backup/`, reconstrói 1 linha por e-mail (aparição
 * mais antiga vence — ver docstring do miolo), grava no store unificado
 * (`scripts/lib/diaria-subscribers-db.ts`, platform `"beehiiv"`) e em
 * `data/metrics/captura-log.jsonl` (1 linha por DIA reconstruído).
 *
 * **Nunca toca rede** — só lê arquivos locais já existentes (guard de
 * publicação do overnight/develop: nenhuma chamada à API Beehiiv/Kit aqui).
 *
 * ## Passo prévio recomendado (fora deste CLI)
 *
 *   npx tsx scripts/build-origem-map.ts
 *
 * Regenera `data/aquisicao/origem-original.json` a partir dos snapshots
 * atuais — sem rodar isto antes, o backfill roda contra a foto mais antiga
 * do mapa de origem e quem apareceu depois fica sem recuperação de origem
 * (o `utm_source` da reativação vaza pra série). Este CLI não roda o
 * regenerador sozinho (ele já tem I/O e argumentos próprios) — decisão
 * explícita de manter os dois CLIs separados, mesma disciplina de
 * `cac-report.ts`, que também espera o mapa já regenerado.
 *
 * ## 2 modos, mutuamente exclusivos
 *
 * **Modo backfill (default).** Varre TODOS os snapshots de `--backup-root`,
 * monta as linhas via `buildBeehiivBackfillRows` e grava (dry-run por
 * padrão — `--write` grava de verdade no store + captura-log).
 *
 * **Modo seed do log (`--seed-gap-until AAAA-MM-DD`).** Só grava linhas
 * `captura-log.jsonl` `origem_serie: "seed-kit"` para os dias de
 * `[2026-08-25, until]` — NENHUMA linha de cadastro é escrita (a contagem
 * real desses dias vem de graça na 1ª execução de F2 — ver docstring de
 * `enumerateSeedGapDays`). Rodar depois da 1ª execução de F2 (#7174),
 * passando o dia do armamento como `until`.
 *
 * ## Idempotência
 *
 * Store: `ensureSubscriber`/`upsertSubscription` fazem find-or-create/
 * upsert; `recordEvent` usa `INSERT OR IGNORE` sobre a chave natural
 * (inclui `enteredAt`, estável entre re-execuções) — re-rodar não duplica.
 * `captura-log.jsonl`: as linhas por DIA que este CLI escreve (`dia` +
 * `origem_serie`) são checadas contra o que já existe no arquivo ANTES de
 * qualquer `appendFileSync` — um dia já presente (mesmo `dia` + mesmo
 * `origem_serie`) nunca é reescrito nem duplicado (o arquivo é append-only
 * por design — ver docstring de `captura-log.ts` — a idempotência aqui é
 * "não gerar a linha de novo", não "sobrescrever a existente").
 *
 * Uso:
 *   npx tsx scripts/metrics-backfill-cadastros.ts [--write]
 *     [--backup-root <p>] [--origem-map <p>] [--db <p>] [--captura-log <p>]
 *   npx tsx scripts/metrics-backfill-cadastros.ts --seed-gap-until 2026-09-01 [--write]
 *     [--captura-log <p>]
 *
 * Dry-run por padrão nos dois modos (só imprime o plano). `--write` grava.
 * Stdout: JSON summary. Exit 1 só se `data/` estiver ausente.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { getArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { listSnapshotDates } from "./lib/beehiiv-backup-snapshots.ts";
import { DEFAULT_BACKUP_ROOT, DEFAULT_ORIGEM_MAP_PATH, loadOrigemIndex, loadPreparedSubscribers } from "./cac-report.ts";
import {
  buildBeehiivBackfillRows,
  countBackfillRowsByDay,
  enumerateSeedGapDays,
  type BeehiivBackfillRow,
} from "./lib/metrics/beehiiv-backfill.ts";
import { buildCapturaLogEntry, serializeCapturaLogEntry, type CapturaLogEntry } from "./lib/metrics/captura-log.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb, ensureSubscriber, upsertSubscription, recordEvent } from "./lib/diaria-subscribers-db.ts";

export function defaultCapturaLogPath(dbPath: string): string {
  return resolve(dirname(dbPath), "..", "metrics", "captura-log.jsonl");
}

function readCapturaLogEntries(path: string): CapturaLogEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: CapturaLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as CapturaLogEntry);
    } catch {
      continue; // linha corrompida — mesmo fail-soft de metrics-cli.ts
    }
  }
  return out;
}

/** Dias já presentes em `captura-log.jsonl` para um dado `origem_serie` —
 *  usado pelos dois modos pra não reescrever/duplicar uma linha já gravada
 *  numa execução anterior deste CLI. */
function alreadyLoggedDays(entries: readonly CapturaLogEntry[], origemSerie: string): Set<string> {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.origem_serie === origemSerie && e.dia) set.add(e.dia);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Modo backfill
// ---------------------------------------------------------------------------

function writeBackfillRow(
  db: ReturnType<typeof openDiariaSubscribersDb>,
  row: BeehiivBackfillRow,
  now: string,
): void {
  const subscriberId = ensureSubscriber(db, "beehiiv", row.externalId, row.email, now);
  upsertSubscription(
    db,
    subscriberId,
    "beehiiv",
    {
      status: row.status,
      enteredAt: row.enteredAt,
      exitedAt: null,
      source: row.utmSource,
      utmMedium: row.utmMedium,
      utmCampaign: row.utmCampaign,
      utmChannel: row.utmChannel,
      referringSite: row.referringSite,
      utmSource: row.utmSource,
      atribuicaoFonte: row.atribuicaoFonte,
      reativado: row.reativado,
      origemSerie: row.origemSerie,
    },
    now,
  );
  const identityKey = row.externalId ?? row.email;
  recordEvent(db, {
    subscriberId,
    platform: "beehiiv",
    type: "subscribe",
    externalEventId: `${identityKey}:subscribe:${row.enteredAt}`,
    ts: row.enteredAt,
  });
}

async function runBackfill(argv: string[]): Promise<void> {
  const backupRoot = getArg(argv, "backup-root") || DEFAULT_BACKUP_ROOT;
  const origemPath = getArg(argv, "origem-map") || DEFAULT_ORIGEM_MAP_PATH;
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const capturaLogPath = getArg(argv, "captura-log") || defaultCapturaLogPath(dbPath);
  const write = hasFlag(argv, "write");

  const dates = listSnapshotDates(backupRoot);
  if (dates.length === 0) {
    console.error(`❌ nenhum snapshot encontrado em ${backupRoot} — nada a backfillar.`);
    process.exitCode = 1;
    return;
  }

  const { index: origemIndex, applied } = loadOrigemIndex(origemPath);
  if (!applied) {
    console.error(
      `⚠ mapa de origem ausente/ilegível (${origemPath}) — o backfill roda com o utm_source cru do ` +
        `snapshot mais antigo por e-mail. Rode "npx tsx scripts/build-origem-map.ts" antes pra melhor cobertura.`,
    );
  }

  console.error(`📇 lendo ${dates.length} snapshot(s) de ${backupRoot}…`);
  let internalFilteredTotal = 0;
  const snapshots = dates.map((date) => {
    const { subs, internalFiltered } = loadPreparedSubscribers(backupRoot, date, origemIndex);
    internalFilteredTotal += internalFiltered;
    return subs;
  });

  const { rows, totalEmailsSeen, excludedByWindow } = buildBeehiivBackfillRows(snapshots);
  const reativadoCount = rows.filter((r) => r.reativado).length;
  const byDay = countBackfillRowsByDay(rows);

  console.error(
    `  …${totalEmailsSeen} e-mail(is) único(s) visto(s), ${excludedByWindow} excluído(s) pela fronteira ` +
      `(>= 2026-08-25), ${rows.length} linha(s) de backfill (${reativadoCount} reativado(s)), ` +
      `${internalFilteredTotal} interno(s)/teste filtrado(s), cobrindo ${byDay.length} dia(s) distintos.`,
  );

  if (!write) {
    console.log(
      JSON.stringify(
        {
          mode: "backfill",
          write: false,
          totalEmailsSeen,
          excludedByWindow,
          rowsPlanned: rows.length,
          reativadoCount,
          diasCobertos: byDay.length,
          primeiroDia: byDay[0]?.dia ?? null,
          ultimoDia: byDay[byDay.length - 1]?.dia ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  const dataRoot = dirname(dirname(dbPath));
  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot} (ver CLAUDE.md setup, passo 2b)`);
    process.exitCode = 1;
    return;
  }
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = openDiariaSubscribersDb(dbPath);
  const now = new Date().toISOString();
  for (const row of rows) writeBackfillRow(db, row, now);
  db.close();

  const capturaLogDir = dirname(capturaLogPath);
  mkdirSync(capturaLogDir, { recursive: true });
  const existingLogEntries = readCapturaLogEntries(capturaLogPath);
  const alreadyLogged = alreadyLoggedDays(existingLogEntries, "backfill-beehiiv");
  let logLinesWritten = 0;
  for (const { dia, total } of byDay) {
    if (alreadyLogged.has(dia)) continue;
    const entry = buildCapturaLogEntry({
      platform: "beehiiv",
      capturedAt: now,
      totalRetornadoApi: total,
      novosGravados: total,
      eventosEstado: total,
      exit: 0,
      origemSerie: "backfill-beehiiv",
      dia,
    });
    appendFileSync(capturaLogPath, serializeCapturaLogEntry(entry));
    logLinesWritten++;
  }

  console.log(
    JSON.stringify(
      {
        mode: "backfill",
        write: true,
        db: dbPath,
        capturaLog: capturaLogPath,
        totalEmailsSeen,
        excludedByWindow,
        rowsWritten: rows.length,
        reativadoCount,
        diasCobertos: byDay.length,
        logLinesWritten,
        logLinesJaPresentes: byDay.length - logLinesWritten,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Modo seed do log (25/08 → dia do armamento de F2) — só o log
// ---------------------------------------------------------------------------

async function runSeedGapLog(argv: string[], until: string): Promise<void> {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const capturaLogPath = getArg(argv, "captura-log") || defaultCapturaLogPath(dbPath);
  const write = hasFlag(argv, "write");

  const days = enumerateSeedGapDays(until);
  const existingLogEntries = readCapturaLogEntries(capturaLogPath);
  const alreadyLogged = alreadyLoggedDays(existingLogEntries, "seed-kit");
  const pending = days.filter((d) => !alreadyLogged.has(d));

  console.error(`🌱 seed do log: ${days.length} dia(s) na janela, ${pending.length} pendente(s).`);

  if (!write) {
    console.log(JSON.stringify({ mode: "seed-gap-log", write: false, until, diasNaJanela: days.length, diasPendentes: pending.length }, null, 2));
    return;
  }

  const capturaLogDir = dirname(capturaLogPath);
  mkdirSync(capturaLogDir, { recursive: true });
  const now = new Date().toISOString();
  for (const dia of pending) {
    // Nenhuma linha de CADASTRO é escrita aqui — só a marca de "dia coberto"
    // (a contagem real vem de graça na 1ª execução de F2, status: "all").
    const entry = buildCapturaLogEntry({
      // "kit", não "beehiiv" — a linha marca que o DIA já está coberto pela
      // 1ª execução de F2 (Kit, `status: "all"`), não pelo backfill Beehiiv.
      platform: "kit",
      capturedAt: now,
      totalRetornadoApi: 0,
      novosGravados: 0,
      eventosEstado: 0,
      exit: 0,
      origemSerie: "seed-kit",
      dia,
    });
    appendFileSync(capturaLogPath, serializeCapturaLogEntry(entry));
  }

  console.log(
    JSON.stringify(
      { mode: "seed-gap-log", write: true, until, capturaLog: capturaLogPath, diasNaJanela: days.length, logLinesWritten: pending.length },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const seedGapUntil = getStringArg(argv, "seed-gap-until", { example: "2026-09-01" });
  if (seedGapUntil) {
    await runSeedGapLog(argv, seedGapUntil);
    return;
  }
  await runBackfill(argv);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[metrics-backfill-cadastros] erro fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
