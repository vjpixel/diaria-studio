/**
 * Execução da rodada: `main` (lock da substituição) e `mainUnlocked`, que orquestra
 * a rodada e o laço de envio. O envio de cada destino é uma etapa no módulo dele
 * (#14204), escolhida por `sendDestinationItem`; o laço guarda a releitura do
 * registro, o marcador de envio, a recusa e o pós-envio comum.
 * #14327: as fases que não são destino saíram para `run-args.ts` (argumentos,
 * corte avulso, confirmação, pasta e escritor), `run-drive.ts` (`--from-drive`),
 * `run-plan.ts` (config, credenciais e o plano), `run-replace.ts` (lock, alvos
 * e fase destrutiva da troca), `run-authorize.ts` (manifesto do dry-run,
 * consumo da autorização do plano, KV do /video) e `run-corte.ts`
 * (autorização e lock do timer do corte); as condições e a ordem de cada uma
 * seguem aqui, travadas por `test/publish-shorts-run-phases-14327.test.ts`.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054); a entrada reexporta o que os
 * testes e os outros scripts importam.
 */
import { cleanupPublishedVideo, recordCredentialSkips } from "../lib/diaria/published-video-cleanup.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PAGE_REPOST_DESTINATION, sha256Hex } from "../lib/diaria/video-publish-plan.ts";
import {
  afterCancelMessage,
  replacementUploadRefusal,
  type ReplacementCancelResult,
  type ShortReplacementTarget,
} from "../lib/diaria/short-scheduled-replace.ts";
import { CORTE_SPEC_FILE, corteR2Key, resolveCorteVideo, parseCorteSpec } from "../lib/diaria/short-corte.ts";
import {
  facebookUploadRoute,
  knownDestinationIds,
  loadShortsConfig,
  mp4DurationSeconds,
  shortVideoFileName,
  type ShortPublishedEntry,
  type ShortsPublishedFile,
} from "../lib/diaria/short-video.ts";
import { alarmYouTubeAudioDegraded, notifyYouTubeAudioDegraded, type YouTubeAudioAlarmFn } from "../lib/diaria/youtube-audio-check.ts";
import {
  instagramTimerScopeError,
  linkedinTimerScopeError,
  threadsTimerScopeError,
  persistShortEntry,
  readShortsRegistry,
  shortsRegistryPath,
} from "../lib/diaria/shorts-published-store.ts";
import { clearShortSending, markShortSending } from "../lib/diaria/shorts-sending-marker.ts";
import { reuseOrUploadToR2 } from "../lib/r2-object-upload.ts";
import { postToWorkerQueue } from "../lib/worker-queue-client.ts";
import { resolveShortEntryState } from "../lib/publish-state.ts";
import { withMissingCoverRecord } from "../lib/diaria/short-cover.ts";
import { THREADS_PROFILE_DESTINATION, ThreadsTimerGateError } from "../lib/threads-personal-video.ts";
import { ROOT, shouldUpdateLatestVideoOnPublish, assignShortsDestinationOwners, ownersContextAfterPublish } from "./_shared.ts";
import { uploadCoverOrFallback, type ReelCoverUpload, prepareInstagramChromeStep } from "./instagram.ts";
import { blockRepostOnProfileFailure, sendLinkedInProfileItem, sendPageRepostStep } from "./linkedin.ts";
import { defaultGraphDeps, type PublishOutcome, sendFacebookItem } from "./facebook.ts";
import { InstagramTimerGateError } from "./instagram-confirm.ts";
import { youtubeShortUploadFile, youtubeShortsPrepareBeforeMarker, youtubeShortUrl, sendYouTubeShortItem } from "./youtube.ts";
import { sendThreadsProfileItem } from "./threads.ts";
import { sendInstagramQueueItem, sendInstagramReelItem } from "./instagram-send.ts";
import { type ShortsEnqueueItem, type ShortsPublishItem, type ShortsRunResult, type ShortsSendContext, type ShortsSendStep, linkedInSendCreds, shortsResult, shortsResultEntry } from "./send-context.ts";
import { recheckBeforePublish } from "./run-checks.ts";
import { sendBufferItem } from "./buffer.ts";
import { runUpdateScheduled } from "./update-scheduled.ts";
import { runMark, runMarkReplaced } from "./mark.ts";
import { configuredThreadsViaTimer, configuredInstagramBackend } from "./cli.ts";
import { syncCorteAgendamento, syncCorteAgendamentoFailSoft } from "./corte.ts";
import { runUpdatePublished } from "./update-published.ts";
import { credentialSkippedItems, confirmInstagram } from "./confirm.ts";
import { consumeShortsPlanAuthorization, shortsPlanDryRunManifest, updateShortVideoRedirects } from "./run-authorize.ts";
import { runShortsReplacePhase, selectShortsReplacement, takeShortsReplaceLock, type ShortsReplaceSelection } from "./run-replace.ts";
import { resolveShortsRunTarget } from "./run-args.ts";
import { fetchShortsVideoFromDrive } from "./run-drive.ts";
import { buildShortsRunPlan } from "./run-plan.ts";
import { authorizeCortePublish, takeCorteManualLock } from "./run-corte.ts";

// #14204: a etapa do YouTube mora em youtube.ts; a entrada reexporta daqui.
export { replacedYouTubeIds } from "./youtube.ts";

// #14327: o manifesto, o consumo da autorização do plano e o KV do /video moram em
// run-authorize.ts; o lock e as fases da substituição, em run-replace.ts.
export { buildShortsPlanManifest, shortsMainPublishCommand, shortsRunDestinations } from "./run-authorize.ts";
export { replaceLockBusy } from "./run-replace.ts";

let releaseReplaceLock: () => void = () => {};

export async function main(): Promise<number> {
  try {
    return await mainUnlocked();
  } finally {
    // #12279: o lock da substituição vive a rodada inteira (do consumo da autorização ao último envio).
    releaseReplaceLock();
  }
}

/**
 * #14204: a etapa de cada destino de API do laço do `--publish` (o item já
 * passou pela releitura do registro e tem o marcador de envio gravado). A
 * ordem das condições é a do laço inline de antes: `enqueue` (fila do Worker
 * do Instagram) primeiro, Facebook por último (todo destino de API que sobra é
 * uma página). Exceção = recusa, tratada pelo laço. #14327: o marcador de
 * envio é do laço (`settled.marker`); a etapa não o recebe.
 */
export async function sendDestinationItem(
  ctx: ShortsSendContext,
  item: ShortsPublishItem | ShortsEnqueueItem,
  ytUpload: { file: Buffer; firstFrame: { ms: number } | null } | null,
): Promise<ShortsSendStep> {
  if (item.action === "enqueue") return sendInstagramQueueItem(ctx, item);
  if (item.destination === "linkedin_profile") return sendLinkedInProfileItem(ctx, item);
  if (item.destination === "youtube_shorts") return sendYouTubeShortItem(ctx, item, ytUpload);
  if (item.destination === THREADS_PROFILE_DESTINATION) return sendThreadsProfileItem(ctx, item);
  if (item.destination === "instagram") return sendInstagramReelItem(ctx, item);
  return sendFacebookItem(ctx, item);
}

async function mainUnlocked(): Promise<number> {
  // #14327: argumentos, corte avulso, confirmação do --publish, pasta e escritor em run-args.ts.
  const target = await resolveShortsRunTarget(process.argv.slice(2));
  if (typeof target === "number") return target;
  const { flags, values, aammdd, corteOutside, corteRevocations, requireCorteAuth, replaceRun, dir, editionDirOverride, unwatchedEditionWarning, linkedinTimer, instagramTimer, threadsTimer, writer } = target;
  let corte = target.corte;
  const revokedOut = () => (corteRevocations.length ? { corte_authorization_revoked: corteRevocations } : {});
  // #13403: alarme do áudio degradado do youtube_shorts (disparado depois de gravar o registro).
  const notifyAudioDegraded: YouTubeAudioAlarmFn = (check, ctx) => notifyYouTubeAudioDegraded(check, ctx, { cwd: ROOT });
  const publishedPath = shortsRegistryPath(dir, writer);
  let published = readShortsRegistry(dir, aammdd);
  // #11795: o vídeo do corte é do editor (ou da pasta de cortes) — a limpeza do vertical da edição nunca o apaga.
  const cleanup = () => {
    if (corte) return;
    cleanupPublishedVideo({ dir, edition: aammdd, kind: "vertical",
      config: () => loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))),
      keepVideo: flags.has("keep-video"), log: console.error });
  };
  const persist = (entry: ShortPublishedEntry): ShortsPublishedFile => persistShortEntry(dir, aammdd, writer, entry);

  // #12279: a substituição segura o lock a rodada inteira, e o lock vale para qualquer --publish
  // da rodada principal (inclusive o --update-scheduled): nenhuma flag o contorna.
  if (flags.has("publish") && !corte && writer === "main") {
    const lock = takeShortsReplaceLock(dir, replaceRun); // #14327: run-replace.ts
    if (typeof lock === "number") return lock;
    if (lock.release) {
      releaseReplaceLock = lock.release;
      // Relido sob o lock: a leitura do início pode estar velha.
      published = readShortsRegistry(dir, aammdd);
    }
  }

  // #14327: --mark-replaced e --mark moram em mark.ts.
  if (values["mark-replaced"] !== undefined) return runMarkReplaced({ dir, aammdd, markReplaced: values["mark-replaced"] });
  if (values["mark"]) {
    return runMark({ dir, aammdd, markArg: values["mark"], values, corte, linkedinTimer, instagramTimer, threadsTimer, published, persist, cleanup });
  }

  // #11159/#11265: a rodada de um timer só toca o destino dele — checado antes
  // de qualquer download, chamada de API ou gravação.
  const onlyList = values["only"] ? values["only"].split(",").map((s) => s.trim()).filter(Boolean) : null;
  const scopeErr =
    linkedinTimerScopeError({ linkedinTimer, only: onlyList, confirmInstagram: flags.has("confirm-instagram") }) ??
    instagramTimerScopeError({ instagramTimer, backend: configuredInstagramBackend(), linkedinTimer, only: onlyList, confirmInstagram: flags.has("confirm-instagram") }) ??
    threadsTimerScopeError({ threadsTimer, viaTimer: configuredThreadsViaTimer(), only: onlyList, confirmInstagram: flags.has("confirm-instagram") });
  if (scopeErr) {
    console.error(`publish-shorts: ${scopeErr}`);
    return 2;
  }

  if (flags.has("update-published")) return runUpdatePublished({ dir, aammdd, corteSlug: null, values, only: onlyList });

  if (flags.has("update-scheduled")) {
    if (linkedinTimer || instagramTimer || threadsTimer || flags.has("confirm-instagram")) {
      console.error("publish-shorts: --update-scheduled não combina com os timers nem com --confirm-instagram");
      return 2;
    }
    return runUpdateScheduled({ dir, aammdd, corte, publish: flags.has("publish"), only: onlyList, published, persist, corteRevocations });
  }

  if (flags.has("confirm-instagram")) {
    const result = await confirmInstagram(aammdd, dir, persist, published, values["since"], values["media-id"], values["edition-url"], values["url"]);
    if (result === 0) cleanup();
    return result;
  }

  const reviewedPath = join(dir, "02-reviewed.md");
  if (!corte && !existsSync(reviewedPath)) {
    console.error(`publish-shorts: ${reviewedPath} não existe`);
    return 1;
  }
  const videoPath = corte ? resolveCorteVideo(dir, corte.video) : resolve(values["video"] ?? join(dir, shortVideoFileName(aammdd)));
  if (values["from-drive"]) {
    // #14327: download protegido e reconferência do "pode publicar" do corte, em run-drive.ts.
    const drive = await fetchShortsVideoFromDrive({
      driveId: values["from-drive"], dir, aammdd, videoPath, replaceRun, corte, requireCorteAuth, cleanup,
      onRevoked: (r) => corteRevocations.push(r),
    });
    if (typeof drive === "number") return drive;
    corte = drive.corte;
  }
  const videoExists = existsSync(videoPath);
  // #10893: a duração decide já no plano (dry-run incluso) se o Instagram vai pela API ou vira passo guiado.
  const file = videoExists ? readFileSync(videoPath) : null;
  const duration = file ? mp4DurationSeconds(file) : null;
  // #12279: hash dos bytes de origem (o que o plano aprova e o registro guarda por destino).
  const videoHash = file ? sha256Hex(file) : null;
  // #12279: a substituição escolhe os alvos no registro e planeja como se eles não estivessem
  // registrados (o envio novo é planejado; o post antigo só sai depois do consumo da autorização).
  let replaceTargets: ShortReplacementTarget[] = [];
  let replaceSkipped: ShortsReplaceSelection["skipped"] = [];
  let planPublished = published;
  let planOnly = onlyList;
  if (replaceRun) {
    const selection = selectShortsReplacement({ dir, aammdd, published, onlyList, videoPath, file, videoHash, duration, publish: flags.has("publish") }); // #14327: run-replace.ts
    if (typeof selection === "number") return selection;
    ({ targets: replaceTargets, skipped: replaceSkipped, planPublished, planOnly } = selection);
  }
  // #14327: config, credenciais, grade, capa e o plano (com premissas e avisos impressos), em run-plan.ts.
  const planned = await buildShortsRunPlan({
    aammdd, dir, corte, corteOutside, requireCorteAuth, editionDirOverride, unwatchedEditionWarning, writer, replaceRun,
    editionUrlArg: values["edition-url"], forceNow: flags.has("now"), reviewedPath, videoPath, videoExists, duration, videoHash,
    published, planPublished, planOnly,
  });
  if (typeof planned === "number") return planned;
  const { config, pages, apiVersion, igApiVersion, shortsCfg, igAuthor, workerUrl, workerToken, r2, liCreds, liApiVersion, threadsCreds, ytMissing, shortCover, bufferOffsetMs } = planned;
  let plan = planned.plan;

  // #12279: a substituição — plano com o horário PRESERVADO de cada post antigo, manifesto
  // próprio (o grant --replace-scheduled), e a fase destrutiva só depois do consumo.
  let replaceResults: ReplacementCancelResult[] = [];
  if (replaceRun) {
    // #14327: dry-run da troca (sai aqui) ou consumo + cancelamento dos posts antigos, em run-replace.ts.
    const phase = await runShortsReplacePhase({
      plan, dir, aammdd, publish: flags.has("publish"), videoArg: values["video"], videoPath, file, videoHash,
      coverBytes: shortCover.bytes, replaceTargets, replaceSkipped, ytMissing, pages, apiVersion,
    });
    if (typeof phase === "number") return phase;
    ({ plan, results: replaceResults } = phase);
  }

  // #12654: o plano da edição (fora do corte e dos timers do 300) passa pela autorização por hash.
  // #12279: a substituição já consumiu a autorização dela acima (no mesmo processo, sob o lock).
  const planGated = !corte && writer === "main";
  if (!flags.has("publish")) {
    // #14327: o manifesto e o plan_sha256 do dry-run vêm de run-authorize.ts; a impressão fica aqui.
    const planOut = shortsPlanDryRunManifest({ plan, dir, aammdd, planGated, partial: onlyList !== null, file, coverBytes: shortCover.bytes });
    console.log(JSON.stringify({ dry_run: true, ...plan, ...revokedOut(), ...planOut }, null, 2));
    return 0;
  }
  if (!file) {
    console.error(`publish-shorts: vídeo curto ausente em ${videoPath}`);
    return 1;
  }
  // #12654: destinos com escrita externa nesta rodada. Fora do plano com autorização (corte, timers) vale tudo como antes.
  let gatedActing: string[] | null = null;
  if (planGated && !replaceRun) {
    // #14327: consumo (uso único) antes da 1ª escrita externa, em run-authorize.ts.
    const auth = await consumeShortsPlanAuthorization({
      plan, dir, aammdd, file, coverBytes: shortCover.bytes, published,
      repostViaWorker: Boolean(workerUrl && workerToken),
      forceNow: flags.has("now"),
    });
    if (typeof auth === "number") return auth;
    gatedActing = auth.acting;
  }
  if (shouldUpdateLatestVideoOnPublish({ corte: !!corte, writer }) && !replaceRun && (gatedActing === null || gatedActing.length > 0)) {
    // #12735/#12786/#13709: link fixo da bio e link por edição, fail-soft, em run-authorize.ts.
    await updateShortVideoRedirects(dir, aammdd);
  }
  // #11912: só o --publish confirmado do corte grava o "pode publicar" (e o --only usado) no
  // corte.json; o timer do 300 não publica sem ele. Dry-run, --mark e --update-scheduled já
  // saíram acima. Fica DEPOIS de todas as validações que abortam (confirmação, escopo dos
  // timers, plano com o --only, vídeo) e ANTES do 1º envio.
  if (corte) {
    // #14327: conferência (filho do timer) ou gravação da autorização, em run-corte.ts.
    const refused = authorizeCortePublish({
      corte, dir, file, coverBytes: shortCover.bytes, coverUnreadable: shortCover.unreadable, requireCorteAuth,
      onlyArg: values["only"], onlyList, known: knownDestinationIds(shortsCfg),
    });
    if (refused !== null) return refused;
  }
  console.error(`[premissa] duração ${duration === null ? "desconhecida" : `${duration.toFixed(1)} s`} → Facebook via ${facebookUploadRoute(duration)}`);
  const deps = defaultGraphDeps;
  const results: ShortsRunResult[] = [];
  // #12279 (F1 do review da PR #13107): falha ou incerteza do cancelamento entra no resultado e no exit code.
  for (const r of replaceResults) {
    if (r.outcome === "failed" || r.outcome === "uncertain") {
      results.push(shortsResult.failed(r.target.destination, r.error, { phase: r.phase, ...(r.outcome === "uncertain" ? { uncertain: true as const } : {}) }));
    }
  }
  // Sobe o vertical no máximo uma vez por rodada (Instagram agendado, X e Threads pessoal usam).
  // #11410/#11432: objeto do dia já no bucket com o mesmo conteúdo (tamanho e ETag) é reaproveitado (sem novo PUT).
  // #11355: memo por chave, porque o corte do Instagram tem objeto próprio.
  const uploadedByKey = new Map<string, Promise<string>>();
  // #11774: chaves do R2 que esta rodada usa (capa e vertical); a poda de retenção
  // de `shorts/` no upload seguinte não as apaga, mesmo de edição com mais de 7 dias.
  const r2KeysInUse = new Set<string>();
  const uploadVideoAt = (key: string) => {
    if (!r2.ready) throw new Error(`R2 não configurado (${r2.missing.join(", ")})`);
    let uploaded = uploadedByKey.get(key);
    if (!uploaded) {
      r2KeysInUse.add(key);
      uploaded = reuseOrUploadToR2({ fetch: (u, i) => fetch(u, i), now: () => new Date() }, r2.config, key, file, "video/mp4", { keep: [...r2KeysInUse] }).then((r) => {
        console.error(`[ok] vertical no R2 ${r.reused ? "reaproveitado (mesmo conteúdo, sem novo upload)" : "enviado"}: ${r.url}`);
        return r.url;
      });
      uploadedByKey.set(key, uploaded);
    }
    return uploaded;
  };
  // #12279: o vídeo novo da substituição vai para uma chave PRÓPRIA no R2: sobrescrever a do dia
  // trocaria os bytes por trás de um post que ainda aponta para ela (Reels na fila, X agendado).
  const uploadVideo = () =>
    uploadVideoAt(corte ? corteR2Key(corte.slug, "video") : replaceRun && videoHash ? `shorts/${aammdd}-replace-${videoHash.slice(0, 12)}.mp4` : `shorts/${shortVideoFileName(aammdd)}`);
  // #12279: o post antigo de cada alvo (o recheck e a mensagem de falha o citam).
  const replaceTargetOf = (dest: string) => (replaceRun ? replaceTargets.find((t) => t.destination === dest) : undefined);
  let uploadedCover: Promise<ReelCoverUpload> | undefined;
  const uploadCover = async (): Promise<ReelCoverUpload> => {
    // #11912: sobe os bytes já lidos (os mesmos da impressão digital do corte), sem reler o disco.
    const coverBytes = shortCover.bytes;
    if (!plan.cover.path || !coverBytes) return undefined;
    // #11679: capa local presente e R2 indisponível também fica no registro (`cover.ok: false`).
    if (!r2.ready) return { error: `capa não enviada ao R2: R2 não configurado (${r2.missing.join(", ")})` };
    const coverKey = corte ? corteR2Key(corte.slug, "cover") : `shorts/${aammdd}-cover.jpg`;
    r2KeysInUse.add(coverKey);
    uploadedCover ??= uploadCoverOrFallback(
      () => reuseOrUploadToR2({ fetch: (u, i) => fetch(u, i), now: () => new Date() }, r2.config,
        coverKey, coverBytes, "image/jpeg", { keep: [...r2KeysInUse] }).then((r) => r.url),
      (line) => console.error(line),
    );
    return uploadedCover;
  };
  // #12001: lock do timer do corte para os destinos dele que esta rodada manual publica (run-corte.ts).
  const { dests: corteLockDests, busy: corteLockBusy, release: releaseCorteLock } = takeCorteManualLock(plan.items, dir, corte, requireCorteAuth);
  // #14204: o que é fixo na rodada e cada etapa de destino lê. O registro (`published`) passa por
  // `registry`, que lê e grava a variável desta função: cada etapa vê a versão mais recente.
  const sendCtx: ShortsSendContext = {
    aammdd,
    dir,
    file,
    videoPath,
    videoHash,
    corte,
    ...(corteOutside ? { corteOutside } : {}),
    writer,
    plan,
    config,
    shortsCfg,
    pages,
    apiVersion,
    igApiVersion,
    shortCover,
    deps,
    replaceRun,
    replaceTargetOf,
    bufferOffsetMs,
    forceYouTube: flags.has("force-youtube"),
    editionUrlArg: values["edition-url"],
    r2,
    r2KeysInUse,
    uploadVideo,
    uploadVideoAt,
    uploadCover,
    workerUrl,
    workerToken,
    igAuthor,
    liCreds: linkedInSendCreds(liCreds),
    liApiVersion,
    threadsCreds,
    registry: {
      current: () => published,
      replace: (fresh) => {
        published = fresh;
      },
      persist: (entry) => {
        published = persist(entry);
      },
    },
  };
  for (const item of plan.items) {
    if (corteLockBusy && corteLockDests.includes(item.destination)) {
      const busy = afterCancelMessage(replaceTargetOf(item.destination), corteLockBusy); // #12279
      results.push(shortsResult.failed(item.destination, busy));
      console.error(`[erro] ${item.destination}: ${busy}`);
      continue;
    }
    // #12279: depois do cancelamento, toda saída sem envio cita o post antigo já cancelado.
    const afterCancel = (msg: string) => afterCancelMessage(replaceTargetOf(item.destination), msg);
    if (item.action === "buffer" || item.action === "publish" || item.action === "enqueue") {
      // #11157: reconfere no disco antes de publicar — outro escritor pode ter
      // registrado o destino depois da leitura do início da rodada.
      const recheck = recheckBeforePublish(dir, aammdd, item.destination);
      // #12279: na Buffer o post antigo segue no registro até a skill apagá-lo e rodar o --mark --replaces.
      const bufferTarget = item.action === "buffer" ? replaceTargetOf(item.destination) : undefined;
      if (bufferTarget && recheck.kind === "already" && recheck.entry.id !== bufferTarget.old_id) {
        const msg = `o registro de ${item.destination} mudou durante a troca (agora ${recheck.entry.id}, não ${bufferTarget.old_id}): nada enviado`;
        results.push(shortsResult.failed(item.destination, msg));
        console.error(`[erro] ${item.destination}: ${msg}`);
        continue;
      }
      if (recheck.kind === "unreadable") {
        results.push(shortsResult.failed(item.destination, afterCancel(recheck.error)));
        console.error(`[erro] ${item.destination}: ${afterCancel(recheck.error)}`);
        continue;
      }
      // #12279: alvo de API com entrada no registro depois do cancelamento: o V2 não sobe e isso é falha, nunca "ok".
      const apiTarget = replaceTargetOf(item.destination);
      if (apiTarget?.kind === "api" && recheck.kind === "already") {
        const msg = afterCancel(`o registro ainda tem ${recheck.entry.id} (${recheck.entry.status}) em ${item.destination} depois do cancelamento: V2 não enviado`);
        results.push(shortsResult.failed(item.destination, msg));
        console.error(`[erro] ${item.destination}: ${msg}`);
        continue;
      }
      if (recheck.kind === "already" && !bufferTarget) {
        const already = recheck.entry;
        published = recheck.fresh;
        results.push(shortsResult.already(item.destination, already));
        console.error(`[aviso] ${item.destination}: registrado por outro processo durante esta rodada (${already.status}${already.url ? `, ${already.url}` : ""}) — não publica de novo`);
        continue;
      }
    }
    if (item.action === "buffer") {
      results.push((await sendBufferItem(sendCtx, item)).result); // #14204: buffer.ts
      continue;
    }
    if (item.action !== "publish" && item.action !== "enqueue") continue;
    // #12100 opção 2 (review da PR #12844): o encode da capa no 1º frame roda ANTES do
    // marcador de envio — um processo morto no ffmpeg (até minutos) não deixa o marcador
    // "pode ter saído" preso — e só com a credencial do canal presente (sem ela,
    // `publishYouTubeShort` recusa e o encode seria jogado fora).
    const ytUpload = youtubeShortsPrepareBeforeMarker(item, process.env)
      ? youtubeShortUploadFile({
          file,
          videoPath,
          cover: shortCover.bytes,
          coverUnreadable: shortCover.unreadable,
          leadMs: shortsCfg.youtubeFirstFrameCoverMs,
          log: (l) => console.error(l),
        })
      : null;
    // #11741 (finding P2 da PR #11827): marca "envio em curso" ANTES de publicar.
    // O registro só recebe o destino depois do aceite; sem a marca, a releitura
    // logo após uma interrupção (processo ainda vivo) sairia `nothing-since`.
    // A marca só fica quando o processo morre no meio ou o aceite não foi registrado.
    try {
      markShortSending(dir, aammdd, writer, { destination: item.destination, started_at: new Date().toISOString(), pid: process.pid });
    } catch (e) {
      const msg = afterCancel(`marcador de envio não gravado (${(e as Error).message}) — não publica sem ele`);
      results.push(shortsResult.failed(item.destination, msg));
      console.error(`[erro] ${item.destination}: ${msg}`);
      continue;
    }
    const clearSending = () => {
      try {
        clearShortSending(dir, aammdd, writer, item.destination);
      } catch (e) {
        console.error(`[aviso] ${item.destination}: marcador de envio não apagado (${(e as Error).message}) — a releitura vai acusá-lo como "pode ter saído"`);
      }
    };
    let outcome: PublishOutcome;
    try {
      // #12279: o envio novo da troca sai no horário preservado ou não sai (nunca "na hora").
      if (replaceRun) {
        const refusal = replacementUploadRefusal("scheduledAt" in item ? item.scheduledAt : null, new Date());
        if (refusal) throw new Error(refusal);
      }
      // #14204: uma etapa por destino (fila do Worker, LinkedIn, YouTube, Threads, Instagram, Facebook).
      // O texto desta chamada é âncora dos guards #12100 e #11827 (ordem: preparo → marcador → envio); mudou aqui, mude lá.
      const step = await sendDestinationItem(sendCtx, item, ytUpload);
      if (step.kind === "settled") {
        // #14327: o marcador é do laço; `keep` = a plataforma tem o post e o registro não diz.
        if (step.marker === "clear") clearSending();
        results.push(step.result);
        continue;
      }
      outcome = step.outcome;
    } catch (e) {
      // Recusa da plataforma/gate: o destino não saiu por esta rodada (envio
      // ambíguo vira `send_unknown` no registro, não exceção).
      clearSending();
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof InstagramTimerGateError) {
        // #11265: o gate não deixou publicar — o timer não pode tratar isso como "o publish falhou".
        // #14327: com `entry`, o gate achou o Reels no ar e o registro falhou (`persist-failed`): não reenviar.
        results.push(
          e.entry
            ? shortsResult.sentUnrecorded(item.destination, e.entry, msg, { cause: "preflight", preflight: e.failure })
            : shortsResult.failed(item.destination, msg, { cause: "preflight", preflight: e.failure }),
        );
      } else if (e instanceof ThreadsTimerGateError) {
        // #11410: idem pro Threads pessoal (perfil ilegível ou vídeo do dia sem marcador).
        results.push(shortsResult.failed(item.destination, msg, { cause: "preflight", preflight: e.failure }));
      } else {
        // #12279: na troca o post antigo já saiu: a falha diz isso, com a causa e o caminho de volta.
        const full = afterCancel(msg);
        results.push(shortsResult.failed(item.destination, full));
        console.error(`[erro] ${item.destination}: ${full}`);
        continue;
      }
      console.error(`[erro] ${item.destination}: ${msg}`);
      continue;
    }
    if (outcome.alreadyRegistered) {
      clearSending();
      results.push(shortsResult.already(item.destination, outcome.entry));
      console.error(`[aviso] ${item.destination}: registrado por outro processo antes do publish (${outcome.entry.status}${outcome.entry.url ? `, ${outcome.entry.url}` : ""}) — não publica de novo`);
      continue;
    }
    const { unconfirmed } = outcome;
    // #12279: YouTube e Facebook sobem `file` tal como está: o registro guarda o hash dos bytes de origem.
    const sha = videoHash && (item.destination === "youtube_shorts" || item.destination.startsWith("facebook:")) ? { video_sha256: videoHash } : {};
    const entry = { ...withMissingCoverRecord(outcome.entry, shortCover.path !== null), ...sha }; // #11660
    // #573: o status do registro é o que o script fez; o estado normalizado é o que se relata.
    const state = resolveShortEntryState(entry, new Date());
    try {
      published = persist(entry); // grava a cada destino — reduz a janela de duplicação num crash
    } catch (e) {
      // A plataforma JÁ aceitou: não pode virar "falhou" (a próxima rodada duplicaria).
      console.error(
        `[erro] ${item.destination}: ${entry.status === "scheduled" ? "AGENDADO" : "PUBLICADO"} (${entry.url ?? entry.id}) mas o registro não foi gravado: ${(e as Error).message}. ` +
          `NÃO rode --publish de novo para este destino sem antes registrá-lo em ${publishedPath}.`,
      );
      results.push(shortsResult.sentUnrecorded(item.destination, entry, `registro não gravado: ${(e as Error).message}`));
      continue; // marca de envio fica: a plataforma aceitou e o registro não diz
    }
    clearSending();
    results.push(shortsResult.sent(item.destination, entry, { unconfirmed, ...(outcome.warnings?.length ? { warnings: outcome.warnings } : {}) }));
    const where = item.action === "enqueue" ? `na fila do Worker para ${entry.scheduled_at} (key ${entry.id})` : (entry.url ?? entry.id);
    console.error(`[ok] ${item.destination}: ${entry.status} (estado ${state}) ${where}${unconfirmed ? " (processamento não confirmado em 5 min — confira)" : ""}`);
    for (const w of outcome.warnings ?? []) console.error(`[aviso] ${item.destination}: ${w}`);
    // #13403: alarme do áudio degradado só depois de o registro estar gravado.
    if (item.destination === "youtube_shorts") {
      await alarmYouTubeAudioDegraded(
        entry.audio_check,
        { videoId: entry.id, url: entry.url ?? youtubeShortUrl(entry.id), label: corte ? `vertical (Short) do corte ${corte.slug}` : `vertical (Short) da edição ${aammdd}` },
        notifyAudioDegraded,
        (l) => console.error(l),
      );
    }
  }
  releaseCorteLock();
  const finalItems = blockRepostOnProfileFailure(plan.items, results);
  if (finalItems !== plan.items) {
    console.error("[aviso] linkedin_page_repost: o vídeo do perfil falhou ou ficou em send_unknown nesta rodada — repost não oferecido");
    plan = { ...plan, items: finalItems };
  }
  // #11121: repost da página pela fila do Worker (como página, API direta).
  // Sem os segredos da página no Worker (#8816), o passo guiado fica.
  // #12654: na rodada com autorização, o repost só vai à fila do Worker se consumiu a autorização dele no início.
  const repostAuthorized = !replaceRun && (gatedActing === null || gatedActing.includes(PAGE_REPOST_DESTINATION));
  if (repostAuthorized && plan.items.some((i) => i.destination === "linkedin_page_repost" && i.action === "guided")) {
    const repost = await sendPageRepostStep({
      aammdd,
      items: plan.items,
      results,
      registry: sendCtx.registry,
      enqueue: workerUrl && workerToken ? (p) => postToWorkerQueue(workerUrl, workerToken, p, 2, "publish-shorts") : null,
      now: new Date(),
      ...(corte ? { corteSlug: corte.slug } : {}),
    });
    if (repost.result) results.push(repost.result);
    plan = { ...plan, items: repost.items };
  }
  // #10915/#14204: Instagram acima do teto vira passo guiado no Chrome; a compressão roda DEPOIS das APIs.
  plan = prepareInstagramChromeStep(plan, { aammdd, dir, videoPath, fileSizeBytes: file.length, durationSeconds: duration });
  // #11550: os itens podem ter mudado depois do plano (repost bloqueado, upload do Chrome) — os donos acompanham.
  plan = {
    ...plan,
    owners: assignShortsDestinationOwners(
      plan.items,
      ownersContextAfterPublish({
        aammdd,
        now: new Date(),
        instagramBackend: shortsCfg.instagramBackend,
        corteViaTimer: shortsCfg.corteViaTimer,
        writer,
        ...(corte ? { corteSlug: corte.slug } : {}),
        ...(corteOutside ? { corteOutsideDir: corteOutside.dir } : {}),
        ...(editionDirOverride !== undefined ? { editionDirOverride } : {}),
      }),
    ),
  };
  if (corte) {
    syncCorteAgendamentoFailSoft(() =>
      syncCorteAgendamento(
        ROOT, parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), dir), published.entries,
        plan.owners.filter(o => o.by === "timer-300").map(o => o.destination), new Date(),
      ),
    );
  }
  const summary = {
    published: results.filter((r) => r.ok && shortsResultEntry(r)?.status === "published").length,
    scheduled: results.filter((r) => r.ok && shortsResultEntry(r)?.status === "scheduled").length,
    failed: results.filter((r) => !r.ok).length,
    /** #10772: envio ambíguo — conferir na rede antes de dizer "publicado". */
    unknown: results.filter((r) => r.ok && shortsResultEntry(r)?.status === "send_unknown").length,
    buffer: results.filter((r) => r.status === "handoff").length,
    pending: plan.items.filter((i) => i.action === "pending_schedule").length,
    skipped: plan.items.filter((i) => i.action.startsWith("skip_") && i.action !== "skip_done").length,
    guided: plan.items.filter((i) => i.action === "guided").length,
  };
  console.log(JSON.stringify({ dry_run: false, ...plan, results, summary, ...revokedOut() }, null, 2));
  // #11240: pulo por credencial é terminal pra limpeza (decisão do editor). Só a
  // rodada principal grava; as dos timers do 300 só planejam o próprio destino.
  if (writer === "main") {
    try {
      recordCredentialSkips(
        dir,
        aammdd,
        plan.items.map((i) => i.destination),
        credentialSkippedItems(plan.items),
        new Date().toISOString(),
      );
    } catch (e) {
      console.error(`[aviso] não foi possível registrar os destinos pulados por credencial: ${(e as Error).message}`);
    }
  }
  cleanup();
  return summary.failed > 0 ? 1 : 0;
}
