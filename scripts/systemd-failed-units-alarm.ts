#!/usr/bin/env node
/**
 * scripts/systemd-failed-units-alarm.ts (#5563 follow-up)
 *
 * Task periódica: varre `systemctl --user list-units 'diaria-*.service'
 * --state=failed` e alarma se qualquer unit deste repo estiver em estado
 * `failed`. Sweep GENÉRICO — cobre de graça as ~34 tasks do registro
 * (`scripts/lib/scheduled-tasks.ts`) em vez de um alarme artesanal por task.
 *
 * Lógica pura em `scripts/lib/systemd-failed-units-alarm.ts` — este arquivo
 * é só I/O: `systemctl --user list-units` + `systemctl --user show` por unit
 * falha (SÓ LEITURA — ver guard abaixo), envio de e-mail, dedup/criação de
 * issue via `scripts/lib/alarm-issues.ts`.
 *
 * **Campos diagnósticos no corpo da issue (#5963).** Pra cada unit falha,
 * `readUnitDiagnosticFields` roda `systemctl --user show <unit>
 * --property={allowlist fechada}` e captura só `Result`, `ExecMainStatus`,
 * `NRestarts`, `ActiveEnterTimestamp`, `InactiveEnterTimestamp`,
 * `InvocationID` — todos enum/inteiro/timestamp/UUID, nunca texto livre.
 * Este repo é PÚBLICO: colar `journalctl` bruto no corpo vazaria resposta
 * de API/e-mail de assinante/token. Validação de forma por propriedade
 * (`isValidUnitDiagnosticValue`) é a 2ª barreira — valor que não bate o
 * formato esperado é descartado, nunca repassado cego. Com `InvocationID`
 * disponível, a instrução de investigação vira
 * `journalctl --user _SYSTEMD_INVOCATION_ID=<id>` (journal da execução
 * específica, recuperável mesmo depois de outras rodadas).
 *
 * **GUARD (invariável):** este script NUNCA chama `systemctl` com
 * `start`/`stop`/`restart`/`enable`/`disable` — só `list-units`/`show`
 * (leitura). Religar um serviço falho é ação manual do editor.
 *
 * **Guard de máquina sem systemd `--user`** (sessão cloud, clone fresco, ou
 * qualquer máquina sem `systemctl`): a chamada falha com ENOENT — tratado
 * como "nenhuma unit falha detectável nesta máquina", nunca como alarme
 * (fail-soft honesto, mesmo padrão de `onedrive-sync-alarm.ts`).
 *
 * Uso:
 *   npx tsx scripts/systemd-failed-units-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/systemd-failed-units-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/systemd-failed-units-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário pra
 * ENVIAR o alarme (mesmo requisito dos outros alarmes locais deste repo).
 *
 * Estado: `data/.systemd-failed-units-alarm-state.json` (dedup do e-mail) +
 * `data/.systemd-failed-units-alarm-issues.json` (tracking de issue por
 * achado, `alarm-issues.ts`).
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
import {
  parseSystemctlListUnitsFailedOutput,
  evaluateSystemdFailedUnits,
  shouldSendSystemdFailedUnitsAlarm,
  markSystemdFailedUnitsAlarmed,
  emptySystemdFailedUnitsAlarmState,
  buildSystemdFailedUnitsAlarmEmail,
  isAlarmingVerdict,
  parseUnitDiagnosticShowOutput,
  formatUnitDiagnosticFieldsTable,
  buildUnitInvestigationCommand,
  buildSimultaneousFailuresNote,
  buildCorrelationComment,
  UNIT_DIAGNOSTIC_PROPERTIES,
  type SystemdFailedUnitsAlarmState,
  type SystemdFailedUnitsEvaluation,
  type UnitDiagnosticFields,
} from "./lib/systemd-failed-units-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  defaultAlarmGhRun,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmIssueResult,
  type AlarmFindingOutcome,
  type GhRunFn,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const STATE_PATH = join(DATA_DIR, ".systemd-failed-units-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = join(DATA_DIR, ".systemd-failed-units-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[systemd-failed-units-alarm]";
/** Cadência recomendada é a cada 2h (ver scripts/lib/scheduled-tasks.ts) —
 * 2 execuções limpas consecutivas = ~4h sem o achado, ordem de grandeza
 * consistente com os outros alarmes de cadência curta do repo
 * (`clarice-guardrail-alarm.ts`, `onedrive-sync-alarm.ts`, ambos 4h,
 * também usam 2). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** `null` = não foi possível consultar (systemctl ausente/erro qualquer) —
 * caller trata como "nenhuma unit falha detectável", nunca como alarme. */
export function readFailedUnitNames(execFn: typeof execFileSync = execFileSync): string[] | null {
  try {
    const out = execFn(
      "systemctl",
      ["--user", "list-units", "diaria-*.service", "--state=failed", "--plain", "--no-legend"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ) as unknown as string;
    return parseSystemctlListUnitsFailedOutput(String(out ?? ""));
  } catch (e: unknown) {
    const err = e as { status?: number | null; stdout?: string };
    // Lista vazia (nenhuma unit failed) faz `systemctl list-units` sair com
    // status != 0 em algumas versões, mas ainda escreve o (não-)resultado em
    // stdout — mesmo padrão de `onedrive-sync-alarm.ts` (is-active). Só
    // trata como "não foi possível consultar" quando nem stdout veio.
    if (typeof err.stdout === "string") {
      return parseSystemctlListUnitsFailedOutput(err.stdout);
    }
    return null;
  }
}

/** `null` = não foi possível consultar (systemctl ausente/erro qualquer) —
 * caller trata como "sem campos diagnósticos", nunca como alarme extra ou
 * falha do sweep (fail-soft honesto, mesmo padrão de `readFailedUnitNames`
 * acima). SÓ LEITURA — `systemctl show` nunca muta o serviço. */
export function readUnitDiagnosticFields(
  unitName: string,
  execFn: typeof execFileSync = execFileSync,
): UnitDiagnosticFields | null {
  try {
    const out = execFn(
      "systemctl",
      ["--user", "show", unitName, `--property=${UNIT_DIAGNOSTIC_PROPERTIES.join(",")}`],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ) as unknown as string;
    return parseUnitDiagnosticShowOutput(String(out ?? ""));
  } catch {
    return null;
  }
}

export function toAlarmFinding(
  unitName: string,
  diagnosticFields: UnitDiagnosticFields | null = null,
  allFailedUnits: readonly string[] = [],
): AlarmFinding {
  const fields = diagnosticFields ?? {};
  const table = formatUnitDiagnosticFieldsTable(fields);
  const investigationCmd = buildUnitInvestigationCommand(unitName, fields);
  // #6788 — lista as OUTRAS units failed na mesma execução (nomes; os
  // números das issues ainda não existem neste ponto — ver
  // `postCorrelationComments` abaixo, que cross-linka por NÚMERO depois que
  // todas as issues desta execução foram criadas/reusadas).
  const simultaneousNote = buildSimultaneousFailuresNote(unitName, allFailedUnits);
  return {
    check: "systemd-failed-units",
    fingerprint: unitName,
    title: `[diar.ia.br] systemd unit falhou: ${unitName}`,
    body: [
      "Achado automático do alarme `Diaria-Systemd-Failed-Units-Alarm`",
      "(`scripts/systemd-failed-units-alarm.ts`, #5563 follow-up, campos diagnósticos #5963, correlação #6788).",
      "",
      `A unit systemd --user \`${unitName}\` está em estado \`failed\`.`,
      ...(table
        ? [
            "",
            "Campos capturados no momento do achado" +
              " (`systemctl --user show`, allowlist fechada — nunca texto livre):",
            "",
            table,
          ]
        : []),
      ...(simultaneousNote ? ["", simultaneousNote] : []),
      "",
      `Investigar: \`${investigationCmd}\` e ` +
        `\`systemctl --user status ${unitName}\`. Religar/reiniciar é ação manual do editor ` +
        "(este alarme nunca muta o serviço).",
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

/**
 * #6788 — depois que TODAS as issues desta execução foram
 * criadas/reusadas (`findingOutcomes` já tem `issueNumber` resolvido pra
 * cada unit), cross-linka por NÚMERO cada issue com as demais units failed
 * na mesma execução: um comentário em cada issue listando `#NNNN
 * (unit-nome)` das outras. Só roda quando ≥2 units falharam nesta execução
 * (nada a correlacionar com 1 só) — I/O, não pura (por isso vive aqui, não
 * em `lib/systemd-failed-units-alarm.ts`, que só monta o TEXTO via
 * `buildCorrelationComment`).
 *
 * Best-effort/fail-soft: uma falha em `gh issue comment` pra uma issue não
 * impede a tentativa nas demais — cada uma é logada, nenhuma lança.
 */
export function postCorrelationComments(
  findingOutcomes: readonly AlarmFindingOutcome[],
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): void {
  const resolved = findingOutcomes.filter(
    (o): o is AlarmFindingOutcome & { issueNumber: number } =>
      typeof o.issueNumber === "number" && o.action !== "failed",
  );
  if (resolved.length < 2) return;

  for (const outcome of resolved) {
    const siblings = resolved
      .filter((o) => o.issueNumber !== outcome.issueNumber)
      .map((o) => ({ unit: o.fingerprint, issueNumber: o.issueNumber }));
    const comment = buildCorrelationComment(siblings);
    if (!comment) continue;
    const res = run(["issue", "comment", String(outcome.issueNumber), "--body", comment], cwd);
    if (res.status !== 0) {
      console.error(
        `${LOG_PREFIX} falha ao postar comentário de correlação (#6788) em #${outcome.issueNumber}: ${res.stderr.trim() || `status ${res.status}`}`,
      );
    }
  }
}

function loadState(): SystemdFailedUnitsAlarmState {
  if (!existsSync(STATE_PATH)) return emptySystemdFailedUnitsAlarmState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<SystemdFailedUnitsAlarmState>;
    const lastAlarmedUnits = Array.isArray(raw.lastAlarmedUnits)
      ? raw.lastAlarmedUnits.filter((u): u is string => typeof u === "string")
      : null;
    // #5978 — `lastAlarmedAt` ausente (state persistido antes desta unidade)
    // vira `null`; `shouldSendSystemdFailedUnitsAlarm` trata isso como
    // "dedup expirado" (reenvia), não como bloqueio silencioso.
    const lastAlarmedAt = typeof raw.lastAlarmedAt === "string" ? raw.lastAlarmedAt : null;
    return { lastAlarmedUnits, lastAlarmedAt };
  } catch {
    return emptySystemdFailedUnitsAlarmState();
  }
}

function saveState(state: SystemdFailedUnitsAlarmState): void {
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

  const failedUnits = readFailedUnitNames();
  if (failedUnits === null) {
    console.log(`${LOG_PREFIX} systemctl indisponível nesta máquina (sessão cloud/sem systemd --user) — nada a checar.`);
    return;
  }

  const evaluation: SystemdFailedUnitsEvaluation = evaluateSystemdFailedUnits(failedUnits);
  console.log(
    `${LOG_PREFIX} verdict=${evaluation.verdict} failedUnits=[${evaluation.failedUnits.join(", ")}]`,
  );

  const state = loadState();
  const alarmFindings: AlarmFinding[] = isAlarmingVerdict(evaluation.verdict)
    ? evaluation.failedUnits.map((unit) => toAlarmFinding(unit, readUnitDiagnosticFields(unit), evaluation.failedUnits))
    : [];
  const alarmState = loadAlarmIssuesState();
  const issueRefs: AlarmIssueResult[] = [];
  // #6788 — mesmo gate do e-mail (dedup por CONJUNTO + expiração #5978):
  // só cross-linka issues por comentário quando este É um alarme NOVO
  // (conjunto mudou ou dedup expirou) — nunca a cada execução enquanto o
  // mesmo conjunto de units segue failed, senão o comentário de correlação
  // reapareceria em loop a cada 2h sem nada de novo pra dizer.
  const shouldAlarmNow = shouldSendSystemdFailedUnitsAlarm(evaluation, state);

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

    if (shouldAlarmNow) {
      postCorrelationComments(findingOutcomes, ROOT);
    }
  }

  if (!shouldAlarmNow) {
    console.log(
      isAlarmingVerdict(evaluation.verdict)
        ? `${LOG_PREFIX} já alarmado pro mesmo conjunto de units nesta invocação anterior — não reenvia.`
        : `${LOG_PREFIX} nenhuma unit failed — nenhum alarme necessário.`,
    );
    return;
  }

  const issueLines = issueRefs.length
    ? "\n\nIssues:\n" +
      issueRefs
        .map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`))
        .join("\n")
    : "";
  const { subject, body } = buildSystemdFailedUnitsAlarmEmail(evaluation, issueLines);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markSystemdFailedUnitsAlarmed(evaluation.failedUnits));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
