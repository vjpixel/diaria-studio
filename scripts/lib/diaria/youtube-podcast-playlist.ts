/**
 * scripts/lib/diaria/youtube-podcast-playlist.ts (#12068)
 *
 * Põe o vídeo HORIZONTAL do dia na playlist do podcast do canal `@diariabr`
 * (`playlistItems.insert`), depois do upload do `publish-youtube.ts --upload`
 * — também quando o vídeo já estava no canal ou já estava registrado (resume).
 * O vertical/Short nunca passa por aqui.
 *
 * - Config: `publishing.youtube.podcast_playlist_id` em `platform.config.json`.
 *   `null`/ausente = no-op (o podcast ainda não existe, #12067); preenchido o
 *   ID, passa a valer sem código novo.
 * - Idempotente: `playlistItems.list?playlistId=…&videoId=…` (1 unidade)
 *   antes do insert; já presente → não insere.
 * - Quota: `playlistItems.insert` custa 50 unidades do balde geral de 10.000/dia.
 * - Escopo: `youtube.force-ssl` (ou `youtube`) cobre list e insert; o token
 *   só com `youtube.upload` cai em 403 de escopo → `scopeMissing: true`.
 * - Fail-soft: nada aqui lança; falha vira campo no resultado e `[aviso]` no
 *   log, nunca derruba a publicação do vídeo.
 */

import {
  YOUTUBE_API_BASE,
  refreshYouTubeAccessToken,
  youtubeScopeInsufficientMessage,
  type YouTubeCredentials,
  type YouTubeUploadDeps,
} from "./youtube-upload.ts";

/** Linha de no-op quando o ID não está configurado. */
export const PODCAST_PLAYLIST_NOT_CONFIGURED =
  "[info] podcast_playlist_id não configurado — vídeo não adicionado ao podcast (#12068)";

/** Lê `publishing.youtube.podcast_playlist_id`; `null` quando ausente/vazio/não-string. */
export function loadPodcastPlaylistId(cfg: unknown): string | null {
  const raw = (cfg as { publishing?: { youtube?: { podcast_playlist_id?: unknown } } } | null)?.publishing?.youtube
    ?.podcast_playlist_id;
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id === "" ? null : id;
}

/** URL do `playlistItems.list` filtrado pelo vídeo (idempotência). */
export function buildPlaylistItemsLookupUrl(playlistId: string, videoId: string): string {
  return (
    `${YOUTUBE_API_BASE}/playlistItems?part=id&maxResults=1` +
    `&playlistId=${encodeURIComponent(playlistId)}&videoId=${encodeURIComponent(videoId)}`
  );
}

export interface PlaylistItemInsertRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: { snippet: { playlistId: string; resourceId: { kind: "youtube#video"; videoId: string } } };
}

/** `playlistItems.insert` (`part=snippet`, `playlistId`, `resourceId.videoId`). */
export function buildPlaylistItemInsertRequest(token: string, playlistId: string, videoId: string): PlaylistItemInsertRequest {
  return {
    url: `${YOUTUBE_API_BASE}/playlistItems?part=snippet`,
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
  };
}

export interface PodcastPlaylistResult {
  playlistId: string;
  attempted: boolean;
  ok: boolean;
  /** Já estava na playlist: nada inserido. */
  alreadyPresent: boolean;
  playlistItemId: string | null;
  error: string | null;
  /** Token sem `youtube.force-ssl`: refazer o consentimento. */
  scopeMissing: boolean;
  at: string | null;
}

const SCOPE_RE = /insufficientPermissions|insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i;

async function snippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

async function jsonOrNull(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

class PlaylistStepError extends Error {
  constructor(message: string, readonly scopeMissing: boolean) {
    super(message);
  }
}

async function failure(res: Response, what: string): Promise<PlaylistStepError> {
  const body = await snippet(res);
  if (res.status === 403 && SCOPE_RE.test(body)) {
    return new PlaylistStepError(youtubeScopeInsufficientMessage("playlist"), true);
  }
  return new PlaylistStepError(`${what} respondeu ${res.status}: ${body}`, false);
}

/**
 * Confere e, se preciso, insere o vídeo na playlist. Nunca lança.
 */
export async function addVideoToPodcastPlaylist(
  deps: YouTubeUploadDeps,
  token: string,
  playlistId: string,
  videoId: string,
): Promise<PodcastPlaylistResult> {
  const base: PodcastPlaylistResult = {
    playlistId,
    attempted: true,
    ok: false,
    alreadyPresent: false,
    playlistItemId: null,
    error: null,
    scopeMissing: false,
    at: null,
  };
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const list = await deps.fetch(buildPlaylistItemsLookupUrl(playlistId, videoId), { headers: auth });
    if (!list.ok) throw await failure(list, "playlistItems.list");
    const found = (await jsonOrNull(list)) as { items?: Array<{ id?: unknown }> } | null;
    if (!found || !Array.isArray(found.items)) throw new PlaylistStepError("playlistItems.list devolveu corpo inesperado", false);
    const existing = found.items.find((i) => typeof i?.id === "string" && i.id !== "");
    if (existing) {
      return { ...base, ok: true, alreadyPresent: true, playlistItemId: existing.id as string, at: deps.now().toISOString() };
    }
    const req = buildPlaylistItemInsertRequest(token, playlistId, videoId);
    const ins = await deps.fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body) });
    if (!ins.ok) throw await failure(ins, "playlistItems.insert");
    const created = (await jsonOrNull(ins)) as { id?: unknown } | null;
    const itemId = created && typeof created.id === "string" && created.id ? created.id : null;
    return { ...base, ok: true, playlistItemId: itemId, at: deps.now().toISOString() };
  } catch (e) {
    return {
      ...base,
      error: (e as Error).message,
      scopeMissing: e instanceof PlaylistStepError && e.scopeMissing,
      at: deps.now().toISOString(),
    };
  }
}

/** Renova o token e chama `addVideoToPodcastPlaylist`. Nunca lança. */
export async function ensureVideoInPodcastPlaylist(
  deps: YouTubeUploadDeps,
  input: { creds: YouTubeCredentials; playlistId: string; videoId: string },
): Promise<PodcastPlaylistResult> {
  let token: string;
  try {
    token = await refreshYouTubeAccessToken(deps, input.creds);
  } catch (e) {
    return {
      playlistId: input.playlistId,
      attempted: true,
      ok: false,
      alreadyPresent: false,
      playlistItemId: null,
      error: (e as Error).message,
      scopeMissing: false,
      at: deps.now().toISOString(),
    };
  }
  return addVideoToPodcastPlaylist(deps, token, input.playlistId, input.videoId);
}

/** Linha de log do passo do podcast. */
export function describePodcastOutcome(r: PodcastPlaylistResult): string {
  if (r.ok && r.alreadyPresent) return `[ok] vídeo já estava na playlist do podcast (${r.playlistId}) — nada inserido`;
  if (r.ok) return `[ok] vídeo adicionado à playlist do podcast (${r.playlistId}${r.playlistItemId ? `, item ${r.playlistItemId}` : ""})`;
  return `[aviso] vídeo NÃO adicionado ao podcast (${r.playlistId}): ${r.error}. O vídeo segue publicado; adicione à mão no YouTube Studio ou rode o --upload de novo (idempotente).`;
}
