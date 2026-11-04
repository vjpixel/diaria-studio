/**
 * scripts/lib/diaria/short-scheduled-update.ts (#11795)
 *
 * Miolo PURO do `publish-shorts.ts --update-scheduled`: troca o texto e a
 * capa de um vertical que JÁ ESTÁ agendado numa plataforma, antes de ele ir
 * ao ar. Em 01/11/2026 isso saiu com scripts descartáveis (o corte "Tratar IA
 * como humano" foi agendado no YouTube e no Facebook e o editor trocou capa e
 * texto depois); mudar `--title`/`--hook`/`--cover` só valia para os destinos
 * ainda não publicados.
 *
 * O que dá para trocar, por destino registrado como `scheduled` com horário
 * futuro (`resolveShortEntryState` = `scheduled`):
 *   - `youtube_shorts`: `videos.update` (título e descrição) + `thumbnails.set`
 *     (`updateScheduledVideo` em `youtube-upload.ts`, que reconfere no canal que
 *     o vídeo segue private com `publishAt` futuro);
 *   - `facebook:{slug}`: `POST /{video-id}` com a descrição + `POST
 *     /{video-id}/thumbnails` (reconfere `published: false` antes);
 *   - `x`/`tiktok` (Buffer): a troca é `edit_post` da Buffer MCP, que só a
 *     skill alcança — o plano devolve o texto novo e o id do post.
 * O resto (já publicado, envio ambíguo, Instagram/LinkedIn/Threads, que saem
 * na hora) fica de fora com o motivo: post no ar não é "antes de publicar".
 */

import { resolveShortEntryState } from "../publish-state.ts";
import {
  buildReelsCaption,
  buildShortSocialText,
  buildTikTokPost,
  buildYouTubeShortMetadata,
  type ShortD1Input,
  type ShortPublishedEntry,
} from "./short-video.ts";

export type ScheduledUpdateItem =
  | { destination: string; action: "update_youtube"; videoId: string; title: string; description: string; scheduledAt: string; cover: boolean }
  | { destination: string; action: "update_facebook"; slug: string; videoId: string; description: string; scheduledAt: string; cover: boolean }
  /** Buffer (X/TikTok): a skill chama `edit_post` com `text` no post `bufferId`. */
  | { destination: string; action: "buffer_edit"; bufferId: string; text: string; scheduledAt: string; tiktokTitle?: string }
  | { destination: string; action: "skip"; reason: string };

/** Pure: o que o `--update-scheduled` faria em cada destino registrado. */
export function planScheduledUpdates(input: {
  entries: readonly ShortPublishedEntry[];
  d1: ShortD1Input;
  now: Date;
  coverPresent: boolean;
  /** #12191: título do horizontal citado na descrição do Short (`resolveShortHorizontalTitle`); ausente/null = sem citação. */
  horizontalTitle?: string | null;
  only?: readonly string[] | null;
  /**
   * Ids de destino que o config conhece (`knownDestinationIds`). Com ele, um
   * `--only` com nome que não é destino conhecido nem registrado lança, em vez
   * de virar um plano vazio sem erro (review do PR #11894).
   */
  known?: ReadonlySet<string>;
}): ScheduledUpdateItem[] {
  const only = input.only && input.only.length ? new Set(input.only) : null;
  if (only && input.known) {
    const valid = new Set([...input.known, ...input.entries.map((e) => e.destination)]);
    const unknown = [...only].filter((d) => !valid.has(d));
    if (unknown.length) throw new Error(`--only com destino desconhecido: ${unknown.join(", ")} (válidos: ${[...valid].join(", ")})`);
  }
  const out: ScheduledUpdateItem[] = [];
  for (const e of input.entries) {
    if (only && !only.has(e.destination)) continue;
    const state = resolveShortEntryState(e, input.now);
    if (state !== "scheduled") {
      const why =
        e.status === "published"
          ? "já publicado: a troca não é mais antes de ir ao ar (faça na plataforma, se quiser)"
          : e.status === "send_unknown"
            ? "envio ambíguo (send_unknown): confira na plataforma antes de qualquer troca"
            : `agendado para ${e.scheduled_at ?? "?"}, que já passou (ou sem horário): confira na plataforma`;
      out.push({ destination: e.destination, action: "skip", reason: why });
      continue;
    }
    const scheduledAt = e.scheduled_at!;
    if (e.destination === "youtube_shorts") {
      const meta = buildYouTubeShortMetadata({ d1: input.d1, horizontalTitle: input.horizontalTitle });
      out.push({ destination: e.destination, action: "update_youtube", videoId: e.id, title: meta.title, description: meta.description, scheduledAt, cover: input.coverPresent });
    } else if (e.destination.startsWith("facebook:")) {
      out.push({
        destination: e.destination,
        action: "update_facebook",
        slug: e.destination.slice("facebook:".length),
        videoId: e.id,
        description: buildReelsCaption({ platform: "facebook", d1: input.d1 }),
        scheduledAt,
        cover: input.coverPresent,
      });
    } else if ((e.destination === "x" || e.destination === "tiktok") && e.id.startsWith("buffer:")) {
      const bufferId = e.id.slice("buffer:".length);
      if (e.destination === "x") {
        out.push({ destination: e.destination, action: "buffer_edit", bufferId, text: buildShortSocialText({ platform: "x", d1: input.d1 }), scheduledAt });
      } else {
        const post = buildTikTokPost({ d1: input.d1 });
        out.push({ destination: e.destination, action: "buffer_edit", bufferId, text: post.caption, scheduledAt, tiktokTitle: post.title });
      }
    } else {
      out.push({ destination: e.destination, action: "skip", reason: "o --update-scheduled não troca este destino (sem edição de post agendado pela API dele)" });
    }
  }
  return out;
}
