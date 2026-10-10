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

/** `jobs.json` do Hermes na máquina onde o cron roda (`300`). Não é
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

/** Assinaturas de parada por COTA no texto de `last_error` do job (#10001).
 *  Em 10/10/2026 o contínuo acumulou `failure_streak=22` com
 *  `last_auth_error` ausente (`auth_code=null`) e a checagem deu `ok`: o
 *  erro real estava só em `last_error` como texto livre. Dois formatos
 *  observados ao vivo no `300`:
 *  - OpenRouter: `RuntimeError: HTTP 403: Key limit exceeded (daily limit). …`
 *  - Codex: `Error code: 429 - {'error': {'type': 'usage_limit_reached', …`
 *  Cada regra exige o CÓDIGO e a FRASE juntos — um 403 genérico ou um 429
 *  de rate limit transitório não casam, porque o conserto deles é outro. */
export const QUOTA_STALL_PATTERNS: readonly { code: number; pattern: RegExp; label: string }[] = [
  { code: 403, pattern: /\b403\b[\s\S]*key limit exceeded/i, label: "OpenRouter key limit exceeded" },
  { code: 429, pattern: /\b429\b[\s\S]*usage_limit_reached/i, label: "Codex usage_limit_reached" },
];

/** Classifica o texto de `last_error` como parada por cota, ou `null`. */
export function classifyQuotaError(lastError: unknown): { code: number; label: string } | null {
  if (typeof lastError !== "string" || lastError === "") return null;
  for (const { code, pattern, label } of QUOTA_STALL_PATTERNS) {
    if (pattern.test(lastError)) return { code, label };
  }
  return null;
}

export interface AuthStallResult {
  /** `true` só com evidência POSITIVA das duas condições. Ausência de dado
   *  nunca vira `true` — o alarme abre issue, e alarme falso desse tipo
   *  manda o editor investigar credencial que está boa. */
  stalled: boolean;
  /** `"auth"` (401/403 em `last_auth_error`), `"quota"` (cota esgotada lida
   *  de `last_error`, #10001) ou `null` quando não há parada. */
  stallKind: "auth" | "quota" | null;
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
  let quota: { code: number; label: string } | null = null;

  try {
    const data = JSON.parse(readFileSync(jobsPath, "utf8")) as { jobs?: unknown };
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const job = jobs.find((j) => (j as { id?: unknown })?.id === CONTINUO_JOB_ID) as
      | { failure_streak?: unknown; last_auth_error?: unknown; last_error?: unknown }
      | undefined;
    if (!job) {
      return {
        stalled: false,
        stallKind: null,
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
    quota = classifyQuotaError(job.last_error);
  } catch (e) {
    // Fail-soft de propósito: `jobs.json` ausente/ilegível é "não sei", NUNCA
    // "está parado". O watch trata `stalled: false` com este motivo como
    // indeterminado, não como saúde confirmada.
    return {
      stalled: false,
      stallKind: null,
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
      stallKind: "auth",
      reason:
        `parada dura por auth: failure_streak=${failureStreak} (limiar ${AUTH_STALL_STREAK_THRESHOLD}), ` +
        `last_auth_error=${lastAuthErrorCode} (${lastAuthErrorReason ?? "n/a"})`,
      failureStreak,
      lastAuthErrorCode,
      lastAuthErrorReason,
    };
  }

  // Cota esgotada (#10001): mesma exigência de streak, mas o código vem do
  // texto de `last_error`. Só depois do ramo de auth — com as duas presentes,
  // credencial inválida é o diagnóstico mais específico.
  if (streakHit && quota) {
    return {
      stalled: true,
      stallKind: "quota",
      reason:
        `parada dura por cota: failure_streak=${failureStreak} (limiar ${AUTH_STALL_STREAK_THRESHOLD}), ` +
        `last_error=${quota.code} (${quota.label})`,
      failureStreak,
      lastAuthErrorCode: quota.code,
      lastAuthErrorReason: quota.label,
    };
  }

  return {
    stalled: false,
    stallKind: null,
    reason: `sem parada dura por auth/cota: failure_streak=${failureStreak}, auth_code=${lastAuthErrorCode}`,
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
