#!/usr/bin/env node
/**
 * scripts/clarice-opens-catchup-alarm.ts (#4740, #4722 item 4)
 *
 * Task diária: lê `data/clarice-subscribers/last-opens-catchup-status.json`
 * (escrito por `extract-opens-catchup-status.ts`, chamado pelo
 * `run-clarice-sync-daily.ps1` logo após cada run de `clarice-sync-brevo.ts
 * --incremental`) e avança um streak de falhas consecutivas do catch-up de
 * opens (#4688). Ao atingir `CONSECUTIVE_FAILURE_THRESHOLD`, alarma o editor
 * por e-mail (Gmail) — o catch-up é fail-soft por design (nunca reprova o
 * sync principal), então uma falha recorrente do MECANISMO DE CORREÇÃO em si
 * passaria despercebida indefinidamente sem este alarme (#4722 item 4, spun
 * off do #4712/#4717/#4721/#4722).
 *
 * Por que não é `clarice-guardrail-alarm.ts`: aquele é domínio DIFERENTE —
 * guardrails de ENGAJAMENTO por campanha (abertura/bounce/unsub/spam) direto
 * contra a API da Brevo, sem ler o summary/log do `clarice-sync-brevo.ts`.
 * Colar a leitura de `opens_catchup.error` ali acoplaria dois alarmes de
 * propósitos distintos sem necessidade (ver corpo da issue #4740).
 *
 * Uso:
 *   npx tsx scripts/clarice-opens-catchup-alarm.ts [--dry-run] [--to email@x]
 *
 *   --dry-run  computa o streak e avalia se alarmaria, mas NÃO envia e-mail
 *              nem avança o estado persistido — mesmo contrato de
 *              `apoios-diff-alarm.ts`/`cursos-error-alarm.ts`.
 *   --to       override do destinatário (default: resolveEditorEmail).
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` + o junction `data/`
 * (OneDrive) — mesmo requisito dos demais alarmes por e-mail do repo.
 *
 * Estado: `data/clarice-subscribers/opens-catchup-alarm-state.json` (streak
 * de falhas, `advanceState`) + `opens-catchup-alarm-issues.json` (tracking
 * de issue por achado, `alarm-issues.ts`).
 *
 * **E-mail (#7960, migrado do estado próprio `lastAlarmedAt` pro portão
 * `notifyEditorForOutcomes`):** severidade `"acao"` — só cria/reusa a issue,
 * nunca manda e-mail sob `notifications.email_policy: "urgent_only"`. Sob
 * `"legacy"`, `legacyResendIntent: "dedupe-new-occurrences-only"` preserva
 * o comportamento histórico: o fingerprint é FIXO ("streak-failing")
 * enquanto o streak persistir, então re-execuções consecutivas reusam a
 * issue (`action: "reused"`) e não devem re-emitir e-mail — era esse o
 * dedup que `shouldAlarm`/`lastAlarmedAt` fazia antes (1 alarme por
 * streak, nunca reenviado a cada checagem — ver docstring de `shouldAlarm`
 * em `lib/clarice-opens-catchup-alarm.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import type { OpensCatchupStatus } from "./lib/extract-opens-catchup-status.ts";
import {
  emptyOpensCatchupAlarmState,
  advanceState,
  buildOpensCatchupAlarmEmail,
  CONSECUTIVE_FAILURE_THRESHOLD,
  type OpensCatchupAlarmState,
} from "./lib/clarice-opens-catchup-alarm.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS_PATH = resolve(ROOT, "data", "clarice-subscribers", "last-opens-catchup-status.json");
/** Streak de falhas consecutivas — NUNCA a idempotência do e-mail (essa
 * migrou pro `AlarmIssueResult.action` via `notifyEditorForOutcomes`, #7960).
 * `lastAlarmedAt` continua no shape (`lib/clarice-opens-catchup-alarm.ts`)
 * mas este script não escreve mais nele — campo morto, preservado só pra
 * não mexer no tipo compartilhado por uma migração que não é dele. */
const STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "opens-catchup-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "opens-catchup-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-opens-catchup-alarm]";
/** #5339: task roda diária — 2 execuções limpas consecutivas (o streak
 * zerou, o achado sai do pendente) fecham a issue automaticamente, mesmo
 * valor de cadência diária usado pelos alarmes já wired (lote 1/3). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** Converte um streak acima do threshold no `AlarmFinding` genérico que
 * `scripts/lib/alarm-issues.ts` consome (#5339). `check`/`fingerprint`
 * FIXOS ("clarice-opens-catchup"/"streak-failing") — diferente dos alarmes
 * `envio`/`envio-guard` (fingerprint por `aammdd`), aqui o achado é "o
 * MECANISMO está quebrado", não um evento datado: a MESMA issue é reusada
 * enquanto o streak persistir (`consecutiveFailures` só aparece no corpo,
 * nunca no fingerprint — senão uma issue nova nasceria a cada dia que o
 * streak cresce). Sem PII: só contagem de streak + mensagem de erro do
 * catch-up (erro de infraestrutura/API, não dado de assinante). */
export function toAlarmFinding(state: OpensCatchupAlarmState, latestError: string | undefined): AlarmFinding {
  return {
    check: "clarice-opens-catchup",
    fingerprint: "streak-failing",
    // #5553 — "o MECANISMO está quebrado" (ver docstring acima), não um
    // evento datado: resolve sozinho quando o streak volta a zero.
    family: "estado",
    title: `[diar.ia.br] catch-up de opens da Clarice falhando (streak ${state.consecutiveFailures})`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Opens-Catchup-Alarm`",
      "(`scripts/clarice-opens-catchup-alarm.ts`).",
      "",
      `Falhas consecutivas: ${state.consecutiveFailures} (threshold: ${CONSECUTIVE_FAILURE_THRESHOLD}).`,
      latestError ? `Último erro: ${latestError}` : "Sem detalhe de erro no status mais recente.",
      "",
      "Verifique data/clarice-subscribers/.brevo-sync-daily.log e confirme",
      "BREVO_CLARICE_API_KEY / conectividade com a Brevo.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

export function loadState(statePath: string = STATE_PATH): OpensCatchupAlarmState {
  if (!existsSync(statePath)) return emptyOpensCatchupAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<OpensCatchupAlarmState>;
    const consecutiveFailures = typeof raw.consecutiveFailures === "number" ? raw.consecutiveFailures : 0;
    const lastAlarmedAt = typeof raw.lastAlarmedAt === "string" || raw.lastAlarmedAt === null ? raw.lastAlarmedAt ?? null : null;
    const lastCheckedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt ?? null : null;
    const lastStatusCheckedAt =
      typeof raw.lastStatusCheckedAt === "string" || raw.lastStatusCheckedAt === null ? raw.lastStatusCheckedAt ?? null : null;
    return { consecutiveFailures, lastAlarmedAt, lastCheckedAt, lastStatusCheckedAt };
  } catch {
    return emptyOpensCatchupAlarmState();
  }
}

// saveState/loadAlarmIssuesState/saveAlarmIssuesState: consolidados em
// scripts/lib/alarm-issues.ts (#7124) — importados acima.
export { saveState };

function loadStatus(statusPath: string = STATUS_PATH): OpensCatchupStatus {
  if (!existsSync(statusPath)) {
    return { status: "not_run", checked_at: new Date().toISOString() };
  }
  try {
    const raw = JSON.parse(readFileSync(statusPath, "utf8")) as Partial<OpensCatchupStatus>;
    if (raw.status === "ok" || raw.status === "error" || raw.status === "not_run") {
      return raw as OpensCatchupStatus;
    }
  } catch {
    // fall through
  }
  return { status: "not_run", checked_at: new Date().toISOString() };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const status = loadStatus();
  const oldState = loadState();
  const now = new Date();
  let newState = advanceState(oldState, status, now);

  console.log(
    `${LOG_PREFIX} status=${status.status} streak=${newState.consecutiveFailures} ` +
      `(último check: ${oldState.lastCheckedAt ?? "nunca"}).`,
  );

  const latestError = status.status === "error" ? status.error : undefined;

  // #5339 — reconcilia issue pro achado (streak acima do threshold) ANTES
  // de montar o e-mail, mesmo padrão do lote 1/3. Roda toda execução
  // não-dry-run. #7960: o e-mail (abaixo) é decidido a partir do OUTCOME
  // desta reconciliação (`notifyEditorForOutcomes`), não mais do gate
  // `shouldAlarm`/`lastAlarmedAt`.
  const alarmFindings: AlarmFinding[] =
    newState.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD ? [toAlarmFinding(newState, latestError)] : [];
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, e-mail NÃO avaliado.`,
    );
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO avançado.`);
    return;
  }

  const { nextState: nextAlarmIssuesState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextAlarmIssuesState, ALARM_ISSUES_STATE_PATH);
  for (const outcome of findingOutcomes) {
    if (outcome.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
    }
  }

  if (findingOutcomes.length === 0) {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário.`);
  } else {
    const result = await notifyEditorForOutcomes(
      findingOutcomes,
      "acao",
      (qualifying) => buildOpensCatchupAlarmEmail(newState, latestError, qualifying[0]),
      {
        cwd: ROOT,
        platformConfigPath: PLATFORM_CONFIG_PATH,
        emailTo: toOverride,
        // #8271: fingerprint FIXO ("streak-failing") enquanto o streak
        // persistir — 1 e-mail por streak (`shouldAlarm` pré-migração),
        // não um reenvio periódico deliberado. Reexecução no MESMO streak
        // reusa a issue (`action: "reused"`) e não deve re-emitir e-mail
        // sob `email_policy: "legacy"` — era esse o dedup que
        // `lastAlarmedAt` fazia antes.
        legacyResendIntent: "dedupe-new-occurrences-only",
      },
    );
    if (result.qualifying.length === 0) {
      console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário pra este outcome.`);
    } else if (result.emailSent) {
      console.log(`${LOG_PREFIX} e-mail de alarme enviado (streak=${newState.consecutiveFailures}).`);
    } else {
      console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
    }
  }

  saveState(newState, STATE_PATH);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
