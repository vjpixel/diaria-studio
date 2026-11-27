/**
 * Buffer (X, TikTok): preparo do item e a marcação da substituição agendada.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { BUFFER_ID_RE, bufferReplaceNextSteps } from "../lib/diaria/short-scheduled-replace.ts";
import type { ShortPublishedEntry } from "../lib/diaria/short-video.ts";
import { BUFFER_DESTINATIONS, type ShortsPlanItem, type TikTokBufferMetadata } from "./_shared.ts";
import type { ShortsRunResult, ShortsSendContext, ShortsSettledStep } from "./send-context.ts";

/** O que o `--publish` devolve pro destino do X (#10772): a URL pública do vertical pra Buffer, ou o erro. */
export interface BufferPrepResult {
  destination: string;
  ok: boolean;
  error?: string;
  buffer?: BufferPostInput;
  /**
   * #12279: o preparo só subiu o vídeo ao R2. O post ainda NÃO existe: falta o
   * `create_post` da skill e o `--mark`. Nunca relatar como post criado.
   */
  pending_buffer_create?: true;
}

/**
 * O que a skill passa pra Buffer `create_post`. `thumbnailOffset` (#11547, ms)
 * vai em `assets[0].video.metadata.thumbnailOffset`; ausente = a Buffer
 * escolhe o frame (ela não aceita imagem de capa em vídeo).
 */
export interface BufferPostInput {
  text: string;
  dueAt: string | null;
  videoUrl: string;
  thumbnailOffset?: number;
  /** #11515: canal da Buffer (o TikTok); ausente no X, que usa `publishing.social.twitter.buffer_channel_id`. */
  channelId?: string;
  /** #11515: `metadata` do `create_post` (`{ tiktok: { title, isAiGenerated } }`). */
  metadata?: { tiktok: TikTokBufferMetadata };
  /** #12279: hash dos bytes que o R2 recebeu; a skill o devolve no `--mark ... --video-sha256` (não vai à Buffer). */
  videoSha256?: string;
}

/**
 * Ramo `buffer` do `--publish` (#10772 F6): só sobe o vertical (R2) e devolve o
 * que a skill passa pra Buffer `create_post`. Nada é registrado aqui — o
 * registro vem do `--mark x=buffer:{id}` depois do `create_post`.
 */
export async function prepareBufferItem(
  item: Extract<ShortsPlanItem, { action: "buffer" }>,
  uploadVideo: () => Promise<string>,
  thumbnailOffsetMs: number | null = null,
): Promise<BufferPrepResult> {
  try {
    const videoUrl = await uploadVideo();
    return {
      destination: item.destination,
      ok: true,
      pending_buffer_create: true,
      buffer: {
        text: item.caption,
        dueAt: item.scheduledAt,
        videoUrl,
        ...(thumbnailOffsetMs === null ? {} : { thumbnailOffset: thumbnailOffsetMs }),
        ...(item.channelId ? { channelId: item.channelId } : {}),
        ...(item.tiktok ? { metadata: { tiktok: item.tiktok } } : {}),
      },
    };
  } catch (e) {
    return { destination: item.destination, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * #14204: etapa da Buffer (X, TikTok) no laço do `--publish` (`mainUnlocked`).
 * #10772: só sobe o vídeo; a Buffer é chamada pela skill (MCP), que registra
 * com `--mark`. #12279: o resultado leva o hash dos bytes (vai no `--mark`) e,
 * na troca, o post antigo que a skill apaga. Sempre `settled`: nada é
 * registrado aqui.
 */
export async function sendBufferItem(ctx: ShortsSendContext, item: Extract<ShortsPlanItem, { action: "buffer" }>): Promise<ShortsSettledStep> {
  const prep = await prepareBufferItem(item, ctx.uploadVideo, ctx.bufferOffsetMs);
  const bufferReplace = ctx.replaceTargetOf(item.destination);
  const { videoHash } = ctx;
  const r: ShortsRunResult = prep.ok && videoHash
    ? {
        ...prep,
        buffer: { ...prep.buffer!, videoSha256: videoHash },
        ...(bufferReplace
          ? {
              replaces: { id: bufferReplace.old_id, at: bufferReplace.at },
              next_steps: bufferReplaceNextSteps(item.destination, bufferReplace.old_id, bufferReplace.at, videoHash),
            }
          : {}),
      }
    : prep;
  console.error(r.ok ? `[ok] ${item.destination}: vídeo no R2 (${r.buffer!.videoUrl}) — falta o create_post na Buffer (skill)` : `[erro] ${item.destination}: ${r.error}`);
  return { kind: "settled", result: r };
}

/** #12279: o registro de autorização como a conferência da Buffer o recebe (string = ilegível). */
export type ReplacementStoreArg = ReplacementStoreLike;

/** Autorização do vertical na forma que a conferência da Buffer lê. */
type ReplacementAuthLike = { part: string; destination: string; status: string; plan_sha256: string; replacement?: { id: string; at: string } };
/** O registro de autorização (ou a mensagem, se ilegível). */
type ReplacementStoreLike = { authorizations: readonly ReplacementAuthLike[]; approved_manifests: Record<string, { media: { video_sha256: string | null } }> } | string;

/** Pure (#12279): a autorização de substituição CONSUMIDA do post antigo da Buffer, e o hash do V2 que ela aprovou. */
function consumedBufferReplacement(store: ReplacementStoreLike, destination: string, oldId: string): { ok: true; videoSha256: string | null } | { ok: false; error: string } {
  if (typeof store === "string") return { ok: false, error: `registro de autorização ilegível (${store}): nada registrado` };
  const latest = [...store.authorizations].reverse().find((a) => a.part === "vertical" && a.destination === destination);
  if (!latest || latest.status !== "consumed" || latest.replacement?.id !== oldId) {
    return { ok: false, error: `${destination}: sem a rodada --replace-scheduled --publish que consumiu a autorização de substituição de ${oldId} (a skill só apaga o post antigo depois dela): nada registrado` };
  }
  return { ok: true, videoSha256: store.approved_manifests[latest.plan_sha256]?.media.video_sha256 ?? null };
}

/**
 * Pure (#12279): `--mark-replaced x=buffer:ANTIGO`, logo depois do `delete_post`
 * confirmado na Buffer. Grava só o histórico: o registro deixa de apontar um
 * post que não existe mais (sem isso, um `create_post` que falhe deixaria o
 * registro mentindo). Só vale depois da rodada de troca que consumiu a
 * autorização deste post, com ele ainda registrado como agendado.
 */
export function bufferDeletedRefusal(input: {
  mark: string;
  entries: readonly ShortPublishedEntry[];
  store: ReplacementStoreLike;
}): { ok: true; entry: ShortPublishedEntry } | { ok: false; error: string } {
  const m = input.mark.match(/^([a-z_]+)=(buffer:[A-Za-z0-9_-]+)$/);
  if (!m || !BUFFER_DESTINATIONS.has(m[1]) || !BUFFER_ID_RE.test(m[2])) return { ok: false, error: `--mark-replaced espera x=buffer:ID ou tiktok=buffer:ID (o post antigo apagado), recebido ${JSON.stringify(input.mark)}` };
  const [, destination, oldId] = m;
  const entry = input.entries.find((e) => e.destination === destination);
  if (!entry || entry.id !== oldId || entry.status !== "scheduled") return { ok: false, error: `${destination}: o registro aponta ${entry ? `${entry.id} (${entry.status})` : "nada"}, não ${oldId} agendado: nada registrado` };
  const auth = consumedBufferReplacement(input.store, destination, oldId);
  return auth.ok ? { ok: true, entry } : auth;
}

/**
 * Pure (#12279): o `--mark x=buffer:NOVO --replaces buffer:ANTIGO --scheduled-at ISO --video-sha256 HASH`
 * que a skill roda depois de criar o post novo na Buffer. Só vale depois da
 * rodada `--replace-scheduled --publish` que consumiu a autorização de
 * substituição DESTE post, com o post antigo ainda registrado como agendado
 * (ou já no histórico, pelo `--mark-replaced`), o novo no MESMO horário e o
 * hash igual ao do V2 aprovado. `null` = ok; senão, o motivo (nada registrado).
 */
export function bufferReplacementMarkRefusal(input: {
  destination: string;
  bufferId: string | null;
  replaces: string;
  scheduledAt: string | undefined;
  videoSha256: string | undefined;
  entries: readonly ShortPublishedEntry[];
  /** Histórico das substituições (o `--mark-replaced` já gravou o antigo?). */
  replaced: readonly { destination: string; id: string; scheduled_at: string | null }[];
  store: ReplacementStoreLike;
}): string | null {
  if (!BUFFER_DESTINATIONS.has(input.destination) || !input.bufferId) return "--replaces só vale com --mark x=buffer:ID ou tiktok=buffer:ID (#12279)";
  if (!BUFFER_ID_RE.test(input.replaces)) return `--replaces espera buffer:ID (o post antigo), recebido ${JSON.stringify(input.replaces)}`;
  if (input.replaces === `buffer:${input.bufferId}`) return "--replaces: o post novo é o mesmo ID do antigo";
  const cur = input.entries.find((e) => e.destination === input.destination);
  const gone = input.replaced.find((r) => r.destination === input.destination && r.id === input.replaces);
  let oldAt: string | null;
  if (cur) {
    if (cur.id !== input.replaces) return `${input.destination}: o registro aponta ${cur.id}, não ${input.replaces}: nada registrado`;
    if (cur.status !== "scheduled" || !cur.scheduled_at) return `${input.destination}: o post ${cur.id} não está agendado no registro (${cur.status}): nada registrado`;
    oldAt = cur.scheduled_at;
  } else if (gone) {
    oldAt = gone.scheduled_at;
  } else {
    return `${input.destination}: nem o registro nem o histórico têm ${input.replaces}: nada registrado`;
  }
  const atMs = input.scheduledAt ? Date.parse(input.scheduledAt) : Number.NaN;
  if (!oldAt || Number.isNaN(atMs) || atMs !== Date.parse(oldAt)) {
    return `${input.destination}: o post novo precisa do horário do antigo (--scheduled-at ${oldAt ?? "?"}; recebido ${input.scheduledAt ?? "nenhum"}): nada registrado`;
  }
  const auth = consumedBufferReplacement(input.store, input.destination, input.replaces);
  if (!auth.ok) return auth.error;
  if (!input.videoSha256) return `${input.destination}: --replaces exige --video-sha256 (o videoSha256 do preparo da troca): nada registrado`;
  if (!auth.videoSha256 || input.videoSha256 !== auth.videoSha256) {
    return `${input.destination}: --video-sha256 ${input.videoSha256} não é o do V2 aprovado na troca (${auth.videoSha256 ?? "sem hash no plano aprovado"}): nada registrado`;
  }
  return null;
}

/**
 * #12279: grava o `--mark ... --replaces` na ordem segura: o registro novo
 * PRIMEIRO, o histórico do antigo depois. Registro que não grava = nada
 * gravado (o antigo segue no registro, a skill repete). Histórico que não
 * grava depois do registro novo só avisa: o upsert do destino já trocou a
 * entrada do arquivo principal.
 */
export function applyBufferReplacementMark(deps: {
  persist: () => void;
  record: () => void;
  warn: (message: string) => void;
}): { ok: true } | { ok: false; error: string } {
  try {
    deps.persist();
  } catch (e) {
    return { ok: false, error: `registro do post novo não gravado (${(e as Error).message}): nada registrado nem arquivado; repita o --mark (#12279)` };
  }
  try {
    deps.record();
  } catch (e) {
    deps.warn(`post novo registrado, mas o histórico do antigo não foi gravado (${(e as Error).message}): uma cópia de conflito antiga ainda pode citá-lo (#12279)`);
  }
  return { ok: true };
}
