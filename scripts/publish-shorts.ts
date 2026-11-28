#!/usr/bin/env node
/**
 * scripts/publish-shorts.ts (#10769)
 *
 * Publica o vídeo CURTO (vertical) da edição — o recorte do "diar.ia.br:
 * notícias de IA" — como Reels nas páginas do Facebook e no Instagram, via Graph
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
 *   npx tsx scripts/publish-shorts.ts AAMMDD --replace-scheduled --video PATH_PROPRIO [--only ...] [--publish --confirm-publish AAMMDD]
 *                                                           # #12279: troca o VÍDEO de post JÁ AGENDADO (V1 por V2) no mesmo
 *                                                           # horário. Sem --publish, o plano (manifesto de substituição). O
 *                                                           # --publish só sai com o grant --replace-scheduled desse plano,
 *                                                           # consumido antes da 1ª exclusão. Procedimento: docs/shorts-replace-scheduled.md.
 *   npx tsx scripts/publish-shorts.ts --corte SLUG --cancel [--confirm SLUG]
 *   npx tsx scripts/publish-shorts.ts --corte SLUG --reschedule --date AAMMDD --at HH:MM [--confirm SLUG]
 *                                                           # #13000: cancela/reagenda o corte JÁ agendado. Sem --confirm,
 *                                                           # só o plano. YouTube (publishAt / private sem agendamento),
 *                                                           # Facebook (scheduled_publish_time / DELETE do agendado, depois
 *                                                           # de reler published=false com 15 min de folga), corte.json
 *                                                           # (date/hhmm, ou o "pode publicar" retirado: o timer do 300 para)
 *                                                           # e registro; X/TikTok voltam como delete_post/edit_post da Buffer.
 *   npx tsx scripts/publish-shorts.ts (AAMMDD | --corte SLUG [--title T] [--hook H]) --update-published [--only ...] [--confirm AAMMDD|SLUG]
 *                                                           # #12936: troca o TEXTO do que JÁ ESTÁ NO AR. Sem --confirm, só o
 *                                                           # plano. YouTube (videos.update relido), Facebook (POST
 *                                                           # /{video-id} relido), LinkedIn pessoal (PARTIAL_UPDATE, sem
 *                                                           # releitura); Instagram e Threads (≤15 min) só pela UI; X e
 *                                                           # TikTok não editam. No corte, título/gancho vão ao corte.json sem
 *                                                           # tocar o "pode publicar" (recusado com destino ainda por sair).
 *                                                           # Já publicado, envio ambíguo ou perto demais do horário: recusado.
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
 *     2 h dos posts da rotação #10305, picos, ≥30 min depois do perfil). Desde
 *     #11121 o `--publish` põe o repost na fila do Worker `diaria-linkedin-cron`
 *     (`action: "repost"`, API direta como página) quando a URN do vídeo do
 *     perfil está no registro; o Worker sem o token da página (#8816) recusa
 *     com `linkedin_creds_missing` e o passo segue guiado no Chrome, com aviso.
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
 * Horário (#10831, #12250): o do vertical, `resolveShortTime(sched, aammdd, destino)`
 * — fixo POR DESTINO (`publishing.shorts.schedule`): YouTube Shorts às 06:30
 * (`by_destination`), os outros destinos às 12:00 (`default_time`); nunca as
 * 06:00 do horizontal (o vídeo relacionado do Short precisa dele já público,
 * #10811). O teste rotativo 06:30/08:00/12:00 (261026 a 261106) foi encerrado
 * no #12250. Com pelo menos 10 min de folga o Facebook
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
 * (`_internal/06-social-published.json` + `06-shorts-published.json`). O horário
 * fixo de cada destino (#12250) nunca é movido: a grade só avisa quando ele
 * cola num post da mesma conta (`slots` no plano, aviso em `warnings`). Antes
 * do #12250, fora do teste do #10831, o `social-slot-planner` escolhia outro
 * horário por destino.
 * O Instagram manual acima do teto (#10893) também reserva slot (#10933): é um
 * post da conta naquele horário, só que feito no app. O Reels do Instagram
 * conta também como post dos collabs (a @diar.ia.br, decisão do editor
 * 261023), e a grade inclui a fila do Worker (`GET /list`, fail-soft): os
 * posts que as skills de divulgação agendaram pro mesmo dia.
 *
 * Link da edição: `--edition-url` > `_internal/05-edition-url.txt` (gravado no
 * Stage 5) > slug derivado do título do D1. O derivado é premissa, não aviso: é
 * a mesma regra com que o Stage 5 grava `05-edition-url.txt` (#7420), então o
 * vertical pode sair antes da Etapa 5 (`--so vertical` ou `--sem-publicacao`; no fluxo padrão do #12591 ele sai depois).
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

// #14054: o código mora em `scripts/publish-shorts/` (um módulo por destino:
// facebook, instagram, linkedin, youtube, buffer, corte, mais o plano, a CLI e
// a execução da rodada em `run.ts`). Esta entrada só carrega o .env, reexporta
// o que os outros scripts importam daqui e roda a CLI. Os testes importam
// direto dos módulos (#14327, trava em test/publish-shorts-test-imports-14327.test.ts).

import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { main } from "./publish-shorts/run.ts";
loadProjectEnv();

export {
  DIARIA_HOME_URL,
  LINKEDIN_TIMER_DETAIL,
  INSTAGRAM_TIMER_DETAIL,
  THREADS_TIMER_DETAIL,
  corteTimerDelegatedDetail,
  publicVideoUnavailableReason,
  publicVideoUnavailableCause,
  GUIDED_DESTINATIONS,
  BUFFER_DESTINATIONS,
  MARKABLE_DESTINATIONS,
  planShortHorizontalLinks,
  shouldUpdateLatestVideoOnPublish,
  missingHorizontalLinkWarning,
  SHORTS_TIMER_TASKS,
  lateNowArgs,
  assignShortsDestinationOwners,
  nonCanonicalEditionDir,
  canonicalShortsEditionDir,
  checkEditionDir,
  ownersContextAfterPublish,
  corteTimerStaleWarning,
  readVerticalCta,
  horizontalRoteiroWarnings,
  verticalBioCtaFromHorizontal,
  readHorizontalVideoForShort,
  readHorizontalUrlForShort,
} from "./publish-shorts/_shared.ts";
export type {
  ShortsPlanItem,
  TikTokBufferMetadata,
  ShortsPlan,
  ShortHorizontalLinkPlan,
  ShortsDestinationOwner,
  ShortsPlanInput,
  InstagramQueueReadiness,
} from "./publish-shorts/_shared.ts";
export {
  planShortsPublish,
  instagramTimerSlot,
} from "./publish-shorts/plan.ts";
export {
  uploadCoverOrFallback,
  reelCoverUrl,
  reelCoverRecord,
  shortsReelsIdempotencyKey,
  resolveInstagramQueueReadiness,
  wantsInstagram,
  INSTAGRAM_PUBLISH_SCOPE,
  resolveInstagramAuthor,
  instagramR2VideoKey,
  instagramReelRouteChoice,
  instagramReelVideoUrl,
  instagramPublishRecheck,
  resolveInstagramReelInputs,
  publishInstagramReel,
  postInstagramReelFirstComment,
  firstCommentErrorIsUncertain,
  checkInstagramCollaborators,
  collabInviteWarnings,
  CHROME_UPLOAD_FFMPEG_TIMEOUT_MS,
  defaultChromeUploadDeps,
  prepareInstagramChromeUpload,
  attachChromeUploadToPlan,
  enqueueInstagramReel,
} from "./publish-shorts/instagram.ts";
export type {
  ReelCoverUpload,
  InstagramAuthor,
  InstagramReelSource,
  InstagramReelRouteChoice,
  ChromeUploadDeps,
  InstagramEnqueueDeps,
} from "./publish-shorts/instagram.ts";
export {
  PROFILE_SEND_UNKNOWN_BLOCKER,
  PROFILE_REPOST_CHAIN_MAX_MS,
  PROFILE_REPOST_CHAIN_STALE_DETAIL,
  corteRepostTimerDetail,
  delegateCorteRepostToTimer,
  isProfileRepostChainStale,
  publishLinkedInProfileVideo,
  blockRepostOnProfileFailure,
  enqueuePageRepostViaWorker,
} from "./publish-shorts/linkedin.ts";
export {
  defaultGraphDeps,
  GRAPH_REQUEST_TIMEOUT_MS,
  GraphResponseError,
  isGraphAuthError,
  FacebookFinishUncertainError,
  uploadFacebookVideoResumable,
  setFacebookVideoThumbnail,
  updateFacebookScheduledVideo,
  updateFacebookPublishedVideoText,
  facebookScheduledMs,
  cancelFacebookScheduledVideo,
  rescheduleFacebookScheduledVideo,
  publishFacebookReel,
  mediaPublishFailureIsDefinitive,
} from "./publish-shorts/facebook.ts";
export type {
  FetchLike,
  GraphDeps,
  PublishOutcome,
} from "./publish-shorts/facebook.ts";
export {
  INSTAGRAM_CONFIRM_MEDIA_LIMIT,
  INSTAGRAM_CONFIRM_MAX_PAGES,
  instagramEditionMarkers,
  INSTAGRAM_HOOK_MARKER_MIN_CHARS,
  INSTAGRAM_CONFIRM_TIME_WINDOW_MS,
  INSTAGRAM_CAPTION_FORMAT_MARKER,
  INSTAGRAM_CAPTION_LEGACY_FORMAT_MARKER,
  captionMatchesEdition,
  instagramAlreadyRegistered,
  decideInstagramConfirm,
  decideInstagramConfirmAcrossAccounts,
  instagramConfirmUrlEntry,
  resolveChromeAuthorReader,
  confirmChromeAuthorDeps,
  instagramConfirmExpectedCollabs,
  timerChromeAuthorDeps,
  decideInstagramTimerAcrossAccounts,
  instagramTimerPreflight,
  InstagramTimerGateError,
  instagramTimerGate,
  instagramTimerPublishStep,
  instagramTimerAlreadyCollabWarnings,
  instagramTimerBeforePublish,
  instagramMediaPagingDone,
  fetchInstagramRecentMedia,
  readAndDecideInstagramConfirm,
} from "./publish-shorts/instagram-confirm.ts";
export type {
  InstagramReelCandidate,
  InstagramConfirmDecision,
  InstagramConfirmAcrossAccounts,
  ChromeAuthorResolution,
  InstagramTimerAlreadyMatch,
  InstagramTimerPreflight,
  InstagramTimerGateFailure,
} from "./publish-shorts/instagram-confirm.ts";
export {
  defaultFirstFrameCoverDeps,
  youtubeShortUploadFile,
  youtubeShortsPrepareBeforeMarker,
  youtubeShortUrl,
  publishYouTubeShort,
} from "./publish-shorts/youtube.ts";
export {
  readShortCover,
  registeredSinceRead,
  corteManualTimerDestinations,
  registerCorteLockCleanup,
  corteTimerLockBusyError,
  recheckBeforePublish,
  loadScheduledGrid,
  loadEditionDayGrid,
  WORKER_QUEUE_LIST_TIMEOUT_MS,
  loadWorkerQueueForGrid,
  parseMarkArg,
  buildMarkEntry,
  parseThumbnailOffsetArg,
  resolveEditionUrlInput,
} from "./publish-shorts/run-checks.ts";
export type {
  PrePublishRecheck,
} from "./publish-shorts/run-checks.ts";
export {
  prepareBufferItem,
  bufferDeletedRefusal,
  bufferReplacementMarkRefusal,
  applyBufferReplacementMark,
} from "./publish-shorts/buffer.ts";
export type {
  BufferPrepResult,
  BufferPostInput,
} from "./publish-shorts/buffer.ts";
export {
  executeScheduledUpdates,
} from "./publish-shorts/update-scheduled.ts";
export type {
  UpdateScheduledDeps,
  UpdateScheduledResult,
} from "./publish-shorts/update-scheduled.ts";
export {
  SHORTS_BOOLEAN_FLAGS,
  REPLACE_SCHEDULED_FORBIDDEN_FLAGS,
  REPLACE_SCHEDULED_FORBIDDEN_VALUES,
  replaceScheduledArgsError,
  SHORTS_REPLACE_LOCK_FILE,
  parseShortsCliArgs,
} from "./publish-shorts/cli.ts";
export {
  buildShortsPlanManifest,
  shortsMainPublishCommand,
  shortsRunDestinations,
  replaceLockBusy,
  replacedYouTubeIds,
} from "./publish-shorts/run.ts";
export {
  CORTE_FORBIDDEN_FLAGS,
  corteRequireAuthArgsError,
  prepareCorteRun,
  syncCorteAuthorizationWithContent,
  syncCorteAgendamento,
  syncCorteAgendamentoFailSoft,
  recordCortePublishAuthorization,
  corteRunAuthorizationError,
  corteRunSpecDrift,
  corteTimerChildRefusal,
  restoreCorteAuthorizationAfterUpdate,
  corteRestoreBlockingFailures,
  CORTE_LIFECYCLE_FORBIDDEN_VALUES,
  CORTE_LIFECYCLE_FORBIDDEN_FLAGS,
  corteLifecycleArgsError,
} from "./publish-shorts/corte.ts";
export type {
  CorteRevocation,
  CorteAuthorizationRefusal,
} from "./publish-shorts/corte.ts";
export {
  UPDATE_PUBLISHED_FORBIDDEN_FLAGS,
  UPDATE_PUBLISHED_FORBIDDEN_VALUES,
  updatePublishedArgsError,
} from "./publish-shorts/update-published.ts";
export {
  threadsEditionMarkers,
  threadsProfilePreflightInput,
  instagramAccountGateApplies,
  corteInstagramConfirmContext,
  editionDayRegisteredIds,
  sameDayCorteRegisteredIds,
  sameDayOtherRegisteredIdsFor,
  credentialSkippedItems,
  instagramManualFirstCommentReminder,
  readInstagramManualFirstCommentReminder,
  confirmInstagram,
} from "./publish-shorts/confirm.ts";
/** Contas do Instagram que a fila do Worker sabe publicar (`ig_account`, #10823) — o tipo mora em short-video.ts (#10916). */
export type { WorkerInstagramAccount } from "./lib/diaria/short-video.ts";

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("publish-shorts:", e instanceof Error ? e.message : e) });
}
