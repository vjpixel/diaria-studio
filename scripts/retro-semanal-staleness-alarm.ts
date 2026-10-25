#!/usr/bin/env node
/**
 * scripts/retro-semanal-staleness-alarm.ts (#11069)
 *
 * Task semanal (sábado de manhã, ver `scripts/lib/scheduled-tasks.ts`): checa
 * se a `/diaria-retro-semanal` já agendou o carrossel `highlights` do sábado
 * — store local `data/weekly/{AAMMDD}/06-weekly-published.json` e, se ele
 * não provar, a fila do Worker (`GET /list`). Sem evidência, cria/reusa uma
 * issue e avisa o editor. Fecha o buraco da semana 261024: a skill só rodou
 * no sábado às 23:12 BRT, o slot de sábado foi perdido e nada avisou.
 *
 * Irmão de `scripts/linkedin-weekly-staleness-alarm.ts` (#5111) — mesmo molde
 * (issue via `alarm-issues.ts`, e-mail via `notifyEditorForOutcomes`,
 * severidade `"acao"`, `legacyResendIntent: "dedupe-new-occurrences-only"`).
 * Lógica pura em `scripts/lib/retro-semanal-staleness-alarm.ts`; este
 * arquivo é só I/O (leitura do store, GET no Worker, gh, e-mail).
 *
 * Uso:
 *   npx tsx scripts/retro-semanal-staleness-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/retro-semanal-staleness-alarm.ts --dry-run      # avalia + imprime; NÃO chama gh nem envia e-mail
 *   npx tsx scripts/retro-semanal-staleness-alarm.ts --saturday 261024   # sábado explícito (debug)
 *   npx tsx scripts/retro-semanal-staleness-alarm.ts --to email@x   # override do destinatário
 *
 * O `--dry-run` ainda faz o GET (só leitura) na fila do Worker quando o store
 * local não prova o agendamento — é o que decide o veredito.
 *
 * Requer (só pra consultar o Worker): `DIARIA_LINKEDIN_CRON_URL` (ou
 * `publishing.social.linkedin.cloudflare_worker_url`) + `DIARIA_LINKEDIN_CRON_TOKEN`.
 * Ausentes → o veredito usa só o store local e o achado registra isso.
 *
 * Estado: `data/weekly/retro-semanal-staleness-alarm-issues.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { resolveWeeklyPublishedPath } from "./lib/weekly-worker-dispatch.ts";
import { fetchWorkerList, resolveLinkedinWorkerUrl, type FetchJsonFn } from "./verify-social-worker-dispatch.ts";
import {
  mostRecentSaturday,
  toAAMMDD,
  needsWorkerLookup,
  evaluateRetroSemanalStalenessAlarm,
  describeRetroSemanalEvaluation,
  buildRetroSemanalStalenessAlarmEmail,
  type RetroSemanalStalenessEvaluation,
  type RetroSemanalWorkerLookup,
} from "./lib/retro-semanal-staleness-alarm.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  saveAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "weekly", "retro-semanal-staleness-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[retro-semanal-staleness-alarm]";
/** Task semanal — 2 execuções limpas consecutivas = 2 sábados sem o achado
 * (mesmo valor do irmão `linkedin-weekly-staleness-alarm.ts`). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;
const WORKER_FETCH_TIMEOUT_MS = 20_000;

export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(`${LOG_PREFIX} estado de alarm-issues corrompido/ilegível em ${statePath} — resetando pra vazio: ${(e as Error).message}`);
    return emptyAlarmIssuesState();
  }
}

/** Lê `06-weekly-published.json` do sábado. Ausente → `null`; ilegível → `null` + log (o veredito trata como sem evidência). */
export function readWeeklyStore(saturday: string, rootDir: string = ROOT): unknown {
  const path = resolveWeeklyPublishedPath(rootDir, saturday);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`${LOG_PREFIX} ${path} ilegível — tratado como sem evidência: ${(e as Error).message}`);
    return null;
  }
}

/** Converte a avaliação num `AlarmFinding` (#5339). `fingerprint` = sábado
 * `AAMMDD` — cada semana perdida é um achado distinto, mesma granularidade
 * do irmão (ciclo). Sem PII. */
export function toAlarmFinding(evaluation: RetroSemanalStalenessEvaluation): AlarmFinding {
  const { saturday } = evaluation;
  return {
    check: "retro-semanal-staleness",
    fingerprint: saturday,
    // Condição re-checada a cada execução ("o carrossel deste sábado está
    // agendado?") — mesma família `estado` do irmão (#5553).
    family: "estado",
    title: `[diar.ia.br] Retro semanal: carrossel de sábado ${saturday} não foi agendado`,
    body: [
      "Achado automático do alarme `Diaria-Retro-Semanal-Staleness-Alarm`",
      "(`scripts/retro-semanal-staleness-alarm.ts`, #11069).",
      "",
      `A retrospectiva semanal (/diaria-retro-semanal) não agendou o carrossel "highlights"`,
      `do sábado ${saturday}: nada em data/weekly/${saturday}/06-weekly-published.json`,
      "nem na fila do Worker.",
      "",
      ...describeRetroSemanalEvaluation(evaluation),
      "",
      `Rode: /diaria-retro-semanal ${saturday}`,
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada",
      `sozinha quando o achado deixar de reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas.`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

const fetchJsonWithTimeout: FetchJsonFn = async (url, token) => {
  const res = await fetch(url, {
    headers: { "X-Diaria-Token": token },
    signal: AbortSignal.timeout(WORKER_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Worker HTTP ${res.status} em ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
};

/** GET `/list` no Worker. Nunca lança — falha vira `{ok: false, error}`. */
export async function lookupWorkerQueue(
  rootDir: string = ROOT,
  fetchJson: FetchJsonFn = fetchJsonWithTimeout,
): Promise<RetroSemanalWorkerLookup> {
  const workerUrl = resolveLinkedinWorkerUrl(rootDir);
  const token = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  if (!workerUrl || !token) {
    return { ok: false, error: "DIARIA_LINKEDIN_CRON_URL/DIARIA_LINKEDIN_CRON_TOKEN ausente" };
  }
  try {
    const list = await fetchWorkerList(workerUrl, token, fetchJson);
    if (!list || !Array.isArray(list.items)) return { ok: false, error: "resposta de /list sem `items`" };
    return { ok: true, items: list.items };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const saturdayArg = getArg(argv, "saturday");
  if (saturdayArg !== undefined && !/^\d{6}$/.test(saturdayArg)) {
    throw new Error(`--saturday precisa ser AAMMDD (recebido: ${saturdayArg})`);
  }
  const saturday = saturdayArg ?? toAAMMDD(mostRecentSaturday(new Date()));

  const store = readWeeklyStore(saturday);
  const worker = needsWorkerLookup(store) ? await lookupWorkerQueue(ROOT) : null;
  const evaluation = evaluateRetroSemanalStalenessAlarm(saturday, store, worker);
  console.log(
    `${LOG_PREFIX} saturday=${saturday} store=${store === null ? "ausente" : "presente"} ` +
      `highlights=${evaluation.highlightsSource} clicked=${evaluation.clickedSource} ` +
      `worker=${evaluation.workerConsulted ? "consultado" : evaluation.workerError ? `falhou (${evaluation.workerError})` : "não consultado"} ` +
      `verdict=${evaluation.verdict}`,
  );

  const alarmFindings: AlarmFinding[] = evaluation.verdict === "alarm-missing" ? [toAlarmFinding(evaluation)] : [];
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, e-mail NÃO avaliado.`,
    );
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
  for (const outcome of findingOutcomes) {
    if (outcome.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
    }
  }

  if (findingOutcomes.length === 0) {
    console.log(`${LOG_PREFIX} sábado ${saturday} OK — nenhum alarme necessário.`);
    return;
  }

  const result = await notifyEditorForOutcomes(
    findingOutcomes,
    "acao",
    (qualifying) => buildRetroSemanalStalenessAlarmEmail(evaluation, qualifying[0]),
    {
      cwd: ROOT,
      platformConfigPath: PLATFORM_CONFIG_PATH,
      emailTo: toOverride,
      // Mesmo racional do irmão (#8271): 1 ocorrência por sábado; retry no
      // mesmo sábado reusa a issue e não re-emite e-mail sob `legacy`.
      legacyResendIntent: "dedupe-new-occurrences-only",
    },
  );
  if (result.qualifying.length === 0) {
    console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário pra este outcome.`);
  } else if (result.emailSent) {
    console.log(`${LOG_PREFIX} e-mail de alarme enviado (saturday=${saturday}).`);
  } else {
    console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
  }
}

if (isMainModule(import.meta.url)) {
  // #9911: process.exitCode (via runCli), nunca process.exit() depois de fetch.
  void runCli(main, { onError: (e) => console.error(`${LOG_PREFIX} erro:`, e) });
}
