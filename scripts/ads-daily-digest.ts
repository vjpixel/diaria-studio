#!/usr/bin/env node
/**
 * scripts/ads-daily-digest.ts (#7487)
 *
 * Task diária `Diaria-Ads-Daily-Digest` (~10h BRT, depois de
 * `Diaria-Google-Ads-Spend-Ingest` às 09:50) — SEMPRE produz um resumo do
 * gasto em ads, mesmo quando não houve gasto nenhum no período. Diferente
 * de `ads-test-watch.ts` (alarme condicional — só dispara quando há marco
 * acionável), este script existe justamente pra eliminar a ambiguidade
 * entre "sem gasto" e "task falhou/não rodou".
 *
 * **#7960 (item 4 da #7957): o destino do resumo é a superfície de
 * Relatórios do Studio (`/relatorios`, #3714), não mais um e-mail diário.**
 * O digest é `severity: "info"` no vocabulário do portão `notifyEditor`
 * (`scripts/lib/editor-notify.ts`) — informativo, nunca acionável — e a
 * decisão do editor (10/09/2026) é que "info" não manda e-mail: fica
 * visível onde o editor já olha. Concretamente: `data/aquisicao/ads-digests/
 * {periodDate}.md` + `registerReport({kind: "ads-digest"})`, e um evento
 * `notifyEditor({severity: "info"})` em `data/run-log.jsonl` pro digest não
 * sumir de quem lê `/diaria-log`. **Nada aqui é acionável por desenho** — o
 * que EXIGE ação do editor continua saindo pelos alarmes condicionais
 * dedicados (`ads-test-watch.ts`, `ads-kill-switch-alarm.ts`), que têm
 * gates próprios e permanecem intocados por esta mudança.
 *
 * Lógica pura em `scripts/lib/ads-daily-digest.ts` — este arquivo é só
 * I/O: ler `spend.csv` (+ histórico leve pra derivar delta diário),
 * `run-state.json` do teste 2608 (opcional), o snapshot Beehiiv mais
 * recente disponível (opcional), gravar/registrar o relatório, e persistir
 * o histórico.
 *
 * **NUNCA chama nenhuma API paga (Google/Meta/Microsoft Ads) ao vivo** —
 * essa ingestão já rodou antes, às 09:50 (`Diaria-Google-Ads-Spend-Ingest`);
 * este script só LÊ o resultado local.
 *
 * Uso:
 *   npx tsx scripts/ads-daily-digest.ts               # avalia + registra relatório + grava histórico
 *   npx tsx scripts/ads-daily-digest.ts --dry-run      # avalia + imprime, não registra nem grava
 *
 * `--to` (override de destinatário) foi REMOVIDA no #7960 junto com o canal
 * de e-mail — passá-la agora aborta com mensagem explícita, em vez de ser
 * ignorada em silêncio (nenhuma task do registro a usava; ver
 * `docs/scheduled-tasks-registry.md`).
 *
 * Guard: se o junction `data/` (OneDrive) não estiver montado, aborta
 * graciosamente (exit 0, log informativo) — mesmo padrão de
 * `scripts/ads-test-watch.ts`/`scripts/lib/exec-mode.ts`.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { registerReport, reportId, type ReportRegistryInput, type RegisterReportResult } from "./studio-ui/studio-reports.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
import { addDays } from "./lib/ads-test-schedule.ts";
import { readSpendCsv } from "./lib/aquisicao-spend.ts";
import { assertValidRunState, type AdsTestRunState } from "./lib/ads-test-run-state.ts";
import { latestSnapshotDate, readSnapshotSubscribers } from "./lib/beehiiv-backup-snapshots.ts";
import { parseClicksCsv } from "./lib/ads-test-watch.ts";
import {
  computeChannelDeltas,
  summarizeTeste2608,
  totalSpendByKnownChannel,
  computeReadersByChannel,
  computeSpendWatchDigestLines,
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
export const DEFAULT_CLICKS_CSV_PATH = resolve(AQUISICAO_DIR, "clicks-2608.csv");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
/** Onde o markdown do digest é persistido, relativo ao `rootDir` — o
 * registry do Studio (#3714) guarda o PATH, nunca o conteúdo. */
export const REPORTS_SUBDIR = "data/aquisicao/ads-digests";
const LOG_PREFIX = "[ads-daily-digest]";

export interface AdsDailyDigestDeps {
  spendCsvPath: string;
  historyPath: string;
  runStatePath: string;
  clicksCsvPath: string;
  backupRoot: string;
  now: () => Date;
  /** Raiz onde o markdown do digest é escrito e onde o registry do Studio
   * (`data/reports/index.jsonl`) vive — default `ROOT`; testes injetam um
   * tmpdir pra nunca registrar contra o registry real (mesmo padrão de
   * `cac-report.ts`). */
  rootDir: string;
  /** `registerReport` injetável (#7960) — substituiu o antigo `sendEmail`.
   * Default a implementação real de `scripts/studio-ui/studio-reports.ts`,
   * que é file-based e fail-soft (nunca lança, nunca depende do servidor do
   * Studio estar no ar). */
  registerReportFn: (rootDir: string, input: ReportRegistryInput) => RegisterReportResult;
  /** `notifyEditor` injetável (#7960) — só o ramo `severity: "info"`, que
   * grava no run-log e NUNCA manda e-mail nem abre issue. */
  notify: typeof notifyEditor;
  execMode: () => "local" | "cloud";
}

function defaultDeps(): AdsDailyDigestDeps {
  return {
    spendCsvPath: DEFAULT_SPEND_CSV_PATH,
    historyPath: DEFAULT_HISTORY_PATH,
    runStatePath: DEFAULT_RUN_STATE_PATH,
    clicksCsvPath: DEFAULT_CLICKS_CSV_PATH,
    backupRoot: DEFAULT_BACKUP_ROOT,
    now: () => new Date(),
    rootDir: ROOT,
    registerReportFn: registerReport,
    notify: notifyEditor,
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
  // #7960: `--to` era o override do destinatário do e-mail diário, que
  // deixou de existir. Abortar é deliberado — aceitar e ignorar deixaria um
  // caller (task antiga, comando colado de um runbook) achando que mandou o
  // digest pra outro endereço.
  if (getArg(argv, "to")) {
    console.error(
      `${LOG_PREFIX} --to não existe mais (#7960): o digest virou relatório do Studio (/relatorios), não e-mail. Rode sem a flag.`,
    );
    process.exitCode = 2;
    return;
  }
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

  // #8240 item 4 — aviso de gasto (1,25×-2×) + projeção de cruzamento do
  // nominal, como SEÇÃO deste digest (nunca e-mail próprio). Só lê o CSV
  // reconciliado à mão — este script nunca chama API paga ao vivo (ver
  // docstring do arquivo); `clicksCsvPath` ausente é benigno (teste ainda
  // não começou a reconciliar, ou junction `data/` sem esse arquivo ainda).
  let spendWatchLines: string[] = [];
  if (existsSync(deps.clicksCsvPath)) {
    try {
      const { rows: clicksRows, errors: clicksErrors } = parseClicksCsv(readFileSync(deps.clicksCsvPath, "utf8"));
      for (const err of clicksErrors) console.error(`${LOG_PREFIX} clicks-2608.csv linha ${err.line}: ${err.reason}`);
      spendWatchLines = computeSpendWatchDigestLines(clicksRows, runState, todayIso);
    } catch (e) {
      console.error(`${LOG_PREFIX} falha ao ler/parsear clicks-2608.csv (${(e as Error).message}) — seção de aviso de gasto omitida hoje.`);
    }
  }

  const { subject, body } = buildAdsDailyDigestEmail({
    periodDate,
    deltas,
    teste2608,
    readers,
    readersSnapshotDate: snapshotDate,
    spendWatchLines,
  });

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: registraria relatório:\n--- title ---\n${subject}\n--- body ---\n${body}`);
    return;
  }

  // #7960 (item 4 da #7957) — relatório do Studio em vez de e-mail.
  // Fail-soft como todo `registerReport` (#3714): falha de escrita/registro
  // vira aviso em stderr e NUNCA impede o `saveHistory` abaixo — o histórico
  // é o que dá sentido ao delta diário do PRÓXIMO digest, e perdê-lo por uma
  // falha de registro reportaria um delta inflado amanhã.
  const relPath = `${REPORTS_SUBDIR}/${periodDate}.md`;
  const absPath = resolve(deps.rootDir, relPath);
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileAtomic(absPath, body.endsWith("\n") ? body : body + "\n");
    const result = deps.registerReportFn(deps.rootDir, {
      kind: "ads-digest",
      sessionId: periodDate,
      title: subject,
      htmlPath: relPath,
    });
    if (result.ok) {
      console.log(`${LOG_PREFIX} registrado: /relatorios/${reportId("ads-digest", periodDate)} ("${subject}")`);
    } else {
      console.error(`${LOG_PREFIX} aviso: registro do relatório falhou (fail-soft, #3714): ${result.error}`);
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} aviso: não foi possível gravar ${relPath} (fail-soft): ${(e as Error).message}`);
  }

  // `severity: "info"` NUNCA manda e-mail nem abre issue em nenhuma das duas
  // políticas (`legacy`/`urgent_only`) — só garante que o digest aparece em
  // `data/run-log.jsonl`, lido por `/diaria-log` e pelo auto-reporter.
  await deps.notify(
    {
      check: "ads-daily-digest",
      fingerprint: periodDate,
      severity: "info",
      subject,
      body,
    },
    { cwd: deps.rootDir, rootDir: deps.rootDir, platformConfigPath: PLATFORM_CONFIG_PATH },
  );

  saveHistory({ rows: toHistoryRows(currentRows), capturedAt: now.toISOString() }, deps.historyPath);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
