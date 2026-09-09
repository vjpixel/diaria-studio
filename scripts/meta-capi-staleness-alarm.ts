#!/usr/bin/env node
/**
 * scripts/meta-capi-staleness-alarm.ts (#7776, follow-up do #5504)
 *
 * Task diária (DECLARADA, NÃO ARMADA — ver `scripts/lib/scheduled-tasks.ts`,
 * `Diaria-Meta-Capi-Staleness-Alarm`): compara `server_last_fired_time` do
 * dataset (pixel) `1285191740325112` da Meta contra `now` e alarma quando
 * passar de `DEFAULT_CAPI_STALENESS_THRESHOLD_DAYS` dias sem disparar —
 * fecha o gap descrito na issue: a CAPI é fail-soft por design
 * (`scripts/lib/shared/meta-capi.ts`), então token ausente/inválido nunca
 * quebra um cadastro, mas também nunca deixou rastro nenhum até este
 * alarme existir.
 *
 * Lógica pura + leitura de rede injetável em `scripts/lib/meta-capi-staleness.ts`
 * — este arquivo é só I/O: ler env, chamar a Meta, enviar e-mail,
 * dedup/criação de issue via `scripts/lib/alarm-issues.ts` (mesmo padrão de
 * `scripts/ads-spend-ingest-alarm.ts`).
 *
 * ## Fail-soft do PRÓPRIO alarme
 *
 * Sem `META_CAPI_ACCESS_TOKEN` no `.env` local (situação ATUAL — o secret
 * nunca foi setado em nenhum worker, e a leitura via Graph API usa o mesmo
 * token localmente) ou com a Meta indisponível: sai limpo com aviso
 * honesto, NUNCA um alarme falso. `verdict === "cannot-verify"` é
 * distinto de `"stale"` de propósito — ver docstring do lib.
 *
 * Uso:
 *   npx tsx scripts/meta-capi-staleness-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/meta-capi-staleness-alarm.ts --dry-run      # avalia + imprime, NÃO envia/persiste
 *   npx tsx scripts/meta-capi-staleness-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `META_CAPI_ACCESS_TOKEN` (leitura do dataset) + `data/.credentials.json`
 * com o scope `gmail.send` (só necessário pra ENVIAR o alarme).
 *
 * Estado: `data/aquisicao/.meta-capi-staleness-alarm-state.json` (dedup do
 * e-mail, 1×/dia) + `data/aquisicao/.meta-capi-staleness-alarm-issues.json`
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
  evaluateMetaCapiStaleness,
  shouldSendMetaCapiStalenessAlarm,
  markMetaCapiStalenessAlarmed,
  emptyMetaCapiStalenessAlarmState,
  buildMetaCapiStalenessAlarmEmail,
  type MetaCapiStalenessAlarmState,
  type MetaCapiStalenessEvaluation,
} from "./lib/meta-capi-staleness.ts";
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
const AQUISICAO_DIR = join(ROOT, "data", "aquisicao");
const STATE_PATH = join(AQUISICAO_DIR, ".meta-capi-staleness-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = join(AQUISICAO_DIR, ".meta-capi-staleness-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[meta-capi-staleness-alarm]";
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

function loadState(statePath: string): MetaCapiStalenessAlarmState {
  if (!existsSync(statePath)) return emptyMetaCapiStalenessAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<MetaCapiStalenessAlarmState>;
    return { lastAlarmedDay: typeof raw.lastAlarmedDay === "string" ? raw.lastAlarmedDay : null };
  } catch {
    return emptyMetaCapiStalenessAlarmState();
  }
}

// loadAlarmIssuesState continua LOCAL (mesmo padrão de
// `ads-spend-ingest-alarm.ts`/`geo-citation-staleness-alarm.ts`) — diverge
// do padrão comum ao logar o parse error, não só um catch silencioso.
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

export function toAlarmFinding(evaluation: MetaCapiStalenessEvaluation): AlarmFinding {
  const fingerprint = evaluation.check?.neverFired ? "never-fired" : "stale";
  const detail = evaluation.check?.neverFired
    ? "o dataset nunca registrou um evento server-side (server_last_fired_time em epoch 0)"
    : `o último evento server-side foi há ${evaluation.check?.daysSinceLastFired} dia(s)`;
  return {
    check: "meta-capi-staleness",
    fingerprint,
    // #5553 — condição RE-CHECÁVEL (volta a firing assim que o secret for
    // setado e um cadastro real acontecer): resolve sozinha.
    family: "estado",
    title: "[diar.ia.br] Meta Conversions API parada — CompleteRegistration server-side não dispara",
    body: [
      "Achado automático do alarme `Diaria-Meta-Capi-Staleness-Alarm`",
      "(`scripts/meta-capi-staleness-alarm.ts`, follow-up do #5504, #7776).",
      "",
      `Sinal: ${detail}.`,
      "",
      "Causa mais provável (confirmada na origem, #7776): META_CAPI_ACCESS_TOKEN não está setado em um ou",
      "mais dos 3 workers (poll, cursos, reativar). Ação de credencial ao vivo do editor — ver corpo da #7776",
      "pro procedimento (`wrangler secret put META_CAPI_ACCESS_TOKEN` em cada worker).",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const now = new Date();
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  const evaluation = await evaluateMetaCapiStaleness({ accessToken }, now);

  if (evaluation.verdict === "cannot-verify") {
    // Fail-soft honesto: não dá pra concluir nada — nunca alarma a partir
    // de uma leitura que não aconteceu. Mesmo racional dos demais alarmes
    // do repo (`context/overnight-dispatch-rules.md`).
    console.log(
      `${LOG_PREFIX} não foi possível verificar (${evaluation.cannotVerifyReason}) — nenhum alarme, nada gravado.`,
    );
    if (evaluation.cannotVerifyReason === "not_configured") {
      console.log(
        `${LOG_PREFIX} META_CAPI_ACCESS_TOKEN ausente do .env local — mesmo token que ` +
          `scripts/meta-capi-batch-send.ts já lê via process.env.`,
      );
    }
    return;
  }

  console.log(
    `${LOG_PREFIX} verdict=${evaluation.verdict} server_last_fired_time=${evaluation.serverLastFiredTime ?? "null"} ` +
      `neverFired=${evaluation.check?.neverFired} daysSinceLastFired=${evaluation.check?.daysSinceLastFired ?? "null"}`,
  );

  const state = loadState(STATE_PATH);
  const alarmFindings: AlarmFinding[] = evaluation.verdict === "stale" ? [toAlarmFinding(evaluation)] : [];
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

  if (!shouldSendMetaCapiStalenessAlarm(evaluation, state, now)) {
    console.log(
      evaluation.verdict === "stale"
        ? `${LOG_PREFIX} já alarmado hoje — não reenvia.`
        : `${LOG_PREFIX} sem staleness — nenhum alarme necessário.`,
    );
    return;
  }

  const issueLines = issueRefs.length
    ? "\n\nIssues:\n" +
      issueRefs
        .map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`))
        .join("\n")
    : "";
  const { subject, body } = buildMetaCapiStalenessAlarmEmail(evaluation, issueLines);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markMetaCapiStalenessAlarmed(now), STATE_PATH);
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
