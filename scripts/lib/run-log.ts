/**
 * run-log.ts (#612) — helper programático pra append em data/run-log.jsonl.
 *
 * Centraliza o que antes vivia duplicado em inbox-drain.ts (logDrainError/Info/Warn),
 * drive-sync.ts (logSyncWarnings), e qualquer caller que append manual no
 * run-log. CLI continua existindo em scripts/log-event.ts; este módulo serve
 * scripts TS que precisam logar inline.
 *
 * Falhas de logging NUNCA sobem — princípio: logging não pode mascarar erro
 * original. Falha silenciosa é OK; auto-reporter só registra o que conseguiu
 * gravar.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface RunLogEvent {
  edition: string | null;
  stage: number | null;
  agent: string | null;
  level: LogLevel;
  message: string;
  details?: unknown;
}

interface PersistedEvent extends RunLogEvent {
  timestamp: string;
  details: unknown;
}

/**
 * Resolve o path do run-log:
 * 1. `platform.config.json` > `logging.path` (relativo a `rootDir`)
 * 2. fallback `data/run-log.jsonl`
 *
 * `rootDir` default é o cwd, mas pode ser injetado pra tests não bagunçarem
 * o log de produção.
 */
export function resolveRunLogPath(rootDir: string = process.cwd()): string {
  const cfgPath = resolve(rootDir, "platform.config.json");
  if (!existsSync(cfgPath)) return resolve(rootDir, "data/run-log.jsonl");
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { logging?: { path?: string } };
    return resolve(rootDir, cfg?.logging?.path ?? "data/run-log.jsonl");
  } catch {
    return resolve(rootDir, "data/run-log.jsonl");
  }
}

/**
 * Pure: monta o evento canônico que vai pro JSONL. Exposto pra tests.
 *
 * `details` ausente ou explicitamente undefined vira `null` — JSONL com null
 * é mais fácil de filtrar do que com chave ausente.
 */
export function buildLogEvent(event: RunLogEvent, now: Date = new Date()): PersistedEvent {
  return {
    timestamp: now.toISOString(),
    edition: event.edition,
    stage: event.stage,
    agent: event.agent,
    level: event.level,
    message: event.message,
    details: event.details ?? null,
  };
}

/**
 * Append um evento estruturado em `data/run-log.jsonl`. Falha silenciosamente
 * — logging nunca pode mascarar o erro original do caller.
 *
 * `rootDir` default é cwd; injete em tests pra apontar pra tmpdir.
 */
export function logEvent(event: RunLogEvent, rootDir: string = process.cwd()): void {
  try {
    const persisted = buildLogEvent(event);
    const logPath = resolveRunLogPath(rootDir);
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(persisted) + "\n", "utf8");
  } catch {
    // swallow — logging must never mask the original error
  }
}
