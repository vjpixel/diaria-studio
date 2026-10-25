/**
 * threads-personal-video.ts (#10772) — vídeo vertical da edição no Threads
 * PESSOAL do editor (destino `threads_profile` de `_internal/06-shorts-published.json`).
 *
 * Fluxo oficial da Threads API (https://developers.facebook.com/docs/threads/posts):
 *   1. `POST /{threads-user-id}/threads` com `media_type=VIDEO`, `video_url`
 *      PÚBLICO (o mesmo `-short.mp4` que o `publish-shorts.ts` sobe pro R2) e `text`;
 *   2. espera o container sair de `IN_PROGRESS` (`GET /{container-id}?fields=status,error_message`;
 *      a Meta recomenda ~30 s e consultar 1x/min por até 5 min);
 *   3. `POST /{threads-user-id}/threads_publish` com `creation_id`.
 * Cliente HTTP compartilhado com os posts da diar.ia.br: `scripts/lib/threads-api.ts`.
 *
 * Credenciais (Doppler `diaria-studio/dev` → `npm run sync-env`), mesmo padrão de
 * `LINKEDIN_PERSONAL_*`: `THREADS_PERSONAL_ACCESS_TOKEN` (longa duração, 60 dias,
 * renovado por `scripts/threads-personal-token-refresh.ts`) e `THREADS_PERSONAL_USER_ID`.
 * Ausentes → o destino é pulado (fail-soft), com aviso nomeando as vars.
 *
 * O repost pela conta da diar.ia.br não está aqui: a Threads API pública não
 * documenta repost; segue manual (passo guiado).
 *
 * Ainda SEM validação real: o token pessoal não existe (comentários de 23/10 e
 * 25/10/2026 na #10772). Integração em `publish-shorts.ts` fica para quando ele existir.
 */

import { THREADS_API_VERSION, ThreadsApiError, createThreadsContainer, fetchThreadsPermalink, publishThreadsContainer, waitForThreadsContainer, type ThreadsFetch } from "./threads-api.ts";
import type { ShortPublishedEntry } from "./diaria/short-video.ts";

export const THREADS_PROFILE_DESTINATION = "threads_profile";

export const THREADS_PERSONAL_ENV = {
  accessToken: "THREADS_PERSONAL_ACCESS_TOKEN",
  userId: "THREADS_PERSONAL_USER_ID",
  /** ISO de vencimento, gravado pelo refresh (opcional; ausente = idade desconhecida). */
  expiresAt: "THREADS_PERSONAL_TOKEN_EXPIRES_AT",
} as const;

/** Espera inicial antes do 1º poll (recomendação da Meta: ~30 s em média). */
export const THREADS_VIDEO_INITIAL_WAIT_MS = 30_000;
/** Intervalo entre polls do container de vídeo. */
export const THREADS_VIDEO_POLL_INTERVAL_MS = 30_000;
/** Polls do container de vídeo: 10 × 30 s = 5 min, o teto que a Meta recomenda. */
export const THREADS_VIDEO_POLL_ATTEMPTS = 10;

export interface ThreadsPersonalCreds {
  accessToken: string;
  userId: string;
  apiVersion: string;
}

export type ThreadsPersonalCredsResult = { ready: true; creds: ThreadsPersonalCreds } | { ready: false; reason: string };

/** Lê as credenciais do Threads pessoal. Ausentes → `ready: false` com a mensagem de skip. */
export function readThreadsPersonalCreds(env: Record<string, string | undefined>): ThreadsPersonalCredsResult {
  const accessToken = (env[THREADS_PERSONAL_ENV.accessToken] ?? "").trim();
  const userId = (env[THREADS_PERSONAL_ENV.userId] ?? "").trim();
  const missing = [!accessToken && THREADS_PERSONAL_ENV.accessToken, !userId && THREADS_PERSONAL_ENV.userId].filter(Boolean);
  if (missing.length > 0) {
    return {
      ready: false,
      reason:
        `threads_profile pulado: ${missing.join(" e ")} ausente(s). Gere o token da conta pessoal ` +
        `(passo a passo na #10772), grave no Doppler diaria-studio/dev e rode npm run sync-env.`,
    };
  }
  return { ready: true, creds: { accessToken, userId, apiVersion: env.THREADS_API_VERSION?.trim() || THREADS_API_VERSION } };
}

export interface ThreadsVideoDeps {
  fetch?: ThreadsFetch;
  sleep?: (ms: number) => Promise<void>;
  now: () => Date;
}

export interface ThreadsVideoOutcome {
  entry: ShortPublishedEntry;
  warnings?: string[];
}

/**
 * Publica o vertical no Threads pessoal. Falha ANTES do publish (container,
 * processamento `ERROR`/`EXPIRED`/timeout, 4xx no publish) lança: nada saiu no
 * perfil e dá pra tentar de novo. Envio AMBÍGUO no `threads_publish` (rede/timeout
 * ou 5xx — a Meta pode ter publicado) volta como `send_unknown`, mesmo contrato
 * do `linkedin_profile`: conta como feito e a rodada seguinte não re-posta.
 */
export async function publishThreadsProfileVideo(args: {
  creds: ThreadsPersonalCreds;
  videoUrl: string;
  text: string;
  deps: ThreadsVideoDeps;
}): Promise<ThreadsVideoOutcome> {
  const { creds, videoUrl, text, deps } = args;
  if (!/^https:\/\//.test(videoUrl)) throw new Error(`threads_profile: video_url precisa ser https público (recebido: ${videoUrl.slice(0, 80)})`);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const containerId = await createThreadsContainer(creds.userId, creds.accessToken, { mediaType: "VIDEO", text, videoUrl }, creds.apiVersion, deps.fetch);
  await sleep(THREADS_VIDEO_INITIAL_WAIT_MS);
  await waitForThreadsContainer(containerId, creds.accessToken, creds.apiVersion, {
    maxAttempts: THREADS_VIDEO_POLL_ATTEMPTS,
    intervalMs: THREADS_VIDEO_POLL_INTERVAL_MS,
    onTimeout: "throw",
    sleep,
    fetchFn: deps.fetch,
  });
  let mediaId: string;
  try {
    mediaId = await publishThreadsContainer(creds.userId, creds.accessToken, containerId, creds.apiVersion, deps.fetch);
  } catch (e) {
    const ambiguous = e instanceof ThreadsApiError && (e.status === null || e.status >= 500);
    if (!ambiguous) throw e;
    const at = deps.now().toISOString();
    return {
      entry: { destination: THREADS_PROFILE_DESTINATION, status: "send_unknown", id: `send_unknown-${at}`, scheduled_at: null, at },
      warnings: [
        `envio ambíguo no threads_publish (${e.message}; container ${containerId}) — confira o perfil antes de qualquer nova tentativa e registre com --mark ${THREADS_PROFILE_DESTINATION}=URL`,
      ],
    };
  }
  const url = await fetchThreadsPermalink(mediaId, creds.accessToken, creds.apiVersion, deps.fetch);
  const at = deps.now().toISOString();
  return {
    entry: { destination: THREADS_PROFILE_DESTINATION, status: "published", id: mediaId, ...(url ? { url } : {}), scheduled_at: null, at },
    ...(url ? {} : { warnings: ["o Threads publicou mas não devolveu o permalink — confira o perfil"] }),
  };
}
