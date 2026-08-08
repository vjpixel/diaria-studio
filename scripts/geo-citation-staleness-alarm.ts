#!/usr/bin/env node
/**
 * scripts/geo-citation-staleness-alarm.ts (#4755)
 *
 * Task semanal: lê o `ts` do registro mais recente de
 * `data/geo-citations/history.jsonl` (escrito por `geo-citation-monitor.ts`,
 * #4558 Parte C) e alarma o editor por e-mail (Gmail) quando faz mais de
 * `STALENESS_THRESHOLD_DAYS` que nenhum registro novo chegou — sinal que
 * cobre, com o mesmo sintoma observável, task desabilitada/removida do Task
 * Scheduler, máquina fora por semanas, ou todo provider sem API key (ver
 * docstring de `scripts/lib/geo-citation-staleness-alarm.ts`).
 *
 * Por que não é o guard de `test/pending-scheduled-tasks.test.ts`: aquele
 * descobre a task pelo NOME (`Get-ScheduledTask`) — cobre só o registro
 * inicial, nunca `State`/`LastTaskResult`. Este alarme olha o SINTOMA
 * (histórico parado), não o registro da task, e roda separado — mesma task
 * desabilitada e sem re-registrar nunca dispara o guard de teste de novo.
 *
 * Uso:
 *   npx tsx scripts/geo-citation-staleness-alarm.ts [--dry-run] [--to email@x]
 *
 *   --dry-run  computa a staleness e avalia se alarmaria, mas NÃO envia
 *              e-mail nem avança o estado persistido — mesmo contrato de
 *              `apoios-diff-alarm.ts`/`clarice-opens-catchup-alarm.ts`.
 *   --to       override do destinatário (default: resolveEditorEmail).
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` + o junction
 * `data/` (OneDrive) — mesmo requisito dos demais alarmes por e-mail do
 * repo. NÃO requer nenhuma das API keys de provider GEO — só lê o histórico
 * já escrito, nunca chama os providers.
 *
 * Estado (idempotência): `data/geo-citations/staleness-alarm-state.json`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { DEFAULT_GEO_CITATIONS_LOG_PATH } from "./lib/geo-citation-monitor.ts";
import {
  emptyGeoCitationStalenessAlarmState,
  computeStaleness,
  fingerprintFor,
  advanceState,
  shouldAlarm,
  buildGeoCitationStalenessAlarmEmail,
  type GeoCitationStalenessAlarmState,
} from "./lib/geo-citation-staleness-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PATH = resolve(ROOT, DEFAULT_GEO_CITATIONS_LOG_PATH);
const STATE_PATH = resolve(ROOT, "data", "geo-citations", "staleness-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[geo-citation-staleness-alarm]";

export function loadState(statePath: string = STATE_PATH): GeoCitationStalenessAlarmState {
  if (!existsSync(statePath)) return emptyGeoCitationStalenessAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<GeoCitationStalenessAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint ?? null
        : null;
    const checkedAt =
      typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt ?? null : null;
    return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: checkedAt };
  } catch {
    return emptyGeoCitationStalenessAlarmState();
  }
}

export function saveState(state: GeoCitationStalenessAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Lê o `ts` do ÚLTIMO registro legível de `history.jsonl`, andando de trás
 * pra frente — fail-soft linha a linha (uma linha corrompida não invalida
 * as anteriores, mesmo espírito string-safe de `extract-opens-catchup-status.ts`).
 * Retorna `null` quando o arquivo não existe, está vazio, ou nenhuma linha é
 * um JSON válido com `ts` string.
 */
export function readLatestGeoCitationTs(historyPath: string = HISTORY_PATH): string | null {
  if (!existsSync(historyPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(historyPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]) as { ts?: unknown };
      if (typeof record.ts === "string" && record.ts.length > 0) return record.ts;
    } catch {
      continue;
    }
  }
  return null;
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const latestRecordTs = readLatestGeoCitationTs();
  const now = new Date();
  const check = computeStaleness(latestRecordTs, now);
  const fingerprint = fingerprintFor(latestRecordTs);
  const state = loadState();

  console.log(
    `${LOG_PREFIX} último registro: ${latestRecordTs ?? "nenhum"} ` +
      `(${check.staleDays ?? "?"} dia(s), stale=${check.isStale}; última checagem: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  if (shouldAlarm(state, check, fingerprint)) {
    const { subject, body } = buildGeoCitationStalenessAlarmEmail(latestRecordTs, check.staleDays);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (não stale, ou esta staleness já foi alarmada antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO avançado.`);
    return;
  }

  const nextFingerprint = check.isStale ? fingerprint : null;
  saveState(advanceState(nextFingerprint, now));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
