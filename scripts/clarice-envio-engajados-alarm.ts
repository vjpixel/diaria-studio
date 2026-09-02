#!/usr/bin/env node
/**
 * scripts/clarice-envio-engajados-alarm.ts (#6945)
 *
 * Alarme de rodada falha da task `Diaria-Clarice-Envio-Engajados` — mesmo
 * padrão de `clarice-envio-alarm.ts` (o alarme do ramp-warm, #5058 item 2),
 * ver docstring de `scripts/lib/clarice-envio-engajados-alarm.ts` pro porquê
 * de ser um módulo dedicado em vez de generalizar o original.
 *
 * Lógica pura em `scripts/lib/clarice-envio-engajados-alarm.ts` — este
 * arquivo é só I/O (listar arquivos, ler mtimes, enviar e-mail, reconciliar
 * issue).
 *
 * Uso:
 *   npx tsx scripts/clarice-envio-engajados-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/clarice-envio-engajados-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/clarice-envio-engajados-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário
 * pra ENVIAR o alarme.
 *
 * Estado (idempotência): `data/clarice-subscribers/envio-engajados-alarm-state.json`.
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE } from "./lib/next-edition-date.ts";
import {
  evaluateEnvioEngajadosAlarm,
  shouldSendEnvioEngajadosAlarm,
  markEnvioEngajadosAlarmed,
  emptyEnvioEngajadosAlarmState,
  buildEnvioEngajadosAlarmEmail,
  type EnvioEngajadosAlarmEvaluation,
  type EnvioEngajadosAlarmReportFile,
  type EnvioEngajadosAlarmState,
} from "./lib/clarice-envio-engajados-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = resolve(ROOT, "data", "clarice-subscribers", "envio-reports");
const STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-engajados-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-engajados-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-envio-engajados-alarm]";
/** 2 execuções limpas consecutivas (2 dias, fingerprint inclui `aammdd`) fecham a issue automaticamente — mesmo valor do irmão ramp-warm. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export function loadState(statePath: string = STATE_PATH): EnvioEngajadosAlarmState {
  if (!existsSync(statePath)) return emptyEnvioEngajadosAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<EnvioEngajadosAlarmState>;
    const lastAlarmedAammdd = typeof raw.lastAlarmedAammdd === "string" || raw.lastAlarmedAammdd === null
      ? raw.lastAlarmedAammdd ?? null
      : null;
    return { lastAlarmedAammdd };
  } catch {
    return emptyEnvioEngajadosAlarmState();
  }
}

export function saveState(state: EnvioEngajadosAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

export function saveAlarmIssuesState(state: AlarmIssuesState, statePath: string = ALARM_ISSUES_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** `family: "evento"` (#5553) — falha de um `aammdd` específico é fato histórico, mesmo racional do irmão ramp-warm. */
export function toAlarmFinding(evaluation: EnvioEngajadosAlarmEvaluation, aammdd: string): AlarmFinding {
  return {
    check: "clarice-envio-engajados",
    fingerprint: `${aammdd}:${evaluation.verdict}:${evaluation.reportId ?? "no-report"}`,
    family: "evento",
    title:
      evaluation.verdict === "alarm-no-report"
        ? `[diar.ia.br] Diaria-Clarice-Envio-Engajados: nenhum relatório encontrado pra ${aammdd}`
        : `[diar.ia.br] Diaria-Clarice-Envio-Engajados falhou em ${aammdd} (${evaluation.reportId})`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Envio-Engajados-Alarm`",
      "(`scripts/clarice-envio-engajados-alarm.ts`, #6945).",
      "",
      `aammdd: ${aammdd}`,
      `verdict: ${evaluation.verdict}`,
      evaluation.reportId ? `reportId: ${evaluation.reportId}` : "Nenhum relatório encontrado — a rodada nem chegou a rodar.",
      "",
      "Diferente do ramp-warm, esta task NÃO retenta sozinha. Investigar:",
      "`journalctl --user -u diaria-clarice-envio-engajados.service -n 100`.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) — achado de EVENTO",
      "PASSADO (#5553): a falha é do dia acima, não se auto-fecha quando a checagem",
      "seguinte avaliar outro dia. Fica aberta até um humano investigar/fechar",
      "(rota Overnight na Triagem).",
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

/** Lista `envio-engajados-{aammdd}*.md` de HOJE. Mesma disciplina de `listTodayEnvioReports` (irmão ramp-warm). */
export function listTodayEnvioEngajadosReports(reportsDir: string, aammdd: string): EnvioEngajadosAlarmReportFile[] {
  if (!existsSync(reportsDir)) return [];
  const prefix = `envio-engajados-${aammdd}`;
  return readdirSync(reportsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => {
      const reportId = f.slice(0, -".md".length);
      const mtimeMs = statSync(resolve(reportsDir, f)).mtimeMs;
      return { reportId, mtimeMs };
    });
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const aammdd = toAammdd(datePartsInTz(new Date(), BRT_TIMEZONE));
  const candidates = listTodayEnvioEngajadosReports(REPORTS_DIR, aammdd);
  const evaluation = evaluateEnvioEngajadosAlarm(candidates, aammdd);
  console.log(
    `${LOG_PREFIX} aammdd=${aammdd} candidatos=${candidates.length} verdict=${evaluation.verdict}` +
      (evaluation.reportId ? ` reportId=${evaluation.reportId}` : ""),
  );

  const alarmFindings: AlarmFinding[] = evaluation.verdict !== "ok" ? [toAlarmFinding(evaluation, aammdd)] : [];
  const alarmState = loadAlarmIssuesState();
  let issueRef: { issueNumber: number | null; url: string | null; action: string; error?: string } | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
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

  const state = loadState();
  if (!shouldSendEnvioEngajadosAlarm(evaluation, state, aammdd)) {
    console.log(
      evaluation.verdict === "ok"
        ? `${LOG_PREFIX} rodada de ${aammdd} OK — nenhum alarme necessário.`
        : `${LOG_PREFIX} já alarmado pra ${aammdd} nesta invocação anterior — não reenvia.`,
    );
    return;
  }

  const { subject, body: emailBody } = buildEnvioEngajadosAlarmEmail(evaluation, aammdd);
  const issueLine = issueRef
    ? "\n\n" +
      (issueRef.action === "failed"
        ? `Issue: falha ao criar/reusar (${issueRef.error})`
        : `Issue: #${issueRef.issueNumber} (${issueRef.url})`)
    : "";
  const body = emailBody + issueLine;
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markEnvioEngajadosAlarmed(state, aammdd));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (aammdd=${aammdd}, verdict=${evaluation.verdict}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
