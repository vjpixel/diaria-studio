#!/usr/bin/env node
/**
 * scripts/edicao-diaria-staleness-alarm.ts (#5563)
 *
 * Task diária (18:20 BRT — ver `scripts/lib/scheduled-tasks.ts`, ~2h20 após
 * o disparo das 16:00): checa se `diaria-edicao-diaria.timer` produziu
 * `data/editions/{YYMM}/{AAMMDD}/` pra edição de amanhã num dia domingo-quinta, e
 * distingue "nunca disparou" de "disparou e falhou" via
 * `data/overnight-schedule.log`. "Disparou e pulou por idempotência"
 * (edição já iniciada à mão pelo editor) é tratado como caso legítimo —
 * a edição existindo em disco já é suficiente pra não alarmar, independente
 * de como chegou lá. Desde o #6898 o alarme também consulta se a unit está
 * `disabled` (automação desligada de propósito → `timer-disabled`, não
 * alarma) e checa os DOIS layouts de `data/editions/` — os dois defeitos que
 * o faziam acusar edição preparada todo dia desde meados de agosto/2026.
 *
 * Lógica pura em `scripts/lib/edicao-diaria-staleness-alarm.ts` — este
 * arquivo é só I/O (leitura do log, `existsSync`, envio de e-mail,
 * dedup/criação de issue via `alarm-issues.ts`).
 *
 * Complementar ao sweep genérico `systemd-failed-units-alarm.ts` (mesmo
 * lote #5563) — ver docstring da lib pra divisão de responsabilidade.
 *
 * Uso:
 *   npx tsx scripts/edicao-diaria-staleness-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/edicao-diaria-staleness-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/edicao-diaria-staleness-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário pra
 * ENVIAR o alarme.
 *
 * Estado: `data/.edicao-diaria-staleness-alarm-state.json` (dedup do
 * e-mail, 1x por edição) + `data/.edicao-diaria-staleness-alarm-issues.json`
 * (tracking de issue por achado, `alarm-issues.ts`).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { nextEditionDate } from "./lib/next-edition-date.ts";
import { queryTaskArmed } from "./lib/scheduled-task-status.ts";
import {
  findLastEdicaoLogEntry,
  isEdicaoDiariaScheduledWeekday,
  evaluateEdicaoDiariaStaleness,
  shouldSendEdicaoDiariaStalenessAlarm,
  markEdicaoDiariaStalenessAlarmed,
  emptyEdicaoDiariaStalenessAlarmState,
  buildEdicaoDiariaStalenessAlarmEmail,
  isAlarmingVerdict,
  edicaoDirCandidates,
  TIMER_DISABLED_CROSS_MACHINE_CAVEAT,
  type EdicaoDiariaStalenessAlarmState,
  type EdicaoDiariaStalenessEvaluation,
  type EdicaoTimerState,
} from "./lib/edicao-diaria-staleness-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmIssueResult,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const SCHEDULE_LOG_PATH = join(DATA_DIR, "overnight-schedule.log");
const STATE_PATH = join(DATA_DIR, ".edicao-diaria-staleness-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = join(DATA_DIR, ".edicao-diaria-staleness-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[edicao-diaria-staleness-alarm]";
/** Task do registro que ARMA a edição diária — não confundir com
 * `Diaria-Edicao-Diaria-Staleness-Alarm`, que é esta task de alarme. */
const EDICAO_TASK_NAME = "Diaria-Edicao-Diaria";
/** Cadência diária — 2 execuções limpas consecutivas = 2 dias úteis sem o
 * achado antes de fechar a issue sozinha (mesmo valor usado por outros
 * alarmes diários do lote #5112, ex: `clarice-opens-catchup-alarm.ts`). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export function toAlarmFinding(evaluation: EdicaoDiariaStalenessEvaluation): AlarmFinding {
  return {
    check: "edicao-diaria-staleness",
    fingerprint: evaluation.aammdd,
    title: `[diar.ia.br] Edição diária ${evaluation.aammdd} não foi preparada (${evaluation.verdict})`,
    body: [
      "Achado automático do alarme `Diaria-Edicao-Diaria-Staleness-Alarm` (#5563).",
      "",
      `verdict=${evaluation.verdict} para edição ${evaluation.aammdd}.`,
      "",
      evaluation.verdict === "alarm-never-fired"
        ? "Nenhuma linha em data/overnight-schedule.log menciona esta edição e a unit NÃO está " +
          "`disabled` (se estivesse, o verdict seria timer-disabled e não haveria alarme, #6898) — " +
          "o timer diaria-edicao-diaria.timer não disparou hoje. " +
          "Verificar `systemctl --user list-timers diaria-edicao-diaria.timer` e " +
          "`systemctl --user status diaria-edicao-diaria.service`."
        : evaluation.verdict === "alarm-failed"
          ? "O service disparou mas a última execução registrada terminou em FAIL (ou travou " +
            "além de 3h sem concluir), sem produzir data/editions/{AAMMDD}/. Ver " +
            "`journalctl --user -u diaria-edicao-diaria.service -n 50` pro erro."
          : "Estado incoerente entre overnight-schedule.log e data/editions/{AAMMDD}/ — checar manualmente.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P1",
    family: "estado",
  };
}

function readScheduleLogLines(): string[] {
  if (!existsSync(SCHEDULE_LOG_PATH)) return [];
  try {
    return readFileSync(SCHEDULE_LOG_PATH, "utf8").split("\n");
  } catch (e) {
    console.warn(`${LOG_PREFIX} falha ao ler ${SCHEDULE_LOG_PATH} — tratando como vazio: ${(e as Error).message}`);
    return [];
  }
}

function loadState(): EdicaoDiariaStalenessAlarmState {
  if (!existsSync(STATE_PATH)) return emptyEdicaoDiariaStalenessAlarmState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<EdicaoDiariaStalenessAlarmState>;
    const lastAlarmedEdition = typeof raw.lastAlarmedEdition === "string" ? raw.lastAlarmedEdition : null;
    return { lastAlarmedEdition };
  } catch {
    return emptyEdicaoDiariaStalenessAlarmState();
  }
}

function saveState(state: EdicaoDiariaStalenessAlarmState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function loadAlarmIssuesState(): AlarmIssuesState {
  if (!existsSync(ALARM_ISSUES_STATE_PATH)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(ALARM_ISSUES_STATE_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(
      `${LOG_PREFIX} estado de alarm-issues corrompido/ilegível em ${ALARM_ISSUES_STATE_PATH} — resetando pra vazio: ${(e as Error).message}`,
    );
    return emptyAlarmIssuesState();
  }
}

function saveAlarmIssuesState(state: AlarmIssuesState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(ALARM_ISSUES_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

/**
 * #6898 defeito 1 — a edição existe? O layout canônico é
 * `data/editions/{YYMM}/{AAMMDD}/` (`editionDir`, #2463); o alarme checava
 * `data/editions/{AAMMDD}/` (flat) e por isso afirmava "não foi preparada"
 * sobre edições completas em disco. O flat continua sendo consultado como
 * FALLBACK porque `data/editions/` ainda tem resquícios não migrados
 * (`260708` etc., a migração do #2463 é gated) — checar os dois é o que
 * mantém o alarme correto durante e depois da migração.
 */
function edicaoExists(aammdd: string): boolean {
  return edicaoDirCandidates(aammdd).some((rel) => existsSync(resolve(ROOT, rel)));
}

/**
 * #6898 defeito 2 — o timer está armado? Sem isso, "desligado de propósito"
 * e "quebrado em silêncio" são o MESMO estado observável pro alarme, e ele
 * acusa o editor todo dia por uma automação que o próprio editor desligou.
 * Traduz o resultado de `queryTaskArmed` (4 estados) pros 3 que a lógica
 * pura distingue — só `disabled` silencia, ver `EdicaoTimerState`.
 */
function queryTimerState(): EdicaoTimerState {
  try {
    const armed = queryTaskArmed(EDICAO_TASK_NAME);
    if (armed.state === "disabled") return "disabled";
    if (armed.state === "armed") return "armed";
    return "unknown";
  } catch (e) {
    console.warn(`${LOG_PREFIX} falha ao consultar armamento do timer — tratando como unknown: ${(e as Error).message}`);
    return "unknown";
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const now = new Date();
  const aammdd = nextEditionDate(now);
  const isScheduledDay = isEdicaoDiariaScheduledWeekday(now);
  const editionExists = edicaoExists(aammdd);
  // `skipped` NÃO é um EdicaoTimerState — é só rótulo de log (#6898, finding
  // 3 do review): quando a edição existe, o evaluator nunca consulta
  // `timerState`, e imprimir `unknown` faria uma consulta NÃO FEITA parecer
  // uma consulta inconclusiva pra quem debugga pelo .alarm.log.
  const timerState: EdicaoTimerState = editionExists ? "unknown" : queryTimerState();
  const timerStateLabel = editionExists ? "skipped" : timerState;
  if (timerState === "disabled") {
    console.warn(`${LOG_PREFIX} ${TIMER_DISABLED_CROSS_MACHINE_CAVEAT}`);
  }
  const lastEntry = editionExists ? null : findLastEdicaoLogEntry(readScheduleLogLines(), aammdd);

  const evaluation = evaluateEdicaoDiariaStaleness(aammdd, isScheduledDay, editionExists, lastEntry, now, timerState);
  console.log(
    `${LOG_PREFIX} aammdd=${aammdd} scheduledDay=${isScheduledDay} editionExists=${editionExists} timerState=${timerStateLabel} verdict=${evaluation.verdict}`,
  );

  const state = loadState();
  const alarmFindings: AlarmFinding[] = isAlarmingVerdict(evaluation.verdict) ? [toAlarmFinding(evaluation)] : [];
  const alarmState = loadAlarmIssuesState();
  let issueRef: AlarmIssueResult | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, estado NÃO gravado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState);
    const outcome = findingOutcomes[0];
    if (outcome) {
      issueRef = { issueNumber: outcome.issueNumber, url: outcome.url, action: outcome.action, error: outcome.error };
      if (outcome.action === "failed") {
        console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
      } else {
        console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
      }
    }
  }

  if (!shouldSendEdicaoDiariaStalenessAlarm(evaluation, state)) {
    console.log(
      isAlarmingVerdict(evaluation.verdict)
        ? `${LOG_PREFIX} já alarmado pra edição ${evaluation.aammdd} nesta invocação anterior — não reenvia.`
        : `${LOG_PREFIX} nenhum achado (verdict=${evaluation.verdict}) — nenhum alarme necessário.`,
    );
    return;
  }

  const { subject, body } = buildEdicaoDiariaStalenessAlarmEmail(evaluation, issueRef);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markEdicaoDiariaStalenessAlarmed(evaluation.aammdd));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (edição ${evaluation.aammdd}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
