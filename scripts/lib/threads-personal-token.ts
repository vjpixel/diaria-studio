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
 * (conservador, #9758). Recusa "<24h" da Meta não alerta (o token é novo), como
 * o Worker.
 *
 * Por que não no Worker: o consumidor previsto deste token é um script LOCAL
 * (`publish-shorts.ts`, que lê Doppler/`.env`, quando a integração do destino
 * `threads_profile` entrar), e o Worker não escreve no Doppler — o token
 * renovado no KV dele nunca chegaria ao consumidor. O token renovado vai pro
 * Doppler + `.env` por `scripts/lib/secret-persist.ts` (mesmo caminho dos
 * setups de OAuth do LinkedIn pessoal, YouTube e Facebook), com o vencimento em
 * `THREADS_PERSONAL_TOKEN_EXPIRES_AT` (paralelo de `LINKEDIN_PERSONAL_TOKEN_EXPIRES_AT`,
 * que também vai pro Doppler — nunca só pro `.env`, senão o `sync-env` aborta
 * com `LocalOnlyEnvKeysError`).
 *
 * Onde roda: na máquina com o Doppler CLI autenticado com escrita — o `300`,
 * onde a task está armada desde 27/10/2026 (#11077 verificou o CLI lá).
 *
 * Doppler fora de sincronia: se a gravação no Doppler falhar, o `.env` local
 * fica com o token novo e o vault com o velho. Um marcador persistente
 * (`data/threads-personal/doppler-out-of-sync.json`) mantém a task saindo 1 em
 * TODA execução seguinte — re-tentando gravar no Doppler os valores atuais do
 * `.env` — até uma gravação dar certo, nunca só no dia da falha.
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
/** Caminho do marcador de Doppler fora de sincronia, relativo a `data/`. */
export const THREADS_PERSONAL_DOPPLER_MARKER = "threads-personal/doppler-out-of-sync.json";

export type RefreshDecision =
  | { action: "skip_no_token" }
  | { action: "skip_fresh"; remainingDays: number }
  | { action: "expired"; expiresAt: string }
  | { action: "refresh"; token: string; remainingMs: number | null };

/** `expiresAt` ausente ou ilegível = idade desconhecida → tenta renovar. */
export function decideThreadsPersonalRefresh(input: { accessToken: string | undefined; expiresAt: string | undefined; now: Date }): RefreshDecision {
  const token = input.accessToken?.trim();
  if (!token) return { action: "skip_no_token" };
  const exp = input.expiresAt ? Date.parse(input.expiresAt) : NaN;
  if (!Number.isFinite(exp)) return { action: "refresh", token, remainingMs: null };
  const remaining = exp - input.now.getTime();
  if (remaining <= 0) return { action: "expired", expiresAt: new Date(exp).toISOString() };
  if (remaining > THREADS_PERSONAL_REFRESH_WHEN_REMAINING_MS) return { action: "skip_fresh", remainingDays: Math.floor(remaining / DAY_MS) };
  return { action: "refresh", token, remainingMs: remaining };
}

export interface DopplerOutOfSyncMarker {
  since: string;
  keys: string[];
  errors: string[];
}

export interface RefreshRunDeps {
  env: Record<string, string | undefined>;
  now: () => Date;
  fetch?: ThreadsFetch;
  /** Grava os segredos (Doppler + `.env`); devolve os nomes que falharam no Doppler. */
  persist: (secrets: Record<string, string>) => { dopplerFailed: string[]; dopplerErrors: string[] };
  /** Marcador persistente de Doppler fora de sincronia. Ausente = sem rastreio entre execuções (só em teste). */
  marker?: {
    read: () => DopplerOutOfSyncMarker | null;
    write: (m: DopplerOutOfSyncMarker) => void;
    clear: () => void;
  };
}

export interface RefreshRunResult {
  /** 0 = ok/skip/falha transitória; 1 = precisa de ação do editor. */
  exitCode: 0 | 1;
  outcome: "skipped" | "refreshed" | "failed" | "expired" | "doppler_out_of_sync";
  message: string;
}

const HOW_TO_FIX_DOPPLER =
  "rode numa máquina com o Doppler CLI autenticado com escrita em diaria-studio/dev (o 300 ou a do editor): " +
  "npx tsx scripts/threads-personal-token-refresh.ts, ou grave à mão com doppler secrets set. " +
  "Enquanto THREADS_PERSONAL_TOKEN_EXPIRES_AT existir só no .env, o npm run sync-env aborta com LocalOnlyEnvKeysError";

/**
 * Uma execução da task. Nunca imprime nem devolve o token. Exit 1 quando o
 * editor precisa agir: token vencido, falha com o token ≥45 dias ou de idade
 * desconhecida, token ausente com o user id configurado, ou Doppler fora de
 * sincronia (nesta execução ou numa anterior ainda não resolvida).
 */
export async function runThreadsPersonalTokenRefresh(deps: RefreshRunDeps): Promise<RefreshRunResult> {
  const base = await runOnce(deps);
  if (base.wroteDoppler === "ok") {
    deps.marker?.clear();
    return base.result;
  }
  if (base.wroteDoppler === "failed") {
    const prev = deps.marker?.read();
    deps.marker?.write({ since: prev?.since ?? deps.now().toISOString(), keys: base.failedKeys, errors: base.failedErrors });
    return base.result;
  }
  // Nada foi gravado nesta execução: se uma anterior deixou o Doppler fora de sincronia, re-tenta com o .env atual.
  const marker = deps.marker?.read();
  if (!marker) return base.result;
  const token = deps.env[THREADS_PERSONAL_ENV.accessToken]?.trim();
  if (!token) return base.result;
  const secrets: Record<string, string> = { [THREADS_PERSONAL_ENV.accessToken]: token };
  const exp = deps.env[THREADS_PERSONAL_ENV.expiresAt]?.trim();
  if (exp) secrets[THREADS_PERSONAL_ENV.expiresAt] = exp;
  const r = deps.persist(secrets);
  if (r.dopplerFailed.length === 0) {
    deps.marker?.clear();
    return { ...base.result, message: `${base.result.message}; Doppler re-sincronizado (fora de sincronia desde ${marker.since})` };
  }
  deps.marker?.write({ since: marker.since, keys: r.dopplerFailed, errors: r.dopplerErrors });
  return {
    exitCode: 1,
    outcome: base.result.exitCode === 1 ? base.result.outcome : "doppler_out_of_sync",
    message:
      `${base.result.message}; o Doppler segue com o token antigo desde ${marker.since} — nova gravação recusou ` +
      `${r.dopplerFailed.join(", ")}${r.dopplerErrors.length ? ` (${r.dopplerErrors.join("; ")})` : ""}. ${HOW_TO_FIX_DOPPLER}`,
  };
}

type RunOnce = { result: RefreshRunResult; wroteDoppler: "none" } | { result: RefreshRunResult; wroteDoppler: "ok" } | { result: RefreshRunResult; wroteDoppler: "failed"; failedKeys: string[]; failedErrors: string[] };

async function runOnce(deps: RefreshRunDeps): Promise<RunOnce> {
  const now = deps.now();
  const decision = decideThreadsPersonalRefresh({
    accessToken: deps.env[THREADS_PERSONAL_ENV.accessToken],
    expiresAt: deps.env[THREADS_PERSONAL_ENV.expiresAt],
    now,
  });
  if (decision.action === "skip_no_token") {
    if (deps.env[THREADS_PERSONAL_ENV.userId]?.trim()) {
      return {
        wroteDoppler: "none",
        result: {
          exitCode: 1,
          outcome: "failed",
          message:
            `${THREADS_PERSONAL_ENV.userId} está configurado mas ${THREADS_PERSONAL_ENV.accessToken} está ausente neste host — ` +
            `o token existe no Doppler diaria-studio/dev e não chegou aqui (rode npm run sync-env), ou foi apagado`,
        },
      };
    }
    return { wroteDoppler: "none", result: { exitCode: 0, outcome: "skipped", message: `${THREADS_PERSONAL_ENV.accessToken} ausente — nada a renovar (Doppler diaria-studio/dev)` } };
  }
  if (decision.action === "skip_fresh") {
    return { wroteDoppler: "none", result: { exitCode: 0, outcome: "skipped", message: `token ainda com ${decision.remainingDays} dias — renova quando faltarem 30` } };
  }
  if (decision.action === "expired") {
    return {
      wroteDoppler: "none",
      result: {
        exitCode: 1,
        outcome: "expired",
        message: `token do Threads pessoal venceu em ${decision.expiresAt} — refresh não recupera token vencido; gere outro (passo a passo na #10772)`,
      },
    };
  }
  const r = await refreshThreadsLongLivedToken(decision.token, deps.fetch);
  if (!r.ok) {
    if (r.tooYoung) {
      return {
        wroteDoppler: "none",
        result: {
          exitCode: 0,
          outcome: "failed",
          message:
            `a Meta recusou o refresh por o token ter menos de 24h (${r.reason}) — é um token novo, nada a fazer; ` +
            `grave ${THREADS_PERSONAL_ENV.expiresAt} no Doppler para a task parar de tentar antes da hora`,
        },
      };
    }
    const remaining = decision.remainingMs;
    const stale = remaining === null || remaining <= THREADS_PERSONAL_STALE_WHEN_REMAINING_MS;
    const ageText = remaining === null ? `idade desconhecida (sem ${THREADS_PERSONAL_ENV.expiresAt})` : `faltam ${Math.floor(remaining / DAY_MS)} dias para vencer`;
    return {
      wroteDoppler: "none",
      result: {
        exitCode: stale ? 1 : 0,
        outcome: "failed",
        message:
          `refresh do token do Threads pessoal falhou (${r.reason}); ${ageText}.` +
          (stale ? " Renove à mão antes que vença (passo a passo na #10772)." : " Tenta de novo na próxima execução."),
      },
    };
  }
  const lifetimeMs = r.expiresInSeconds !== null ? r.expiresInSeconds * 1000 : THREADS_TOKEN_LIFETIME_MS;
  const expiresAt = new Date(now.getTime() + lifetimeMs).toISOString();
  const persisted = deps.persist({ [THREADS_PERSONAL_ENV.accessToken]: r.accessToken, [THREADS_PERSONAL_ENV.expiresAt]: expiresAt });
  if (persisted.dopplerFailed.length > 0) {
    return {
      wroteDoppler: "failed",
      failedKeys: persisted.dopplerFailed,
      failedErrors: persisted.dopplerErrors,
      result: {
        exitCode: 1,
        outcome: "refreshed",
        message:
          `token renovado (vence ${expiresAt}) e gravado no .env, mas o Doppler recusou ${persisted.dopplerFailed.join(", ")}` +
          (persisted.dopplerErrors.length ? ` (${persisted.dopplerErrors.join("; ")})` : "") +
          ` — sem o Doppler as outras máquinas ficam com o token antigo; a task segue saindo 1 até o Doppler aceitar. ${HOW_TO_FIX_DOPPLER}`,
      },
    };
  }
  return { wroteDoppler: "ok", result: { exitCode: 0, outcome: "refreshed", message: `token renovado; vence ${expiresAt}` } };
}
