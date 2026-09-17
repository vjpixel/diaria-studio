#!/usr/bin/env node
/**
 * scripts/ads-test-watch.ts (#5845)
 *
 * Task diária `Diaria-Ads-Test-Watch` — cobra sozinha os marcos do ciclo de
 * vida do teste de 3 canais pagos (#5524) que hoje dependem só da memória
 * do editor. Lógica pura em `scripts/lib/ads-test-watch.ts`
 * (`planAdsTestWatchActions` + os builders de e-mail) — este arquivo é só
 * I/O: ler `run-state.json`/`clicks-2608.csv`, enviar e-mail, invocar
 * `build-origem-map.ts` + `cac-report.ts` (SEMPRE nessa ordem, imediatamente
 * um após o outro — §7.2), comentar em #5838.
 *
 * **Lê relatório de gasto das APIs pagas (Google/Meta/Microsoft Ads) —
 * NUNCA escreve nelas (#8240 item 3).** Até o #8240 este script só lia
 * `clicks-2608.csv` (reconciliado manualmente, §8.3), invisível pro gasto
 * pós-retomada enquanto ninguém digita a linha do dia. Ler relatório de
 * gasto não gera custo — mesmo caminho REST fail-soft de
 * `scripts/lib/ads-campaign-economics-fetch.ts` (usado pela tela `/ads`,
 * #7536) — e complementa o CSV, nunca o substitui: sem NENHUMA linha ainda
 * no CSV pra um braço, a fonte automática não tem baseline pra
 * complementar (`resolveArmSpend`, `scripts/lib/ads-test-watch.ts`).
 * Credencial ausente/erro de rede é fail-soft (o braço cai pro CSV com
 * rótulo `fonte manual, até DD/MM`), nunca aborta a task inteira.
 *
 * Uso:
 *   npx tsx scripts/ads-test-watch.ts               # avalia + age
 *   npx tsx scripts/ads-test-watch.ts --dry-run      # avalia + imprime, não envia e-mail nem grava estado
 *   npx tsx scripts/ads-test-watch.ts --to email@x   # override do destinatário
 *
 * Guard: se o junction `data/` (OneDrive) não estiver montado, aborta
 * graciosamente (exit 0, log informativo) — mesmo padrão de
 * `scripts/lib/exec-mode.ts` — em vez de tentar ler paths que não existem
 * numa sessão cloud/clone fresco.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, getStringArg, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage, type GmailSendResult } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
import { addDays } from "./lib/ads-test-schedule.ts";
import { assertValidRunState, type AdsTestRunState } from "./lib/ads-test-run-state.ts";
import { isSubscribersSnapshotUsable } from "./lib/beehiiv-backup-snapshots.ts";
import { spawnGhSync, type GhSpawnResult } from "./lib/shared/gh-run.ts";
import { main as buildOrigemMapMain } from "./build-origem-map.ts";
import { main as cacReportMain } from "./cac-report.ts";
import { reportId } from "./studio-ui/studio-reports.ts";
import {
  planAdsTestWatchActions,
  emptyAdsTestWatchState,
  markReligarBrevoTriggered,
  markApuracaoCompleted,
  parseClicksCsv,
  findMissingClicksBracosForDate,
  evaluateSpendOverageDeathCondition,
  evaluateSpendWarning,
  projectBudgetCrossing,
  resolveArmSpend,
  buildSpendWatchDigestSection,
  buildMissingD0OverdueEmail,
  buildMissingClicksCoverageEmail,
  buildDeathConditionEmail,
  buildReligarBrevoDueEmail,
  buildApuracaoSnapshotUnusableEmail,
  buildApuracaoSuccessEmail,
  DEFAULT_PLANNED_DAILY_BUDGET_BRL,
  DEFAULT_NOMINAL_ARM_BUDGET_BRL,
  type AdsTestWatchState,
  type ClicksCsvRow,
} from "./lib/ads-test-watch.ts";
import { normalizePauseIntervals, dailyBudgetForDate, type AdsTestRunStateWithPause } from "./lib/ads-test-pause-window.ts";
import { fetchCampaignEconomicsSources } from "./lib/ads-campaign-economics-fetch.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AQUISICAO_DIR = resolve(ROOT, "data/aquisicao");
export const DEFAULT_RUN_STATE_PATH = resolve(AQUISICAO_DIR, "teste-2608/run-state.json");
export const DEFAULT_WATCH_STATE_PATH = resolve(AQUISICAO_DIR, "teste-2608/watch-state.json");
export const DEFAULT_CLICKS_CSV_PATH = resolve(AQUISICAO_DIR, "clicks-2608.csv");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[ads-test-watch]";

/** Data planejada de acendimento, sem `run-state.json` ainda — recomendação
 *  registrada em `data/aquisicao/campanhas-260816/00-PROTOCOLO.md`
 *  ("Data recomendada para o D0: 26/08/2026", revisto 21/08). Documento vive
 *  fora do git (`data/`), então este valor pode divergir se a decisão mudar
 *  sem o código acompanhar — por isso é sempre overridável via
 *  `--planned-d0`, e deixa de importar assim que `run-state.json` existir
 *  (o pré-registro real substitui a recomendação em prosa). */
export const DEFAULT_PLANNED_D0 = "2026-08-26";

/** Issue que rastreia o religamento de `Diaria-Brevo-Diaria-Evaluate`
 *  (#5838) — comentar nela em vez de reimplementar o mecanismo. */
export const RELIGAR_BREVO_ISSUE_NUMBER = 5838;

export interface AdsTestWatchDeps {
  runStatePath: string;
  watchStatePath: string;
  clicksCsvPath: string;
  backupRoot: string;
  plannedD0: string | null;
  plannedDailyBudgetBRL: number;
  now: () => Date;
  sendEmail: (to: string, subject: string, body: string) => Promise<GmailSendResult>;
  /** Roda `build-origem-map.ts` (sempre ANTES de `runCacReport`, #7.2) —
   *  retorna `ok:false` se o script sinalizar falha via `process.exitCode`. */
  runBuildOrigemMap: () => boolean;
  /** Roda `cac-report.ts --snapshot {date}` — mesma convenção de retorno. */
  runCacReport: (snapshotDate: string) => boolean;
  isSnapshotUsable: (root: string, date: string) => { usable: boolean; reason: string | null };
  commentOnReligarBrevoIssue: (body: string) => GhSpawnResult;
  /** Injetável só pra teste (evita depender do junction `data/` real do
   *  worktree que roda a suíte) — em produção sempre `detectExecMode`. */
  execMode: () => "local" | "cloud";
  /** #8240 item 3 — busca o gasto diário AO VIVO dos 3 canais pra
   *  complementar `clicks-2608.csv` nos dias depois da última linha
   *  reconciliada. `braco -> Map<data YYYY-MM-DD, gastoBrl do dia>`.
   *  Fail-soft por natureza (nunca lança) — credencial ausente/erro de
   *  rede em QUALQUER fonte não impede as demais nem aborta a task;
   *  `resolveArmSpend` (`scripts/lib/ads-test-watch.ts`) trata a ausência
   *  de dado pra um braço como fallback pro CSV, rotulado. */
  fetchAutoSpend: () => Promise<Map<string, Map<string, number>>>;
}

function realBuildOrigemMap(): boolean {
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  buildOrigemMapMain([]);
  const failed = process.exitCode !== undefined && process.exitCode !== 0;
  process.exitCode = priorExitCode;
  return !failed;
}

function realCacReport(snapshotDate: string): boolean {
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  cacReportMain(["--snapshot", snapshotDate]);
  const failed = process.exitCode !== undefined && process.exitCode !== 0;
  process.exitCode = priorExitCode;
  return !failed;
}

/**
 * Implementação real de `fetchAutoSpend` — `fetchCampaignEconomicsSources`
 * já é fail-soft POR FONTE (uma credencial ausente vira `{error}` daquela
 * fonte só); aqui só reagrupamos `ChannelDailyMetric[]` (1 linha por
 * canal+dia) em `braco -> Map<data, gastoBrl>`, e envolvemos a chamada
 * inteira num try/catch extra — uma falha de rede não capturada por
 * `fetchCampaignEconomicsSources` (ex: `fetch` global ausente/polyfill
 * quebrado) não pode derrubar `Diaria-Ads-Test-Watch`, que tem outras 4
 * checagens a fazer no mesmo dia.
 */
async function realFetchAutoSpend(): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  try {
    const kitResult = resolveKitConfig();
    const result = await fetchCampaignEconomicsSources(fetch as typeof fetch, kitResult.ok ? kitResult.config : null, {
      lookbackDays: 30,
    });
    for (const m of result.metrics) {
      if (!out.has(m.canal)) out.set(m.canal, new Map());
      out.get(m.canal)!.set(m.date, m.gastoBrl);
    }
    const errs = Object.entries(result.sources)
      .filter(([, s]) => s.error)
      .map(([k, s]) => `${k}: ${s.error}`);
    if (errs.length > 0) console.warn(`${LOG_PREFIX} fonte automática de gasto com falha parcial — ${errs.join(" | ")}`);
  } catch (e) {
    console.warn(`${LOG_PREFIX} fonte automática de gasto indisponível (${e instanceof Error ? e.message : e}) — braços caem pro CSV manual.`);
  }
  return out;
}

function defaultDeps(argv: string[]): AdsTestWatchDeps {
  return {
    runStatePath: getArg(argv, "run-state-path") || DEFAULT_RUN_STATE_PATH,
    watchStatePath: getArg(argv, "watch-state-path") || DEFAULT_WATCH_STATE_PATH,
    clicksCsvPath: getArg(argv, "clicks-csv-path") || DEFAULT_CLICKS_CSV_PATH,
    backupRoot: getArg(argv, "backup-root") || DEFAULT_BACKUP_ROOT,
    plannedD0: getStringArg(argv, "planned-d0") ?? DEFAULT_PLANNED_D0,
    // getIntArg (não Number(getArg(...) || default)) — distingue flag AUSENTE
    // (undefined -> default) de flag PRESENTE mas vazia/inválida (lança, em
    // vez de colapsar em 0/NaN silencioso; ver docstring de getArg em
    // scripts/lib/cli-args.ts, guard #4573).
    plannedDailyBudgetBRL: getIntArg(argv, "planned-daily-budget", { min: 1 }) ?? DEFAULT_PLANNED_DAILY_BUDGET_BRL,
    now: () => new Date(),
    sendEmail: sendGmailMessage,
    runBuildOrigemMap: realBuildOrigemMap,
    runCacReport: realCacReport,
    isSnapshotUsable: (root, date) => isSubscribersSnapshotUsable(root, date),
    commentOnReligarBrevoIssue: (body) =>
      spawnGhSync(["issue", "comment", String(RELIGAR_BREVO_ISSUE_NUMBER), "--body", body], ROOT),
    execMode: () => detectExecMode({ projectRoot: ROOT }),
    fetchAutoSpend: realFetchAutoSpend,
  };
}

function loadRunState(path: string): AdsTestRunState | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assertValidRunState(raw);
  return raw;
}

function loadWatchState(path: string): AdsTestWatchState {
  if (!existsSync(path)) return emptyAdsTestWatchState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AdsTestWatchState>;
    return {
      religarBrevoTriggeredAt: typeof raw.religarBrevoTriggeredAt === "string" ? raw.religarBrevoTriggeredAt : null,
      apuracaoCompletedAt: typeof raw.apuracaoCompletedAt === "string" ? raw.apuracaoCompletedAt : null,
      apuracaoReportPath: typeof raw.apuracaoReportPath === "string" ? raw.apuracaoReportPath : null,
    };
  } catch {
    return emptyAdsTestWatchState();
  }
}

function saveWatchState(state: AdsTestWatchState, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

export async function main(argv: string[] = process.argv.slice(2), depsOverride: Partial<AdsTestWatchDeps> = {}): Promise<void> {
  loadProjectEnv(ROOT);

  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const deps: AdsTestWatchDeps = { ...defaultDeps(argv), ...depsOverride };

  if (deps.execMode() === "cloud") {
    console.log(`${LOG_PREFIX} data/ ausente (modo cloud) — abortando graciosamente, nada a fazer.`);
    return;
  }

  let runState: AdsTestRunState | null;
  try {
    runState = loadRunState(deps.runStatePath);
  } catch (e) {
    console.error(`${LOG_PREFIX} run-state.json corrompido/ilegível: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let watchState = loadWatchState(deps.watchStatePath);
  const now = deps.now();
  const nowDateStr = now.toISOString().slice(0, 10);

  const plan = planAdsTestWatchActions(nowDateStr, runState, deps.plannedD0, watchState);
  console.log(
    `${LOG_PREFIX} ${nowDateStr} runState=${runState ? runState.d0 : "ausente"} plan=${JSON.stringify(plan)}`,
  );

  const emails: Array<{ subject: string; body: string }> = [];
  let nextWatchState = watchState;

  if (plan.alarmMissingD0Overdue && deps.plannedD0) {
    emails.push(buildMissingD0OverdueEmail(deps.plannedD0, nowDateStr));
  }

  if ((plan.checkClicksCoverage || plan.checkDeathConditions) && runState) {
    const csvContent = existsSync(deps.clicksCsvPath) ? readFileSync(deps.clicksCsvPath, "utf8") : "";
    if (!csvContent.trim()) {
      if (plan.checkClicksCoverage) {
        emails.push(buildMissingClicksCoverageEmail(runState.bracos, addDays(nowDateStr, -1)));
      }
    } else {
      try {
        const { rows, errors } = parseClicksCsv(csvContent);
        for (const err of errors) console.error(`${LOG_PREFIX} clicks-2608.csv linha ${err.line}: ${err.reason}`);

        if (plan.checkClicksCoverage) {
          const yesterday = addDays(nowDateStr, -1);
          const missing = findMissingClicksBracosForDate(rows, runState.bracos, yesterday);
          if (missing.length > 0) emails.push(buildMissingClicksCoverageEmail(missing, yesterday));
        }
        if (plan.checkDeathConditions) {
          const runStateExt = runState as unknown as AdsTestRunStateWithPause;
          const pauseIntervals = normalizePauseIntervals(runStateExt.revisao?.pausa);
          const budgetScheduleByBraco = runStateExt.orcamento_diario_brl ?? {};

          // #8240 item 3 — complementa o CSV com a fonte automática ANTES de
          // avaliar morte/aviso/projeção: os 3 avaliadores operam sobre
          // `rows`, então basta injetar 1 linha "resolvida" por braço (data +
          // acumulado mais recente conhecidos, CSV+automática combinados) —
          // ela vira automaticamente a linha mais recente pros 3 (datas
          // maiores vencem no `reduce` de cada avaliador).
          const autoSpendByCanal = await deps.fetchAutoSpend();
          const resolvedRows: ClicksCsvRow[] = [];
          for (const braco of runState.bracos) {
            const resolved = resolveArmSpend(braco, rows, nowDateStr, autoSpendByCanal.get(braco) ?? null);
            if (resolved.label) console.log(`${LOG_PREFIX} ${braco}: ${resolved.label}`);
            resolvedRows.push({ canal: braco, data_apuracao: resolved.lastKnownDate, gasto_acumulado: resolved.gastoAcumulado });
          }
          const evalRows = [...rows, ...resolvedRows];

          const findings = evaluateSpendOverageDeathCondition(
            evalRows,
            runState.bracos,
            runState.d0,
            nowDateStr,
            deps.plannedDailyBudgetBRL,
            { pauseIntervals, budgetScheduleByBraco },
          );
          if (findings.length > 0) emails.push(buildDeathConditionEmail(findings));

          // Aviso + projeção (#8240 item 4) — NUNCA e-mail próprio, só
          // console/`--dry-run` aqui; `ads-daily-digest.ts` é quem os
          // consome como seção do e-mail diário que já sai todo dia.
          const warnings = evaluateSpendWarning(evalRows, runState.bracos, runState.d0, nowDateStr, deps.plannedDailyBudgetBRL, {
            pauseIntervals,
            budgetScheduleByBraco,
          });
          const projections = runState.bracos
            .map((braco) => {
              const ritmoFallback = dailyBudgetForDate(nowDateStr, budgetScheduleByBraco[braco], deps.plannedDailyBudgetBRL);
              return projectBudgetCrossing(evalRows, braco, nowDateStr, runState!.fim_janela, DEFAULT_NOMINAL_ARM_BUDGET_BRL, ritmoFallback);
            })
            .filter((p): p is NonNullable<typeof p> => p !== null);
          for (const line of buildSpendWatchDigestSection(warnings, projections)) console.log(`${LOG_PREFIX} ${line}`);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} falha ao ler/parsear clicks-2608.csv: ${(e as Error).message}`);
      }
    }
  }

  if (plan.triggerReligarBrevo && runState) {
    const { subject, body } = buildReligarBrevoDueEmail(runState.religar_brevo);
    if (!isDryRun) {
      const result = deps.commentOnReligarBrevoIssue(
        `A task \`Diaria-Ads-Test-Watch\` confirma: D+21 (${runState.religar_brevo}) chegou — religar ` +
          `\`Diaria-Brevo-Diaria-Evaluate\` agora (reverter \`enabled: false\` em scripts/lib/scheduled-tasks.ts).`,
      );
      if (result.status !== 0) {
        console.error(`${LOG_PREFIX} falha ao comentar em #${RELIGAR_BREVO_ISSUE_NUMBER}: ${result.stderr}`);
      } else {
        console.log(`${LOG_PREFIX} comentário postado em #${RELIGAR_BREVO_ISSUE_NUMBER}.`);
        nextWatchState = markReligarBrevoTriggered(nextWatchState, now.toISOString());
      }
    }
    emails.push({ subject, body });
  }

  if (plan.runApuracao && runState) {
    const usability = deps.isSnapshotUsable(deps.backupRoot, runState.apuracao_snapshot);
    if (!usability.usable) {
      emails.push(buildApuracaoSnapshotUnusableEmail(runState.apuracao_snapshot, usability.reason ?? "motivo desconhecido"));
      console.error(`${LOG_PREFIX} apuração NÃO rodou — snapshot ${runState.apuracao_snapshot} inutilizável: ${usability.reason}`);
    } else if (!isDryRun) {
      // SEMPRE build-origem-map.ts imediatamente antes de cac-report.ts (§7.2) —
      // nunca separados, nunca fora de ordem.
      const origemOk = deps.runBuildOrigemMap();
      if (!origemOk) {
        console.error(`${LOG_PREFIX} build-origem-map.ts falhou — apuração abortada, cac-report.ts NÃO rodou.`);
      } else {
        const cacOk = deps.runCacReport(runState.apuracao_snapshot);
        if (!cacOk) {
          console.error(`${LOG_PREFIX} cac-report.ts falhou para snapshot ${runState.apuracao_snapshot}.`);
        } else {
          const reportPath = `data/aquisicao/cac-reports/${reportId("cac", runState.apuracao_snapshot)}.md`;
          const reportUrl = `/relatorios/${reportId("cac", runState.apuracao_snapshot)}`;
          nextWatchState = markApuracaoCompleted(nextWatchState, now.toISOString(), reportPath);
          emails.push(buildApuracaoSuccessEmail(runState.apuracao_snapshot, reportUrl));
          console.log(`${LOG_PREFIX} apuração congelada gerada: ${reportPath}`);
        }
      }
    }
  }

  if (emails.length === 0) {
    console.log(`${LOG_PREFIX} nada a alarmar/agir hoje.`);
    return;
  }

  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  for (const { subject, body } of emails) {
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
      continue;
    }
    await deps.sendEmail(to, subject, body);
    console.log(`${LOG_PREFIX} e-mail enviado pra ${to}: "${subject}"`);
  }

  if (!isDryRun && nextWatchState !== watchState) {
    saveWatchState(nextWatchState, deps.watchStatePath);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
