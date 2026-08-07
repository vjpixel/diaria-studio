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
 * Estado (idempotência): `data/clarice-subscribers/opens-catchup-alarm-state.json`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import type { OpensCatchupStatus } from "./lib/extract-opens-catchup-status.ts";
import {
  emptyOpensCatchupAlarmState,
  advanceState,
  shouldAlarm,
  markAlarmed,
  buildOpensCatchupAlarmEmail,
  type OpensCatchupAlarmState,
} from "./lib/clarice-opens-catchup-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS_PATH = resolve(ROOT, "data", "clarice-subscribers", "last-opens-catchup-status.json");
const STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "opens-catchup-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-opens-catchup-alarm]";

export function loadState(statePath: string = STATE_PATH): OpensCatchupAlarmState {
  if (!existsSync(statePath)) return emptyOpensCatchupAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<OpensCatchupAlarmState>;
    const consecutiveFailures = typeof raw.consecutiveFailures === "number" ? raw.consecutiveFailures : 0;
    const lastAlarmedAt = typeof raw.lastAlarmedAt === "string" || raw.lastAlarmedAt === null ? raw.lastAlarmedAt ?? null : null;
    const lastCheckedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt ?? null : null;
    return { consecutiveFailures, lastAlarmedAt, lastCheckedAt };
  } catch {
    return emptyOpensCatchupAlarmState();
  }
}

export function saveState(state: OpensCatchupAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

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

  if (shouldAlarm(newState)) {
    const latestError = status.status === "error" ? status.error : undefined;
    const { subject, body } = buildOpensCatchupAlarmEmail(newState, latestError);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      await sendGmailMessage(to, subject, body);
      newState = markAlarmed(newState, now);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (streak=${newState.consecutiveFailures}).`);
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
