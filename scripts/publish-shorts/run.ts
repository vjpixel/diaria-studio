/**
 * Execução da rodada: `main` (lock da substituição) e `mainUnlocked`, o laço por destino.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { cleanupPublishedVideo, recordCredentialSkips, shortsVideoTerminal } from "../lib/diaria/published-video-cleanup.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { publishConfirmSuffix, publishConfirmationError } from "../lib/diaria/publish-confirm.ts";
import {
  buildReplacementManifest,
  buildVerticalManifest,
  PAGE_REPOST_DESTINATION,
  planSha256,
  readVideoPlanSources,
  sha256Hex,
  VERTICAL_RUN_ACTIONS,
  writeVideoPlanManifest,
  type VideoPlanManifest,
} from "../lib/diaria/video-publish-plan.ts";
import { authorizationRefusalMessage, consumeBeforeExternalEffects, readAuthorizationStore } from "../lib/diaria/video-publish-authorization.ts";
import {
  applyReplacementTimes,
  planScheduledReplacements,
  REPLACE_MIN_LEAD_MS,
  replacementPublishCommand,
  afterCancelMessage,
  replacementSurvivors,
  replacementUploadRefusal,
  runScheduledReplacement,
  shortVideoChangeWarnings,
  type ReplacementCancelResult,
  type ShortReplacementTarget,
} from "../lib/diaria/short-scheduled-replace.ts";
import { alarmTaskAuthorizationRefusal } from "../lib/diaria/video-publish-authorization-alarm.ts";
import { editionDir as editionDirFor } from "../lib/edition-paths.ts";
import {
  CORTE_SPEC_FILE,
  CORTE_TIMER_LOCK_FILE,
  ALLOW_UNWATCHED_DIR_FLAG,
  CORTES_REL_DIR,
  checkCorteDir,
  corteR2Key,
  corteRelDir,
  corteVideoPortabilityWarning,
  resolveCorteVideo,
  parseCorteSpec,
  type CorteSpec,
} from "../lib/diaria/short-corte.ts";
import { corteContentFingerprintFromBytes } from "../lib/diaria/corte-content.ts";
import { loadResolvedFacebookPages } from "../lib/facebook-pages.ts";
import {
  facebookDestinationId,
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
  describeEditionVideoOutcome,
  describeLatestVideoOutcome,
  pollKvFromEnv,
  updateEditionVideoRedirect,
  updateLatestVideoRedirect,
} from "../set-latest-video-redirect.ts";
import {
  instagramTimerScopeError,
  linkedinTimerScopeError,
  threadsTimerScopeError,
  persistShortEntry,
  readShortsRegistry,
  readShortReplacements,
  recordShortReplacement,
  shortsRegistryPath,
  shortsRegistryWriterFor,
} from "../lib/diaria/shorts-published-store.ts";
import { clearShortSending, clearShortSendingAll, markShortSending, openSendingMarks, readShortsSending } from "../lib/diaria/shorts-sending-marker.ts";
import { acquireTimerLock, TIMER_LOCK_HEARTBEAT_MS } from "../lib/diaria/timer-lock.ts";
import { readCorteTimerHeartbeat } from "../lib/diaria/corte-timer-heartbeat.ts";
import { defaultYouTubeUploadDeps, missingYouTubeCredentials, rescheduleScheduledVideo } from "../lib/diaria/youtube-upload.ts";
import { gFetchRetry } from "../lib/drive-helpers.ts";
import { DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS, DriveDownloadEmptyError, downloadDriveFileById } from "../lib/drive-download.ts";
import { PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT } from "../lib/diaria/vertical-download-guard.ts";
import { loadR2UploadConfig, reuseOrUploadToR2 } from "../lib/r2-object-upload.ts";
import { postToWorkerQueue, resolveSocialWorkerToken, resolveSocialWorkerUrl } from "../lib/worker-queue-client.ts";
import { linkedInPostUrnFrom } from "../lib/diaria/linkedin-page-actions.ts";
import { resolveShortEntryState } from "../lib/publish-state.ts";
import { LINKEDIN_PERSONAL_ENV, defaultLinkedInApiVersion, readPersonalCreds } from "../lib/linkedin-personal.ts";
import { clampBufferThumbnailOffsetMs, carryOverCover, withMissingCoverRecord, SHORT_COVER_MISSING_ERROR } from "../lib/diaria/short-cover.ts";
import { THREADS_PROFILE_DESTINATION, ThreadsTimerGateError, readThreadsPersonalCreds } from "../lib/threads-personal-video.ts";
import {
  ROOT,
  publicVideoUnavailableReason,
  publicVideoUnavailableCause,
  type ShortsPlanItem,
  type ShortsPlan,
  shouldUpdateLatestVideoOnPublish,
  assignShortsDestinationOwners,
  nonCanonicalEditionDir,
  canonicalShortsEditionDir,
  checkEditionDir,
  ownersContextAfterPublish,
  readHorizontalVideoForShort,
} from "./_shared.ts";
import { planShortsPublish } from "./plan.ts";
import {
  uploadCoverOrFallback,
  type ReelCoverUpload,
  resolveInstagramQueueReadiness,
  wantsInstagram,
  type InstagramAuthor,
  resolveInstagramAuthor,
  prepareInstagramChromeStep,
} from "./instagram.ts";
import { blockRepostOnProfileFailure, sendLinkedInProfileItem, sendPageRepostStep } from "./linkedin.ts";
import { defaultGraphDeps, type PublishOutcome, cancelFacebookScheduledVideo, sendFacebookItem } from "./facebook.ts";
import { InstagramTimerGateError } from "./instagram-confirm.ts";
import { youtubeShortUploadFile, youtubeShortsPrepareBeforeMarker, youtubeShortUrl, sendYouTubeShortItem } from "./youtube.ts";
import { sendThreadsProfileItem } from "./threads.ts";
import { sendInstagramQueueItem, sendInstagramReelItem } from "./instagram-send.ts";
import type { ShortsEnqueueItem, ShortsPublishItem, ShortsRunResult, ShortsSendContext, ShortsSendIo, ShortsSendStep } from "./send-context.ts";
import {
  readShortCover,
  corteManualTimerDestinations,
  registerCorteLockCleanup,
  corteTimerLockBusyError,
  recheckBeforePublish,
  loadScheduledGrid,
  loadEditionDayGrid,
  loadWorkerQueueForGrid,
  parseMarkArg,
  buildMarkEntry,
  parseThumbnailOffsetArg,
  resolveEditionUrlInput,
} from "./run-checks.ts";
import {
  sendBufferItem,
  type ReplacementStoreArg,
  bufferDeletedRefusal,
  bufferReplacementMarkRefusal,
  applyBufferReplacementMark,
} from "./buffer.ts";
import { runUpdateScheduled } from "./update-scheduled.ts";
import {
  USAGE,
  replaceScheduledArgsError,
  markReplaceCancelling,
  SHORTS_REPLACE_LOCK_FILE,
  parseShortsCliArgs,
  configuredThreadsViaTimer,
  configuredInstagramBackend,
} from "./cli.ts";
import {
  CORTE_FORBIDDEN_FLAGS,
  type CorteRevocation,
  corteRequireAuthArgsError,
  prepareCorteRun,
  syncCorteAuthorizationWithContent,
  syncCorteAgendamento,
  syncCorteAgendamentoFailSoft,
  recordCortePublishAuthorization,
  type CorteAuthorizationRefusal,
  corteTimerChildRefusal,
  corteLifecycleArgsError,
  runCorteLifecycle,
} from "./corte.ts";
import { updatePublishedArgsError, runUpdatePublished } from "./update-published.ts";
import { credentialSkippedItems, readInstagramManualFirstCommentReminder, confirmInstagram } from "./confirm.ts";

// #14204: a etapa do YouTube mora em youtube.ts; a entrada reexporta daqui.
export { replacedYouTubeIds } from "./youtube.ts";

let releaseReplaceLock: () => void = () => {};

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

export async function main(): Promise<number> {
  try {
    return await mainUnlocked();
  } finally {
    // #12279: o lock da substituição vive a rodada inteira (do consumo da autorização ao último envio).
    releaseReplaceLock();
  }
}

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
 * #14204: a etapa de cada destino de API do laço do `--publish` (o item já
 * passou pela releitura do registro e tem o marcador de envio gravado). A
 * ordem das condições é a do laço inline de antes: `enqueue` (fila do Worker
 * do Instagram) primeiro, Facebook por último (todo destino de API que sobra é
 * uma página). Exceção = recusa, tratada pelo laço.
 */
export async function sendDestinationItem(
  ctx: ShortsSendContext,
  item: ShortsPublishItem | ShortsEnqueueItem,
  io: ShortsSendIo,
  ytUpload: { file: Buffer; firstFrame: { ms: number } | null } | null,
): Promise<ShortsSendStep> {
  if (item.action === "enqueue") return sendInstagramQueueItem(ctx, item);
  if (item.destination === "linkedin_profile") return sendLinkedInProfileItem(ctx, item);
  if (item.destination === "youtube_shorts") return sendYouTubeShortItem(ctx, item, ytUpload);
  if (item.destination === THREADS_PROFILE_DESTINATION) return sendThreadsProfileItem(ctx, item, io);
  if (item.destination === "instagram") return sendInstagramReelItem(ctx, item, io);
  return sendFacebookItem(ctx, item);
}

async function mainUnlocked(): Promise<number> {
  const parsed = parseShortsCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`publish-shorts: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const { flags, values } = parsed;
  let aammdd = parsed.aammdd;
  // #13403: alarme do áudio degradado do youtube_shorts (disparado depois de gravar o registro).
  const notifyAudioDegraded: YouTubeAudioAlarmFn = (check, ctx) => notifyYouTubeAudioDegraded(check, ctx, { cwd: ROOT });
  // #11795: corte avulso — pasta, registro, data, título e gancho próprios, fora de data/editions/.
  const corteSlug = values["corte"];
  let corte: CorteSpec | null = null;
  // #11911: corte fora de data/cortes/ aceito por --allow-unwatched-dir (sem alarme de destino faltante).
  let corteOutside: { dir: string; warning: string } | undefined;
  // #11912: derrubadas do "pode publicar" nesta rodada — saem no JSON, não só no stderr.
  const corteRevocations: CorteRevocation[] = [];
  const revokedOut = () => (corteRevocations.length ? { corte_authorization_revoked: corteRevocations } : {});
  const requireCorteAuth = flags.has("require-corte-authorization");
  // #11912: o filho do timer só CONFERE a autorização; nunca muda o plano nem grava nada.
  const requireAuthArgsErr = corteRequireAuthArgsError(flags, values);
  if (requireAuthArgsErr) {
    console.error(`publish-shorts: ${requireAuthArgsErr}`);
    return 2;
  }
  // #13000: --cancel/--reschedule do corte — conferido antes de qualquer leitura ou gravação.
  const lifecycleErr = corteLifecycleArgsError(flags, values);
  if (lifecycleErr) {
    console.error(`publish-shorts: ${lifecycleErr}`);
    return 2;
  }
  // #12936: --update-published — conferido antes de qualquer leitura ou gravação.
  const updatePublishedErr = updatePublishedArgsError(flags, values, aammdd);
  if (updatePublishedErr) {
    console.error(`publish-shorts: ${updatePublishedErr}`);
    return 2;
  }
  // #12279: --replace-scheduled — conferido antes de qualquer leitura ou gravação.
  const replaceRun = flags.has("replace-scheduled");
  const replaceArgsErr = replaceScheduledArgsError(flags, values);
  if (replaceArgsErr) {
    console.error(`publish-shorts: ${replaceArgsErr}`);
    return 2;
  }
  if (corteSlug !== undefined) {
    const forbidden = CORTE_FORBIDDEN_FLAGS.filter((f) => flags.has(f));
    if (forbidden.length) {
      console.error(`publish-shorts: --corte não combina com ${forbidden.map((f) => `--${f}`).join(", ")} (timers e conferência do Instagram são da edição; registre à mão com --mark)`);
      return 2;
    }
    if (values["edition"] !== undefined) {
      console.error("publish-shorts: --corte usa --date AAMMDD, não --edition");
      return 2;
    }
    const corteDir = resolve(values["edition-dir"] ?? join(ROOT, corteRelDir(corteSlug)));
    // #11911: só data/cortes/{slug}/ é vista pelo timer do corte e pelo vigia de cortes sem dono.
    // Conferido antes de qualquer gravação (o prepareCorteRun já grava o corte.json).
    const dirCheck = checkCorteDir({ slug: corteSlug, dir: corteDir, cortesRoot: join(ROOT, CORTES_REL_DIR), allowUnwatched: flags.has(ALLOW_UNWATCHED_DIR_FLAG) });
    if (!dirCheck.ok) {
      console.error(`publish-shorts: ${dirCheck.error}`);
      return 2;
    }
    if (dirCheck.outside) {
      corteOutside = { dir: dirCheck.dir, warning: dirCheck.warning };
      console.error(`[aviso] ${dirCheck.warning}`);
    }
    // #13000: antes do prepareCorteRun, que gravaria o --date/--at novos e derrubaria o "pode publicar".
    if (flags.has("cancel") || flags.has("reschedule")) return runCorteLifecycle({ dir: corteDir, slug: corteSlug, flags, values });
    // #12936: antes do prepareCorteRun, que gravaria --title/--hook e derrubaria o "pode publicar".
    if (flags.has("update-published")) {
      return runUpdatePublished({ dir: corteDir, aammdd: "", corteSlug, values, only: values["only"] ? values["only"].split(",").map((s) => s.trim()).filter(Boolean) : null });
    }
    try {
      corte = prepareCorteRun({ slug: corteSlug, dir: corteDir, values, positionalDate: aammdd, log: (l) => console.error(l), onRevoked: (r) => corteRevocations.push(r), unwatchedDirWarning: corteOutside?.warning, readOnly: requireCorteAuth });
    } catch (e) {
      console.error(`publish-shorts: ${(e as Error).message}`);
      return 2;
    }
    aammdd = corte.date;
    console.error(`[premissa] corte avulso "${corte.slug}": ${corte.date} às ${corte.hhmm} BRT, vídeo ${resolveCorteVideo(corteDir, corte.video)}, registro em ${corteDir}`);
    const portability = corteVideoPortabilityWarning(resolveCorteVideo(corteDir, corte.video), join(ROOT, "data"));
    if (portability) console.error(`[aviso] ${portability}`);
  }
  // #11741: `--publish` tem efeito público — só com a confirmação explícita da
  // edição (no corte avulso, a data do corte), checada antes de qualquer
  // download, credencial, API ou gravação de registro.
  if (flags.has("publish")) {
    const confirmErr = publishConfirmationError({ script: "publish-shorts", mode: "--publish", aammdd, flags, values });
    if (confirmErr) {
      console.error(confirmErr);
      return 2;
    }
  }
  // #11911: a pasta canônica da edição é a do repo (ROOT), nunca relativa ao cwd — mesmo critério do corte.
  const canonicalEditionDir = canonicalShortsEditionDir(aammdd);
  const dir = corte ? resolve(values["edition-dir"] ?? join(ROOT, corteRelDir(corte.slug))) : resolve(values["edition-dir"] ?? canonicalEditionDir);
  // #11911: `--edition-dir` fora de data/editions/{AAMM}/{AAMMDD}: nada é delegado aos timers do 300.
  const editionDirOverride = corte ? undefined : nonCanonicalEditionDir(dir, canonicalEditionDir);
  // #11911: e é recusada sem --allow-unwatched-dir. Em 02/11 a rodada original foi no modo edição com
  // --edition-dir ~/diaria-cortes/... e os timers de Instagram da edição ficaram cegos; o
  // `--instagram-timer` com a mesma pasta foi só a remediação manual (12:38 BRT).
  // Depois da confirmação do --publish e antes de qualquer leitura ou gravação na pasta.
  let unwatchedEditionWarning: string | undefined;
  if (!corte) {
    const editionCheck = checkEditionDir({ aammdd, override: editionDirOverride, allowUnwatched: flags.has(ALLOW_UNWATCHED_DIR_FLAG), canonicalDir: canonicalEditionDir });
    if (!editionCheck.ok) {
      console.error(`publish-shorts: ${editionCheck.error}`);
      return 2;
    }
    if (editionCheck.outside) {
      unwatchedEditionWarning = editionCheck.warning;
      console.error(`[aviso] ${editionCheck.warning}`);
    }
  }
  // #11157: cada escritor grava no próprio arquivo (o timer do 300 no dele) e
  // toda gravação relê do disco e troca só a própria entrada, sob lock.
  const linkedinTimer = flags.has("linkedin-timer");
  const instagramTimer = flags.has("instagram-timer");
  const threadsTimer = flags.has("threads-timer");
  if (linkedinTimer && instagramTimer) {
    console.error("publish-shorts: --instagram-timer não combina com --linkedin-timer (cada timer grava o próprio registro)");
    return 2;
  }
  if (threadsTimer && (linkedinTimer || instagramTimer)) {
    console.error("publish-shorts: --threads-timer não combina com outro timer (cada timer grava o próprio registro)");
    return 2;
  }
  const writer = shortsRegistryWriterFor(linkedinTimer, instagramTimer, threadsTimer);
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
      releaseReplaceLock = rel;
      // Relido sob o lock: a leitura do início pode estar velha.
      published = readShortsRegistry(dir, aammdd);
    } else {
      const lock = replaceLockBusy(dir);
      if (lock === "busy") {
        console.error("publish-shorts: substituição do vertical agendado (--replace-scheduled) em curso nesta edição: aguarde o desfecho dela antes de publicar (#12279)");
        return 2;
      }
      if (lock !== "free") {
        console.error(`publish-shorts: lock da substituição ${lock.unreadable}: nada publicado (#12279)`);
        return 2;
      }
    }
  }

  if (values["mark-replaced"] !== undefined) {
    // #12279: logo depois do delete_post do post antigo na Buffer: o registro deixa de apontá-lo.
    let entries: ShortPublishedEntry[];
    try {
      entries = readShortsRegistry(dir, aammdd).entries;
    } catch (e) {
      console.error(`publish-shorts: ${(e as Error).message}`);
      return 2;
    }
    let store: ReplacementStoreArg;
    try {
      store = readAuthorizationStore(dir, aammdd);
    } catch (e) {
      store = (e as Error).message;
    }
    const r = bufferDeletedRefusal({ mark: values["mark-replaced"], entries, store });
    if (!r.ok) {
      console.error(`publish-shorts: ${r.error}`);
      return 2;
    }
    try {
      recordShortReplacement(dir, { destination: r.entry.destination, id: r.entry.id, scheduled_at: r.entry.scheduled_at ?? null, replaced_at: new Date().toISOString(), new_video_sha256: null });
    } catch (e) {
      console.error(`publish-shorts: histórico não gravado (${(e as Error).message}): o registro ainda aponta ${r.entry.id}; repita o --mark-replaced (#12279)`);
      return 2;
    }
    console.log(JSON.stringify({ mark_replaced: r.entry.destination, id: r.entry.id, scheduled_at: r.entry.scheduled_at ?? null }));
    return 0;
  }

  if (values["mark"]) {
    let mark: ReturnType<typeof parseMarkArg>;
    try {
      mark = parseMarkArg(values["mark"]);
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
    const markScopeErr =
      linkedinTimerScopeError({ linkedinTimer, only: null, markDestination: mark.destination }) ??
      instagramTimerScopeError({ instagramTimer, backend: configuredInstagramBackend(), linkedinTimer, only: null, markDestination: mark.destination }) ??
      threadsTimerScopeError({ threadsTimer, viaTimer: configuredThreadsViaTimer(), only: null, markDestination: mark.destination });
    if (markScopeErr) {
      console.error(`publish-shorts: ${markScopeErr}`);
      return 2;
    }
    // #11547: a capa do X só entra no registro com o offset que a skill DE FATO passou à Buffer.
    const offset = parseThumbnailOffsetArg(values["thumbnail-offset"], Boolean(mark.bufferId));
    if (!offset.ok) {
      console.error(offset.error);
      return 2;
    }
    const built = buildMarkEntry(mark, values["scheduled-at"], new Date().toISOString(), offset.value);
    if (!built.ok) {
      console.error(built.error);
      return 2;
    }
    const videoSha = values["video-sha256"];
    if (videoSha !== undefined && !/^[a-f0-9]{64}$/.test(videoSha)) {
      console.error("publish-shorts: --video-sha256 espera o hash hexadecimal de 64 caracteres (o `video_sha256` do preparo da Buffer)");
      return 2;
    }
    const readStore = (): ReplacementStoreArg => {
      try {
        return readAuthorizationStore(dir, aammdd);
      } catch (e) {
        return (e as Error).message;
      }
    };
    // #11547: a confirmação (`x=URL`) mantém o registro da capa do agendamento.
    const markEntry = carryOverCover(built.entry, values["replaces"] !== undefined ? undefined : published.entries.find((e) => e.destination === mark.destination));
    const newEntry = videoSha ? { ...markEntry, video_sha256: videoSha } : markEntry;
    if (values["replaces"] !== undefined) {
      // #12279: o post novo da Buffer que troca o agendado antigo (criado pela skill depois da rodada de troca).
      let replaced: ReturnType<typeof readShortReplacements>;
      try {
        replaced = readShortReplacements(dir);
      } catch (e) {
        console.error(`publish-shorts: ${(e as Error).message}`);
        return 2;
      }
      const refusal = bufferReplacementMarkRefusal({
        destination: mark.destination,
        bufferId: mark.bufferId ?? null,
        replaces: values["replaces"],
        scheduledAt: values["scheduled-at"],
        videoSha256: videoSha,
        entries: published.entries,
        replaced,
        store: readStore(),
      });
      if (refusal) {
        console.error(`publish-shorts: ${refusal}`);
        return 2;
      }
      const old = published.entries.find((e) => e.destination === mark.destination) ?? replaced.find((r) => r.destination === mark.destination && r.id === values["replaces"])!;
      const applied = applyBufferReplacementMark({
        persist: () => {
          published = persist(newEntry);
        },
        record: () =>
          recordShortReplacement(dir, { destination: mark.destination, id: values["replaces"], scheduled_at: old.scheduled_at ?? null, replaced_at: new Date().toISOString(), new_video_sha256: videoSha ?? null }),
        warn: (m) => console.error(`[aviso] ${mark.destination}: ${m}`),
      });
      if (!applied.ok) {
        console.error(`publish-shorts: ${applied.error}`);
        return 2;
      }
    } else {
      published = persist(newEntry);
    }
    if (corte) {
      syncCorteAgendamentoFailSoft(() =>
        syncCorteAgendamento(ROOT, parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), dir), published.entries, [], new Date()),
      );
    }
    // #13781: o Reels registrado à mão não ganha o 1º comentário sozinho; lembra o editor.
    const firstCommentReminder = mark.destination === "instagram" && !corte ? readInstagramManualFirstCommentReminder(dir, aammdd) : null;
    if (firstCommentReminder) console.error(`[aviso] instagram: ${firstCommentReminder}`);
    console.log(JSON.stringify({ marked: mark.destination, url: mark.url, ...(mark.bufferId ? { buffer_id: mark.bufferId } : {}), ...(firstCommentReminder ? { first_comment_reminder: firstCommentReminder } : {}) }));
    cleanup();
    return 0;
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
  // #12279: na substituição todos os destinos já estão registrados; o V2 baixa assim mesmo.
  if (values["from-drive"] && !replaceRun && !existsSync(videoPath) && shortsVideoTerminal(dir, aammdd,
    loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))))) {
    cleanup();
    console.error("[ok] destinos do vertical já concluídos — nada a baixar");
    return 0;
  }
  if (values["from-drive"]) {
    const id = values["from-drive"];
    if (!/^[\w-]{10,}$/.test(id)) {
      console.error(`--from-drive espera o id do arquivo no Drive, recebido ${JSON.stringify(id)}`);
      return 2;
    }
    if (existsSync(videoPath)) console.error(`[aviso] substituindo ${videoPath} pelo arquivo do Drive`);
    // #11082: mesmo download protegido do fetch-drive-video.ts (.part, teto de 20 min,
    // 60 s sem bytes aborta, tamanho conferido contra o metadado, só .mp4).
    try {
      const { bytes } = await downloadDriveFileById(
        { driveFetch: (url, init) => gFetchRetry(url, init ?? {}) },
        id,
        videoPath,
        DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS,
        (line) => console.error(line),
      );
      console.error(`[ok] vídeo curto baixado do Drive (${(bytes / 1e6).toFixed(1)} MB) → ${videoPath}`);
    } catch (e) {
      console.error(`publish-shorts: ${(e as Error).message}`);
      // #13540/#13541: arquivo ainda subindo para o Drive — exit próprio, que os timers leem como espera.
      return e instanceof DriveDownloadEmptyError ? PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT : 1;
    }
    // #11912: outro arquivo no lugar do vídeo aprovado não herda o "pode publicar".
    if (corte && !requireCorteAuth) corte = syncCorteAuthorizationWithContent(dir, new Date().toISOString(), { log: (l) => console.error(l), onRevoked: (r) => corteRevocations.push(r) });
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
  let replaceSkipped: ReturnType<typeof planScheduledReplacements>["skipped"] = [];
  let planPublished = published;
  let planOnly = onlyList;
  if (replaceRun) {
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
      console.log(JSON.stringify({ dry_run: !flags.has("publish"), replace_scheduled: true, aammdd, video: videoPath, video_sha256: videoHash, targets: [], skipped: selection.skipped }, null, 2));
      return flags.has("publish") ? 1 : 0;
    }
    replaceTargets = selection.targets;
    replaceSkipped = selection.skipped;
    const targetDests = new Set(replaceTargets.map((t) => t.destination));
    planPublished = { ...published, entries: published.entries.filter((e) => !targetDests.has(e.destination)) };
    planOnly = [...targetDests];
  }
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config);
  const igApiVersion = process.env.INSTAGRAM_API_VERSION || apiVersion;
  let shortsCfg: ReturnType<typeof loadShortsConfig>;
  try {
    shortsCfg = loadShortsConfig(config);
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  const igAuthor: InstagramAuthor = wantsInstagram(shortsCfg, planOnly, planPublished)
    ? await resolveInstagramAuthor(defaultGraphDeps, shortsCfg.instagramAuthorPage, pages, igApiVersion, {
        igUserId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? "",
        token: process.env.INSTAGRAM_ACCESS_TOKEN ?? "",
      })
    : { ready: false, reason: "fora desta rodada" };
  if (igAuthor.ready) {
    const collab = shortsCfg.instagramCollaborators.length ? ` + collab ${shortsCfg.instagramCollaborators.map((c) => `@${c}`).join(", ")}` : "";
    console.error(`[premissa] Instagram: autora ${igAuthor.username ? `@${igAuthor.username}` : igAuthor.igUserId} (${igAuthor.source})${collab}`);
  }
  const editionUrlIn = resolveEditionUrlInput(dir, values["edition-url"]);
  // #10823: fila do Worker pro Reels com horário futuro (mesmas vars do publish-instagram.ts --schedule).
  const workerUrl: string = resolveSocialWorkerUrl(config, { preferSlot: "instagram" });
  const workerToken = resolveSocialWorkerToken();
  const r2 = loadR2UploadConfig(process.env);
  // #10772: LinkedIn pessoal (mesmo token do 4º post) e o vídeo completo do YouTube pro texto.
  const liCreds = readPersonalCreds(process.env, new Date());
  const liApiVersion = process.env[LINKEDIN_PERSONAL_ENV.apiVersion]?.trim() || defaultLinkedInApiVersion(new Date());
  // #11122: Threads pessoal (fail-soft até o token existir, #10772/#11077).
  const threadsCreds = readThreadsPersonalCreds(process.env);
  // #11070: Short pela Data API com a credencial do horizontal (YOUTUBE_*, youtube-oauth-setup.ts).
  const ytMissing = missingYouTubeCredentials(process.env);
  // #11265: a fila do Worker só entra com o backend antigo. O R2 é cobrado no
  // plano: X, Threads e, desde o #11355, o Reels da @diar.ia.br dependem dele.
  const instagramQueue =
    shortsCfg.instagramBackend === "worker-r2"
      ? resolveInstagramQueueReadiness({
          authorPage: shortsCfg.instagramAuthorPage,
          workerUrl,
          workerToken,
          r2Missing: r2.ready ? [] : r2.missing,
        })
      : undefined;
  // #10819: a fila do Worker entra na grade (só leitura, fail-soft).
  const warnGrid = (m: string) => console.error(`[aviso] ${m}`);
  const workerQueue = await loadWorkerQueueForGrid(workerUrl, workerToken, fetch, warnGrid);

  const shortCover = readShortCover(dir, (l) => console.error(l)); // #11547
  // #11660: capa ausente nesta máquina é aviso explícito (e vai pro registro de cada destino), nunca silêncio.
  if (!shortCover.path) console.error(`[aviso] capa do vertical: ${SHORT_COVER_MISSING_ERROR}`);
  // #11679 item 2: offset do X fora do vertical (sequência do Premiere que não começa em 00:00:00:00) não vai à Buffer.
  const bufferOffsetMs = clampBufferThumbnailOffsetMs(shortCover.bufferOffsetMs, duration);
  if (shortCover.bufferOffsetMs !== null && bufferOffsetMs === null) {
    console.error(`[aviso] capa do X: offset ${shortCover.bufferOffsetMs} ms do timecode do Still fica fora do vertical — a Buffer escolhe o frame`);
  }
  let plan: ShortsPlan;
  try {
    plan = planShortsPublish({
      aammdd,
      coverPath: shortCover.path,
      coverUploadReady: r2.ready,
      coverBufferOffsetMs: bufferOffsetMs,
      reviewedMd: corte ? "" : readFileSync(reviewedPath, "utf8"),
      // #11964: o filho do timer (--require-corte-authorization) é o único que publica os destinos do timer na janela.
      ...(corte
        ? { corte: { slug: corte.slug, hhmm: corte.hhmm, title: corte.title, hook: corte.hook, timerRun: requireCorteAuth }, ...(corteOutside ? { corteOutside } : {}) }
        : editionDirOverride !== undefined
          ? { editionDirOverride, unwatchedEditionWarning: unwatchedEditionWarning! }
          : {}),
      // #12191: a descrição do Short (edição, nunca corte) cita o vídeo horizontal.
      ...(corte ? {} : { horizontalVideo: readHorizontalVideoForShort(dir) }),
      // #11986: a rodada manual confere se o timer do corte, a quem entrega destinos, está vivo.
      ...(corte && !requireCorteAuth ? { corteTimerHeartbeat: readCorteTimerHeartbeat(join(ROOT, CORTES_REL_DIR)) } : {}),
      now: new Date(),
      config,
      pages,
      instagramReady: igAuthor.ready,
      instagramNotReadyReason: igAuthor.ready ? undefined : igAuthor.reason,
      instagramWarnings: igAuthor.ready ? igAuthor.warnings : undefined,
      instagramQueue,
      linkedinPersonal: liCreds.ok ? { ready: true } : { ready: false, reason: liCreds.reason },
      threadsPersonal: threadsCreds.ready ? { ready: true } : { ready: false, reason: threadsCreds.reason },
      publicVideo: r2.ready ? { ready: true } : { ready: false, reason: publicVideoUnavailableReason(shortsCfg.instagramBackend, r2.missing), cause: publicVideoUnavailableCause(shortsCfg.instagramBackend, r2.missing) },
      youtubeApi: ytMissing.length ? { ready: false, reason: `faltam ${ytMissing.join(", ")} no ambiente` } : { ready: true },
      writer,
      published: planPublished,
      video: { path: videoPath, exists: videoExists, sizeBytes: videoExists ? statSync(videoPath).size : null },
      videoDurationSeconds: duration,
      editionUrl: editionUrlIn.url,
      editionUrlSource: editionUrlIn.source,
      forceNow: flags.has("now"),
      only: planOnly,
      grid: [
        ...loadScheduledGrid(dir, planPublished, shortsCfg.instagramAuthorPage, warnGrid, {
          instagramCollaborators: shortsCfg.instagramCollaborators,
          workerQueue,
        }),
        // #11795: o corte disputa as contas com a edição do mesmo dia (só leitura, fail-soft).
        ...(corte ? loadEditionDayGrid(editionDirFor(aammdd), aammdd, shortsCfg.instagramAuthorPage, shortsCfg.instagramCollaborators, warnGrid) : []),
      ],
    });
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  // #12279: no dry-run normal, o vídeo local que não é o registrado vira aviso (V2 re-exportado).
  if (!replaceRun && !corte && videoHash) plan.warnings.push(...shortVideoChangeWarnings(published.entries, videoHash));
  for (const p of plan.premises) console.error(`[premissa] ${p}`);
  for (const w of plan.warnings) console.error(`[aviso] ${w}`);

  // #12279: a substituição — plano com o horário PRESERVADO de cada post antigo, manifesto
  // próprio (o grant --replace-scheduled), e a fase destrutiva só depois do consumo.
  let replaceResults: ReplacementCancelResult[] = [];
  if (replaceRun) {
    const timed = applyReplacementTimes(plan.items, replaceTargets);
    if (!timed.ok) {
      console.error(`publish-shorts: --replace-scheduled: ${timed.error}`);
      return 2;
    }
    plan = { ...plan, items: timed.items };
    const ownerCommand = replacementPublishCommand(aammdd, { video: values["video"] });
    const replacementManifest = (generatedAt?: string) =>
      buildReplacementManifest(
        buildShortsPlanManifest(plan, { editionDir: dir, videoBytes: file, coverBytes: shortCover.bytes, ...(generatedAt ? { generatedAt } : {}) }),
        replaceTargets,
        ownerCommand,
      );
    if (!flags.has("publish")) {
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
    replaceResults = phase.results;
    for (const r of replaceResults) {
      if (r.outcome === "cancelled") console.error(`[ok] ${r.target.destination}: post antigo ${r.target.old_id} cancelado; envio novo no horário preservado ${r.target.at}`);
      else if (r.outcome === "failed" || r.outcome === "uncertain") console.error(`[erro] ${r.target.destination}: ${r.error}`);
    }
    // Só o alvo cancelado (API) ou da Buffer recebe envio novo; falha e incerteza entram em results (exit ≠ 0).
    const going = replacementSurvivors(replaceResults);
    plan = { ...plan, items: plan.items.filter((i) => going.has(i.destination)) };
  }

  // #12654: o plano da edição (fora do corte e dos timers do 300) passa pela autorização por hash.
  // #12279: a substituição já consumiu a autorização dela acima (no mesmo processo, sob o lock).
  const planGated = !corte && writer === "main";
  if (!flags.has("publish")) {
    let planOut: { plan_sha256: string; plan_manifest: VideoPlanManifest } | Record<string, never> = {};
    if (planGated) {
      const manifest = buildShortsPlanManifest(plan, { editionDir: dir, videoBytes: file, coverBytes: shortCover.bytes, generatedAt: new Date().toISOString() });
      const planHash = planSha256(manifest);
      planOut = { plan_sha256: planHash, plan_manifest: manifest };
      // Só a rodada de plano inteiro grava o manifesto que o grant lê (um --only parcial não substitui o plano da parte).
      if (!onlyList) {
        try {
          const manifestPath = writeVideoPlanManifest(dir, manifest);
          console.error(`[premissa] plano do vertical: plan_sha256 ${planHash} (${manifestPath}). Depois do "pode publicar" explícito do editor sobre ESTE plano: npx tsx scripts/video-publish-authorize.ts grant ${aammdd} --part vertical --plan-sha256 ${planHash} --confirmation "{resposta do editor}" (#12654)`);
        } catch (e) {
          console.error(`[aviso] manifesto do plano não gravado (${(e as Error).message}): sem ele o grant recusa e o --publish não sai (#12654)`);
        }
      } else {
        console.error(`[premissa] plano parcial (--only): plan_sha256 ${planHash} só confere; o manifesto da parte não é regravado (#12654)`);
      }
    }
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
    // Confere e consome (uso único) a autorização de cada destino que esta rodada executa, com o
    // manifesto recalculado agora, ANTES da 1ª escrita externa (KV do link da bio, R2, APIs, fila do Worker).
    const acting = shortsRunDestinations(plan.items, {
      repostViaWorker: Boolean(workerUrl && workerToken),
      profileUrnKnown: linkedInPostUrnFrom(published.entries.find((e) => e.destination === "linkedin_profile")) !== null,
    });
    gatedActing = acting;
    if (acting.length) {
      const authCommand = `npx tsx scripts/publish-shorts.ts ${process.argv.slice(2).join(" ")}`;
      const auth = consumeBeforeExternalEffects({
        editionDir: dir, edition: aammdd,
        manifest: buildShortsPlanManifest(plan, { editionDir: dir, videoBytes: file, coverBytes: shortCover.bytes }),
        destinations: acting, now: new Date(), pid: process.pid, by: "publish-shorts --publish",
        command: authCommand,
        fallbackCommand: shortsMainPublishCommand(aammdd),
        forceNow: flags.has("now"),
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
  }
  if (shouldUpdateLatestVideoOnPublish({ corte: !!corte, writer }) && !replaceRun && (gatedActing === null || gatedActing.length > 0)) {
    // #12735: o link fixo da bio (diar.ia.br/video) passa a apontar para o horizontal desta edição.
    // Fail-soft: o vertical sai mesmo sem o KV; a gravação só avança (edição anterior não sobrescreve).
    // #12786: só a rodada principal; as dos timers do 300 não leem nem gravam o KV.
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
  // #11912: só o --publish confirmado do corte grava o "pode publicar" (e o --only usado) no
  // corte.json; o timer do 300 não publica sem ele. Dry-run, --mark e --update-scheduled já
  // saíram acima. Fica DEPOIS de todas as validações que abortam (confirmação, escopo dos
  // timers, plano com o --only, vídeo) e ANTES do 1º envio.
  // #11912: a impressão digital é dos bytes que esta rodada sobe (o vídeo já lido, a capa do readShortCover).
  const corteContent = corte ? corteContentFingerprintFromBytes(file, shortCover.bytes) : null;
  if (corte && corteContent && requireCorteAuth) {
    // #11912: o filho do timer só confere (autorização presente, cobre o --only, o mesmo plano com que montou
    // título e gancho, vídeo/capa iguais aos aprovados). A recusa sai em JSON: o timer alarma o motivo certo.
    const specPath = join(dir, CORTE_SPEC_FILE);
    let refusal: { refused: CorteAuthorizationRefusal; reason: string } | null;
    try {
      refusal = corteTimerChildRefusal(parseCorteSpec(readFileSync(specPath, "utf8"), specPath), corte, onlyList, corteContent);
    } catch (e) {
      // #11923: falha ao reler o corte.json (EBUSY do OneDrive, JSON pela metade) não é revogação.
      refusal = { refused: "spec-unreadable", reason: `corte.json ilegível nesta rodada: ${(e as Error).message}` };
    }
    if (refusal) {
      console.error(`publish-shorts: --require-corte-authorization: ${refusal.reason} — nada publicado`);
      console.log(JSON.stringify({ dry_run: false, authorization_refused: refusal.refused, reason: refusal.reason }, null, 2));
      return 2;
    }
  } else if (corte && corteContent) {
    try {
      recordCortePublishAuthorization(dir, values["only"], knownDestinationIds(shortsCfg), corteContent, new Date().toISOString(), (l) => console.error(l), shortCover.unreadable);
    } catch (e) {
      console.error(`publish-shorts: ${(e as Error).message}`);
      return 2;
    }
  }
  console.error(`[premissa] duração ${duration === null ? "desconhecida" : `${duration.toFixed(1)} s`} → Facebook via ${facebookUploadRoute(duration)}`);
  const deps = defaultGraphDeps;
  const results: ShortsRunResult[] = [];
  // #12279 (F1 do review da PR #13107): falha ou incerteza do cancelamento entra no resultado e no exit code.
  for (const r of replaceResults) {
    if (r.outcome === "failed" || r.outcome === "uncertain") {
      results.push({ destination: r.target.destination, ok: false, error: r.error, phase: r.phase, ...(r.outcome === "uncertain" ? { uncertain: true as const } : {}) });
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
  // #12001: a rodada manual que publica destinos do timer do corte (a última hora antes do teto,
  // #11996) toma o MESMO lock do timer: o timer que passar junto acha o lock e sai sem publicar,
  // e se o timer já está com ele, esses destinos não saem por aqui. Falha ao tomar = recusa.
  const corteLockDests = corteManualTimerDestinations(plan.items, corte ? { timerRun: requireCorteAuth } : null);
  let corteLockBusy: string | null = null;
  let releaseCorteLock = () => {};
  if (corte && corteLockDests.length) {
    let rel: (() => void) | null = null;
    try {
      rel = acquireTimerLock(join(dir, CORTE_TIMER_LOCK_FILE), Date.now(), { heartbeatMs: TIMER_LOCK_HEARTBEAT_MS }); // #12005: rodada sem teto renova o lock
    } catch (e) {
      corteLockBusy = `lock do timer do corte não tomado (${(e as Error).message}): nada enviado neste destino para não duplicar o post com o timer (#12001)`;
    }
    if (rel) {
      releaseCorteLock = registerCorteLockCleanup(rel);
    } else if (!corteLockBusy) {
      corteLockBusy = corteTimerLockBusyError(corte.slug);
    }
  }
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
    liCreds,
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
      results.push({ destination: item.destination, ok: false, error: busy });
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
        results.push({ destination: item.destination, ok: false, error: msg });
        console.error(`[erro] ${item.destination}: ${msg}`);
        continue;
      }
      if (recheck.kind === "unreadable") {
        results.push({ destination: item.destination, ok: false, error: afterCancel(recheck.error) });
        console.error(`[erro] ${item.destination}: ${afterCancel(recheck.error)}`);
        continue;
      }
      // #12279: alvo de API com entrada no registro depois do cancelamento: o V2 não sobe e isso é falha, nunca "ok".
      const apiTarget = replaceTargetOf(item.destination);
      if (apiTarget?.kind === "api" && recheck.kind === "already") {
        const msg = afterCancel(`o registro ainda tem ${recheck.entry.id} (${recheck.entry.status}) em ${item.destination} depois do cancelamento: V2 não enviado`);
        results.push({ destination: item.destination, ok: false, error: msg });
        console.error(`[erro] ${item.destination}: ${msg}`);
        continue;
      }
      if (recheck.kind === "already" && !bufferTarget) {
        const already = recheck.entry;
        published = recheck.fresh;
        results.push({ destination: item.destination, ok: true, entry: already, alreadyRegistered: true });
        console.error(`[aviso] ${item.destination}: registrado por outro processo durante esta rodada (${already.status}${already.url ? `, ${already.url}` : ""}) — não publica de novo`);
        continue;
      }
    }
    if (item.action === "buffer") {
      // #10772/#14204: só sobe o vídeo (buffer.ts); a Buffer é chamada pela skill (MCP), que registra com --mark.
      const step = await sendBufferItem(sendCtx, item);
      if (step.kind === "settled" && step.result) results.push(step.result);
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
      results.push({ destination: item.destination, ok: false, error: msg });
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
      const step = await sendDestinationItem(sendCtx, item, { clearSending }, ytUpload);
      if (step.kind === "settled") {
        if (step.result) results.push(step.result);
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
        results.push({ destination: item.destination, ok: false, error: msg, cause: "preflight", preflight: e.failure, ...(e.entry ? { entry: e.entry } : {}) });
      } else if (e instanceof ThreadsTimerGateError) {
        // #11410: idem pro Threads pessoal (perfil ilegível ou vídeo do dia sem marcador).
        results.push({ destination: item.destination, ok: false, error: msg, cause: "preflight", preflight: e.failure });
      } else {
        // #12279: na troca o post antigo já saiu: a falha diz isso, com a causa e o caminho de volta.
        const full = afterCancel(msg);
        results.push({ destination: item.destination, ok: false, error: full });
        console.error(`[erro] ${item.destination}: ${full}`);
        continue;
      }
      console.error(`[erro] ${item.destination}: ${msg}`);
      continue;
    }
    if (outcome.alreadyRegistered) {
      clearSending();
      results.push({ destination: item.destination, ok: true, entry: outcome.entry, alreadyRegistered: true });
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
      results.push({ destination: item.destination, ok: false, entry, error: `registro não gravado: ${(e as Error).message}` });
      continue; // marca de envio fica: a plataforma aceitou e o registro não diz
    }
    clearSending();
    results.push({ destination: item.destination, ok: true, entry, unconfirmed, ...(outcome.warnings?.length ? { warnings: outcome.warnings } : {}) });
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
    published: results.filter((r) => r.ok && r.entry?.status === "published").length,
    scheduled: results.filter((r) => r.ok && r.entry?.status === "scheduled").length,
    failed: results.filter((r) => !r.ok).length,
    /** #10772: envio ambíguo — conferir na rede antes de dizer "publicado". */
    unknown: results.filter((r) => r.ok && r.entry?.status === "send_unknown").length,
    buffer: results.filter((r) => r.ok && r.buffer).length,
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
