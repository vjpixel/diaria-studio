/**
 * Fases da substituição do vertical agendado (`--replace-scheduled`, #12279)
 * fora do laço de envio (#14327 item 5): o lock da troca, a escolha dos alvos
 * no registro e a fase destrutiva (dry-run com o manifesto próprio, ou o
 * consumo da autorização seguido do cancelamento dos posts antigos).
 *
 * O envio novo de cada alvo sai depois pelo laço normal de `mainUnlocked`
 * (`run.ts`), no horário preservado.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildReplacementManifest, planSha256, writeVideoPlanManifest } from "../lib/diaria/video-publish-plan.ts";
import { consumeBeforeExternalEffects } from "../lib/diaria/video-publish-authorization.ts";
import {
  applyReplacementTimes,
  planScheduledReplacements,
  REPLACE_MIN_LEAD_MS,
  replacementPublishCommand,
  replacementSurvivors,
  runScheduledReplacement,
  type ReplacementCancelResult,
  type ShortReplacementTarget,
} from "../lib/diaria/short-scheduled-replace.ts";
import type { loadResolvedFacebookPages } from "../lib/facebook-pages.ts";
import { facebookDestinationId, type ShortsPublishedFile } from "../lib/diaria/short-video.ts";
import { readShortsRegistry, recordShortReplacement } from "../lib/diaria/shorts-published-store.ts";
import { clearShortSending, clearShortSendingAll, openSendingMarks, readShortsSending } from "../lib/diaria/shorts-sending-marker.ts";
import { acquireTimerLock, TIMER_LOCK_HEARTBEAT_MS } from "../lib/diaria/timer-lock.ts";
import { defaultYouTubeUploadDeps, rescheduleScheduledVideo } from "../lib/diaria/youtube-upload.ts";
import type { ShortsPlan } from "./_shared.ts";
import { cancelFacebookScheduledVideo, defaultGraphDeps } from "./facebook.ts";
import { markReplaceCancelling, SHORTS_REPLACE_LOCK_FILE } from "./cli.ts";
import { buildShortsPlanManifest } from "./run-authorize.ts";

/**
 * #12279: o lock da substituição está vivo? (um `--replace-scheduled --publish` em
 * curso nesta máquina). Lock velho (processo morto há mais que o teto) é
 * reaproveitado e solto na hora, como nos timers.
 */
export function replaceLockBusy(dir: string, acquire: typeof acquireTimerLock = acquireTimerLock): "free" | "busy" | { unreadable: string } {
  const path = join(dir, SHORTS_REPLACE_LOCK_FILE);
  if (!existsSync(path)) return "free";
  let rel: (() => void) | null;
  try {
    rel = acquire(path, Date.now());
  } catch (e) {
    // Falha fechada: lock ilegível segura o --publish, com a mensagem própria.
    return { unreadable: `${path} ilegível (${(e as Error).message}): confira o arquivo e remova-o à mão se nenhuma troca estiver em curso` };
  }
  if (!rel) return "busy";
  rel();
  return "free";
}

/**
 * #12279: no `--publish` da rodada principal, a substituição toma o lock dela
 * (solto só no fim de `main`); qualquer outro `--publish` confere que nenhuma
 * troca está em curso. Devolve a função que solta o lock (`null` fora da troca)
 * ou o exit code da recusa. Nenhuma flag contorna.
 */
export function takeShortsReplaceLock(dir: string, replaceRun: boolean): { release: (() => void) | null } | number {
  if (replaceRun) {
    let rel: (() => void) | null = null;
    try {
      rel = acquireTimerLock(join(dir, SHORTS_REPLACE_LOCK_FILE), Date.now(), { heartbeatMs: TIMER_LOCK_HEARTBEAT_MS });
    } catch (e) {
      console.error(`publish-shorts: lock da substituição não tomado (${(e as Error).message}): nada feito (#12279)`);
      return 2;
    }
    if (!rel) {
      console.error("publish-shorts: outra substituição (--replace-scheduled --publish) está em curso nesta edição: nada feito (#12279)");
      return 2;
    }
    return { release: rel };
  }
  const lock = replaceLockBusy(dir);
  if (lock === "busy") {
    console.error("publish-shorts: substituição do vertical agendado (--replace-scheduled) em curso nesta edição: aguarde o desfecho dela antes de publicar (#12279)");
    return 2;
  }
  if (lock !== "free") {
    console.error(`publish-shorts: lock da substituição ${lock.unreadable}: nada publicado (#12279)`);
    return 2;
  }
  return { release: null };
}

export type ShortsReplaceSelection = {
  targets: ShortReplacementTarget[];
  skipped: ReturnType<typeof planScheduledReplacements>["skipped"];
  /** O registro sem os alvos: o plano trata cada alvo como não registrado. */
  planPublished: ShortsPublishedFile;
  /** `--only` do plano: só os destinos trocados. */
  planOnly: string[];
};

/**
 * #12279: a substituição escolhe os alvos no registro e planeja como se eles não estivessem
 * registrados (o envio novo é planejado; o post antigo só sai depois do consumo da autorização).
 * Devolve a seleção ou o exit code (vídeo novo inválido, seleção recusada, nada a trocar).
 */
export function selectShortsReplacement(input: {
  dir: string;
  aammdd: string;
  published: ShortsPublishedFile;
  onlyList: string[] | null;
  videoPath: string;
  file: Buffer | null;
  videoHash: string | null;
  duration: number | null;
  publish: boolean;
}): ShortsReplaceSelection | number {
  const { dir, aammdd, published, onlyList, videoPath, file, videoHash, duration } = input;
  if (!file || !videoHash || !duration) {
    console.error(`publish-shorts: --replace-scheduled exige o vídeo novo (V2) em MP4 válido: ${videoPath}${file ? " sem duração MP4 legível" : " ausente"} (--video PATH, num caminho próprio)`);
    return 2;
  }
  let selection: ReturnType<typeof planScheduledReplacements>;
  try {
    selection = planScheduledReplacements(published.entries, {
      now: new Date(),
      only: onlyList,
      videoSha256: videoHash,
      openMarks: openSendingMarks(readShortsSending(dir, aammdd), published.entries),
    });
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  for (const s of selection.skipped) console.error(`[aviso] ${s.destination}: não trocado — ${s.reason}`);
  if (!selection.targets.length) {
    console.error("publish-shorts: --replace-scheduled: nenhum post agendado a trocar (veja os avisos): nada feito");
    console.log(JSON.stringify({ dry_run: !input.publish, replace_scheduled: true, aammdd, video: videoPath, video_sha256: videoHash, targets: [], skipped: selection.skipped }, null, 2));
    return input.publish ? 1 : 0;
  }
  const targetDests = new Set(selection.targets.map((t) => t.destination));
  return {
    targets: selection.targets,
    skipped: selection.skipped,
    planPublished: { ...published, entries: published.entries.filter((e) => !targetDests.has(e.destination)) },
    planOnly: [...targetDests],
  };
}

/**
 * #12279: a substituição — plano com o horário PRESERVADO de cada post antigo, manifesto
 * próprio (o grant --replace-scheduled), e a fase destrutiva só depois do consumo.
 * No dry-run grava o manifesto e imprime o plano (exit code). No `--publish` consome a
 * autorização de TODOS os alvos antes da 1ª exclusão e cancela os posts antigos; devolve
 * o plano só com os alvos que recebem envio novo e o desfecho de cada cancelamento.
 */
export async function runShortsReplacePhase(input: {
  plan: ShortsPlan;
  dir: string;
  aammdd: string;
  publish: boolean;
  /** `--video` da linha de comando (entra no comando do dono da troca). */
  videoArg: string | undefined;
  videoPath: string;
  file: Buffer | null;
  videoHash: string | null;
  coverBytes: Buffer | null;
  replaceTargets: ShortReplacementTarget[];
  replaceSkipped: ShortsReplaceSelection["skipped"];
  ytMissing: string[];
  pages: ReturnType<typeof loadResolvedFacebookPages>["pages"];
  apiVersion: string;
}): Promise<{ plan: ShortsPlan; results: ReplacementCancelResult[] } | number> {
  const { dir, aammdd, file, videoHash, videoPath, replaceTargets, replaceSkipped, ytMissing, pages, apiVersion } = input;
  let plan = input.plan;
  const timed = applyReplacementTimes(plan.items, replaceTargets);
  if (!timed.ok) {
    console.error(`publish-shorts: --replace-scheduled: ${timed.error}`);
    return 2;
  }
  plan = { ...plan, items: timed.items };
  const ownerCommand = replacementPublishCommand(aammdd, { video: input.videoArg });
  const replacementManifest = (generatedAt?: string) =>
    buildReplacementManifest(
      buildShortsPlanManifest(plan, { editionDir: dir, videoBytes: file, coverBytes: input.coverBytes, ...(generatedAt ? { generatedAt } : {}) }),
      replaceTargets,
      ownerCommand,
    );
  if (!input.publish) {
    const manifest = replacementManifest(new Date().toISOString());
    const planHash = planSha256(manifest);
    try {
      const manifestPath = writeVideoPlanManifest(dir, manifest, { replacement: true });
      console.error(
        `[premissa] substituição do vertical agendado: plan_sha256 ${planHash} (${manifestPath}). Depois do "pode publicar" explícito do editor sobre ESTA troca: ` +
          `npx tsx scripts/video-publish-authorize.ts grant ${aammdd} --part vertical --replace-scheduled --plan-sha256 ${planHash} --confirmation "{resposta do editor}" e então ${ownerCommand} (#12279)`,
      );
    } catch (e) {
      // Sem o manifesto o grant recusa: o plano impresso não é aprovável, a rodada sai ≠0.
      console.error(`publish-shorts: manifesto da substituição não gravado (${(e as Error).message}): sem ele o grant recusa e o --publish não sai (#12279)`);
      console.log(JSON.stringify({ dry_run: true, replace_scheduled: true, aammdd, manifest_written: false, targets: replaceTargets, skipped: replaceSkipped }, null, 2));
      return 1;
    }
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          replace_scheduled: true,
          aammdd,
          video: videoPath,
          video_sha256: videoHash,
          targets: replaceTargets,
          skipped: replaceSkipped,
          items: plan.items,
          buffer_instructions: replaceTargets.some((t) => t.kind === "buffer")
            ? "X/TikTok: nada é apagado antes do --publish desta troca. Depois dele (results[] com pending_buffer_create), por destino: get_post do post antigo (conferir na fila, não enviado, dueAt igual ao horário do plano com mais de 30 min), delete_post, logo em seguida --mark-replaced DEST=buffer:ANTIGO, create_post com results[].buffer, e por fim --mark DEST=buffer:NOVO --replaces buffer:ANTIGO --scheduled-at HORÁRIO --video-sha256 HASH."
            : undefined,
          plan_sha256: planHash,
          plan_manifest: manifest,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  // --publish: o consumo da autorização de substituição de TODOS os alvos vem ANTES da 1ª exclusão.
  const authCommand = `npx tsx scripts/publish-shorts.ts ${process.argv.slice(2).join(" ")}`;
  const ytCreds = () => {
    if (ytMissing.length) throw new Error(`faltam ${ytMissing.join(", ")} no ambiente (rode scripts/youtube-oauth-setup.ts)`);
    return {
      clientId: (process.env.GOOGLE_CLIENT_ID ?? "").trim(),
      clientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
      refreshToken: (process.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
      channelId: (process.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
    };
  };
  const phase = await runScheduledReplacement(replaceTargets, {
    consume: () => {
      const auth = consumeBeforeExternalEffects({
        editionDir: dir, edition: aammdd,
        manifest: replacementManifest(),
        destinations: replaceTargets.map((t) => t.destination), now: new Date(), pid: process.pid, by: "publish-shorts --replace-scheduled --publish",
        command: authCommand,
        fallbackCommand: ownerCommand,
        replacement: true,
      });
      return auth.ok ? { ok: true } : { ok: false, error: auth.error };
    },
    stillRegistered: (t) => {
      const e = readShortsRegistry(dir, aammdd).entries.find((x) => x.destination === t.destination);
      return !!e && e.id === t.old_id && e.status === "scheduled" && !!e.scheduled_at && Date.parse(e.scheduled_at) === Date.parse(t.at);
    },
    cancel: async (t, onBeforeWrite) => {
      // A releitura confere também o horário do plano: post relido em outro horário não é tocado.
      if (t.destination === "youtube_shorts") {
        // YouTube: o antigo volta a private SEM agendamento (nada apagado; o editor apaga no Studio se quiser).
        await rescheduleScheduledVideo(defaultYouTubeUploadDeps, ytCreds(), t.old_id, null, REPLACE_MIN_LEAD_MS, { expectedAt: t.at, onBeforeWrite });
        return;
      }
      const page = pages.find((p) => facebookDestinationId(p.slug) === t.destination);
      if (!page || page.missing.length) throw new Error(`página ${t.destination} sem credencial (${page ? page.missing.join(", ") : "fora de publishing.social.facebook.pages"})`);
      await cancelFacebookScheduledVideo(defaultGraphDeps, page, apiVersion, t.old_id, REPLACE_MIN_LEAD_MS, { expectedAt: t.at, onBeforeWrite });
    },
    // Marca "cancelando" = marca de envio do destino: a releitura (video-publish-registry-status) e o dry-run a acusam.
    markCancelling: (t) => markReplaceCancelling(dir, aammdd, t.destination),
    clearCancelling: (d) => clearShortSending(dir, aammdd, "main", d),
    record: (t) => recordShortReplacement(dir, { destination: t.destination, id: t.old_id, scheduled_at: t.at, replaced_at: new Date().toISOString(), new_video_sha256: videoHash }),
    clearMarks: (d) => {
      clearShortSendingAll(dir, aammdd, d);
    },
    warn: (m) => console.error(`[aviso] ${m}`),
  });
  if (phase.refused !== null) {
    console.error(
      `publish-shorts --replace-scheduled: substituição recusada pela autorização do plano (#12279, #12654): ${phase.refused}. Nada foi apagado nem enviado. ` +
        `Para trocar: dry-run --replace-scheduled, plano (plan_sha256) ao editor, "pode publicar" explícito, ` +
        `npx tsx scripts/video-publish-authorize.ts grant ${aammdd} --part vertical --replace-scheduled --plan-sha256 {hash} --confirmation "{resposta do editor}" e só então o comando.`,
    );
    console.log(JSON.stringify({ dry_run: false, replace_scheduled: true, aammdd, refused: phase.refused, targets: replaceTargets }, null, 2));
    return 2;
  }
  console.error(`[ok] autorização de substituição consumida (uso único): ${replaceTargets.map((t) => t.destination).join(", ")} (#12279)`);
  const results = phase.results;
  for (const r of results) {
    if (r.outcome === "cancelled") console.error(`[ok] ${r.target.destination}: post antigo ${r.target.old_id} cancelado; envio novo no horário preservado ${r.target.at}`);
    else if (r.outcome === "failed" || r.outcome === "uncertain") console.error(`[erro] ${r.target.destination}: ${r.error}`);
  }
  // Só o alvo cancelado (API) ou da Buffer recebe envio novo; falha e incerteza entram em results (exit ≠ 0).
  const going = replacementSurvivors(results);
  return { plan: { ...plan, items: plan.items.filter((i) => going.has(i.destination)) }, results };
}
