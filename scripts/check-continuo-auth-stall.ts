#!/usr/bin/env npx tsx
/**
 * check-continuo-auth-stall.ts (#7647, parte repo-side)
 *
 * Detecção DETERMINÍSTICA de parada dura por auth no contínuo. Em 08/09/2026
 * o contínuo parou 7 ticks em silêncio: o refresh token do Codex foi reusado
 * por outro cliente, o cron do Hermes passou a falhar com 401/403, e nada
 * no repo notava — o `failure_streak` do job subia dentro do `jobs.json` do
 * Hermes e ninguém o lia.
 *
 * **O que este arquivo NÃO faz, e é deliberado:** não lê credencial, não
 * toca `auth.json`, não invoca `hermes auth add|remove`, não mexe no pool de
 * contas. Higiene de pool e política de conta exigem decisão do editor e
 * acesso externo — isso fica registrado como bloqueio, não é executado aqui.
 * Ele lê UM arquivo de estado interno do cron (`jobs.json`) e devolve um
 * veredito; quem alarma é `hermes/scripts/watch-continuo-health.sh`.
 *
 * Uso (o consumidor real é o watch, via `--json`):
 *   npx tsx scripts/check-continuo-auth-stall.ts --json
 *   npx tsx scripts/check-continuo-auth-stall.ts --jobs-path /caminho/jobs.json --json
 *
 * Exit code é SEMPRE 0 (inclusive com `stalled: true`): quem decide o que
 * fazer com o veredito é o watch, que já tem a disciplina fail-soft de
 * distinguir "indeterminado" de "alarme" — um exit≠0 aqui viraria
 * `FAILS+1` no watch e confundiria "detectei parada" com "não consegui
 * detectar".
 *
 * @see hermes/scripts/watch-continuo-health.sh (o consumidor)
 * @see test/check-continuo-auth-stall.test.ts
 */
import { readFileSync } from "node:fs";
import { isMainModule } from "./lib/cli-args.ts";

/** Job do cron do Hermes que roda o tick do contínuo (`hermes cron list`). */
export const CONTINUO_JOB_ID = "5d791ef6fc2c";

/** `jobs.json` do Hermes na máquina onde o cron roda (`helios`). Não é
 *  segredo — é estado do agendador. Parametrizável por argumento porque
 *  hardcodar o path tornava a função intestável e amarrava o módulo a uma
 *  máquina específica (achado do review da PR #7654). */
export const DEFAULT_JOBS_PATH = "/home/vjpixel/.hermes/cron/jobs.json";

/** `failure_streak` a partir do qual uma sequência de falhas deixa de ser
 *  ruído transitório. 2 e não 1 porque uma falha isolada de rede não é
 *  parada dura; 2 e não 5 porque o incidente de 08/09 custou 7 ticks. */
export const AUTH_STALL_STREAK_THRESHOLD = 2;

/** Códigos HTTP que caracterizam parada por AUTH (e não por outra coisa).
 *  Um 500 com streak alto é o Hermes fora do ar, não credencial reusada — o
 *  conserto é outro, então não pode disparar este alarme. */
export const AUTH_STALL_CODES: readonly number[] = [401, 403];

export interface AuthStallResult {
  /** `true` só com evidência POSITIVA das duas condições. Ausência de dado
   *  nunca vira `true` — o alarme abre issue, e alarme falso desse tipo
   *  manda o editor investigar credencial que está boa. */
  stalled: boolean;
  reason: string;
  failureStreak: number | null;
  lastAuthErrorCode: number | null;
  lastAuthErrorReason: string | null;
}

/** `code` pode chegar como número ou string do `jobs.json` — normaliza sem
 *  transformar lixo em número (`parseInt("abc")` é `NaN`, não um código). */
function normalizeCode(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function checkContinuoAuthStall(jobsPath: string = DEFAULT_JOBS_PATH): AuthStallResult {
  let failureStreak: number | null = null;
  let lastAuthErrorCode: number | null = null;
  let lastAuthErrorReason: string | null = null;

  try {
    const data = JSON.parse(readFileSync(jobsPath, "utf8")) as { jobs?: unknown };
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const job = jobs.find((j) => (j as { id?: unknown })?.id === CONTINUO_JOB_ID) as
      | { failure_streak?: unknown; last_auth_error?: unknown }
      | undefined;
    if (!job) {
      return {
        stalled: false,
        reason: `job ${CONTINUO_JOB_ID} não encontrado em ${jobsPath}`,
        failureStreak: null,
        lastAuthErrorCode: null,
        lastAuthErrorReason: null,
      };
    }
    failureStreak = typeof job.failure_streak === "number" ? job.failure_streak : null;
    const err = job.last_auth_error;
    if (err && typeof err === "object") {
      lastAuthErrorCode = normalizeCode((err as { code?: unknown }).code);
      const reason = (err as { reason?: unknown }).reason;
      lastAuthErrorReason = typeof reason === "string" ? reason : null;
    }
  } catch (e) {
    // Fail-soft de propósito: `jobs.json` ausente/ilegível é "não sei", NUNCA
    // "está parado". O watch trata `stalled: false` com este motivo como
    // indeterminado, não como saúde confirmada.
    return {
      stalled: false,
      reason: `jobs.json ilegível (${jobsPath}): ${e instanceof Error ? e.message : String(e)}`,
      failureStreak: null,
      lastAuthErrorCode: null,
      lastAuthErrorReason: null,
    };
  }

  const streakHit = failureStreak !== null && failureStreak >= AUTH_STALL_STREAK_THRESHOLD;
  const codeHit = lastAuthErrorCode !== null && AUTH_STALL_CODES.includes(lastAuthErrorCode);

  if (streakHit && codeHit) {
    return {
      stalled: true,
      reason:
        `parada dura por auth: failure_streak=${failureStreak} (limiar ${AUTH_STALL_STREAK_THRESHOLD}), ` +
        `last_auth_error=${lastAuthErrorCode} (${lastAuthErrorReason ?? "n/a"})`,
      failureStreak,
      lastAuthErrorCode,
      lastAuthErrorReason,
    };
  }

  return {
    stalled: false,
    reason: `sem parada dura por auth: failure_streak=${failureStreak}, auth_code=${lastAuthErrorCode}`,
    failureStreak,
    lastAuthErrorCode,
    lastAuthErrorReason,
  };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const pathIdx = argv.indexOf("--jobs-path");
  const jobsPath = pathIdx >= 0 ? (argv[pathIdx + 1] ?? DEFAULT_JOBS_PATH) : DEFAULT_JOBS_PATH;
  console.log(JSON.stringify(checkContinuoAuthStall(jobsPath)));
}
