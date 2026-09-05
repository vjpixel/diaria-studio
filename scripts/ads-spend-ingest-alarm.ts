#!/usr/bin/env node
/**
 * scripts/ads-spend-ingest-alarm.ts (#5597)
 *
 * Alarme que interpreta o CONTEÚDO (não só o exit code) do log acumulado de
 * `scripts/google-ads-ingest-spend.ts` (e, quando espelhado lá, do
 * Microsoft Ads) — decisão deliberada do #5237/#5502 mantém exit code 0
 * mesmo em `defect` (query malformada, versão de API descontinuada), pra
 * não calar o canal vizinho na task encadeada `google-ads-ingest-spend.ts
 * && microsoft-ads-ingest-spend.ts`. Sem este alarme, nenhum mecanismo
 * existente (`Diaria-Systemd-Failed-Units-Alarm`, `--state=failed`) enxerga
 * um defeito real — a unit sempre reporta sucesso.
 *
 * Lógica pura em `scripts/lib/ads-spend-ingest-alarm.ts` — este arquivo é
 * só I/O: ler o log em disco, enviar e-mail, dedup/criação de issue via
 * `scripts/lib/alarm-issues.ts`.
 *
 * **Correção de prosa vencida (#7137, 05/09/2026):** este parágrafo dizia
 * "a task `Diaria-Ads-Spend-Ingest` ainda NÃO existe no registro" — ficou
 * desatualizado quando o #5704 registrou `Diaria-Google-Ads-Spend-Ingest`
 * em `scripts/lib/scheduled-tasks.ts` (daily 09:50), o alvo que este alarme
 * lê. Este script agora está registrado como `Diaria-Ads-Spend-Ingest-Alarm`
 * (daily 10:05, logo depois) — exatamente o padrão de prosa-vencida que a
 * #7137 mediu (10 entradas "DECLARADA, NÃO ARMADA" no registro tipado
 * ficaram vencidas depois de armadas; aqui o vencimento era nesta
 * docstring, fora do registro).
 *
 * Uso:
 *   npx tsx scripts/ads-spend-ingest-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/ads-spend-ingest-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/ads-spend-ingest-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário pra
 * ENVIAR o alarme (mesmo requisito dos outros alarmes locais deste repo).
 *
 * Estado: `data/aquisicao/.ads-spend-ingest-alarm-state.json` (dedup do
 * e-mail, 1×/dia) + `data/aquisicao/.ads-spend-ingest-alarm-issues.json`
 * (tracking de issue por achado, `alarm-issues.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  evaluateAdsSpendIngestAlarm,
  shouldSendAdsSpendIngestAlarm,
  markAdsSpendIngestAlarmed,
  emptyAdsSpendIngestAlarmState,
  buildAdsSpendIngestAlarmEmail,
  isAlarmingVerdict,
  type AdsSpendIngestAlarmState,
  type AdsSpendIngestAlarmEvaluation,
} from "./lib/ads-spend-ingest-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmIssueResult,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const AQUISICAO_DIR = join(DATA_DIR, "aquisicao");
/** Convenção de logPath que a futura entrada `Diaria-Ads-Spend-Ingest` em
 *  `scheduled-tasks.ts` deveria usar (mesma subpasta que `spend.csv` já
 *  ocupa) — `data/aquisicao/.ads-spend-ingest.log`. Sobreponível via
 *  `--log-path` só pra teste manual/depuração local. */
const DEFAULT_LOG_PATH = join(AQUISICAO_DIR, ".ads-spend-ingest.log");
const STATE_PATH = join(AQUISICAO_DIR, ".ads-spend-ingest-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = join(AQUISICAO_DIR, ".ads-spend-ingest-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[ads-spend-ingest-alarm]";
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

function readLogContent(logPath: string): string | null {
  if (!existsSync(logPath)) return null;
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
}

export function toAlarmFinding(evaluation: AdsSpendIngestAlarmEvaluation): AlarmFinding {
  const fingerprint = evaluation.verdict === "alarm-defect" ? "defect" : "no-run";
  return {
    check: "ads-spend-ingest",
    fingerprint,
    title:
      evaluation.verdict === "alarm-defect"
        ? "[diar.ia.br] ads-spend-ingest: DEFEITO real detectado no log (exit code não avisa)"
        : "[diar.ia.br] ads-spend-ingest: nenhuma execução encontrada hoje",
    body: [
      "Achado automático do alarme `Diaria-Ads-Spend-Ingest-Alarm`",
      "(`scripts/ads-spend-ingest-alarm.ts`, #5597).",
      "",
      evaluation.verdict === "alarm-defect"
        ? `O run de ${evaluation.latestRunAt} contém o marcador "✖ DEFEITO" — ver e-mail/log completo.`
        : "Nenhum run de hoje foi encontrado no log da ingestão.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: evaluation.verdict === "alarm-defect" ? "P1" : "P2",
    family: "estado",
  };
}

function loadState(statePath: string): AdsSpendIngestAlarmState {
  if (!existsSync(statePath)) return emptyAdsSpendIngestAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<AdsSpendIngestAlarmState>;
    return { lastAlarmedDay: typeof raw.lastAlarmedDay === "string" ? raw.lastAlarmedDay : null };
  } catch {
    return emptyAdsSpendIngestAlarmState();
  }
}

// saveState/saveAlarmIssuesState: consolidados em scripts/lib/alarm-issues.ts
// (#7124) — importados acima.

// loadAlarmIssuesState continua LOCAL (#7124) — diverge do padrão comum ao
// logar o parse error via console.error, não só um catch silencioso; não
// forçado para o helper genérico pra não perder o diagnóstico.
function loadAlarmIssuesState(statePath: string): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(
      `${LOG_PREFIX} estado de alarm-issues corrompido/ilegível em ${statePath} — resetando pra vazio: ${(e as Error).message}`,
    );
    return emptyAlarmIssuesState();
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const logPath = getArg(argv, "log-path") ?? DEFAULT_LOG_PATH;

  const now = new Date();
  const logContent = readLogContent(logPath);
  const evaluation = evaluateAdsSpendIngestAlarm(logContent, now);
  console.log(`${LOG_PREFIX} verdict=${evaluation.verdict} latestRunAt=${evaluation.latestRunAt ?? "-"} logPath=${logPath}`);

  const state = loadState(STATE_PATH);
  const alarmFindings: AlarmFinding[] = isAlarmingVerdict(evaluation.verdict) ? [toAlarmFinding(evaluation)] : [];
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);
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
    saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
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

  if (!shouldSendAdsSpendIngestAlarm(evaluation, state, now)) {
    console.log(
      isAlarmingVerdict(evaluation.verdict)
        ? `${LOG_PREFIX} já alarmado hoje — não reenvia.`
        : `${LOG_PREFIX} run de hoje sem defeito — nenhum alarme necessário.`,
    );
    return;
  }

  const issueLines = issueRefs.length
    ? "\n\nIssues:\n" +
      issueRefs
        .map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`))
        .join("\n")
    : "";
  const { subject, body } = buildAdsSpendIngestAlarmEmail(evaluation, logPath, issueLines);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markAdsSpendIngestAlarmed(now), STATE_PATH);
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
