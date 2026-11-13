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

/**
 * #12429: a marca de "legenda sem plano, não revisada" ao lado do SRT. O
 * `video-montagem.ts srt --from-final --no-plan` a grava junto com a cópia na
 * pasta da edição (texto ouvido pelo Whisper, sem roteiro) e qualquer outro
 * `srt` que regrave a cópia a apaga; com ela presente, o `--captions-only`
 * recusa enviar o SRT sem `--captions-reviewed`.
 */
export function youtubeCaptionNoPlanMarkerPath(srtPath: string): string {
  return `${srtPath}.no-plan.json`;
}

/** Conteúdo da marca acima. */
export interface YoutubeCaptionNoPlanMarker {
  origin: "no-plan";
  /** sha256 do SRT gravado. */
  sha256: string;
  writtenAt: string;
  /** Nome do export que gerou a legenda. */
  fromExport: string;
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
  /** #13004: a faixa existente foi atualizada (`captions.update`) em vez de criada. */
  updated?: boolean;
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

export interface CaptionUpdateRequest {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  /** Corpo multipart/related: o recurso (`id` + `snippet.isDraft`) + o SRT novo. */
  body: Buffer;
  resource: { id: string; snippet: { isDraft: boolean } };
}

/**
 * #13004: monta o `captions.update` (puro, sem rede): troca o arquivo da faixa
 * `captionId` que já existe, em vez de criar outra (o `captions.insert`).
 * O `snippet` aceito no update é só o `isDraft`; língua e nome ficam os da faixa.
 */
export function buildCaptionUpdateRequest(
  token: string,
  captionId: string,
  srt: Buffer,
  boundary = `diaria-caption-update-${captionId}`,
): CaptionUpdateRequest {
  const resource = { id: captionId, snippet: { isDraft: false } };
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(resource) +
        `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    ),
    srt,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  return {
    url: `${YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT}?uploadType=multipart&part=snippet`,
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
    resource,
  };
}

/** `captions.update` (#13004). Lança `CaptionScopeError` em 403 de escopo; outro erro, `Error`. Devolve o id da faixa. */
export async function updateCaption(deps: YouTubeUploadDeps, token: string, captionId: string, srt: Buffer): Promise<string> {
  const req = buildCaptionUpdateRequest(token, captionId, srt);
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
    throw new Error(`captions.update respondeu ${res.status}: ${text}`);
  }
  let json: { id?: unknown } | null = null;
  try {
    json = (await res.json()) as { id?: unknown } | null;
  } catch {
    json = null;
  }
  // O update responde com o recurso da faixa; sem id no corpo, vale o id pedido.
  return json && typeof json.id === "string" && json.id ? json.id : captionId;
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
  /** #13004: id da faixa a atualizar (`captions.update`); ausente = `captions.insert`. */
  updateId?: string,
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
    if (updateId) {
      const captionId = await updateCaption(deps, token, updateId, srt);
      return { ...base, attempted: true, ok: true, captionId, at: deps.now().toISOString(), updated: true };
    }
    const captionId = await insertCaption(deps, token, videoId, srt);
    return { ...base, attempted: true, ok: true, captionId, at: deps.now().toISOString() };
  } catch (e) {
    return {
      ...base,
      attempted: true,
      ...(updateId ? { updated: false } : {}),
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

/**
 * Linha de log da legenda (o `[aviso]` de escopo traz o comando de setup).
 * `videoId` (#12429): o vídeo veio do `--video-id`, sem registro, e o comando
 * de nova tentativa precisa levá-lo.
 */
export function describeCaptionOutcome(c: CaptionUploadResult, aammdd: string, videoId?: string): string | null {
  if (!c.attempted) return null;
  if (c.ok) return c.updated ? `[ok] faixa ${c.captionId} atualizada com a legenda nova (captions.update, #13004)` : `[ok] legenda ${c.language} enviada (captionId ${c.captionId})`;
  const retry = `npx tsx scripts/publish-youtube.ts ${aammdd} --captions-only${videoId ? ` --video-id ${videoId}` : ""}`;
  if (c.scopeMissing) {
    return `[aviso] legenda NÃO enviada: ${c.error}. Depois do setup, \`${retry}\` envia só a legenda. O vídeo segue sem ela.`;
  }
  return `[aviso] legenda NÃO enviada: ${c.error}. Tente \`${retry}\` ou envie pelo Studio (Legendas → Enviar arquivo). O vídeo segue sem ela.`;
}


/**
 * `snippet.trackKind` do `captions.list`: `standard` é a faixa enviada,
 * `asr` a automática, `forced` a forçada; valor fora disso (ou ausente) vira
 * `unknown`.
 */
export type CaptionTrackKind = "standard" | "asr" | "forced" | "unknown";

function toTrackKind(v: unknown): CaptionTrackKind {
  const k = typeof v === "string" ? v.toLowerCase() : "";
  return k === "standard" || k === "asr" || k === "forced" ? k : "unknown";
}

/** Uma faixa de legenda do vídeo, como o `captions.list` devolve (só o que a conferência usa). */
export interface CaptionTrack {
  id: string;
  language: string;
  name: string;
  trackKind: CaptionTrackKind;
  isDraft: boolean;
  lastUpdated: string | null;
}

export const YOUTUBE_CAPTIONS_LIST_ENDPOINT = "https://www.googleapis.com/youtube/v3/captions";

/**
 * `captions.list` (#12429): as faixas do vídeo, para conferir o backfill
 * (a pt-BR `standard` enviada, além da `asr` automática). Só leitura; 50
 * unidades de quota; exige o escopo `youtube.force-ssl` (o 403 de escopo vira
 * `CaptionScopeError`). Faixa sem id é descartada.
 */
export async function listCaptions(deps: YouTubeUploadDeps, token: string, videoId: string): Promise<CaptionTrack[]> {
  const url = `${YOUTUBE_CAPTIONS_LIST_ENDPOINT}?part=snippet&videoId=${encodeURIComponent(videoId)}`;
  const res = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let text = "";
    try {
      text = (await res.text()).slice(0, 300);
    } catch {
      // corpo ilegível: segue só com o status
    }
    if (isCaptionScopeError(res.status, text)) throw new CaptionScopeError();
    throw new Error(`captions.list respondeu ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { items?: Array<{ id?: unknown; snippet?: Record<string, unknown> }> } | null;
  return (json?.items ?? []).flatMap((it) => {
    if (typeof it.id !== "string" || !it.id) return [];
    const sn = it.snippet ?? {};
    return [{
      id: it.id,
      language: typeof sn.language === "string" ? sn.language : "",
      name: typeof sn.name === "string" ? sn.name : "",
      trackKind: toTrackKind(sn.trackKind),
      isDraft: sn.isDraft === true,
      lastUpdated: typeof sn.lastUpdated === "string" ? sn.lastUpdated : null,
    }];
  });
}

/** A faixa é a pt-BR enviada (`standard`), e não a automática nem outra língua? */
function isSentPtBr(t: CaptionTrack): boolean {
  return t.language.toLowerCase() === YOUTUBE_CAPTION_LANGUAGE.toLowerCase() && t.trackKind === "standard";
}

/**
 * Faixa `standard` de qualquer variante de português (`pt`, `pt-BR`, `pt-PT`)?
 * #12429: a faixa enviada à mão pelo Studio pode vir como `pt`; para decidir
 * se o `--captions-only --video-id` envia, ela também conta como já enviada.
 */
function isSentPt(t: CaptionTrack): boolean {
  return t.trackKind === "standard" && t.language.toLowerCase().startsWith("pt");
}

/** ID de vídeo do YouTube: 11 caracteres de `[A-Za-z0-9_-]` (#12429, barra erro de digitação no `--video-id`). */
export function isYouTubeVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

/** Decisão do `--captions-only` pelas faixas do vídeo (#12429, #13004). */
export interface CaptionsTrackDecision {
  /** Enviar (insert, ou update quando `updateId` vem). */
  send: boolean;
  line: string;
  /** #13004: a faixa pt `standard` que o `--force` atualiza (`captions.update`). */
  updateId?: string;
  /** #13004: `--force` sem saber qual faixa atualizar (2+ faixas pt): nada enviado, exit 1. */
  refused?: boolean;
}

/**
 * `--captions-only` pelas faixas do vídeo (#12429). Qualquer faixa `standard`
 * de idioma `pt*` (pt-BR do script, ou `pt` enviada pelo Studio; publicada ou
 * rascunho) = já enviada: sem `--force`, não envia. A `asr` automática nunca
 * conta.
 *
 * `--force` (#13004) ATUALIZA a faixa existente (`captions.update`) em vez de
 * criar uma 2ª faixa em português: a do `preferId` (o `captionId` do registro)
 * quando ela está entre as faixas pt, senão a única faixa pt. Com 2+ faixas pt
 * e nenhuma delas a do registro, não há como escolher: recusa (`refused`),
 * nada enviado. Puro.
 */
export function decideCaptionsOnlyByTracks(tracks: CaptionTrack[], force: boolean, preferId?: string | null): CaptionsTrackDecision {
  const sent = tracks.filter(isSentPt);
  const ids = sent.map((t) => `${t.id}${t.isDraft ? " (rascunho)" : ""}`).join(", ");
  if (sent.length === 0) return { send: true, line: "[info] o vídeo não tem faixa pt `standard` enviada: envia" };
  if (!force) return { send: false, line: `[ok] o vídeo já tem faixa pt enviada (${ids}) — nada feito. Use --force para atualizar a faixa.` };
  const target = (preferId ? sent.find((t) => t.id === preferId) : undefined) ?? (sent.length === 1 ? sent[0] : undefined);
  if (target) return { send: true, updateId: target.id, line: `[premissa] --force: atualiza a faixa ${target.id} (${target.language}) com a legenda nova, sem criar outra (#13004)` };
  return {
    send: false,
    refused: true,
    line: `[erro] --force: o vídeo tem ${sent.length} faixas pt standard (${ids}) e não dá para saber qual atualizar. Apague as extras no YouTube Studio (Legendas) e rode de novo. Nada enviado (#13004).`,
  };
}

export interface UnregisteredCaptionOutcome {
  /** Nada enviado porque o vídeo já tinha faixa pt-BR (sem `--force`). */
  skipped: boolean;
  /** #13004: `--force` com 2+ faixas pt e nenhuma escolhível: nada enviado, o chamador sai exit 1. */
  refused?: boolean;
  /** Linha da decisão pelas faixas (`decideCaptionsOnlyByTracks`); `null` se o `captions.list` falhou. */
  decisionLine: string | null;
  /** Resultado do envio; `null` quando pulado. */
  result: CaptionUploadResult | null;
}

/**
 * `--captions-only --video-id` (#12429): legenda para um vídeo do canal SEM
 * registro na edição (os horizontais antigos, fora dos 25 uploads que o
 * `--accept-period-match` varre). Só legenda: token → canal → `captions.list`
 * → `captions.insert`. Nenhuma chamada de playlist, `videos.update` ou
 * thumbnail. Falha de token/canal lança `YouTubeUploadError`; a do
 * `captions.list`/legenda vem no resultado (403 de escopo = `scopeMissing`).
 *
 * #13004: também o caminho do `--force` com registro que já tem faixa: o
 * `captions.list` decide entre atualizar a faixa existente (`captions.update`,
 * a do `preferId` ou a única pt) e recusar (2+ faixas pt).
 */
export async function uploadCaptionsForUnregisteredVideo(
  deps: YouTubeUploadDeps,
  input: {
    creds: YouTubeCredentials;
    videoId: string;
    srt: Buffer;
    path: string;
    force: boolean;
    /** #13004: o `captionId` do registro, a faixa que o `--force` atualiza quando está no vídeo. */
    preferId?: string | null;
  },
): Promise<UnregisteredCaptionOutcome> {
  const token = await refreshYouTubeAccessToken(deps, input.creds);
  await assertExpectedChannel(deps, token, input.creds.channelId);
  let tracks: CaptionTrack[];
  try {
    tracks = await listCaptions(deps, token, input.videoId);
  } catch (e) {
    return {
      skipped: false,
      decisionLine: null,
      result: {
        attempted: true,
        ok: false,
        captionId: null,
        language: YOUTUBE_CAPTION_LANGUAGE,
        path: input.path,
        error: (e as Error).message,
        scopeMissing: e instanceof CaptionScopeError,
        at: deps.now().toISOString(),
      },
    };
  }
  const decision = decideCaptionsOnlyByTracks(tracks, input.force, input.preferId);
  if (decision.refused) return { skipped: false, refused: true, decisionLine: decision.line, result: null };
  if (!decision.send) return { skipped: true, decisionLine: decision.line, result: null };
  const result = await uploadCaptionSafely(deps, token, input.videoId, input.srt, input.path, decision.updateId);
  return { skipped: false, decisionLine: decision.line, result };
}

/**
 * A faixa pt-BR enviada pelo script está publicada no vídeo? (#12429) Com o
 * `captionId` do registro: ok só se essa faixa está no vídeo, é pt-BR
 * `standard` e não é rascunho. Sem ele: ok se há alguma faixa pt-BR
 * `standard` fora de rascunho (a `asr` automática nunca conta). `line` é a
 * linha do log, `[ok]`/`[aviso]`/`[erro]`. Puro.
 */
export function captionBackfillStatus(tracks: CaptionTrack[], recordedCaptionId: string | null): { ok: boolean; line: string } {
  const pt = tracks.filter(isSentPtBr);
  if (recordedCaptionId) {
    const hit = tracks.find((t) => t.id === recordedCaptionId);
    if (hit) {
      const desc = `${hit.id} (${hit.language}, ${hit.trackKind}, ${hit.lastUpdated ?? "sem data"})`;
      if (!isSentPtBr(hit)) return { ok: false, line: `[erro] faixa registrada não é a pt-BR standard: ${desc}` };
      return { ok: !hit.isDraft, line: `${hit.isDraft ? "[aviso] faixa registrada em rascunho" : "[ok] faixa registrada no vídeo"}: ${desc}` };
    }
    return { ok: false, line: `[erro] captionId ${recordedCaptionId} do registro não está no vídeo (faixas: ${tracks.map((t) => `${t.id} ${t.language}/${t.trackKind}`).join(", ") || "nenhuma"})` };
  }
  const live = pt.filter((t) => !t.isDraft);
  if (live.length) return { ok: true, line: `[ok] faixa pt-BR publicada: ${live.map((t) => `${t.id} (${t.lastUpdated ?? "sem data"})`).join(", ")} (sem captionId no registro)` };
  return { ok: false, line: `[erro] nenhuma faixa pt-BR publicada além da automática (faixas: ${tracks.map((t) => `${t.id} ${t.language}/${t.trackKind}`).join(", ") || "nenhuma"})` };
}
