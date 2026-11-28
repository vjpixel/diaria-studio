/**
 * Plano da rodada (#14327 item 5): config, páginas, autora do Instagram,
 * credenciais de cada destino (LinkedIn e Threads pessoais, YouTube, R2, fila
 * do Worker), a grade de horários e a capa, tudo o que `planShortsPublish`
 * recebe; depois imprime as premissas e os avisos do plano.
 *
 * Movido de `mainUnlocked` (`run.ts`) sem mudança de comportamento. Devolve,
 * além do plano, o que o laço de envio lê (config, credenciais, capa).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CORTES_REL_DIR, type CorteSpec } from "../lib/diaria/short-corte.ts";
import { shortVideoChangeWarnings } from "../lib/diaria/short-scheduled-replace.ts";
import { editionDir as editionDirFor } from "../lib/edition-paths.ts";
import { loadResolvedFacebookPages } from "../lib/facebook-pages.ts";
import { loadShortsConfig, type ShortsPublishedFile } from "../lib/diaria/short-video.ts";
import type { ShortsRegistryWriter } from "../lib/diaria/shorts-published-store.ts";
import { readCorteTimerHeartbeat } from "../lib/diaria/corte-timer-heartbeat.ts";
import { missingYouTubeCredentials } from "../lib/diaria/youtube-upload.ts";
import { loadR2UploadConfig } from "../lib/r2-object-upload.ts";
import { resolveSocialWorkerToken, resolveSocialWorkerUrl } from "../lib/worker-queue-client.ts";
import { LINKEDIN_PERSONAL_ENV, defaultLinkedInApiVersion, readPersonalCreds } from "../lib/linkedin-personal.ts";
import { clampBufferThumbnailOffsetMs, SHORT_COVER_MISSING_ERROR } from "../lib/diaria/short-cover.ts";
import { readThreadsPersonalCreds } from "../lib/threads-personal-video.ts";
import {
  ROOT,
  publicVideoUnavailableReason,
  publicVideoUnavailableCause,
  type ShortsPlan,
  readHorizontalVideoForShort,
} from "./_shared.ts";
import { planShortsPublish } from "./plan.ts";
import { resolveInstagramQueueReadiness, wantsInstagram, type InstagramAuthor, resolveInstagramAuthor } from "./instagram.ts";
import { defaultGraphDeps } from "./facebook.ts";
import { readShortCover, loadScheduledGrid, loadEditionDayGrid, loadWorkerQueueForGrid, resolveEditionUrlInput } from "./run-checks.ts";

/**
 * #14327: monta o plano da rodada. `2` = config dos verticais inválida ou
 * plano recusado (ex.: `--only` com destino desconhecido).
 */
export async function buildShortsRunPlan(input: {
  aammdd: string;
  dir: string;
  corte: CorteSpec | null;
  corteOutside: { dir: string; warning: string } | undefined;
  requireCorteAuth: boolean;
  editionDirOverride: string | undefined;
  unwatchedEditionWarning: string | undefined;
  writer: ShortsRegistryWriter;
  replaceRun: boolean;
  /** `--edition-url`. */
  editionUrlArg: string | undefined;
  /** `--now`. */
  forceNow: boolean;
  reviewedPath: string;
  videoPath: string;
  videoExists: boolean;
  duration: number | null;
  videoHash: string | null;
  /** Registro lido no início (o aviso de vídeo trocado compara com ele). */
  published: ShortsPublishedFile;
  /** #12279: na substituição, o registro sem os alvos e o `--only` deles. */
  planPublished: ShortsPublishedFile;
  planOnly: string[] | null;
}) {
  const { aammdd, dir, corte, corteOutside, requireCorteAuth, editionDirOverride, writer, planPublished, planOnly, videoPath, videoExists, duration } = input;
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
  const editionUrlIn = resolveEditionUrlInput(dir, input.editionUrlArg);
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
      reviewedMd: corte ? "" : readFileSync(input.reviewedPath, "utf8"),
      // #11964: o filho do timer (--require-corte-authorization) é o único que publica os destinos do timer na janela.
      ...(corte
        ? { corte: { slug: corte.slug, hhmm: corte.hhmm, title: corte.title, hook: corte.hook, timerRun: requireCorteAuth }, ...(corteOutside ? { corteOutside } : {}) }
        : editionDirOverride !== undefined
          ? { editionDirOverride, unwatchedEditionWarning: input.unwatchedEditionWarning! }
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
      forceNow: input.forceNow,
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
  if (!input.replaceRun && !corte && input.videoHash) plan.warnings.push(...shortVideoChangeWarnings(input.published.entries, input.videoHash));
  for (const p of plan.premises) console.error(`[premissa] ${p}`);
  for (const w of plan.warnings) console.error(`[aviso] ${w}`);
  return { plan, config, pages, apiVersion, igApiVersion, shortsCfg, igAuthor, workerUrl, workerToken, r2, liCreds, liApiVersion, threadsCreds, ytMissing, shortCover, bufferOffsetMs };
}

/** #14327: o plano montado e o que o laço de envio lê dele. */
export type ShortsRunPlan = Exclude<Awaited<ReturnType<typeof buildShortsRunPlan>>, number>;
