#!/usr/bin/env node
/**
 * scripts/clarice-novos-abort-alarm.ts (#5405 item 1)
 *
 * Task diária: lê `data/clarice-subscribers/last-novos-run-status.json`
 * (escrito por `clarice-novos-run.ts` em toda invocação real — Passo 1 em
 * diante) e avança um streak de ABORTS CONSECUTIVOS por semáforo vermelho
 * (D4, #4347). Ao atingir `NOVOS_ABORT_STREAK_THRESHOLD`, alarma o editor
 * por e-mail — mesmo molde de `clarice-opens-catchup-alarm.ts` (#4740):
 * D4 é fail-soft por design (aborta a rodada, não quebra a task), então uma
 * série de aborts passaria despercebida indefinidamente sem este alarme
 * (achado ao vivo, #5405: 2 rodadas seguidas abortaram em silêncio,
 * descobertas só ao abrir o relatório manualmente).
 *
 * Uso:
 *   npx tsx scripts/clarice-novos-abort-alarm.ts [--dry-run] [--to email@x]
 *
 *   --dry-run  computa o streak e avalia se alarmaria, mas NÃO envia e-mail
 *              nem avança o estado persistido.
 *   --to       override do destinatário (default: resolveEditorEmail).
 *
 * Estado (idempotência): `data/clarice-subscribers/novos-abort-alarm-state.json`.
 *
 * @see scripts/lib/clarice-novos-abort-alarm.ts (lógica pura)
 * @see scripts/lib/clarice-novos-run-status.ts (fonte do status por rodada)
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { readNovosRunStatus } from "./lib/clarice-novos-run-status.ts";
import { readNovosCutoff } from "./lib/clarice-novos-cutoff.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { loadStoreRows, segmentNovos } from "./lib/clarice-segment.ts";
import {
  emptyNovosAbortAlarmState,
  advanceNovosAbortState,
  shouldAlarmNovosAbort,
  markNovosAbortAlarmed,
  buildNovosAbortAlarmEmail,
  NOVOS_ABORT_STREAK_THRESHOLD,
  type NovosAbortAlarmState,
} from "./lib/clarice-novos-abort-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLARICE_DIR = resolve(ROOT, "data", "clarice-subscribers");
const STATE_PATH = resolve(CLARICE_DIR, "novos-abort-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(CLARICE_DIR, "novos-abort-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-novos-abort-alarm]";
/** 2 execuções limpas consecutivas fecham a issue automaticamente — mesmo
 * valor de cadência diária usado pelos alarmes já wired (#5339). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export function toAlarmFinding(state: NovosAbortAlarmState, latestDetail: string | undefined): AlarmFinding {
  return {
    check: "clarice-novos-abort",
    fingerprint: "semaphore-streak",
    // #5553 — o achado é "o MECANISMO está abortando", não um evento datado:
    // resolve sozinho quando o streak volta a zero.
    family: "estado",
    title: `[diar.ia.br] /diaria-clarice-novos abortando (streak ${state.consecutiveSemaphoreAborts})`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Novos-Abort-Alarm`",
      "(`scripts/clarice-novos-abort-alarm.ts`).",
      "",
      `Aborts consecutivos por semáforo vermelho (D4): ${state.consecutiveSemaphoreAborts} (threshold: ${NOVOS_ABORT_STREAK_THRESHOLD}).`,
      latestDetail ? `Último detalhe: ${latestDetail}` : "Sem detalhe adicional no status mais recente.",
      "",
      "D4 é o comportamento correto (não enviar com entregabilidade comprometida)",
      "— esta issue é sobre VISIBILIDADE, não sobre reverter o guard.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5405) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

export function loadState(statePath: string = STATE_PATH): NovosAbortAlarmState {
  if (!existsSync(statePath)) return emptyNovosAbortAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<NovosAbortAlarmState>;
    const consecutiveSemaphoreAborts =
      typeof raw.consecutiveSemaphoreAborts === "number" ? raw.consecutiveSemaphoreAborts : 0;
    const lastAlarmedAt =
      typeof raw.lastAlarmedAt === "string" || raw.lastAlarmedAt === null ? raw.lastAlarmedAt ?? null : null;
    const lastCheckedAt =
      typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt ?? null : null;
    return { consecutiveSemaphoreAborts, lastAlarmedAt, lastCheckedAt };
  } catch {
    return emptyNovosAbortAlarmState();
  }
}

export function saveState(state: NovosAbortAlarmState, statePath: string = STATE_PATH): void {
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

/** #5405 item 3 — fila represada (contatos na janela `novos` ainda não
 * enviados) no MOMENTO do alarme. Fail-soft: qualquer erro de leitura do
 * store (DB ausente/corrompida) devolve `null` — o alarme dispara mesmo
 * assim, só sem esse dado auxiliar no corpo do e-mail. */
function computePendingNovos(dbPath: string): { count: number; earliestCreatedIso: string | null } | null {
  const cutoff = readNovosCutoff(CLARICE_DIR);
  if (!cutoff) return null;
  try {
    const db = openClariceDb(dbPath);
    let rows;
    try {
      rows = loadStoreRows(db);
    } finally {
      db.close();
    }
    const pending = segmentNovos(rows, { sinceIso: cutoff.cutoffIso });
    if (pending.length === 0) return { count: 0, earliestCreatedIso: null };
    let earliest: string | null = null;
    for (const r of pending) {
      if (r.created && (earliest === null || r.created < earliest)) earliest = r.created;
    }
    return { count: pending.length, earliestCreatedIso: earliest };
  } catch (err) {
    console.error(`${LOG_PREFIX} aviso: não consegui calcular a fila represada (fail-soft): ${(err as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const status = readNovosRunStatus(CLARICE_DIR);
  const oldState = loadState();
  const now = new Date();

  if (!status) {
    console.log(`${LOG_PREFIX} sem status de novos-run ainda (1ª rodada nesta base) — nada a fazer.`);
    return;
  }

  let newState = advanceNovosAbortState(oldState, status.status, now);

  console.log(
    `${LOG_PREFIX} status=${status.status} streak=${newState.consecutiveSemaphoreAborts} ` +
      `(último check: ${oldState.lastCheckedAt ?? "nunca"}).`,
  );

  const latestDetail = status.status === "semaphore-red" ? status.detail : undefined;

  const alarmFindings: AlarmFinding[] =
    newState.consecutiveSemaphoreAborts >= NOVOS_ABORT_STREAK_THRESHOLD ? [toAlarmFinding(newState, latestDetail)] : [];
  const alarmState = loadAlarmIssuesState();
  let issueRef: { issueNumber: number | null; url: string | null; action: string; error?: string } | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState: nextAlarmIssuesState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextAlarmIssuesState);
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

  if (shouldAlarmNovosAbort(newState)) {
    const pending = computePendingNovos(DEFAULT_DB_PATH);
    const { subject, body } = buildNovosAbortAlarmEmail(newState, latestDetail, pending, issueRef);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      await sendGmailMessage(to, subject, body);
      newState = markNovosAbortAlarmed(newState, now);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (streak=${newState.consecutiveSemaphoreAborts}).`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário.`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO avançado.`);
    return;
  }
  saveState(newState);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
