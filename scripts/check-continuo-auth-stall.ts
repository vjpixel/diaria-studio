// check-continuo-auth-stall.ts — detecção determinística de parada dura por
// auth no contínuo (issue #7647, parte repo-side: alarme + teste).
// NÃO lê credenciais, NÃO toca auth.json, NÃO decide política de conta.
// Lê apenas o jobs.json do cron (estado interno do hermes, não secrets).
// Registra bloqueio honesto se auth.json / hermes auth não estiver disponível.

import fs from 'fs';

const JOB_ID = '5d791ef6fc2c';
const JOBS_PATH = '/home/vjpixel/.hermes/cron/jobs.json';

export interface AuthStallResult {
  stalled: boolean;
  reason: string;
  failureStreak: number | null;
  lastAuthErrorCode: number | null;
  lastAuthErrorReason: string | null;
}

export function checkContinuoAuthStall(): AuthStallResult {
  let failureStreak: number | null = null;
  let lastAuthErrorCode: number | null = null;
  let lastAuthErrorReason: string | null = null;

  try {
    const raw = fs.readFileSync(JOBS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const job = jobs.find((j: any) => j?.id === JOB_ID);
    if (!job) {
      return { stalled: false, reason: 'job nao encontrado', failureStreak: null, lastAuthErrorCode: null, lastAuthErrorReason: null };
    }
    failureStreak = typeof job.failure_streak === 'number' ? job.failure_streak : null;
    const err = job.last_auth_error;
    if (err && typeof err === 'object') {
      lastAuthErrorCode = typeof err.code === 'number' ? err.code : (typeof err.code === 'string' ? parseInt(err.code, 10) : null);
      lastAuthErrorReason = err.reason ?? null;
    }
  } catch {
    return { stalled: false, reason: 'jobs.json ilegivel', failureStreak: null, lastAuthErrorCode: null, lastAuthErrorReason: null };
  }

  // Parada dura por auth: streak >= 2 + erro explicito de 401/403
  const authHardStop = (failureStreak !== null && failureStreak >= 2) &&
    (lastAuthErrorCode === 401 || lastAuthErrorCode === 403);

  if (authHardStop) {
    return {
      stalled: true,
      reason: `parada dura por auth: failure_streak=${failureStreak}, last_auth_error=${lastAuthErrorCode} (${lastAuthErrorReason ?? 'n/a'})`,
      failureStreak,
      lastAuthErrorCode,
      lastAuthErrorReason,
    };
  }

  return {
    stalled: false,
    reason: `streak=${failureStreak}, auth_code=${lastAuthErrorCode}`,
    failureStreak,
    lastAuthErrorCode,
    lastAuthErrorReason,
  };
}
