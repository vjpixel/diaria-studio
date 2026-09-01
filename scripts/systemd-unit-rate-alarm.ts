#!/usr/bin/env node
/**
 * scripts/systemd-unit-rate-alarm.ts (#5765)
 *
 * Task periódica: varre TODAS as tasks de `scripts/lib/scheduled-tasks.ts`
 * (exceto as com `rateAlarmExempt: true`) e mede a TAXA de sucesso das
 * últimas N execuções de cada unit systemd `--user` correspondente, via
 * `journalctl --user -u <unit>` (SÓ LEITURA). Complementa
 * `scripts/systemd-failed-units-alarm.ts` (#5563), que só vê ESTADO
 * instantâneo — cego por construção pra uma oneshot que falha cronicamente
 * mas limpa o estado a cada execução nova (caso real: #5763).
 *
 * Lógica pura em `scripts/lib/systemd-unit-rate-alarm.ts` — ver docstring
 * de lá pro cálculo de taxa e o critério de fechamento (reusa
 * `alarm-issues.ts` sem lógica especial — a janela deslizante já implica
 * "recuperou ao longo de N execuções").
 *
 * **GUARD (invariável):** este script NUNCA chama `systemctl`/`journalctl`
 * com efeito de mutação — só leitura (`journalctl --user -u <unit>`,
 * `systemctl` nem é invocado aqui). Religar/investigar é ação manual do
 * editor.
 *
 * **Guard de máquina sem systemd `--user`/`journalctl`** (sessão cloud,
 * clone fresco): a chamada falha com ENOENT — tratado como "nenhuma taxa
 * detectável nesta máquina", nunca como alarme (mesmo padrão de
 * `systemd-failed-units-alarm.ts`/`studio-liveness-alarm.ts`).
 *
 * Uso:
 *   npx tsx scripts/systemd-unit-rate-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/systemd-unit-rate-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/systemd-unit-rate-alarm.ts --to email@x   # override do destinatário
 *
 * Estado: `data/.systemd-unit-rate-alarm-issues.json` (tracking de issue por
 * achado, `alarm-issues.ts`) + `data/.systemd-unit-rate-alarm-state.json`
 * (dedup do e-mail, mesmo padrão de `systemd-failed-units-alarm.ts`).
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
import { SCHEDULED_TASKS, type ScheduledTaskDefinition } from "./lib/scheduled-tasks.ts";
import { unitBaseName } from "./lib/systemd-units.ts";
import {
  parseJournalUnitOutcomes,
  evaluateUnitFailureRate,
  isAlarmingRateVerdict,
  detectPossibleParserDesync,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_FAILURE_THRESHOLD,
  type UnitFailureRateEvaluation,
} from "./lib/systemd-unit-rate-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  aggregateFindingsOnDebut,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmIssueResult,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const ALARM_ISSUES_STATE_PATH = join(DATA_DIR, ".systemd-unit-rate-alarm-issues.json");
const EMAIL_STATE_PATH = join(DATA_DIR, ".systemd-unit-rate-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[systemd-unit-rate-alarm]";
/** Mesma cadência do #5765: reconciliação por CONJUNTO de units alarmando
 * (não streak-per-unit de 1 e-mail por conta), fechada quando o conjunto
 * sai de `pending` por 2 execuções consecutivas DESTE script — ver
 * docstring de `scripts/lib/systemd-unit-rate-alarm.ts` pra por que essa
 * reconciliação padrão de `alarm-issues.ts` já implementa "taxa se
 * recuperou ao longo da janela" sem precisar de lógica extra. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** #6572 — grupo declarado em cada finding pra `aggregateFindingsOnDebut`
 * (`alarm-issues.ts`), generalização do cap de estreia do #6562/#6564
 * (antes exclusivo de `session-registry-safebackup`). Várias units
 * alarmando na MESMA 1ª execução deste alarme (state local ainda vazio)
 * costuma ser sintoma de UMA causa raiz compartilhada (ex: outage de rede,
 * `systemd --user` reiniciado, `data/` indisponível) — não N problemas
 * independentes; 4 issues P1 saindo de 2 problemas reais foi o caso
 * concreto citado no #6572. */
const UNIT_RATE_GROUP = "systemd-unit-rate";
/** Teto (exclusivo) — acima disto, na 1ª execução, agrega numa issue só em
 * vez de 1 por unit. */
export const SYSTEMD_UNIT_RATE_ESTREIA_AGGREGATE_THRESHOLD = 3;
const UNIT_RATE_ESTREIA_AGGREGATE_FINGERPRINT = "estreia-aggregate";

export interface UnitToCheck {
  taskName: string;
  unitName: string;
  successExitCodes: number[];
}

/** Pura — deriva a lista de units elegíveis (unit systemd + successExitCodes
 * da task) a partir do registro, pulando `rateAlarmExempt: true`. */
export function tasksToUnitsToCheck(tasks: readonly ScheduledTaskDefinition[]): UnitToCheck[] {
  return tasks
    .filter((t) => !t.rateAlarmExempt)
    .map((t) => ({
      taskName: t.name,
      unitName: `${unitBaseName(t.name)}.service`,
      successExitCodes: t.successExitCodes ?? [],
    }));
}

/** `null` = journalctl indisponível/erro que não devolveu stdout — caller
 * trata como "sem histórico detectável nesta máquina", nunca como alarme.
 * `-n 500` é generoso o bastante pra cobrir bem mais que
 * `DEFAULT_WINDOW_SIZE` execuções mesmo em task de cadência curta (2h),
 * sem custo relevante (leitura local do journal). */
export function readUnitJournalLines(unitName: string, execFn: typeof execFileSync = execFileSync): string[] | null {
  try {
    const out = execFn("journalctl", ["--user", "-u", unitName, "--no-pager", "-n", "500"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    return String(out ?? "").split("\n");
  } catch (e: unknown) {
    const err = e as { status?: number | null; stdout?: string };
    if (typeof err.stdout === "string") return err.stdout.split("\n");
    return null;
  }
}

export interface UnitRateFinding {
  unit: UnitToCheck;
  evaluation: UnitFailureRateEvaluation;
}

export function toAlarmFinding({ unit, evaluation }: UnitRateFinding): AlarmFinding {
  const window = evaluation.windowOutcomes
    .map((o) => (o.kind === "success" ? "OK" : `FAIL${o.exitCode !== null ? `(${o.exitCode})` : ""}`))
    .join(", ");
  return {
    check: "systemd-unit-rate",
    fingerprint: unit.unitName,
    title: `[diar.ia.br] taxa de falha alta: ${unit.unitName} (${evaluation.failuresInWindow}/${evaluation.windowSize})`,
    body: [
      "Achado automático do alarme `Diaria-Systemd-Unit-Rate-Alarm`",
      "(`scripts/systemd-unit-rate-alarm.ts`, #5765).",
      "",
      `A unit systemd --user \`${unit.unitName}\` (task \`${unit.taskName}\`) falhou ` +
        `${evaluation.failuresInWindow} de ${evaluation.windowSize} das execuções mais recentes registradas no journal ` +
        `(limiar de alarme: ${evaluation.failureThreshold}).`,
      "",
      `Janela considerada (mais antiga → mais recente): ${window}`,
      unit.successExitCodes.length > 0
        ? `Exit code(s) tratado(s) como sucesso pra esta task: ${unit.successExitCodes.join(", ")} ` +
          "(via `successExitCodes` do registro — já excluído do cálculo acima)."
        : "",
      "",
      `Investigar: \`journalctl --user -u ${unit.unitName} -n 50\` e ` + `\`systemctl --user status ${unit.unitName}\`. ` +
        "Consertar a task é ação manual do editor (este alarme nunca muta o serviço, nem religa/reinicia nada).",
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada",
      "sozinha quando a JANELA (não uma execução isolada) voltar a ter menos de",
      `${evaluation.failureThreshold} falha(s) por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas deste alarme ` +
        "(mesmo padrão de #5112 — ver docstring de `scripts/lib/systemd-unit-rate-alarm.ts` pro porquê disso já cobrir " +
        "recuperação sustentada, não 1 passe isolado).",
    ]
      .filter(Boolean)
      .join("\n"),
    labels: ["bug"],
    priority: "P1",
    family: "estado",
    group: UNIT_RATE_GROUP,
  };
}

/**
 * #6572 — achado agregado da estreia (`aggregateFindingsOnDebut`
 * `buildAggregate`, injetado). Mesmo formato de
 * `buildAggregatedSafeBackupFinding` (`scripts/lib/session-registry-safebackup-alarm.ts`,
 * #6562): lista cada finding individual (já convertido — reusa `title`, que
 * já carrega a taxa de falha formatada) em vez de reconstruir a partir do
 * `UnitRateFinding` original, que não chega até aqui.
 */
export function buildAggregatedUnitRateFinding(findings: readonly AlarmFinding[]): AlarmFinding {
  const sorted = [...findings].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return {
    check: "systemd-unit-rate",
    fingerprint: UNIT_RATE_ESTREIA_AGGREGATE_FINGERPRINT,
    title: `[diar.ia.br] taxa de falha alta em ${sorted.length} units systemd na estreia do alarme`,
    body: [
      "Achado automático do alarme `Diaria-Systemd-Unit-Rate-Alarm`",
      "(`scripts/systemd-unit-rate-alarm.ts`, #5765), agregado por ser a 1ª execução (modo de estreia, #6572).",
      "",
      `${sorted.length} units com taxa de falha acima do limiar encontradas na 1ª execução deste alarme nesta ` +
        `máquina/checkout — acima do teto de ${SYSTEMD_UNIT_RATE_ESTREIA_AGGREGATE_THRESHOLD}, agregadas nesta issue ` +
        "única em vez de 1 issue por unit (volume alto na estreia costuma ser sintoma de UMA causa raiz " +
        "compartilhada, não N problemas independentes):",
      "",
      ...sorted.map((f) => `- \`${f.fingerprint}\`: ${f.title}`),
      "",
      "Investigar cada unit com `journalctl --user -u <unit> -n 50` e `systemctl --user status <unit>`. Consertar " +
        "é ação manual do editor (este alarme nunca muta o serviço, nem religa/reinicia nada).",
      "",
      "Esta issue agregada é exclusiva da 1ª execução do alarme — a partir da execução seguinte o alarme volta ao " +
        "modo normal (1 issue por unit, ver #5765) e esta issue se fecha sozinha, independente de as units ainda " +
        "estarem acima do limiar ou não.",
    ].join("\n"),
    labels: ["bug"],
    priority: "P1",
    family: "estado",
  };
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

interface EmailAlarmState {
  /** Fingerprints (unit names) já alarmados no último e-mail enviado —
   * ordenado. `null` = nunca alarmado. Mesmo padrão de idempotência-por-
   * conjunto de `SystemdFailedUnitsAlarmState`. */
  lastAlarmedUnits: string[] | null;
}

function emptyEmailState(): EmailAlarmState {
  return { lastAlarmedUnits: null };
}

function loadEmailState(): EmailAlarmState {
  if (!existsSync(EMAIL_STATE_PATH)) return emptyEmailState();
  try {
    const raw = JSON.parse(readFileSync(EMAIL_STATE_PATH, "utf8")) as Partial<EmailAlarmState>;
    const lastAlarmedUnits = Array.isArray(raw.lastAlarmedUnits)
      ? raw.lastAlarmedUnits.filter((u): u is string => typeof u === "string")
      : null;
    return { lastAlarmedUnits };
  } catch {
    return emptyEmailState();
  }
}

function saveEmailState(state: EmailAlarmState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(EMAIL_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function sameUnitSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const unitsToCheck = tasksToUnitsToCheck(SCHEDULED_TASKS);
  const findings: UnitRateFinding[] = [];
  let anyJournalReadable = false;

  for (const unit of unitsToCheck) {
    const lines = readUnitJournalLines(unit.unitName);
    if (lines === null) continue; // journalctl indisponível pra esta unit/máquina
    anyJournalReadable = true;
    const outcomes = parseJournalUnitOutcomes(lines, unit.unitName);
    // #6905 — sinal antes de agir: journal com linhas, zero sucessos
    // reconhecidos, pelo menos 1 falha reconhecida. Não bloqueia o alarme
    // (a unit pode genuinamente só estar falhando), só avisa alto — é o
    // padrão exato que o bug do formato de sucesso produzia (as 2 linhas
    // de falha usam `: `, que nunca mudou; só o sucesso ficava invisível).
    if (detectPossibleParserDesync(outcomes, lines.length > 0)) {
      console.warn(
        `${LOG_PREFIX} ⚠️  ${unit.unitName}: journal tem linhas e o parser achou falha(s), mas ZERO sucesso reconhecido — ` +
          `possível dessincronia do parser com o formato do journal desta máquina (achado ao vivo #6905). ` +
          `Verificar manualmente antes de confiar na taxa: journalctl --user -u ${unit.unitName} -n 50`,
      );
    }
    const evaluation = evaluateUnitFailureRate(outcomes, {
      windowSize: DEFAULT_WINDOW_SIZE,
      failureThreshold: DEFAULT_FAILURE_THRESHOLD,
      successExitCodes: unit.successExitCodes,
    });
    if (isAlarmingRateVerdict(evaluation.verdict)) {
      findings.push({ unit, evaluation });
    }
  }

  if (!anyJournalReadable) {
    console.log(`${LOG_PREFIX} journalctl --user indisponível nesta máquina (sessão cloud/sem systemd --user) — nada a checar.`);
    return;
  }

  console.log(
    `${LOG_PREFIX} ${unitsToCheck.length} unit(s) elegível(is), ${findings.length} com taxa de falha acima do limiar: ` +
      `[${findings.map((f) => f.unit.unitName).join(", ")}]`,
  );

  const alarmState = loadAlarmIssuesState();
  const stateIsEmpty = Object.keys(alarmState).length === 0;
  // #6572 — modo de estreia: várias units alarmando na 1ª execução (state
  // vazio) agregam numa issue só acima do teto, mesmo mecanismo genérico
  // usado por `session-registry-safebackup-alarm.ts` (#6562/#6564).
  const alarmFindings: AlarmFinding[] = aggregateFindingsOnDebut(findings.map(toAlarmFinding), {
    threshold: SYSTEMD_UNIT_RATE_ESTREIA_AGGREGATE_THRESHOLD,
    stateIsEmpty,
    buildAggregate: (_group, groupFindings) => buildAggregatedUnitRateFinding(groupFindings),
  });
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

  const emailState = loadEmailState();
  const currentUnits = findings.map((f) => f.unit.unitName).sort();
  const shouldSendEmail =
    currentUnits.length > 0 && (emailState.lastAlarmedUnits === null || !sameUnitSet(emailState.lastAlarmedUnits, currentUnits));

  if (!shouldSendEmail) {
    console.log(
      findings.length > 0
        ? `${LOG_PREFIX} já alarmado pro mesmo conjunto de units nesta invocação anterior — não reenvia e-mail.`
        : `${LOG_PREFIX} nenhuma unit com taxa de falha acima do limiar — nenhum alarme necessário.`,
    );
    return;
  }

  const issueLines = issueRefs.length
    ? "\n\nIssues:\n" +
      issueRefs
        .map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`))
        .join("\n")
    : "";
  const list = findings.map((f) => `  - ${f.unit.unitName}: ${f.evaluation.failuresInWindow}/${f.evaluation.windowSize} falhas`).join("\n");
  const subject = `⚠️ ${findings.length} unit(s) systemd com taxa de falha alta: ${currentUnits.join(", ")}`;
  const body =
    `${findings.length} unit(s) systemd --user com prefixo diaria-*.service estão com taxa de falha acima do limiar ` +
    `nas execuções mais recentes:\n\n${list}\n\n` +
    `Investigar com \`journalctl --user -u <unit> -n 50\` e \`systemctl --user status <unit>\`. ` +
    `Consertar a task é ação manual do editor (este alarme nunca muta nada).\n\n` +
    `Achado automático de \`Diaria-Systemd-Unit-Rate-Alarm\` (\`scripts/systemd-unit-rate-alarm.ts\`, #5765).${issueLines}`;

  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveEmailState({ lastAlarmedUnits: currentUnits });
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
