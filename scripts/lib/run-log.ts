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
 *
 * `logEvent` (#8453) devolve `boolean` (sucesso da escrita) em vez de `void`
 * — NUNCA lança, mas agora expõe um sinal que o caller pode checar se quiser
 * (ex: `notifyEditor` propaga isso como `logWriteOk` pro caminho
 * `info`/`silencio`, que antes não tinha NENHUMA forma de distinguir
 * "gravado" de "escrita falhou em silêncio" — achado #8453/PR #8452).
 * Callers que ignoram o retorno (a maioria, hoje) continuam funcionando
 * sem mudança nenhuma.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendFileWithRetry } from "./source-runs.ts";

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
 * Append um evento estruturado em `data/run-log.jsonl`.
 *
 * #8634: retry curto com backoff (3x) no append — Windows + OneDrive Files
 * On-Demand pode retornar `UNKNOWN` (errno=-4094), `EPERM`, `EBUSY`,
 * `EACCES` quando o sync agent tem o arquivo locked durante hidratação.
 * Caso real 260921: `appendFileSync` lançou `Error: UNKNOWN: unknown error,
 * write` (errno -4094) ao gravar em `data/run-log.jsonl`, o log daquele evento
 * se perdeu e o script saiu com stack trace.
 *
 * Se o retry também falhar, degrada: escreve um `warn` no stderr e devolve
 * `false` — logging NUNCA pode derrubar o stage (#8634). O caller original
 * (ex: `stage-0-run.ts`) continua sem ser afetado.
 *
 * `logEvent` devolve `boolean` (`true` = escreveu, `false` = falhou) em vez
 * de `void` (#8453), pra quem quiser checar sem precisar que `logEvent`
 * lance. Callers que ignoram o retorno (a maioria, hoje) continuam
 * funcionando sem mudança nenhuma.
 *
 * `rootDir` default é cwd; injete em tests pra apontar pra tmpdir.
 * `appendFn` é a tentativa ÚNICA de append (injetável pra teste). Sem
 * injeção, `logEvent` usa `appendFileWithRetry` (que já faz o retry com
 * backoff interno). A injeção evita que o teste tenha que simular falhas de
 * I/O de verdade (EISDIR etc.) e permite assertar o comportamento de retry
 * sem depender de `mock.method` contra `node:fs` (que é read-only).
 */
export function logEvent(
  event: RunLogEvent,
  rootDir: string = process.cwd(),
  appendFn: (p: string, d: string) => void = (p, d) =>
    appendFileWithRetry(p, d),
): boolean {
  const persisted = buildLogEvent(event);
  const logPath = resolveRunLogPath(rootDir);
  const payload = JSON.stringify(persisted) + "\n";
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFn(logPath, payload);
    return true;
  } catch (err) {
    // swallow — logging must never mask the original error, nem derrubar o stage
    console.error(
      `[log-event] falha ao gravar em ${resolveRunLogPath(rootDir)}: ${
        err instanceof Error ? err.message : String(err)
      } — evento perdido (warn, não bloqueia)`,
    );
    return false;
  }
}
