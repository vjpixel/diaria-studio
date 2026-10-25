/**
 * threads-personal-token.ts (#10772) — refresh do token de longa duração (60 dias)
 * do Threads PESSOAL do editor. Lógica pura; I/O em
 * `scripts/threads-personal-token-refresh.ts` (task `Diaria-Threads-Personal-Token`).
 *
 * Mesmas regras do refresh do token da diar.ia.br no Worker
 * (`workers/linkedin-cron/src/maintenance.ts`, #9569/#9618): renova a cada 30
 * dias (metade da vida útil); refresh só funciona com o token válido e ≥24h
 * (https://developers.facebook.com/docs/threads/get-started/long-lived-tokens);
 * falha persistente vira alerta a partir de 45 dias de idade (15 dias antes de
 * vencer, enquanto ainda dá pra agir); idade DESCONHECIDA + falha alerta já
 * (conservador, #9758).
 *
 * Por que não no Worker: quem usa este token é um script LOCAL
 * (`publish-shorts.ts`, que lê Doppler/`.env`), e o Worker não escreve no Doppler
 * — o token renovado no KV dele nunca chegaria ao consumidor. O token renovado
 * vai pro Doppler + `.env` por `scripts/lib/secret-persist.ts` (mesmo caminho dos
 * setups de OAuth do LinkedIn pessoal, YouTube e Facebook), com o vencimento em
 * `THREADS_PERSONAL_TOKEN_EXPIRES_AT` (paralelo de `LINKEDIN_PERSONAL_TOKEN_EXPIRES_AT`).
 */

import { refreshThreadsLongLivedToken, type ThreadsFetch } from "./threads-api.ts";
import { THREADS_PERSONAL_ENV } from "./threads-personal-video.ts";

const DAY_MS = 86_400_000;
/** Vida útil de um token de longa duração do Threads. */
export const THREADS_TOKEN_LIFETIME_MS = 60 * DAY_MS;
/** Renova quando faltam ≤ 30 dias (= idade ≥ 30 dias), como `THREADS_REFRESH_AFTER_MS` do Worker. */
export const THREADS_PERSONAL_REFRESH_WHEN_REMAINING_MS = 30 * DAY_MS;
/** Falha com ≤ 15 dias restantes (= idade ≥ 45 dias) alerta, como `THREADS_STALE_ALERT_MS` do Worker. */
export const THREADS_PERSONAL_STALE_WHEN_REMAINING_MS = 15 * DAY_MS;

export type RefreshDecision =
  | { action: "skip_no_token" }
  | { action: "skip_fresh"; remainingDays: number }
  | { action: "expired"; expiresAt: string }
  | { action: "refresh"; remainingMs: number | null };

/** `expiresAt` ausente ou ilegível = idade desconhecida → tenta renovar. */
export function decideThreadsPersonalRefresh(input: { accessToken: string | undefined; expiresAt: string | undefined; now: Date }): RefreshDecision {
  if (!input.accessToken?.trim()) return { action: "skip_no_token" };
  const exp = input.expiresAt ? Date.parse(input.expiresAt) : NaN;
  if (!Number.isFinite(exp)) return { action: "refresh", remainingMs: null };
  const remaining = exp - input.now.getTime();
  if (remaining <= 0) return { action: "expired", expiresAt: new Date(exp).toISOString() };
  if (remaining > THREADS_PERSONAL_REFRESH_WHEN_REMAINING_MS) return { action: "skip_fresh", remainingDays: Math.floor(remaining / DAY_MS) };
  return { action: "refresh", remainingMs: remaining };
}

export interface RefreshRunDeps {
  env: Record<string, string | undefined>;
  now: () => Date;
  fetch?: ThreadsFetch;
  /** Grava os segredos (Doppler + `.env`); devolve os nomes que falharam no Doppler. */
  persist: (secrets: Record<string, string>) => { dopplerFailed: string[]; dopplerErrors: string[] };
}

export interface RefreshRunResult {
  /** 0 = ok/skip/falha transitória; 1 = precisa de ação do editor. */
  exitCode: 0 | 1;
  outcome: "skipped" | "refreshed" | "failed" | "expired";
  message: string;
}

/**
 * Uma execução da task. Nunca imprime nem devolve o token. Exit 1 quando o
 * editor precisa agir: token vencido, falha com o token ≥45 dias ou de idade
 * desconhecida, ou Doppler recusou a gravação (o `.env` desta máquina tem o
 * token novo, mas o próximo `sync-env` de outra máquina traria o velho).
 */
export async function runThreadsPersonalTokenRefresh(deps: RefreshRunDeps): Promise<RefreshRunResult> {
  const now = deps.now();
  const decision = decideThreadsPersonalRefresh({
    accessToken: deps.env[THREADS_PERSONAL_ENV.accessToken],
    expiresAt: deps.env[THREADS_PERSONAL_ENV.expiresAt],
    now,
  });
  if (decision.action === "skip_no_token") {
    return { exitCode: 0, outcome: "skipped", message: `${THREADS_PERSONAL_ENV.accessToken} ausente — nada a renovar (Doppler diaria-studio/dev)` };
  }
  if (decision.action === "skip_fresh") {
    return { exitCode: 0, outcome: "skipped", message: `token ainda com ${decision.remainingDays} dias — renova quando faltarem 30` };
  }
  if (decision.action === "expired") {
    return {
      exitCode: 1,
      outcome: "expired",
      message: `token do Threads pessoal venceu em ${decision.expiresAt} — refresh não recupera token vencido; gere outro (passo a passo na #10772)`,
    };
  }
  const r = await refreshThreadsLongLivedToken(deps.env[THREADS_PERSONAL_ENV.accessToken]!.trim(), deps.fetch);
  if (!r.ok) {
    const remaining = decision.remainingMs;
    const stale = remaining === null || remaining <= THREADS_PERSONAL_STALE_WHEN_REMAINING_MS;
    const ageText = remaining === null ? "idade desconhecida (sem THREADS_PERSONAL_TOKEN_EXPIRES_AT)" : `faltam ${Math.floor(remaining / DAY_MS)} dias para vencer`;
    return {
      exitCode: stale ? 1 : 0,
      outcome: "failed",
      message:
        `refresh do token do Threads pessoal falhou (${r.reason}); ${ageText}.` +
        (stale ? " Renove à mão antes que vença (passo a passo na #10772)." : " Tenta de novo na próxima execução."),
    };
  }
  const lifetimeMs = r.expiresInSeconds !== null ? r.expiresInSeconds * 1000 : THREADS_TOKEN_LIFETIME_MS;
  const expiresAt = new Date(now.getTime() + lifetimeMs).toISOString();
  const persisted = deps.persist({ [THREADS_PERSONAL_ENV.accessToken]: r.accessToken, [THREADS_PERSONAL_ENV.expiresAt]: expiresAt });
  if (persisted.dopplerFailed.length > 0) {
    return {
      exitCode: 1,
      outcome: "refreshed",
      message:
        `token renovado (vence ${expiresAt}) e gravado no .env, mas o Doppler recusou ${persisted.dopplerFailed.join(", ")}` +
        (persisted.dopplerErrors.length ? ` (${persisted.dopplerErrors.join("; ")})` : "") +
        ` — sem o Doppler as outras máquinas ficam com o token antigo`,
    };
  }
  return { exitCode: 0, outcome: "refreshed", message: `token renovado; vence ${expiresAt}` };
}
