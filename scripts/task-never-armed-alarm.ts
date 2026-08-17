#!/usr/bin/env node
/**
 * scripts/task-never-armed-alarm.ts (#5607)
 *
 * Task periódica: cruza o registro declarativo (`scripts/lib/scheduled-tasks.ts
 * --json`) contra `systemctl --user list-timers --all` e alarma se qualquer
 * task deste repo estiver definida mas nunca armada — o caso que o sweep
 * genérico do #5563 (`systemd-failed-units-alarm.ts`, "disparou e falhou")
 * não cobre por desenho ("nunca disparou" não deixa rastro em `--state=failed`).
 * Também alarma (mais fraco) o inverso: timer `diaria-*` armado sem task
 * correspondente no registro.
 *
 * Lógica pura em `scripts/lib/task-never-armed-alarm.ts` — este arquivo é
 * só I/O: `systemctl --user list-timers --all` (SÓ LEITURA — ver guard
 * abaixo), envio de e-mail, dedup/criação de issue via `scripts/lib/alarm-issues.ts`.
 *
 * **GUARD (invariável):** este script NUNCA chama `systemctl` com
 * `enable`/`disable`/`start`/`stop`/`restart` — só `list-timers` (leitura).
 * Armar/desarmar é ação manual do editor.
 *
 * **Guard de máquina sem systemd `--user`** (sessão cloud, clone fresco, ou
 * qualquer máquina sem `systemctl`): a chamada falha com ENOENT — tratado
 * como "nada detectável nesta máquina", nunca como alarme (fail-soft
 * honesto, mesmo padrão de `systemd-failed-units-alarm.ts`).
 *
 * Uso:
 *   npx tsx scripts/task-never-armed-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/task-never-armed-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/task-never-armed-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário pra
 * ENVIAR o alarme (mesmo requisito dos outros alarmes locais deste repo).
 *
 * Estado: `data/.task-never-armed-alarm-state.json` (dedup do e-mail) +
 * `data/.task-never-armed-alarm-issues.json` (tracking de issue por achado,
 * `alarm-issues.ts`).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { listScheduledTaskNames } from "./lib/scheduled-tasks.ts";
import {
  parseSystemctlListTimersOutput,
  evaluateTaskNeverArmed,
  shouldSendTaskNeverArmedAlarm,
  markTaskNeverArmedAlarmed,
  emptyTaskNeverArmedAlarmState,
  buildTaskNeverArmedAlarmEmail,
  isAlarmingVerdict,
  type TaskNeverArmedAlarmState,
  type TaskNeverArmedEvaluation,
} from "./lib/task-never-armed-alarm.ts";
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
const STATE_PATH = join(DATA_DIR, ".task-never-armed-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = join(DATA_DIR, ".task-never-armed-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[task-never-armed-alarm]";
/** Cadência recomendada: diária, mesmo espírito de
 * `Diaria-Edicao-Diaria-Staleness-Alarm` — este é um check de DRIFT lento
 * (registro vs. máquina só diverge quando alguém adiciona/remove task e
 * esquece de armar/desarmar), não um evento de alta frequência. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** `null` = não foi possível consultar (systemctl ausente/erro qualquer) —
 * caller trata como "nada detectável", nunca como alarme. */
export function readArmedTimerUnitBaseNames(execFn: typeof execFileSync = execFileSync): string[] | null {
  try {
    const out = execFn("systemctl", ["--user", "list-timers", "--all", "--plain", "--no-legend"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    return parseSystemctlListTimersOutput(String(out ?? ""));
  } catch (e: unknown) {
    const err = e as { status?: number | null; stdout?: string };
    // Mesmo padrão de systemd-failed-units-alarm.ts: uma lista vazia pode
    // sair com status != 0 em algumas versões do systemd, mas ainda escreve
    // o (não-)resultado em stdout. Só trata como "não foi possível
    // consultar" quando nem stdout veio.
    if (typeof err.stdout === "string") {
      return parseSystemctlListTimersOutput(err.stdout);
    }
    return null;
  }
}

export function toNeverArmedFinding(taskName: string): AlarmFinding {
  return {
    check: "task-never-armed",
    fingerprint: taskName,
    title: `[diar.ia.br] task nunca armada: ${taskName}`,
    body: [
      "Achado automático do alarme `Diaria-Task-Never-Armed-Alarm`",
      "(`scripts/task-never-armed-alarm.ts`, #5607).",
      "",
      `A task \`${taskName}\` está no registro declarativo (\`scripts/lib/scheduled-tasks.ts\`)`,
      "mas não tem timer systemd --user armado nesta máquina.",
      "",
      "Armar: rodar `scripts/setup-systemd-timers.ts` (ou o passo manual equivalente) e " +
        "confirmar com `systemctl --user list-timers`. Este alarme nunca arma sozinho.",
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

export function toOrphanTimerFinding(unitBaseName: string): AlarmFinding {
  return {
    check: "task-never-armed-orphan-timer",
    fingerprint: unitBaseName,
    title: `[diar.ia.br] timer órfão sem task no registro: ${unitBaseName}.timer`,
    body: [
      "Achado automático do alarme `Diaria-Task-Never-Armed-Alarm`",
      "(`scripts/task-never-armed-alarm.ts`, #5607).",
      "",
      `O timer \`${unitBaseName}.timer\` está armado nesta máquina mas não tem task`,
      "correspondente no registro declarativo (`scripts/lib/scheduled-tasks.ts`) —",
      "possível task renomeada ou removida sem desarmar o timer antigo.",
      "",
      `Investigar: \`systemctl --user status ${unitBaseName}.timer\`. Desarmar` +
        " (`systemctl --user disable --now`) é ação manual do editor.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["enhancement"],
    priority: "P3",
    family: "estado",
  };
}

function loadState(): TaskNeverArmedAlarmState {
  if (!existsSync(STATE_PATH)) return emptyTaskNeverArmedAlarmState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<TaskNeverArmedAlarmState>;
    if (
      raw.lastAlarmed &&
      Array.isArray(raw.lastAlarmed.neverArmed) &&
      Array.isArray(raw.lastAlarmed.orphanTimers)
    ) {
      return {
        lastAlarmed: {
          neverArmed: raw.lastAlarmed.neverArmed.filter((s): s is string => typeof s === "string"),
          orphanTimers: raw.lastAlarmed.orphanTimers.filter((s): s is string => typeof s === "string"),
        },
      };
    }
    return emptyTaskNeverArmedAlarmState();
  } catch {
    return emptyTaskNeverArmedAlarmState();
  }
}

function saveState(state: TaskNeverArmedAlarmState): void {
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

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const armedUnitBaseNames = readArmedTimerUnitBaseNames();
  if (armedUnitBaseNames === null) {
    console.log(`${LOG_PREFIX} systemctl indisponível nesta máquina (sessão cloud/sem systemd --user) — nada a checar.`);
    return;
  }

  const registryTaskNames = listScheduledTaskNames();
  const evaluation: TaskNeverArmedEvaluation = evaluateTaskNeverArmed(registryTaskNames, armedUnitBaseNames);
  console.log(
    `${LOG_PREFIX} verdict=${evaluation.verdict} neverArmed=[${evaluation.neverArmed.join(", ")}] ` +
      `orphanTimers=[${evaluation.orphanTimers.join(", ")}]`,
  );

  const state = loadState();
  const alarmFindings: AlarmFinding[] = isAlarmingVerdict(evaluation.verdict)
    ? [...evaluation.neverArmed.map(toNeverArmedFinding), ...evaluation.orphanTimers.map(toOrphanTimerFinding)]
    : [];
  const alarmState = loadAlarmIssuesState();
  const issueRefs: AlarmIssueResult[] = [];

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
    for (const outcome of findingOutcomes) {
      const ref: AlarmIssueResult = {
        issueNumber: outcome.issueNumber,
        url: outcome.url,
        action: outcome.action,
        error: outcome.error,
      };
      issueRefs.push(ref);
      if (outcome.action === "failed") {
        console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
      } else {
        console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
      }
    }
  }

  if (!shouldSendTaskNeverArmedAlarm(evaluation, state)) {
    console.log(
      isAlarmingVerdict(evaluation.verdict)
        ? `${LOG_PREFIX} já alarmado pro mesmo conjunto nesta invocação anterior — não reenvia.`
        : `${LOG_PREFIX} nenhum drift registro↔systemd — nenhum alarme necessário.`,
    );
    return;
  }

  const issueLines = issueRefs.length
    ? "\n\nIssues:\n" +
      issueRefs
        .map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`))
        .join("\n")
    : "";
  const { subject, body } = buildTaskNeverArmedAlarmEmail(evaluation, issueLines);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markTaskNeverArmedAlarmed(evaluation));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
