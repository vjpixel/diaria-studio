/**
 * Threads pessoal: etapa do vídeo no perfil no laço do `--publish` (#14204).
 *
 * Extraída de `mainUnlocked` (`run.ts`) sem mudar a lógica: a conferência do
 * perfil antes de enviar (#11410/#11742) e o envio com a resposta do link do
 * horizontal (#13117).
 */
import { THREADS_PROFILE_DESTINATION, publishThreadsProfileVideo, threadsProfilePreflight } from "../lib/threads-personal-video.ts";
import { sameDayOtherRegisteredIds, threadsProfilePreflightInput } from "./confirm.ts";
import type { ShortsPublishItem, ShortsSendContext, ShortsSendIo, ShortsSendStep } from "./send-context.ts";

/** I/O da etapa do Threads (trocável nos testes). */
export interface ThreadsSendDeps {
  preflight: typeof threadsProfilePreflight;
  publish: typeof publishThreadsProfileVideo;
  sameDayOtherIds: typeof sameDayOtherRegisteredIds;
}

const defaultThreadsSendDeps: ThreadsSendDeps = {
  preflight: threadsProfilePreflight,
  publish: publishThreadsProfileVideo,
  sameDayOtherIds: sameDayOtherRegisteredIds,
};

/**
 * #14204: etapa do `threads_profile`. Sem credencial lança (o plano não marca
 * `publish` sem ela). Vídeo do dia já no perfil: registra e não publica de
 * novo (`settled`); registro que falha nesse caso deixa o marcador de envio
 * (o vídeo está no perfil e o registro não diz).
 */
export async function sendThreadsProfileItem(
  ctx: ShortsSendContext,
  item: ShortsPublishItem,
  io: ShortsSendIo,
  deps: ThreadsSendDeps = defaultThreadsSendDeps,
): Promise<ShortsSendStep> {
  const { threadsCreds, corte, aammdd, plan } = ctx;
  if (!threadsCreds.ready) throw new Error(threadsCreds.reason); // o plano não marca publish sem credencial
  // #11410: confere o perfil antes — um post à mão (depois de um
  // skip_late) ou de uma rodada sem registro sincronizado não está no
  // registro, mas está no perfil. Falha de leitura nunca vira "não está lá".
  // #11742: em TODA rodada, não só na do timer: a task one-shot do app
  // desktop com o config defasado corria com o timer do 300 no mesmo minuto.
  const pre = await deps.preflight({
    creds: threadsCreds.creds,
    ...threadsProfilePreflightInput({
      aammdd,
      // 1ª linha do texto = o título do D1 (ou do corte) como o post o leva (cortado com … se não coube).
      caption: item.caption,
      corte: corte !== null,
      sameDayOtherIds: deps.sameDayOtherIds(corte?.slug ?? null, aammdd, THREADS_PROFILE_DESTINATION),
    }),
    now: () => new Date(),
  });
  if (pre.kind === "already") {
    try {
      ctx.registry.persist(pre.entry);
    } catch (e) {
      console.error(`[erro] threads_profile: o vídeo JÁ ESTÁ no perfil (${pre.entry.url ?? pre.entry.id}) mas o registro não foi gravado: ${(e as Error).message}`);
      // marca de envio fica: o vídeo está no perfil e o registro não diz
      return { kind: "settled", result: { destination: item.destination, ok: false, entry: pre.entry, error: `registro não gravado: ${(e as Error).message}`, cause: "preflight" } };
    }
    io.clearSending();
    console.error(`[aviso] threads_profile: o vídeo da edição já está no perfil (${pre.entry.url ?? pre.entry.id}) — registrado, não publica de novo`);
    if (plan.horizontalLinks?.threads_profile?.replyText) console.error(`[aviso] Threads: confira se o post existente tem a resposta "${plan.horizontalLinks.threads_profile.replyText}"; complete à mão se faltar (#13117).`);
    return { kind: "settled", result: { destination: item.destination, ok: true, entry: pre.entry, alreadyRegistered: true } };
  }
  const outcome = await deps.publish({
    creds: threadsCreds.creds,
    videoUrl: await ctx.uploadVideo(),
    text: item.caption,
    replyText: plan.horizontalLinks?.threads_profile?.replyText,
    deps: { now: () => new Date() },
  });
  return { kind: "outcome", outcome };
}
