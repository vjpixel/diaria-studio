#!/usr/bin/env node
/**
 * scripts/ads-daily-digest.ts (#7487)
 *
 * Task diária `Diaria-Ads-Daily-Digest` (~10h BRT, depois de
 * `Diaria-Google-Ads-Spend-Ingest` às 09:50) — SEMPRE envia um e-mail
 * resumindo o gasto em ads, mesmo quando não houve gasto nenhum no
 * período. Diferente de `ads-test-watch.ts` (alarme condicional — só
 * envia quando há marco acionável), este script existe justamente pra
 * eliminar a ambiguidade entre "sem gasto" e "task falhou/não rodou".
 *
 * Lógica pura em `scripts/lib/ads-daily-digest.ts` — este arquivo é só
 * I/O: ler `spend.csv` (+ histórico leve pra derivar delta diário),
 * `run-state.json` do teste 2608 (opcional), o snapshot Beehiiv mais
 * recente disponível (opcional), enviar e-mail, e persistir o histórico.
 *
 * **NUNCA chama nenhuma API paga (Google/Meta/Microsoft Ads) ao vivo** —
 * essa ingestão já rodou antes, às 09:50 (`Diaria-Google-Ads-Spend-Ingest`);
 * este script só LÊ o resultado local.
 *
 * Uso:
 *   npx tsx scripts/ads-daily-digest.ts               # avalia + envia + grava histórico
 *   npx tsx scripts/ads-daily-digest.ts --dry-run      # avalia + imprime, não envia nem grava
 *   npx tsx scripts/ads-daily-digest.ts --to email@x   # override do destinatário
 *
 * Guard: se o junction `data/` (OneDrive) não estiver montado, aborta
 * graciosamente (exit 0, log informativo) — mesmo padrão de
 * `scripts/ads-test-watch.ts`/`scripts/lib/exec-mode.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage, type GmailSendResult } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
import { addDays } from "./lib/ads-test-schedule.ts";
import { readSpendCsv } from "./lib/aquisicao-spend.ts";
import { assertValidRunState, type AdsTestRunState } from "./lib/ads-test-run-state.ts";
import { latestSnapshotDate, readSnapshotSubscribers } from "./lib/beehiiv-backup-snapshots.ts";
import {
  computeChannelDeltas,
  summarizeTeste2608,
  totalSpendByKnownChannel,
  computeReadersByChannel,
  buildAdsDailyDigestEmail,
  toHistoryRows,
  emptyDigestHistory,
  type AdsDailyDigestHistory,
} from "./lib/ads-daily-digest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AQUISICAO_DIR = resolve(ROOT, "data/aquisicao");
export const DEFAULT_SPEND_CSV_PATH = resolve(AQUISICAO_DIR, "spend.csv");
export const DEFAULT_HISTORY_PATH = resolve(AQUISICAO_DIR, ".ads-daily-digest-history.json");
export const DEFAULT_RUN_STATE_PATH = resolve(AQUISICAO_DIR, "teste-2608/run-state.json");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[ads-daily-digest]";

export interface AdsDailyDigestDeps {
  spendCsvPath: string;
  historyPath: string;
  runStatePath: string;
  backupRoot: string;
  now: () => Date;
  sendEmail: (to: string, subject: string, body: string) => Promise<GmailSendResult>;
  execMode: () => "local" | "cloud";
}

function defaultDeps(): AdsDailyDigestDeps {
  return {
    spendCsvPath: DEFAULT_SPEND_CSV_PATH,
    historyPath: DEFAULT_HISTORY_PATH,
    runStatePath: DEFAULT_RUN_STATE_PATH,
    backupRoot: DEFAULT_BACKUP_ROOT,
    now: () => new Date(),
    sendEmail: sendGmailMessage,
    execMode: () => detectExecMode({ projectRoot: ROOT }),
  };
}

function loadHistory(path: string): AdsDailyDigestHistory {
  if (!existsSync(path)) return emptyDigestHistory();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AdsDailyDigestHistory>;
    if (!Array.isArray(raw.rows)) return emptyDigestHistory();
    return { rows: raw.rows, capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : "" };
  } catch {
    return emptyDigestHistory();
  }
}

function saveHistory(history: AdsDailyDigestHistory, path: string): void {
  writeFileAtomic(path, JSON.stringify(history, null, 2) + "\n");
}

function loadRunState(path: string): AdsTestRunState | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assertValidRunState(raw);
    return raw;
  } catch (e) {
    console.error(`${LOG_PREFIX} run-state.json ilegível/corrompido, ignorando teste 2608 nesta corrida: ${(e as Error).message}`);
    return null;
  }
}

export async function main(argv: string[] = process.argv.slice(2), depsOverride: Partial<AdsDailyDigestDeps> = {}): Promise<void> {
  loadProjectEnv(ROOT);

  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const deps: AdsDailyDigestDeps = { ...defaultDeps(), ...depsOverride };

  if (deps.execMode() === "cloud") {
    console.log(`${LOG_PREFIX} data/ ausente (modo cloud) — abortando graciosamente, nada a fazer.`);
    return;
  }

  if (!existsSync(deps.spendCsvPath)) {
    console.log(`${LOG_PREFIX} spend.csv não encontrado (${deps.spendCsvPath}) — provável junction data/ não montada; abortando por segurança.`);
    return;
  }

  const now = deps.now();
  const todayIso = now.toISOString().slice(0, 10);
  const periodDate = addDays(todayIso, -1); // "dia anterior" — issue #7487

  const { rows: currentRows, errors } = readSpendCsv(deps.spendCsvPath);
  for (const err of errors) {
    console.error(`${LOG_PREFIX} spend.csv linha ${err.line}: ${err.reason}`);
  }

  const history = loadHistory(deps.historyPath);
  const deltas = computeChannelDeltas(currentRows, history.rows);

  const runState = loadRunState(deps.runStatePath);
  const teste2608 = summarizeTeste2608(currentRows, runState, todayIso);

  const spendByChannel = totalSpendByKnownChannel(currentRows);
  const snapshotDate = latestSnapshotDate(deps.backupRoot);
  const subs = snapshotDate ? readSnapshotSubscribers(deps.backupRoot, snapshotDate) : null;
  const readers = computeReadersByChannel(subs, spendByChannel);

  const { subject, body } = buildAdsDailyDigestEmail({
    periodDate,
    deltas,
    teste2608,
    readers,
    readersSnapshotDate: snapshotDate,
  });

  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    return;
  }

  await deps.sendEmail(to, subject, body);
  console.log(`${LOG_PREFIX} e-mail enviado pra ${to}: "${subject}"`);

  saveHistory({ rows: toHistoryRows(currentRows), capturedAt: now.toISOString() }, deps.historyPath);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
