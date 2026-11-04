/**
 * scripts/lib/diaria/youtube-podcast-playlist.ts (#12068)
 *
 * Põe o vídeo HORIZONTAL do dia na playlist do podcast do canal `@diariabr`
 * (`playlistItems.insert`), depois do upload do `publish-youtube.ts --upload`
 * — também quando o vídeo já estava no canal ou já estava registrado (resume).
 * O vertical/Short nunca passa por aqui.
 *
 * - Config: `publishing.youtube.podcast_playlist_id` em `platform.config.json`.
 *   `null`/ausente = no-op com 1 linha `[info]`; presente mas inválido
 *   (vazio, não-string) = no-op com `[aviso]` (`readPodcastPlaylistConfig`).
 * - Idempotente: `playlistItems.list?playlistId=…&videoId=…` (1 unidade)
 *   antes do insert; já presente → não insere.
 * - Quota: `playlistItems.insert` custa 50 unidades do balde geral de 10.000/dia.
 * - Escopo: só o INSERT exige `youtube.force-ssl` (ou `youtube`); o `list`
 *   passa com o `youtube.readonly` que todo token tem. Sem force-ssl o insert
 *   cai em 403 de escopo → `scopeMissing: true`.
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

/** Leitura do config: ausente/`null` (não configurado), ID válido, ou presente mas inválido. */
export type PodcastPlaylistConfig = { kind: "absent" } | { kind: "ok"; id: string } | { kind: "invalid"; reason: string };

export function readPodcastPlaylistConfig(cfg: unknown): PodcastPlaylistConfig {
  const raw = (cfg as { publishing?: { youtube?: { podcast_playlist_id?: unknown } } } | null)?.publishing?.youtube
    ?.podcast_playlist_id;
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (typeof raw !== "string") return { kind: "invalid", reason: `podcast_playlist_id não é string (${JSON.stringify(raw)})` };
  const id = raw.trim();
  return id === "" ? { kind: "invalid", reason: "podcast_playlist_id vazio" } : { kind: "ok", id };
}

/** Lê `publishing.youtube.podcast_playlist_id`; `null` quando ausente/vazio/não-string. */
export function loadPodcastPlaylistId(cfg: unknown): string | null {
  const r = readPodcastPlaylistConfig(cfg);
  return r.kind === "ok" ? r.id : null;
}

/** `[aviso]` do config presente mas inválido ou ilegível: o podcast foi pulado por causa dele. */
export function podcastConfigWarning(reason: string): string {
  return `[aviso] podcast pulado por causa do config: ${reason} — corrija publishing.youtube.podcast_playlist_id em platform.config.json e rode o --upload de novo (#12068)`;
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
  /** Vídeo tentado: o guard de "já feito" exige que bata com o `videoId` do registro. */
  videoId: string;
  attempted: boolean;
  ok: boolean;
  /** Já estava na playlist: nada inserido. */
  alreadyPresent: boolean;
  playlistItemId: string | null;
  error: string | null;
  /** Token sem `youtube.force-ssl`: refazer o consentimento. */
  scopeMissing: boolean;
  /** Status HTTP da chamada que falhou (`null` = rede, corpo inesperado ou ok). */
  httpStatus: number | null;
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
  constructor(
    message: string,
    readonly scopeMissing: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "PlaylistStepError";
  }
}

async function failure(res: Response, what: string): Promise<PlaylistStepError> {
  const body = await snippet(res);
  if (res.status === 403 && SCOPE_RE.test(body)) {
    return new PlaylistStepError(youtubeScopeInsufficientMessage("playlist"), true, res.status);
  }
  return new PlaylistStepError(`${what} respondeu ${res.status}: ${body}`, false, res.status);
}

function baseResult(playlistId: string, videoId: string): PodcastPlaylistResult {
  return {
    playlistId,
    videoId,
    attempted: true,
    ok: false,
    alreadyPresent: false,
    playlistItemId: null,
    error: null,
    scopeMissing: false,
    httpStatus: null,
    at: null,
  };
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
  const base = baseResult(playlistId, videoId);
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const list = await deps.fetch(buildPlaylistItemsLookupUrl(playlistId, videoId), { headers: auth });
    if (!list.ok) throw await failure(list, "playlistItems.list");
    const found = (await jsonOrNull(list)) as { items?: Array<{ id?: unknown }> } | null;
    if (!found || !Array.isArray(found.items)) throw new PlaylistStepError("playlistItems.list devolveu corpo inesperado", false);
    const existing = found.items.find((i): i is { id: string } => typeof i?.id === "string" && i.id !== "");
    if (existing) {
      return { ...base, ok: true, alreadyPresent: true, playlistItemId: existing.id, at: deps.now().toISOString() };
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
      httpStatus: e instanceof PlaylistStepError ? e.httpStatus : null,
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
    return { ...baseResult(input.playlistId, input.videoId), error: (e as Error).message, at: deps.now().toISOString() };
  }
  return addVideoToPodcastPlaylist(deps, token, input.playlistId, input.videoId);
}

/**
 * Linha de log do passo do podcast. Na falha, a ação depende da causa: escopo
 * (refazer o consentimento), 404 (conferir o ID no config) ou rede/5xx (rodar
 * de novo). `aammdd` monta o comando exato do `--upload` (que exige
 * `--confirm-publish`); sem ele, o comando sai com o placeholder AAMMDD.
 */
export function describePodcastOutcome(r: PodcastPlaylistResult, aammdd?: string): string {
  if (r.ok && r.alreadyPresent) return `[ok] vídeo já estava na playlist do podcast (${r.playlistId}) — nada inserido`;
  if (r.ok) return `[ok] vídeo adicionado à playlist do podcast (${r.playlistId}${r.playlistItemId ? `, item ${r.playlistItemId}` : ""})`;
  const ed = aammdd ?? "AAMMDD";
  const rerun = "`npx tsx scripts/publish-youtube.ts " + ed + " --upload --confirm-publish " + ed + "`";
  let action: string;
  if (r.scopeMissing) {
    action =
      "Refaça o consentimento (`npx tsx scripts/youtube-oauth-setup.ts`; no 300, `npm run sync-env`) e depois rode o --upload de novo: " +
      `${rerun} (retoma: não reenvia o vídeo, só adiciona ao podcast).`;
  } else if (r.httpStatus === 404) {
    action = `Playlist ${r.playlistId} não encontrada: confira publishing.youtube.podcast_playlist_id em platform.config.json e rode o --upload de novo: ${rerun}.`;
  } else {
    action = `Rode de novo: ${rerun} (retoma: não reenvia o vídeo e não duplica no podcast), ou adicione à mão no YouTube Studio.`;
  }
  return `[aviso] vídeo NÃO adicionado ao podcast (${r.playlistId}): ${r.error}. O vídeo segue publicado. ${action}`;
}
