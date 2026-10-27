/**
 * youtube-captions.ts (#11384) — envia a legenda SRT do horizontal pela
 * YouTube Data API v3 (`captions.insert`, upload multipart).
 *
 * `captions.insert` exige o escopo `youtube.force-ssl` (o `youtube.upload`
 * do vídeo não basta). Tokens gerados antes do #11384 não o têm: o 403 de
 * escopo vira `scopeMissing: true` e o chamador segue sem legenda (fail-soft),
 * com o comando de setup no `[aviso]`. O vídeo nunca depende da legenda.
 *
 * Faixa: pt-BR, `isDraft: false` (publicada junto com o vídeo).
 * Arquivo: `{editionDir}/diaria-comentada-{AAMMDD}.srt` (o mesmo nome-base do
 * `.mp4`, `youtubeCaptionFileName`).
 */

import {
  assertExpectedChannel,
  refreshYouTubeAccessToken,
  type YouTubeCredentials,
  type YouTubeUploadDeps,
} from "./youtube-upload.ts";

export const YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/captions";
export const YOUTUBE_CAPTION_LANGUAGE = "pt-BR";
export const YOUTUBE_CAPTION_NAME = "Português (Brasil)";
export const YOUTUBE_OAUTH_SETUP_COMMAND = "npx tsx scripts/youtube-oauth-setup.ts";

/** Nome convencional do SRT do horizontal, ao lado do `.mp4` (#11384). */
export function youtubeCaptionFileName(aammdd: string): string {
  return `diaria-comentada-${aammdd}.srt`;
}

export interface CaptionInsertRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** Corpo multipart/related: snippet JSON + o SRT. */
  body: Buffer;
  snippet: { videoId: string; language: string; name: string; isDraft: boolean };
}

/** Monta o request de `captions.insert` (puro, sem rede). */
export function buildCaptionInsertRequest(
  token: string,
  videoId: string,
  srt: Buffer,
  boundary = `diaria-caption-${videoId}`,
): CaptionInsertRequest {
  const snippet = { videoId, language: YOUTUBE_CAPTION_LANGUAGE, name: YOUTUBE_CAPTION_NAME, isDraft: false };
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ snippet }) +
        `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    ),
    srt,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  return {
    url: `${YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT}?uploadType=multipart&part=snippet`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
    snippet,
  };
}

/** 403 por falta de escopo (token anterior ao #11384, sem `youtube.force-ssl`). */
export function isCaptionScopeError(status: number, body: string): boolean {
  return status === 403 && /insufficientPermissions|insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body);
}

export class CaptionScopeError extends Error {
  constructor() {
    super(
      `token do YouTube sem o escopo youtube.force-ssl (captions.insert) — rode \`${YOUTUBE_OAUTH_SETUP_COMMAND}\` ` +
        "de novo no terminal do editor (e `npm run sync-env` no 300)",
    );
    this.name = "CaptionScopeError";
  }
}

export interface CaptionUploadResult {
  attempted: boolean;
  ok: boolean;
  captionId: string | null;
  language: string;
  path: string | null;
  error: string | null;
  /** O token não tem `youtube.force-ssl` (#11384): rodar o setup de novo. */
  scopeMissing: boolean;
  at: string | null;
}

/** `captions.insert`. Lança `CaptionScopeError` em 403 de escopo; outro erro, `Error`. */
export async function insertCaption(deps: YouTubeUploadDeps, token: string, videoId: string, srt: Buffer): Promise<string> {
  const req = buildCaptionInsertRequest(token, videoId, srt);
  const res = await deps.fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: new Uint8Array(req.body.buffer as ArrayBuffer, req.body.byteOffset, req.body.length),
  });
  if (!res.ok) {
    let text = "";
    try {
      text = (await res.text()).slice(0, 300);
    } catch {
      // corpo ilegível: segue só com o status
    }
    if (isCaptionScopeError(res.status, text)) throw new CaptionScopeError();
    throw new Error(`captions.insert respondeu ${res.status}: ${text}`);
  }
  let json: { id?: unknown } | null = null;
  try {
    json = (await res.json()) as { id?: unknown } | null;
  } catch {
    json = null;
  }
  if (!json || typeof json.id !== "string" || !json.id) throw new Error("captions.insert não devolveu o id da legenda");
  return json.id;
}

/**
 * Envia a legenda e NUNCA lança: o vídeo já está no canal, falha aqui vira
 * campo no resultado (fail-soft). `srt: null` = sem arquivo, nada tentado.
 */
export async function uploadCaptionSafely(
  deps: YouTubeUploadDeps,
  token: string,
  videoId: string,
  srt: Buffer | null,
  path: string | null,
): Promise<CaptionUploadResult> {
  const base: CaptionUploadResult = {
    attempted: false,
    ok: false,
    captionId: null,
    language: YOUTUBE_CAPTION_LANGUAGE,
    path,
    error: null,
    scopeMissing: false,
    at: null,
  };
  if (!srt) return base;
  try {
    const captionId = await insertCaption(deps, token, videoId, srt);
    return { ...base, attempted: true, ok: true, captionId, at: deps.now().toISOString() };
  } catch (e) {
    return {
      ...base,
      attempted: true,
      error: (e as Error).message,
      scopeMissing: e instanceof CaptionScopeError,
      at: deps.now().toISOString(),
    };
  }
}

/**
 * `--captions-only` (#11384): legenda para um vídeo já no canal. Renova o
 * token e confere o canal (mesmas etapas do upload) antes do `captions.insert`.
 * Falha de token/canal lança `YouTubeUploadError`; a da legenda vem no resultado.
 */
export async function uploadCaptionsOnly(
  deps: YouTubeUploadDeps,
  input: { creds: YouTubeCredentials; videoId: string; srt: Buffer; path: string },
): Promise<CaptionUploadResult> {
  const token = await refreshYouTubeAccessToken(deps, input.creds);
  await assertExpectedChannel(deps, token, input.creds.channelId);
  return uploadCaptionSafely(deps, token, input.videoId, input.srt, input.path);
}

/** Linha de log da legenda (o `[aviso]` de escopo traz o comando de setup). */
export function describeCaptionOutcome(c: CaptionUploadResult, aammdd: string): string | null {
  if (!c.attempted) return null;
  if (c.ok) return `[ok] legenda ${c.language} enviada (captionId ${c.captionId})`;
  const retry = `npx tsx scripts/publish-youtube.ts ${aammdd} --captions-only`;
  if (c.scopeMissing) {
    return `[aviso] legenda NÃO enviada: ${c.error}. Depois do setup, \`${retry}\` envia só a legenda. O vídeo segue sem ela.`;
  }
  return `[aviso] legenda NÃO enviada: ${c.error}. Tente \`${retry}\` ou envie pelo Studio (Legendas → Enviar arquivo). O vídeo segue sem ela.`;
}

