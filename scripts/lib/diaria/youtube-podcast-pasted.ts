/**
 * scripts/lib/diaria/youtube-podcast-pasted.ts (#12085)
 *
 * Passo do podcast no fallback do YouTube Studio: o editor sobe o horizontal à
 * mão e cola o link (`link-video-d1.ts --save`, ou `/diaria-publica-video
 * --video-url`, Passos A4/A5). Até aqui só o `publish-youtube.ts --upload`
 * (#12068) punha o vídeo na playlist do podcast, e o relato marcava "podcast:
 * adicionar à mão" nesse caminho.
 *
 * Reaproveita `ensureVideoInPodcastPlaylist` (idempotente: `playlistItems.list`
 * pelo vídeo antes do insert) e as mesmas linhas de log. Só o horizontal passa
 * por aqui: o `link-video-d1.ts` é o link do D1, que é sempre o horizontal.
 * Fail-soft: nada aqui lança e o desfecho nunca muda o exit code do `--save`.
 */

import { extractYouTubeVideoId } from "./d1-video-link.ts";
import {
  PODCAST_PLAYLIST_NOT_CONFIGURED,
  describePodcastOutcome,
  ensureVideoInPodcastPlaylist,
  podcastConfigWarning,
  readPodcastPlaylistConfig,
  type PodcastPlaylistResult,
} from "./youtube-podcast-playlist.ts";
import { missingYouTubeCredentials, type YouTubeUploadDeps } from "./youtube-upload.ts";

export interface PastedPodcastInput {
  aammdd: string;
  videoUrl: string;
  /** `platform.config.json` já lido; `null` = ilegível (vira `[aviso]`). */
  config: unknown;
  /** Motivo de o config estar ilegível (só com `config: null`). */
  configError?: string;
  env: Record<string, string | undefined>;
  /** Registro do upload, quando existe: `podcast.ok` do mesmo vídeo e playlist pula a chamada. */
  recordPodcast?: Pick<PodcastPlaylistResult, "ok" | "playlistId" | "videoId"> | null;
  log: (line: string) => void;
}

export type PastedPodcastOutcome =
  | { kind: "not-configured" }
  | { kind: "config-invalid" }
  | { kind: "bad-url" }
  | { kind: "already-done" }
  | { kind: "no-credentials"; missing: string[] }
  | { kind: "attempted"; result: PodcastPlaylistResult };

/**
 * Linha de log do caminho colado. No sucesso é a mesma do `--upload`; na falha
 * o retry é o `--save` (o `--upload` sem registro subiria o vídeo de novo).
 */
export function describePastedPodcastOutcome(r: PodcastPlaylistResult, aammdd: string, videoUrl: string): string {
  if (r.ok) return describePodcastOutcome(r, aammdd);
  const retry = `\`npx tsx scripts/link-video-d1.ts ${aammdd} --save --video-url ${videoUrl}\``;
  const action = r.scopeMissing
    ? `Refaça o consentimento (\`npx tsx scripts/youtube-oauth-setup.ts\`; no 300, \`npm run sync-env\`) e rode ${retry}.`
    : r.httpStatus === 404
      ? `Playlist ${r.playlistId} não encontrada: confira publishing.youtube.podcast_playlist_id em platform.config.json e rode ${retry}.`
      : `Rode ${retry} (não duplica no podcast), ou adicione à mão no YouTube Studio.`;
  return `[aviso] vídeo NÃO adicionado ao podcast (${r.playlistId}): ${r.error}. O vídeo segue publicado. ${action} (#12085)`;
}

/** Põe o vídeo colado na playlist do podcast. Nunca lança. */
export async function addPastedVideoToPodcast(deps: YouTubeUploadDeps, input: PastedPodcastInput): Promise<PastedPodcastOutcome> {
  if (input.config === null) {
    input.log(podcastConfigWarning(`platform.config.json ilegível (${input.configError ?? "?"})`));
    return { kind: "config-invalid" };
  }
  const cfg = readPodcastPlaylistConfig(input.config);
  if (cfg.kind === "absent") {
    input.log(PODCAST_PLAYLIST_NOT_CONFIGURED);
    return { kind: "not-configured" };
  }
  if (cfg.kind === "invalid") {
    input.log(podcastConfigWarning(cfg.reason));
    return { kind: "config-invalid" };
  }
  const videoId = extractYouTubeVideoId(input.videoUrl);
  if (!videoId) {
    input.log(`[aviso] vídeo NÃO adicionado ao podcast: ${JSON.stringify(input.videoUrl)} não é link de vídeo do YouTube (#12085)`);
    return { kind: "bad-url" };
  }
  const rp = input.recordPodcast;
  if (rp?.ok === true && rp.playlistId === cfg.id && rp.videoId === videoId) {
    input.log(`[ok] vídeo já estava na playlist do podcast (${cfg.id}) pelo registro do upload — nada chamado (#12085)`);
    return { kind: "already-done" };
  }
  const missing = missingYouTubeCredentials(input.env);
  if (missing.length > 0) {
    input.log(`[aviso] vídeo NÃO adicionado ao podcast: faltam ${missing.join(", ")} no ambiente. Adicione à mão no YouTube Studio (#12085).`);
    return { kind: "no-credentials", missing };
  }
  const result = await ensureVideoInPodcastPlaylist(deps, {
    creds: {
      clientId: (input.env.GOOGLE_CLIENT_ID ?? "").trim(),
      clientSecret: (input.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
      refreshToken: (input.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
      channelId: (input.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
    },
    playlistId: cfg.id,
    videoId,
  });
  input.log(describePastedPodcastOutcome(result, input.aammdd, input.videoUrl));
  return { kind: "attempted", result };
}
