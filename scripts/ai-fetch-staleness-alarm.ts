#!/usr/bin/env node
/**
 * scripts/ai-fetch-staleness-alarm.ts (#8340)
 *
 * Task diária: checa se `data/ai-fetch/history.jsonl` (escrito por
 * `Diaria-Ai-Fetch-Report`, `scripts/ai-fetch-report.ts`) recebeu um
 * registro novo dentro de `AI_FETCH_STALENESS_THRESHOLD_DAYS` dias, e
 * alarma o editor por e-mail (+ issue auto-criada, via `notifyEditor`) se
 * não. Fecha o buraco de observabilidade da própria #8340: a task
 * `ai-fetch-report.ts` já tinha sido mergeada e nunca agendada por semanas
 * sem que ninguém percebesse — este alarme existe pra essa classe de falha
 * não se repetir em silêncio (task desregistrada de novo, credencial
 * Cloudflare expirada, etc).
 *
 * Lógica pura em `scripts/lib/ai-fetch-staleness-alarm.ts` — este arquivo é
 * só I/O (leitura local do JSONL, envio de e-mail via `notifyEditor`).
 * **Nunca chama a API Cloudflare KV** — leitura local apenas (guard de
 * publicação do overnight/develop não se aplica aqui, mas a disciplina de
 * "não rede em teste" segue igual pro resto do repo).
 *
 * Uso:
 *   npx tsx scripts/ai-fetch-staleness-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/ai-fetch-staleness-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/ai-fetch-staleness-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` pra ENVIAR o
 * alarme — a checagem em si não precisa de credencial nenhuma. Requer o
 * junction `data/` (OneDrive) pra ler o histórico e persistir o state.
 *
 * Estado (idempotência): `data/ai-fetch/staleness-alarm-state.json` — 1
 * alarme por (isStale, último ts conhecido), mesmo padrão de
 * `beehiiv-backup-staleness-alarm.ts` (#5494).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { computeStaleness } from "./lib/geo-citation-staleness-alarm.ts";
import { DEFAULT_AI_FETCH_LOG_PATH } from "./ai-fetch-report.ts";
import {
  AI_FETCH_STALENESS_THRESHOLD_DAYS,
  emptyAiFetchStalenessAlarmState,
  shouldAlarm,
  advanceState,
  fingerprintFor,
  buildAiFetchStalenessAlarmEmail,
  type AiFetchStalenessAlarmState,
} from "./lib/ai-fetch-staleness-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_HISTORY_PATH = resolve(ROOT, DEFAULT_AI_FETCH_LOG_PATH);
const DEFAULT_STATE_PATH = resolve(ROOT, "data/ai-fetch/staleness-alarm-state.json");
const LOG_PREFIX = "[ai-fetch-staleness-alarm]";

/**
 * Lê o `ts` do ÚLTIMO registro legível de `history.jsonl`, andando de trás
 * pra frente — fail-soft linha a linha (uma linha corrompida não invalida
 * as anteriores), mesmo padrão de `readLatestGeoCitationTs`
 * (`geo-citation-staleness-alarm.ts`). Retorna `null` quando o arquivo não
 * existe, está vazio, ou nenhuma linha é um JSON válido com `ts` string.
 */
export function readLatestAiFetchTs(historyPath: string = DEFAULT_HISTORY_PATH): string | null {
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

export function loadState(statePath: string): AiFetchStalenessAlarmState {
  if (!existsSync(statePath)) return emptyAiFetchStalenessAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<AiFetchStalenessAlarmState>;
    return {
      lastAlarmedFingerprint: typeof raw.lastAlarmedFingerprint === "string" ? raw.lastAlarmedFingerprint : null,
    };
  } catch {
    return emptyAiFetchStalenessAlarmState();
  }
}

export function saveState(state: AiFetchStalenessAlarmState, statePath: string): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv();
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const historyPath = getArg(argv, "history") || DEFAULT_HISTORY_PATH;
  const statePath = getArg(argv, "state") || DEFAULT_STATE_PATH;

  const latestRecordTs = readLatestAiFetchTs(historyPath);
  const check = computeStaleness(latestRecordTs, new Date(), AI_FETCH_STALENESS_THRESHOLD_DAYS);
  console.log(`${LOG_PREFIX} último registro=${latestRecordTs ?? "nenhum"} staleDays=${check.staleDays ?? "n/d"} isStale=${check.isStale}`);

  const state = loadState(statePath);
  if (!shouldAlarm(check, latestRecordTs, state)) {
    console.log(check.isStale ? `${LOG_PREFIX} já alarmado pra este estado — não reenvia.` : `${LOG_PREFIX} nada a alarmar.`);
    return;
  }

  const { subject, body } = buildAiFetchStalenessAlarmEmail(latestRecordTs, check.staleDays);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: registraria alarme:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  const result = await notifyEditor(
    {
      check: "ai-fetch-staleness-alarm",
      fingerprint: fingerprintFor(check, latestRecordTs),
      severity: "acao",
      subject,
      body,
    },
    { cwd: ROOT, emailTo: toOverride },
  );
  if (result.issue?.action === "failed") {
    throw new Error(`ensureAlarmIssue falhou: ${result.issue.error}`);
  }
  saveState(advanceState(check, latestRecordTs), statePath);
  console.log(`${LOG_PREFIX} alarme registrado (issue #${result.issue?.issueNumber ?? "?"}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
