#!/usr/bin/env node
/**
 * scripts/publish-youtube.ts (#10659)
 *
 * Publisher do vídeo diário "diar.ia.br comentada" (Pixel comentando o D1) no
 * canal `@diariabr`, via YouTube Data API v3 (`videos.insert`, resumable
 * upload, scope `youtube.upload`).
 *
 * Uso:
 *   npx tsx scripts/publish-youtube.ts AAMMDD --dry-run
 *     [--edition-dir DIR] [--video PATH] [--episode N]
 *     [--edition-url URL] [--publish-at ISO]
 *   npx tsx scripts/publish-youtube.ts AAMMDD --upload [mesmas flags] [--force]
 *
 * ## `--dry-run` (default seguro)
 *
 * Lê a edição (`02-reviewed.md`), deriva título/descrição/tags do D1, decide
 * o agendamento (06:00 BRT do dia da edição, ou na hora se já passou ou
 * faltam menos de 15 min, #10875) e
 * imprime o request de `videos.insert` + o passo de `thumbnails.set` como
 * JSON — SEM chamar a API e sem escrever nada.
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
 * vídeo no D1, #10772) — só se o estado relido for `published`, ou
 * `scheduled` com `publishAt` até o post do D1 (#10858); vídeo `private`
 * nunca vira link no D1.
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
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { parseDestaques } from "./extract-destaques.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { deriveEditionUrl } from "./lib/edition-url.ts";
import {
  YOUTUBE_THUMBNAIL_ENDPOINT,
  YOUTUBE_THUMB_FILE,
  buildYouTubeInsertRequest,
  buildYouTubeMetadata,
  deriveEpisodeNumber,
  resolveEffectiveVisibility,
  resolveYouTubeSchedule,
  YOUTUBE_API_PROJECT_AUDITED,
  youtubeVideoFileName,
  type YouTubeInsertRequest,
  type YouTubeEffectiveVisibility,
  type YouTubeMetadata,
  type YouTubeScheduleDecision,
} from "./lib/diaria/youtube-video.ts";
import {
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
import { d1SocialSlotAt, videoLinkEligibility } from "./lib/diaria/youtube-video-link-gate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface YouTubePublishPlanInput {
  aammdd: string;
  /** Conteúdo de `02-reviewed.md`. */
  reviewedMd: string;
  now: Date;
  episode?: number;
  editionUrl?: string;
  publishAt?: string;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  thumb: { path: string; exists: boolean };
  /** Projeto GCP auditado? Default `YOUTUBE_API_PROJECT_AUDITED` (false). */
  projectAudited?: boolean;
  /** Modo do CLI — muda só o texto dos avisos. Default `dry-run`. */
  mode?: "dry-run" | "upload";
}

export interface YouTubePublishPlan {
  aammdd: string;
  episode: number;
  metadata: YouTubeMetadata;
  schedule: YouTubeScheduleDecision;
  /** O que o vídeo de fato fica — difere de `schedule` sem a auditoria do GCP. */
  effective: YouTubeEffectiveVisibility;
  request: YouTubeInsertRequest;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  thumbnail: { path: string; exists: boolean; endpoint: string } | null;
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
    premises.push(`episódio #${episode} derivado da cadência diária desde 261021 (passe --episode N se algum dia ficou sem vídeo)`);
  }

  let editionUrl = input.editionUrl;
  if (!editionUrl) {
    editionUrl = deriveEditionUrl(d1.title);
    premises.push(`link da edição derivado do slug do título do D1: ${editionUrl} (passe --edition-url se o slug publicado divergir)`);
  }

  const metadata = buildYouTubeMetadata({
    aammdd: input.aammdd,
    episode,
    editionUrl,
    d1: { title: d1.title, body: d1.body, url: d1.url, category: d1.category },
  });
  const schedule = resolveYouTubeSchedule(input.aammdd, input.now, input.publishAt ?? null);
  premises.push(schedule.premise);
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

  const request = buildYouTubeInsertRequest(metadata, schedule, {
    contentType: "video/mp4",
    contentLength: input.video.sizeBytes,
  });

  return {
    aammdd: input.aammdd,
    episode,
    metadata,
    schedule,
    effective,
    request,
    video: input.video,
    thumbnail: input.thumb.exists
      ? { path: input.thumb.path, exists: true, endpoint: `${YOUTUBE_THUMBNAIL_ENDPOINT}?videoId={videoId}` }
      : null,
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
  /** Registros substituídos por `--force` (mais antigo primeiro). */
  previous_uploads?: PreviousUploadEntry[];
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
  readFile: (p: string) => Buffer;
  log: (line: string) => void;
  /**
   * Horário do post do D1 (#10858) — limite para um vídeo `scheduled` virar
   * link no D1. `null`/ausente: só vídeo `published` vira link.
   */
  d1SlotAt?: Date | null;
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
 * #10772) só quando o estado RELIDO deixa o leitor abrir o vídeo — nunca com o
 * vídeo `private` (#10858). Não sobrescreve uma URL diferente já gravada à mão.
 * Nunca lança: o vídeo já subiu, falha aqui vira aviso.
 */
export function writeD1VideoUrlAfterUpload(
  editionDir: string,
  record: Pick<YouTubePublishedRecord, "aammdd" | "url" | "state" | "rereadStatus">,
  d1SlotAt: Date | null,
  log: (line: string) => void,
  /** Default `YOUTUBE_API_PROJECT_AUDITED`; sem auditoria, `scheduled` não grava (#10865). */
  projectAudited: boolean = YOUTUBE_API_PROJECT_AUDITED,
): boolean {
  const verdict = videoLinkEligibility({
    state: record.state,
    publishAt: record.rereadStatus?.publishAt ?? null,
    d1SlotAt,
    projectAudited,
  });
  const urlFile = join(editionDir, D1_VIDEO_URL_FILE);
  if (!verdict.ok) {
    log(
      `[aviso] link do vídeo NÃO gravado em ${urlFile}: ${verdict.reason}. Depois de publicar (ou agendar antes do D1) ` +
        `no Studio, rode \`npx tsx scripts/link-video-d1.ts ${record.aammdd} --save --assume-public\` (#10858).`,
    );
    return false;
  }
  try {
    if (existsSync(urlFile)) {
      const current = readFileSync(urlFile, "utf8").trim();
      if (current && current !== record.url) {
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

/** Histórico a carregar no próximo registro, a partir do que está no disco. */
function historyFrom(read: PublishedRecordRead): PreviousUploadEntry[] {
  if (read.kind === "none") return [];
  const prev = read.kind === "done" ? read.record : read.sentinel;
  const { previous_uploads, ...rest } = prev;
  return [...(previous_uploads ?? []), rest];
}

/**
 * `--upload`: envia o plano de verdade e grava o registro. Separado do `main`
 * pra o teste injetar `deps.fetch` e o ambiente sem tocar a rede nem o `.env`.
 */
export async function runYouTubeUpload(deps: YouTubeUploadDeps, input: RunUploadInput): Promise<RunUploadOutcome> {
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
      beforeVideoBytes: () => writeSentinel({ status: "in_progress", at: deps.now().toISOString() }),
    });
  } catch (e) {
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
    video_path: plan.video.path,
    thumbnail_path: plan.thumbnail?.path ?? null,
    audit_blocked: plan.effective.auditBlocked,
    ...result,
    ...(history.length > 0 ? { previous_uploads: history } : {}),
  };

  if (result.thumbnail.attempted && !result.thumbnail.ok) {
    log(`[aviso] vídeo enviado, mas a capa falhou: ${result.thumbnail.error} — suba ${plan.thumbnail?.path} à mão no Studio`);
  }
  if (result.rereadError) log(`[aviso] releitura do estado falhou: ${result.rereadError}`);
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
  "uso: publish-youtube.ts AAMMDD (--dry-run | --upload [--force]) [--edition-dir DIR] [--video PATH] [--episode N] [--edition-url URL] [--publish-at ISO]";

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error(USAGE);
    return 2;
  }
  const dryRun = flags.has("dry-run");
  const upload = flags.has("upload");
  if (dryRun === upload) {
    console.error(
      dryRun
        ? "publish-youtube: --dry-run e --upload são exclusivos."
        : "publish-youtube: escolha o modo — --dry-run (só o plano) ou --upload (envio real; sem a auditoria do YouTube API Services o vídeo sai private, #10659).",
    );
    console.error(USAGE);
    return 2;
  }

  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
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
    video: { path: videoPath, exists: videoExists, sizeBytes: videoExists ? statSync(videoPath).size : null },
    thumb: { path: thumbPath, exists: existsSync(thumbPath) },
    mode: dryRun ? "dry-run" : "upload",
  });

  for (const p of plan.premises) console.error(`[premissa] ${p}`);
  for (const w of plan.warnings) console.error(`[aviso] ${w}`);
  if (dryRun) {
    console.log(JSON.stringify({ dry_run: true, ...plan }, null, 2));
    return 0;
  }

  loadProjectEnv(ROOT);
  const outcome = await runYouTubeUpload(defaultYouTubeUploadDeps, {
    plan,
    editionDir: dir,
    env: process.env,
    force: flags.has("force"),
    readFile: (p) => readFileSync(p),
    log: (line) => console.error(line),
    d1SlotAt: loadD1SlotAt(aammdd),
  });
  if (outcome.record) console.log(JSON.stringify({ dry_run: false, skipped: outcome.skipped, ...outcome.record }, null, 2));
  return outcome.exitCode;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("publish-youtube:", e instanceof Error ? e.message : e) });
}
