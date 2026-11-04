#!/usr/bin/env node
import { cleanupPublishedVideo } from "./lib/diaria/published-video-cleanup.ts";
/**
 * scripts/publish-youtube.ts (#10659)
 *
 * Publisher do vídeo diário "diar.ia.br comentada" (Pixel comentando o D1) no
 * canal `@diariabr`, via YouTube Data API v3 (`videos.insert`, resumable
 * upload, scope `youtube.upload`).
 *
 * Uso:
 *   npx tsx scripts/publish-youtube.ts AAMMDD --dry-run
 *     [--keep-video] [--edition-dir DIR] [--video PATH] [--episode N]
 *     [--edition-url URL] [--publish-at ISO] [--title "TÍTULO"]
 *   npx tsx scripts/publish-youtube.ts AAMMDD --upload --confirm-publish AAMMDD [mesmas flags] [--force]
 *   npx tsx scripts/publish-youtube.ts AAMMDD --upload --accept-period-match VIDEO_ID
 *
 * `--upload` exige `--confirm-publish AAMMDD` (a mesma edição), dada só depois
 * do "pode publicar" explícito do editor; sem ela sai exit 2 sem enviar nada
 * (#11741, `scripts/lib/diaria/publish-confirm.ts`). O `--accept-period-match`
 * não envia vídeo e dispensa a flag.
 *
 * ## `--dry-run` (default seguro)
 *
 * Lê a edição (`02-reviewed.md`), deriva título/descrição/tags do D1, decide
 * o agendamento (06:00 BRT do dia da edição, ou na hora se já passou ou
 * faltam menos de 15 min, #10875) e
 * imprime o request de `videos.insert` + o passo de `thumbnails.set` como
 * JSON — SEM chamar a API. A única escrita é o marcador
 * `_internal/05-youtube-pending-approval.json` (#12122): o plano está com o
 * editor à espera do "pode publicar", e o `stage5-youtube.ts` não sobe o vídeo
 * enquanto ele existir (o `--upload` e o `link-video-d1.ts --save` o apagam).
 * Vídeo já registrado ou link já colado não grava. Sem `04-youtube-thumb.jpg`, o
 * JSON traz `cover_prerequisites` (ffmpeg, codex, Georgia, rembg desta
 * máquina, a sonda de `check-video-env.ts`, #11532): o que falta para gerar a
 * capa aqui, antes do Passo A2.
 *
 * ## `--upload` (upload real, #10659)
 *
 * Mesmo plano, enviado de verdade (`scripts/lib/diaria/youtube-upload.ts`):
 * refresh token → confere o canal (`YOUTUBE_CHANNEL_ID`) → `videos.insert`
 * resumable com `privacyStatus`/`publishAt` do plano (PUT dos bytes retomado
 * na mesma sessão em falha transitória, #10875) → `thumbnails.set` com
 * a capa (falha aqui não desfaz o vídeo) → releitura do `status` normalizada
 * por `resolveYouTubeState` (#573). Grava o resultado em
 * `_internal/05-youtube-published.json`; com esse registro presente, um novo
 * `--upload` recusa (exit 0, nada enviado) a menos que venha `--force`, que
 * guarda o registro anterior em `previous_uploads`.
 *
 * Com o vídeo enviado, grava também `_internal/05-video-url.txt` (link do
 * vídeo no D1, #10772), inclusive privado/sem auditoria (#10960).
 * A disponibilidade pública gera aviso, sem impedir a gravação do link.
 *
 * Antes do PUT dos bytes o mesmo arquivo recebe um marcador
 * `{ status: "in_progress" }`; se o upload falhar dali em diante (5xx, rede
 * caindo, PUT sem id) ele vira `{ status: "upload_indeterminado", step }`.
 * Os dois bloqueiam um novo `--upload` (exit 1) até o editor conferir o canal
 * e rodar com `--force` — o vídeo PODE ter sido criado.
 *
 * Credenciais (Doppler → `.env`, nunca impressas): GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET (mesmo client do `youtube-oauth-setup.ts`),
 * YOUTUBE_REFRESH_TOKEN e YOUTUBE_CHANNEL_ID (gravados por
 * `scripts/youtube-oauth-setup.ts`, PR #10757). Ausentes → exit 1.
 *
 * **Sem a auditoria do YouTube API Services, o upload via API pode sair
 * `private`** mesmo pedindo `public` ou `publishAt` (restrição de 2020 no
 * revision history; a página atual de `videos.insert` diz o contrário — o 1º
 * upload real confirma pela releitura). A releitura mostra o estado real
 * (`draft` ou `scheduled`); se ficar privado, publicar à mão no Studio.
 *
 * Saída: exit 0 = vídeo enviado (inclusive quando só a capa falhou — vira
 * `[aviso]`); exit 1 = nada enviado (sem credencial, sem vídeo, erro de API
 * antes dos bytes), estado incerto (falha a partir do PUT — o vídeo PODE
 * existir), vídeo recusado pelo YouTube na releitura (`failed`/`rejected`/
 * `deleted`) ou enviado sem conseguir gravar o registro; exit 2 = uso inválido.
 *
 * Fora de escopo aqui: download do vídeo pelo Drive e passo no Stage 5 (a
 * convenção de nome do arquivo ainda não foi confirmada).
 *
 * Arquivo de vídeo: convenção `{editionDir}/diaria-comentada-{AAMMDD}.mp4`
 * (sobrescrevível com `--video`). Ausente → aviso no dry-run (o passo do
 * Stage 5 será fail-soft quando o vídeo ainda não existir); com `--upload`,
 * exit 1 sem enviar nada.
 * Capa: `{editionDir}/04-youtube-thumb.jpg` (1280x720), opcional.
 *
 * Título (#11739): derivado do D1; `--title "..."` (dry-run e upload) troca pelo
 * título que o editor escolheu para o YouTube. O título efetivo vai para o
 * registro (`title`, com `title_source: "flag"` e o `d1_title` derivado), e a
 * detecção do vídeo já no canal casa por qualquer um dos dois. Trocar o título
 * DEPOIS do upload (`videos.update`) exige o escopo `youtube.force-ssl`, que o
 * `youtube-oauth-setup.ts` já pede desde #11384: token anterior a isso (403
 * `ACCESS_TOKEN_SCOPE_INSUFFICIENT`) se resolve rodando o setup de novo.
 *
 * Vídeo da edição já no canal (#11080): sem `--force`, o `--upload` confere
 * os uploads recentes antes de enviar. Reconhecido por AAMMDD/`utm_campaign`
 * ou pelo título do D1 → não envia, grava o registro e o link do D1 (exit 0).
 * Reconhecido SÓ pelo período (vídeo qualquer no dia BRT da edição, #11132) →
 * exit 1 sem enviar e sem gravar nada: pode ser uma live ou um vídeo avulso, e
 * o link iria para o D1 público. O editor confere no Studio e roda de novo com
 * `--accept-period-match VIDEO_ID` (é o vídeo da edição: registra e linka) ou
 * `--force` (não é: sobe o vídeo da edição).
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveYouTubeState } from "./lib/publish-state.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { parseDestaques } from "./extract-destaques.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { publishConfirmationError } from "./lib/diaria/publish-confirm.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { deriveEditionUrl } from "./lib/edition-url.ts";
import {
  YOUTUBE_THUMBNAIL_ENDPOINT,
  YOUTUBE_THUMB_FILE,
  buildYouTubeInsertRequest,
  buildYouTubeTitle,
  buildYouTubeMetadata,
  deriveEpisodeNumber,
  resolveEffectiveVisibility,
  resolveYouTubeSchedule,
  YOUTUBE_API_PROJECT_AUDITED,
  youtubeVideoFileName,
  youtubeD1Themes,
  type YouTubeInsertRequest,
  type YouTubeTheme,
  type YouTubeEffectiveVisibility,
  type YouTubeMetadata,
  type YouTubeScheduleDecision,
} from "./lib/diaria/youtube-video.ts";
import {
  ExistingEditionVideoError,
  YOUTUBE_PUBLISHED_FILE,
  YouTubeUploadError,
  defaultYouTubeUploadDeps,
  describeYouTubeState,
  failedUploadStatus,
  isIndeterminateUploadFailure,
  missingYouTubeCredentials,
  uploadYouTubeVideo,
  type YouTubeUploadDeps,
  type YouTubeUploadResult,
} from "./lib/diaria/youtube-upload.ts";
import { D1_VIDEO_URL_FILE } from "./lib/diaria/d1-video-link.ts";
import {
  YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT,
  YOUTUBE_CAPTION_LANGUAGE,
  describeCaptionOutcome,
  uploadCaptionSafely,
  uploadCaptionsOnly,
  youtubeCaptionFileName,
  type CaptionUploadResult,
} from "./lib/diaria/youtube-captions.ts";
import {
  PODCAST_PLAYLIST_NOT_CONFIGURED,
  describePodcastOutcome,
  ensureVideoInPodcastPlaylist,
  podcastConfigWarning,
  readPodcastPlaylistConfig,
  type PodcastPlaylistResult,
} from "./lib/diaria/youtube-podcast-playlist.ts";
import { logEvent, type RunLogEvent } from "./lib/run-log.ts";
import { d1SocialSlotAt, videoLinkEligibility } from "./lib/diaria/youtube-video-link-gate.ts";
import { coverPrerequisites } from "./lib/diaria/video-env-check.ts";
import { clearPendingApproval, writePendingApproval } from "./lib/diaria/youtube-pending-approval.ts";
import {
  addVideoToThemePlaylists,
  describeThemePlaylists,
  planThemePlaylists,
  readThemePlaylistsConfig,
  type ThemePlaylistResult,
  type ThemePlaylistsConfig,
} from "./lib/diaria/youtube-theme-playlists.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface YouTubePublishPlanInput {
  aammdd: string;
  /** Conteúdo de `02-reviewed.md`. */
  reviewedMd: string;
  now: Date;
  episode?: number;
  editionUrl?: string;
  publishAt?: string;
  /**
   * `--title` (#11739): título do YouTube escolhido pelo editor, diferente do
   * D1 (ex.: melhor para busca). Passa pelo mesmo saneamento do título derivado
   * (markdown, `<`/`>`, 100 caracteres). Ausente = título do D1.
   */
  title?: string;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  thumb: { path: string; exists: boolean };
  /** Legenda SRT do horizontal (#11384). Ausente = sem legenda no plano. */
  captions?: { path: string; exists: boolean };
  /** Projeto GCP auditado? Default `YOUTUBE_API_PROJECT_AUDITED` (false). */
  projectAudited?: boolean;
  /** Modo do CLI — muda só o texto dos avisos. Default `dry-run`. */
  mode?: "dry-run" | "upload";
}

export interface YouTubePublishPlan {
  aammdd: string;
  episode: number;
  metadata: YouTubeMetadata;
  /**
   * Título derivado do D1 (#11739). Igual a `metadata.title` sem `--title`; com
   * ele, segue valendo como 2º título na detecção do vídeo já no canal (#11080).
   */
  d1Title: string;
  /** De onde veio `metadata.title`: o D1 ou o `--title` do editor (#11739). */
  titleSource: "d1" | "flag";
  schedule: YouTubeScheduleDecision;
  /** O que o vídeo de fato fica — difere de `schedule` sem a auditoria do GCP. */
  effective: YouTubeEffectiveVisibility;
  request: YouTubeInsertRequest;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  thumbnail: { path: string; exists: boolean; endpoint: string } | null;
  /** `captions.insert` depois do vídeo (#11384); `null` sem o `.srt`. */
  captions: { path: string; exists: true; endpoint: string; language: string } | null;
  /** Temas do D1 para as playlists temáticas (#12077); os IDs vêm do config no upload. */
  themes: YouTubeTheme[];
  premises: string[];
  warnings: string[];
}

/** Miolo puro do dry-run: tudo o que o upload faria, sem I/O. */
export function planYouTubePublish(input: YouTubePublishPlanInput): YouTubePublishPlan {
  const premises: string[] = [];
  const warnings: string[] = [];

  const d1 = parseDestaques(input.reviewedMd).find((d) => d.n === 1);
  if (!d1) throw new Error("02-reviewed.md sem DESTAQUE 1 — nada para derivar o vídeo");

  let episode = input.episode;
  if (episode === undefined) {
    episode = deriveEpisodeNumber(input.aammdd);
    premises.push(`episódio #${episode} derivado da cadência diária desde 261021 (só registro interno, não aparece no título; passe --episode N se algum dia ficou sem vídeo)`);
  }

  let editionUrl = input.editionUrl;
  if (!editionUrl) {
    editionUrl = deriveEditionUrl(d1.title);
    premises.push(`link da edição derivado do slug do título do D1: ${editionUrl} (passe --edition-url se o slug publicado divergir)`);
  }

  const derived = buildYouTubeMetadata({
    aammdd: input.aammdd,
    episode,
    editionUrl,
    d1: { title: d1.title, body: d1.body, url: d1.url, category: d1.category },
  });
  let metadata = derived;
  let titleSource: YouTubePublishPlan["titleSource"] = "d1";
  if (input.title !== undefined) {
    const custom = buildYouTubeTitle(input.title);
    if (!custom) throw new Error(`--title vazio depois do saneamento: ${JSON.stringify(input.title)}`);
    if (custom !== derived.title) {
      metadata = { ...derived, title: custom };
      titleSource = "flag";
      premises.push(`título do YouTube vindo de --title: "${custom}" (o do D1 seria "${derived.title}", #11739)`);
    }
    if (Array.from(input.title.trim()).length > Array.from(custom).length) {
      warnings.push(`--title passou de 100 caracteres e foi cortado para "${custom}"`);
    }
  }
  const schedule = resolveYouTubeSchedule(input.aammdd, input.now, input.publishAt ?? null);
  premises.push(schedule.premise);
  const themes = youtubeD1Themes({ title: d1.title, body: d1.body, category: d1.category });
  premises.push(
    themes.length
      ? `playlists temáticas do D1: ${themes.join(", ")} (#12077; só entram as com ID em publishing.youtube.theme_playlists)`
      : "D1 sem tema de playlist (#12077)",
  );
  const effective = resolveEffectiveVisibility(schedule, input.projectAudited ?? YOUTUBE_API_PROJECT_AUDITED);
  if (effective.auditBlocked) {
    const pedido = schedule.mode === "immediate" ? "publicação na hora (public)" : `agendamento (publishAt ${schedule.publishAt})`;
    warnings.push(
      `projeto GCP sem auditoria: o plano pede ${pedido}, mas o upload via API pode sair travado em private ` +
        "(restrição de 2020; a página atual de videos.insert diz o contrário — a releitura confirma) — " +
        "nesse caso o vídeo fica privado e precisa ser publicado à mão no Studio do YouTube (#10659)",
    );
  }

  if (!input.video.exists) {
    warnings.push(
      input.mode === "upload"
        ? `vídeo ausente em ${input.video.path} — o --upload sai exit 1 sem enviar nada (passe --video PATH)`
        : `vídeo ausente em ${input.video.path} — o upload real seria pulado (fail-soft)`,
    );
  }
  if (!input.thumb.exists) {
    warnings.push(`capa ausente em ${input.thumb.path} — o YouTube usaria a thumb automática`);
  }

  if (input.captions && !input.captions.exists) {
    premises.push(`sem legenda em ${input.captions.path} — o vídeo sobe sem legenda (passe --captions PATH; depois, --captions-only envia só ela, #11384)`);
  }

  const request = buildYouTubeInsertRequest(metadata, schedule, {
    contentType: "video/mp4",
    contentLength: input.video.sizeBytes,
  });

  return {
    aammdd: input.aammdd,
    episode,
    metadata,
    d1Title: derived.title,
    titleSource,
    schedule,
    effective,
    request,
    video: input.video,
    thumbnail: input.thumb.exists
      ? { path: input.thumb.path, exists: true, endpoint: `${YOUTUBE_THUMBNAIL_ENDPOINT}?videoId={videoId}` }
      : null,
    captions: input.captions?.exists
      ? { path: input.captions.path, exists: true, endpoint: YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT, language: YOUTUBE_CAPTION_LANGUAGE }
      : null,
    themes,
    premises,
    warnings,
  };
}

function parseEpisode(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`--episode inválido: ${JSON.stringify(raw)}`);
  return Number(raw);
}

/** Registro do upload em `_internal/05-youtube-published.json`. */
export interface YouTubePublishedRecord extends YouTubeUploadResult {
  aammdd: string;
  episode: number;
  title: string;
  video_path: string;
  thumbnail_path: string | null;
  /** O plano previa o rebaixamento pra private (projeto GCP sem auditoria). */
  audit_blocked: boolean;
  /**
   * #11739: o `title` veio de `--title` (≠ D1). Ausente = título do D1. O
   * título derivado do D1 fica em `d1_title` para conferência.
   */
  title_source?: "flag";
  d1_title?: string;
  /** Registros substituídos por `--force` (mais antigo primeiro). */
  previous_uploads?: PreviousUploadEntry[];
  /**
   * `already-on-channel` (#11080): o vídeo NÃO foi enviado por este script — já
   * estava no canal (upload manual no Studio) e o registro só o reconhece.
   */
  source?: "already-on-channel";
  /** Sinal que reconheceu o vídeo existente (só com `source`). */
  matched_by?: string;
  /** `matched_by: "period"` aceito pelo editor via `--accept-period-match` (#11132). */
  period_match_accepted?: boolean;
  /**
   * Legenda SRT (#11384), com o `captionId` quando o `captions.insert` passou.
   * `scopeMissing: true` = token sem `youtube.force-ssl` (rodar o setup e
   * depois `--captions-only`).
   */
  captions?: CaptionUploadResult;
  /**
   * Playlist do podcast (#12068), gravado só quando o passo chegou à API (ok ou
   * falha com o motivo). Ausente = não tentado (sem ID configurado, config
   * inválido, sem credencial, desfecho do vídeo com erro) ou resultado não
   * gravado (registro ausente/ilegível no disco).
   */
  podcast?: PodcastPlaylistResult;
  /** Playlists temáticas (#12077), só as que chegaram à API. */
  theme_playlists?: ThemePlaylistResult[];
}

/**
 * Marcador gravado no MESMO arquivo do registro enquanto o vídeo está em
 * estado incerto: `in_progress` logo antes do PUT dos bytes, trocado por
 * `upload_indeterminado` se o upload falhar dali em diante. Bloqueia um novo
 * `--upload` até `--force` (o vídeo PODE ter sido criado).
 */
export interface YouTubeUploadSentinel {
  aammdd: string;
  status: "in_progress" | "upload_indeterminado";
  at: string;
  /** Etapa em que falhou (só em `upload_indeterminado`). */
  step?: string;
  error?: string;
  video_path: string;
  title: string;
  previous_uploads?: PreviousUploadEntry[];
}

/** Entrada de histórico: registro ou marcador anterior, sem o próprio histórico. */
export type PreviousUploadEntry = Omit<YouTubePublishedRecord, "previous_uploads"> | Omit<YouTubeUploadSentinel, "previous_uploads">;

export type PublishedRecordRead =
  | { kind: "none" }
  | { kind: "done"; record: YouTubePublishedRecord }
  | { kind: "pending"; sentinel: YouTubeUploadSentinel };

export interface RunUploadInput {
  plan: YouTubePublishPlan;
  editionDir: string;
  env: Record<string, string | undefined>;
  force: boolean;
  /**
   * #11132: aceita um vídeo reconhecido só pelo período (`matchedBy: "period"`)
   * como o desta edição. Sem isso o `--upload` sai exit 1 sem enviar nem gravar.
   * Só o editor passa (`--accept-period-match VIDEO_ID`); o Stage 5 nunca.
   * O aceite exige o ID exato; booleanos legados não autorizam nenhum candidato.
   */
  acceptPeriodMatch?: boolean | string;
  readFile: (p: string) => Buffer;
  log: (line: string) => void;
  /**
   * Horário do post do D1 (#10858) — limite para um vídeo `scheduled` virar
   * link no D1. `null`/ausente: só vídeo `published` vira link.
   */
  d1SlotAt?: Date | null;
  /**
   * #12068: `publishing.youtube.podcast_playlist_id`. `null`/ausente = o vídeo
   * não vai para o podcast (1 linha `[info]`). Só o horizontal passa por aqui.
   */
  podcastPlaylistId?: string | null;
  /**
   * #12068: `[aviso]` de config presente mas inválido/ilegível. Com ele e sem
   * ID, sai esta linha no lugar do `[info]` de "não configurado".
   */
  podcastConfigWarning?: string | null;
  /** #12068: evento no run-log quando o podcast falha (warn). Ausente = só o log de linha. */
  logRunEvent?: (e: RunLogEvent) => void;
  /** #12077: `publishing.youtube.theme_playlists` lido. Ausente = passo pulado em silêncio (testes antigos). */
  themePlaylists?: ThemePlaylistsConfig;
}

export interface RunUploadOutcome {
  exitCode: number;
  record: YouTubePublishedRecord | null;
  skipped: boolean;
  /** `_internal/05-video-url.txt` gravado nesta rodada (#10858). */
  videoUrlWritten?: boolean;
}

/**
 * Depois do upload, grava `_internal/05-video-url.txt` (o link do vídeo no D1,
 * #10772), inclusive privado (#10960). O estado relido serve só de aviso.
 * Não sobrescreve uma URL diferente já gravada à mão.
 * Nunca lança: o vídeo já subiu, falha aqui vira aviso.
 */
export function writeD1VideoUrlAfterUpload(
  editionDir: string,
  record: Pick<YouTubePublishedRecord, "aammdd" | "url" | "state" | "rereadStatus"> & Partial<Pick<YouTubePublishedRecord, "previous_uploads">>,
  d1SlotAt: Date | null,
  log: (line: string) => void,
  /** Default `YOUTUBE_API_PROJECT_AUDITED`; usado somente para o aviso. */
  projectAudited: boolean = YOUTUBE_API_PROJECT_AUDITED,
): boolean {
  const verdict = videoLinkEligibility({
    state: record.state,
    publishAt: record.rereadStatus?.publishAt ?? null,
    d1SlotAt,
    projectAudited,
  });
  const urlFile = join(editionDir, D1_VIDEO_URL_FILE);
  // Upload forçado troca o link de um upload anterior, inclusive privado
  // (#10960). URLs inseridas manualmente pelo editor seguem preservadas.
  const previousUrls = new Set(
    (record.previous_uploads ?? [])
      .map((p) => ("url" in p && typeof p.url === "string" ? p.url : null))
      .filter((u): u is string => !!u && u !== record.url),
  );
  let currentRaw = "";
  try {
    currentRaw = existsSync(urlFile) ? readFileSync(urlFile, "utf8").trim() : "";
  } catch {
    // Ilegível: o bloco de gravação abaixo relê e registra o erro.
  }
  const staleFromPreviousUpload = currentRaw !== "" && previousUrls.has(currentRaw);
  if (!verdict.ok) {
    log(`[aviso] vídeo ainda pode não abrir para o leitor: ${verdict.reason}. O link será incluído no D1 mesmo assim (#10960).`);
  }
  try {
    if (existsSync(urlFile)) {
      const current = readFileSync(urlFile, "utf8").trim();
      if (current && current !== record.url && !staleFromPreviousUpload) {
        log(`[aviso] ${urlFile} já aponta para ${current} — mantido; o vídeo enviado é ${record.url} (#10858)`);
        return false;
      }
      if (current === record.url) return false;
    }
    mkdirSync(dirname(urlFile), { recursive: true });
    writeFileAtomic(urlFile, `${record.url}\n`);
    log(`[ok] ${urlFile} gravado (${verdict.reason}) — o Stage 5 põe o link no D1 de X, Threads e Facebook`);
    return true;
  } catch (e) {
    log(`[aviso] link do vídeo não gravado em ${urlFile}: ${(e as Error).message} — rode link-video-d1.ts --save`);
    return false;
  }
}

const SENTINEL_STATUSES = new Set(["in_progress", "upload_indeterminado"]);

/**
 * Lê o registro anterior. Lança quando o arquivo existe mas não dá pra
 * confiar nele — ilegível, de outra edição, sem `videoId`, `null`, `{}`:
 * nesses casos não dá pra saber se o vídeo já subiu, e recusar é mais seguro
 * que duplicar.
 */
export function readPublishedRecord(path: string, aammdd: string): PublishedRecordRead {
  if (!existsSync(path)) return { kind: "none" };
  const refuse = (why: string) =>
    new Error(`registro ${path} ilegível (${why}) — confira o canal e apague/corrija o arquivo antes de --upload`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw refuse((e as Error).message);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw refuse("não é um objeto JSON");
  const rec = raw as Record<string, unknown>;
  if (rec.aammdd !== aammdd) throw refuse(`é de outra edição: ${JSON.stringify(rec.aammdd ?? null)}`);
  if (typeof rec.status === "string" && SENTINEL_STATUSES.has(rec.status)) {
    return { kind: "pending", sentinel: rec as unknown as YouTubeUploadSentinel };
  }
  if (typeof rec.videoId !== "string" || !rec.videoId) throw refuse("sem videoId");
  return { kind: "done", record: rec as unknown as YouTubePublishedRecord };
}

/** Origem do título no registro (#11739): só aparece quando veio de `--title`. */
function titleProvenance(plan: YouTubePublishPlan): Pick<YouTubePublishedRecord, "title_source" | "d1_title"> {
  return plan.titleSource === "flag" ? { title_source: "flag", d1_title: plan.d1Title } : {};
}

/** Histórico a carregar no próximo registro, a partir do que está no disco. */
function historyFrom(read: PublishedRecordRead): PreviousUploadEntry[] {
  if (read.kind === "none") return [];
  const prev = read.kind === "done" ? read.record : read.sentinel;
  const { previous_uploads, ...rest } = prev;
  return [...(previous_uploads ?? []), rest];
}

/**
 * #11080: a edição já tem vídeo no canal (subido à mão). Nada foi enviado; grava
 * o registro com `source: "already-on-channel"` — assim as próximas rodadas e os
 * consumidores de `05-youtube-published.json` (fetch, gate do link no D1) tratam
 * como publicado — e põe o link no D1 como num upload normal. Exit 0.
 * Vídeo com `uploadStatus` falho nunca chega aqui: `matchEditionVideo` o
 * descarta e o upload normal segue (#11103).
 * #11132: só com `period` aceito pelo editor — ver `unconfirmedPeriodMatch`.
 */
function recordExistingVideo(
  e: ExistingEditionVideoError,
  input: RunUploadInput,
  plan: YouTubePublishPlan,
  recordPath: string,
  history: PreviousUploadEntry[],
  now: Date,
): RunUploadOutcome {
  const v = e.video;
  const state = v.status ? resolveYouTubeState({ status: v.status }, now) : "unknown";
  const record: YouTubePublishedRecord = {
    aammdd: plan.aammdd,
    episode: plan.episode,
    title: v.title || plan.metadata.title,
    video_path: plan.video.path,
    thumbnail_path: null,
    audit_blocked: plan.effective.auditBlocked,
    videoId: v.videoId,
    url: v.url,
    channelId: null,
    requested: { privacyStatus: v.status?.privacyStatus ?? "", publishAt: v.status?.publishAt ?? null },
    thumbnail: { attempted: false, ok: false, error: null },
    state,
    rereadStatus: v.status,
    rereadError: null,
    uploadedAt: v.publishedAt ?? now.toISOString(),
    rereadAt: now.toISOString(),
    source: "already-on-channel",
    matched_by: v.matchedBy,
    ...(v.matchedBy === "period" ? { period_match_accepted: true } : {}),
    ...(history.length > 0 ? { previous_uploads: history } : {}),
  };
  input.log(
    `[ok] already-on-channel: ${v.url} (${v.title || "sem título"}) já está no canal, reconhecido por ${v.matchedBy}, estado ${state} — nada enviado. ` +
      "Se não for o vídeo desta edição, rode de novo com --force (cria OUTRO vídeo no canal).",
  );
  try {
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileAtomic(recordPath, JSON.stringify(record, null, 2) + "\n");
  } catch (we) {
    input.log(`[aviso] registro do vídeo existente não gravado em ${recordPath}: ${(we as Error).message}`);
    return { exitCode: 0, record, skipped: true };
  }
  const videoUrlWritten = writeD1VideoUrlAfterUpload(input.editionDir, record, input.d1SlotAt ?? null, input.log, !plan.effective.auditBlocked);
  return { exitCode: 0, record, skipped: true, videoUrlWritten };
}

/**
 * #11132: o único sinal foi o período (vídeo no dia BRT da edição, sem AAMMDD,
 * `utm_campaign` nem o título do D1). Pode ser uma live ou um vídeo avulso:
 * gravar o registro poria esse link no D1 de X, Threads e Facebook, e subir por
 * cima poderia duplicar um upload manual. Não envia, não grava registro nem
 * link; exit 1 com as duas saídas para o editor.
 */
function unconfirmedPeriodMatch(e: ExistingEditionVideoError, input: RunUploadInput, plan: YouTubePublishPlan): RunUploadOutcome {
  const v = e.video;
  for (const candidate of v.periodCandidates ?? [v]) {
    input.log(`[candidato period] ${candidate.videoId} — ${candidate.url} — "${candidate.title || "sem título"}" — ${candidate.status?.publishAt ?? candidate.publishedAt ?? "sem data"}`);
  }
  input.log(
    `[erro] há um vídeo no canal no dia da edição ${plan.aammdd} que não traz a marca dela (${v.url}, "${v.title || "sem título"}", ` +
      `publicado/agendado ${v.status?.publishAt ?? v.publishedAt ?? "sem data"}) — reconhecido só pelo período, sem AAMMDD, utm_campaign nem o título do D1. ` +
      "Nada foi enviado nem gravado (o link não vai para o D1). Confira no YouTube Studio: se for o vídeo desta edição, rode de novo com " +
      "--accept-period-match VIDEO_ID (registra e põe o link no D1); se não for, rode com --force (sobe o vídeo da edição).",
  );
  return { exitCode: 1, record: null, skipped: false };
}

/**
 * `--upload`: envia o plano de verdade e grava o registro. Separado do `main`
 * pra o teste injetar `deps.fetch` e o ambiente sem tocar a rede nem o `.env`.
 * Depois de um desfecho com vídeo (enviado agora, já no canal ou já
 * registrado), põe o vídeo na playlist do podcast (#12068, fail-soft).
 */
export async function runYouTubeUpload(deps: YouTubeUploadDeps, input: RunUploadInput): Promise<RunUploadOutcome> {
  const outcome = await runYouTubeUploadCore(deps, input);
  const withPodcast = await addToPodcastAfterUpload(deps, input, outcome);
  return addToThemePlaylistsAfterUpload(deps, input, withPodcast);
}

/**
 * #12077 item 3: playlists temáticas do D1, depois do podcast. Mesmas regras
 * do podcast: só com vídeo confirmado, nunca muda o exit code, tema já `ok`
 * para o mesmo vídeo no registro não gasta quota de novo, e o resultado só é
 * regravado num registro que já está no disco.
 */
export async function addToThemePlaylistsAfterUpload(
  deps: YouTubeUploadDeps,
  input: Pick<RunUploadInput, "plan" | "editionDir" | "env" | "log" | "themePlaylists">,
  outcome: RunUploadOutcome,
): Promise<RunUploadOutcome> {
  const rec = outcome.record;
  if (!rec || outcome.exitCode !== 0 || !input.themePlaylists) return outcome;
  for (const w of input.themePlaylists.warnings) input.log(w);
  const steps = planThemePlaylists(input.plan.themes ?? [], input.themePlaylists);
  const done = new Set((rec.theme_playlists ?? []).filter((r) => r.ok && r.videoId === rec.videoId).map((r) => `${r.theme}:${r.playlistId}`));
  const todo = steps.filter((s) => s.playlistId !== null && !done.has(`${s.theme}:${s.playlistId}`));
  if (todo.length && missingYouTubeCredentials(input.env).length > 0) {
    input.log(`[aviso] playlists temáticas não tentadas: faltam ${missingYouTubeCredentials(input.env).join(", ")} no ambiente (#12077)`);
    return outcome;
  }
  const results = todo.length
    ? await addVideoToThemePlaylists(deps, {
        creds: {
          clientId: (input.env.GOOGLE_CLIENT_ID ?? "").trim(),
          clientSecret: (input.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
          refreshToken: (input.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
          channelId: (input.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
        },
        steps: todo,
        videoId: rec.videoId,
      })
    : [];
  const shown = [...(rec.theme_playlists ?? []).filter((r) => done.has(`${r.theme}:${r.playlistId}`)), ...results];
  for (const line of describeThemePlaylists(steps, shown)) input.log(line);
  if (!results.length) return outcome;
  const kept = (rec.theme_playlists ?? []).filter((r) => !results.some((n) => n.theme === r.theme));
  const record: YouTubePublishedRecord = { ...rec, theme_playlists: [...kept, ...results] };
  const recordPath = join(input.editionDir, YOUTUBE_PUBLISHED_FILE);
  if (!existsSync(recordPath)) return { ...outcome, record };
  try {
    writeFileAtomic(recordPath, JSON.stringify(record, null, 2) + "\n");
  } catch (e) {
    input.log(`[aviso] resultado das playlists temáticas não gravado em ${recordPath}: ${(e as Error).message}`);
  }
  return { ...outcome, record };
}

/**
 * #12068: passo do podcast. Só roda com vídeo confirmado (`record` + exit 0);
 * nunca muda o exit code. Registro que já traz `podcast.ok` para a mesma
 * playlist não gasta quota de novo.
 */
export async function addToPodcastAfterUpload(
  deps: YouTubeUploadDeps,
  input: Pick<RunUploadInput, "editionDir" | "env" | "log" | "podcastPlaylistId" | "podcastConfigWarning" | "logRunEvent"> &
    Partial<Pick<RunUploadInput, "force">>,
  outcome: RunUploadOutcome,
): Promise<RunUploadOutcome> {
  const rec = outcome.record;
  if (!rec) return outcome;
  if (outcome.exitCode !== 0) {
    input.log("[info] podcast não tentado: vídeo sem confirmação (#12068)");
    return outcome;
  }
  if (input.force) warnStalePodcastItem(rec, input.log);
  const playlistId = (input.podcastPlaylistId ?? "").trim();
  if (!playlistId) {
    input.log(input.podcastConfigWarning ?? PODCAST_PLAYLIST_NOT_CONFIGURED);
    return outcome;
  }
  if (rec.podcast?.ok === true && rec.podcast.playlistId === playlistId && rec.podcast.videoId === rec.videoId) return outcome;
  const missing = missingYouTubeCredentials(input.env);
  if (missing.length > 0) {
    input.log(`[aviso] vídeo NÃO adicionado ao podcast: faltam ${missing.join(", ")} no ambiente. O vídeo segue publicado.`);
    return outcome;
  }
  const podcast = await ensureVideoInPodcastPlaylist(deps, {
    creds: {
      clientId: (input.env.GOOGLE_CLIENT_ID ?? "").trim(),
      clientSecret: (input.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
      refreshToken: (input.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
      channelId: (input.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
    },
    playlistId,
    videoId: rec.videoId,
  });
  input.log(describePodcastOutcome(podcast, rec.aammdd));
  if (!podcast.ok && input.logRunEvent) {
    try {
      input.logRunEvent({
        edition: rec.aammdd,
        stage: null,
        agent: "publish-youtube",
        level: "warn",
        message: "podcast: vídeo não adicionado à playlist (#12068)",
        details: { playlistId, videoId: rec.videoId, error: podcast.error, scopeMissing: podcast.scopeMissing, httpStatus: podcast.httpStatus },
      });
    } catch {
      // fail-soft: o run-log nunca derruba o vídeo.
    }
  }
  const record: YouTubePublishedRecord = { ...rec, podcast };
  const recordPath = join(input.editionDir, YOUTUBE_PUBLISHED_FILE);
  // Só regrava um registro que já está no disco: se o core não o gravou (ex.:
  // already-on-channel com falha de escrita), criar o arquivo aqui faria a
  // próxima rodada cair em "done" e nunca gravar o link do D1 (05-video-url.txt).
  if (!existsSync(recordPath)) {
    input.log(`[aviso] resultado do podcast não gravado: ${recordPath} não existe (o registro do vídeo não foi gravado nesta rodada)`);
    return { ...outcome, record };
  }
  try {
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileAtomic(recordPath, JSON.stringify(record, null, 2) + "\n");
  } catch (e) {
    input.log(`[aviso] resultado do podcast não gravado em ${recordPath}: ${(e as Error).message}`);
  }
  return { ...outcome, record };
}

/**
 * #12068: `--force` sobe OUTRO vídeo; o anterior continua na playlist do
 * podcast. Avisa o item a remover no Studio (nada é apagado por aqui).
 */
function warnStalePodcastItem(rec: YouTubePublishedRecord, log: (line: string) => void): void {
  const prev = [...(rec.previous_uploads ?? [])].reverse().find((p) => "podcast" in p && p.podcast);
  const pod = prev && "podcast" in prev ? prev.podcast : undefined;
  if (!prev || !pod?.ok || !pod.playlistItemId) return;
  if ("videoId" in prev && prev.videoId === rec.videoId) return;
  const url = "url" in prev && typeof prev.url === "string" ? prev.url : (pod.videoId ?? "vídeo anterior");
  log(
    `[aviso] --force: o upload anterior (${url}) segue na playlist do podcast ${pod.playlistId} como item ${pod.playlistItemId} — ` +
      "remova-o do podcast no YouTube Studio (nada foi apagado por este script).",
  );
}

async function runYouTubeUploadCore(deps: YouTubeUploadDeps, input: RunUploadInput): Promise<RunUploadOutcome> {
  const { plan, log } = input;
  const recordPath = join(input.editionDir, YOUTUBE_PUBLISHED_FILE);

  let previous: PublishedRecordRead;
  try {
    previous = readPublishedRecord(recordPath, plan.aammdd);
  } catch (e) {
    log(`publish-youtube: ${(e as Error).message}. Nada foi enviado.`);
    return { exitCode: 1, record: null, skipped: false };
  }
  if (previous.kind === "done" && !input.force) {
    const rec = previous.record;
    log(
      `[ok] vídeo desta edição já enviado (${rec.url}, estado relido em ${rec.rereadAt}: ${rec.state}) — nada enviado. ` +
        "Use --force para subir de novo (cria OUTRO vídeo no canal).",
    );
    if (plan.captions && !rec.captions?.ok) {
      log(`[aviso] o vídeo registrado não tem legenda enviada — \`npx tsx scripts/publish-youtube.ts ${plan.aammdd} --captions-only\` envia ${plan.captions.path} (#11384)`);
    }
    return { exitCode: 0, record: rec, skipped: true };
  }
  if (previous.kind === "pending" && !input.force) {
    const s = previous.sentinel;
    log(
      `[erro] um upload anterior desta edição ficou em estado incerto (${s.status}${s.step ? `, etapa ${s.step}` : ""}, em ${s.at}) — ` +
        `o vídeo PODE ter sido criado. Confira o canal no YouTube Studio; se não houver vídeo, rode de novo com --force. Nada foi enviado.`,
    );
    return { exitCode: 1, record: null, skipped: false };
  }

  const missing = missingYouTubeCredentials(input.env);
  if (missing.length > 0) {
    log(
      `publish-youtube: faltam ${missing.join(", ")} no ambiente — rode \`npx tsx scripts/youtube-oauth-setup.ts\` ` +
        "(e `npm run sync-env` no 300). Nada foi enviado.",
    );
    return { exitCode: 1, record: null, skipped: false };
  }
  if (!plan.video.exists) {
    log(`publish-youtube: vídeo ausente em ${plan.video.path} — nada foi enviado (passe --video PATH)`);
    return { exitCode: 1, record: null, skipped: false };
  }

  let video: Buffer;
  let thumbnail: Buffer | null;
  try {
    video = input.readFile(plan.video.path);
    thumbnail = plan.thumbnail ? input.readFile(plan.thumbnail.path) : null;
  } catch (e) {
    log(`publish-youtube: não foi possível ler o vídeo/capa: ${(e as Error).message}. Nada foi enviado.`);
    return { exitCode: 1, record: null, skipped: false };
  }
  // #11384: a legenda é opcional — ilegível vira aviso, nunca bloqueia o vídeo.
  let srt: Buffer | null = null;
  if (plan.captions) {
    try {
      srt = input.readFile(plan.captions.path);
    } catch (e) {
      log(`[aviso] legenda ${plan.captions.path} ilegível (${(e as Error).message}) — o vídeo sobe sem ela`);
    }
  }
  const captionOut: { result: CaptionUploadResult | null } = { result: null };

  const history = historyFrom(previous);
  const writeSentinel = (sentinel: Omit<YouTubeUploadSentinel, "aammdd" | "video_path" | "title" | "previous_uploads">) => {
    const full: YouTubeUploadSentinel = {
      aammdd: plan.aammdd,
      ...sentinel,
      video_path: plan.video.path,
      title: plan.metadata.title,
      ...(history.length > 0 ? { previous_uploads: history } : {}),
    };
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileAtomic(recordPath, JSON.stringify(full, null, 2) + "\n");
  };

  let result: YouTubeUploadResult;
  try {
    result = await uploadYouTubeVideo(deps, {
      creds: {
        clientId: (input.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (input.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (input.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (input.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      },
      request: plan.request,
      video,
      contentType: "video/mp4",
      thumbnail,
      // #11080: --force sobe de novo de propósito; sem ele, confere o canal antes.
      ...(input.force
        ? {}
        : {
            existingVideoCheck: {
              aammdd: plan.aammdd,
              title: plan.metadata.title,
              // #11739: com --title, o título do D1 também reconhece o vídeo (upload manual com o título padrão).
              ...(plan.titleSource === "flag" ? { altTitles: [plan.d1Title] } : {}),
              acceptedPeriodVideoId: typeof input.acceptPeriodMatch === "string" ? input.acceptPeriodMatch : undefined,
            },
          }),
      beforeVideoBytes: () => writeSentinel({ status: "in_progress", at: deps.now().toISOString() }),
      ...(srt
        ? {
            afterVideo: async (token: string, videoId: string) => {
              captionOut.result = await uploadCaptionSafely(deps, token, videoId, srt, plan.captions?.path ?? null);
            },
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof ExistingEditionVideoError) {
      if (e.video.matchedBy === "period") {
        const selected = (e.video.periodCandidates ?? [e.video]).find((v) => v.videoId === input.acceptPeriodMatch);
        if (!selected) return unconfirmedPeriodMatch(e, input, plan);
        return recordExistingVideo(new ExistingEditionVideoError(selected), input, plan, recordPath, history, deps.now());
      }
      if (typeof input.acceptPeriodMatch === "string" && e.video.videoId !== input.acceptPeriodMatch) {
        log("[erro] VIDEO_ID aceito difere do vídeo reconhecido por edição/título. Nada foi enviado nem gravado.");
        return { exitCode: 1, record: null, skipped: false };
      }
      return recordExistingVideo(e, input, plan, recordPath, history, deps.now());
    }
    const step = e instanceof YouTubeUploadError ? e.step : "desconhecida";
    const msg = `${(e as Error).message} (etapa ${step})`;
    if (!isIndeterminateUploadFailure(e)) {
      log(`publish-youtube: upload falhou — ${msg}. Nada foi publicado.`);
      return { exitCode: 1, record: null, skipped: false };
    }
    let sentinelNote: string;
    try {
      writeSentinel({ status: "upload_indeterminado", at: deps.now().toISOString(), step, error: (e as Error).message });
      sentinelNote = `marcador de estado incerto gravado em ${recordPath}: o próximo --upload recusa até --force`;
    } catch (we) {
      sentinelNote = `marcador de estado incerto NÃO gravado em ${recordPath} (${(we as Error).message}) — não confie no --upload para evitar duplicata`;
    }
    log(
      `[erro] upload falhou — ${msg}. O vídeo PODE ter sido criado — confira o canal antes de rodar de novo (${sentinelNote}).`,
    );
    return { exitCode: 1, record: null, skipped: false };
  }

  const record: YouTubePublishedRecord = {
    aammdd: plan.aammdd,
    episode: plan.episode,
    title: plan.metadata.title,
    ...titleProvenance(plan),
    video_path: plan.video.path,
    thumbnail_path: plan.thumbnail?.path ?? null,
    audit_blocked: plan.effective.auditBlocked,
    ...result,
    ...(captionOut.result ? { captions: captionOut.result } : {}),
    ...(history.length > 0 ? { previous_uploads: history } : {}),
  };

  if (result.thumbnail.attempted && !result.thumbnail.ok) {
    log(`[aviso] vídeo enviado, mas a capa falhou: ${result.thumbnail.error} — suba ${plan.thumbnail?.path} à mão no Studio`);
  }
  if (result.rereadError) log(`[aviso] releitura do estado falhou: ${result.rereadError}`);
  const captionLine = captionOut.result ? describeCaptionOutcome(captionOut.result, plan.aammdd) : null;
  if (captionLine) log(captionLine);
  const failed = failedUploadStatus(result.rereadStatus);
  if (failed) {
    const reason = result.rereadStatus?.rejectionReason ?? result.rereadStatus?.failureReason ?? "sem motivo informado";
    log(
      `[erro] vídeo enviado (${result.url}), mas o YouTube marcou uploadStatus=${failed} (motivo: ${reason}) — ` +
        "o vídeo não vai ao ar; confira no Studio. O registro foi mantido para não duplicar o envio.",
    );
  } else {
    log(
      `[ok] vídeo enviado: ${result.url} — estado relido: ${result.state} ` +
        `(${describeYouTubeState(result.state, { auditBlocked: plan.effective.auditBlocked })})`,
    );
  }

  try {
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileAtomic(recordPath, JSON.stringify(record, null, 2) + "\n");
  } catch (e) {
    // O YouTube JÁ aceitou: não pode virar "falhou" silencioso (a próxima rodada duplicaria).
    log(
      `[erro] vídeo ENVIADO (${result.url}) mas o registro não foi gravado em ${recordPath}: ${(e as Error).message}. ` +
        "NÃO rode --upload de novo sem antes conferir o canal.",
    );
    return { exitCode: 1, record, skipped: false };
  }
  // #10865: mesma premissa de auditoria com que o plano foi montado.
  const videoUrlWritten = failed
    ? false
    : writeD1VideoUrlAfterUpload(input.editionDir, record, input.d1SlotAt ?? null, log, !plan.effective.auditBlocked);
  return { exitCode: failed ? 1 : 0, record, skipped: false, videoUrlWritten };
}

export interface RunCaptionsOnlyInput {
  aammdd: string;
  editionDir: string;
  /** Caminho do `.srt` (default: `youtubeCaptionFileName` na pasta da edição). */
  captionsPath: string;
  env: Record<string, string | undefined>;
  /** Envia mesmo com uma legenda já registrada (cria outra faixa). */
  force: boolean;
  readFile: (p: string) => Buffer;
  log: (line: string) => void;
}

/**
 * `--captions-only` (#11384): envia só a legenda para o vídeo JÁ registrado em
 * `_internal/05-youtube-published.json` (pelo `videoId`), sem tocar no vídeo.
 * Exit 0 = legenda enviada, já registrada (sem `--force`) ou token sem o
 * escopo `youtube.force-ssl` (fail-soft: `[aviso]` com o comando de setup);
 * exit 1 = sem registro, sem `.srt`, sem credencial, canal/token errado ou
 * erro da API na legenda.
 */
export async function runCaptionsOnly(deps: YouTubeUploadDeps, input: RunCaptionsOnlyInput): Promise<RunUploadOutcome> {
  const { log } = input;
  const recordPath = join(input.editionDir, YOUTUBE_PUBLISHED_FILE);
  let read: PublishedRecordRead;
  try {
    read = readPublishedRecord(recordPath, input.aammdd);
  } catch (e) {
    log(`publish-youtube: ${(e as Error).message}. Nenhuma legenda enviada.`);
    return { exitCode: 1, record: null, skipped: false };
  }
  if (read.kind !== "done") {
    log(
      read.kind === "none"
        ? `publish-youtube: sem ${recordPath} — --captions-only precisa do vídeo registrado (rode --upload antes, ou --accept-period-match se ele já está no canal). Nenhuma legenda enviada.`
        : `publish-youtube: o registro está em estado incerto (${read.sentinel.status}) — confira o canal antes. Nenhuma legenda enviada.`,
    );
    return { exitCode: 1, record: null, skipped: false };
  }
  const rec = read.record;
  if (rec.captions?.ok && !input.force) {
    log(`[ok] legenda já enviada (captionId ${rec.captions.captionId}) — nada feito. Use --force para enviar outra faixa.`);
    return { exitCode: 0, record: rec, skipped: true };
  }
  if (!existsSync(input.captionsPath)) {
    log(`publish-youtube: legenda ausente em ${input.captionsPath} (passe --captions PATH). Nenhuma legenda enviada.`);
    return { exitCode: 1, record: null, skipped: false };
  }
  const missing = missingYouTubeCredentials(input.env);
  if (missing.length > 0) {
    log(`publish-youtube: faltam ${missing.join(", ")} no ambiente — rode \`npx tsx scripts/youtube-oauth-setup.ts\`. Nenhuma legenda enviada.`);
    return { exitCode: 1, record: null, skipped: false };
  }
  let srt: Buffer;
  try {
    srt = input.readFile(input.captionsPath);
  } catch (e) {
    log(`publish-youtube: legenda ilegível (${(e as Error).message}). Nenhuma legenda enviada.`);
    return { exitCode: 1, record: null, skipped: false };
  }

  let captions: CaptionUploadResult;
  try {
    captions = await uploadCaptionsOnly(deps, {
      creds: {
        clientId: (input.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (input.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (input.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (input.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      },
      videoId: rec.videoId,
      srt,
      path: input.captionsPath,
    });
  } catch (e) {
    log(`publish-youtube: ${(e as Error).message}. Nenhuma legenda enviada.`);
    return { exitCode: 1, record: null, skipped: false };
  }
  const line = describeCaptionOutcome(captions, input.aammdd);
  if (line) log(line);

  const record: YouTubePublishedRecord = { ...rec, captions };
  try {
    writeFileAtomic(recordPath, JSON.stringify(record, null, 2) + "\n");
  } catch (e) {
    log(`[aviso] resultado da legenda não gravado em ${recordPath}: ${(e as Error).message}`);
  }
  const exitCode = captions.ok || captions.scopeMissing ? 0 : 1;
  return { exitCode, record, skipped: false };
}

/**
 * #12068: `publishing.youtube.podcast_playlist_id`. Ausente/`null` = sem ID e
 * sem aviso (o passo loga o `[info]`); presente mas inválido, ou config
 * ilegível = sem ID e com o `[aviso]` de "pulado por causa do config". Nunca lança.
 */
function loadPodcastPlaylistIdFromConfig(): { id: string | null; warning: string | null } {
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  } catch (e) {
    return { id: null, warning: podcastConfigWarning(`platform.config.json ilegível (${(e as Error).message})`) };
  }
  const r = readPodcastPlaylistConfig(cfg);
  if (r.kind === "ok") return { id: r.id, warning: null };
  return { id: null, warning: r.kind === "invalid" ? podcastConfigWarning(r.reason) : null };
}

/**
 * #12122: depois do `--dry-run`, grava o marcador de "à espera do pode publicar"
 * que segura o upload automático do `stage5-youtube.ts`. Não grava quando o
 * vídeo desta edição já existe no canal (registro `done`) ou o link já foi
 * colado (`05-video-url.txt`): aí não há confirmação pendente. Registro
 * ilegível ou em estado incerto grava (o erro seguro é segurar o Stage 5).
 * Nunca lança: o dry-run não falha por causa do marcador.
 */
export function markPendingApprovalAfterDryRun(dir: string, aammdd: string, now: Date, log: (line: string) => void): boolean {
  try {
    if (existsSync(join(dir, D1_VIDEO_URL_FILE))) return false;
    let done = false;
    try {
      done = readPublishedRecord(join(dir, YOUTUBE_PUBLISHED_FILE), aammdd).kind === "done";
    } catch {
      done = false;
    }
    if (done) return false;
    const path = writePendingApproval(dir, aammdd, now);
    log(`[premissa] ${path} gravado: o stage5-youtube.ts não sobe o horizontal até o --upload confirmado (ou o link colado) apagá-lo (#12122)`);
    return true;
  } catch (e) {
    log(`[aviso] marcador de confirmação pendente não gravado (${(e as Error).message}) — com a Etapa 5 rodando em paralelo, o stage5-youtube.ts pode subir o vídeo antes do "pode publicar" (#12122)`);
    return false;
  }
}

/** #12077: `publishing.youtube.theme_playlists` do `platform.config.json`. Nunca lança. */
function loadThemePlaylistsFromConfig(): ThemePlaylistsConfig {
  try {
    return readThemePlaylistsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
  } catch (e) {
    return { ids: {}, warnings: [`[aviso] playlists temáticas puladas: platform.config.json ilegível (${(e as Error).message}) (#12077)`] };
  }
}

/** Horário do post do D1 pelo `platform.config.json`; `null` se não der (nunca lança). */
function loadD1SlotAt(aammdd: string): Date | null {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")) as {
      publishing?: { social?: Record<string, unknown> };
    };
    return d1SocialSlotAt(aammdd, cfg.publishing?.social ?? null);
  } catch (e) {
    console.error(`[aviso] horário do D1 não derivado (${(e as Error).message}) — só vídeo público vira link no D1`);
    return null;
  }
}

const USAGE =
  "uso: publish-youtube.ts AAMMDD (--dry-run | --upload --confirm-publish AAMMDD [--force] | --upload --accept-period-match VIDEO_ID | --captions-only [--force]) [--keep-video] [--edition-dir DIR] [--video PATH] [--captions PATH | --no-captions] [--episode N] [--edition-url URL] [--publish-at ISO] [--title TÍTULO]";

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error(USAGE);
    return 2;
  }
  const dryRun = flags.has("dry-run");
  const upload = flags.has("upload");
  const captionsOnly = flags.has("captions-only");
  const modes = [dryRun, upload, captionsOnly].filter(Boolean).length;
  if (modes !== 1) {
    console.error(
      modes > 1
        ? "publish-youtube: --dry-run, --upload e --captions-only são exclusivos."
        : "publish-youtube: escolha o modo — --dry-run (só o plano), --upload (envio real; sem a auditoria do YouTube API Services o vídeo sai private, #10659) ou --captions-only (só a legenda do vídeo registrado, #11384).",
    );
    console.error(USAGE);
    return 2;
  }
  if (values["captions"] !== undefined && flags.has("no-captions")) {
    console.error("publish-youtube: --captions e --no-captions são exclusivos.");
    return 2;
  }
  if ((flags.has("accept-period-match") || values["accept-period-match"] !== undefined) &&
      (!values["accept-period-match"] || !upload || flags.has("force"))) {
    console.error("publish-youtube: --accept-period-match exige VIDEO_ID e só vale com --upload e sem --force (o --force pula a conferência do canal).");
    console.error(USAGE);
    return 2;
  }
  // #11739: `--title` sem valor (ou seguido de outra flag) cai em `flags`, não
  // em `values` — sem esta recusa o plano usaria o título do D1 em silêncio.
  if (flags.has("title") || values["title"] === "") {
    console.error("publish-youtube: --title exige o TÍTULO (ex.: --title \"Meu título\").");
    console.error(USAGE);
    return 2;
  }
  // #11741: o upload tem efeito público — só com a confirmação explícita da
  // edição, checada antes de credencial, vídeo ou rede. O `--accept-period-match`
  // não envia nada (registra um vídeo que já está no canal) e fica de fora.
  if (upload && values["accept-period-match"] === undefined) {
    const confirmErr = publishConfirmationError({ script: "publish-youtube", mode: "--upload", aammdd, flags, values });
    if (confirmErr) {
      console.error(confirmErr);
      return 2;
    }
  }

  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  const captionsPath = resolve(values["captions"] ?? join(dir, youtubeCaptionFileName(aammdd)));
  if (captionsOnly) {
    if (flags.has("no-captions")) {
      console.error("publish-youtube: --captions-only com --no-captions não faz nada.");
      return 2;
    }
    loadProjectEnv(ROOT);
    const outcome = await runCaptionsOnly(defaultYouTubeUploadDeps, {
      aammdd,
      editionDir: dir,
      captionsPath,
      env: process.env,
      force: flags.has("force"),
      readFile: (p) => readFileSync(p),
      log: (line) => console.error(line),
    });
    if (outcome.record?.captions) console.log(JSON.stringify({ captions_only: true, skipped: outcome.skipped, videoId: outcome.record.videoId, captions: outcome.record.captions }, null, 2));
    return outcome.exitCode;
  }
  const reviewedPath = join(dir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) {
    console.error(`publish-youtube: ${reviewedPath} não existe`);
    return 1;
  }
  const videoPath = resolve(values["video"] ?? join(dir, youtubeVideoFileName(aammdd)));
  const videoExists = existsSync(videoPath);
  const thumbPath = join(dir, YOUTUBE_THUMB_FILE);

  const plan = planYouTubePublish({
    aammdd,
    reviewedMd: readFileSync(reviewedPath, "utf8"),
    now: new Date(),
    episode: parseEpisode(values["episode"]),
    editionUrl: values["edition-url"],
    publishAt: values["publish-at"],
    title: values["title"],
    video: { path: videoPath, exists: videoExists, sizeBytes: videoExists ? statSync(videoPath).size : null },
    thumb: { path: thumbPath, exists: existsSync(thumbPath) },
    ...(flags.has("no-captions") ? {} : { captions: { path: captionsPath, exists: existsSync(captionsPath) } }),
    mode: dryRun ? "dry-run" : "upload",
  });

  for (const p of plan.premises) console.error(`[premissa] ${p}`);
  for (const w of plan.warnings) console.error(`[aviso] ${w}`);
  if (dryRun) {
    // #11532 item 3: sem capa pronta, o plano lista o que a máquina precisa
    // para gerá-la (ffmpeg, codex, Georgia, rembg). Só sonda, nunca instala.
    let coverPrereqs: ReturnType<typeof coverPrerequisites> | null = null;
    if (!plan.thumbnail) {
      const { runVideoEnvCheck } = await import("./check-video-env.ts");
      coverPrereqs = coverPrerequisites(await runVideoEnvCheck());
      console.error(`[premissa] ${coverPrereqs.summary}`);
      for (const i of coverPrereqs.items.filter((x) => !x.ok)) console.error(`[aviso] capa: falta ${i.id} (${i.detail ?? "?"}) — bloqueia ${i.blocks}. Resolver: ${i.fix}`);
    }
    // #12077: o plano mostra em que playlists temáticas o vídeo entraria (sem ID = não entra).
    const themeCfg = loadThemePlaylistsFromConfig();
    for (const w of themeCfg.warnings) console.error(w);
    const themePlaylists = planThemePlaylists(plan.themes, themeCfg);
    console.log(JSON.stringify({ dry_run: true, ...plan, theme_playlists: themePlaylists, ...(coverPrereqs ? { cover_prerequisites: coverPrereqs } : {}) }, null, 2));
    markPendingApprovalAfterDryRun(dir, aammdd, new Date(), (line) => console.error(line));
    return 0;
  }

  loadProjectEnv(ROOT);
  const podcastCfg = loadPodcastPlaylistIdFromConfig();
  const outcome = await runYouTubeUpload(defaultYouTubeUploadDeps, {
    plan,
    editionDir: dir,
    env: process.env,
    force: flags.has("force"),
    acceptPeriodMatch: values["accept-period-match"],
    readFile: (p) => readFileSync(p),
    log: (line) => console.error(line),
    d1SlotAt: loadD1SlotAt(aammdd),
    podcastPlaylistId: podcastCfg.id,
    podcastConfigWarning: podcastCfg.warning,
    themePlaylists: loadThemePlaylistsFromConfig(),
    logRunEvent: (e) => {
      logEvent(e);
    },
  });
  if (outcome.record) console.log(JSON.stringify({ dry_run: false, skipped: outcome.skipped, ...outcome.record }, null, 2));
  // #12122: com o vídeo no canal (registro gravado), a espera do "pode publicar" acabou.
  if (outcome.record && existsSync(join(dir, YOUTUBE_PUBLISHED_FILE))) clearPendingApproval(dir, (line) => console.error(line));
  cleanupPublishedVideo({ dir, edition: aammdd, kind: "horizontal", keepVideo: flags.has("keep-video"), log: console.error });
  return outcome.exitCode;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("publish-youtube:", e instanceof Error ? e.message : e) });
}
