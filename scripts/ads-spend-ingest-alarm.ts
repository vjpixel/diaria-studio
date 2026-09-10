#!/usr/bin/env node
/**
 * scripts/ads-spend-ingest-alarm.ts (#5597, reescrito no #7518)
 *
 * Alarme que interpreta o CONTEÚDO (não só o exit code) dos logs
 * acumulados de `scripts/google-ads-ingest-spend.ts` e
 * `scripts/microsoft-ads-ingest-spend.ts` — decisão deliberada do
 * #5237/#5502 mantém exit code 0 mesmo em `defect` (query malformada,
 * versão de API descontinuada), pra não calar a ingestão da plataforma
 * vizinha. Sem este alarme, nenhum mecanismo existente
 * (`Diaria-Systemd-Failed-Units-Alarm`, `--state=failed`) enxerga um
 * defeito real — a unit sempre reporta sucesso.
 *
 * Lógica pura em `scripts/lib/ads-spend-ingest-alarm.ts` — este arquivo é
 * só I/O: ler os DOIS logs em disco (um por plataforma), enviar e-mail,
 * dedup/criação de issue via `scripts/lib/alarm-issues.ts`.
 *
 * **Correção de causa raiz (#7518, 09/09/2026):** a versão original lia um
 * ÚNICO path (`data/aquisicao/.ads-spend-ingest.log`) que descrevia a
 * convenção de uma task unificada que nunca chegou a existir — as duas
 * tasks reais (`Diaria-Google-Ads-Spend-Ingest`,
 * `Diaria-Microsoft-Ads-Spend-Ingest`) sempre gravaram em logs SEPARADOS.
 * O alarme nunca leu run nenhum (o arquivo lido nunca existiu) e sempre
 * reportou `alarm-no-run` — pelo motivo ERRADO: "achei o arquivo mas não
 * tem run de hoje" nunca foi verdade, o arquivo nunca existiu. Ver a
 * docstring de `scripts/lib/ads-spend-ingest-alarm.ts` pro racional
 * completo (tri-state honesto por plataforma + composição do veredito
 * combinado).
 *
 * Uso:
 *   npx tsx scripts/ads-spend-ingest-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/ads-spend-ingest-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/ads-spend-ingest-alarm.ts --to email@x   # override do destinatário
 *   npx tsx scripts/ads-spend-ingest-alarm.ts --google-log-path X --microsoft-log-path Y  # override p/ teste manual
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
import { hasFlag, getArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
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
  type PlatformLogInput,
  platformLabel,
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
/** Paths REAIS — batem com `logPath` de `Diaria-Google-Ads-Spend-Ingest` e
 *  `Diaria-Microsoft-Ads-Spend-Ingest` em `scripts/lib/scheduled-tasks.ts`
 *  (relativo a `data/`, mesma convenção de `ScheduledTaskDef.logPath`).
 *  `test/ads-spend-ingest-alarm-log-path-guard.test.ts` trava que os dois
 *  batem — é o guard que impede esta issue de reproduzir com um path
 *  diferente no futuro. */
/** Exportados pra `test/ads-spend-ingest-alarm-log-path-guard.test.ts` —
 *  o guard estático que compara estes 2 paths contra o `logPath` real das
 *  2 tasks em `scripts/lib/scheduled-tasks.ts`, pra nunca mais deixar este
 *  alarme apontar pra um arquivo que nenhuma task grava (a causa raiz do
 *  #7518). */
export const DEFAULT_GOOGLE_LOG_PATH = join(AQUISICAO_DIR, ".google-ads-ingest.log");
export const DEFAULT_MICROSOFT_LOG_PATH = join(AQUISICAO_DIR, ".microsoft-ads-ingest.log");
const STATE_PATH = join(AQUISICAO_DIR, ".ads-spend-ingest-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = join(AQUISICAO_DIR, ".ads-spend-ingest-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[ads-spend-ingest-alarm]";
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

function readPlatformLog(logPath: string): PlatformLogInput {
  const exists = existsSync(logPath);
  if (!exists) return { logPath, exists: false, content: null };
  try {
    return { logPath, exists: true, content: readFileSync(logPath, "utf8") };
  } catch {
    // Existe mas não dá pra ler (permissão, etc.) — mesmo tratamento de
    // "cannot-verify" que arquivo ausente recebe do lado da lógica pura;
    // `exists: true` + `content: null` deixa `evaluateSinglePlatformLog`
    // reportar `cannotVerifyReason: "log_unparseable"` em vez de
    // `"log_missing"` (mais preciso pro operador que for investigar).
    return { logPath, exists: true, content: null };
  }
}

export function toAlarmFinding(evaluation: AdsSpendIngestAlarmEvaluation): AlarmFinding {
  const fingerprint = evaluation.verdict === "alarm-defect" ? "defect" : "no-run";
  const offendingPlatforms = evaluation.platforms.filter((p) =>
    evaluation.verdict === "alarm-defect" ? p.verdict === "defect" : p.verdict === "no-run",
  );
  const platformNames = offendingPlatforms.map((p) => platformLabel(p.platform)).join(", ");
  return {
    check: "ads-spend-ingest",
    fingerprint,
    title:
      evaluation.verdict === "alarm-defect"
        ? `[diar.ia.br] ads-spend-ingest: DEFEITO real detectado no log (${platformNames}) — exit code não avisa`
        : `[diar.ia.br] ads-spend-ingest: nenhuma execução encontrada hoje (${platformNames})`,
    body: [
      "Achado automático do alarme `Diaria-Ads-Spend-Ingest-Alarm`",
      "(`scripts/ads-spend-ingest-alarm.ts`, #5597/#7518).",
      "",
      evaluation.verdict === "alarm-defect"
        ? `O run de ${evaluation.latestRunAt} (${platformNames}) contém sinal de defeito/fallback — ver e-mail/log completo.`
        : `Log presente mas sem run de hoje em: ${platformNames}.`,
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
  // #7518 (2ª causa raiz, achada em produção depois do fix original mergear):
  // `getArg` (import acima) usa "" como sentinela pra flag AUSENTE —
  // documentado no próprio `cli-args.ts` — então `getArg(...) ?? default`
  // NUNCA cai no default (`??` só reage a null/undefined, "" não é
  // nullish). Achado ao vivo (#7518, rodada 260910): sem os 2 overrides
  // passados explicitamente (o caso normal, real, do systemd timer),
  // `googleLogPath`/`microsoftLogPath` colapsavam pra "" — `readPlatformLog("")`
  // reporta `exists: false` (`existsSync("")` é sempre false) e o
  // veredito combinado vira `cannot-verify` silencioso (fail-soft, sem
  // e-mail/issue) mesmo com os 2 logs reais presentes e saudáveis. O
  // alarme reescrito pelo próprio #7518 nunca disse `ok` em produção por
  // essa razão. `getStringArg` retorna `undefined` genuíno quando a flag
  // está ausente (ver docstring de `cli-args.ts`) — o `??` funciona.
  const googleLogPath = getStringArg(argv, "google-log-path", { example: DEFAULT_GOOGLE_LOG_PATH }) ?? DEFAULT_GOOGLE_LOG_PATH;
  const microsoftLogPath =
    getStringArg(argv, "microsoft-log-path", { example: DEFAULT_MICROSOFT_LOG_PATH }) ?? DEFAULT_MICROSOFT_LOG_PATH;

  const now = new Date();
  const google = readPlatformLog(googleLogPath);
  const microsoft = readPlatformLog(microsoftLogPath);
  const evaluation = evaluateAdsSpendIngestAlarm(google, microsoft, now);
  console.log(
    `${LOG_PREFIX} verdict=${evaluation.verdict} ` +
      evaluation.platforms.map((p) => `${p.platform}=${p.verdict}(${p.logPath})`).join(" "),
  );

  if (evaluation.verdict === "cannot-verify") {
    // Fail-soft do PRÓPRIO alarme (mesma disciplina de
    // `onboarding-continuity-alarm.ts`/`meta-capi-staleness.ts`, #7776):
    // nunca cria issue/envia e-mail a partir de uma leitura que não
    // aconteceu — mas o veredito acima já ficou honesto no console
    // (nunca "ok", nunca "alarm-no-run"). Retorna ANTES de ler qualquer
    // estado de dedup — nada precisa ser lido pra um caminho que não
    // grava/envia nada (achado do self-review da #7518).
    console.log(`${LOG_PREFIX} cannot-verify — pelo menos uma plataforma sem log legível; nenhum alarme disparado (fail-soft).`);
    return;
  }

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
  const { subject, body } = buildAdsSpendIngestAlarmEmail(evaluation, issueLines);
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
