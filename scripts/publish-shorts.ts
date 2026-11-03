#!/usr/bin/env node
import { cleanupPublishedVideo, recordCredentialSkips, shortsVideoTerminal } from "./lib/diaria/published-video-cleanup.ts";
/**
 * scripts/publish-shorts.ts (#10769)
 *
 * Publica o vídeo CURTO (vertical) da edição — o recorte do "diar.ia.br
 * comentada" — como Reels nas páginas do Facebook e no Instagram, via Graph
 * API, e monta os passos GUIADOS (Chrome, com o editor) do YouTube Shorts e do
 * perfil pessoal. Miolo puro em `scripts/lib/diaria/short-video.ts`.
 *
 * Uso:
 *   npx tsx scripts/publish-shorts.ts AAMMDD                # plano (dry-run), não publica nada
 *   npx tsx scripts/publish-shorts.ts AAMMDD --publish --confirm-publish AAMMDD
 *                                                           # publica os destinos de API (a confirmação é a
 *                                                           # mesma edição, dada só depois do "pode publicar"
 *                                                           # do editor; sem ela, exit 2 sem nada, #11741)
 *     [--only facebook:diaria,instagram] [--now] [--video PATH]
 *     [--edition-dir DIR] [--edition-url URL]
 *     [--linkedin-timer | --instagram-timer | --threads-timer] # rodada de um timer do 300 (só o destino dele, #10982/#11265/#11410)
 *   npx tsx scripts/publish-shorts.ts AAMMDD --from-drive FILE_ID
 *                                                           # baixa o vertical do Drive (OAuth do projeto, não o conector)
 *   npx tsx scripts/publish-shorts.ts AAMMDD --mark youtube_shorts=URL
 *                                                           # registra destino GUIADO já feito
 *   npx tsx scripts/publish-shorts.ts AAMMDD --confirm-instagram [--since ISO] [--media-id ID] [--url URL]
 *                                                           # registra o Reels postado no Chrome (lê /media, #10915;
 *                                                           # #11794: a autora à mão é a @diar.ia.br, a conta da API;
 *                                                           # aceita o permalink com --url)
 *   npx tsx scripts/publish-shorts.ts --corte SLUG --date AAMMDD --at HH:MM --title T --hook H
 *     (--video PATH | --from-drive FILE_ID) [--cover JPG] [--publish] [--only ...] [--now]
 *                                                           # corte AVULSO, fora de edição (#11795): título e gancho
 *                                                           # explícitos, registro em data/cortes/SLUG/ (corte.json +
 *                                                           # 06-shorts-published.json), R2 em shorts/cortes/, horário
 *                                                           # explícito fora do teste do #10831, sem os timers da edição
 *                                                           # (com publishing.shorts.corte_via_timer, o timer próprio do
 *                                                           # corte no 300, Diaria-Shorts-Cortes, publica e alarma, só
 *                                                           # o que o --publish --confirm-publish gravou no corte.json
 *                                                           # como "pode publicar": destinos e sha256, #11912).
 *                                                           # Re-execução e --mark só com --corte SLUG (fora de
 *                                                           # data/cortes/, com o mesmo --edition-dir e a flag abaixo).
 *                                                           # #11911: --edition-dir fora de data/cortes/SLUG/ (caminho
 *                                                           # real) é RECUSADO: o timer e o vigia de cortes sem dono só
 *                                                           # leem data/cortes/. Escape: --allow-unwatched-dir (avisa
 *                                                           # que nenhum alarme de destino faltante cobre o corte;
 *                                                           # recusado se data/cortes/SLUG/corte.json já existir).
 *                                                           # Idem no modo edição: --edition-dir fora de
 *                                                           # data/editions/AAMM/AAMMDD/ é recusado sem a mesma flag.
 *   npx tsx scripts/publish-shorts.ts (AAMMDD | --corte SLUG) --update-scheduled [--publish --confirm-publish AAMMDD]
 *                                                           # #11795: troca texto e capa de post JÁ AGENDADO (YouTube
 *                                                           # videos.update + thumbnails.set; Facebook POST /{video-id}
 *                                                           # + /thumbnails); X/TikTok voltam como edit_post da Buffer.
 *
 * Destinos (config `publishing.shorts`, default = decisão do editor):
 *   - `facebook:{slug}` (API) — cada slug de `publishing.shorts.facebook_pages`,
 *     credencial pelas env vars da página em `publishing.social.facebook.pages`
 *     (`scripts/lib/facebook-pages.ts`). O `enabled` de lá NÃO vale aqui: ele
 *     liga os posts diários da página, não o Reels. Página sem credencial =
 *     aviso e segue (rode `scripts/facebook-page-token-setup.ts`). Até 90 s
 *     sobe por `video_reels`; acima disso (a API de Reels recusa), por
 *     `/{page-id}/videos` em upload RESUMABLE (start/transfer/finish, #10815:
 *     o POST único dava 413 com o vertical de 275 MB) — vídeo vertical aparece
 *     como Reel.
 *   - `instagram` (API) — Reels no Instagram. Autora: a conta do Instagram
 *     vinculada à página `publishing.shorts.instagram_author_page` (#10790
 *     usava a conta pessoal do editor, ligada à página VJ pixel); `null` = conta
 *     da diar.ia.br, a autora desde #11223 (27/10/2026)
 *     (`INSTAGRAM_BUSINESS_ACCOUNT_ID` + `INSTAGRAM_ACCESS_TOKEN`). Contas de
 *     `instagram_collaborators` entram como collab (aceitam o convite no app);
 *     depois do publish o script relê os collaborators da mídia e avisa se o
 *     convite foi descartado (#10820). No dry-run confere também se o token da
 *     página tem `instagram_content_publish` (#10820). Na @diar.ia.br o
 *     container é criado com `video_url` (R2) em vez do rupload, sem teto de
 *     duração (#11355); as outras autoras seguem no rupload. Acima do teto de
 *     duração DA AUTORA (`instagram_api_max_seconds_by_account`, #10916) vira
 *     passo guiado no Chrome: o `--publish` gera a versão comprimida em
 *     `_internal/`, mirando 9,5 MB (abaixo do limite de 10 MB do file_upload;
 *     `upload` do item, #10915), e o `--confirm-instagram` registra.
 *   - `linkedin_profile` (API, #10772) — vídeo NATIVO no perfil pessoal do
 *     editor pela Videos API (`scripts/lib/linkedin-video.ts`), com o token do
 *     4º post (`LINKEDIN_PERSONAL_*`, nenhum segredo novo). Texto sem link
 *     (título, gancho e hashtags, #11617). A Posts API
 *     não agenda: antes do horário fica `pending_schedule` (rode de novo depois,
 *     ou `--now`). Envio ambíguo grava `send_unknown` e nunca re-posta.
 *   - `linkedin_page_repost` (guiado, #10772) — repost do vídeo do perfil pela
 *     página, no horário que a grade da PÁGINA permite (`planLinkedInRepostSlot`:
 *     2 h dos posts da rotação #10305, picos, ≥30 min depois do perfil). Guiado
 *     porque não há token de organização local (a página publica pelo Worker).
 *   - `x` (guiado, #10772) — X @diariabr pela Buffer (MCP, só a skill alcança).
 *     O plano traz texto (≤280 ponderado) e `dueAt`; com R2 configurado o
 *     `--publish` sobe o vertical e devolve `results[].buffer.videoUrl` (e
 *     `thumbnailOffset` em ms, a capa do X, quando o Still traz timecode, #11547).
 *     O R2 está habilitado desde 27/10/2026 (#10772, bucket `diaria-shorts`);
 *     só numa máquina sem os secrets dele o X é pulado com aviso e fica
 *     PENDENTE (#11478/#11498): o `-short.mp4` fica no disco e uma máquina com
 *     os secrets publica; à mão só registrando com `--mark`, senão sai
 *     duplicado. Registro com `--mark x=buffer:{id} --scheduled-at {dueAt}`.
 *   - `tiktok` (guiado, #11515) — TikTok @diar.ia.br pela Buffer (MCP, só a
 *     skill alcança), mesmo caminho do X: texto (`buildTikTokPost`, sem link),
 *     `dueAt` e, no `--publish`, `results[].buffer` com `videoUrl`, `channelId`
 *     (`publishing.shorts.tiktok_buffer_channel_id`) e `metadata.tiktok`
 *     (`title`, `isAiGenerated: false`). Registro com `--mark tiktok=buffer:{id}`.
 *   - `threads_profile` (API, #11122) — vertical no Threads PESSOAL do editor
 *     (`scripts/lib/threads-personal-video.ts`, `THREADS_PERSONAL_*`), com o
 *     vertical por URL pública (R2) e o texto de `buildShortSocialText`
 *     (`platform: "threads"`). Sem token, ou sem os secrets do R2 na máquina
 *     (os dois existem desde 27/10/2026, #10772), é pulado com aviso
 *     (fail-soft). Sem token é terminal (#11240); sem R2 fica PENDENTE para
 *     uma máquina com os secrets (#11478/#11498), nunca "postar à mão" sem
 *     `--mark`. A API não agenda: mesmo `pending_schedule`/teto de atraso do
 *     `linkedin_profile`. Envio ambíguo grava `send_unknown` (conta como feito,
 *     nunca re-posta); confira o perfil e registre com `--mark threads_profile=URL`.
 *     O repost pela diar.ia.br não entra: a Threads API não documenta repost.
 *     #11410: com `publishing.shorts.threads_profile_via_timer: true` quem
 *     publica é o timer do 300 (`scripts/shorts-threads-profile-timer.ts`,
 *     `--only threads_profile --publish --threads-timer`), no horário do
 *     vertical; as outras rodadas devolvem `skip_delegated`. A rodada do timer
 *     grava no registro próprio (`06-shorts-published.threads-timer.json`) e
 *     reaproveita o objeto do vertical já no R2 (`reuseOrUploadToR2`). Toda
 *     rodada que publica o destino (a do timer, a da skill, a task one-shot do
 *     app desktop, o corte avulso) confere o perfil antes
 *     (`threadsProfilePreflight`, só leitura, #11742): o config em `false` num
 *     checkout defasado não abre mais a corrida com o timer.
 *   - `youtube_shorts` (API, #11070) — Short pela YouTube Data API
 *     (`publishYouTubeShort`, o mesmo upload do `publish-youtube.ts`), private
 *     + `publishAt` no horário do vertical (o agendado vira público sozinho sem
 *     a auditoria, medido em 23/10/2026), com a capa por `thumbnails.set` (vale
 *     pra Short, medido em 28/10/2026, #11547). Confere o canal antes (Short da edição já lá vira registro;
 *     só pelo dia, pede `--mark` ou `--force-youtube`). Sem `YOUTUBE_*` ou com
 *     `publishing.shorts.youtube_shorts_api: false`, volta a ser guiado.
 *   - `facebook_profile` (guiado) — o JSON traz a legenda; o skill
 *     `/diaria-shorts` executa no Chrome e grava com `--mark`. Sem comentário
 *     fixado no Short: link em comentário de Short não é clicável (#10831).
 *
 * `linkedin_profile` pelo timer do 300 (#10982): com
 * `publishing.shorts.linkedin_profile_via_timer: true`, só a rodada com
 * `--linkedin-timer` (a de `scripts/shorts-linkedin-profile-timer.ts`) publica
 * o vídeo do perfil; as outras o devolvem `skip_delegated`. #11159: o
 * `--linkedin-timer` só vale com `--only linkedin_profile` (ou `--mark
 * linkedin_profile=URL`) — qualquer outro destino nessa rodada cairia no
 * registro do timer e voltaria a ter dois escritores em máquinas diferentes.
 *
 * Horário (#10831): o do vertical, `resolveShortTime` — teste de 15 dias úteis
 * alternando 06:30/08:00/12:00 BRT a partir de 261026 (`publishing.shorts.schedule`),
 * nunca as 06:00 do horizontal. Com pelo menos 10 min de folga o Facebook
 * agenda (a folga é reconferida antes de cada página); senão publica na hora.
 * O Instagram não agenda Reels pela API. Desde #11265 (decisão do editor,
 * 27/10/2026) quem publica é o timer do 300 (`publishing.shorts.instagram_backend`
 * = "timer-300", default): `scripts/shorts-instagram-timer.ts` roda esta CLI com
 * `--only instagram --publish --instagram-timer` no horário do vertical, com
 * o vídeo no R2 e o container por `video_url` (@diar.ia.br, #11355; o rupload
 * para em ~32,5 s de processamento e recusa os verticais reais), e as outras
 * rodadas devolvem o `instagram` como `skip_delegated`. A rodada do timer grava no
 * registro próprio (`06-shorts-published.instagram-timer.json`), confere
 * antes na conta (`/media`, só leitura) se o Reels da edição já saiu por fora,
 * e passadas 3 h do horário vira `skip_late` (o timer avisa o editor).
 * O caminho antigo (#10823, `instagram_backend: "worker-r2"`) segue como
 * opção: o vertical sobe pro R2 e o Reels vai pra FILA do Worker
 * `diaria-linkedin-cron`; sem Worker, sem R2 ou com autora que o Worker não
 * conhece, fica pendente até rodar de novo depois do horário (ou `--now`).
 * O R2 foi habilitado depois (#10772), mas o editor manteve o `timer-300`
 * (#11411: o timer funciona; racional em `docs/scheduled-tasks-registry.md`). X e Threads, que só
 * recebem o vídeo por URL pública, usam o R2 independente do
 * `instagram_backend` (`r2.ready`); só sem os secrets dele ficam pulados com
 * aviso (manuais).
 *
 * Grade (#10819, `planShortSlots`): o plano lê o que já está agendado no dia
 * (`_internal/06-social-published.json` + `06-shorts-published.json`). Durante
 * o teste do #10831 o horário do teste vale pra todos os destinos e a grade só
 * avisa quando ele cola num post da mesma conta; fora do teste, cada destino
 * de API tem o próprio horário (`slots` no plano) pelo `social-slot-planner`.
 * O Instagram manual acima do teto (#10893) também reserva slot (#10933): é um
 * post da conta naquele horário, só que feito no app. O Reels do Instagram
 * conta também como post dos collabs (a @diar.ia.br, decisão do editor
 * 261023), e a grade inclui a fila do Worker (`GET /list`, fail-soft): os
 * posts que as skills de divulgação agendaram pro mesmo dia.
 *
 * Link da edição: `--edition-url` > `_internal/05-edition-url.txt` (gravado no
 * Stage 5) > slug derivado do título do D1. O derivado é premissa, não aviso: é
 * a mesma regra com que o Stage 5 grava `05-edition-url.txt` (#7420), então o
 * vertical pode sair antes da Etapa 5 (fluxo do #10943).
 *
 * Registro por destino em `{edição}/_internal/06-shorts-published.json`
 * (escrita atômica, logo após cada destino). Destino registrado é pulado.
 * #11157: a rodada `--linkedin-timer` grava no registro próprio do timer
 * (`06-shorts-published.linkedin-timer.json`); a leitura une os dois (e as
 * cópias de conflito do OneDrive), cada gravação relê do disco e troca só a
 * própria entrada sob lock, e cada destino é reconferido no disco logo antes
 * de publicar (`scripts/lib/diaria/shorts-published-store.ts`).
 * Registro ilegível ABORTA (nunca vira "nada publicado", o que duplicaria
 * Reels públicos). Se a plataforma aceitar e a gravação falhar, o erro mostra
 * o id/URL e o comando `--mark` pra registrar à mão.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDestaques } from "./extract-destaques.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { publishConfirmSuffix, publishConfirmationError } from "./lib/diaria/publish-confirm.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { deriveEditionUrl } from "./lib/edition-url.ts";
import {
  CORTE_SPEC_FILE,
  CORTE_TIMER_DESTINATIONS,
  CORTE_TIMER_INTERVAL_MS,
  CORTE_TIMER_LOCK_FILE,
  CORTE_TIMER_TASK,
  ALLOW_UNWATCHED_DIR_FLAG,
  CORTES_REL_DIR,
  checkCorteDir,
  corteBaseCommand,
  corteR2Key,
  corteRelDir,
  corteShortTime,
  corteTextInput,
  corteVideoFileName,
  corteVideoPortabilityWarning,
  corteVideoRef,
  mergeCorteSpec,
  realpathLenient,
  resolveCorteVideo,
  parseCorteSpec,
  samePathOnPlatform,
  shellQuote,
  type CorteSpec,
} from "./lib/diaria/short-corte.ts";
import {
  corteAuthorizedDestinations,
  corteContentCheck,
  planCorteAuthorizationRestore,
  withCortePublishAuthorization,
  withoutCortePublishAuthorization,
  type CorteContentFingerprint,
  type CorteRevocationKind,
} from "./lib/diaria/short-corte.ts";
import { corteContentFingerprint, corteContentFingerprintFromBytes } from "./lib/diaria/corte-content.ts";
import { planScheduledUpdates, type ScheduledUpdateItem } from "./lib/diaria/short-scheduled-update.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import { loadResolvedFacebookPages, type ResolvedFacebookPage } from "./lib/facebook-pages.ts";
import {
  buildReelsCaption,
  buildYouTubeShortMetadata,
  DIARIA_YOUTUBE_CHANNEL_URL,
  firstSentence,
  facebookDestinationId,
  facebookUploadRoute,
  INSTAGRAM_CHROME_ROUTE,
  INSTAGRAM_ENV_ACCOUNT_KEY,
  instagramAccountKey,
  REELS_NEWSLETTER_SENTENCE,
  instagramApiMaxSecondsPremise,
  instagramReelUploadRoute,
  shortInstagramVideoFileName,
  type InstagramReelUploadRoute,
  instagramChromeRouteText,
  instagramReelsApiFit,
  isDestinationDone,
  knownDestinationIds,
  listShortDestinations,
  loadShortScheduleConfig,
  loadShortsConfig,
  mp4DurationSeconds,
  planShortSlots,
  resolveInstagramApiMaxSeconds,
  resolveReelsSchedule,
  resolveShortTime,
  buildShortSocialText,
  buildTikTokPost,
  planLinkedInRepostSlot,
  shortVideoFileName,
  type ShortDestination,
  type ShortPublishedEntry,
  type ShortSlot,
  type ShortsConfig,
  type ShortsPublishedFile,
  type ShortTime,
  type InstagramBackend,
  type WorkerInstagramAccount,
  type YouTubeShortMetadata,
  shortDestinationAccount,
  shortDestinationAlsoAccounts,
} from "./lib/diaria/short-video.ts";
import {
  instagramTimerScopeError,
  linkedinTimerScopeError,
  threadsTimerScopeError,
  persistShortEntry,
  readShortsRegistry,
  shortsRegistryPath,
  shortsRegistryWriterFor,
  type ShortsRegistryWriter,
} from "./lib/diaria/shorts-published-store.ts";
import { clearShortSending, markShortSending } from "./lib/diaria/shorts-sending-marker.ts";
import { acquireTimerLock, TIMER_LOCK_HEARTBEAT_MS } from "./lib/diaria/timer-lock.ts";
import { corteTimerHeartbeatStale, describeCorteTimerHeartbeat, readCorteTimerHeartbeat, type CorteTimerHeartbeat } from "./lib/diaria/corte-timer-heartbeat.ts";
import {
  buildYouTubeInsertRequest,
  buildYouTubeTags,
  resolveYouTubeSchedule,
  stripInlineMarkdown,
  youtubeVideoFileName,
  type YouTubeScheduleDecision,
} from "./lib/diaria/youtube-video.ts";
import {
  ExistingEditionVideoError,
  defaultYouTubeUploadDeps,
  describeYouTubeState,
  failedUploadStatus,
  isIndeterminateUploadFailure,
  missingYouTubeCredentials,
  updateScheduledVideo,
  uploadYouTubeVideo,
  type YouTubeUploadDeps,
} from "./lib/diaria/youtube-upload.ts";
import { resolveYouTubeState } from "./lib/publish-state.ts";
import { gFetchRetry } from "./lib/drive-helpers.ts";
import { DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS, downloadDriveFileById } from "./lib/drive-download.ts";
import {
  gridFromLinkedInPersonalIntent,
  gridFromShortsPublished,
  gridFromSocialPublished,
  gridFromWorkerQueue,
  mergeGrids,
  type ScheduledSlot,
} from "./lib/social-slot-planner.ts";
import { loadR2UploadConfig, r2ObjectHasBody, r2PublicUrl, reuseOrUploadToR2 } from "./lib/r2-object-upload.ts";
import { buildReelsQueuePayload, postToWorkerQueue, WorkerQueueError, type WorkerQueuePayload } from "./lib/worker-queue-client.ts";
import { resolveShortEntryState, resolveWorkerQueueState } from "./lib/publish-state.ts";
import { LINKEDIN_PERSONAL_ENV, MAX_FIRE_LATENESS_MS, PERSONAL_INTENT_FILE, defaultLinkedInApiVersion, postUrlFromUrn, readPersonalCreds, type PersonalCreds } from "./lib/linkedin-personal.ts";
import { postVideoToPersonalProfile, type LinkedInVideoDeps } from "./lib/linkedin-video.ts";
import {
  SHORT_COVER_FILE,
  SHORT_COVER_SOURCE_FILE,
  bufferThumbnailOffsetMs,
  clampBufferThumbnailOffsetMs,
  carryOverCover,
  parseShortCoverSource,
  planCoverDestination,
  withCoverRecord,
  withMissingCoverRecord,
  SHORT_COVER_MISSING_ERROR,
  type ShortCoverRecord,
} from "./lib/diaria/short-cover.ts"; // #11547
import {
  THREADS_PROFILE_DESTINATION,
  ThreadsTimerGateError,
  publishThreadsProfileVideo,
  readThreadsPersonalCreds,
  threadsProfilePreflight,
  type ThreadsTimerGateFailure,
} from "./lib/threads-personal-video.ts";
import {
  CHROME_UPLOAD_MAX_BYTES,
  buildChromeUploadFfmpegPasses,
  chromeUploadBitrate,
  chromeUploadFileName,
  chromeUploadReusable,
  chromeUploadSidecarPath,
  fitsChromeUpload,
  type ChromeUploadPlanFile,
  type ChromeUploadResult,
  type ChromeUploadSidecar,
} from "./lib/diaria/instagram-chrome-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** #11795: link de referência do corte avulso (nenhum texto do vertical leva link, #11617). */
export const DIARIA_HOME_URL = "https://diar.ia.br";
const GRAPH = "https://graph.facebook.com";
const GRAPH_VIDEO = "https://graph-video.facebook.com";
const RUPLOAD = "https://rupload.facebook.com";

/**
 * #10982: por que o `linkedin_profile` não sai nesta rodada quando o timer do
 * 300 é o dono dele (`publishing.shorts.linkedin_profile_via_timer`).
 */
export const LINKEDIN_TIMER_DETAIL =
  "sai pelo timer do 300 (Diaria-Shorts-LinkedIn-Profile, publishing.shorts.linkedin_profile_via_timer) no horário do vertical; " +
  "para publicar desta máquina mesmo assim, rode só esse destino com --only linkedin_profile --linkedin-timer --publish --confirm-publish AAMMDD " +
  "(confira antes que o 300 não publicou; o --linkedin-timer recusa qualquer outro destino)";

/**
 * #11265: por que o `instagram` não sai nesta rodada quando o timer do 300 é
 * o dono dele (`publishing.shorts.instagram_backend: "timer-300"`).
 */
export const INSTAGRAM_TIMER_DETAIL =
  "sai pelo timer do 300 (Diaria-Shorts-Instagram, publishing.shorts.instagram_backend = timer-300) no horário do vertical, " +
  "com o vertical único do Drive pela API; se não conseguir, volta a tentar sozinho de hora em hora até 3 h depois do horário do vertical " +
  "e, se ainda assim o Reels não sair (acima do teto da API, credencial, falha), abre um alarme para o editor. " +
  "Para publicar pela API mesmo assim, rode NO 300 (de outra máquina vira um segundo escritor: o lock do timer não cruza máquina e o Reels sai duplicado) " +
  "só esse destino com --only instagram --instagram-timer --publish --confirm-publish AAMMDD " +
  "(confira antes que o 300 não publicou; o --instagram-timer recusa qualquer outro destino)";

/**
 * #11410: por que o `threads_profile` não sai nesta rodada quando o timer do
 * 300 é o dono dele (`publishing.shorts.threads_profile_via_timer`).
 */
export const THREADS_TIMER_DETAIL =
  "sai pelo timer do 300 (Diaria-Shorts-Threads-Profile, publishing.shorts.threads_profile_via_timer) no horário do vertical, " +
  "até 3 h depois dele; se não sair, o timer abre um alarme para o editor. " +
  "Para publicar mesmo assim, rode NO 300 (de outra máquina vira um segundo escritor e o post pode sair duplicado) " +
  "só esse destino com --only threads_profile --threads-timer --publish --confirm-publish AAMMDD " +
  "(confira antes que o vídeo não está no perfil; o --threads-timer recusa qualquer outro destino)";

/**
 * #11964: por que um destino do timer do corte (`CORTE_TIMER_DESTINATIONS`) não
 * sai na rodada manual do corte com `publishing.shorts.corte_via_timer` ligado,
 * a partir de 10 min antes do horário até 3 h depois: é a janela em que o timer
 * do 300 publica. As duas rodadas publicando o mesmo destino ao mesmo tempo
 * duplicam o post (a conferência da conta só vê o post que já está no ar).
 */
export function corteTimerDelegatedDetail(slug: string): string {
  return (
    `sai pelo timer do 300 (${CORTE_TIMER_TASK}, de hora em hora, publishing.shorts.corte_via_timer), que é o dono deste destino do horário do corte até 3 h depois e alarma se falhar; ` +
    `esta rodada não o publica para não sair em dobro com o timer (#11964). O timer só publica com o "pode publicar" (--publish --confirm-publish do corte). ` +
    `Para publicar já, rode NO 300 o próprio timer: npx tsx scripts/shorts-corte-timer.ts --corte ${slug}`
  );
}

/**
 * #11265: motivo do pulo de X/Threads quando o R2 NÃO está configurado (só é
 * chamado com `r2.ready === false`). Escrito quando o R2 não seria habilitado
 * (decisão do editor, 27/10/2026); ele foi habilitado no mesmo dia (#10772),
 * então hoje `r2.ready === false` significa máquina sem os secrets
 * `R2_*`/`SHORTS_R2_*`. Com o backend do timer o aviso não lista os secrets;
 * com `worker-r2` (que depende dele) lista o que falta. Desde o #11478 o
 * destino fica PENDENTE (não terminal) e o aviso diz isso (#11498): mandar o
 * editor postar à mão o que outra máquina vai publicar duplica o post.
 */
export function publicVideoUnavailableReason(backend: InstagramBackend, r2Missing: readonly string[]): string {
  const cause = publicVideoUnavailableCause(backend, r2Missing);
  return backend === "timer-300" ? `${cause} — fica pendente; publica numa máquina com os secrets do R2 (ou à mão, registrando com --mark)` : cause;
}

/**
 * Pure: só a causa, sem o "fica pendente" de X/Threads. É o que o Instagram do
 * timer cita (#11355): ali quem responde é o alarme, com o que fazer no corpo.
 */
export function publicVideoUnavailableCause(backend: InstagramBackend, r2Missing: readonly string[]): string {
  return backend === "timer-300"
    ? "sem URL pública do vertical: R2 não configurado nesta máquina (faltam os secrets R2_*/SHORTS_R2_*; o bucket existe desde 27/10/2026, #10772/#11265)"
    : `falta ${r2Missing.join(", ")}`;
}

/** Destinos que só o skill faz (Chrome; o X e o TikTok pela Buffer MCP, #10772/#11515). */
export const GUIDED_DESTINATIONS = new Set(["youtube_shorts", "facebook_profile", "linkedin_page_repost", "x", "tiktok"]);

/** #11515: destinos que saem pela Buffer (`--mark {destino}=buffer:{id}`). */
export const BUFFER_DESTINATIONS = new Set(["x", "tiktok"]);

/**
 * Destinos que `--mark` aceita: os guiados + o `instagram`, que vira passo
 * guiado quando o vertical passa do teto de duração da API (#10893) — o editor
 * posta no app e registra, e a próxima rodada não tenta o rupload de novo — e
 * os dois perfis pessoais de API (`linkedin_profile`, `threads_profile`,
 * #11122), pra registrar a URL depois de conferir um `send_unknown`.
 */
export const MARKABLE_DESTINATIONS = new Set([...GUIDED_DESTINATIONS, "instagram", "linkedin_profile", THREADS_PROFILE_DESTINATION]);

export type ShortsPlanItem =
  /** `title`: título da mídia (vídeo do LinkedIn pessoal, #10772). */
  | { destination: string; mode: "api"; action: "publish"; caption: string; scheduledAt: string | null; title?: string }
  | { destination: string; mode: "api"; action: "pending_schedule"; caption: string; scheduledAt: string; detail: string }
  /** #10823: Reels do Instagram com horário futuro, entregue à fila do Worker. */
  /** `idempotencyKey` (#10906): o POST /queue repetido cai na mesma entry do Worker. */
  | { destination: string; mode: "api"; action: "enqueue"; caption: string; scheduledAt: string; igAccount: WorkerInstagramAccount; idempotencyKey: string }
  | { destination: string; mode: "api" | "guided"; action: "skip_done" }
  /** `skip_late` (#10772 F4): o horário do destino passou além do teto de atraso — vira passo manual. */
  /** `skip_delegated` (#10982): o destino sai por outro caminho (o `linkedin_profile` pelo timer do 300). */
  /**
   * `cause: "public_video"` (#11240): o pulo veio do R2 fora do ar (X/Threads
   * recebem o vídeo por URL pública), não de credencial do destino. Só o pulo
   * por credencial conta como terminal pra limpeza do vertical.
   */
  | { destination: string; mode: "api" | "guided"; action: "skip_missing_credentials" | "skip_invalid" | "skip_late" | "skip_delegated"; detail: string; cause?: "public_video" }
  /** `at`: horário planejado do passo guiado (repost da página, #10772; Instagram manual acima do teto, slot da grade, #10933). Ausente = `shortTime`. */
  /**
   * `upload` (#10915): o arquivo a subir no passo guiado — no Instagram acima
   * do teto, a versão comprimida pro `file_upload` do Chrome (ou o original,
   * se a compressão falhou), com `fitsChromeUpload` dizendo se ele cabe nos
   * 10 MB do `file_upload`. Só existe depois do `--publish`.
   */
  | { destination: string; mode: "guided"; action: "guided"; caption?: string; detail: string; at?: string; upload?: ChromeUploadPlanFile }
  /**
   * #10772: X via Buffer (MCP, só a skill chama). `scheduledAt` null = postar
   * já. A URL pública do vídeo só existe no `--publish` (sobe pro R2): vem em
   * `results[].buffer`.
   */
  | {
      destination: string;
      mode: "guided";
      action: "buffer";
      caption: string;
      scheduledAt: string | null;
      detail: string;
      /** #11515: canal da Buffer quando o destino não é o X (o do X vem de `publishing.social.twitter`). */
      channelId?: string;
      /** #11515: `metadata.tiktok` do `create_post` (título e a declaração de conteúdo de IA). */
      tiktok?: TikTokBufferMetadata;
    };

/** #11515: `metadata.tiktok` da Buffer. `isAiGenerated: false`: o vídeo é o Pixel gravado (decisão do editor, 28/10/2026). */
export interface TikTokBufferMetadata {
  title: string;
  isAiGenerated: boolean;
}

export interface ShortsPlan {
  aammdd: string;
  editionUrl: string;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  cover: { path: string | null; destinations: Record<string, string> };
  longVideo: string;
  youtube: YouTubeShortMetadata;
  /** Horário do vertical (#10831): HH:MM BRT, ISO no dia da edição, de onde veio. Base dos destinos guiados. */
  shortTime: ShortTime & { at: string };
  /** Horário de cada destino de API desta rodada contra a grade já agendada (#10819). */
  slots: ShortSlot[];
  items: ShortsPlanItem[];
  /**
   * #11550: quem executa cada destino que não sai nesta rodada (ou sai por
   * passo da skill). Decisão do editor de 28/10/2026: "sempre é você que
   * precisa publicar" — nenhum destino volta para ele como passo manual.
   */
  owners: ShortsDestinationOwner[];
  premises: string[];
  warnings: string[];
}

/**
 * #11550: o dono automático de um destino.
 *   - `timer-300`: uma task do 300 publica (`task`), sem ação da skill;
 *   - `agent-scheduled-task`: a skill cria uma task agendada one-shot que roda
 *     `command` em `at` (a API do destino não agenda e não há timer ligado);
 *   - `agent`: o agente executa nesta mesma rodada (`command`, ou o passo
 *     guiado/Buffer descrito no item).
 * Nunca `editor`: o relato da skill não devolve destino ao editor.
 */
export interface ShortsDestinationOwner {
  destination: string;
  action: ShortsPlanItem["action"];
  by: "timer-300" | "agent-scheduled-task" | "agent";
  task?: string;
  at?: string;
  command?: string;
  note: string;
}

/** Task do 300 que é dona de cada destino delegado (`scripts/lib/scheduled-tasks.ts`). */
export const SHORTS_TIMER_TASKS: Readonly<Record<string, string>> = {
  linkedin_profile: "Diaria-Shorts-LinkedIn-Profile",
  instagram: "Diaria-Shorts-Instagram",
  [THREADS_PROFILE_DESTINATION]: "Diaria-Shorts-Threads-Profile",
};

/** Flag de timer que faz a rodada ser a dona do destino (sem ela o destino delegado cai em `skip_delegated`). */
const TIMER_FLAG_OF: Partial<Record<ShortsRegistryWriter, { destination: string; flag: string }>> = {
  "linkedin-timer": { destination: "linkedin_profile", flag: "--linkedin-timer" },
  "threads-timer": { destination: THREADS_PROFILE_DESTINATION, flag: "--threads-timer" },
  "instagram-timer": { destination: "instagram", flag: "--instagram-timer" },
};

/**
 * Pure (#11679 item 3): argumentos que publicam um destino em `skip_late` já.
 * Na rodada do timer dono do destino, `--only X --publish --now` sem a flag do
 * timer cai em `skip_delegated` e não publica — a flag vai junto.
 */
export function lateNowArgs(destination: string, writer?: ShortsRegistryWriter): string {
  const timer = writer ? TIMER_FLAG_OF[writer] : undefined;
  return `--only ${destination} --publish${timer?.destination === destination ? ` ${timer.flag}` : ""} --now`;
}

/** Antecedência mínima para valer a pena agendar em vez de executar já (mesmo limiar de `resolveReelsSchedule`). */
const OWNER_SCHEDULE_MIN_LEAD_MS = 10 * 60_000;

/**
 * Pure (#11550): dono de cada destino que não terminou nesta rodada.
 * `pending_schedule` sem timer vira task agendada pela skill; `skip_late` e os
 * passos guiados/Buffer ficam com o agente; `skip_delegated`, com o timer.
 * Destinos que saem nesta rodada (`publish`/`enqueue`), já registrados
 * (`skip_done`) ou pulados por credencial/conteúdo não entram.
 */
export function assignShortsDestinationOwners(
  items: readonly ShortsPlanItem[],
  ctx: {
    aammdd: string;
    now: Date;
    instagramViaTimer: boolean;
    writer?: ShortsRegistryWriter;
    /** #11795: comando base do corte avulso (`--corte SLUG`); os passos guiados re-executam por ele, sem a skill da edição. */
    baseCommand?: string;
    /** #11795: corte avulso com `publishing.shorts.corte_via_timer` — o timer do 300 é o dono dos destinos que a API não agenda. */
    corteTimer?: boolean;
    /** #11911: `--edition-dir` fora da pasta canônica — vai em todo comando de re-execução da edição. */
    editionDirOverride?: string;
  },
): ShortsDestinationOwner[] {
  // #11911: a pasta fora da canônica só roda com o escape — a re-execução leva os dois.
  // #11944: aspas simples de shell (com JSON.stringify, `$` e crase do caminho seriam expandidos).
  const dirArg = ctx.editionDirOverride !== undefined ? ` --edition-dir ${shellQuote(ctx.editionDirOverride)} --${ALLOW_UNWATCHED_DIR_FLAG}` : "";
  const base = ctx.baseCommand ?? `npx tsx scripts/publish-shorts.ts ${ctx.aammdd}${dirArg}`;
  const owners: ShortsDestinationOwner[] = [];
  for (const item of items) {
    const { destination, action } = item;
    if (action === "skip_delegated" && ctx.corteTimer && CORTE_TIMER_DESTINATIONS.includes(destination)) {
      // #11964: no corte, o dono é o timer do corte (não os timers da edição).
      owners.push({
        destination,
        action,
        by: "timer-300",
        task: CORTE_TIMER_TASK,
        note: `o timer do 300 (${CORTE_TIMER_TASK}, de hora em hora) publica na próxima execução, até 3 h depois do horário do corte, e alarma se falhar; só com o "pode publicar" do --publish --confirm-publish (#11912, #11964)`,
      });
    } else if (action === "skip_delegated") {
      const task = SHORTS_TIMER_TASKS[destination];
      owners.push({ destination, action, by: "timer-300", ...(task ? { task } : {}), note: `o timer do 300${task ? ` (${task})` : ""} publica no horário do vertical e alarma se não sair` });
    } else if (action === "pending_schedule") {
      if (ctx.corteTimer && CORTE_TIMER_DESTINATIONS.includes(destination)) {
        owners.push({
          destination,
          action,
          by: "timer-300",
          task: CORTE_TIMER_TASK,
          at: item.scheduledAt,
          note: `o timer do 300 (${CORTE_TIMER_TASK}, de hora em hora) publica na 1ª execução depois de ${item.scheduledAt}, até 3 h, e alarma o editor se o destino falhar; só depois do --publish --confirm-publish do corte (o "pode publicar", #11912), nunca a partir do dry-run`,
        });
      } else if (destination === "instagram" && ctx.instagramViaTimer) {
        owners.push({ destination, action, by: "timer-300", task: SHORTS_TIMER_TASKS.instagram, at: item.scheduledAt, note: "rodada do timer do 300: ele mesmo publica depois do horário" });
      } else {
        owners.push({
          destination,
          action,
          by: "agent-scheduled-task",
          at: item.scheduledAt,
          command: `${base} --only ${destination} --publish ${publishConfirmSuffix(ctx.aammdd)}`,
          note:
            `a API não agenda: a skill cria uma task agendada one-shot para ${item.scheduledAt} com este comando` +
            (SHORTS_TIMER_TASKS[destination] ? ` (dono permanente: ligar o timer ${SHORTS_TIMER_TASKS[destination]} no 300)` : ""),
        });
      }
    } else if (action === "skip_late") {
      owners.push({
        destination,
        action,
        by: "agent",
        command: `${base} ${lateNowArgs(destination, ctx.writer)} ${publishConfirmSuffix(ctx.aammdd)}`,
        note: "horário passou do teto: o agente publica nesta rodada com --now (ou registra com --mark se já saiu); nunca volta ao editor",
      });
    } else if (action === "guided") {
      const at = item.at;
      const later = at !== undefined && Date.parse(at) - ctx.now.getTime() > OWNER_SCHEDULE_MIN_LEAD_MS;
      if (ctx.baseCommand) {
        // #11795: o corte não tem skill de re-execução (a `/diaria-publica-video` só conhece edição) e o
        // comando do corte só imprime o plano de um passo guiado: o agente desta rodada é o dono real.
        owners.push({
          destination,
          action,
          by: "agent",
          ...(at !== undefined ? { at } : {}),
          note:
            `passo guiado (Chrome) do corte, executado pelo agente nesta rodada` +
            (later ? `: agendar na própria plataforma para ${at}, ou publicar e registrar com --mark` : "") +
            ` (re-executar ${ctx.baseCommand} só reimprime o plano)`,
        });
        continue;
      }
      owners.push(
        later
          ? {
              destination,
              action,
              by: "agent-scheduled-task",
              at,
              command: ctx.baseCommand ?? `/diaria-publica-video ${ctx.aammdd} --so vertical`,
              note: `passo guiado da skill (Chrome) às ${at}: a skill agenda a própria re-execução para esse horário`,
            }
          : { destination, action, by: "agent", note: "passo guiado da skill (Chrome), executado pelo agente nesta rodada" },
      );
    } else if (action === "buffer") {
      owners.push({ destination, action, by: "agent", note: "o agente agenda pela Buffer MCP (create_post) nesta rodada" });
    }
  }
  return owners;
}

interface ShortsPlanCommonInput {
  coverPath?: string | null;
  coverUploadReady?: boolean;
  /** #11547: `thumbnailOffset` (ms) do X/Buffer, derivado do timecode do Still; null = a Buffer escolhe. */
  coverBufferOffsetMs?: number | null;
  aammdd: string;
  reviewedMd: string;
  now: Date;
  config: unknown;
  pages: ResolvedFacebookPage[];
  instagramReady: boolean;
  /** Por que o Instagram não está pronto (vira o aviso do plano). */
  instagramNotReadyReason?: string;
  /**
   * Plano B na conta sem teto (#11355) ou com o vertical dentro do teto (#11774): trata o Instagram como passo guiado com
   * este motivo, sem olhar a duração. Só o `prepare-instagram-guided.ts` passa,
   * e ele nunca publica; a rodada que publica segue pela API.
   */
  instagramGuidedFallback?: string;
  /** Avisos do Instagram pronto mas não totalmente conferido (ex.: escopo do token, #10820). */
  instagramWarnings?: string[];
  /**
   * #10823: dá pra agendar o Reels pela fila do Worker? Ausente = não (o
   * Instagram com horário futuro fica `pending_schedule`, como antes).
   */
  instagramQueue?: InstagramQueueReadiness;
  published: ShortsPublishedFile;
  /**
   * #10772: credencial do perfil pessoal do LinkedIn (`readPersonalCreds`).
   * Ausente = não conferida → o destino é pulado com aviso.
   */
  linkedinPersonal?: { ready: true } | { ready: false; reason: string };
  /**
   * #11122: credencial do Threads pessoal (`readThreadsPersonalCreds`).
   * Ausente = não conferida → o destino é pulado com aviso.
   */
  threadsPersonal?: { ready: true } | { ready: false; reason: string };
  /**
   * #10772: dá pra servir o vertical por URL pública (R2)? O X (Buffer) só
   * recebe vídeo por URL. Ausente = não → X pulado com aviso.
   */
  publicVideo?: { ready: true } | { ready: false; reason: string; cause?: string };
  /**
   * #11070: credencial do canal (`YOUTUBE_*`, `missingYouTubeCredentials`).
   * Pronta → o Short sobe pela Data API; ausente ou não pronta → passo guiado.
   */
  youtubeApi?: { ready: true } | { ready: false; reason: string };
  /**
   * Quem é esta rodada (#11368: um campo só, nunca "os dois timers"). Ausente =
   * `main`. `linkedin-timer` (#10982, `--linkedin-timer`): com
   * `linkedin_profile_via_timer` ligado, só ela publica o `linkedin_profile`.
   * `instagram-timer` (#11265, `--instagram-timer`): com `instagram_backend:
   * "timer-300"`, só ela publica o `instagram`. `threads-timer` (#11410,
   * `--threads-timer`): com `threads_profile_via_timer`, só ela publica o
   * `threads_profile`.
   */
  writer?: ShortsRegistryWriter;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  /**
   * #10893: duração do vertical (`mp4DurationSeconds`). Ausente = não medida;
   * null = medida mas ilegível. Nos dois casos o Instagram segue pela API
   * (com aviso no null, se o vídeo existe).
   */
  videoDurationSeconds?: number | null;
  editionUrl?: string;
  /** De onde veio o `editionUrl` (só pra premissa). */
  editionUrlSource?: string;
  forceNow?: boolean;
  only?: string[] | null;
  /**
   * Posts já agendados/publicados no dia, por conta (#10819) — `06-social-published.json`
   * + `06-shorts-published.json`. Ausente = grade vazia.
   */
  grid?: ScheduledSlot[];
  /**
   * #11986: heartbeat do timer do corte (`readCorteTimerHeartbeat`). Presente e
   * velho com destinos entregues ao timer = aviso em `warnings` (o timer pode
   * estar parado e nada publicar esses destinos). Ausente (testes, filho do
   * timer) = sem conferência.
   */
  corteTimerHeartbeat?: CorteTimerHeartbeat;
}

/** #11944: corte discrimina a origem; pasta e aviso da edição são inseparáveis. */
export type ShortsPlanInput = ShortsPlanCommonInput & (
  | {
      /** Corte avulso: título, gancho e horário próprios, fora da edição. */
      corte: {
        slug: string; hhmm: string; title: string; hook: string;
        /** #11964: só o filho autorizado do timer publica na janela dele. */
        timerRun?: boolean;
      };
      corteOutside?: { dir: string; warning: string };
      editionDirOverride?: never;
      unwatchedEditionWarning?: never;
    }
  | ({ corte?: undefined; corteOutside?: never } & (
      | { editionDirOverride?: undefined; unwatchedEditionWarning?: never }
      | { editionDirOverride: string; unwatchedEditionWarning: string }
    ))
);

/**
 * Puro (#11911): `--edition-dir` aponta para fora da pasta canônica da edição?
 * Devolve o caminho a passar ao plano (`editionDirOverride`), ou `undefined`.
 */
export function nonCanonicalEditionDir(
  dir: string,
  canonicalDir: string,
  realpath: (p: string) => string = safeRealpath,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  // Compara pelo caminho real: `data/` é symlink pro OneDrive, e o mesmo diretório por outro caminho não é "fora".
  // #11944: no Windows sem diferenciar maiúsculas (o NTFS não diferencia).
  return samePathOnPlatform(realpath(resolve(dir)), realpath(resolve(canonicalDir)), platform) ? undefined : resolve(dir);
}

/** #11911: pasta canônica da edição, absoluta pela raiz do repo (não pelo cwd). */
export function canonicalShortsEditionDir(aammdd: string, root: string = ROOT): string {
  return resolve(root, editionDirFor(aammdd));
}

function safeRealpath(p: string): string {
  return realpathLenient(p);
}

/**
 * Puro (#11911): no modo edição, a pasta fora de `data/editions/{AAMM}/{AAMMDD}`
 * (`override`, de `nonCanonicalEditionDir`) é invisível aos timers do 300
 * (Instagram, LinkedIn e Threads pessoais) — recusa, a menos do escape
 * `--allow-unwatched-dir`, que devolve o aviso.
 */
export function checkEditionDir(input: { aammdd: string; override: string | undefined; allowUnwatched: boolean; canonicalDir: string }):
  | { ok: true; outside: false }
  | { ok: true; outside: true; warning: string }
  | { ok: false; error: string } {
  if (input.override === undefined) return { ok: true, outside: false };
  if (!input.allowUnwatched) {
    return {
      ok: false,
      error:
        `--edition-dir ${input.override} fica fora da pasta canônica da edição ${input.aammdd} (${input.canonicalDir}): os timers do 300 (Instagram, LinkedIn e Threads pessoais) não enxergam esta pasta, então nenhum destino que faltar gera alarme. ` +
        `Rode sem --edition-dir (usa a pasta canônica) ou, se for um corte fora de edição, use --corte SLUG (registro em data/cortes/SLUG/). ` +
        `Para rodar mesmo assim, sem alarme, passe --${ALLOW_UNWATCHED_DIR_FLAG} (#11911)`,
    };
  }
  return {
    ok: true,
    outside: true,
    warning:
      `--edition-dir ${input.override} fora da pasta canônica da edição ${input.aammdd} (${input.canonicalDir}) por --${ALLOW_UNWATCHED_DIR_FLAG}: nenhum alarme de destino faltante cobre esta pasta ` +
      `(os timers do 300 de Instagram, LinkedIn e Threads pessoais não a enxergam); confira cada destino à mão (#11911)`,
  };
}

/**
 * Puro (#11911): contexto dos donos recalculados depois da publicação (#11550).
 * Espelha o do plano: pasta fora da canônica (edição ou corte) nunca delega a
 * timer e leva a pasta e o escape nos comandos de re-execução.
 */
export function ownersContextAfterPublish(input: {
  aammdd: string;
  now: Date;
  instagramBackend: InstagramBackend;
  corteViaTimer: boolean;
  writer?: ShortsRegistryWriter;
  corteSlug?: string;
  corteOutsideDir?: string;
  editionDirOverride?: string;
}): Parameters<typeof assignShortsDestinationOwners>[1] {
  const corte = input.corteSlug !== undefined;
  return {
    aammdd: input.aammdd,
    now: input.now,
    instagramViaTimer: input.instagramBackend === "timer-300" && !corte && input.editionDirOverride === undefined,
    ...(input.writer !== undefined ? { writer: input.writer } : {}),
    ...(corte
      ? { baseCommand: corteBaseCommand(input.corteSlug!, input.corteOutsideDir), corteTimer: input.corteViaTimer && input.corteOutsideDir === undefined }
      : input.editionDirOverride !== undefined
        ? { editionDirOverride: input.editionDirOverride }
        : {}),
  };
}

/** Puro (#11986): aviso da rodada que entrega destinos a um timer do corte sem execução recente. */
export function corteTimerStaleWarning(delegated: readonly string[], hb: CorteTimerHeartbeat, now: Date): string {
  return (
    `timer do corte (${CORTE_TIMER_TASK}) sem execução recente — ${describeCorteTimerHeartbeat(hb, now)}: ${delegated.join(", ")} ficam com ele e não saem se ele estiver parado (desarmado ou 300 fora do ar). ` +
    "Confira a task no 300 antes de contar com o timer; a vigia dos cortes no 300 alarma por e-mail se o horário passar com ele parado (#11986)"
  );
}

/** Miolo puro: o que cada destino faria, sem I/O. Lança em config/`--only` inconsistentes. */
export function planShortsPublish(input: ShortsPlanInput): ShortsPlan {
  const premises: string[] = [];
  const warnings: string[] = [];
  const corte = input.corte;
  // #11795: o corte está fora do teste de horário por definição; o texto do skip_late não pode citá-lo.
  const lateReason = corte ? "passou do horário do corte (--at)" : "fora do horário do teste (#10831)";
  const d1 = corte ? { n: 1, ...corteTextInput(corte) } : parseDestaques(input.reviewedMd).find((d) => d.n === 1);
  if (!d1) throw new Error("02-reviewed.md sem DESTAQUE 1 — nada para derivar o vídeo curto");

  const editionUrl: string = input.editionUrl ?? (corte ? DIARIA_HOME_URL : deriveEditionUrl(d1.title));
  if (corte) {
    // #11795: o corte não é de edição — nenhum texto do vertical leva link (#11617), então o link é só referência do plano.
    premises.push(`corte avulso "${corte.slug}": título e gancho explícitos (sem D1); link de referência ${editionUrl}${input.editionUrl ? ` (${input.editionUrlSource ?? "--edition-url"})` : ""}`);
  } else if (input.editionUrl) {
    premises.push(`link da edição: ${editionUrl} (${input.editionUrlSource ?? "--edition-url"})`);
  } else {
    // #10943 item 3: no fluxo novo o vertical sai ANTES da Etapa 5, então
    // `05-edition-url.txt` ainda não existe. O Stage 5 grava exatamente
    // `deriveEditionUrl(D1)` (publish-newsletter-kit.ts, #7420): o link derivado
    // aqui é o mesmo que o Stage 5 vai gravar, não um palpite.
    premises.push(`link da edição: ${editionUrl} (derivado do título do D1 — mesma regra do Stage 5, #7420)`);
  }
  const d1In = { title: d1.title, body: d1.body };
  const youtube = buildYouTubeShortMetadata({ d1: d1In });

  // #10831: o vertical tem horário próprio (nunca as 06:00 do horizontal).
  const time = corte ? corteShortTime(corte.hhmm) : resolveShortTime(loadShortScheduleConfig(input.config), input.aammdd);
  const shortTime = { ...time, at: resolveEditionScheduledAt(input.aammdd, time.hhmm) };
  premises.push(`horário do vertical: ${time.hhmm} BRT (${time.reason})`);
  if (input.forceNow) premises.push("--now: publica na hora");
  if (!input.video.exists) warnings.push(`vídeo curto ausente em ${input.video.path} — nada a publicar até ele existir`);

  const cfg = loadShortsConfig(input.config);
  for (const slug of cfg.facebookPages) {
    if (!input.pages.some((p) => p.slug === slug)) {
      throw new Error(`publishing.shorts.facebook_pages: página "${slug}" não existe em publishing.social.facebook.pages`);
    }
  }
  // #10820: mesmo tratamento do facebook_pages — slug inválido é erro de config, não aviso de runtime.
  if (cfg.instagram && cfg.instagramAuthorPage !== null && !input.pages.some((p) => p.slug === cfg.instagramAuthorPage)) {
    throw new Error(`publishing.shorts.instagram_author_page: página "${cfg.instagramAuthorPage}" não existe em publishing.social.facebook.pages`);
  }
  const known = knownDestinationIds(cfg);
  const only = input.only && input.only.length ? new Set(input.only) : null;
  if (only) {
    const unknown = [...only].filter((d) => !known.has(d));
    if (unknown.length) throw new Error(`--only com destino desconhecido: ${unknown.join(", ")} (válidos: ${[...known].join(", ")})`);
  }

  const destinations = listShortDestinations(cfg).filter((d) => !only || only.has(d.id));
  // #10893: Reels acima do teto medido da API do Instagram vira passo guiado
  // ANTES do upload, em vez de falhar no rupload depois de subir o arquivo.
  // #10916: o teto é POR CONTA (a autora do Reels), não global.
  const igMaxRes = resolveInstagramApiMaxSeconds(input.config, cfg.instagramAuthorPage);
  const igMax = igMaxRes.maxSeconds;
  const igMaxPremise = instagramApiMaxSecondsPremise(igMaxRes);
  if (igMaxPremise && destinations.some((d) => d.id === "instagram")) premises.push(igMaxPremise);
  const igAccountLabel = cfg.instagramAuthorPage === null ? "da diar.ia.br (env)" : `vinculada à página ${cfg.instagramAuthorPage}`;
  const igFit = input.instagramGuidedFallback
    ? ({ fits: false, reason: input.instagramGuidedFallback } as const)
    : instagramReelsApiFit(input.videoDurationSeconds ?? null, igMax, igAccountLabel);
  // Sem credencial (ou acima do teto, no Instagram) o destino não sai pela API — não disputa a grade nem gera premissa de horário.
  function publishable(d: ShortDestination): boolean {
    if (d.kind === "facebook_page") return !input.pages.find((p) => p.slug === d.slug)!.missing.length;
    if (d.kind === "instagram") return input.instagramReady && igFit.fits;
    if (d.kind === "linkedin_profile") return input.linkedinPersonal?.ready === true;
    if (d.kind === "x" || d.kind === "tiktok") return input.publicVideo?.ready === true;
    if (d.kind === "threads_profile") return input.threadsPersonal?.ready === true && input.publicVideo?.ready === true;
    return false;
  }
  // #10933: Instagram acima do teto vira post MANUAL no app, mas continua sendo
  // um post da conta naquele horário — reserva o slot na grade como os de API.
  const manualInstagram = (d: ShortDestination) => d.kind === "instagram" && !igFit.fits;
  // #10819: só os destinos que esta rodada ainda vai publicar disputam a grade;
  // os já registrados entram nela pelo `06-shorts-published.json`.
  // #11265: com o timer do 300 dono do Instagram, o Reels sai SEMPRE no
  // horário do vertical (`shortTime`), fora da grade — é o mesmo horário que
  // o timer usa pra decidir quando agir (`decideInstagramTimerRun`). Pela
  // grade, fora da rotação os dois divergiam (261117: shortTime 12:00, slot
  // 19:30) e o Reels nunca saía. Ele entra na grade como post fixo, pros
  // outros destinos se espaçarem em volta dele.
  // #11795: o corte avulso nunca delega aos timers do 300 (eles procuram a pasta da edição).
  // #11911: nem uma pasta fora de data/editions/{AAMM}/{AAMMDD} (`--edition-dir`): o timer não a
  // enxerga e pula em silêncio ("dia sem edição") — foi assim que o Reels do corte de 02/11 sumiu
  // (rodada em modo edição com --edition-dir ~/diaria-cortes/...).
  const timersBlind = Boolean(corte) || input.editionDirOverride !== undefined;
  if (input.editionDirOverride !== undefined && !corte) {
    if (input.unwatchedEditionWarning !== undefined) warnings.push(input.unwatchedEditionWarning);
    const delegable = [
      cfg.instagram && cfg.instagramBackend === "timer-300" ? "instagram" : null,
      cfg.linkedinProfile && cfg.linkedinProfileViaTimer ? "linkedin_profile" : null,
      cfg.threadsProfile && cfg.threadsProfileViaTimer ? "threads_profile" : null,
    ].filter((d): d is string => d !== null && (!only || only.has(d)));
    if (delegable.length) {
      warnings.push(
        `--edition-dir ${input.editionDirOverride} fica fora de ${editionDirFor(input.aammdd)}: os timers do 300 não enxergam esta pasta, então ${delegable.join(", ")} não é delegado a eles e o dono é esta rodada (re-execução com o mesmo --edition-dir e --${ALLOW_UNWATCHED_DIR_FLAG}). Para um corte fora de edição, use --corte SLUG (#11795, #11911)`,
      );
    }
  }
  const instagramViaTimer = cfg.instagramBackend === "timer-300" && !timersBlind;
  // #11911: corte fora de data/cortes/ — o timer do corte não o enxerga.
  const corteOutside = corte ? input.corteOutside : undefined;
  if (corteOutside) warnings.push(corteOutside.warning);
  const corteTimer = Boolean(corte) && cfg.corteViaTimer && !corteOutside;
  // #11795: quem roda de novo depois do horário um destino cuja API não agenda.
  const pendingRunner = (hhmm: string): string =>
    corteTimer
      ? `o timer do 300 (${CORTE_TIMER_TASK}) publica na 1ª execução depois das ${hhmm} BRT e alarma se falhar, só com o --publish confirmado (owners, #11795, #11912)`
      : `a skill agenda a re-execução para depois das ${hhmm} BRT (owners, #11550)`;
  // #11964: na janela em que o timer do corte publica (de 10 min antes do horário, quando a
  // rodada já publicaria na hora, até uma cadência do timer antes do teto de 3 h, #11996), só o filho do timer publica os destinos
  // dele. A rodada manual (com ou sem --now) os delega: as duas no mesmo destino duplicam o post.
  // Antes da janela segue `pending_schedule` (o timer é o dono); depois, `skip_late` (o timer já
  // não publica e só alarma, então a rodada manual com --now é segura).
  const corteTimerOwnsNow = (destination: string): boolean => {
    if (!corte || !corteTimer || corte.timerRun === true || !CORTE_TIMER_DESTINATIONS.includes(destination)) return false;
    // Reels acima do teto da API: o timer também não publica (vira passo guiado); o passo fica com esta rodada.
    if (destination === "instagram" && !igFit.fits) return false;
    const deltaMs = input.now.getTime() - Date.parse(shortTime.at);
    // #11996: com menos de uma cadência do timer até o teto, a próxima execução dele já cai em
    // `late` (só alarma): delegar ali deixava o post sem sair. A rodada manual fica com o destino.
    return deltaMs >= -OWNER_SCHEDULE_MIN_LEAD_MS && deltaMs <= MAX_FIRE_LATENESS_MS - CORTE_TIMER_INTERVAL_MS;
  };
  const instagramDelegated = instagramViaTimer && input.writer !== "instagram-timer";
  const slotDestinations = destinations.filter((d) => !isDestinationDone(input.published, d.id) && (publishable(d) || manualInstagram(d)));
  const fixedInstagram = instagramViaTimer ? slotDestinations.find((d) => d.kind === "instagram") : undefined;
  const fixedInstagramSlot: ShortSlot | null = fixedInstagram ? instagramTimerSlot(fixedInstagram, cfg, time.hhmm, shortTime.at) : null;
  const slots = [
    ...(fixedInstagramSlot ? [fixedInstagramSlot] : []),
    ...planShortSlots({
      aammdd: input.aammdd,
      time,
      timeAt: shortTime.at,
      destinations: slotDestinations.filter((d) => d !== fixedInstagram),
      cfg,
      grid: [
        ...(input.grid ?? []),
        ...(fixedInstagramSlot
          ? [{ account: fixedInstagramSlot.account, at: fixedInstagramSlot.at, label: "shorts instagram (timer do 300)", ...(fixedInstagramSlot.alsoAccounts ? { alsoAccounts: fixedInstagramSlot.alsoAccounts } : {}) }]
          : []),
      ],
    }),
  ];
  const slotOf = new Map(slots.map((s) => [s.destination, s]));
  for (const s of slots) {
    if (s.rule === "timer-300" || s.rule === "explicit") premises.push(`${s.destination}: ${s.hhmm} BRT (${s.premise})`);
    else if (s.rule !== "test-schedule") premises.push(`${s.destination}: ${s.hhmm} BRT (grade #10819: ${s.premise})`);
    if (s.warning) warnings.push(s.warning);
  }
  const scheduleFor = (s: ShortSlot) => (input.forceNow ? ({ mode: "immediate" } as const) : resolveReelsSchedule(s.at, input.now));
  for (const s of slots) {
    if (input.forceNow) continue;
    if (s.destination === "instagram" && !igFit.fits) {
      premises.push(`instagram: passo manual (Chrome ou app) às ${s.hhmm} BRT do dia da edição (acima do teto da API, #10893) — slot reservado na grade (#10933)`);
      continue;
    }
    const sch = scheduleFor(s);
    premises.push(
      sch.mode === "scheduled"
        ? `${s.destination}: ${s.destination !== "instagram" ? "agendado para" : instagramViaTimer ? "timer do 300 publica depois de" : input.instagramQueue?.ready ? "fila do Worker para" : "pendente até"} ${sch.at} (${s.hhmm} BRT do dia da edição)`
        : `${s.destination}: ${s.hhmm} BRT do dia da edição já passou (ou falta <10 min) — publica na hora`,
    );
  }

  const socialText = (platform: "linkedin" | "x" | "threads") =>
    buildShortSocialText({ platform, d1: d1In });

  // #10772 F4: a Posts API do LinkedIn não agenda — o vídeo sai quando a rodada
  // roda. Sem teto, uma rodada horas depois (ou no dia seguinte) publicaria fora
  // do horário do teste (#10831). Mesmo teto do `--fire-due` do 4º post; `--now`
  // é a exceção explícita.
  // #11122: a Threads API também não agenda — mesmo teto pro Threads pessoal.
  const lateFor = (destination: string): string | null => {
    const slot = slotOf.get(destination);
    if (!slot || input.forceNow) return null;
    const lateMs = input.now.getTime() - Date.parse(slot.at);
    if (!(lateMs > MAX_FIRE_LATENESS_MS)) return null;
    return `${slot.hhmm} BRT passou há ${Math.round(lateMs / 60_000)} min (teto ${MAX_FIRE_LATENESS_MS / 3_600_000} h)`;
  };
  const profileLate = lateFor("linkedin_profile");
  // #10982: com o timer do 300 dono do vídeo do perfil, a rodada da skill não o publica.
  const profileDelegated = cfg.linkedinProfileViaTimer && input.writer !== "linkedin-timer" && !timersBlind;
  // #11410: idem pro Threads pessoal.
  const threadsDelegated = cfg.threadsProfileViaTimer && input.writer !== "threads-timer" && !timersBlind;

  // #10772 F1: o repost da página só existe se o vídeo do perfil já está
  // registrado ou sai nesta rodada (publish/pending_schedule). Sem isso a skill
  // receberia um passo de repost de um vídeo que não existe.
  const profileBlocker = ((): string | null => {
    // #10907: `send_unknown` conta como feito pra NÃO repostar o vídeo do perfil,
    // mas não prova que ele existe — o repost espera o editor conferir e registrar a URL.
    if (input.published.entries.some((e) => e.destination === "linkedin_profile" && e.status === "send_unknown")) {
      return PROFILE_SEND_UNKNOWN_BLOCKER;
    }
    if (isDestinationDone(input.published, "linkedin_profile")) return null;
    const dest = destinations.find((d) => d.kind === "linkedin_profile");
    if (!dest) return "o vídeo do perfil (linkedin_profile) não está registrado nem nesta rodada";
    if (!publishable(dest)) return "o vídeo do perfil (linkedin_profile) não sai nesta rodada (sem credencial)";
    if (profileDelegated) return `o vídeo do perfil (linkedin_profile) ${LINKEDIN_TIMER_DETAIL}`;
    if (corte && corteTimerOwnsNow("linkedin_profile")) return `o vídeo do perfil (linkedin_profile) ${corteTimerDelegatedDetail(corte.slug)}`;
    if (profileLate) return `o vídeo do perfil (linkedin_profile) não sai nesta rodada (${profileLate})`;
    try {
      socialText("linkedin");
    } catch (e) {
      return `o vídeo do perfil (linkedin_profile) não sai nesta rodada (${(e as Error).message})`;
    }
    return null;
  })();

  // #10772: repost da página — depois do vídeo do perfil, num horário da grade da página.
  const repostSlot = (() => {
    if (!destinations.some((d) => d.kind === "linkedin_page_repost") || isDestinationDone(input.published, "linkedin_page_repost")) return null;
    if (profileBlocker) return null;
    const profileEntry = input.published.entries.find((e) => e.destination === "linkedin_profile");
    const profileAt = profileEntry ? (profileEntry.scheduled_at ?? profileEntry.at) : (slotOf.get("linkedin_profile")?.at ?? shortTime.at);
    const plannedGrid = [
      ...(input.grid ?? []),
      ...slots.map((s) => ({ account: s.account, at: s.at, label: `shorts ${s.destination}`, ...(s.alsoAccounts ? { alsoAccounts: s.alsoAccounts } : {}) })),
    ];
    const s = planLinkedInRepostSlot({ aammdd: input.aammdd, profileAt: Number.isNaN(Date.parse(profileAt)) ? shortTime.at : profileAt, grid: plannedGrid });
    premises.push(`linkedin_page_repost: ${s.hhmm} BRT (grade da página #10819: ${s.premise})`);
    if (s.warning) warnings.push(s.warning);
    return s;
  })();

  const items: ShortsPlanItem[] = destinations.map((dest) => planDestination(dest));

  function planDestination(dest: ShortDestination): ShortsPlanItem {
    if (isDestinationDone(input.published, dest.id)) {
      return { destination: dest.id, mode: dest.mode, action: "skip_done" };
    }
    if (corte && corteTimerOwnsNow(dest.id)) {
      // #11964: o timer do corte publica este destino agora; esta rodada não (sairia em dobro).
      return { destination: dest.id, mode: "api", action: "skip_delegated", detail: corteTimerDelegatedDetail(corte.slug) };
    }
    if (dest.kind === "youtube_shorts") {
      // #11070: Data API com publishAt (o horizontal provou em 23/10 que o
      // agendado vira público sozinho, sem a auditoria). Sem credencial, guiado.
      if (cfg.youtubeShortsApi && input.youtubeApi?.ready === true) {
        const sch = input.forceNow ? null : resolveYouTubeSchedule(input.aammdd, input.now, shortTime.at);
        const publishAt = sch?.mode === "scheduled" ? sch.publishAt : null;
        premises.push(
          publishAt
            ? `youtube_shorts: Data API, agendado (private + publishAt ${publishAt}, ${time.hhmm} BRT do vertical) (#11070)`
            : `youtube_shorts: Data API, público na hora (${input.forceNow ? "--now" : `${time.hhmm} BRT já passou ou falta menos de 15 min`}) (#11070)`,
        );
        return { destination: dest.id, mode: "api", action: "publish", caption: youtube.description, scheduledAt: publishAt, title: youtube.title };
      }
      const why = !cfg.youtubeShortsApi
        ? "publishing.shorts.youtube_shorts_api = false"
        : input.youtubeApi?.ready === false
          ? input.youtubeApi.reason
          : "credencial YOUTUBE_* não conferida";
      if (cfg.youtubeShortsApi) warnings.push(`youtube_shorts: ${why} — vira passo guiado no YouTube Studio (#11070)`);
      return { destination: dest.id, mode: "guided", action: "guided", detail: `YouTube Studio no Chrome (${why})` };
    }
    if (dest.kind === "linkedin_profile") {
      if (profileDelegated) {
        return { destination: dest.id, mode: "api", action: "skip_delegated", detail: LINKEDIN_TIMER_DETAIL };
      }
      if (input.linkedinPersonal?.ready !== true) {
        const reason = input.linkedinPersonal?.ready === false ? input.linkedinPersonal.reason : "credencial LINKEDIN_PERSONAL_* não conferida";
        warnings.push(`linkedin_profile: ${reason}`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: reason };
      }
      if (profileLate) {
        const nowCmd = `${lateNowArgs(dest.id, input.writer)} ${publishConfirmSuffix(input.aammdd)}`;
        const detail =
          `${profileLate} — ${lateReason}, esta rodada não publica sozinha. ` +
          `O agente publica com ${nowCmd} (ou registra com --mark linkedin_profile=URL se já saiu); nunca volta ao editor (#11550)`;
        warnings.push(`linkedin_profile: ${detail}`);
        return { destination: dest.id, mode: "api", action: "skip_late", detail };
      }
      let text: string;
      try {
        text = socialText("linkedin");
      } catch (e) {
        warnings.push(`linkedin_profile: ${(e as Error).message}`);
        return { destination: dest.id, mode: "api", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      const title = stripInlineMarkdown(d1In.title).replace(/\s+/g, " ").trim();
      if (schedule.mode === "scheduled") {
        return {
          destination: dest.id,
          mode: "api",
          action: "pending_schedule",
          caption: text,
          scheduledAt: schedule.at,
          detail: `a Posts API do LinkedIn não agenda — ${pendingRunner(slot.hhmm)}`,
        };
      }
      return { destination: dest.id, mode: "api", action: "publish", caption: text, scheduledAt: null, title };
    }
    if (dest.kind === "linkedin_page_repost") {
      if (profileBlocker) {
        const detail = `${profileBlocker} — repost só depois que o vídeo do perfil sair (ou for registrado com --mark linkedin_profile=URL)`;
        warnings.push(`linkedin_page_repost: ${detail}`);
        return { destination: dest.id, mode: "guided", action: "skip_invalid", detail };
      }
      const profile = input.published.entries.find((e) => e.destination === "linkedin_profile");
      const where = profile?.url ? ` (${profile.url})` : profile ? "" : " — depois que o vídeo do perfil (linkedin_profile) sair";
      return {
        destination: dest.id,
        mode: "guided",
        action: "guided",
        at: repostSlot!.at,
        detail:
          `repost pela página diar.ia.br às ${repostSlot!.hhmm} BRT: no Chrome, como a página, "Repostar" o vídeo do perfil${where}. ` +
          `Sem token de organização local, por isso guiado; registre com --mark linkedin_page_repost=URL`,
      };
    }
    if (dest.kind === "x") {
      if (input.publicVideo?.ready !== true) {
        const reason = `o X recebe o vídeo por URL pública, indisponível nesta rodada (${input.publicVideo?.ready === false ? input.publicVideo.reason : "não conferido"})`;
        warnings.push(`x: ${reason}`);
        return { destination: dest.id, mode: "guided", action: "skip_missing_credentials", detail: reason, cause: "public_video" };
      }
      let text: string;
      try {
        text = socialText("x");
      } catch (e) {
        warnings.push(`x: ${(e as Error).message}`);
        return { destination: dest.id, mode: "guided", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      return {
        destination: dest.id,
        mode: "guided",
        action: "buffer",
        caption: text,
        scheduledAt: schedule.mode === "scheduled" ? schedule.at : null,
        detail:
          "Buffer create_post no canal @diariabr com o vídeo de results[].buffer.videoUrl (o --publish sobe o vertical pro R2); " +
          "com results[].buffer.thumbnailOffset presente, o asset vai como { video: { url, metadata: { thumbnailOffset } } } (ms, a capa do X, #11547); " +
          "registre com --mark x=buffer:{id do post} --scheduled-at {dueAt} (+ --thumbnail-offset {ms} se passou o offset)",
      };
    }
    if (dest.kind === "tiktok") {
      // #11515: TikTok pela Buffer (decisão do editor de 28/10/2026), mesmo caminho do X:
      // o --publish sobe o vertical pro R2 e a skill chama o create_post.
      if (input.publicVideo?.ready !== true) {
        const reason = `o TikTok (Buffer) recebe o vídeo por URL pública, indisponível nesta rodada (${input.publicVideo?.ready === false ? input.publicVideo.reason : "não conferido"})`;
        warnings.push(`tiktok: ${reason}`);
        return { destination: dest.id, mode: "guided", action: "skip_missing_credentials", detail: reason, cause: "public_video" };
      }
      let post: { caption: string; title: string };
      try {
        post = buildTikTokPost({ d1: d1In });
      } catch (e) {
        warnings.push(`tiktok: ${(e as Error).message}`);
        return { destination: dest.id, mode: "guided", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      const channelId = cfg.tiktokBufferChannelId!; // loadShortsConfig exige o canal com tiktok ligado
      return {
        destination: dest.id,
        mode: "guided",
        action: "buffer",
        caption: post.caption,
        scheduledAt: schedule.mode === "scheduled" ? schedule.at : null,
        channelId,
        tiktok: { title: post.title, isAiGenerated: false },
        detail:
          `Buffer create_post no canal TikTok ${channelId} com o vídeo de results[].buffer.videoUrl (o --publish sobe o vertical pro R2), ` +
          "metadata.tiktok de results[].buffer.metadata.tiktok (title, isAiGenerated: false); " +
          "registre com --mark tiktok=buffer:{id do post} --scheduled-at {dueAt} (+ --thumbnail-offset {ms} se passou o offset)",
      };
    }
    if (dest.kind === "threads_profile") {
      // #11122: vertical no Threads pessoal. Mesmo contrato do linkedin_profile:
      // sem credencial é fail-soft, a API não agenda (pending antes do horário,
      // skip_late depois do teto), `send_unknown` conta como feito.
      if (threadsDelegated) {
        return { destination: dest.id, mode: "api", action: "skip_delegated", detail: THREADS_TIMER_DETAIL };
      }
      if (input.threadsPersonal?.ready !== true) {
        const reason = input.threadsPersonal?.ready === false ? input.threadsPersonal.reason : "credencial THREADS_PERSONAL_* não conferida";
        warnings.push(`threads_profile: ${reason}`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: reason };
      }
      if (input.publicVideo?.ready !== true) {
        const reason = `o Threads recebe o vídeo por URL pública, indisponível nesta rodada (${input.publicVideo?.ready === false ? input.publicVideo.reason : "não conferido"})`;
        warnings.push(`threads_profile: ${reason}`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: reason, cause: "public_video" };
      }
      const late = lateFor(dest.id);
      if (late) {
        const detail =
          `${late} — ${lateReason}, esta rodada não publica sozinha. ` +
          `O agente publica com ${lateNowArgs(dest.id, input.writer)} ${publishConfirmSuffix(input.aammdd)} (ou registra com --mark threads_profile=URL se já saiu); nunca volta ao editor (#11550)`;
        warnings.push(`threads_profile: ${detail}`);
        return { destination: dest.id, mode: "api", action: "skip_late", detail };
      }
      let text: string;
      try {
        text = socialText("threads");
      } catch (e) {
        warnings.push(`threads_profile: ${(e as Error).message}`);
        return { destination: dest.id, mode: "api", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      if (schedule.mode === "scheduled") {
        return {
          destination: dest.id,
          mode: "api",
          action: "pending_schedule",
          caption: text,
          scheduledAt: schedule.at,
          detail: `a Threads API não agenda — ${pendingRunner(slot.hhmm)}`,
        };
      }
      return { destination: dest.id, mode: "api", action: "publish", caption: text, scheduledAt: null };
    }
    if (dest.kind === "facebook_profile") {
      return {
        destination: dest.id,
        mode: "guided",
        action: "guided",
        caption: buildReelsCaption({ platform: "facebook", d1: d1In }),
        detail: "perfil pessoal: a Graph API não publica em perfil de pessoa — Chrome, ou compartilhar o Reels da página",
      };
    }
    if (dest.kind === "facebook_page") {
      const page = input.pages.find((p) => p.slug === dest.slug)!;
      if (page.missing.length) {
        warnings.push(`${dest.id}: sem credencial (${page.missing.join(", ")}) — rode scripts/facebook-page-token-setup.ts`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: page.missing.join(", ") };
      }
      const schedule = scheduleFor(slotOf.get(dest.id)!);
      return {
        destination: dest.id,
        mode: "api",
        action: "publish",
        caption: buildReelsCaption({ platform: "facebook", d1: d1In }),
        scheduledAt: schedule.mode === "scheduled" ? schedule.at : null,
      };
    }
    // instagram
    if (instagramDelegated) {
      return { destination: dest.id, mode: "api", action: "skip_delegated", detail: INSTAGRAM_TIMER_DETAIL };
    }
    if (!igFit.fits) {
      // #10933: o horário vem da grade (o mesmo slot que os outros destinos já enxergaram).
      const slot = slotOf.get(dest.id);
      const hhmm = slot?.hhmm ?? time.hhmm;
      // #10915: o --publish gera a versão comprimida pro file_upload do Chrome (campo `upload` do item).
      // #11794: a rota à mão tem a mesma autoria da API (@diar.ia.br autora, @vjpixel em collab).
      const detail =
        `${igFit.reason} — poste pelo instagram.com no Chrome (Passo B3b do /diaria-publica-video, com o arquivo mirando 9,5 MB, abaixo do limite de 10 MB do file_upload, que o --publish gera em _internal/) ` +
        `ou no app, ${instagramChromeRouteText()}, às ${hhmm} BRT do dia da edição (slot reservado na grade, #10933), ` +
        `e registre com --confirm-instagram (lê a conta da @${INSTAGRAM_CHROME_ROUTE.authorUsername}; ou --url URL do Reel) ou --mark instagram=URL`;
      warnings.push(`instagram: ${detail}`);
      let caption: string | undefined;
      try {
        caption = buildReelsCaption({ platform: "instagram", d1: d1In });
      } catch (e) {
        warnings.push(`instagram: ${(e as Error).message}`);
      }
      return { destination: dest.id, mode: "guided", action: "guided", ...(caption ? { caption } : {}), detail, at: slot?.at ?? shortTime.at };
    }
    // Só quando o caller MEDIU e não conseguiu ler (null); ausente = não medido (testes, chamadas antigas).
    if (input.videoDurationSeconds === null && igMax !== null && input.video.exists && input.instagramReady) {
      warnings.push(`instagram: duração do vertical não lida do MP4 — sobe pela API sem conferir o teto de ~${igMax} s (#10893); se o rupload der ProcessingFailedError, poste à mão`);
    }
    for (const w of input.instagramWarnings ?? []) warnings.push(`instagram: ${w}`);
    if (!input.instagramReady) {
      warnings.push(`instagram: ${input.instagramNotReadyReason ?? "sem INSTAGRAM_BUSINESS_ACCOUNT_ID/INSTAGRAM_ACCESS_TOKEN"}`);
      return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: input.instagramNotReadyReason ?? "INSTAGRAM_*" };
    }
    let caption: string;
    try {
      caption = buildReelsCaption({ platform: "instagram", d1: d1In });
    } catch (e) {
      // Legenda grande demais só derruba o Instagram, não os outros destinos.
      warnings.push(`instagram: ${(e as Error).message}`);
      return { destination: dest.id, mode: "api", action: "skip_invalid", detail: (e as Error).message };
    }
    // #11355: na @diar.ia.br o Reels depende da URL pública. Sem R2 o publish não
    // chega a tentar: o timer alarma citando o R2 (`cause`), e a limpeza do
    // vertical não conta o destino como terminal (#11478).
    const publishOrBlocked = (text: string): ShortsPlanItem => {
      if (instagramReelUploadRoute(cfg.instagramAuthorPage) === "video_url" && input.publicVideo?.ready !== true) {
        const why = input.publicVideo?.ready === false ? (input.publicVideo.cause ?? input.publicVideo.reason) : "não conferido";
        const detail = `o Reels da @diar.ia.br sobe por URL pública (video_url, #11355), indisponível nesta rodada: ${why}`;
        warnings.push(`instagram: ${detail}`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail, cause: "public_video" };
      }
      return { destination: dest.id, mode: "api", action: "publish", caption: text, scheduledAt: null };
    };
    const slot = slotOf.get(dest.id)!;
    const schedule = scheduleFor(slot);
    if (instagramViaTimer) {
      // #11265: rodada do timer do 300. Antes do horário espera; até 3 h depois
      // publica (`video_url` na @diar.ia.br, #11355); depois disso não publica
      // sozinho fora do horário do teste (#10831), mesmo teto do linkedin_profile.
      if (schedule.mode === "scheduled") {
        return {
          destination: dest.id,
          mode: "api",
          action: "pending_schedule",
          caption,
          scheduledAt: schedule.at,
          detail: `o Instagram não agenda Reels pela API — o timer do 300 publica depois das ${slot.hhmm} BRT (ou use --now)`,
        };
      }
      const late = lateFor(dest.id);
      if (late) {
        const detail =
          `${late} — ${lateReason}, não publica sozinho. ` +
          `Publique à mão (Passo B3b) e registre com --confirm-instagram ou --mark instagram=URL, ou rode com --now para publicar mesmo assim`;
        warnings.push(`instagram: ${detail}`);
        return { destination: dest.id, mode: "api", action: "skip_late", detail };
      }
      return publishOrBlocked(caption);
    }
    if (schedule.mode === "scheduled") {
      // #10823: a fila do Worker publica no horário (o Instagram não agenda Reels pela API).
      if (input.instagramQueue?.ready) {
        return {
          destination: dest.id,
          mode: "api",
          action: "enqueue",
          caption,
          scheduledAt: schedule.at,
          igAccount: input.instagramQueue.account,
          idempotencyKey: shortsReelsIdempotencyKey(input.aammdd, input.instagramQueue.account),
        };
      }
      const why = input.instagramQueue ? ` Fila do Worker indisponível: ${input.instagramQueue.reason}.` : "";
      if (input.instagramQueue) warnings.push(`instagram: sem fila do Worker (${input.instagramQueue.reason}) — fica pendente até ${slot.hhmm} BRT`);
      return {
        destination: dest.id,
        mode: "api",
        action: "pending_schedule",
        caption,
        scheduledAt: schedule.at,
        detail: `o Instagram não agenda Reels pela API — ${pendingRunner(slot.hhmm)}.${why}`,
      };
    }
    return publishOrBlocked(caption);
  }

  // #11547: o que cada destino faz com a capa (Still) — ver scripts/lib/diaria/short-cover.ts.
  const coverCtx = { coverPath: input.coverPath ?? null, coverUploadReady: input.coverUploadReady === true, bufferOffsetMs: input.coverBufferOffsetMs ?? null };
  const cover = { path: input.coverPath ?? null, destinations: Object.fromEntries(items.map((i) => [i.destination, planCoverDestination(i, coverCtx)])) };
  // #11986: delegar a um timer parado deixa os destinos sem sair por até 3 h, sem alarme do timer.
  if (corteTimer && input.corteTimerHeartbeat && corteTimerHeartbeatStale(input.corteTimerHeartbeat, input.now)) {
    const delegated = items
      .filter((i) => CORTE_TIMER_DESTINATIONS.includes(i.destination) && (i.action === "skip_delegated" || i.action === "pending_schedule"))
      .map((i) => i.destination);
    if (delegated.length) warnings.push(corteTimerStaleWarning(delegated, input.corteTimerHeartbeat, input.now));
  }
  // #11944: a regra de dono mora só em `ownersContextAfterPublish` (o recálculo depois do publish usa a mesma).
  const owners = assignShortsDestinationOwners(
    items,
    ownersContextAfterPublish({
      aammdd: input.aammdd,
      now: input.now,
      instagramBackend: cfg.instagramBackend,
      corteViaTimer: cfg.corteViaTimer,
      ...(input.writer !== undefined ? { writer: input.writer } : {}),
      ...(corte ? { corteSlug: corte.slug } : {}),
      ...(corteOutside ? { corteOutsideDir: corteOutside.dir } : {}),
      ...(!corte && input.editionDirOverride !== undefined ? { editionDirOverride: input.editionDirOverride } : {}),
    }),
  );
  return { aammdd: input.aammdd, editionUrl, video: input.video, cover, longVideo: youtubeVideoFileName(input.aammdd), youtube, shortTime, slots, items, owners, premises, warnings };
}

/**
 * Pure (#11265): slot do Instagram com o timer do 300 — o horário do vertical,
 * sem passar pela grade (ver o comentário em `planShortsPublish`).
 */
export function instagramTimerSlot(dest: ShortDestination, cfg: ShortsConfig, hhmm: string, at: string): ShortSlot {
  const account = shortDestinationAccount(dest, cfg);
  if (!account) throw new Error(`instagramTimerSlot: ${dest.id} sem conta na grade`);
  const also = shortDestinationAlsoAccounts(dest, cfg);
  return {
    destination: dest.id,
    account,
    ...(also.length ? { alsoAccounts: also } : {}),
    at: new Date(Date.parse(at)).toISOString(),
    hhmm,
    rule: "timer-300",
    premise: "timer do 300: sempre no horário do vertical, fora da grade (#11265)",
  };
}

/** Contas do Instagram que a fila do Worker sabe publicar (`ig_account`, #10823) — o tipo mora em short-video.ts (#10916). */
export type { WorkerInstagramAccount };

/**
 * #10906 — chave idempotente do Reels na fila do Worker: um por edição e conta.
 * O retry do `postToWorkerQueue` (resposta perdida depois do commit) e uma
 * rodada repetida no mesmo horário caem na mesma entry, nunca numa 2ª que
 * publicaria o mesmo Reels de novo.
 */
/**
 * Capa do Reel é opcional: erro no upload vira aviso e o Reel sai com o frame
 * automático, nunca derruba a publicação (review #11545).
 */
export async function uploadCoverOrFallback(
  upload: () => Promise<string>,
  log: (line: string) => void,
): Promise<ReelCoverUpload> {
  try {
    return await upload();
  } catch (e) {
    const error = `capa não enviada ao R2: ${(e as Error).message}`;
    log(`[aviso] ${error}; o Reel segue com o frame automático`);
    // #11679 item 1: a falha volta como valor, e não `undefined`, para o registro gravar `cover.ok: false`.
    return { error };
  }
}

/**
 * Resultado do upload da capa do Reel (#11679): a URL pública, a falha do
 * upload (o Reel sai com o frame automático e o registro diz que a capa não
 * foi) ou `undefined` (rodada sem capa a enviar).
 */
export type ReelCoverUpload = string | { error: string } | undefined;

/** Pure (#11679): URL que vai no `cover_url` do Reel; falha ou ausência = frame automático. */
export function reelCoverUrl(cover: ReelCoverUpload): string | undefined {
  return typeof cover === "string" ? cover : undefined;
}

/** Pure (#11547/#11679): registro da capa do Reel — `ok: false` com o erro quando o upload falhou. */
export function reelCoverRecord(cover: ReelCoverUpload): ShortCoverRecord | null {
  if (typeof cover === "string") return { method: "cover_url", ok: true };
  if (cover) return { method: "cover_url", ok: false, error: cover.error };
  return null;
}

export function shortsReelsIdempotencyKey(aammdd: string, account: WorkerInstagramAccount): string {
  return `shorts-instagram-${aammdd}-${account}`;
}

/** #10907 — motivo do bloqueio do repost quando o vídeo do perfil ficou em `send_unknown`. */
export const PROFILE_SEND_UNKNOWN_BLOCKER =
  "o vídeo do perfil (linkedin_profile) ficou em send_unknown (envio ambíguo) — confira o perfil e registre com --mark linkedin_profile=URL";

export type InstagramQueueReadiness = { ready: true; account: WorkerInstagramAccount } | { ready: false; reason: string };

/**
 * Pure (#10823): a fila do Worker consegue agendar o Reels desta autora? Precisa
 * do Worker (URL + token), do R2 pro `video_url` público e de uma autora que o
 * Worker conhece: `instagram_author_page` null = conta da diar.ia.br
 * (`diaria`); `vjpixel` = a conta vinculada à página VJ pixel (secrets
 * `INSTAGRAM_VJPIXEL_*` no Worker). Qualquer outra página não tem credencial
 * no Worker.
 */
export function resolveInstagramQueueReadiness(input: {
  authorPage: string | null;
  workerUrl: string;
  workerToken: string;
  r2Missing: string[];
}): InstagramQueueReadiness {
  const account: WorkerInstagramAccount | null = input.authorPage === null ? INSTAGRAM_ENV_ACCOUNT_KEY : input.authorPage === "vjpixel" ? "vjpixel" : null;
  if (!account) return { ready: false, reason: `o Worker só publica nas contas diaria e vjpixel, não na da página ${input.authorPage}` };
  const missing = [
    ...(input.workerUrl ? [] : ["DIARIA_LINKEDIN_CRON_URL"]),
    ...(input.workerToken ? [] : ["DIARIA_LINKEDIN_CRON_TOKEN"]),
    ...input.r2Missing,
  ];
  if (missing.length) return { ready: false, reason: `falta ${missing.join(", ")}` };
  return { ready: true, account };
}

/**
 * Pure (#10820): esta rodada precisa resolver a autora do Instagram? Não quando
 * o Instagram está desligado, fora do `--only`, ou já registrado (skip_done) —
 * aí a resolução seria só uma chamada à Graph (e um aviso) à toa.
 */
export function wantsInstagram(cfg: Pick<ShortsConfig, "instagram">, only: string[] | null, published: ShortsPublishedFile): boolean {
  if (!cfg.instagram) return false;
  if (only && only.length && !only.includes("instagram")) return false;
  return !isDestinationDone(published, "instagram");
}

// ── Graph API ────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (msg: string) => void;
}

export const defaultGraphDeps: GraphDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  log: (m) => console.error(m),
};

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

/**
 * #11774: teto de cada chamada à Graph (`graphPost`/`graphGet`). Sem ele, uma
 * conexão travada segurava o lock do timer até a idade de lock velho (90 min,
 * `SHORTS_TIMER_LOCK_STALE_MS`), e aí outra rodada podia publicar junto.
 */
export const GRAPH_REQUEST_TIMEOUT_MS = 60_000;

/**
 * #11774: a Graph RESPONDEU com erro (HTTP não-ok, `error` no JSON ou resposta
 * sem o campo esperado). Falha de transporte (timeout, conexão) não vira esta
 * classe: ela não prova o que aconteceu do outro lado.
 */
export class GraphResponseError extends Error {
  readonly status: number;
  /** `error.code` da Graph (190 = token inválido ou revogado). */
  readonly code: number | null;
  constructor(message: string, status: number, code: number | null) {
    super(message);
    this.name = "GraphResponseError";
    this.status = status;
    this.code = code;
  }
}

/** Token inválido/revogado (OAuthException 190): repetir a consulta não adianta. */
export function isGraphAuthError(e: unknown): boolean {
  return e instanceof GraphResponseError && e.code === 190;
}

function graphError(method: string, path: string, res: Response, json: any): GraphResponseError {
  const code = typeof json?.error?.code === "number" ? json.error.code : null;
  return new GraphResponseError(`${method} ${path}: ${res.status} ${JSON.stringify(json?.error ?? json)}`, res.status, code);
}

async function graphPost(deps: GraphDeps, path: string, params: Record<string, string>, apiVersion: string, base = GRAPH): Promise<any> {
  const res = await deps.fetch(`${base}/${apiVersion}/${path}`, { method: "POST", body: new URLSearchParams(params), signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS) });
  const json = await readJson(res);
  if (!res.ok || json.error) throw graphError("POST", path, res, json);
  return json;
}

async function graphGet(deps: GraphDeps, path: string, params: Record<string, string>, apiVersion: string): Promise<any> {
  const res = await deps.fetch(`${GRAPH}/${apiVersion}/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS) });
  const json = await readJson(res);
  if (!res.ok || json.error) throw graphError("GET", path, res, json);
  return json;
}

/** Envia o arquivo inteiro num POST ao rupload (offset 0). Só `success: true` conta. */
async function ruploadBinary(deps: GraphDeps, url: string, token: string, file: Buffer): Promise<void> {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(file.length) },
    body: new Uint8Array(file),
  });
  const json = await readJson(res);
  if (!res.ok || json.success !== true) throw new Error(`rupload: ${res.status} ${JSON.stringify(json.error ?? json)}`);
}

/** Folga mínima do Facebook pra agendar (10 min); abaixo disso, publica na hora. */
function stillSchedulable(scheduledAt: string | null, now: Date): string | null {
  if (!scheduledAt) return null;
  return Date.parse(scheduledAt) - now.getTime() > 10 * 60_000 ? scheduledAt : null;
}

/**
 * Espera o Facebook processar o vídeo (até 5 min). Erro de processamento
 * lança; tempo esgotado só avisa (o vídeo pode terminar depois) — o registro
 * sai com `unconfirmed` pra o relatório dizer "confira".
 */
async function waitFacebookProcessing(deps: GraphDeps, videoId: string, token: string, apiVersion: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    let st: any;
    try {
      st = (await graphGet(deps, videoId, { fields: "status", access_token: token }, apiVersion)).status ?? {};
    } catch (e) {
      deps.log(`[aviso] status do vídeo ${videoId}: ${(e as Error).message} — tentando de novo`);
      await deps.sleep(10_000);
      continue;
    }
    const phases = [st.uploading_phase, st.processing_phase, st.publishing_phase].map((p: any) => p?.status);
    if (st.video_status === "error" || st.video_status === "expired" || phases.includes("error")) {
      throw new Error(`Facebook recusou o vídeo ${videoId} no processamento: ${JSON.stringify(st)}`);
    }
    if (st.video_status === "ready" || st.processing_phase?.status === "complete") return true;
    await deps.sleep(10_000);
  }
  return false;
}

export interface PublishOutcome {
  entry: ShortPublishedEntry;
  /** true quando o processamento não foi confirmado no tempo de espera. */
  unconfirmed?: boolean;
  /** Avisos pós-publicação (ex.: convite de collab descartado, #10820). */
  warnings?: string[];
  /** #11355: outro processo registrou o destino antes do publish; nada saiu nesta rodada e `entry` é o registro dele. */
  alreadyRegistered?: true;
}

/**
 * #11869: o `finish` do Facebook (`/videos` ou `video_reels`) falhou sem resposta
 * definitiva da Graph — timeout de 60 s (`GRAPH_REQUEST_TIMEOUT_MS`), queda de
 * conexão ou 5xx. A Meta pode ter processado o `finish` e agendado (ou
 * publicado) o vídeo. Tratar como falha comum fazia a próxima rodada subir o
 * vídeo de novo e criar um 2º Reel na página pública; `publishFacebookReel`
 * converte este erro num registro `send_unknown` (conta como feito, nunca
 * re-posta), como o `media_publish` do Instagram (#11774).
 */
export class FacebookFinishUncertainError extends Error {
  readonly videoId: string;
  constructor(message: string, videoId: string) {
    super(message);
    this.name = "FacebookFinishUncertainError";
    this.videoId = videoId;
  }
}

/**
 * #11869: o `finish` do upload do Facebook. Resposta da Graph com erro 4xx (ou
 * 200 sem `success: true`) prova que o `finish` não valeu e lança o erro comum;
 * falha de transporte ou 5xx lança `FacebookFinishUncertainError`.
 */
async function facebookFinish(deps: GraphDeps, path: string, params: Record<string, string>, apiVersion: string, base: string, videoId: string): Promise<void> {
  let done: any;
  try {
    done = await graphPost(deps, path, params, apiVersion, base);
  } catch (e) {
    if (mediaPublishFailureIsDefinitive(e)) throw e;
    throw new FacebookFinishUncertainError(`POST ${path} (finish) sem resposta definitiva: ${(e as Error).message}`, videoId);
  }
  if (done.success !== true) throw new Error(`POST ${path} (finish) sem success: ${JSON.stringify(done)}`);
}

/** Teto de blocos do upload resumable — só existe pra nunca virar loop infinito (o servidor dita o tamanho do bloco). */
const FACEBOOK_RESUMABLE_MAX_CHUNKS = 10_000;
/** Tentativas por bloco no `transfer` (falha transitória não joga fora o que já subiu). */
const FACEBOOK_RESUMABLE_CHUNK_ATTEMPTS = 3;

/**
 * Upload RESUMABLE em `/{page-id}/videos` (#10815): `start` (tamanho) →
 * `transfer` dos blocos que o servidor pedir (offsets devolvidos a cada
 * resposta) → `finish` com legenda e agendamento. Substitui o POST único,
 * que dava `413` com o vertical exportado (275 MB em 261022). Devolve o
 * `video_id`.
 */
export async function uploadFacebookVideoResumable(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  file: Buffer,
  caption: string,
  scheduledAt: string | null,
): Promise<string> {
  const path = `${page.pageId}/videos`;
  const start = await graphPost(deps, path, { upload_phase: "start", file_size: String(file.length), access_token: page.token }, apiVersion, GRAPH_VIDEO);
  const sessionId: string | undefined = start.upload_session_id;
  const videoId: string | undefined = start.video_id;
  if (!sessionId || !videoId) throw new Error(`POST ${path} (start) sem upload_session_id/video_id: ${JSON.stringify(start)}`);
  let from = Number(start.start_offset);
  let to = Number(start.end_offset);
  for (let chunk = 0; from < file.length; chunk++) {
    if (chunk >= FACEBOOK_RESUMABLE_MAX_CHUNKS) throw new Error(`POST ${path} (transfer): mais de ${FACEBOOK_RESUMABLE_MAX_CHUNKS} blocos — abortado`);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > file.length) {
      throw new Error(`POST ${path} (transfer): offsets inválidos do servidor (start ${from}, end ${to}, arquivo ${file.length})`);
    }
    let json: any;
    for (let attempt = 1; ; attempt++) {
      const form = new FormData();
      form.append("access_token", page.token);
      form.append("upload_phase", "transfer");
      form.append("upload_session_id", sessionId);
      form.append("start_offset", String(from));
      form.append("video_file_chunk", new Blob([new Uint8Array(file.subarray(from, to))], { type: "application/octet-stream" }), "chunk");
      const res = await deps.fetch(`${GRAPH_VIDEO}/${apiVersion}/${path}`, { method: "POST", body: form });
      json = await readJson(res);
      if (res.ok && !json.error) break;
      const msg = `POST ${path} (transfer ${from}-${to}): ${res.status} ${JSON.stringify(json.error ?? json)}`;
      if (attempt >= FACEBOOK_RESUMABLE_CHUNK_ATTEMPTS) throw new Error(msg);
      deps.log(`[aviso] ${msg} — tentando o bloco de novo (${attempt}/${FACEBOOK_RESUMABLE_CHUNK_ATTEMPTS})`);
      await deps.sleep(5_000);
    }
    const next = Number(json.start_offset);
    if (!Number.isInteger(next) || next <= from) {
      throw new Error(`POST ${path} (transfer): o upload não avançou (start ${from} → ${json.start_offset})`);
    }
    from = next;
    to = Number(json.end_offset);
  }
  const finish: Record<string, string> = { upload_phase: "finish", upload_session_id: sessionId, description: caption, access_token: page.token };
  if (scheduledAt) {
    finish.published = "false";
    finish.scheduled_publish_time = String(Math.floor(Date.parse(scheduledAt) / 1000));
  }
  await facebookFinish(deps, path, finish, apiVersion, GRAPH_VIDEO, videoId); // #11869
  return videoId;
}

/**
 * #11547: capa do vídeo da Página — `POST /{video-id}/thumbnails` com o JPEG
 * (`source`) e `is_preferred=true`, o mesmo que o editor fez à mão na 261029
 * (HTTP 200 nas duas páginas). Nunca lança: a capa é opcional e o vídeo já
 * subiu; a falha volta no registro (`ok: false`).
 */
export async function setFacebookVideoThumbnail(
  deps: GraphDeps,
  videoId: string,
  token: string,
  apiVersion: string,
  jpeg: Buffer,
): Promise<ShortCoverRecord> {
  try {
    const form = new FormData();
    form.append("access_token", token);
    form.append("is_preferred", "true");
    form.append("source", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "capa.jpg");
    const res = await deps.fetch(`${GRAPH}/${apiVersion}/${videoId}/thumbnails`, { method: "POST", body: form });
    const json = await readJson(res);
    if (!res.ok || json.error || json.success === false) {
      return { method: "thumbnail_upload", ok: false, error: `POST ${videoId}/thumbnails: ${res.status} ${JSON.stringify(json.error ?? json)}` };
    }
    return { method: "thumbnail_upload", ok: true };
  } catch (e) {
    return { method: "thumbnail_upload", ok: false, error: `POST ${videoId}/thumbnails: ${(e as Error).message}` };
  }
}

/**
 * #11795: troca a descrição (e a capa) de um vídeo AGENDADO numa Página.
 * Reconfere antes que ele não foi ao ar (`published: false`): vídeo no ar não é
 * tocado. Capa é opcional e nunca derruba a troca do texto.
 */
export async function updateFacebookScheduledVideo(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  videoId: string,
  description: string,
  cover: Buffer | null,
): Promise<{ cover: ShortCoverRecord | null }> {
  const cur = await graphGet(deps, videoId, { fields: "published,scheduled_publish_time", access_token: page.token }, apiVersion);
  if (cur?.published === true) throw new Error(`o vídeo ${videoId} já está publicado na página — nada alterado; troque no Meta Business Suite`);
  await graphPost(deps, videoId, { description, access_token: page.token }, apiVersion);
  return { cover: cover ? await setFacebookVideoThumbnail(deps, videoId, page.token, apiVersion, cover) : null };
}

/**
 * Reels numa Página. ≤90 s: `video_reels` (start → rupload → finish). >90 s: `/videos` resumable (#10815).
 * #11547: com `cover`, aplica a capa logo depois do upload (as duas rotas).
 * #11869: `finish` sem resposta definitiva (timeout, conexão, 5xx) devolve o
 * registro `send_unknown` com o `video_id`, sem esperar processamento nem capa.
 */
export async function publishFacebookReel(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  file: Buffer,
  caption: string,
  plannedScheduledAt: string | null,
  cover: Buffer | null = null,
): Promise<PublishOutcome> {
  const scheduledAt = stillSchedulable(plannedScheduledAt, deps.now());
  if (plannedScheduledAt && !scheduledAt) deps.log(`[premissa] ${facebookDestinationId(page.slug)}: menos de 10 min pro horário — publicando na hora`);
  const route = facebookUploadRoute(mp4DurationSeconds(file));
  let videoId: string;

  try {
    if (route === "video_reels") {
      const start = await graphPost(deps, `${page.pageId}/video_reels`, { upload_phase: "start", access_token: page.token }, apiVersion);
      videoId = start.video_id;
      if (!videoId) throw new Error(`video_reels start sem video_id: ${JSON.stringify(start)}`);
      await ruploadBinary(deps, start.upload_url ?? `${RUPLOAD}/video-upload/${apiVersion}/${videoId}`, page.token, file);
      const finish: Record<string, string> = { upload_phase: "finish", video_id: videoId, description: caption, access_token: page.token };
      if (scheduledAt) {
        finish.video_state = "SCHEDULED";
        finish.scheduled_publish_time = String(Math.floor(Date.parse(scheduledAt) / 1000));
      } else {
        finish.video_state = "PUBLISHED";
      }
      await facebookFinish(deps, `${page.pageId}/video_reels`, finish, apiVersion, GRAPH, videoId); // #11869
    } else {
      videoId = await uploadFacebookVideoResumable(deps, page, apiVersion, file, caption, scheduledAt);
    }
  } catch (e) {
    if (!(e instanceof FacebookFinishUncertainError)) throw e;
    // #11869: o finish pode ter valido do lado da Meta — registra estado incerto, nunca re-posta sozinho.
    const at = deps.now().toISOString();
    return {
      entry: {
        destination: facebookDestinationId(page.slug),
        status: "send_unknown",
        id: e.videoId,
        scheduled_at: scheduledAt,
        at,
      },
      warnings: [
        `${e.message}: o vídeo ${e.videoId} PODE estar ${scheduledAt ? "agendado" : "no ar"} na página — confira no Meta Business Suite antes de repostar; ` +
          `se não estiver, apague a entrada de ${facebookDestinationId(page.slug)} do registro e rode de novo`,
      ],
    };
  }

  const confirmed = await waitFacebookProcessing(deps, videoId, page.token, apiVersion);
  const coverRecord = cover ? await setFacebookVideoThumbnail(deps, videoId, page.token, apiVersion, cover) : null;
  const warnings = coverRecord && !coverRecord.ok ? [`capa não aplicada (${coverRecord.error}) — o vídeo segue com o frame automático`] : [];
  return {
    entry: withCoverRecord(
      {
        destination: facebookDestinationId(page.slug),
        status: scheduledAt ? "scheduled" : "published",
        id: videoId,
        url: route === "video_reels" ? `https://www.facebook.com/reel/${videoId}` : `https://www.facebook.com/${page.pageId}/videos/${videoId}`,
        scheduled_at: scheduledAt,
        at: deps.now().toISOString(),
      },
      coverRecord,
    ),
    unconfirmed: !confirmed,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Autora do Reels no Instagram, resolvida pra uma conta + token (#10790). */
export type InstagramAuthor =
  | { ready: true; igUserId: string; token: string; username: string | null; source: string; warnings?: string[] }
  /**
   * `readFailed` (#11427): a credencial existe, mas a leitura da conta vinculada
   * na Graph falhou (5xx, rede) — falha transitória, não credencial ausente.
   */
  | { ready: false; reason: string; readFailed?: true };

/** Escopo que o token da página precisa pra publicar no Instagram vinculado. */
export const INSTAGRAM_PUBLISH_SCOPE = "instagram_content_publish";

/**
 * Escopos do token via `debug_token` (#10820). `error` = não deu pra conferir
 * (erro da Graph ou resposta sem `scopes`): o caller avisa e segue, porque
 * recusar aí bloquearia um token válido por falha de leitura.
 */
async function readTokenScopes(deps: Pick<GraphDeps, "fetch">, token: string, apiVersion: string): Promise<{ scopes: string[] } | { error: string }> {
  try {
    const json = await graphGet(deps as GraphDeps, "debug_token", { input_token: token, access_token: token }, apiVersion);
    const scopes = json?.data?.scopes;
    if (!Array.isArray(scopes)) return { error: "debug_token sem lista de escopos" };
    return { scopes: scopes.filter((x: unknown): x is string => typeof x === "string") };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Resolve a conta do Instagram que publica o Reels (faz um GET na Graph, inclusive no
 * dry-run). Com `authorPage`, é a conta
 * VINCULADA a essa página do Facebook, usando o token da página (precisa de
 * `instagram_content_publish`). Sem vínculo ou sem token → não pronto, com o
 * passo que destrava: nunca cai em silêncio na conta da diar.ia.br.
 */
export async function resolveInstagramAuthor(
  deps: Pick<GraphDeps, "fetch">,
  authorPage: string | null,
  pages: ResolvedFacebookPage[],
  apiVersion: string,
  envAccount: { igUserId: string; token: string },
  /** #11390: `readOnly` = só lê a conta (o `--confirm-instagram` no perfil do autor); não exige o escopo de publicação. */
  opts: { readOnly?: boolean } = {},
): Promise<InstagramAuthor> {
  if (authorPage === null) {
    if (!envAccount.igUserId || !envAccount.token) return { ready: false, reason: "sem INSTAGRAM_BUSINESS_ACCOUNT_ID/INSTAGRAM_ACCESS_TOKEN" };
    return { ready: true, igUserId: envAccount.igUserId, token: envAccount.token, username: null, source: "conta da diar.ia.br (env)" };
  }
  const page = pages.find((p) => p.slug === authorPage);
  if (!page) return { ready: false, reason: `instagram_author_page "${authorPage}" não existe em publishing.social.facebook.pages` };
  if (page.missing.length || !page.token || !page.pageId) {
    return { ready: false, reason: `página ${authorPage} sem credencial (${page.missing.join(", ")}) — rode scripts/facebook-page-token-setup.ts --pages ${authorPage}` };
  }
  let json: any;
  try {
    json = await graphGet(deps as GraphDeps, page.pageId, { fields: "instagram_business_account{id,username}", access_token: page.token }, apiVersion);
  } catch (e) {
    return { ready: false, reason: `não foi possível ler a conta do Instagram vinculada à página ${authorPage}: ${(e as Error).message}`, readFailed: true };
  }
  const ig = json?.instagram_business_account;
  if (!ig?.id) {
    return {
      ready: false,
      reason:
        `nenhuma conta do Instagram vinculada à página ${authorPage} — torne a conta pessoal profissional (criador), ` +
        `vincule-a à página no Facebook e gere de novo o token da página com instagram_content_publish ` +
        `(scripts/facebook-page-token-setup.ts --pages ${authorPage})`,
    };
  }
  if (opts.readOnly) return { ready: true, igUserId: ig.id, token: page.token, username: ig.username ?? null, source: `conta vinculada à página ${authorPage}` };
  // #10820: ler a conta vinculada não prova que o token PUBLICA — sem o escopo, a falha só apareceria no --publish.
  const scopeCheck = await readTokenScopes(deps, page.token, apiVersion);
  const warnings: string[] = [];
  if ("scopes" in scopeCheck) {
    if (!scopeCheck.scopes.includes(INSTAGRAM_PUBLISH_SCOPE)) {
      return {
        ready: false,
        reason:
          `o token da página ${authorPage} lê a conta vinculada mas não tem o escopo ${INSTAGRAM_PUBLISH_SCOPE} — ` +
          `gere de novo com esse escopo (scripts/facebook-page-token-setup.ts --pages ${authorPage})`,
      };
    }
  } else {
    warnings.push(`não deu pra conferir se o token da página ${authorPage} tem ${INSTAGRAM_PUBLISH_SCOPE} (${scopeCheck.error}) — a falha, se houver, aparece no --publish`);
  }
  return {
    ready: true,
    igUserId: ig.id,
    token: page.token,
    username: ig.username ?? null,
    source: `conta vinculada à página ${authorPage}`,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** #11355: como o Reels chega à Meta: bytes pelo rupload ou URL pública que ela baixa. */
export type InstagramReelSource = Buffer | { videoUrl: string };

/**
 * #11355: chave do vertical no R2 para o Reels. O arquivo genérico divide o
 * objeto com X e Threads; o corte próprio do Instagram (o timer passa `--video`
 * com ele) tem chave própria, senão o PUT trocaria o vídeo que a Buffer ainda
 * vai baixar pro X. A chave do corte leva o hash do conteúdo: trocado o corte no
 * Drive, a URL muda e nenhum cache serve o vídeo velho para a Meta.
 */
export function instagramR2VideoKey(aammdd: string, videoPath: string, file: Buffer): string {
  const generic = shortVideoFileName(aammdd);
  if (basename(videoPath) === generic) return `shorts/${generic}`;
  const hash = createHash("sha256").update(file).digest("hex").slice(0, 12);
  return `shorts/${shortInstagramVideoFileName(aammdd).replace(/\.mp4$/, "")}-${hash}.mp4`;
}

/** #11355: a rota do Reels nesta rodada e, na `video_url`, onde o vídeo fica no R2. */
export type InstagramReelRouteChoice =
  | { route: "rupload" }
  /** `genericKey`: objeto do vertical genérico, que serve se o corte for idêntico a ele; null quando `key` já é ele. */
  | { route: "video_url"; key: string; genericKey: string | null };

/** Pure (#11355): a ligação entre a autora, o arquivo e a rota, fora do `main()` para ter teste. */
export function instagramReelRouteChoice(input: {
  authorPage: string | null;
  aammdd: string;
  videoPath: string;
  file: Buffer;
  /** #11795: corte avulso — o Reels usa o mesmo objeto do corte que X e Threads (`corteR2Key`), nunca a chave da edição. */
  corteVideoKey?: string;
}): InstagramReelRouteChoice {
  if (instagramReelUploadRoute(input.authorPage) === "rupload") return { route: "rupload" };
  if (input.corteVideoKey) return { route: "video_url", key: input.corteVideoKey, genericKey: null };
  const key = instagramR2VideoKey(input.aammdd, input.videoPath, input.file);
  const generic = `shorts/${shortVideoFileName(input.aammdd)}`;
  return { route: "video_url", key, genericKey: key === generic ? null : generic };
}

/**
 * #11355: URL do vídeo do Reels. Corte idêntico ao vertical genérico já no
 * bucket reaproveita aquele objeto, sem duplicar o conteúdo em duas chaves.
 */
export async function instagramReelVideoUrl(
  choice: Extract<InstagramReelRouteChoice, { route: "video_url" }>,
  deps: { urlIfSameContent: (key: string) => Promise<string | null>; upload: (key: string) => Promise<string> },
): Promise<string> {
  const reused = choice.genericKey ? await deps.urlIfSameContent(choice.genericKey) : null;
  return reused ?? deps.upload(choice.key);
}

/**
 * #11355: reconferência do registro logo antes do `media_publish`, sem custo de
 * rede (o processamento leva até 72 s, e o `--mark` ou `--confirm-instagram` de
 * outro processo pode ter entrado nesse meio tempo). Registro ilegível lança.
 */
export function instagramPublishRecheck(
  dir: string,
  aammdd: string,
  onFresh: (fresh: ShortsPublishedFile) => void,
  read: (dir: string, aammdd: string) => ShortsPublishedFile = readShortsRegistry,
): () => ShortPublishedEntry | null {
  return () => {
    const recheck = recheckBeforePublish(dir, aammdd, "instagram", read);
    if (recheck.kind === "unreadable") throw new Error(recheck.error);
    if (recheck.kind === "proceed") return null;
    onFresh(recheck.fresh);
    return recheck.entry;
  };
}

/**
 * #11355 (porta `containerWasPublished` do Worker, #10877): o que o container diz
 * depois de uma falha no `media_publish`. Timeout ou 5xx não provam que o Reels
 * não saiu. `unknown` = a consulta falhou ou não trouxe o estado.
 */
async function instagramContainerPublishState(deps: GraphDeps, containerId: string, token: string, apiVersion: string): Promise<"published" | "finished" | "not_published" | "unknown"> {
  try {
    const code = (await graphGet(deps, containerId, { fields: "status_code", access_token: token }, apiVersion)).status_code;
    if (typeof code !== "string" || !code) return "unknown";
    if (code === "FINISHED") return "finished"; // #11774: pronto, e o publish pode estar em andamento
    return code === "PUBLISHED" ? "published" : "not_published";
  } catch {
    return "unknown";
  }
}

/**
 * #11774: a falha do `media_publish` prova que a Meta recusou? Só uma resposta
 * da Graph abaixo de 500 prova (4xx, ou 200 sem o id da mídia). Timeout, conexão caída ou 5xx deixam o publish possivelmente
 * em andamento: o container ainda aparece FINISHED (não PUBLISHED) e relançar
 * faria a próxima rodada depender só do gate do `/media`.
 */
export function mediaPublishFailureIsDefinitive(e: unknown): boolean {
  return e instanceof GraphResponseError && e.status < 500;
}

/**
 * #11355: fonte e capa do Reels, pela rota da autora. Na rota `video_url` a capa
 * sobe ANTES do vídeo: o upload da capa roda a poda de retenção de `shorts/`
 * (#10923), que apagaria um vertical mais velho que 7 dias reaproveitado antes
 * dela. Nesta ordem, o HEAD do vídeo vê o 404 da poda e sobe de novo. Falha no
 * upload do vídeo lança antes de qualquer container.
 */
export async function resolveInstagramReelInputs(input: {
  route: InstagramReelUploadRoute;
  file: Buffer;
  uploadCover: () => Promise<ReelCoverUpload>;
  uploadVideo: () => Promise<string>;
}): Promise<{ source: InstagramReelSource; cover: ReelCoverUpload }> {
  const cover = await input.uploadCover();
  if (input.route === "rupload") return { source: input.file, cover };
  return { source: { videoUrl: await input.uploadVideo() }, cover };
}

/**
 * Reels no Instagram → espera FINISHED → media_publish. Duas rotas de container
 * (#11355): `video_url` (a Meta baixa e processa sem o prazo de uma requisição,
 * mesmos parâmetros de `fireInstagramReels` no Worker) ou resumable + rupload.
 * O poll de até 10 min cobre o pior caso medido na `video_url`, 72 s.
 */
export async function publishInstagramReel(
  deps: GraphDeps,
  igUserId: string,
  token: string,
  apiVersion: string,
  source: InstagramReelSource,
  caption: string,
  collaborators: string[] = [],
  cover?: ReelCoverUpload,
  /** `beforePublish`: devolve o registro de outro processo (não publica) ou null; lançar também não publica. */
  opts: { beforePublish?: () => ShortPublishedEntry | null | Promise<ShortPublishedEntry | null> } = {},
): Promise<PublishOutcome> {
  const coverUrl = reelCoverUrl(cover);
  const file = Buffer.isBuffer(source) ? source : null;
  const params: Record<string, string> = {
    media_type: "REELS",
    ...(Buffer.isBuffer(source) ? { upload_type: "resumable" } : { video_url: source.videoUrl }),
    caption,
    share_to_feed: "true",
    access_token: token,
  };
  // #10790: collab — a Graph API recebe a lista como JSON; cada conta aceita o convite no app.
  if (coverUrl) params.cover_url = coverUrl;
  if (collaborators.length) params.collaborators = JSON.stringify(collaborators);
  const container = await graphPost(deps, `${igUserId}/media`, params, apiVersion);
  const containerId: string = container.id;
  if (!containerId) throw new Error(`media (REELS) sem id: ${JSON.stringify(container)}`);
  if (file) {
    try {
      await ruploadBinary(deps, container.uri ?? `${RUPLOAD}/ig-api-upload/${apiVersion}/${containerId}`, token, file);
    } catch (e) {
      const msg = (e as Error).message;
      // #10893: é assim que o teto de duração aparece — o rupload aceita os bytes e recusa no processamento.
      if (/ProcessingFailedError/.test(msg)) {
        throw new Error(
          `${msg} — padrão do teto de duração do Reels pela API (#10893); poste pelo instagram.com no Chrome (Passo B3b do /diaria-publica-video) ou no app ` +
            `e registre com --confirm-instagram (lê a mídia pela API) ou --mark instagram=URL ` +
            `(ajuste o teto desta conta em publishing.shorts.instagram_api_max_seconds_by_account se ele mudou, #10916)`,
        );
      }
      throw e;
    }
  }
  let last = "";
  for (let i = 0; ; i++) {
    if (i >= 60) throw new Error(`container ${containerId} não ficou pronto em 10 min (último: ${last || "sem resposta"})`);
    let st: any;
    try {
      st = await graphGet(deps, containerId, { fields: "status_code,status", access_token: token }, apiVersion);
    } catch (e) {
      // #11774: token revogado (190) não melhora com o tempo — falha já, sem 10 min de poll.
      if (isGraphAuthError(e)) throw new Error(`container ${containerId}: token do Instagram recusado (${(e as Error).message}) — renove o token da página autora`);
      // Falha transitória na consulta não joga fora o upload — tenta de novo até o teto.
      last = (e as Error).message;
      deps.log(`[aviso] instagram: status do container falhou (${last}) — tentando de novo`);
      await deps.sleep(10_000);
      continue;
    }
    // #11774: o `status` (texto da Meta) acompanha o código no erro de tempo esgotado.
    last = [st.status_code, st.status].filter((x) => typeof x === "string" && x).join(" ");
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
      // #11355: o Reels não saiu; a rota à mão segue valendo.
      const hint = file ? "" : " — pela rota video_url (#11355); se persistir, poste pelo Chrome (Passo B3b do /diaria-publica-video) e registre com --confirm-instagram";
      throw new Error(`container ${containerId}: ${st.status_code} ${st.status ?? ""}${hint}`);
    }
    await deps.sleep(10_000);
  }
  const registered = (await opts.beforePublish?.()) ?? null;
  if (registered) return { entry: registered, alreadyRegistered: true };
  let pub: any;
  try {
    pub = await graphPost(deps, `${igUserId}/media_publish`, { creation_id: containerId, access_token: token }, apiVersion);
    // Resposta 200 sem id: a Graph respondeu, o publish não está em andamento (#11774).
    if (!pub.id) throw new GraphResponseError(`media_publish sem id: ${JSON.stringify(pub)}`, 200, null);
  } catch (e) {
    const failure = (e as Error).message;
    const container = await instagramContainerPublishState(deps, containerId, token, apiVersion);
    // #11774: container FINISHED depois de timeout/5xx não prova que o publish não segue em andamento.
    const state = container === "finished" ? (mediaPublishFailureIsDefinitive(e) ? "not_published" : "unknown") : container;
    if (state === "not_published") throw e;
    const at = deps.now().toISOString();
    if (state === "published") {
      // Sem o id da mídia não há permalink: o registro sai sem `url` e o timer pede a conferência.
      return {
        entry: withCoverRecord({ destination: "instagram", status: "published", id: containerId, scheduled_at: null, at }, reelCoverRecord(cover)),
        warnings: [`media_publish falhou (${failure}), mas o container ${containerId} está PUBLISHED: o Reels está no ar, sem permalink no registro — não reposte; registre com --mark instagram=URL`],
      };
    }
    return {
      entry: withCoverRecord({ destination: "instagram", status: "send_unknown", id: `send_unknown-${at}`, scheduled_at: null, at }, reelCoverRecord(cover)),
      warnings: [`media_publish falhou (${failure}) e a consulta do container ${containerId} também: o Reels PODE estar no ar — confira a conta antes de repostar; registre com --mark instagram=URL`],
    };
  }
  let url: string | undefined;
  try {
    url = (await graphGet(deps, pub.id, { fields: "permalink", access_token: token }, apiVersion)).permalink;
  } catch (e) {
    deps.log(`[aviso] instagram: permalink indisponível (${(e as Error).message}) — o id ${pub.id} identifica o Reels`);
  }
  const warnings = collaborators.length ? await checkInstagramCollaborators(deps, pub.id, token, apiVersion, collaborators) : [];
  return {
    entry: withCoverRecord(
      { destination: "instagram", status: "published", id: pub.id, url, scheduled_at: null, at: deps.now().toISOString() },
      reelCoverRecord(cover), // #11547, #11679
    ),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Relê os collaborators da mídia publicada (#10820): o Instagram pode descartar
 * o convite sem erro no `media_publish` (conta inexistente, conta que não
 * aceita collab). Nunca lança — o Reels já está no ar; devolve avisos.
 */
export async function checkInstagramCollaborators(
  deps: Pick<GraphDeps, "fetch">,
  mediaId: string,
  token: string,
  apiVersion: string,
  expected: string[],
): Promise<string[]> {
  let json: any;
  try {
    json = await graphGet(deps as GraphDeps, `${mediaId}/collaborators`, { fields: "username,invite_status", access_token: token }, apiVersion);
  } catch (e) {
    return [`não deu pra conferir o convite de collab (${(e as Error).message}) — confira no app`];
  }
  return collabInviteWarnings(json?.data, expected, { reportPending: false });
}

/**
 * Pure: avisos sobre os collabs esperados, a partir de `/{media}/collaborators`
 * (`[{username, invite_status}]`). Ausente = convite descartado. Com
 * `reportPending` (#10915, conferência do post feito no Chrome), também avisa
 * `Pending` (a conta ainda não aceitou) e `Declined`. Logo depois do
 * `media_publish` pela API o convite é sempre `Pending`, por isso lá não avisa.
 */
export function collabInviteWarnings(data: unknown, expected: string[], opts: { reportPending: boolean }): string[] {
  if (!Array.isArray(data)) return ["resposta de collaborators sem lista — confira o convite de collab no app"];
  const status = new Map(data.map((c: any) => [String(c?.username ?? "").toLowerCase(), String(c?.invite_status ?? "")]));
  const missing = expected.filter((u) => !status.has(u.toLowerCase()));
  const out: string[] = [];
  if (missing.length) out.push(`convite de collab descartado pelo Instagram: ${missing.map((u) => `@${u}`).join(", ")} — convide à mão no app`);
  if (opts.reportPending) {
    for (const u of expected) {
      const st = status.get(u.toLowerCase());
      if (st && /^pending$/i.test(st)) out.push(`collab @${u} está Pending: a @${u} ainda precisa aceitar o convite no app`);
      if (st && /^declined$/i.test(st)) out.push(`collab @${u} foi recusado (Declined) — convide de novo no app`);
    }
  }
  return out;
}

/** Normaliza o `timestamp` do Instagram (`2026-10-22T15:22:00+0000`) pra ISO que o Date.parse aceita. */
function parseIgTimestamp(ts: unknown): number {
  if (typeof ts !== "string") return Number.NaN;
  return Date.parse(ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

/**
 * Tamanho de cada página que o `--confirm-instagram` lê de `/{ig-user}/media`
 * (as mais recentes da autora primeiro). Desde #10978 a leitura pagina
 * (`paging.next`) até achar o que procura ou bater `INSTAGRAM_CONFIRM_MAX_PAGES`.
 */
export const INSTAGRAM_CONFIRM_MEDIA_LIMIT = 15;

/**
 * Teto de páginas do `/media` (#10978): 5 × 15 = as 75 mídias mais recentes.
 * Os candidatos são sempre DENTRO do que foi lido: um Reels mais antigo que
 * isso não aparece (e a recusa diz quantas mídias foram lidas).
 */
export const INSTAGRAM_CONFIRM_MAX_PAGES = 5;

export interface InstagramReelCandidate {
  id: string;
  permalink: string | null;
  timestamp: string;
  /** A legenda tem o marcador desta edição (`instagramEditionMarkers`). */
  matchesEdition: boolean;
}

/**
 * Pure (#10915): marcadores que identificam o Reels DESTA edição na legenda.
 * A legenda do Instagram (`buildReelsCaption`) não leva URL nem UTM — manda
 * pro link da bio —, então o marcador principal é o título do D1, que abre a
 * legenda. `utm_campaign={AAMMDD}` e a URL da edição entram também, pro caso
 * de a legenda colada trazer o link.
 *
 * #10978 item 5: o gancho (1ª frase do D1, 2º parágrafo da legenda) também
 * conta, então editar só a 1ª linha (o título) no Chrome não derruba o
 * match. Gancho curto demais (< `INSTAGRAM_HOOK_MARKER_MIN_CHARS`) fica de
 * fora: casaria legenda de outra edição.
 */
export function instagramEditionMarkers(input: { aammdd: string; d1Title?: string | null; d1Body?: string | null; editionUrl?: string | null }): string[] {
  const out = [`utm_campaign=${input.aammdd}`];
  if (input.editionUrl) out.push(input.editionUrl.replace(/[?#].*$/, ""));
  const title = input.d1Title ? stripInlineMarkdown(input.d1Title).replace(/\s+/g, " ").trim() : "";
  if (title) out.push(title);
  const hook = input.d1Body ? firstSentence(input.d1Body) : "";
  if (Array.from(hook).length >= INSTAGRAM_HOOK_MARKER_MIN_CHARS) out.push(hook);
  return out;
}

/** #10978 item 5: tamanho mínimo do gancho pra valer como marcador da edição. */
export const INSTAGRAM_HOOK_MARKER_MIN_CHARS = 30;

/**
 * #10978 item 5: janela em torno do horário do vertical (`resolveShortTime`,
 * o mesmo horário em que o timer do 300 publica, #11265, e o slot do
 * Instagram no plano com `timer-300`) em que um Reels SEM marcador ainda pode
 * ser o da edição.
 */
export const INSTAGRAM_CONFIRM_TIME_WINDOW_MS = 90 * 60_000;

/**
 * #10978 item 5: trecho fixo da legenda de todo vertical (`buildReelsCaption`).
 * Não identifica a edição, só o formato: entra junto com a janela de horário,
 * nunca sozinho. #11388: a frase que explica a newsletter substituiu a linha do
 * canal do YouTube.
 */
export const INSTAGRAM_CAPTION_FORMAT_MARKER = REELS_NEWSLETTER_SENTENCE;

/** #11388: o trecho fixo das legendas de antes (linha do canal do YouTube), que segue valendo pros Reels já no ar. */
export const INSTAGRAM_CAPTION_LEGACY_FORMAT_MARKER = DIARIA_YOUTUBE_CHANNEL_URL.replace(/^https:\/\/www\./, "");

function normalizeForMatch(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Pure: a legenda tem algum dos marcadores (sem diferenciar caixa nem espaços)? */
export function captionMatchesEdition(caption: unknown, markers: string[]): boolean {
  if (typeof caption !== "string" || !caption) return false;
  const c = normalizeForMatch(caption);
  return markers.some((m) => m.trim() && c.includes(normalizeForMatch(m)));
}

export type InstagramConfirmDecision =
  /** Já registrado: no-op, nada é escrito. `exitCode` 1 quando o registro não é `published` (ex.: `scheduled` na fila). */
  | { kind: "already_registered"; entry: ShortPublishedEntry; exitCode: 0 | 1 }
  /**
   * Nenhum match, mais de 1 match, ou `--media-id` fora da lista: recusa (exit 1) listando os candidatos.
   * `cause` (#11265): `none` = nenhum Reels na janela; `no-match` = há Reels, nenhum da edição;
   * `ambiguous` = mais de um candidato; `window` = a leitura não cobriu o corte; `media-id` = escolha inválida.
   */
  | { kind: "refuse"; reason: string; candidates: InstagramReelCandidate[]; cause: "none" | "no-match" | "ambiguous" | "window" | "media-id" }
  /** `matchedBy` (#10978 item 5): pelo marcador na legenda, pela janela de horário + formato, ou pelo `--media-id`. */
  | { kind: "register"; entry: ShortPublishedEntry; candidates: InstagramReelCandidate[]; matchedBy: "marker" | "time-window" | "media-id" };

/**
 * Pure (#10915): decide o que o `--confirm-instagram` grava, a partir do
 * registro atual e da resposta de `/{ig-user}/media` (com `caption`). Só
 * aceita o Reels cuja legenda tem o marcador da edição — o "mais recente
 * desde 00:00" gravava qualquer Reels que a autora tivesse postado no dia.
 * `mediaId` (escolha explícita do editor) dispensa o marcador e o corte de
 * horário, mas a mídia tem que estar entre as lidas da autora (garante que é
 * dela).
 */
/**
 * Pure (#10915): o `instagram` já tem registro? Então o `--confirm-instagram`
 * é no-op (nada é escrito) e sai não-zero quando o registro não é
 * `published` — um `scheduled` na fila do Worker não é "postado no Chrome".
 */
export function instagramAlreadyRegistered(published: ShortsPublishedFile): { entry: ShortPublishedEntry; exitCode: 0 | 1 } | null {
  const existing = published.entries.find((e) => e.destination === "instagram");
  return existing ? { entry: existing, exitCode: existing.status === "published" ? 0 : 1 } : null;
}

export function decideInstagramConfirm(input: {
  published: ShortsPublishedFile;
  media?: unknown;
  sinceIso: string;
  markers: string[];
  mediaId?: string | null;
  nowIso: string;
  /**
   * #10978: a leitura do `/media` chegou ao `sinceIso` (ou acabou)? Default:
   * o `windowCovered` que `fetchInstagramRecentMedia` devolve junto de `data`,
   * senão `true`. `false` (parou no teto de páginas) recusa o match automático
   * — pode haver outro Reels da edição não lido — e exige `--media-id`.
   */
  windowCovered?: boolean;
  /**
   * #10978 item 5: horário planejado do Reels (ISO). Sem nenhum marcador na
   * legenda, aceita o ÚNICO Reels a até `windowMs` dele cuja legenda ainda tem
   * o formato do vertical (`INSTAGRAM_CAPTION_FORMAT_MARKER`). Ausente = só marcador.
   */
  expectedAtIso?: string | null;
  windowMs?: number;
}): InstagramConfirmDecision {
  const already = instagramAlreadyRegistered(input.published);
  if (already) return { kind: "already_registered", ...already };
  const since = Date.parse(input.sinceIso);
  if (Number.isNaN(since)) throw new Error(`--since inválido: ${input.sinceIso}`);
  const data = (input.media as any)?.data;
  if (!Array.isArray(data)) throw new Error(`GET /media sem lista: ${JSON.stringify(input.media ?? null).slice(0, 200)}`);
  const toCandidate = (m: any): InstagramReelCandidate => ({
    id: m.id,
    permalink: typeof m.permalink === "string" ? m.permalink : null,
    timestamp: String(m.timestamp ?? ""),
    matchesEdition: captionMatchesEdition(m.caption, input.markers),
  });
  const valid = data.filter((m: any) => typeof m?.id === "string");
  const byNewest = (a: InstagramReelCandidate, b: InstagramReelCandidate) => parseIgTimestamp(b.timestamp) - parseIgTimestamp(a.timestamp);
  const entryFor = (c: InstagramReelCandidate): ShortPublishedEntry => {
    const timestamp = parseIgTimestamp(c.timestamp);
    return {
      destination: "instagram",
      status: "published",
      id: c.id,
      ...(c.permalink ? { url: c.permalink } : {}),
      scheduled_at: null,
      at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : input.nowIso,
    };
  };
  const isReels = (m: any) => m.media_product_type === "REELS";
  if (input.mediaId) {
    const all = valid.map(toCandidate).sort(byNewest);
    const raw = valid.find((m: any) => m.id === input.mediaId);
    if (!raw) {
      return {
        kind: "refuse",
        reason: `--media-id ${input.mediaId} não está entre as ${data.length} mídias mais recentes lidas da autora`,
        candidates: all,
        cause: "media-id",
      };
    }
    // #10966: a escolha explícita também precisa ser um Reels — uma foto ou um
    // carrossel com o id errado viraria o registro `instagram: published` (#573).
    if (!isReels(raw)) {
      const type = typeof raw.media_product_type === "string" ? raw.media_product_type : "sem media_product_type";
      return {
        kind: "refuse",
        reason: `--media-id ${input.mediaId} não é um Reels (media_product_type: ${type}${typeof raw.media_type === "string" ? `, media_type: ${raw.media_type}` : ""}) — escolha um dos Reels listados`,
        candidates: valid.filter(isReels).map(toCandidate).sort(byNewest),
        cause: "media-id",
      };
    }
    return { kind: "register", entry: entryFor(toCandidate(raw)), candidates: all, matchedBy: "media-id" };
  }
  const reelsRaw = valid.filter((m: any) => isReels(m) && parseIgTimestamp(m.timestamp) >= since);
  const reels: InstagramReelCandidate[] = reelsRaw.map(toCandidate).sort(byNewest);
  const matches = reels.filter((c) => c.matchesEdition);
  const windowCovered = input.windowCovered ?? (input.media as any)?.windowCovered !== false;
  if (!windowCovered) {
    return {
      kind: "refuse",
      reason: `a leitura parou no teto de páginas (${data.length} mídias) sem chegar a ${input.sinceIso} — pode haver Reels da edição não lido; escolha com --media-id`,
      candidates: matches.length ? matches : reels,
      cause: "window",
    };
  }
  if (matches.length === 1) return { kind: "register", entry: entryFor(matches[0]), candidates: reels, matchedBy: "marker" };
  if (!reels.length) {
    return {
      kind: "refuse",
      reason: `nenhum Reels desde ${input.sinceIso} (entre as ${data.length} mídias mais recentes lidas) — o Share terminou? (o processamento leva ~30–60 s)`,
      candidates: [],
      cause: "none",
    };
  }
  if (matches.length > 1) {
    return {
      kind: "refuse",
      reason: `${matches.length} Reels desde ${input.sinceIso} têm o marcador desta edição na legenda — escolha com --media-id`,
      candidates: matches,
      cause: "ambiguous",
    };
  }
  // #10978 item 5: legenda editada (título e gancho trocados no Chrome). Vale o
  // ÚNICO Reels perto do horário planejado que ainda tem o formato do vertical;
  // dois ou mais na janela é ambíguo e recusa, como sempre.
  const expected = input.expectedAtIso ? Date.parse(input.expectedAtIso) : Number.NaN;
  if (!Number.isNaN(expected)) {
    const windowMs = input.windowMs ?? INSTAGRAM_CONFIRM_TIME_WINDOW_MS;
    const near = reelsRaw.filter(
      (m: any) => Math.abs(parseIgTimestamp(m.timestamp) - expected) <= windowMs && captionMatchesEdition(m.caption, [INSTAGRAM_CAPTION_FORMAT_MARKER, INSTAGRAM_CAPTION_LEGACY_FORMAT_MARKER]),
    );
    if (near.length === 1) return { kind: "register", entry: entryFor(toCandidate(near[0])), candidates: reels, matchedBy: "time-window" };
    if (near.length > 1) {
      return {
        kind: "refuse",
        reason: `nenhum Reels tem o marcador desta edição e ${near.length} Reels no formato do vertical caem a até ${Math.round(windowMs / 60_000)} min do horário planejado — escolha com --media-id`,
        candidates: near.map(toCandidate).sort(byNewest),
        cause: "ambiguous",
      };
    }
  }
  return {
    kind: "refuse",
    reason: `nenhum dos ${reels.length} Reels desde ${input.sinceIso} tem o marcador desta edição na legenda (título ou gancho do D1, utm_campaign)${Number.isNaN(expected) ? "" : " nem cai perto do horário planejado com o formato do vertical"} — escolha com --media-id`,
    candidates: reels,
    cause: "no-match",
  };
}

/**
 * #11390/#11794: recusas da conta da API em que vale procurar no perfil do autor
 * da rota do Chrome (`INSTAGRAM_CHROME_ROUTE`), quando ele é outra conta (só com
 * `instagram_author_page` apontando para outra página): nada da edição na conta,
 * ou o `--media-id` escolhido não está entre as mídias dela. Ambíguo e janela
 * incompleta não: lá a conta já tem candidato e quem escolhe é o editor.
 */
const CHROME_AUTHOR_FALLBACK_CAUSES: ReadonlySet<string> = new Set(["none", "no-match", "media-id"]);

export interface InstagramConfirmAcrossAccounts {
  decision: InstagramConfirmDecision;
  /** De onde veio a decisão: a conta da API ou o perfil do autor da rota do Chrome. */
  account: "primary" | "chrome-author";
  /** Por que o perfil do autor não resolveu (sem credencial, leitura falhou, recusa); ausente = não foi consultado ou resolveu. */
  fallbackNote?: string;
}

/**
 * #11390/#11794: o `--confirm-instagram` procura primeiro na conta da API e, se
 * ela não tem o Reels da edição, no perfil do autor da rota do Chrome, quando
 * ele é outra conta. Na config de produção a autora é a própria conta da API e
 * não há segundo perfil. `chromeAuthor` null = o perfil não é consultável (sem
 * credencial, ou é a mesma conta da API); o motivo vem em `chromeAuthorUnavailable`.
 * Falha na leitura do perfil nunca derruba a decisão da conta da API.
 */
export async function decideInstagramConfirmAcrossAccounts(deps: {
  primary: () => Promise<InstagramConfirmDecision>;
  chromeAuthor: (() => Promise<InstagramConfirmDecision>) | null;
  chromeAuthorUnavailable?: string;
}): Promise<InstagramConfirmAcrossAccounts> {
  const primary = await deps.primary();
  if (primary.kind !== "refuse" || !CHROME_AUTHOR_FALLBACK_CAUSES.has(primary.cause)) return { decision: primary, account: "primary" };
  const who = `@${INSTAGRAM_CHROME_ROUTE.authorUsername}`;
  if (!deps.chromeAuthor) {
    return { decision: primary, account: "primary", ...(deps.chromeAuthorUnavailable ? { fallbackNote: `perfil do ${who} não consultado: ${deps.chromeAuthorUnavailable}` } : {}) };
  }
  let fallback: InstagramConfirmDecision;
  try {
    fallback = await deps.chromeAuthor();
  } catch (e) {
    return { decision: primary, account: "primary", fallbackNote: `a leitura do perfil do ${who} falhou: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (fallback.kind === "register" || fallback.kind === "already_registered") return { decision: fallback, account: "chrome-author" };
  return { decision: primary, account: "primary", fallbackNote: `perfil do ${who}: ${fallback.reason}` };
}

/**
 * Pure (#11390): `--confirm-instagram --url URL` registra o Reel pela URL que
 * o editor copiou (sem conferência pela API). Só aceita permalink do instagram.com (`/reel/`, `/reels/`, `/p/`,
 * com ou sem o usuário antes); a query (`?igsh=...`) sai do registro.
 */
export function instagramConfirmUrlEntry(url: string, nowIso: string): { ok: true; entry: ShortPublishedEntry } | { ok: false; error: string } {
  const m = url.trim().match(/^https:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reel|reels|p)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/);
  if (!m) return { ok: false, error: `--url precisa ser o permalink do Reel no instagram.com (https://www.instagram.com/reel/CODIGO/), recebido ${JSON.stringify(url)}` };
  const clean = url.trim().replace(/[?#].*$/, "");
  return { ok: true, entry: { destination: "instagram", status: "published", id: clean, url: clean, scheduled_at: null, at: nowIso } };
}

export interface ChromeAuthorResolution {
  reader: Extract<InstagramAuthor, { ready: true }> | null;
  unavailable?: string;
  sameAccount?: true;
  /** #11427: a credencial existe, mas a leitura da conta vinculada falhou (transitório). */
  readFailed?: true;
}

/**
 * #11390: o leitor do perfil do autor da rota do Chrome (@diar.ia.br, #11794), só
 * leitura. `reader` null = não consultável (mesma conta da API, sem credencial, ou
 * a leitura falhou — `readFailed`, #11427), com o motivo em `unavailable`.
 * Compara por `instagramAccountKey`: `instagram_author_page: null` (a conta do
 * env) e a página `diaria` são a mesma conta, e nenhuma credencial de página é
 * pedida nesse caso.
 */
export async function resolveChromeAuthorReader(
  apiAuthorPage: string | null,
  pages: ResolvedFacebookPage[],
  igApiVersion: string,
  deps: Pick<GraphDeps, "fetch"> = defaultGraphDeps,
): Promise<ChromeAuthorResolution> {
  if (instagramAccountKey(apiAuthorPage) === instagramAccountKey(INSTAGRAM_CHROME_ROUTE.authorPage)) return { reader: null, unavailable: "é a mesma conta da API", sameAccount: true };
  const resolved = await resolveInstagramAuthor(deps, INSTAGRAM_CHROME_ROUTE.authorPage, pages, igApiVersion, { igUserId: "", token: "" }, { readOnly: true });
  if (resolved.ready) return { reader: resolved };
  return { reader: null, unavailable: resolved.reason, ...(resolved.readFailed ? { readFailed: true as const } : {}) };
}

/**
 * Pure (#11794): o perfil do autor resolvido → as deps do
 * `decideInstagramConfirmAcrossAccounts`. Mesma conta da API não tem segundo
 * perfil a consultar, então a recusa não leva nota de "perfil não consultado".
 */
export function confirmChromeAuthorDeps(
  chrome: ChromeAuthorResolution,
  readFor: (igUserId: string, token: string) => () => Promise<InstagramConfirmDecision>,
): { chromeAuthor: (() => Promise<InstagramConfirmDecision>) | null; chromeAuthorUnavailable?: string } {
  if (chrome.reader) return { chromeAuthor: readFor(chrome.reader.igUserId, chrome.reader.token) };
  if (chrome.sameAccount || chrome.unavailable === undefined) return { chromeAuthor: null };
  return { chromeAuthor: null, chromeAuthorUnavailable: chrome.unavailable };
}

/**
 * Pure (#11794): de quem o `--confirm-instagram` cobra o collab. O Reels achado na
 * conta da autora da rota do Chrome (no perfil dela ou porque ela é a conta da
 * API) exige a @vjpixel mesmo que `instagram_collaborators` mude; em outra conta
 * da API, valem só os do config.
 */
export function instagramConfirmExpectedCollabs(input: {
  account: InstagramConfirmAcrossAccounts["account"];
  sameAccount: boolean;
  configCollaborators: string[];
}): string[] {
  const routeCollab: string = INSTAGRAM_CHROME_ROUTE.collaboratorUsername;
  if (input.account === "chrome-author") return [routeCollab];
  if (!input.sameAccount) return input.configCollaborators;
  return input.configCollaborators.includes(routeCollab) ? input.configCollaborators : [...input.configCollaborators, routeCollab];
}

/**
 * Pure (#11427): o perfil do autor resolvido → as deps do
 * `decideInstagramTimerAcrossAccounts`. Leitura que falhou com a credencial
 * presente NÃO é "sem credencial": vira um `chromeAuthor` que lança, e o gate
 * classifica como `read-failed` (urgente, a próxima rodada tenta de novo) em
 * vez de `author-unchecked` (alarme `acao` que manda fornecer a credencial e
 * suprime o `late` da edição). Só é consultado quando a conta da API não tem
 * o Reels, como antes.
 */
export function timerChromeAuthorDeps(
  chrome: ChromeAuthorResolution,
  readFor: (igUserId: string, token: string) => () => Promise<InstagramConfirmDecision>,
): { chromeAuthor: (() => Promise<InstagramConfirmDecision>) | null; chromeAuthorUnavailable?: string } {
  if (chrome.reader) return { chromeAuthor: readFor(chrome.reader.igUserId, chrome.reader.token) };
  if (chrome.sameAccount) return { chromeAuthor: null };
  const why = chrome.unavailable ?? "sem credencial";
  if (chrome.readFailed) {
    return {
      chromeAuthor: async () => {
        throw new Error(why);
      },
    };
  }
  return { chromeAuthor: null, chromeAuthorUnavailable: why };
}

/**
 * #11389/#11390 (fix do review do PR #11395): a conferência da conta ANTES de o
 * timer publicar olha também o perfil do autor da rota do Chrome, quando ele é
 * outra conta. Na config de produção (#11794) a autora à mão é a própria conta da
 * API: o Reels aparece nela depois do processamento (30 a 60 s), e a leitura da
 * API basta; uma rodada dentro desses segundos não o vê e publica. Reel só na
 * @vjpixel não é lido, risco aceito (#11794: nunca postar por essa conta). Com
 * `instagram_author_page` em outra página, um Reels à mão não apareceria na conta
 * da API e o timer publicaria de novo, em conta pública. Regras:
 * - a conta da API acha o Reels, ou bloqueia (ambíguo/janela) → vale ela;
 * - nada na conta da API → a decisão do perfil do autor, se ele achou ou
 *   bloqueou; se ele também não tem nada, segue a da API (publica);
 * - leitura do perfil que falha → propaga (o gate vira `read-failed` e não
 *   publica: fail-closed, igual à leitura da conta da API);
 *   inclui a leitura da conta vinculada à página do autor com a credencial
 *   presente (#11427, `timerChromeAuthorDeps`): é transitória, não
 *   `author-unchecked`;
 * - perfil não consultável por ser a mesma conta da API (`chromeAuthor` null,
 *   sem `chromeAuthorUnavailable`) → segue a da API: ela já é o perfil do autor;
 * - perfil não consultável por falta da credencial da página do autor
 *   (`chromeAuthor` null com `chromeAuthorUnavailable`) → fail-closed (#11421):
 *   lança `InstagramTimerGateError` `author-unchecked` e não publica. Um Reels
 *   postado à mão seria invisível e a API duplicaria o post
 *   em conta pública; o timer alarma para o editor postar pelo Chrome ou prover
 *   a credencial. Só vale quando a conta da API não tem nada: achado/bloqueio
 *   nela continua decidindo sozinho.
 */
export async function decideInstagramTimerAcrossAccounts(deps: {
  primary: () => Promise<InstagramConfirmDecision>;
  chromeAuthor: (() => Promise<InstagramConfirmDecision>) | null;
  /** Por que o perfil do autor não é consultável (sem credencial). Ausente com `chromeAuthor` null = mesma conta da API. */
  chromeAuthorUnavailable?: string;
}): Promise<InstagramConfirmDecision> {
  const primary = await deps.primary();
  if (primary.kind !== "refuse" || (primary.cause !== "none" && primary.cause !== "no-match")) return primary;
  if (!deps.chromeAuthor) {
    if (deps.chromeAuthorUnavailable === undefined) return primary;
    throw new InstagramTimerGateError(
      `o perfil do @${INSTAGRAM_CHROME_ROUTE.authorUsername} não foi conferido (${deps.chromeAuthorUnavailable}) — um Reels postado à mão fica nesse perfil, não na conta da API; o timer não publica sem conferir. Poste pelo Chrome ou forneça a credencial da página ${INSTAGRAM_CHROME_ROUTE.authorPage} no 300`,
      "author-unchecked",
    );
  }
  const author = await deps.chromeAuthor();
  if (author.kind === "refuse" && (author.cause === "none" || author.cause === "no-match")) return primary;
  return author;
}

export type InstagramTimerAlreadyMatch = "registry" | "marker" | "time-window" | "media-id";

export type InstagramTimerPreflight =
  | { kind: "proceed" }
  /** O Reels da edição já está na conta (registrado ou achado pela API): grava, não publica. */
  | { kind: "already"; entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch }
  /** Pode haver Reels da edição na conta e não dá pra afirmar qual: não publica. */
  | { kind: "block"; reason: string };

/**
 * Pure (#11265): antes de o timer do 300 publicar o Reels, a conta já tem o da
 * edição? Cobre o Share feito por fora (Chrome/app) sem `--confirm-instagram`:
 * o registro não sabe, a conta sabe. Achou → grava e não publica; ambíguo ou
 * leitura incompleta → não publica (o timer avisa); nada → publica.
 */
export function instagramTimerPreflight(decision: InstagramConfirmDecision): InstagramTimerPreflight {
  if (decision.kind === "already_registered") return { kind: "already", entry: decision.entry, matchedBy: "registry" };
  if (decision.kind === "register") return { kind: "already", entry: decision.entry, matchedBy: decision.matchedBy };
  if (decision.cause === "none" || decision.cause === "no-match") return { kind: "proceed" };
  return { kind: "block", reason: decision.reason };
}

/**
 * #11265: por que a conferência da conta do timer não deixou publicar.
 * `blocked` = pode haver Reels da edição na conta (ambíguo, janela ou media-id);
 * `read-failed` = a leitura do `/media` falhou; `persist-failed` = o Reels foi
 * ACHADO na conta, mas o registro não foi gravado (`entry` = o achado);
 * `author-unchecked` (#11421) = nada na conta da API, mas o perfil do autor da
 * rota do Chrome, sendo outra conta, não pôde ser conferido (sem credencial).
 */
export type InstagramTimerGateFailure = "blocked" | "read-failed" | "persist-failed" | "author-unchecked";

/**
 * #11265: erro da conferência da conta do timer. O resultado do destino leva
 * `cause: "preflight"` no JSON, para o timer distinguir "o gate não deixou
 * publicar" (nunca sugerir `--publish`: pode duplicar o Reels) de "o publish
 * falhou".
 */
export class InstagramTimerGateError extends Error {
  readonly failure: InstagramTimerGateFailure;
  readonly entry?: ShortPublishedEntry;
  constructor(message: string, failure: InstagramTimerGateFailure, entry?: ShortPublishedEntry) {
    super(message);
    this.name = "InstagramTimerGateError";
    this.failure = failure;
    if (entry) this.entry = entry;
  }
}

/**
 * #11265: a conferência da conta ligada ao publish da rodada do timer, com I/O
 * injetável. Reels já no ar → grava (`persist`) e não publica; ambíguo ou
 * leitura incompleta → lança (o destino vira falha e o timer alarma, nunca
 * publica); achado só pela janela de horário → lança `blocked` sem gravar
 * (#11368); nada na conta → publica. Erro da leitura também lança
 * (fail-closed: a próxima execução de hora em hora tenta de novo). Todo erro
 * daqui é `InstagramTimerGateError` (`persist-failed` carrega o Reels achado).
 */
export async function instagramTimerGate(deps: {
  decide: () => Promise<InstagramConfirmDecision>;
  persist: (entry: ShortPublishedEntry) => void;
  /**
   * #11795: como registrar o Reels achado (a mensagem do bloqueio). Default: o
   * `--confirm-instagram --media-id` da edição; o corte avulso, que não tem
   * `--confirm-instagram`, passa o `--mark instagram=URL` do comando dele.
   */
  registerHint?: (mediaId?: string) => string;
}): Promise<{ kind: "publish" } | { kind: "already"; entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch }> {
  const hint = deps.registerHint ?? ((mediaId?: string) => `--confirm-instagram --media-id ${mediaId ?? "ID"}`);
  let decision: InstagramConfirmDecision;
  try {
    decision = await deps.decide();
  } catch (e) {
    if (e instanceof InstagramTimerGateError) throw e; // #11421: `author-unchecked` não é falha de leitura
    throw new InstagramTimerGateError(`a leitura da conta do Instagram falhou (${e instanceof Error ? e.message : String(e)}) — o timer não publica sem conferir`, "read-failed");
  }
  const pre = instagramTimerPreflight(decision);
  if (pre.kind === "block") {
    throw new InstagramTimerGateError(`a conta pode já ter o Reels da edição (${pre.reason}) — o timer não publica; confira e registre com ${hint()}`, "blocked");
  }
  if (pre.kind === "already" && pre.matchedBy === "time-window") {
    // #11368: achado só pela janela de ±90 min, sem o marcador da edição — pode
    // ser o Reels de OUTRA edição postado atrasado. O timer não registra (o
    // registro errado esconderia o Reels de hoje) nem publica: o editor confere.
    const where = pre.entry.url ?? pre.entry.id;
    throw new InstagramTimerGateError(
      `um Reels sem o marcador da edição está perto do horário (${where}, só pela janela de horário) — pode ser de outra edição; o timer não registra nem publica. Se for o desta edição, registre com ${hint(pre.entry.id)}`,
      "blocked",
    );
  }
  if (pre.kind === "already") {
    try {
      deps.persist(pre.entry);
    } catch (e) {
      throw new InstagramTimerGateError(`registro não gravado: ${e instanceof Error ? e.message : String(e)}`, "persist-failed", pre.entry);
    }
    return pre;
  }
  return { kind: "publish" };
}

/**
 * #11368: o passo do Instagram na rodada do timer, com I/O injetável — a
 * conferência da conta SEMPRE antes do upload. Reels já na conta → nada sobe;
 * gate que lança → nada sobe (o erro segue pro chamador).
 */
export async function instagramTimerPublishStep<T>(deps: {
  gate: () => ReturnType<typeof instagramTimerGate>;
  publish: () => Promise<T>;
}): Promise<{ kind: "already"; entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch } | { kind: "published"; outcome: T }> {
  const gate = await deps.gate();
  if (gate.kind === "already") return gate;
  return { kind: "published", outcome: await deps.publish() };
}

/**
 * #11828: o timer achou o Reels feito à mão na conta e o registrou sem publicar.
 * Relê `/{media}/collaborators` e devolve um aviso quando falta um collab
 * esperado (a @vjpixel, na rota do Chrome). Nunca lança nem bloqueia: o registro
 * já foi gravado e o Reels está no ar. `registry` não relê, porque nada foi
 * gravado nesta rodada (o registro veio de antes).
 */
export async function instagramTimerAlreadyCollabWarnings(
  deps: Pick<GraphDeps, "fetch">,
  input: { matchedBy: InstagramTimerAlreadyMatch; mediaId: string; token: string; apiVersion: string; expected: string[] },
): Promise<string[]> {
  if (input.matchedBy === "registry" || input.expected.length === 0) return [];
  return checkInstagramCollaborators(deps, input.mediaId, input.token, input.apiVersion, input.expected);
}

/**
 * #11774: a reconferência logo antes do `media_publish` na rodada do timer. O
 * gate da conta roda antes do upload no R2; o upload e o processamento levam
 * minutos, e um Share feito por fora nesse meio tempo não está no registro
 * local. Por isso, depois do registro local (sem custo de rede), o gate da conta
 * roda de novo: Reels achado → grava e não publica; gate que lança → não publica
 * (o erro segue como `cause: "preflight"`).
 */
export function instagramTimerBeforePublish(deps: {
  local: () => ShortPublishedEntry | null;
  gate: () => ReturnType<typeof instagramTimerGate>;
  /**
   * #11870: o gate da conta achou o Reels nesta reconferência (e gravou). Leva o
   * `matchedBy` ao chamador, que relê os collabs como no passo `already` do
   * início da rodada (#11828). O achado no registro local não chama: nada foi
   * gravado por esta rodada.
   */
  onAlready?: (hit: { entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch }) => void;
}): () => Promise<ShortPublishedEntry | null> {
  return async () => {
    const local = deps.local();
    if (local) return local;
    const gate = await deps.gate();
    if (gate.kind !== "already") return null;
    deps.onAlready?.({ entry: gate.entry, matchedBy: gate.matchedBy });
    return gate.entry;
  };
}

/**
 * Pure (#10978): a leitura do `/media` já tem o que procura? Com `mediaId`,
 * quando a mídia apareceu. Sem ele, quando a página mais recente lida já
 * chegou a uma mídia anterior ao `sinceIso` — o `/media` vem do mais novo pro
 * mais velho, então as páginas seguintes só trazem mídia fora da janela (e a
 * janela inteira precisa ser lida pra a recusa por ambiguidade valer).
 */
export function instagramMediaPagingDone(input: { lastPage: unknown[]; all: unknown[]; sinceIso?: string | null; mediaId?: string | null }): boolean {
  if (input.mediaId) return input.all.some((m: any) => m?.id === input.mediaId);
  const since = input.sinceIso ? Date.parse(input.sinceIso) : Number.NaN;
  if (Number.isNaN(since)) return false;
  return input.lastPage.some((m: any) => parseIgTimestamp(m?.timestamp) < since);
}

/**
 * #10915: lê `/{ig-user}/media` com a legenda, pro `decideInstagramConfirm`.
 * Só leitura: nunca cria container nem publica. Desde #10978 segue
 * `paging.next` (até `maxPages`, default `INSTAGRAM_CONFIRM_MAX_PAGES`) e
 * para assim que `instagramMediaPagingDone` diz que já achou. Devolve
 * `{ data }` com todas as páginas lidas, na ordem da API, e `windowCovered`:
 * `false` quando parou no teto sem chegar ao `sinceIso` (a decisão recusa).
 */
export async function fetchInstagramRecentMedia(
  deps: Pick<GraphDeps, "fetch">,
  igUserId: string,
  token: string,
  apiVersion: string,
  opts: { sinceIso?: string | null; mediaId?: string | null; maxPages?: number } = {},
): Promise<{ data: unknown[]; pages: number; more: boolean; windowCovered: boolean }> {
  // NaN/Infinity/undefined caem no teto padrão — nunca "sem limite".
  const maxPages = typeof opts.maxPages === "number" && Number.isFinite(opts.maxPages) ? Math.max(1, Math.floor(opts.maxPages)) : INSTAGRAM_CONFIRM_MAX_PAGES;
  let page: any = await graphGet(
    deps as GraphDeps,
    `${igUserId}/media`,
    { fields: "id,permalink,timestamp,media_product_type,media_type,caption", limit: String(INSTAGRAM_CONFIRM_MEDIA_LIMIT), access_token: token },
    apiVersion,
  );
  const all: unknown[] = [];
  let pages = 0;
  for (;;) {
    if (!Array.isArray(page?.data)) throw new Error(`GET ${igUserId}/media sem lista: ${JSON.stringify(page ?? null).slice(0, 200)}`);
    all.push(...page.data);
    pages++;
    const next = typeof page?.paging?.next === "string" ? page.paging.next : null;
    if (!next) return { data: all, pages, more: false, windowCovered: true };
    if (instagramMediaPagingDone({ lastPage: page.data, all, sinceIso: opts.sinceIso, mediaId: opts.mediaId })) {
      return { data: all, pages, more: true, windowCovered: true };
    }
    // Bateu o teto sem chegar ao corte: a janela pode ter mais Reels não lidos.
    if (pages >= maxPages) return { data: all, pages, more: true, windowCovered: false };
    // O `next` já traz o access_token: só segue se for o próprio Graph.
    if (new URL(next).origin !== GRAPH) throw new Error(`GET ${igUserId}/media: paging.next fora do Graph (${new URL(next).origin})`);
    const res = await deps.fetch(next);
    page = await readJson(res);
    if (!res.ok || page?.error) throw new Error(`GET ${igUserId}/media (página ${pages + 1}): ${res.status} ${JSON.stringify(page?.error ?? page)}`);
  }
}

/**
 * #10978: miolo do `--confirm-instagram` com I/O injetável — valida o
 * `--since` ANTES de qualquer leitura (um corte inválido não gasta 5 páginas
 * pra só então falhar), lê o `/media` com o corte e o `--media-id`, e decide.
 */
export async function readAndDecideInstagramConfirm(
  deps: Pick<GraphDeps, "fetch">,
  input: {
    igUserId: string;
    token: string;
    apiVersion: string;
    published: ShortsPublishedFile;
    sinceIso: string;
    markers: string[];
    mediaId?: string | null;
    nowIso: string;
    maxPages?: number;
    /** #10978 item 5: horário planejado do Reels (ver `decideInstagramConfirm`). */
    expectedAtIso?: string | null;
    /** #11795: mídias de outro vertical do dia já registradas (o Reels da edição, visto pelo corte): saem da decisão. */
    ignoreIds?: readonly string[];
  },
): Promise<InstagramConfirmDecision> {
  if (Number.isNaN(Date.parse(input.sinceIso))) throw new Error(`--since inválido: ${input.sinceIso}`);
  const read = await fetchInstagramRecentMedia(deps, input.igUserId, input.token, input.apiVersion, {
    sinceIso: input.sinceIso,
    mediaId: input.mediaId ?? null,
    maxPages: input.maxPages,
  });
  const ignore = new Set(input.ignoreIds ?? []);
  const media = ignore.size ? { ...read, data: read.data.filter((m: any) => !ignore.has(m?.id)) } : read;
  return decideInstagramConfirm({
    published: input.published,
    media,
    sinceIso: input.sinceIso,
    markers: input.markers,
    mediaId: input.mediaId ?? null,
    nowIso: input.nowIso,
    windowCovered: media.windowCovered,
    expectedAtIso: input.expectedAtIso ?? null,
  });
}

/** Lado com I/O do preparo do arquivo pro Chrome (#10915), injetável nos testes. */
export interface ChromeUploadDeps {
  runFfmpeg: (args: string[]) => { ok: true } | { ok: false; error: string };
  stat: (path: string) => { size: number; mtimeMs: number } | null;
  rename: (from: string, to: string) => void;
  /** Best-effort (arquivos de log do 2-pass, parcial de uma falha). */
  remove: (path: string) => void;
  mkdirp: (dir: string) => void;
  /** Sidecar do reuso; null = ausente/ilegível. */
  readText: (path: string) => string | null;
  writeText: (path: string, text: string) => void;
  /** `/dev/null` ou `NUL` (Windows). */
  nullSink: string;
}

/** Teto de cada passada do ffmpeg: um encode travado não pode segurar o --publish pra sempre. */
export const CHROME_UPLOAD_FFMPEG_TIMEOUT_MS = 15 * 60_000;

export const defaultChromeUploadDeps: ChromeUploadDeps = {
  runFfmpeg: (args) => {
    const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: CHROME_UPLOAD_FFMPEG_TIMEOUT_MS });
    if (r.error) return { ok: false, error: `${r.error.message}${r.signal ? ` (sinal ${r.signal})` : ""}` };
    if (r.signal) {
      return { ok: false, error: `ffmpeg encerrado por ${r.signal}${r.signal === "SIGTERM" ? ` (provável timeout de ${CHROME_UPLOAD_FFMPEG_TIMEOUT_MS / 60_000} min)` : ""}` };
    }
    if (r.status !== 0) return { ok: false, error: (r.stderr ?? "").trim().slice(-500) || `exit ${r.status}` };
    return { ok: true };
  },
  stat: (p) => {
    try {
      const st = statSync(p);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  },
  rename: (a, b) => renameSync(a, b),
  remove: (p) => rmSync(p, { force: true }),
  mkdirp: (d) => mkdirSync(d, { recursive: true }),
  readText: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeText: (p, t) => writeFileAtomic(p, t),
  nullSink: process.platform === "win32" ? "NUL" : "/dev/null",
};

/**
 * #10915: gera (ou reaproveita) a versão do vertical que cabe no `file_upload`
 * do Chrome. NUNCA lança: qualquer falha (ffmpeg ausente, encode quebrado,
 * timeout) volta `ok: false` e o passo guiado segue apontando pro original.
 * Reaproveita o arquivo já gerado só quando o sidecar `.json` bate exatamente
 * com a fonte (path, tamanho, mtime), o bitrate e o tamanho do próprio
 * arquivo, e ele tem de 1 byte a 10 MB.
 */
export function prepareInstagramChromeUpload(
  deps: ChromeUploadDeps,
  input: { source: string; output: string; durationSeconds: number },
): ChromeUploadResult {
  try {
    const bitrate = chromeUploadBitrate(input.durationSeconds);
    const src = deps.stat(input.source);
    if (!src) return { ok: false, error: `vídeo original ausente em ${input.source}` };
    const sidecarPath = chromeUploadSidecarPath(input.output);
    const expected = { source: { path: input.source, sizeBytes: src.size, mtimeMs: src.mtimeMs }, videoKbps: bitrate.videoKbps };
    const prev = deps.stat(input.output);
    if (prev && chromeUploadReusable(deps.readText(sidecarPath), expected, prev)) {
      return { ok: true, path: input.output, sizeBytes: prev.size, videoKbps: bitrate.videoKbps, reused: true };
    }
    deps.mkdirp(dirname(input.output));
    const tmp = input.output.replace(/\.mp4$/i, "") + ".part.mp4";
    const passlog = `${input.output}.2pass`;
    const cleanup = () => {
      for (const f of [`${passlog}-0.log`, `${passlog}-0.log.mbtree`]) deps.remove(f);
    };
    const passes = buildChromeUploadFfmpegPasses({
      input: input.source,
      output: tmp,
      videoKbps: bitrate.videoKbps,
      passlogfile: passlog,
      nullSink: deps.nullSink,
    });
    for (const [i, args] of passes.entries()) {
      const r = deps.runFfmpeg(args);
      if (!r.ok) {
        cleanup();
        deps.remove(tmp);
        return { ok: false, error: `ffmpeg (passada ${i + 1}) falhou: ${r.error}` };
      }
    }
    cleanup();
    const out = deps.stat(tmp);
    if (!out || out.size === 0) {
      deps.remove(tmp);
      return { ok: false, error: `ffmpeg terminou sem gerar ${tmp}` };
    }
    deps.rename(tmp, input.output);
    const sidecar: ChromeUploadSidecar = { ...expected, outputSizeBytes: out.size };
    const warnings: string[] = [];
    try {
      deps.writeText(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");
    } catch (e) {
      warnings.push(`sidecar ${sidecarPath} não gravado (${(e as Error).message}) — a próxima rodada refaz o arquivo`);
    }
    if (bitrate.warning) warnings.push(bitrate.warning);
    if (out.size > CHROME_UPLOAD_MAX_BYTES) {
      warnings.push(`o arquivo saiu com ${(out.size / 1e6).toFixed(1)} MB, acima dos ${CHROME_UPLOAD_MAX_BYTES / 1e6} MB do file_upload do Chrome — o editor escolhe o arquivo`);
    }
    return {
      ok: true,
      path: input.output,
      sizeBytes: out.size,
      videoKbps: bitrate.videoKbps,
      reused: false,
      ...(warnings.length ? { warning: warnings.join("; ") } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Pure (#10915): põe o arquivo do Chrome no passo guiado do Instagram, com
 * `upload.fitsChromeUpload` legível pela skill. Falha na compressão → o passo
 * aponta pro original (`fitsChromeUpload: false`), com aviso.
 */
export function attachChromeUploadToPlan(
  items: ShortsPlanItem[],
  upload: ChromeUploadResult,
  original: { path: string; sizeBytes: number | null },
): { items: ShortsPlanItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const next = items.map((i): ShortsPlanItem => {
    if (i.destination !== "instagram" || i.action !== "guided") return i;
    if (upload.ok) {
      if (upload.warning) warnings.push(`instagram: ${upload.warning}`);
      const fits = fitsChromeUpload(upload.sizeBytes);
      const mb = (upload.sizeBytes / 1e6).toFixed(1);
      return {
        ...i,
        upload: { path: upload.path, sizeBytes: upload.sizeBytes, fitsChromeUpload: fits },
        detail:
          `${i.detail}. Arquivo pro Chrome: ${upload.path} (${mb} MB, ${upload.videoKbps} kbps${upload.reused ? ", reaproveitado" : ""}` +
          `${fits ? "" : `; passa dos ${CHROME_UPLOAD_MAX_BYTES / 1e6} MB do file_upload — o editor escolhe o arquivo`})`,
      };
    }
    warnings.push(`instagram: versão comprimida não gerada (${upload.error}) — o passo guiado usa o original, e o editor escolhe o arquivo`);
    return { ...i, upload: { path: original.path, sizeBytes: original.sizeBytes, fitsChromeUpload: false } };
  });
  return { items: next, warnings };
}

export interface InstagramEnqueueDeps {
  /** Sobe o vertical e devolve a URL pública (R2). */
  uploadVideo: () => Promise<string>;
  uploadCover?: () => Promise<ReelCoverUpload>;
  /** `POST /queue` do Worker. */
  enqueue: (payload: WorkerQueuePayload) => Promise<{ key: string; scheduled_at: string }>;
  now: () => Date;
}

/**
 * #10823: agenda o Reels pela fila do Worker — sobe o vertical, enfileira com a
 * conta e os collabs, e registra como `scheduled` com a key da fila no `id`.
 * O 202 do Worker só prova que a entry está na fila, nunca que saiu
 * (`resolveWorkerQueueState`, #573): o registro nunca diz `published`.
 */
export async function enqueueInstagramReel(
  deps: InstagramEnqueueDeps,
  item: { caption: string; scheduledAt: string; igAccount: WorkerInstagramAccount; idempotencyKey: string },
  collaborators: string[],
): Promise<PublishOutcome> {
  const videoUrl = await deps.uploadVideo();
  const cover = await deps.uploadCover?.();
  const coverUrl = reelCoverUrl(cover);
  let queued: { key: string; scheduled_at: string };
  try {
    queued = await deps.enqueue(
      buildReelsQueuePayload({
        caption: item.caption,
        videoUrl,
        coverUrl,
        scheduledAt: item.scheduledAt,
        account: item.igAccount,
        collaborators,
        idempotencyKey: item.idempotencyKey,
      }),
    );
  } catch (e) {
    if (e instanceof WorkerQueueError && e.code === "instagram_account_creds_missing") {
      throw new Error(
        `o Worker recusou a conta ${item.igAccount}: faltam os secrets INSTAGRAM_VJPIXEL_ACCOUNT_ID/INSTAGRAM_VJPIXEL_ACCESS_TOKEN no diaria-linkedin-cron (${e.message})`,
      );
    }
    throw e;
  }
  const state = resolveWorkerQueueState({ key: queued.key, scheduled_at: queued.scheduled_at }, deps.now());
  return {
    // #11547: a capa vai no payload; o Worker é quem a aplica — `ok` aqui é "enviada à fila".
    entry: withCoverRecord(
      { destination: "instagram", status: "scheduled", id: queued.key, scheduled_at: queued.scheduled_at, at: deps.now().toISOString() },
      reelCoverRecord(cover),
    ),
    ...(state === "scheduled" ? {} : { warnings: [`fila do Worker devolveu scheduled_at ${queued.scheduled_at} (estado ${state}) — confira se a entry não disparou na hora`] }),
  };
}

/**
 * #10772: vertical nativo no perfil pessoal do LinkedIn (Videos API + Posts
 * API, `scripts/lib/linkedin-video.ts`). Falha antes do envio lança (nada no
 * perfil, pode re-tentar). Envio AMBÍGUO (timeout/5xx no POST do post) volta
 * como `send_unknown`: o registro passa a contar o destino como feito e a
 * próxima rodada não re-posta — o editor confere o perfil e registra com
 * `--mark linkedin_profile=URL`.
 */
export async function publishLinkedInProfileVideo(
  deps: LinkedInVideoDeps & { now: () => Date },
  creds: PersonalCreds,
  apiVersion: string,
  file: Buffer,
  text: string,
  title: string,
  /** #11547: capa (JPEG) — `uploadThumbnail` na Videos API; falha nunca derruba o vídeo. */
  cover: Buffer | null = null,
): Promise<PublishOutcome> {
  // CONFERIR NA 1ª EXECUÇÃO REAL (#10772 F3): `new Uint8Array(file)` copia o
  // vertical inteiro (275 MB em 261022). Se a memória do processo apertar, trocar
  // por `new Uint8Array(file.buffer, file.byteOffset, file.length)` (sem cópia).
  const r = await postVideoToPersonalProfile({ deps, creds, apiVersion, text, title, bytes: new Uint8Array(file), thumbnail: cover ? new Uint8Array(cover) : null });
  const at = deps.now().toISOString();
  const coverRecord: ShortCoverRecord | null = r.thumbnail
    ? r.thumbnail.ok
      ? { method: "thumbnail_upload", ok: true }
      : { method: "thumbnail_upload", ok: false, error: r.thumbnail.error }
    : null;
  const coverWarnings = coverRecord && !coverRecord.ok ? [`capa não aplicada (${coverRecord.error}) — o vídeo segue com o frame automático`] : [];
  if (r.ok) {
    const url = postUrlFromUrn(r.postUrn);
    const warnings = [...(r.postUrn ? [] : ["a LinkedIn aceitou o post sem devolver a URN (x-restli-id) — confira o perfil"]), ...coverWarnings];
    return {
      entry: withCoverRecord({ destination: "linkedin_profile", status: "published", id: r.postUrn ?? `sem-urn-${at}`, ...(url ? { url } : {}), scheduled_at: null, at }, coverRecord),
      ...(warnings.length ? { warnings } : {}),
    };
  }
  if (r.phase === "ambiguous") {
    return {
      entry: withCoverRecord({ destination: "linkedin_profile", status: "send_unknown", id: `send_unknown-${at}`, scheduled_at: null, at }, coverRecord),
      warnings: [`envio ambíguo (${r.reason}) — confira o perfil antes de qualquer nova tentativa e registre com --mark linkedin_profile=URL`, ...coverWarnings],
    };
  }
  throw new Error(r.reason);
}

/** URL pública do Short (#11070) — o `youtu.be/{id}` também abre, mas o registro guarda a de Shorts. */
export function youtubeShortUrl(videoId: string): string {
  return `https://youtube.com/shorts/${videoId}`;
}

/**
 * #11070: Short pela YouTube Data API — o mesmo `uploadYouTubeVideo` do
 * horizontal (`publish-youtube.ts`), com `publishAt` no horário do vertical.
 * Capa (#11547): `thumbnails.set` com o Still depois do insert — vale pra Short
 * (HTTP 200 medido pelo editor em 28/10/2026); falha só vira aviso. Antes de enviar confere o canal (`kind: "short"`): Short da edição já
 * lá (subido à mão) vira registro, sem novo upload; reconhecido só pelo dia,
 * lança pedindo confirmação (`--mark youtube_shorts=URL` ou `--force-youtube`).
 * Falha a partir do PUT dos bytes devolve `send_unknown` (o vídeo PODE
 * existir; a próxima rodada não re-envia). `onBeforeBytes` recebe o mesmo
 * `send_unknown` pra gravar ANTES do PUT: um processo morto no meio do upload
 * também não duplica.
 */
export async function publishYouTubeShort(input: {
  deps: YouTubeUploadDeps;
  env: Record<string, string | undefined>;
  aammdd: string;
  title: string;
  description: string;
  scheduledAt: string | null;
  file: Buffer;
  /** `--force-youtube`: pula a conferência do canal. */
  force: boolean;
  onBeforeBytes?: (entry: ShortPublishedEntry) => void;
  /** #11547: capa (JPEG) — `thumbnails.set` depois do insert; falha não desfaz o Short. */
  cover?: Buffer | null;
  /**
   * #11795: corte avulso — só o título conta como "já está no canal". A marca
   * da edição e o dia acusariam o Short da EDIÇÃO do mesmo dia.
   */
  matchTitleOnly?: boolean;
}): Promise<PublishOutcome> {
  const missing = missingYouTubeCredentials(input.env);
  if (missing.length) throw new Error(`faltam ${missing.join(", ")} no ambiente (rode scripts/youtube-oauth-setup.ts)`);
  const schedule: YouTubeScheduleDecision = input.scheduledAt
    ? { mode: "scheduled", publishAt: input.scheduledAt, privacyStatus: "private", premise: "" }
    : { mode: "immediate", publishAt: null, privacyStatus: "public", premise: "" };
  const request = buildYouTubeInsertRequest(
    { title: input.title, description: input.description, tags: buildYouTubeTags() },
    schedule,
    { contentType: "video/mp4", contentLength: input.file.length },
  );
  const unknownEntry = (): ShortPublishedEntry => {
    const at = input.deps.now().toISOString();
    return { destination: "youtube_shorts", status: "send_unknown", id: `send_unknown-${at}`, scheduled_at: input.scheduledAt, at };
  };
  let result;
  try {
    result = await uploadYouTubeVideo(input.deps, {
      creds: {
        clientId: (input.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (input.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (input.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (input.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      },
      request,
      video: input.file,
      contentType: "video/mp4",
      thumbnail: input.cover ?? null,
      ...(input.force ? {} : { existingVideoCheck: { aammdd: input.aammdd, title: input.title, kind: "short" as const, ...(input.matchTitleOnly ? { titleOnly: true } : {}) } }),
      ...(input.onBeforeBytes ? { beforeVideoBytes: () => input.onBeforeBytes!(unknownEntry()) } : {}),
    });
  } catch (e) {
    if (e instanceof ExistingEditionVideoError) {
      const v = e.video;
      if (v.matchedBy === "period") {
        throw new Error(
          `há um Short no canal no dia da edição sem a marca dela (${v.url}, "${v.title || "sem título"}") — nada enviado. ` +
            "Se for o Short desta edição, registre com --mark youtube_shorts=URL; se não for, rode com --force-youtube",
        );
      }
      const now = input.deps.now();
      const state = v.status ? resolveYouTubeState({ status: v.status }, now) : "unknown";
      const at = now.toISOString();
      const base = { destination: "youtube_shorts", id: v.videoId, url: youtubeShortUrl(v.videoId), at };
      const warn = `já no canal (reconhecido por ${v.matchedBy}), nada enviado`;
      if (state === "published") return { entry: { ...base, status: "published", scheduled_at: null }, warnings: [warn] };
      if (state === "scheduled") return { entry: { ...base, status: "scheduled", scheduled_at: v.status?.publishAt ?? null }, warnings: [warn] };
      return { entry: { ...base, status: "send_unknown", scheduled_at: null }, warnings: [`${warn}; estado ${state} — confira no YouTube Studio`] };
    }
    if (!isIndeterminateUploadFailure(e)) throw e;
    return {
      entry: unknownEntry(),
      warnings: [`upload em estado incerto (${(e as Error).message}) — o Short PODE ter sido criado; confira o canal e registre com --mark youtube_shorts=URL`],
    };
  }
  const warnings: string[] = [];
  if (result.rereadError) warnings.push(`releitura do estado falhou: ${result.rereadError}`);
  const failed = failedUploadStatus(result.rereadStatus);
  // #11547: `thumbnails.set` vale para Short (medido em 28/10/2026); falha só vira registro.
  const thumb = result.thumbnail;
  const cover: ShortCoverRecord | undefined = thumb?.attempted
    ? thumb.ok
      ? { method: "thumbnails_set", ok: true }
      : { method: "thumbnails_set", ok: false, error: thumb.error ?? "sem detalhe" }
    : undefined;
  if (cover && !cover.ok) warnings.push(`capa não aplicada (${cover.error}) — troque no YouTube Studio (Miniatura → Enviar arquivo)`);
  const base = { destination: "youtube_shorts", id: result.videoId, url: youtubeShortUrl(result.videoId), at: result.uploadedAt, ...(cover ? { cover } : {}) };
  if (failed) {
    warnings.push(`o YouTube marcou uploadStatus=${failed} — o Short não vai ao ar; confira no Studio (registro mantido para não re-enviar)`);
    return { entry: { ...base, status: "send_unknown", scheduled_at: null }, warnings };
  }
  if (result.state !== "published" && result.state !== "scheduled") warnings.push(`estado relido ${result.state}: ${describeYouTubeState(result.state)}`);
  return {
    entry: input.scheduledAt ? { ...base, status: "scheduled", scheduled_at: input.scheduledAt } : { ...base, status: "published", scheduled_at: null },
    ...(warnings.length ? { warnings } : {}),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * #11547: a capa do vertical na pasta da edição (`04-youtube-short-capa.jpg`)
 * e o offset da Buffer derivado do Still que a gerou (sidecar de
 * `fetch-drive-video.ts`). Capa vazia/ausente → `path: null`. Nunca lança:
 * leitura falha vira "sem capa" com aviso — a capa nunca barra o vídeo.
 * #11923: na leitura falha, `unreadable` traz o motivo (a capa EXISTE): o
 * "pode publicar" do corte não é gravado com `cover_sha256: null` por isso.
 */
export function readShortCover(dir: string, log: (line: string) => void = () => {}): { path: string | null; bytes: Buffer | null; bufferOffsetMs: number | null; unreadable?: string } {
  const path = join(dir, SHORT_COVER_FILE);
  try {
    if (!existsSync(path) || statSync(path).size === 0) return { path: null, bytes: null, bufferOffsetMs: null };
    const bytes = readFileSync(path);
    const sidecar = join(dir, SHORT_COVER_SOURCE_FILE);
    const source = parseShortCoverSource(existsSync(sidecar) ? readFileSync(sidecar, "utf8") : null, bytes.length);
    return { path, bytes, bufferOffsetMs: bufferThumbnailOffsetMs(source) };
  } catch (e) {
    log(`[aviso] capa do vertical ilegível (${(e as Error).message}) — segue sem capa`);
    return { path: null, bytes: null, bufferOffsetMs: null, unreadable: (e as Error).message };
  }
}

/**
 * #11157: destino que outro processo (o timer do 300, um `--mark` no neo)
 * registrou DEPOIS que esta rodada leu o registro. Relido do disco logo antes
 * de publicar: o plano foi montado com a leitura do início da rodada, e
 * publicar por cima de uma entrada nova duplicaria o post. Puro.
 */
export function registeredSinceRead(fresh: ShortsPublishedFile, destination: string): ShortPublishedEntry | null {
  return fresh.entries.find((e) => e.destination === destination) ?? null;
}

/** #11159: resultado da reconferência no disco logo antes de publicar um destino. */
export type PrePublishRecheck =
  | { kind: "proceed"; fresh: ShortsPublishedFile }
  | { kind: "already"; fresh: ShortsPublishedFile; entry: ShortPublishedEntry }
  | { kind: "unreadable"; error: string };

/**
 * #11157/#11159: a reconferência do laço de publicação, extraída pra ser
 * testável. Relê o registro unido do disco (`read`, injetável no teste);
 * registro ilegível nunca vira "publica" (`unreadable`), destino já registrado
 * por outro processo vira `already`.
 */
/**
 * Puro (#12001): destinos do timer do corte que ESTA rodada vai publicar (na
 * última hora antes do teto de 3 h a rodada manual não delega mais, #11996,
 * e o timer ainda pode passar). Não vazio = a rodada toma o lock do timer do
 * corte (`CORTE_TIMER_LOCK_FILE`) durante os envios. O filho do timer
 * (`timerRun`) nunca toma: quem o chamou já está com o lock.
 */
export function corteManualTimerDestinations(items: readonly ShortsPlanItem[], corte: { timerRun?: boolean } | null | undefined): string[] {
  if (!corte || corte.timerRun === true) return [];
  return items.filter((i) => (i.action === "publish" || i.action === "enqueue") && CORTE_TIMER_DESTINATIONS.includes(i.destination)).map((i) => i.destination);
}

/**
 * #12004: libera o lock na conclusão, em exceção e nos sinais de parada capturáveis.
 * No sinal, libera o lock, remove o handler e re-emite o mesmo sinal: o processo morre
 * pela disposição padrão (status 130 no SIGINT, 143 no SIGTERM), sem `process.exit()`,
 * que o #9911 proíbe em script com fetch (`scripts/lib/cli-exit.ts`).
 */
export function registerCorteLockCleanup(release: () => void): () => void {
  let released = false;
  const reraise = (sig: "SIGINT" | "SIGTERM", code: number) => () => {
    cleanup();
    process.exitCode = code;
    process.kill(process.pid, sig);
  };
  const onSigint = reraise("SIGINT", 130);
  const onSigterm = reraise("SIGTERM", 143);
  const cleanup = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", cleanup);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    release();
  };
  // SIGKILL não é capturável; nesse caso continua valendo a expiração do lock.
  process.once("exit", cleanup);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return cleanup;
}

/** #12001: motivo da recusa quando o timer do corte está com o lock (nada enviado nesses destinos). */
export function corteTimerLockBusyError(slug: string): string {
  return (
    `outra execução (manual ou timer) está com o lock do corte "${slug}" agora (${CORTE_TIMER_LOCK_FILE} de pé): nada enviado neste destino para não duplicar o post. ` +
    "Rode de novo em alguns minutos: a rodada relê o registro e só publica o que ainda não foi registrado (#12001)"
  );
}

export function recheckBeforePublish(
  dir: string,
  aammdd: string,
  destination: string,
  read: (dir: string, aammdd: string) => ShortsPublishedFile = readShortsRegistry,
): PrePublishRecheck {
  let fresh: ShortsPublishedFile;
  try {
    fresh = read(dir, aammdd);
  } catch (e) {
    return { kind: "unreadable", error: `registro ilegível na reconferência, não publica: ${(e as Error).message}` };
  }
  const entry = registeredSinceRead(fresh, destination);
  return entry ? { kind: "already", fresh, entry } : { kind: "proceed", fresh };
}

/**
 * Grade já agendada do dia (#10819): posts sociais da edição + o que o vertical
 * já registrou + a fila do Worker (`opts.workerQueue`, a resposta de `GET
 * /list` já lida — `loadWorkerQueueForGrid`). Store social ausente = só o do
 * vertical; ilegível = aviso e segue sem ele (a grade só ajusta horário; nunca
 * é motivo pra não publicar). `opts.instagramCollaborators`: o Reels registrado
 * ocupa também a conta dos collabs (decisão do editor 261023).
 */
export function loadScheduledGrid(
  dir: string,
  published: ShortsPublishedFile,
  instagramAccount: string | null,
  warn: (m: string) => void,
  opts: { instagramCollaborators?: readonly string[]; workerQueue?: unknown } = {},
): ScheduledSlot[] {
  const local = loadEditionGrid(dir, published, instagramAccount, warn, opts.instagramCollaborators ?? []);
  return opts.workerQueue === undefined ? local : mergeGrids(local, gridFromWorkerQueue(opts.workerQueue));
}

/**
 * #11795: grade da edição do dia, vista pelo corte avulso. Só leitura e
 * fail-soft: pasta ausente = grade vazia; registro ilegível = aviso.
 */
export function loadEditionDayGrid(
  editionDir: string,
  aammdd: string,
  instagramAccount: string | null,
  instagramCollaborators: readonly string[],
  warn: (m: string) => void,
): ScheduledSlot[] {
  if (!existsSync(editionDir)) return [];
  let published: ShortsPublishedFile;
  try {
    published = readShortsRegistry(editionDir, aammdd);
  } catch (e) {
    warn(`registro do vertical da edição ${aammdd} ilegível (${(e as Error).message}) — a grade do corte segue sem ele`);
    published = { aammdd, entries: [] };
  }
  return loadEditionGrid(editionDir, published, instagramAccount, warn, instagramCollaborators);
}

function loadEditionGrid(
  dir: string,
  published: ShortsPublishedFile,
  instagramAccount: string | null,
  warn: (m: string) => void,
  instagramCollaborators: readonly string[],
): ScheduledSlot[] {
  const grid = gridFromShortsPublished(published, instagramAccount ?? "diaria", instagramCollaborators);
  // #10772: o 4º post no perfil pessoal do LinkedIn (#9568) disputa a mesma conta que o vertical nativo.
  const personal = join(dir, "_internal", PERSONAL_INTENT_FILE);
  if (existsSync(personal)) {
    try {
      grid.push(...gridFromLinkedInPersonalIntent(JSON.parse(readFileSync(personal, "utf8"))));
    } catch (e) {
      warn(`${personal} ilegível (${(e as Error).message}) — grade sem o 4º post do perfil pessoal`);
    }
  }
  const p = join(dir, "_internal", "06-social-published.json");
  if (!existsSync(p)) return grid;
  try {
    return [...gridFromSocialPublished(JSON.parse(readFileSync(p, "utf8"))), ...grid];
  } catch (e) {
    warn(`${p} ilegível (${(e as Error).message}) — grade #10819 sem os posts sociais do dia`);
    return grid;
  }
}

/**
 * #11001: teto da leitura da fila do Worker. A fila só ajusta horário, então um
 * Worker lento/pendurado nunca pode prender o script (nem o dry-run): estourou,
 * aborta e segue sem a fila, como em qualquer outra falha do Worker.
 */
export const WORKER_QUEUE_LIST_TIMEOUT_MS = 10_000;

/**
 * Lê a fila do Worker (`GET /list`, só leitura) pra grade do #10819. Fail-soft:
 * sem URL/token, com erro ou passado `timeoutMs` (#11001), avisa e devolve
 * `undefined` (a grade segue só com os stores da edição) — a fila só ajusta
 * horário, nunca impede publicar.
 */
export async function loadWorkerQueueForGrid(
  workerUrl: string,
  workerToken: string,
  fetchFn: typeof fetch,
  warn: (m: string) => void,
  opts: {
    timeoutMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): Promise<unknown | undefined> {
  if (!workerUrl || !workerToken) {
    warn("grade #10819 sem a fila do Worker (DIARIA_LINKEDIN_CRON_URL/_TOKEN ausente) — posts agendados fora dos stores da edição não entram");
    return undefined;
  }
  const url = workerUrl.replace(/\/+$/, "") + "/list";
  const timeoutMs = opts.timeoutMs ?? WORKER_QUEUE_LIST_TIMEOUT_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const controller = new AbortController();
  // A corrida contra o timer garante o teto mesmo com um fetch que ignore o
  // `signal`; o abort libera o socket quando o fetch o respeita.
  let timer: unknown;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimer(() => {
      controller.abort();
      reject(new Error(`timeout de ${timeoutMs} ms no GET /list`));
    }, timeoutMs);
  });
  try {
    const json = await Promise.race([
      (async () => {
        const res = await fetchFn(url, { headers: { "X-Diaria-Token": workerToken }, signal: controller.signal });
        if (!res.ok) {
          // #9991: corpo descartado precisa ser cancelado, senão o socket segura o exit.
          await res.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${res.status}`);
        }
        return (await res.json()) as unknown;
      })(),
      timedOut,
    ]);
    if (!Array.isArray((json as { items?: unknown })?.items)) throw new Error("resposta sem items");
    return json;
  } catch (e) {
    warn(`grade #10819 sem a fila do Worker (${(e as Error).message}) — posts agendados fora dos stores da edição não entram`);
    return undefined;
  } finally {
    clearTimer(timer);
    timedOut.catch(() => {});
  }
}

/**
 * `--mark DESTINO=URL`: só destinos guiados (+ `instagram`, #10893, e
 * `linkedin_profile`, #10772, depois de conferir um envio ambíguo), só URL
 * http(s). O X aceita também `x=buffer:{id}` (#10772): o post agendado na
 * Buffer ainda não tem URL.
 */
export function parseMarkArg(raw: string): { destination: string; url: string | null; bufferId?: string } {
  // #11515: o TikTok também sai pela Buffer (`tiktok=buffer:{id}`).
  const buf = raw.match(/^([a-z_]+)=buffer:([A-Za-z0-9_-]+)$/);
  if (buf && BUFFER_DESTINATIONS.has(buf[1])) return { destination: buf[1], url: null, bufferId: buf[2] };
  const m = raw.match(/^([a-z_]+)=(https?:\/\/\S+)$/);
  if (!m) throw new Error(`--mark espera DESTINO=URL (http/https), recebido ${JSON.stringify(raw)}`);
  if (!MARKABLE_DESTINATIONS.has(m[1])) {
    throw new Error(`--mark só registra destinos guiados (${[...MARKABLE_DESTINATIONS].join(", ")}); "${m[1]}" é publicado pelo script`);
  }
  return { destination: m[1], url: m[2] };
}

/**
 * Entrada que o `--mark` grava (#10772 F6). `x=buffer:{id}` vira `scheduled`
 * com o `--scheduled-at` (ISO) — sem ele, `scheduled_at` null (estado
 * `unknown` até conferir). Os demais viram `published` com a URL.
 */
export function buildMarkEntry(
  mark: ReturnType<typeof parseMarkArg>,
  scheduledAt: string | undefined,
  at: string,
  /**
   * #11547: `thumbnailOffset` (ms) que a skill passou no `create_post` da
   * Buffer (`--thumbnail-offset`). O `--mark` só registra, não confere a Buffer.
   */
  bufferThumbnailOffset: number | null = null,
): { ok: true; entry: ShortPublishedEntry } | { ok: false; error: string } {
  if (scheduledAt !== undefined && (!mark.bufferId || Number.isNaN(Date.parse(scheduledAt)))) {
    return { ok: false, error: "--scheduled-at só vale com --mark x=buffer:{id} (ou tiktok=buffer:{id}) e precisa ser ISO 8601" };
  }
  if (mark.bufferId) {
    return {
      ok: true,
      entry: withCoverRecord(
        { destination: mark.destination, status: "scheduled", id: `buffer:${mark.bufferId}`, scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null, at },
        bufferThumbnailOffset === null ? null : { method: "thumbnail_offset", ok: true, offset_ms: bufferThumbnailOffset },
      ),
    };
  }
  return { ok: true, entry: { destination: mark.destination, status: "published", id: mark.url!, url: mark.url!, at } };
}

/**
 * Pure (#11547): `--thumbnail-offset MS` do `--mark x=buffer:{id}` — inteiro
 * ≥ 0, só com `x=buffer`. Ausente = nenhuma capa registrada.
 */
export function parseThumbnailOffsetArg(raw: string | undefined, isBufferMark: boolean): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: null };
  if (!isBufferMark) return { ok: false, error: "--thumbnail-offset só vale com --mark x=buffer:{id} (ou tiktok=buffer:{id})" };
  if (!/^\d+$/.test(raw)) return { ok: false, error: `--thumbnail-offset espera milissegundos (inteiro ≥ 0), recebido ${JSON.stringify(raw)}` };
  return { ok: true, value: Number(raw) };
}

/** O que o `--publish` devolve pro destino do X (#10772): a URL pública do vertical pra Buffer, ou o erro. */
export interface BufferPrepResult {
  destination: string;
  ok: boolean;
  error?: string;
  buffer?: BufferPostInput;
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

/** #11795: I/O do `--update-scheduled`, injetável nos testes. */
export interface UpdateScheduledDeps {
  youtube: (videoId: string, input: { title: string; description: string; thumbnail: Buffer | null }) => Promise<{ thumbnail: { attempted: boolean; ok: boolean; error: string | null } }>;
  facebook: (slug: string, videoId: string, description: string, cover: Buffer | null) => Promise<{ cover: ShortCoverRecord | null }>;
  persist: (entry: ShortPublishedEntry) => void;
  now: () => Date;
}

export interface UpdateScheduledResult {
  destination: string;
  ok: boolean;
  error?: string;
  warnings?: string[];
  /** Buffer (X/TikTok): o que a skill passa pro `edit_post` (nada foi alterado pelo script). */
  buffer?: { bufferId: string; text: string; tiktokTitle?: string };
}

/**
 * #11795: aplica o plano do `--update-scheduled`. YouTube e Facebook trocam
 * pela API e gravam `updated_at` (e a capa nova) no registro; Buffer só volta
 * em `results[].buffer` para a skill. Falha de um destino não para os outros.
 */
export async function executeScheduledUpdates(
  items: readonly ScheduledUpdateItem[],
  entries: readonly ShortPublishedEntry[],
  cover: Buffer | null,
  deps: UpdateScheduledDeps,
): Promise<UpdateScheduledResult[]> {
  const results: UpdateScheduledResult[] = [];
  for (const item of items) {
    if (item.action === "skip") continue;
    if (item.action === "buffer_edit") {
      results.push({ destination: item.destination, ok: true, buffer: { bufferId: item.bufferId, text: item.text, ...(item.tiktokTitle ? { tiktokTitle: item.tiktokTitle } : {}) } });
      continue;
    }
    const entry = entries.find((e) => e.destination === item.destination);
    if (!entry) continue; // o plano sai das entradas: inalcançável
    try {
      let coverRecord: ShortCoverRecord | null = null;
      if (item.action === "update_youtube") {
        const r = await deps.youtube(item.videoId, { title: item.title, description: item.description, thumbnail: item.cover ? cover : null });
        if (r.thumbnail.attempted) coverRecord = r.thumbnail.ok ? { method: "thumbnails_set", ok: true } : { method: "thumbnails_set", ok: false, error: r.thumbnail.error ?? "sem detalhe" };
      } else {
        coverRecord = (await deps.facebook(item.slug, item.videoId, item.description, item.cover ? cover : null)).cover;
      }
      const warnings = coverRecord && !coverRecord.ok ? [`capa não trocada (${coverRecord.error}) — o texto foi trocado`] : [];
      try {
        deps.persist({ ...withCoverRecord(entry, coverRecord), updated_at: deps.now().toISOString() });
      } catch (e) {
        warnings.push(`texto trocado, mas o registro não gravou o updated_at: ${(e as Error).message}`);
      }
      results.push({ destination: item.destination, ok: true, ...(warnings.length ? { warnings } : {}) });
    } catch (e) {
      results.push({ destination: item.destination, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/**
 * #10772 F1 (em runtime): o plano oferece o repost da página contando com o
 * vídeo do perfil desta rodada; se o `--publish` falhar no perfil (sem nada
 * registrado), o repost vira `skip_invalid` em vez de passo guiado de um vídeo
 * que não existe.
 */
export function blockRepostOnProfileFailure(
  items: ShortsPlanItem[],
  results: Array<{ destination: string; ok: boolean; entry?: { status?: string } | unknown; error?: string }>,
): ShortsPlanItem[] {
  const profile = results.filter((r) => r.destination === "linkedin_profile");
  const failed = profile.some((r) => !r.ok && !r.entry);
  // #10907: envio ambíguo nesta mesma rodada — o vídeo pode não existir.
  const unknown = profile.some((r) => (r.entry as { status?: string } | undefined)?.status === "send_unknown");
  if (!failed && !unknown) return items;
  const detail = unknown
    ? `${PROFILE_SEND_UNKNOWN_BLOCKER} — repost só depois disso`
    : "o vídeo do perfil (linkedin_profile) falhou nesta rodada — repost só depois que ele sair (ou for registrado com --mark linkedin_profile=URL)";
  return items.map((i) =>
    i.destination === "linkedin_page_repost" && i.action === "guided"
      ? { destination: i.destination, mode: "guided", action: "skip_invalid", detail }
      : i,
  );
}

/** Link da edição: --edition-url > `_internal/05-edition-url.txt` > (derivado, no plano). */
export function resolveEditionUrlInput(dir: string, flag: string | undefined): { url?: string; source?: string } {
  if (flag) return { url: flag, source: "--edition-url" };
  const p = join(dir, "_internal", "05-edition-url.txt");
  if (existsSync(p)) {
    const url = readFileSync(p, "utf8").trim();
    if (/^https?:\/\//.test(url)) return { url, source: "_internal/05-edition-url.txt" };
  }
  return {};
}

const USAGE =
  "uso: publish-shorts.ts AAMMDD [--publish --confirm-publish AAMMDD] [--only dest1,dest2] [--now] [--video PATH | --from-drive FILE_ID]\n" +
  "                       [--linkedin-timer | --instagram-timer | --threads-timer] [--force-youtube] [--keep-video]\n" +
  "                       [--edition-dir DIR] [--edition-url URL] [--edition AAMMDD]\n" +
  "     publish-shorts.ts AAMMDD --mark youtube_shorts=URL | facebook_profile=URL | linkedin_page_repost=URL | linkedin_profile=URL | threads_profile=URL\n" +
  "     publish-shorts.ts AAMMDD --mark x=buffer:ID | tiktok=buffer:ID [--scheduled-at ISO] [--thumbnail-offset MS]\n" +
  "     publish-shorts.ts (AAMMDD | --corte SLUG) --update-scheduled [--only ...] [--publish --confirm-publish AAMMDD]\n" +
  "                                                                                 # troca texto e capa dos posts JÁ AGENDADOS (YouTube, Facebook; Buffer via skill), #11795\n" +
  "     publish-shorts.ts AAMMDD --confirm-instagram [--since ISO] [--media-id ID]   # registra o Reels postado no Chrome/app (lê a API: conta da diar.ia.br, #11794)\n" +
  "     publish-shorts.ts AAMMDD --confirm-instagram --url URL                       # registra pelo permalink do Reel, sem conferir na API (#11390)\n" +
  "     publish-shorts.ts --corte SLUG --date AAMMDD --at HH:MM --title T --hook H (--video PATH | --from-drive ID) [--cover JPG] [--publish] [--only ...] [--now]\n" +
  "                                                                                 # corte avulso fora de edição (#11795): registro em data/cortes/SLUG/, re-execução só com --corte SLUG\n" +
  "                                                                                 # (fora de data/cortes/: o mesmo --edition-dir e --allow-unwatched-dir)\n" +
  "                                                                                 # (o dry-run também grava data/cortes/SLUG/corte.json: registra o corte; --from-drive baixa sempre para essa pasta)\n" +
  "                                                                                 # --edition-dir fora de data/cortes/SLUG/ (corte) ou de data/editions/AAMM/AAMMDD/ (edição) é recusado;\n" +
  "                                                                                 # --allow-unwatched-dir roda mesmo assim, sem alarme de destino faltante (#11911)";

/** Flags booleanas do `publish-shorts.ts` (não levam valor). */
export const SHORTS_BOOLEAN_FLAGS = ["publish", "now", "confirm-instagram", "linkedin-timer", "instagram-timer", "threads-timer", "force-youtube", "keep-video", "update-scheduled", "require-corte-authorization", ALLOW_UNWATCHED_DIR_FLAG] as const;

/**
 * Pure (#10978): `parseArgs` + a edição. O parser genérico lê
 * `--confirm-instagram 261022` como `values["confirm-instagram"] = "261022"`
 * (a data vira valor da flag) e o comando caía no usage. Aqui a data colada
 * numa flag booleana volta a ser a edição, então as duas ordens valem.
 * Valor que não é AAMMDD numa flag booleana, ou duas edições diferentes, é
 * erro de uso (nunca adivinha qual edição gravar).
 */
export function parseShortsCliArgs(argv: string[]):
  | { ok: true; aammdd: string; flags: Set<string>; values: Record<string, string>; positional: string[] }
  | { ok: false; error: string } {
  const { flags, values, positional } = parseArgs(argv);
  const positionalOut = [...positional];
  // Só AAMMDD é posicional: o resto (ex.: um `publish` sem `--`) é erro de uso,
  // nunca candidato a edição ("edição ambígua: 261022, publish" enganava).
  const unknown = positionalOut.find((p) => !/^\d{6}$/.test(p));
  if (unknown !== undefined) return { ok: false, error: `argumento não reconhecido: ${unknown}` };
  for (const f of SHORTS_BOOLEAN_FLAGS) {
    const v = values[f];
    if (v === undefined) continue;
    if (!/^\d{6}$/.test(v)) return { ok: false, error: `--${f} não leva valor (recebeu "${v}")` };
    delete values[f];
    flags.add(f);
    positionalOut.push(v);
  }
  const candidates = [...new Set([values["edition"], ...positionalOut].filter((x): x is string => typeof x === "string"))];
  if (candidates.length > 1) return { ok: false, error: `edição ambígua: ${candidates.join(", ")}` };
  const aammdd = candidates[0];
  // #11795: no corte avulso a data vem de --date (ou do corte.json); o AAMMDD posicional é opcional.
  if (!aammdd && values["corte"] !== undefined) return { ok: true, aammdd: "", flags, values, positional: positionalOut };
  if (!aammdd || !/^\d{6}$/.test(aammdd)) return { ok: false, error: "AAMMDD ausente ou inválido" };
  return { ok: true, aammdd, flags, values, positional: positionalOut };
}

/**
 * #11410: `publishing.shorts.threads_profile_via_timer` no config real; config
 * ilegível = `"unreadable"` (o `--threads-timer` recusa).
 */
function configuredThreadsViaTimer(): boolean | "unreadable" {
  try {
    return loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))).threadsProfileViaTimer;
  } catch {
    return "unreadable";
  }
}

/**
 * Backend do Instagram no config real; config ilegível = `"unreadable"` (#11368:
 * o `--instagram-timer` recusa, inclusive no `--mark`, em vez de pular a regra).
 */
function configuredInstagramBackend(): InstagramBackend | "unreadable" {
  try {
    return loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))).instagramBackend;
  } catch {
    return "unreadable";
  }
}

/** #11795: flags que não valem no corte avulso (timers do 300 e conferência do Instagram são da edição). */
export const CORTE_FORBIDDEN_FLAGS = ["linkedin-timer", "instagram-timer", "threads-timer", "confirm-instagram"] as const;

/** #11912: uma autorização ("pode publicar") do corte que caiu nesta rodada; vai no JSON de saída. */
export interface CorteRevocation {
  at: string;
  destinations: string[];
  reason: string;
  /** `plan`: o `--update-scheduled --publish` pode devolver; `content`: só um `--publish` explícito. */
  reason_kind: CorteRevocationKind;
}

/**
 * #11912: `--require-corte-authorization` (o filho do timer do 300) só vale
 * com `--corte` e `--publish`, sem `--update-scheduled` e sem flag que mude o
 * corte ou grave registro: o filho confere, nunca grava. Puro; `null` = ok.
 */
export function corteRequireAuthArgsError(flags: ReadonlySet<string>, values: Record<string, string | undefined>): string | null {
  if (!flags.has("require-corte-authorization")) return null;
  if (values["corte"] === undefined) return "--require-corte-authorization só vale com --corte";
  const planFlags = ["date", "at", "title", "hook", "video", "from-drive", "cover", "mark"].filter((k) => values[k] !== undefined);
  if (!flags.has("publish") || flags.has("update-scheduled") || planFlags.length) {
    return `--require-corte-authorization só vale com --publish e sem mudar o corte${planFlags.length ? ` (recebeu ${planFlags.map((k) => `--${k}`).join(", ")})` : ""}`;
  }
  return null;
}

/**
 * #11795: prepara a rodada do corte avulso — lê `data/cortes/{slug}/corte.json`,
 * aplica as flags desta rodada, grava a spec se mudou e copia a capa
 * (`--cover`) pra pasta do corte. Lança em spec ilegível ou incompleta.
 *
 * #11912: plano novo (título, gancho, horário, data: queda `plan`; outro
 * `--video`: queda `content`) derruba o "pode publicar" e registra
 * `publish_revoked_*`; cada derrubada vai para `onRevoked` (o `main` põe no
 * JSON da rodada). A conferência do conteúdo contra a impressão digital
 * aprovada só roda quando ESTA rodada trouxe conteúdo (`--cover`, `--video`;
 * o `--from-drive` confere depois do download, no `main`): uma cópia do
 * OneDrive atrasada ou parcial não derruba a autorização (o timer alarma).
 * `readOnly` (o filho do timer, `--require-corte-authorization`): não grava
 * nada e lança se as flags mudariam o corte.
 */
export function prepareCorteRun(input: {
  slug: string;
  dir: string;
  values: Record<string, string>;
  positionalDate: string;
  log: (line: string) => void;
  now?: () => Date;
  onRevoked?: (r: CorteRevocation) => void;
  readOnly?: boolean;
  unwatchedDirWarning?: string;
}): CorteSpec {
  const specPath = join(input.dir, CORTE_SPEC_FILE);
  const existing = existsSync(specPath) ? parseCorteSpec(readFileSync(specPath, "utf8"), specPath) : null;
  const { values } = input;
  if (values["video"] !== undefined && values["from-drive"] !== undefined) {
    throw new Error("--corte: passe --video OU --from-drive, não os dois (o --from-drive baixa sempre para a pasta do corte)");
  }
  if (values["date"] !== undefined && input.positionalDate && values["date"] !== input.positionalDate) {
    throw new Error(`data ambígua: --date ${values["date"]} e AAMMDD ${input.positionalDate}`);
  }
  // #11825: o --from-drive baixa SEMPRE para data/cortes/{slug}/corte-{slug}.mp4, nunca para o `video`
  // já registrado (que pode ser o arquivo original do editor); o caminho fica relativo à pasta do corte.
  const video = values["video"] !== undefined
    ? corteVideoRef(input.dir, resolve(values["video"]))
    : values["from-drive"] !== undefined
      ? corteVideoFileName(input.slug)
      : undefined;
  const merged = mergeCorteSpec(input.slug, existing, {
    date: values["date"] ?? (input.positionalDate || undefined),
    at: values["at"],
    title: values["title"],
    hook: values["hook"],
    video,
  });
  if (!merged.ok) throw new Error(merged.error);
  if (input.readOnly) {
    // #11912: o filho do timer nunca grava (nem o corte, nem autorização, nem derrubada).
    if (!existing) throw new Error(`${specPath} não existe: o filho do timer não registra corte`);
    if (merged.changed.length || values["cover"] !== undefined) throw new Error(`o filho do timer não muda o corte (${[...merged.changed, ...(values["cover"] !== undefined ? ["cover"] : [])].join(", ")})`);
    return existing;
  }
  const coverSrc = values["cover"] !== undefined ? resolve(values["cover"]) : null;
  if (coverSrc !== null && !existsSync(coverSrc)) throw new Error(`--cover: ${coverSrc} não existe`);
  const nowIso = (input.now ?? (() => new Date()))().toISOString();
  // A spec do arquivo (com a autorização) por baixo, o plano desta rodada por cima.
  let spec: CorteSpec = existing ? { ...existing, ...merged.spec } : merged.spec;
  if (existing && merged.changed.length) {
    // Outro `--video` é outro conteúdo: a queda não pode ser devolvida pelo --update-scheduled.
    const kind: CorteRevocationKind = merged.changed.includes("video") ? "content" : "plan";
    spec = revokeCorteAuthorization(spec, nowIso, `o plano do corte mudou (${merged.changed.join(", ")})`, kind, input);
  }
  const warningChanged = input.unwatchedDirWarning !== undefined && spec.unwatched_dir_warning !== input.unwatchedDirWarning;
  if (input.unwatchedDirWarning !== undefined) spec.unwatched_dir_warning = input.unwatchedDirWarning;
  if (merged.changed.length || warningChanged) {
    mkdirSync(input.dir, { recursive: true });
    writeFileAtomic(specPath, JSON.stringify(spec, null, 2) + "\n");
    input.log(`[ok] corte "${input.slug}": ${existing ? `atualizado (${[...merged.changed, ...(warningChanged ? ["unwatched_dir_warning"] : [])].join(", ")})` : "registrado"} em ${specPath}`);
  }
  if (coverSrc !== null) {
    mkdirSync(input.dir, { recursive: true });
    copyFileSync(coverSrc, join(input.dir, SHORT_COVER_FILE));
    input.log(`[ok] corte "${input.slug}": capa copiada para ${join(input.dir, SHORT_COVER_FILE)}`);
  }
  // #11912: só esta rodada trazendo conteúdo (capa, vídeo) confere contra o aprovado.
  if (coverSrc === null && values["video"] === undefined) return spec;
  return syncCorteAuthorizationWithContent(input.dir, nowIso, input);
}

function revokeCorteAuthorization(
  spec: CorteSpec,
  nowIso: string,
  reason: string,
  kind: CorteRevocationKind,
  io: { log: (line: string) => void; onRevoked?: (r: CorteRevocation) => void },
): CorteSpec {
  const r = withoutCortePublishAuthorization(spec, nowIso, kind);
  if (!r.revoked) return spec;
  const how = kind === "plan"
    ? "um novo --publish --confirm-publish, ou o --update-scheduled --publish --confirm-publish do corte"
    : "um novo --publish --confirm-publish (o --update-scheduled não devolve: o vídeo ou a capa mudou)";
  io.log(`[aviso] corte "${spec.slug}": o "pode publicar" caiu (${reason}); os destinos que estavam autorizados (${r.revoked.join(", ")}) só saem pelo timer do 300 depois de ${how}, e o timer alarma (revoked) se o horário chegar antes`);
  io.onRevoked?.({ at: nowIso, destinations: r.revoked, reason, reason_kind: kind });
  return r.spec;
}

/**
 * #11912: confere o vídeo e a capa da pasta do corte contra a impressão
 * digital do "pode publicar". Arquivo diferente (outra `--cover`, outro
 * `--from-drive`) → derruba a autorização (`content`) e grava. Vídeo ou capa
 * aprovada AUSENTE nesta máquina não derruba (cópia do OneDrive atrasada: o
 * timer alarma). Só chamada quando a rodada trouxe conteúdo novo. Devolve a
 * spec atual.
 */
export function syncCorteAuthorizationWithContent(
  dir: string,
  nowIso: string,
  io: { log: (line: string) => void; onRevoked?: (r: CorteRevocation) => void },
): CorteSpec {
  const specPath = join(dir, CORTE_SPEC_FILE);
  const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
  if (!corteAuthorizedDestinations(spec)) {
    // #11923: título e --cover na mesma rodada: a queda `plan` já gravada (antes da cópia da capa)
    // vira `content` quando o arquivo deixa de ser o aprovado — o alarme diz o motivo certo e o
    // --update-scheduled não promete devolver o que não devolve.
    if (spec.publish_revoked_reason_kind !== "plan" || !spec.publish_revoked_content) return spec;
    const prior = corteContentCheck(spec.publish_revoked_content, corteContentFingerprint(dir, spec));
    if (prior.kind !== "changed") return spec;
    const { publish_revoked_content: _approved, ...rest } = spec;
    const next: CorteSpec = { ...rest, publish_revoked_at: nowIso, publish_revoked_reason_kind: "content" };
    io.log(`[aviso] corte "${spec.slug}": ${prior.reason}; a queda do "pode publicar" passa a ser por conteúdo (só um novo --publish --confirm-publish devolve)`);
    writeFileAtomic(specPath, JSON.stringify(next, null, 2) + "\n");
    return next;
  }
  const check = corteContentCheck(spec.publish_confirmed_content, corteContentFingerprint(dir, spec));
  if (check.kind !== "changed") return spec;
  const next = revokeCorteAuthorization(spec, nowIso, check.reason, "content", io);
  writeFileAtomic(specPath, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/**
 * #11912: grava no `corte.json` a autorização do `--publish --confirm-publish`.
 * `main` chama só depois de TODAS as validações que podem abortar a rodada
 * (confirmação, escopo dos timers, plano com o `--only`, vídeo presente) e
 * antes do 1º envio: um `--publish` que sai com exit 2 não deixa o corte
 * autorizado. `onlyRaw` é o `--only` da rodada; `known` são os destinos
 * válidos da config (`knownDestinationIds`) e, sem `--only`, viram a lista
 * gravada (destino ligado depois não herda a autorização). Destino
 * desconhecido lança antes de ler ou gravar qualquer coisa: nome errado no
 * marcador faria o timer ignorar o destino certo. `content` é a impressão
 * digital dos bytes que esta rodada publica (o vídeo já lido e a capa do
 * `readShortCover`); vídeo ausente lança. #11923: `coverUnreadable` (o
 * `unreadable` do `readShortCover`: a capa existe e a leitura falhou) também
 * lança — gravar `cover_sha256: null` faria o timer alarmar `content-changed`
 * falso quando a capa voltasse a ser lida.
 */
export function recordCortePublishAuthorization(
  dir: string,
  onlyRaw: string | undefined,
  known: ReadonlySet<string>,
  content: CorteContentFingerprint,
  nowIso: string,
  log: (line: string) => void,
  coverUnreadable?: string,
): void {
  const only = onlyRaw ? onlyRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const unknown = (only ?? []).filter((d) => !known.has(d));
  if (unknown.length) {
    throw new Error(`"pode publicar" não gravado: --only com destino desconhecido: ${unknown.join(", ")} (válidos: ${[...known].join(", ")})`);
  }
  if (coverUnreadable !== undefined) {
    throw new Error(`"pode publicar" não gravado: a capa do corte existe mas não pôde ser lida (${coverUnreadable}); rode de novo quando o arquivo estiver acessível`);
  }
  const specPath = join(dir, CORTE_SPEC_FILE);
  const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
  if (content.video_sha256 === null) throw new Error(`"pode publicar" não gravado: vídeo do corte ausente (${resolveCorteVideo(dir, spec.video)})`);
  const next = withCortePublishAuthorization(spec, only ?? [...known], content, nowIso);
  if (!next.changed) return;
  writeFileAtomic(specPath, JSON.stringify(next.spec, null, 2) + "\n");
  log(`[ok] corte "${spec.slug}": "pode publicar" gravado em ${specPath} (destinos: ${(corteAuthorizedDestinations(next.spec) ?? []).join(", ")})`);
}

/** #11912: por que o filho do timer recusou; o timer mapeia para o alarme (`interpretCorteTimerOutput`). */
export type CorteAuthorizationRefusal = "revoked" | "content-changed" | "missing-content" | "spec-unreadable" | "replanned";

/**
 * #11912: `--require-corte-authorization` (o filho do timer do 300). Confere,
 * sem gravar nada, que a autorização atual do `corte.json` cobre esta rodada:
 * existe, cobre todo o `--only` (obrigatório) e o vídeo/capa que a rodada
 * publica batem com a impressão digital. `null` = pode publicar.
 */
export function corteRunAuthorizationError(
  spec: CorteSpec,
  only: readonly string[] | null,
  content: CorteContentFingerprint,
): { refused: CorteAuthorizationRefusal; reason: string } | null {
  const authorized = corteAuthorizedDestinations(spec);
  if (!authorized) {
    return { refused: "revoked", reason: `corte "${spec.slug}" sem o "pode publicar" no corte.json${spec.publish_revoked_at ? ` (caiu em ${spec.publish_revoked_at})` : ""}` };
  }
  if (!only || !only.length) return { refused: "revoked", reason: "--require-corte-authorization exige --only (os destinos que o timer vai publicar)" };
  const outside = only.filter((d) => !authorized.includes(d));
  if (outside.length) return { refused: "revoked", reason: `destinos fora do "pode publicar" do corte "${spec.slug}": ${outside.join(", ")} (autorizados: ${authorized.join(", ")})` };
  const check = corteContentCheck(spec.publish_confirmed_content, content);
  if (check.kind === "ok") return null;
  return { refused: check.kind === "missing" ? "missing-content" : "content-changed", reason: `corte "${spec.slug}": ${check.reason}` };
}

/**
 * #11912 (H): o `corte.json` relido logo antes de publicar ainda é o plano
 * com que esta rodada montou título e gancho? Lista os campos que mudaram no
 * meio (outra máquina regravou o corte); vazio = o mesmo plano. Puro.
 */
export function corteRunSpecDrift(fresh: CorteSpec, used: CorteSpec): string[] {
  return (["title", "hook", "date", "hhmm", "video"] as const).filter((k) => fresh[k] !== used[k]);
}

/**
 * Puro: a recusa do filho do timer (`--require-corte-authorization`), com o
 * `corte.json` relido logo antes de publicar (`fresh`) e a spec com que a
 * rodada montou título e gancho (`used`). `null` = pode publicar.
 *
 * #11923: plano que mudou no meio da rodada com o "pode publicar" do plano
 * NOVO já gravado (o editor restaurou enquanto o filho rodava) é `replanned`:
 * nada sai com o plano velho, mas o timer não alarma `revoked` (a próxima
 * execução publica o plano novo). Sem autorização para o plano novo segue
 * `revoked`.
 */
export function corteTimerChildRefusal(
  fresh: CorteSpec,
  used: CorteSpec,
  only: readonly string[] | null,
  content: CorteContentFingerprint,
): { refused: CorteAuthorizationRefusal; reason: string } | null {
  const drift = corteRunSpecDrift(fresh, used);
  const authError = corteRunAuthorizationError(fresh, only, content);
  if (!drift.length) return authError;
  const changed = `o corte.json mudou durante a rodada (${drift.join(", ")}): nada publicado com o plano velho`;
  return authError === null
    ? { refused: "replanned", reason: `${changed}; o plano novo já tem o "pode publicar" e sai na próxima execução do timer` }
    : { refused: "revoked", reason: changed };
}

/**
 * #11912: `--update-scheduled --publish --confirm-publish` do corte. Corrigir
 * título/gancho derruba a autorização (queda `plan`); a confirmação desta
 * rodada é o "pode publicar" do plano novo, então ele volta para os destinos
 * derrubados (`planCorteAuthorizationRestore`: só queda `plan`, só destinos da
 * config, só os do `--only`), desde que o vídeo e a capa nesta máquina sejam
 * os aprovados antes da queda. `main` chama só depois de as atualizações
 * terem dado certo. Nunca lança: o motivo de não restaurar volta no JSON.
 */
export function restoreCorteAuthorizationAfterUpdate(
  dir: string,
  nowIso: string,
  known: ReadonlySet<string>,
  only: readonly string[] | null,
  log: (line: string) => void,
): { restored: true; destinations: string[] } | { restored: false; reason: string } {
  try {
    return restoreCorteAuthorizationAfterUpdateUnsafe(dir, nowIso, known, only, log);
  } catch (e) {
    // #11923: as atualizações já deram certo; uma leitura/escrita falha aqui não pode perder o JSON final.
    return { restored: false, reason: `falha ao regravar o "pode publicar": ${(e as Error).message}` };
  }
}

function restoreCorteAuthorizationAfterUpdateUnsafe(
  dir: string,
  nowIso: string,
  known: ReadonlySet<string>,
  only: readonly string[] | null,
  log: (line: string) => void,
): { restored: true; destinations: string[] } | { restored: false; reason: string } {
  const specPath = join(dir, CORTE_SPEC_FILE);
  const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
  const plan = planCorteAuthorizationRestore(spec, only, known);
  if (!plan.ok) return { restored: false, reason: plan.reason };
  const content = corteContentFingerprint(dir, spec);
  if (content.video_sha256 === null) {
    return { restored: false, reason: `vídeo do corte ausente nesta máquina (${resolveCorteVideo(dir, spec.video)}): rode --publish --confirm-publish onde o vídeo está` };
  }
  const check = corteContentCheck(spec.publish_revoked_content, content);
  if (check.kind !== "ok") return { restored: false, reason: `${check.reason}: dê o "pode publicar" explícito com --publish --confirm-publish` };
  const next = withCortePublishAuthorization(spec, plan.destinations, content, nowIso);
  if (next.changed) writeFileAtomic(specPath, JSON.stringify(next.spec, null, 2) + "\n");
  log(`[ok] corte "${spec.slug}": "pode publicar" regravado com o plano corrigido (destinos: ${plan.destinations.join(", ")})`);
  return { restored: true, destinations: plan.destinations };
}

/**
 * Puro (#11955): os destinos cuja falha no `--update-scheduled` segura a
 * regravação do "pode publicar" do corte. O `youtube_shorts` não entra: a falha
 * dele (escopo do token, vídeo já no ar) tem contorno no YouTube Studio e não
 * muda o que o timer do 300 publica (LinkedIn e Threads pessoais, Instagram);
 * sem isso uma falha só no YouTube deixava os timers parados até um
 * `--publish --confirm-publish` extra.
 */
export function corteRestoreBlockingFailures(results: ReadonlyArray<{ destination: string; ok: boolean }>): string[] {
  return results.filter((r) => !r.ok && r.destination !== "youtube_shorts").map((r) => r.destination);
}

/**
 * #11795: `--update-scheduled` — troca texto e capa dos destinos já
 * AGENDADOS com o título/gancho atuais (D1 da edição, ou `corte.json`) e a capa
 * da pasta. Sem `--publish`, só o plano; com ele (e `--confirm-publish`,
 * checado em `main`), aplica no YouTube e no Facebook e devolve o `edit_post`
 * da Buffer pra skill.
 */
async function runUpdateScheduled(input: {
  dir: string;
  aammdd: string;
  corte: CorteSpec | null;
  publish: boolean;
  only: string[] | null;
  published: ShortsPublishedFile;
  persist: (entry: ShortPublishedEntry) => ShortsPublishedFile;
  /** #11912: autorizações do corte que caíram nesta rodada (vão no JSON). */
  corteRevocations?: readonly CorteRevocation[];
}): Promise<number> {
  const { dir, aammdd, corte } = input;
  const revokedOut = input.corteRevocations?.length ? { corte_authorization_revoked: input.corteRevocations } : {};
  let d1: { title: string; body: string } | undefined;
  if (corte) {
    d1 = corteTextInput(corte);
  } else {
    const reviewedPath = join(dir, "02-reviewed.md");
    if (!existsSync(reviewedPath)) {
      console.error(`publish-shorts: ${reviewedPath} não existe`);
      return 1;
    }
    d1 = parseDestaques(readFileSync(reviewedPath, "utf8")).find((d) => d.n === 1);
    if (!d1) {
      console.error("publish-shorts: 02-reviewed.md sem DESTAQUE 1");
      return 1;
    }
  }
  const cover = readShortCover(dir, (l) => console.error(l));
  let items: ScheduledUpdateItem[];
  let known: Set<string>;
  try {
    known = knownDestinationIds(loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))));
    items = planScheduledUpdates({ entries: input.published.entries, d1, now: new Date(), coverPresent: cover.bytes !== null, only: input.only, known });
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  for (const i of items) if (i.action === "skip") console.error(`[aviso] ${i.destination}: ${i.reason}`);
  if (!input.publish) {
    // #11912: o plano avisa o que o --publish desta rodada faria com o "pode publicar" do corte.
    let restorePreview: ReturnType<typeof planCorteAuthorizationRestore> | null = null;
    if (corte) {
      const specPath = join(dir, CORTE_SPEC_FILE);
      restorePreview = planCorteAuthorizationRestore(parseCorteSpec(readFileSync(specPath, "utf8"), specPath), input.only, known);
      if (restorePreview.ok) {
        console.error(`[aviso] corte "${corte.slug}": o --publish --confirm-publish desta rodada regravaria o "pode publicar" de ${restorePreview.destinations.join(", ")} (se todas as atualizações derem certo e o vídeo e a capa forem os aprovados): o timer do 300 volta a publicá-los`);
      }
    }
    console.log(JSON.stringify({ dry_run: true, update_scheduled: true, aammdd, items, ...revokedOut, ...(restorePreview ? { corte_authorization_restore_preview: restorePreview } : {}) }, null, 2));
    return 0;
  }
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config);
  const results = await executeScheduledUpdates(items, input.published.entries, cover.bytes, {
    youtube: (videoId, u) => {
      const missing = missingYouTubeCredentials(process.env);
      if (missing.length) throw new Error(`faltam ${missing.join(", ")} no ambiente (rode scripts/youtube-oauth-setup.ts)`);
      return updateScheduledVideo(defaultYouTubeUploadDeps, {
        clientId: (process.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (process.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (process.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      }, videoId, u);
    },
    facebook: async (slug, videoId, description, coverBytes) => {
      const page = pages.find((p) => p.slug === slug);
      if (!page || page.missing.length) throw new Error(`página ${slug} sem credencial (${page ? page.missing.join(", ") : "fora de publishing.social.facebook.pages"})`);
      return updateFacebookScheduledVideo(defaultGraphDeps, page, apiVersion, videoId, description, coverBytes);
    },
    persist: (entry) => {
      input.persist(entry);
    },
    now: () => new Date(),
  });
  for (const r of results) {
    if (r.buffer) console.error(`[ok] ${r.destination}: falta o edit_post na Buffer (skill), post ${r.buffer.bufferId}`);
    else console.error(r.ok ? `[ok] ${r.destination}: texto${cover.bytes ? " e capa" : ""} do post agendado trocados` : `[erro] ${r.destination}: ${r.error}`);
    for (const w of r.warnings ?? []) console.error(`[aviso] ${r.destination}: ${w}`);
  }
  // #11912: a confirmação desta rodada é o "pode publicar" do plano corrigido: volta, DEPOIS das
  // atualizações e só se todas deram certo, para os destinos derrubados por mudança de plano (nunca
  // de conteúdo), dentro do --only (senão Instagram/LinkedIn pessoal/Threads do corte nunca saem).
  let corteAuthorization: ReturnType<typeof restoreCorteAuthorizationAfterUpdate> | null = null;
  if (corte) {
    // #11955: falha só no YouTube (escopo do token, Short já no ar) não segura o "pode publicar" dos outros.
    const blocking = corteRestoreBlockingFailures(results);
    corteAuthorization = !blocking.length
      ? restoreCorteAuthorizationAfterUpdate(dir, new Date().toISOString(), known, input.only, (l) => console.error(l))
      : { restored: false, reason: `a atualização de ${blocking.join(", ")} falhou: o "pode publicar" não volta numa rodada parcial` };
    if (!corteAuthorization.restored) console.error(`[aviso] corte "${corte.slug}": "pode publicar" não regravado — ${corteAuthorization.reason}`);
    else if (results.some((r) => !r.ok)) {
      console.error(`[aviso] corte "${corte.slug}": o youtube_shorts não foi atualizado (troque título/descrição no YouTube Studio), mas o "pode publicar" dos outros destinos voltou (#11955)`);
    }
  }
  console.log(JSON.stringify({ dry_run: false, update_scheduled: true, aammdd, items, results, ...revokedOut, ...(corteAuthorization ? { corte_authorization: corteAuthorization } : {}) }, null, 2));
  return results.some((r) => !r.ok) ? 1 : 0;
}

async function main(): Promise<number> {
  const parsed = parseShortsCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`publish-shorts: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const { flags, values } = parsed;
  let aammdd = parsed.aammdd;
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
    // #11547: a confirmação (`x=URL`) mantém o registro da capa do agendamento.
    published = persist(carryOverCover(built.entry, published.entries.find((e) => e.destination === mark.destination)));
    console.log(JSON.stringify({ marked: mark.destination, url: mark.url, ...(mark.bufferId ? { buffer_id: mark.bufferId } : {}) }));
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
  if (values["from-drive"] && !existsSync(videoPath) && shortsVideoTerminal(dir, aammdd,
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
      return 1;
    }
    // #11912: outro arquivo no lugar do vídeo aprovado não herda o "pode publicar".
    if (corte && !requireCorteAuth) corte = syncCorteAuthorizationWithContent(dir, new Date().toISOString(), { log: (l) => console.error(l), onRevoked: (r) => corteRevocations.push(r) });
  }
  const videoExists = existsSync(videoPath);
  // #10893: a duração decide já no plano (dry-run incluso) se o Instagram vai pela API ou vira passo guiado.
  const file = videoExists ? readFileSync(videoPath) : null;
  const duration = file ? mp4DurationSeconds(file) : null;
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
  const igAuthor: InstagramAuthor = wantsInstagram(shortsCfg, onlyList, published)
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
  const workerUrl: string =
    process.env.DIARIA_LINKEDIN_CRON_URL ??
    config?.publishing?.social?.instagram?.cloudflare_worker_url ??
    config?.publishing?.social?.linkedin?.cloudflare_worker_url ??
    "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
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
      published,
      video: { path: videoPath, exists: videoExists, sizeBytes: videoExists ? statSync(videoPath).size : null },
      videoDurationSeconds: duration,
      editionUrl: editionUrlIn.url,
      editionUrlSource: editionUrlIn.source,
      forceNow: flags.has("now"),
      only: onlyList,
      grid: [
        ...loadScheduledGrid(dir, published, shortsCfg.instagramAuthorPage, warnGrid, {
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
  for (const p of plan.premises) console.error(`[premissa] ${p}`);
  for (const w of plan.warnings) console.error(`[aviso] ${w}`);

  if (!flags.has("publish")) {
    console.log(JSON.stringify({ dry_run: true, ...plan, ...revokedOut() }, null, 2));
    return 0;
  }
  if (!file) {
    console.error(`publish-shorts: vídeo curto ausente em ${videoPath}`);
    return 1;
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
  const results: Array<{
    destination: string;
    ok: boolean;
    entry?: ShortPublishedEntry;
    unconfirmed?: boolean;
    warnings?: string[];
    error?: string;
    /** #11157: outro processo registrou o destino durante a rodada; nada foi enviado. */
    alreadyRegistered?: boolean;
    /** #11265: como a conferência do timer achou o Reels já no ar (`time-window` pede conferir o permalink). */
    matchedBy?: InstagramTimerAlreadyMatch;
    /** #10772: o que a skill passa pra Buffer `create_post` (nada é registrado até o `--mark`). */
    buffer?: BufferPostInput;
    /** #11265: a falha veio da conferência da conta do timer (`instagramTimerGate`), não do publish. */
    cause?: "preflight";
    preflight?: InstagramTimerGateFailure | ThreadsTimerGateFailure;
  }> = [];
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
  const uploadVideo = () => uploadVideoAt(corte ? corteR2Key(corte.slug, "video") : `shorts/${shortVideoFileName(aammdd)}`);
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
  for (const item of plan.items) {
    if (corteLockBusy && corteLockDests.includes(item.destination)) {
      results.push({ destination: item.destination, ok: false, error: corteLockBusy });
      console.error(`[erro] ${item.destination}: ${corteLockBusy}`);
      continue;
    }
    if (item.action === "buffer" || item.action === "publish" || item.action === "enqueue") {
      // #11157: reconfere no disco antes de publicar — outro escritor pode ter
      // registrado o destino depois da leitura do início da rodada.
      const recheck = recheckBeforePublish(dir, aammdd, item.destination);
      if (recheck.kind === "unreadable") {
        results.push({ destination: item.destination, ok: false, error: recheck.error });
        console.error(`[erro] ${item.destination}: ${recheck.error}`);
        continue;
      }
      if (recheck.kind === "already") {
        const already = recheck.entry;
        published = recheck.fresh;
        results.push({ destination: item.destination, ok: true, entry: already, alreadyRegistered: true });
        console.error(`[aviso] ${item.destination}: registrado por outro processo durante esta rodada (${already.status}${already.url ? `, ${already.url}` : ""}) — não publica de novo`);
        continue;
      }
    }
    if (item.action === "buffer") {
      // #10772: só sobe o vídeo; a Buffer é chamada pela skill (MCP), que registra com --mark.
      const r = await prepareBufferItem(item, uploadVideo, bufferOffsetMs);
      results.push(r);
      console.error(r.ok ? `[ok] ${item.destination}: vídeo no R2 (${r.buffer!.videoUrl}) — falta o create_post na Buffer (skill)` : `[erro] ${item.destination}: ${r.error}`);
      continue;
    }
    if (item.action !== "publish" && item.action !== "enqueue") continue;
    // #11741 (finding P2 da PR #11827): marca "envio em curso" ANTES de publicar.
    // O registro só recebe o destino depois do aceite; sem a marca, a releitura
    // logo após uma interrupção (processo ainda vivo) sairia `nothing-since`.
    // A marca só fica quando o processo morre no meio ou o aceite não foi registrado.
    try {
      markShortSending(dir, aammdd, writer, { destination: item.destination, started_at: new Date().toISOString(), pid: process.pid });
    } catch (e) {
      const msg = `marcador de envio não gravado (${(e as Error).message}) — não publica sem ele`;
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
      if (item.action === "enqueue") {
        outcome = await enqueueInstagramReel(
          {
            uploadVideo,
            uploadCover,
            enqueue: (payload) => postToWorkerQueue(workerUrl, workerToken, payload, 2, "publish-shorts"),
            now: () => new Date(),
          },
          item,
          shortsCfg.instagramCollaborators,
        );
      } else if (item.destination === "linkedin_profile") {
        if (!liCreds.ok) throw new Error(liCreds.reason); // o plano não marca publish sem credencial
        outcome = await publishLinkedInProfileVideo(
          { fetchFn: (u, i) => fetch(u, i), sleep: deps.sleep, log: deps.log, now: deps.now },
          liCreds.creds,
          liApiVersion,
          file,
          item.caption,
          item.title ?? plan.youtube.title,
          shortCover.bytes,
        );
      } else if (item.destination === "youtube_shorts") {
        outcome = await publishYouTubeShort({
          deps: defaultYouTubeUploadDeps,
          env: process.env,
          aammdd,
          title: item.title ?? plan.youtube.title,
          description: item.caption,
          scheduledAt: item.scheduledAt,
          file,
          cover: shortCover.bytes,
          force: flags.has("force-youtube"),
          matchTitleOnly: corte !== null,
          // Grava send_unknown antes do PUT: um processo morto no upload não duplica o Short.
          onBeforeBytes: (marker) => {
            published = persist(marker);
          },
        });
      } else if (item.destination === THREADS_PROFILE_DESTINATION) {
        if (!threadsCreds.ready) throw new Error(threadsCreds.reason); // o plano não marca publish sem credencial
        {
          // #11410: confere o perfil antes — um post à mão (depois de um
          // skip_late) ou de uma rodada sem registro sincronizado não está no
          // registro, mas está no perfil. Falha de leitura nunca vira "não está lá".
          // #11742: em TODA rodada, não só na do timer: a task one-shot do app
          // desktop com o config defasado corria com o timer do 300 no mesmo minuto.
          const pre = await threadsProfilePreflight({
            creds: threadsCreds.creds,
            ...threadsProfilePreflightInput({
              aammdd,
              // 1ª linha do texto = o título do D1 (ou do corte) como o post o leva (cortado com … se não coube).
              caption: item.caption,
              corte: corte !== null,
              sameDayOtherIds: sameDayOtherRegisteredIds(corte?.slug ?? null, aammdd, THREADS_PROFILE_DESTINATION),
            }),
            now: () => new Date(),
          });
          if (pre.kind === "already") {
            try {
              published = persist(pre.entry);
            } catch (e) {
              results.push({ destination: item.destination, ok: false, entry: pre.entry, error: `registro não gravado: ${(e as Error).message}`, cause: "preflight" });
              console.error(`[erro] threads_profile: o vídeo JÁ ESTÁ no perfil (${pre.entry.url ?? pre.entry.id}) mas o registro não foi gravado: ${(e as Error).message}`);
              continue; // marca de envio fica: o vídeo está no perfil e o registro não diz
            }
            clearSending();
            results.push({ destination: item.destination, ok: true, entry: pre.entry, alreadyRegistered: true });
            console.error(`[aviso] threads_profile: o vídeo da edição já está no perfil (${pre.entry.url ?? pre.entry.id}) — registrado, não publica de novo`);
            continue;
          }
        }
        outcome = await publishThreadsProfileVideo({
          creds: threadsCreds.creds,
          videoUrl: await uploadVideo(),
          text: item.caption,
          deps: { now: () => new Date() },
        });
      } else if (item.destination === "instagram") {
        if (!igAuthor.ready) throw new Error(igAuthor.reason); // o plano não marca publish sem autora pronta
        const author = igAuthor;
        const publishReel = async (
          accountGate?: () => ReturnType<typeof instagramTimerGate>,
          onRecheckAlready?: (hit: { entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch }) => void, // #11870
        ) => {
          const choice = instagramReelRouteChoice({
            authorPage: shortsCfg.instagramAuthorPage,
            aammdd,
            videoPath,
            file,
            ...(corte ? { corteVideoKey: corteR2Key(corte.slug, "video") } : {}),
          });
          const { source, cover } = await resolveInstagramReelInputs({
            route: choice.route,
            file,
            uploadCover,
            uploadVideo: async () => {
              if (choice.route !== "video_url") throw new Error("a rota rupload não usa o R2");
              return instagramReelVideoUrl(choice, {
                urlIfSameContent: async (key) => {
                  if (!r2.ready) return null;
                  const same = await r2ObjectHasBody({ fetch: (u, i) => fetch(u, i), now: () => new Date() }, r2.config, key, file);
                  if (same) {
                    r2KeysInUse.add(key); // #11774: o reaproveitado também fica fora da poda
                    console.error(`[ok] corte do Instagram igual ao vertical genérico: reaproveita ${key}`);
                  }
                  return same ? r2PublicUrl(r2.config, key) : null;
                },
                upload: uploadVideoAt,
              });
            },
          });
          const localRecheck = instagramPublishRecheck(dir, aammdd, (fresh) => {
            published = fresh;
          });
          const beforePublish = accountGate ? instagramTimerBeforePublish({ local: localRecheck, gate: accountGate, onAlready: onRecheckAlready }) : localRecheck;
          return publishInstagramReel(deps, author.igUserId, author.token, igApiVersion, source, item.caption, shortsCfg.instagramCollaborators, cover, { beforePublish });
        };
        if (instagramAccountGateApplies(writer, corte !== null)) {
          // #11265: o timer confere a conta antes — um Share feito por fora sem
          // --confirm-instagram não está no registro, mas está no /media.
          // #11795: o corte avulso também (o Reels do corte postado à mão), com o
          // título e o gancho do corte e sem contar o Reels da edição do dia.
          const ctx = corte ? corteInstagramConfirmContext(corte) : instagramConfirmContext(dir, aammdd, config, values["edition-url"]);
          // #11913: na edição, o Reels dos cortes do dia (a extra) também não conta.
          const ignoreIds = sameDayOtherRegisteredIds(corte?.slug ?? null, aammdd, "instagram");
          // Fix do review do PR #11395: o gate olha também o perfil do autor à mão, se for outra conta (#11794: na produção, é a mesma).
          const chrome = await resolveChromeAuthorReader(shortsCfg.instagramAuthorPage, pages, igApiVersion);
          // #11421: sem a credencial da página do autor, o gate não publica (fail-closed) se a conta da API não tiver o Reels.
          // #11427: leitura que falhou com a credencial presente vira `read-failed` (nova tentativa), não `author-unchecked`.
          if (!chrome.reader && !chrome.sameAccount) console.error(`[aviso] instagram: perfil do @${INSTAGRAM_CHROME_ROUTE.authorUsername} não consultável (${chrome.unavailable ?? "sem motivo"})${chrome.readFailed ? " — leitura falhou; o timer não publica pela API sem conferir e tenta de novo na próxima rodada" : " — o timer não publica pela API sem conferir"}`);
          const readFor = (igUserId: string, token: string) => () =>
            readAndDecideInstagramConfirm(defaultGraphDeps, {
              igUserId,
              token,
              apiVersion: igApiVersion,
              published,
              sinceIso: ctx.sinceIso,
              markers: ctx.markers,
              nowIso: new Date().toISOString(),
              expectedAtIso: ctx.expectedAtIso,
              ignoreIds,
            });
          // #11828: em qual conta o gate achou o Reels (e com que token reler os collabs).
          let foundIn: { account: "primary" | "chrome-author"; token: string } = { account: "primary", token: author.token };
          const tagged = (account: "primary" | "chrome-author", token: string, read: () => Promise<InstagramConfirmDecision>) => async () => {
            const d = await read();
            if (d.kind === "register") foundIn = { account, token };
            return d;
          };
          const accountGate = () =>
            instagramTimerGate({
              decide: () =>
                decideInstagramTimerAcrossAccounts({
                  primary: tagged("primary", author.token, readFor(author.igUserId, author.token)),
                  ...timerChromeAuthorDeps(chrome, (igUserId, token) => tagged("chrome-author", token, readFor(igUserId, token))),
                }),
              persist: (entry) => {
                published = persist(entry);
              },
              ...(corte ? { registerHint: () => `${corteBaseCommand(corte.slug, corteOutside?.dir)} --mark instagram=URL` } : {}),
            });
          // #11870: o gate re-rodado antes do media_publish também pode achar o Reels; guarda o matchedBy dele.
          const recheck: { hit: { entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch } | null } = { hit: null };
          const step = await instagramTimerPublishStep({
            gate: accountGate,
            // #11774: o mesmo gate roda de novo logo antes do media_publish.
            publish: () =>
              publishReel(accountGate, (hit) => {
                recheck.hit = hit;
              }),
          });
          const already =
            step.kind === "already"
              ? { entry: step.entry, matchedBy: step.matchedBy, when: "" }
              : step.outcome.alreadyRegistered && recheck.hit
                ? { entry: recheck.hit.entry, matchedBy: recheck.hit.matchedBy, when: " na reconferência antes do publish" }
                : null;
          if (already) {
            clearSending();
            // #11828/#11870: o Reels feito à mão pode ter saído sem o convite da @vjpixel; avisa sem bloquear o registro.
            const collabWarnings = await instagramTimerAlreadyCollabWarnings(deps, {
              matchedBy: already.matchedBy,
              mediaId: already.entry.id,
              token: foundIn.token,
              apiVersion: igApiVersion,
              expected: instagramConfirmExpectedCollabs({ account: foundIn.account, sameAccount: chrome.sameAccount === true, configCollaborators: shortsCfg.instagramCollaborators }),
            });
            results.push({ destination: item.destination, ok: true, entry: already.entry, alreadyRegistered: true, matchedBy: already.matchedBy, ...(collabWarnings.length ? { warnings: collabWarnings } : {}) });
            console.error(`[aviso] instagram: o Reels da edição já está na conta${already.when} (${already.matchedBy}, ${already.entry.url ?? already.entry.id}) — registrado, não publica de novo`);
            for (const w of collabWarnings) console.error(`[aviso] instagram: ${w}`);
            continue;
          }
          if (step.kind !== "published") { clearSending(); continue; } // inalcançável: `already` acima cobre esse caso
          outcome = step.outcome;
        } else {
          outcome = await publishReel(); // sem gate da conta fora do timer e do corte (o registro local segue valendo)
        }
      } else {
        const page = pages.find((p) => facebookDestinationId(p.slug) === item.destination)!;
        outcome = await publishFacebookReel(deps, page, apiVersion, file, item.caption, item.scheduledAt, shortCover.bytes);
      }
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
        results.push({ destination: item.destination, ok: false, error: msg });
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
    const entry = withMissingCoverRecord(outcome.entry, shortCover.path !== null); // #11660
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
  }
  releaseCorteLock();
  const finalItems = blockRepostOnProfileFailure(plan.items, results);
  if (finalItems !== plan.items) {
    console.error("[aviso] linkedin_page_repost: o vídeo do perfil falhou ou ficou em send_unknown nesta rodada — repost não oferecido");
    plan = { ...plan, items: finalItems };
  }
  // #10915: Instagram acima do teto vira passo guiado no Chrome. A compressão
  // só alimenta esse passo, então roda DEPOIS das APIs: um encode lento ou
  // travado nunca atrasa os Reels/vídeos que saem por API.
  if (duration !== null && plan.items.some((i) => i.destination === "instagram" && i.action === "guided")) {
    const upload = prepareInstagramChromeUpload(defaultChromeUploadDeps, {
      source: videoPath,
      output: join(dir, "_internal", chromeUploadFileName(aammdd)),
      durationSeconds: duration,
    });
    const attached = attachChromeUploadToPlan(plan.items, upload, { path: videoPath, sizeBytes: file.length });
    plan = { ...plan, items: attached.items, warnings: [...plan.warnings, ...attached.warnings] };
    if (upload.ok) {
      const fits = fitsChromeUpload(upload.sizeBytes);
      console.error(
        `${fits ? "[ok]" : "[aviso]"} instagram: arquivo pro Chrome ${upload.reused ? "reaproveitado" : "gerado"} (${(upload.sizeBytes / 1e6).toFixed(1)} MB` +
          `${fits ? "" : `, acima dos ${CHROME_UPLOAD_MAX_BYTES / 1e6} MB do file_upload`}) → ${upload.path}`,
      );
    }
    for (const w of attached.warnings) console.error(`[aviso] ${w}`);
  }
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

/**
 * Pure (#11410): o que identifica o vertical da edição num post do perfil do
 * Threads — o título do D1 como o texto de `buildShortSocialText` o leva, e o
 * `utm_campaign={AAMMDD}` do link da edição que o texto levava até o #11617
 * (segue como marcador pros posts já no ar).
 * Título com reticências (cortado pra caber) entra sem elas.
 */
export function threadsEditionMarkers(aammdd: string, d1Title: string): string[] {
  const title = stripInlineMarkdown(d1Title).replace(/\s+/g, " ").replace(/…$/, "").trim();
  return [`utm_campaign=${aammdd}`, ...(title ? [title] : [])];
}

/** #11742/#11795: o `utm_campaign={AAMMDD}` é da EDIÇÃO; no corte avulso ele casaria com o vertical da edição do mesmo dia. */
function withoutEditionUtmMarker(markers: string[]): string[] {
  return markers.filter((m) => !m.startsWith("utm_campaign="));
}

/**
 * Pure (#11742): a entrada da conferência do perfil do Threads antes de QUALQUER
 * rodada publicar `threads_profile` — a do timer (`--threads-timer`), a da
 * skill, a task one-shot do app desktop (que com o config em `false` num
 * checkout defasado corria com o timer do 300 no mesmo minuto) e o corte
 * avulso. Marcadores: o título como a 1ª linha do texto o leva (+ o
 * `utm_campaign` só na edição). O vídeo do OUTRO lado do mesmo dia, já
 * registrado (`sameDayOtherIds`), não conta: no corte, o da edição do dia
 * (`editionDayRegisteredIds`); na edição, o dos cortes do dia
 * (`sameDayCorteRegisteredIds`, #11913 — a extra das 06:30 bloqueava a
 * principal das 12:00). Sem isso um lado bloquearia o outro.
 */
export function threadsProfilePreflightInput(input: {
  aammdd: string;
  caption: string;
  corte: boolean;
  sameDayOtherIds: readonly string[];
}): { sinceIso: string; markers: string[]; ignoreIds: string[] } {
  const markers = threadsEditionMarkers(input.aammdd, input.caption.split("\n")[0] ?? "");
  return {
    sinceIso: resolveEditionScheduledAt(input.aammdd, "00:00"),
    markers: input.corte ? withoutEditionUtmMarker(markers) : markers,
    ignoreIds: [...input.sameDayOtherIds],
  };
}

/**
 * Pure (#11795): a conferência da conta do Instagram antes de publicar o Reels
 * (`instagramTimerGate`, #11265) vale na rodada do timer da edição e em TODA
 * rodada do corte avulso (o timer `Diaria-Shorts-Cortes` roda sem
 * `--instagram-timer`, e o `--confirm-instagram` não existe no corte): um Reels
 * do corte postado à mão e não registrado sairia duplicado.
 */
export function instagramAccountGateApplies(writer: ShortsRegistryWriter, corte: boolean): boolean {
  return writer === "instagram-timer" || corte;
}

/**
 * Pure (#11795): marcadores, início da leitura e horário planejado do Reels do
 * corte avulso — o título e o gancho do `corte.json` (nunca o D1 da edição), o
 * dia do corte desde 00:00 BRT e o `--at`. Sem `utm_campaign` nem URL: o
 * vertical não leva link (#11617) e o utm do dia é o da edição.
 */
export function corteInstagramConfirmContext(corte: Pick<CorteSpec, "date" | "hhmm" | "title" | "hook">): { markers: string[]; sinceIso: string; expectedAtIso: string } {
  return {
    markers: withoutEditionUtmMarker(instagramEditionMarkers({ aammdd: corte.date, d1Title: corte.title, d1Body: corte.hook, editionUrl: null })),
    sinceIso: resolveEditionScheduledAt(corte.date, "00:00"),
    expectedAtIso: resolveEditionScheduledAt(corte.date, corte.hhmm),
  };
}

/**
 * #11742/#11795: ids que o registro do vertical da EDIÇÃO do dia já tem para o
 * destino. O corte avulso não os confunde com o próprio post na conferência da
 * conta. Registro ilegível → aviso e lista vazia (a conferência fica mais
 * restritiva, nunca menos).
 */
export function editionDayRegisteredIds(
  editionDir: string,
  aammdd: string,
  destination: string,
  warn: (m: string) => void,
  read: (dir: string, aammdd: string) => ShortsPublishedFile = readShortsRegistry,
): string[] {
  if (!existsSync(editionDir)) return [];
  try {
    return read(editionDir, aammdd)
      .entries.filter((e) => e.destination === destination && typeof e.id === "string" && e.id.length > 0)
      .map((e) => e.id as string);
  } catch (e) {
    warn(`registro do vertical da edição ${aammdd} ilegível (${(e as Error).message}) — a conferência da conta do corte não o desconta`);
    return [];
  }
}

/**
 * #11913: o espelho de `editionDayRegisteredIds` para a rodada da EDIÇÃO — os
 * ids que os cortes avulsos do mesmo dia (`data/cortes/{slug}/`, inclusive a
 * vertical extra, #11898) já registraram para o destino. O post do corte não
 * leva link nem `utm_campaign`, então sem descontá-lo a conferência da edição
 * o lê como "vídeo do dia sem marcador" e bloqueia. Corte com `corte.json` ou
 * registro ilegível → aviso e pula só aquele corte (a conferência fica mais
 * restritiva, nunca menos).
 */
export function sameDayCorteRegisteredIds(
  cortesDir: string,
  aammdd: string,
  destination: string,
  warn: (m: string) => void,
  read: (dir: string, aammdd: string) => ShortsPublishedFile = readShortsRegistry,
  /** #11965: o corte que está publicando (a pasta = slug) não desconta o próprio registro. */
  exceptSlug?: string,
): string[] {
  if (!existsSync(cortesDir)) return [];
  let names: string[];
  try {
    names = readdirSync(cortesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (e) {
    warn(`pasta dos cortes ${cortesDir} ilegível (${(e as Error).message}) — a conferência da edição não desconta os cortes do dia`);
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (exceptSlug !== undefined && name === exceptSlug) continue;
    const dir = join(cortesDir, name);
    const specPath = join(dir, CORTE_SPEC_FILE);
    if (!existsSync(specPath)) continue;
    try {
      const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
      if (spec.date !== aammdd) continue;
      for (const e of read(dir, spec.date).entries) {
        if (e.destination === destination && typeof e.id === "string" && e.id.length > 0) ids.push(e.id);
      }
    } catch (e) {
      warn(`corte ${name} ilegível (${(e as Error).message}) — a conferência da edição ${aammdd} não o desconta`);
    }
  }
  return ids;
}

/**
 * #11742/#11795/#11913/#11965: os ids do mesmo dia que a conferência da conta
 * de UM lado desconta — no corte, os da edição do dia E os dos OUTROS cortes do
 * dia (#11965: o 2º corte do dia era bloqueado pelo vídeo já registrado do 1º);
 * na edição, os dos cortes do dia. `corteSlug` = a rodada é do corte com esse slug.
 */
export function sameDayOtherRegisteredIdsFor(input: {
  corteSlug: string | null;
  aammdd: string;
  destination: string;
  editionDir: string;
  cortesDir: string;
  warn: (m: string) => void;
  read?: (dir: string, aammdd: string) => ShortsPublishedFile;
}): string[] {
  const read = input.read ?? readShortsRegistry;
  const cortes = sameDayCorteRegisteredIds(input.cortesDir, input.aammdd, input.destination, input.warn, read, input.corteSlug ?? undefined);
  if (input.corteSlug === null) return cortes;
  return [...editionDayRegisteredIds(input.editionDir, input.aammdd, input.destination, input.warn, read), ...cortes];
}

function sameDayOtherRegisteredIds(corteSlug: string | null, aammdd: string, destination: string): string[] {
  return sameDayOtherRegisteredIdsFor({
    corteSlug,
    aammdd,
    destination,
    editionDir: editionDirFor(aammdd),
    cortesDir: join(ROOT, CORTES_REL_DIR),
    warn: (m) => console.error(`[aviso] ${m}`),
  });
}

/**
 * Destinos que a rodada pulou por falta de credencial/token do PRÓPRIO destino
 * (#11240), terminais pra limpeza do vertical. O pulo por falta de URL pública
 * (`cause: "public_video"`, X e Threads) NUNCA conta, em nenhum backend
 * (#11478): o R2 está habilitado desde 27/10/2026 (#10772), então esse pulo
 * só quer dizer que ESTA máquina não tem os secrets `R2_*`/`SHORTS_R2_*`
 * (clone novo, sync de env atrasado). Outra máquina com eles ainda publica
 * com o mesmo `-short.mp4`, que por isso não pode ser podado. A regra
 * anterior (terminal com `timer-300` sem R2, #11265) era do tempo em que o
 * R2 não seria habilitado. Puro.
 */
export function credentialSkippedItems(
  items: readonly ShortsPlanItem[],
): Array<{ destination: string; detail: string }> {
  return items.flatMap((i) =>
    i.action === "skip_missing_credentials" && i.cause !== "public_video"
      ? [{ destination: i.destination, detail: i.detail }]
      : [],
  );
}

/**
 * #10978 item 5 / #11265: o que identifica o Reels da edição na conta —
 * marcadores (título e gancho do D1, utm, URL), o corte default (00:00 BRT do
 * dia da edição, o vertical sai no próprio dia, #10831) e o horário planejado
 * do vertical (`resolveShortTime`), base da janela de horário quando a
 * legenda foi editada. Usado pelo `--confirm-instagram` e pela conferência do
 * timer antes de publicar.
 */
function instagramConfirmContext(
  dir: string,
  aammdd: string,
  config: unknown,
  editionUrlFlag: string | undefined,
): { markers: string[]; sinceIso: string; expectedAtIso: string | null; d1Title: string | null } {
  const reviewedPath = join(dir, "02-reviewed.md");
  const d1 = existsSync(reviewedPath) ? (parseDestaques(readFileSync(reviewedPath, "utf8")).find((d) => d.n === 1) ?? null) : null;
  const markers = instagramEditionMarkers({ aammdd, d1Title: d1?.title ?? null, d1Body: d1?.body ?? null, editionUrl: resolveEditionUrlInput(dir, editionUrlFlag).url ?? null });
  let expectedAtIso: string | null = null;
  try {
    expectedAtIso = resolveEditionScheduledAt(aammdd, resolveShortTime(loadShortScheduleConfig(config), aammdd).hhmm);
  } catch {
    expectedAtIso = null; // config de horário inválido: fica só o marcador (a recusa segue segura)
  }
  return { markers, sinceIso: resolveEditionScheduledAt(aammdd, "00:00"), expectedAtIso, d1Title: d1?.title ?? null };
}

/**
 * `--confirm-instagram` (#10915): depois do Share no Chrome (ou no app), acha o
 * Reels pela API (`/{ig-user}/media`, só leitura), grava a entrada `instagram`
 * e avisa se o collab ficou Pending. A confirmação vem da API, nunca da tela,
 * e só vale o Reels com o marcador desta edição na legenda
 * (`decideInstagramConfirm`); ambíguo → recusa e pede `--media-id`.
 */
export async function confirmInstagram(
  aammdd: string,
  dir: string,
  persist: (entry: ShortPublishedEntry) => ShortsPublishedFile,
  published: ShortsPublishedFile,
  sinceFlag: string | undefined,
  mediaIdFlag: string | undefined,
  editionUrlFlag: string | undefined,
  urlFlag?: string,
  /** #11794: I/O injetável para testar o wiring; o default é a Graph real e o config do repo. */
  io: { graph?: GraphDeps; config?: unknown } = {},
): Promise<number> {
  const graph = io.graph ?? defaultGraphDeps;
  const already = instagramAlreadyRegistered(published);
  if (already) {
    const e = already.entry;
    console.log(JSON.stringify({ confirmed: false, already_registered: true, status: e.status, url: e.url ?? e.id ?? null }));
    if (already.exitCode !== 0) {
      console.error(`publish-shorts: o instagram já está registrado como "${e.status}", não "published" — confira na conta antes de relatar; nada foi gravado`);
    }
    return already.exitCode;
  }
  // #11390: o editor colou o permalink do Reel.
  if (urlFlag !== undefined) {
    const built = instagramConfirmUrlEntry(urlFlag, new Date().toISOString());
    if (!built.ok) {
      console.error(`publish-shorts: ${built.error}`);
      return 2;
    }
    persist(built.entry);
    const warning = "registrado pela URL informada, sem conferir na API — confira que é o Reel desta edição";
    console.error(`[aviso] instagram: ${warning}`);
    console.log(JSON.stringify({ confirmed: true, id: built.entry.id, url: built.entry.url, account: "--url", warnings: [warning] }));
    return 0;
  }
  // #10978: --since inválido falha antes de qualquer chamada à API.
  if (sinceFlag !== undefined && Number.isNaN(Date.parse(sinceFlag))) {
    console.error(`publish-shorts: --since inválido: ${sinceFlag}`);
    return 2;
  }
  const config: any = io.config ?? JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config);
  const igApiVersion = process.env.INSTAGRAM_API_VERSION || apiVersion;
  const cfg = loadShortsConfig(config);
  const author = await resolveInstagramAuthor(graph, cfg.instagramAuthorPage, pages, igApiVersion, {
    igUserId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? "",
    token: process.env.INSTAGRAM_ACCESS_TOKEN ?? "",
  });
  if (!author.ready) {
    console.error(`publish-shorts: não deu pra ler a conta do Instagram (${author.reason}) — registre com --mark instagram=URL`);
    return 1;
  }
  const ctx = instagramConfirmContext(dir, aammdd, config, editionUrlFlag);
  if (!ctx.d1Title && !mediaIdFlag) console.error(`[aviso] instagram: sem título do D1 (${join(dir, "02-reviewed.md")}) — o marcador fica só utm_campaign/URL e a janela de horário; se recusar, use --media-id`);
  const readInput = {
    apiVersion: igApiVersion,
    published,
    sinceIso: sinceFlag ?? ctx.sinceIso,
    markers: ctx.markers,
    mediaId: mediaIdFlag ?? null,
    nowIso: new Date().toISOString(),
    expectedAtIso: ctx.expectedAtIso,
  };
  // #11794: o Reels do B3b é postado pela @diar.ia.br com a @vjpixel em collab.
  // Na config de produção ela é a conta da API; outro perfil só com outra autora no config.
  const chrome = await resolveChromeAuthorReader(cfg.instagramAuthorPage, pages, igApiVersion, graph);
  const chromeReader = chrome.reader;
  const across = await decideInstagramConfirmAcrossAccounts({
    primary: () => readAndDecideInstagramConfirm(graph, { ...readInput, igUserId: author.igUserId, token: author.token }),
    ...confirmChromeAuthorDeps(chrome, (igUserId, token) => () => readAndDecideInstagramConfirm(graph, { ...readInput, igUserId, token })),
  });
  const decision = across.decision;
  const reader = across.account === "chrome-author" && chromeReader ? chromeReader : author;
  const who = reader.username ? `@${reader.username}` : across.account === "chrome-author" ? `@${INSTAGRAM_CHROME_ROUTE.authorUsername}` : reader.igUserId;
  if (decision.kind !== "register") {
    // already_registered foi tratado acima; aqui só sobra a recusa.
    const reason = decision.kind === "refuse" ? decision.reason : "já registrado";
    const candidates = decision.kind === "refuse" ? decision.candidates : [];
    console.error(`publish-shorts: ${who}: ${reason}. Nada gravado.`);
    if (across.fallbackNote) console.error(`publish-shorts: ${across.fallbackNote}`);
    for (const c of candidates) console.error(`  candidato: --media-id ${c.id}  ${c.timestamp}  ${c.permalink ?? "(sem permalink)"}${c.matchesEdition ? "  [marcador da edição]" : ""}`);
    console.error(`publish-shorts: com o permalink em mãos, registre com --confirm-instagram --url URL (ou --mark instagram=URL)`);
    console.log(JSON.stringify({ confirmed: false, reason, candidates, ...(across.fallbackNote ? { fallback: across.fallbackNote } : {}) }));
    return 1;
  }
  const entry = decision.entry;
  const warnings: string[] = [];
  if (decision.matchedBy === "time-window") {
    warnings.push(`a legenda não tem o título nem o gancho do D1; registrado pelo único Reels no formato do vertical perto das ${ctx.expectedAtIso} (#10978) — confira o permalink`);
  }
  if (!entry.url) warnings.push(`a mídia ${entry.id} veio sem permalink — o id fica no registro`);
  // #11794: o Reels da autora da rota do Chrome sempre cobra o collab da @vjpixel.
  const expectedCollabs = instagramConfirmExpectedCollabs({ account: across.account, sameAccount: chrome.sameAccount === true, configCollaborators: cfg.instagramCollaborators });
  if (across.account === "chrome-author") {
    warnings.push(`achado no perfil do ${who} (rota do Chrome, #11390): o Reel aparece na @${INSTAGRAM_CHROME_ROUTE.collaboratorUsername} quando o convite de collab for aceito`);
  }
  if (expectedCollabs.length) {
    try {
      const collab = await graphGet(graph, `${entry.id}/collaborators`, { fields: "username,invite_status", access_token: reader.token }, igApiVersion);
      warnings.push(...collabInviteWarnings(collab?.data, expectedCollabs, { reportPending: true }));
    } catch (e) {
      warnings.push(`não deu pra conferir o collab (${(e as Error).message}) — confira no app`);
    }
  }
  persist(entry);
  for (const w of warnings) console.error(`[aviso] instagram: ${w}`);
  console.log(JSON.stringify({ confirmed: true, id: entry.id, url: entry.url ?? null, account: who, warnings }));
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("publish-shorts:", e instanceof Error ? e.message : e) });
}
