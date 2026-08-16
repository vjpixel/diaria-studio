#!/usr/bin/env node
/**
 * scripts/clarice-postmaster-alarm.ts (#5399 achado 2)
 *
 * Task periódica: busca a entry mais recente de `postmaster:spam`
 * (`GET {dashboardUrl}/api/postmaster-spam`, mesma fonte que
 * `clarice-envio-risk.ts` consulta pra decidir o freio de ISP) e avança um
 * streak de checagens CONSECUTIVAS em que a leitura está STALE (`date` além
 * de `POSTMASTER_DATA_STALE_MS`, ou nenhuma leitura registrada). Ao atingir
 * `CONSECUTIVE_STALE_THRESHOLD`, alarma o editor por e-mail (Gmail) — o freio
 * de ISP (`decideBrake`) já é fail-safe quando o sinal degrada pra
 * `indeterminate` (assume 70% de utilização, nunca acelera), mas NENHUM dos 4
 * alarmes já wired do domínio Clarice (`clarice-envio-alarm.ts`,
 * `clarice-envio-guard-alarm.ts`, `clarice-guardrail-alarm.ts`,
 * `clarice-opens-catchup-alarm.ts`) cobria isso (grep limpo, achado ao vivo
 * 16/08/2026) — o risco real é o operador decidir volume manualmente sem
 * saber que o sinal primário de spam está cego.
 *
 * Lógica pura em `scripts/lib/clarice-postmaster-alarm.ts` — este arquivo é
 * só I/O (fetch do dashboard, ler/gravar estado, enviar e-mail), mesmo molde
 * de `clarice-opens-catchup-alarm.ts`.
 *
 * Uso:
 *   npx tsx scripts/clarice-postmaster-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/clarice-postmaster-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/clarice-postmaster-alarm.ts --to email@x   # override do destinatário
 *   npx tsx scripts/clarice-postmaster-alarm.ts --dashboard-url URL
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário pra
 * ENVIAR o alarme; a leitura do dashboard não precisa de credencial nenhuma.
 *
 * Estado (idempotência): `data/clarice-subscribers/postmaster-alarm-state.json` —
 * 1 alarme por streak (zera e re-arma quando uma leitura fresca aparece).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { DEFAULT_DASHBOARD_URL, fetchPostmasterSpamEntry } from "./clarice-schedule-ramp.ts";
import {
  emptyPostmasterStaleAlarmState,
  advanceState,
  shouldAlarm,
  markAlarmed,
  buildPostmasterStaleAlarmEmail,
  CONSECUTIVE_STALE_THRESHOLD,
  type PostmasterStaleAlarmState,
} from "./lib/clarice-postmaster-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "postmaster-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "postmaster-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-postmaster-alarm]";
/** 2 checagens limpas consecutivas (streak zerou — leitura fresca voltou)
 * fecham a issue automaticamente, mesmo valor de cadência usado pelos outros
 * alarmes já wired (#5339). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** Converte um streak acima do threshold no `AlarmFinding` genérico que
 * `scripts/lib/alarm-issues.ts` consome. `check`/`fingerprint` FIXOS
 * ("clarice-postmaster"/"signal-stale") — o achado é "o SINAL está cego",
 * não um evento datado: a MESMA issue é reusada enquanto o streak persistir.
 * Sem PII: só data da última leitura + contagem de streak. */
function toAlarmFinding(state: PostmasterStaleAlarmState, entryDate: string | null): AlarmFinding {
  return {
    check: "clarice-postmaster",
    fingerprint: "signal-stale",
    title: `[diar.ia.br] sinal de spam do Postmaster cego (streak ${state.consecutiveStale})`,
    body: [
      "Achado automático do alarme `Diaria-Postmaster-Spam-Alarm`",
      "(`scripts/clarice-postmaster-alarm.ts`).",
      "",
      `Checagens stale consecutivas: ${state.consecutiveStale} (threshold: ${CONSECUTIVE_STALE_THRESHOLD}).`,
      `Última data de leitura conhecida: ${entryDate ?? "(nenhuma)"}.`,
      "",
      "O freio de ISP (clarice-envio-risk.ts) segue fail-safe (assume 70% de",
      "utilização), mas o operador pode decidir volume manualmente sem saber",
      "que o sinal primário está cego. Verifique a task",
      "'Diaria-Postmaster-Spam-Sync' (docs/postmaster-spam-sync-setup.md).",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5339).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

export function loadState(statePath: string = STATE_PATH): PostmasterStaleAlarmState {
  if (!existsSync(statePath)) return emptyPostmasterStaleAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PostmasterStaleAlarmState>;
    const consecutiveStale = typeof raw.consecutiveStale === "number" ? raw.consecutiveStale : 0;
    const lastAlarmedAt = typeof raw.lastAlarmedAt === "string" || raw.lastAlarmedAt === null ? raw.lastAlarmedAt ?? null : null;
    const lastCheckedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt ?? null : null;
    return { consecutiveStale, lastAlarmedAt, lastCheckedAt };
  } catch {
    return emptyPostmasterStaleAlarmState();
  }
}

export function saveState(state: PostmasterStaleAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE por achado) — arquivo separado de
// STATE_PATH de propósito, mesmo racional dos alarmes já wired: idempotência
// do E-MAIL e tracking de ISSUE são preocupações independentes.

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

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const dashboardUrl = getArg(argv, "dashboard-url") || DEFAULT_DASHBOARD_URL;

  const entry = await fetchPostmasterSpamEntry(dashboardUrl);
  const oldState = loadState();
  const now = new Date();
  let newState = advanceState(oldState, entry, now);

  console.log(
    `${LOG_PREFIX} entry.date=${entry?.date ?? "(nenhuma)"} streak=${newState.consecutiveStale} ` +
      `(último check: ${oldState.lastCheckedAt ?? "nunca"}).`,
  );

  // Reconcilia issue pro achado (streak acima do threshold) ANTES de montar
  // o e-mail, mesmo padrão dos alarmes já wired. Roda toda execução
  // não-dry-run, independente do gate `shouldAlarm` (que é sobre o E-MAIL,
  // já idempotente por streak via `lastAlarmedAt`).
  const alarmFindings: AlarmFinding[] =
    newState.consecutiveStale >= CONSECUTIVE_STALE_THRESHOLD ? [toAlarmFinding(newState, entry?.date ?? null)] : [];
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

  if (shouldAlarm(newState)) {
    const { subject, body } = buildPostmasterStaleAlarmEmail(newState, entry ? { date: entry.date } : null, issueRef);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      await sendGmailMessage(to, subject, body);
      newState = markAlarmed(newState, now);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (streak=${newState.consecutiveStale}).`);
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
