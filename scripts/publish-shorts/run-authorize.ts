/**
 * Fases da rodada que ficam entre o plano e o envio (#14327 item 5): o manifesto
 * do plano (`plan_sha256`) que o dry-run grava e o `--publish` confere, o
 * consumo da autorização do plano antes da 1ª escrita externa (#12654) e a
 * gravação fail-soft do KV de `diar.ia.br/video` (#12735, #13709).
 *
 * As condições de cada fase (`planGated`, `!replaceRun`, `gatedActing`) seguem
 * em `mainUnlocked` (`run.ts`): aqui mora só o corpo.
 */
import { publishConfirmSuffix } from "../lib/diaria/publish-confirm.ts";
import {
  buildVerticalManifest,
  PAGE_REPOST_DESTINATION,
  planSha256,
  readVideoPlanSources,
  sha256Hex,
  VERTICAL_RUN_ACTIONS,
  writeVideoPlanManifest,
  type VideoPlanManifest,
} from "../lib/diaria/video-publish-plan.ts";
import { authorizationRefusalMessage, consumeBeforeExternalEffects } from "../lib/diaria/video-publish-authorization.ts";
import { alarmTaskAuthorizationRefusal } from "../lib/diaria/video-publish-authorization-alarm.ts";
import { linkedInPostUrnFrom } from "../lib/diaria/linkedin-page-actions.ts";
import type { ShortsPublishedFile } from "../lib/diaria/short-video.ts";
import {
  describeEditionVideoOutcome,
  describeLatestVideoOutcome,
  pollKvFromEnv,
  updateEditionVideoRedirect,
  updateLatestVideoRedirect,
} from "../set-latest-video-redirect.ts";
import { ROOT, type ShortsPlan, type ShortsPlanItem } from "./_shared.ts";

/**
 * #12654: manifesto canônico do plano do vertical da edição (hashes dos bytes
 * do vídeo e da capa, título/descrição do Short, horário e modo/instante
 * efetivo por destino, texto de cada destino, dono/comando, fontes
 * editoriais). O dry-run grava e imprime o `plan_sha256` que o editor aprova;
 * o `--publish` (rodada principal e task one-shot) recalcula e confere a
 * projeção de cada destino que vai agir antes de qualquer escrita externa
 * (leituras com credencial, como a Graph e a fila do Worker para a grade,
 * acontecem antes, no plano). Só no modo edição: o corte tem a autorização
 * própria (#11912) e os timers do 300 a da config que os ligou (#11741).
 */
export function buildShortsPlanManifest(
  plan: ShortsPlan,
  input: { editionDir: string; videoBytes: Buffer | null; coverBytes: Buffer | null; generatedAt?: string },
): VideoPlanManifest {
  return buildVerticalManifest({
    aammdd: plan.aammdd,
    items: plan.items,
    owners: plan.owners,
    destinationAt: (id) => plan.destinationTimes[id]?.at ?? plan.shortTime.at,
    horizontalLink: (id) => plan.horizontalLinks?.[id]?.link ?? null,
    metadata: { title: plan.youtube.title, description: plan.youtube.description },
    media: {
      video_sha256: input.videoBytes ? sha256Hex(input.videoBytes) : null,
      cover_sha256: input.coverBytes ? sha256Hex(input.coverBytes) : null,
      captions_sha256: null, // o vertical não sobe legenda em arquivo: o texto de cada destino está em `content`
    },
    sources: readVideoPlanSources(input.editionDir),
    publishCommand: shortsMainPublishCommand(plan.aammdd),
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  });
}

/** #12654: o comando da rodada principal do vertical (dono dos destinos que saem nela). */
export function shortsMainPublishCommand(aammdd: string): string {
  return `npx tsx scripts/publish-shorts.ts ${aammdd} --publish ${publishConfirmSuffix(aammdd)}`;
}

/**
 * #12654: destinos que esta rodada `--publish` executa (escrita externa pelo
 * publisher): publish/enqueue/buffer e o repost da página quando ele vai à
 * fila do Worker (guiado, Worker configurado e o vídeo do perfil conhecido no
 * registro ou saindo nesta rodada). Cada um consome a sua autorização antes do
 * 1º efeito; com a lista vazia a rodada não faz escrita externa nenhuma.
 */
export function shortsRunDestinations(
  items: readonly ShortsPlanItem[],
  opts: { repostViaWorker?: boolean; profileUrnKnown?: boolean } = {},
): string[] {
  const run = items.filter((i) => VERTICAL_RUN_ACTIONS.has(i.action)).map((i) => i.destination);
  const repost = items.some((i) => i.destination === PAGE_REPOST_DESTINATION && i.action === "guided");
  const profileThisRun = run.includes("linkedin_profile");
  if (repost && opts.repostViaWorker === true && (opts.profileUrnKnown === true || profileThisRun)) run.push(PAGE_REPOST_DESTINATION);
  return run;
}

/**
 * #12654: no dry-run da rodada com autorização, o manifesto do plano e o
 * `plan_sha256` que vão no JSON. Só a rodada de plano inteiro (sem `--only`)
 * grava o manifesto que o grant lê. Sem `planGated` (corte, timers do 300), nada.
 */
export function shortsPlanDryRunManifest(input: {
  plan: ShortsPlan;
  dir: string;
  aammdd: string;
  planGated: boolean;
  partial: boolean;
  file: Buffer | null;
  coverBytes: Buffer | null;
}): { plan_sha256: string; plan_manifest: VideoPlanManifest } | Record<string, never> {
  const { plan, dir, aammdd } = input;
  if (!input.planGated) return {};
  const manifest = buildShortsPlanManifest(plan, { editionDir: dir, videoBytes: input.file, coverBytes: input.coverBytes, generatedAt: new Date().toISOString() });
  const planHash = planSha256(manifest);
  // Só a rodada de plano inteiro grava o manifesto que o grant lê (um --only parcial não substitui o plano da parte).
  if (!input.partial) {
    try {
      const manifestPath = writeVideoPlanManifest(dir, manifest);
      console.error(`[premissa] plano do vertical: plan_sha256 ${planHash} (${manifestPath}). Depois do "pode publicar" explícito do editor sobre ESTE plano: npx tsx scripts/video-publish-authorize.ts grant ${aammdd} --part vertical --plan-sha256 ${planHash} --confirmation "{resposta do editor}" (#12654)`);
    } catch (e) {
      console.error(`[aviso] manifesto do plano não gravado (${(e as Error).message}): sem ele o grant recusa e o --publish não sai (#12654)`);
    }
  } else {
    console.error(`[premissa] plano parcial (--only): plan_sha256 ${planHash} só confere; o manifesto da parte não é regravado (#12654)`);
  }
  return { plan_sha256: planHash, plan_manifest: manifest };
}

/**
 * #12654: confere e consome (uso único) a autorização de cada destino que esta
 * rodada executa, com o manifesto recalculado agora, ANTES da 1ª escrita
 * externa (KV do link da bio, R2, APIs, fila do Worker). Devolve os destinos
 * que agem (lista vazia = nenhuma escrita externa) ou o exit code da recusa.
 */
export async function consumeShortsPlanAuthorization(input: {
  plan: ShortsPlan;
  dir: string;
  aammdd: string;
  file: Buffer;
  coverBytes: Buffer | null;
  published: ShortsPublishedFile;
  repostViaWorker: boolean;
  forceNow: boolean;
}): Promise<{ acting: string[] } | number> {
  const { plan, dir, aammdd, file } = input;
  const acting = shortsRunDestinations(plan.items, {
    repostViaWorker: input.repostViaWorker,
    profileUrnKnown: linkedInPostUrnFrom(input.published.entries.find((e) => e.destination === "linkedin_profile")) !== null,
  });
  if (acting.length) {
    const authCommand = `npx tsx scripts/publish-shorts.ts ${process.argv.slice(2).join(" ")}`;
    const auth = consumeBeforeExternalEffects({
      editionDir: dir, edition: aammdd,
      manifest: buildShortsPlanManifest(plan, { editionDir: dir, videoBytes: file, coverBytes: input.coverBytes }),
      destinations: acting, now: new Date(), pid: process.pid, by: "publish-shorts --publish",
      command: authCommand,
      fallbackCommand: shortsMainPublishCommand(aammdd),
      forceNow: input.forceNow,
    });
    if (!auth.ok) {
      console.error(authorizationRefusalMessage("publish-shorts", "vertical", aammdd, auth.error));
      // #12859: a task one-shot roda sem ninguém olhando; a recusa dela vira alarme ao editor.
      await alarmTaskAuthorizationRefusal({ editionDir: dir, aammdd, part: "vertical", command: authCommand, refusals: auth.refusals ?? [], notifyDeps: { cwd: ROOT } });
      return 2;
    }
    console.error(`[ok] autorização do plano consumida (uso único): ${auth.consumed.map((a) => a.destination).join(", ")} (#12654)`);
  } else {
    console.error("[premissa] nenhum destino sai por esta rodada: nenhuma autorização consumida e nenhuma escrita externa (KV do diar.ia.br/video, fila do Worker); os adiados saem pelos donos do owners[], cada um com a sua (#12654)");
  }
  return { acting };
}

/**
 * #12735: o link fixo da bio (diar.ia.br/video) passa a apontar para o horizontal desta edição.
 * Fail-soft: o vertical sai mesmo sem o KV; a gravação só avança (edição anterior não sobrescreve).
 * #12786: só a rodada principal; as dos timers do 300 não leem nem gravam o KV (a condição fica em `mainUnlocked`).
 */
export async function updateShortVideoRedirects(dir: string, aammdd: string): Promise<void> {
  try {
    const kvEnv = pollKvFromEnv();
    if (!kvEnv.kv) console.error(`[aviso] diar.ia.br/video não atualizado: ${kvEnv.reason} — rode set-latest-video-redirect.ts ${aammdd} --apply (#12735)`);
    else {
      try {
        console.error(`[ok] ${describeLatestVideoOutcome(await updateLatestVideoRedirect({ editionDir: dir, aammdd, kv: kvEnv.kv, apply: true, now: new Date() }))} (#12735)`);
      } catch (e) {
        console.error(`[aviso] diar.ia.br/video não atualizado: ${(e as Error).message} — rode set-latest-video-redirect.ts ${aammdd} --apply (#12735)`);
      }
      // #13709: o link por edição do 1º comentário (Instagram) e da resposta (Threads), independente do mais recente.
      try {
        console.error(`[ok] ${describeEditionVideoOutcome(aammdd, await updateEditionVideoRedirect({ editionDir: dir, aammdd, kv: kvEnv.kv, apply: true, now: new Date() }))}`);
      } catch (e) {
        console.error(`[aviso] diar.ia.br/video/${aammdd} não atualizado: ${(e as Error).message} — o link do 1º comentário cai na lista do canal; rode set-latest-video-redirect.ts ${aammdd} --apply (#13709)`);
      }
    }
  } catch (e) {
    console.error(`[aviso] diar.ia.br/video não atualizado: ${(e as Error).message} — rode set-latest-video-redirect.ts ${aammdd} --apply (#12735)`);
  }
}
