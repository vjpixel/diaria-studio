/**
 * scripts/lib/diaria/youtube-theme-playlists.ts (#12077 item 3)
 *
 * Playlists temáticas do canal `@diariabr` (OpenAI, Google, Anthropic, Brasil,
 * Segurança e riscos): depois do upload do horizontal, o vídeo entra nas
 * playlists dos temas do D1 (`youtubeD1Themes`, `youtube-video.ts`).
 * Playlist aumenta o tempo de sessão e aparece na busca.
 *
 * - Config: `publishing.youtube.theme_playlists` em `platform.config.json`,
 *   `{ tema: ID | null }`. Tema sem ID (ou ausente) = não adicionado, com
 *   `[info]` no log: as playlists são criadas no YouTube Studio e o ID vai no
 *   config. Valor não-string/vazio = `[aviso]` e o tema fica de fora.
 * - Mesmo passo do podcast (`addVideoToPodcastPlaylist`, genérico para
 *   qualquer playlist): `playlistItems.list` pelo vídeo antes do insert
 *   (idempotente), 50 unidades por insert, escopo `youtube.force-ssl`.
 * - Fail-soft: nada aqui lança, nunca muda o exit code do upload.
 */

import { addVideoToPodcastPlaylist, type PodcastPlaylistResult } from "./youtube-podcast-playlist.ts";
import { refreshYouTubeAccessToken, type YouTubeCredentials, type YouTubeUploadDeps } from "./youtube-upload.ts";
import { YOUTUBE_THEMES, type YouTubeTheme } from "./youtube-video.ts";

export interface ThemePlaylistsConfig {
  ids: Partial<Record<YouTubeTheme, string>>;
  warnings: string[];
}

/** Lê `publishing.youtube.theme_playlists`. Nunca lança. */
export function readThemePlaylistsConfig(cfg: unknown): ThemePlaylistsConfig {
  const raw = (cfg as { publishing?: { youtube?: { theme_playlists?: unknown } } } | null)?.publishing?.youtube?.theme_playlists;
  const out: ThemePlaylistsConfig = { ids: {}, warnings: [] };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    out.warnings.push(`[aviso] publishing.youtube.theme_playlists não é objeto (${JSON.stringify(raw)}): playlists temáticas puladas (#12077)`);
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.endsWith("_note") || k === "note") continue;
    if (!(YOUTUBE_THEMES as readonly string[]).includes(k)) {
      out.warnings.push(`[aviso] publishing.youtube.theme_playlists.${k}: tema desconhecido (válidos: ${YOUTUBE_THEMES.join(", ")}) — ignorado (#12077)`);
      continue;
    }
    if (v === null) continue;
    if (typeof v !== "string" || v.trim() === "") {
      out.warnings.push(`[aviso] publishing.youtube.theme_playlists.${k} inválido (${JSON.stringify(v)}) — tema pulado (#12077)`);
      continue;
    }
    out.ids[k as YouTubeTheme] = v.trim();
  }
  return out;
}

export interface ThemePlaylistStep {
  theme: YouTubeTheme;
  playlistId: string | null;
}

/** Puro: temas do D1 → passo por tema (sem ID = não adicionado). */
export function planThemePlaylists(themes: readonly YouTubeTheme[], cfg: ThemePlaylistsConfig): ThemePlaylistStep[] {
  return themes.map((theme) => ({ theme, playlistId: cfg.ids[theme] ?? null }));
}

export interface ThemePlaylistResult extends PodcastPlaylistResult {
  theme: YouTubeTheme;
}

/**
 * Põe o vídeo nas playlists dos temas com ID. Um token só para todos; falha no
 * token vira o mesmo erro em cada tema. Nunca lança.
 */
export async function addVideoToThemePlaylists(
  deps: YouTubeUploadDeps,
  input: { creds: YouTubeCredentials; steps: readonly ThemePlaylistStep[]; videoId: string },
): Promise<ThemePlaylistResult[]> {
  const steps = input.steps.filter((s): s is ThemePlaylistStep & { playlistId: string } => s.playlistId !== null);
  if (!steps.length) return [];
  let token: string;
  try {
    token = await refreshYouTubeAccessToken(deps, input.creds);
  } catch (e) {
    const at = deps.now().toISOString();
    return steps.map((s) => ({
      theme: s.theme,
      playlistId: s.playlistId,
      videoId: input.videoId,
      attempted: true,
      ok: false,
      alreadyPresent: false,
      playlistItemId: null,
      error: (e as Error).message,
      scopeMissing: false,
      httpStatus: null,
      at,
    }));
  }
  const out: ThemePlaylistResult[] = [];
  for (const s of steps) out.push({ theme: s.theme, ...(await addVideoToPodcastPlaylist(deps, token, s.playlistId, input.videoId)) });
  return out;
}

/** Linhas de log do passo (uma por tema). */
export function describeThemePlaylists(steps: readonly ThemePlaylistStep[], results: readonly ThemePlaylistResult[]): string[] {
  if (!steps.length) return ["[info] playlists temáticas: o D1 não casou com nenhum tema (#12077)"];
  return steps.map((s) => {
    if (!s.playlistId) return `[info] playlist temática "${s.theme}" sem ID em publishing.youtube.theme_playlists — vídeo não adicionado (#12077)`;
    const r = results.find((x) => x.theme === s.theme);
    if (!r) return `[aviso] playlist temática "${s.theme}" não tentada (#12077)`;
    if (r.ok) return `[ok] vídeo ${r.alreadyPresent ? "já estava" : "adicionado"} na playlist temática "${s.theme}" (${r.playlistId}) (#12077)`;
    const why = r.scopeMissing ? "token sem youtube.force-ssl (refazer scripts/youtube-oauth-setup.ts)" : r.httpStatus === 404 ? "playlist não encontrada (conferir o ID no config)" : (r.error ?? "erro");
    return `[aviso] vídeo NÃO adicionado à playlist temática "${s.theme}" (${r.playlistId}): ${why}. O vídeo segue publicado; adicionar à mão no Studio ou rodar o --upload de novo (#12077)`;
  });
}
