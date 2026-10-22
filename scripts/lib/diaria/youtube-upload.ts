/**
 * scripts/lib/diaria/youtube-upload.ts (#10659)
 *
 * Upload REAL do vídeo diário no `@diariabr` (YouTube Data API v3), usado por
 * `scripts/publish-youtube.ts --upload`. Toda a rede passa por `deps.fetch`
 * (injetável), então os testes cobrem o fluxo inteiro com fetch mockado.
 *
 * Sequência:
 *   1. refresh token → access token (`oauth2.googleapis.com/token`), com o
 *      MESMO client OAuth do `youtube-oauth-setup.ts` (PR #10757) e o
 *      `YOUTUBE_REFRESH_TOKEN` que ele grava. Este módulo não muda o fluxo de
 *      auth, só consome o token;
 *   2. `channels.list?mine=true` — confere que o token é do canal esperado
 *      (`YOUTUBE_CHANNEL_ID`) ANTES de subir qualquer byte;
 *   3. `videos.insert` resumable: POST de início (metadados + status com
 *      `privacyStatus`/`publishAt` do plano) → `Location` → PUT dos bytes;
 *   4. `thumbnails.set` com a capa — falha aqui NÃO desfaz o vídeo, só vira
 *      `thumbnail.ok = false` no resultado;
 *   5. releitura de `videos.list?part=status` e normalização por
 *      `resolveYouTubeState` (#573) — o estado relatado é o RELIDO, nunca o
 *      pedido. Sem a auditoria do YouTube API Services o YouTube trava o
 *      vídeo em `private` e a releitura mostra isso ("draft").
 *
 * Erros saem como `YouTubeUploadError` com mensagem curta e acionável, sem
 * token nem stack trace. A mensagem nunca inclui o access/refresh token.
 */

import { resolveYouTubeState, type PublishState } from "../publish-state.ts";
import type { YouTubeInsertRequest } from "./youtube-video.ts";
import { YOUTUBE_THUMBNAIL_ENDPOINT } from "./youtube-video.ts";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

/** Registro do upload, em `_internal/` da edição. */
export const YOUTUBE_PUBLISHED_FILE = "_internal/05-youtube-published.json";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface YouTubeUploadDeps {
  fetch: FetchLike;
  now: () => Date;
}

export const defaultYouTubeUploadDeps: YouTubeUploadDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  now: () => new Date(),
};

export class YouTubeUploadError extends Error {
  constructor(
    message: string,
    /** Etapa em que falhou — o vídeo só existe a partir de `thumbnail`. */
    readonly step: "token" | "channel" | "insert" | "upload",
  ) {
    super(message);
    this.name = "YouTubeUploadError";
  }
}

export interface YouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Canal esperado (`YOUTUBE_CHANNEL_ID`); vazio = não confere. */
  channelId: string;
}

/** Variáveis exigidas pelo upload; devolve as ausentes (só nomes, nunca valores). */
export function missingYouTubeCredentials(env: Record<string, string | undefined>): string[] {
  return ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN", "YOUTUBE_CHANNEL_ID"].filter(
    (k) => !(env[k] ?? "").trim(),
  );
}

/** Buffer → corpo de fetch sem copiar os bytes (o vídeo pode ter centenas de MB). */
function asBody(buf: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.length);
}

/** Lê um trecho do corpo de erro sem estourar (e sem nunca ecoar o request). */
async function errorSnippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Explica falhas de `videos.insert`/`thumbnails.set`/token sem expor nada
 * sensível. Cobre os motivos que o editor consegue resolver sozinho.
 */
export function explainYouTubeUploadError(status: number, body: string): string {
  if (/invalid_grant/i.test(body)) {
    return "refresh token do YouTube inválido ou expirado — rode `npx tsx scripts/youtube-oauth-setup.ts` de novo (e `npm run sync-env` no 300)";
  }
  if (status === 401) {
    return "o YouTube recusou o token (401) — refaça o consentimento com `npx tsx scripts/youtube-oauth-setup.ts`";
  }
  if (status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(body)) {
    return "quota diária da YouTube Data API esgotada (upload custa 1.600 de 10.000 unidades) — tente amanhã ou suba à mão no Studio";
  }
  if (status === 403 && /uploadLimitExceeded/i.test(body)) {
    return "o canal atingiu o limite de uploads do YouTube — suba à mão no Studio mais tarde";
  }
  if (status === 403 && /insufficientPermissions|insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body)) {
    return "token sem o escopo youtube.upload — refaça o consentimento deixando os 2 escopos marcados (`scripts/youtube-oauth-setup.ts`)";
  }
  if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(body)) {
    return "YouTube Data API v3 não está ativada no projeto GCP do client OAuth";
  }
  if (status === 403 && /forbidden/i.test(body)) {
    return "o YouTube recusou (403 forbidden) — para capa customizada o canal precisa estar verificado (youtube.com/verify)";
  }
  return `YouTube API respondeu ${status}: ${body.slice(0, 300)}`;
}

/** Troca o refresh token por um access token. */
export async function refreshYouTubeAccessToken(deps: YouTubeUploadDeps, creds: YouTubeCredentials): Promise<string> {
  let res: Response;
  try {
    res = await deps.fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (e) {
    throw new YouTubeUploadError(`sem rede para renovar o token do YouTube: ${(e as Error).message}`, "token");
  }
  if (!res.ok) throw new YouTubeUploadError(explainYouTubeUploadError(res.status, await errorSnippet(res)), "token");
  const json = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!json || typeof json.access_token !== "string" || !json.access_token) {
    throw new YouTubeUploadError("a troca do refresh token não devolveu access_token", "token");
  }
  return json.access_token;
}

/** Confere que o token pertence ao canal esperado antes de subir qualquer byte. */
export async function assertExpectedChannel(deps: YouTubeUploadDeps, token: string, expectedChannelId: string): Promise<void> {
  if (!expectedChannelId) return;
  const res = await deps.fetch(`${YOUTUBE_API_BASE}/channels?part=id&mine=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new YouTubeUploadError(explainYouTubeUploadError(res.status, await errorSnippet(res)), "channel");
  const json = (await res.json().catch(() => null)) as { items?: Array<{ id?: unknown }> } | null;
  const ids = (json?.items ?? []).map((i) => i.id).filter((id): id is string => typeof id === "string");
  if (!ids.includes(expectedChannelId)) {
    throw new YouTubeUploadError(
      `o token não é do canal esperado (YOUTUBE_CHANNEL_ID=${expectedChannelId}; token vê ${ids.join(", ") || "nenhum canal"}) — nada foi enviado`,
      "channel",
    );
  }
}

/** POST de início do resumable upload; devolve a URL de sessão (`Location`). */
export async function startResumableUpload(deps: YouTubeUploadDeps, token: string, request: YouTubeInsertRequest): Promise<string> {
  const res = await deps.fetch(request.url, {
    method: request.method,
    headers: { ...request.headers, Authorization: `Bearer ${token}` },
    body: JSON.stringify(request.body),
  });
  if (!res.ok) throw new YouTubeUploadError(explainYouTubeUploadError(res.status, await errorSnippet(res)), "insert");
  const location = res.headers.get("location");
  if (!location) throw new YouTubeUploadError("videos.insert não devolveu a URL de upload (header Location)", "insert");
  return location;
}

export interface UploadedVideoResource {
  id: string;
  snippet?: { channelId?: string; title?: string };
  status?: { uploadStatus?: string; privacyStatus?: string; publishAt?: string | null };
}

/** PUT dos bytes na sessão resumable; devolve o resource `videos` criado. */
export async function putVideoBytes(
  deps: YouTubeUploadDeps,
  token: string,
  sessionUrl: string,
  file: Buffer,
  contentType: string,
): Promise<UploadedVideoResource> {
  let res: Response;
  try {
    res = await deps.fetch(sessionUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType, "Content-Length": String(file.length) },
      body: asBody(file),
    });
  } catch (e) {
    throw new YouTubeUploadError(`envio dos bytes do vídeo falhou (rede): ${(e as Error).message}`, "upload");
  }
  if (!res.ok) throw new YouTubeUploadError(explainYouTubeUploadError(res.status, await errorSnippet(res)), "upload");
  const json = (await res.json().catch(() => null)) as UploadedVideoResource | null;
  if (!json || typeof json.id !== "string" || !json.id) {
    throw new YouTubeUploadError("o upload terminou sem devolver o id do vídeo — confira no YouTube Studio antes de tentar de novo", "upload");
  }
  return json;
}

/** `thumbnails.set` com a capa JPEG. */
export async function setThumbnail(deps: YouTubeUploadDeps, token: string, videoId: string, jpeg: Buffer): Promise<void> {
  const res = await deps.fetch(`${YOUTUBE_THUMBNAIL_ENDPOINT}?videoId=${encodeURIComponent(videoId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg", "Content-Length": String(jpeg.length) },
    body: asBody(jpeg),
  });
  if (!res.ok) throw new Error(explainYouTubeUploadError(res.status, await errorSnippet(res)));
}

/** Relê `status` do vídeo. `null` se a API não devolver o item. */
export async function fetchVideoStatus(
  deps: YouTubeUploadDeps,
  token: string,
  videoId: string,
): Promise<UploadedVideoResource["status"] | null> {
  const res = await deps.fetch(`${YOUTUBE_API_BASE}/videos?part=status&id=${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(explainYouTubeUploadError(res.status, await errorSnippet(res)));
  const json = (await res.json().catch(() => null)) as { items?: UploadedVideoResource[] } | null;
  const item = json?.items?.find((i) => i.id === videoId);
  return item?.status ?? null;
}

export interface YouTubeUploadInput {
  creds: YouTubeCredentials;
  request: YouTubeInsertRequest;
  video: Buffer;
  contentType?: string;
  /** Capa (JPEG); null = sem `thumbnails.set`. */
  thumbnail: Buffer | null;
}

export interface YouTubeUploadResult {
  videoId: string;
  url: string;
  channelId: string | null;
  /** O que o request pediu (não o que o YouTube aplicou). */
  requested: { privacyStatus: string; publishAt: string | null };
  thumbnail: { attempted: boolean; ok: boolean; error: string | null };
  /** Estado RELIDO (#573), normalizado por `resolveYouTubeState`. */
  state: PublishState;
  /** `status` cru da releitura (null se a releitura falhou). */
  rereadStatus: UploadedVideoResource["status"] | null;
  rereadError: string | null;
  uploadedAt: string;
  rereadAt: string;
}

/**
 * Upload completo. Lança `YouTubeUploadError` até o vídeo existir; depois
 * disso (capa, releitura) nunca lança — falha vira campo no resultado, pra o
 * caller sempre conseguir gravar o videoId e não duplicar o upload.
 */
export async function uploadYouTubeVideo(deps: YouTubeUploadDeps, input: YouTubeUploadInput): Promise<YouTubeUploadResult> {
  const token = await refreshYouTubeAccessToken(deps, input.creds);
  await assertExpectedChannel(deps, token, input.creds.channelId);
  const sessionUrl = await startResumableUpload(deps, token, input.request);
  const resource = await putVideoBytes(deps, token, sessionUrl, input.video, input.contentType ?? "video/mp4");
  const uploadedAt = deps.now().toISOString();
  const videoId = resource.id;

  const thumbnail: YouTubeUploadResult["thumbnail"] = { attempted: false, ok: false, error: null };
  if (input.thumbnail) {
    thumbnail.attempted = true;
    try {
      await setThumbnail(deps, token, videoId, input.thumbnail);
      thumbnail.ok = true;
    } catch (e) {
      thumbnail.error = (e as Error).message;
    }
  }

  let rereadStatus: YouTubeUploadResult["rereadStatus"] = null;
  let rereadError: string | null = null;
  try {
    rereadStatus = await fetchVideoStatus(deps, token, videoId);
    if (!rereadStatus) rereadError = "videos.list não devolveu o vídeo recém-enviado (processamento ainda não indexado?)";
  } catch (e) {
    rereadError = (e as Error).message;
  }
  const rereadAt = deps.now();
  const state: PublishState = rereadStatus ? resolveYouTubeState({ status: rereadStatus }, rereadAt) : "unknown";

  return {
    videoId,
    url: `https://youtu.be/${videoId}`,
    channelId: resource.snippet?.channelId ?? null,
    requested: {
      privacyStatus: input.request.body.status.privacyStatus,
      publishAt: input.request.body.status.publishAt ?? null,
    },
    thumbnail,
    state,
    rereadStatus,
    rereadError,
    uploadedAt,
    rereadAt: rereadAt.toISOString(),
  };
}

/** Explica o estado relido para o editor (nunca diz "publicado" sem `published`). */
export function describeYouTubeState(state: PublishState): string {
  switch (state) {
    case "published":
      return "público";
    case "scheduled":
      return "agendado (privado até o publishAt)";
    case "draft":
      return "privado sem agendamento — sem a auditoria do YouTube API Services o YouTube trava todo upload via API em private; publique à mão no Studio";
    default:
      return "estado não confirmado na releitura — confira no YouTube Studio antes de afirmar qualquer coisa";
  }
}
