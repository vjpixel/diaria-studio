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
 * o agendamento (06:00 BRT do dia da edição, ou na hora se já passou) e
 * imprime o request de `videos.insert` + o passo de `thumbnails.set` como
 * JSON — SEM chamar a API e sem escrever nada.
 *
 * ## `--upload` (upload real, #10659)
 *
 * Mesmo plano, enviado de verdade (`scripts/lib/diaria/youtube-upload.ts`):
 * refresh token → confere o canal (`YOUTUBE_CHANNEL_ID`) → `videos.insert`
 * resumable com `privacyStatus`/`publishAt` do plano → `thumbnails.set` com
 * a capa (falha aqui não desfaz o vídeo) → releitura do `status` normalizada
 * por `resolveYouTubeState` (#573). Grava o resultado em
 * `_internal/05-youtube-published.json`; com esse registro presente, um novo
 * `--upload` recusa (exit 0, nada enviado) a menos que venha `--force`.
 *
 * Credenciais (Doppler → `.env`, nunca impressas): GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET (mesmo client do `youtube-oauth-setup.ts`),
 * YOUTUBE_REFRESH_TOKEN e YOUTUBE_CHANNEL_ID (gravados por
 * `scripts/youtube-oauth-setup.ts`, PR #10757). Ausentes → exit 1.
 *
 * **Sem a auditoria do YouTube API Services, todo upload via API sai
 * `private`** — mesmo pedindo `public` ou `publishAt`. A releitura mostra o
 * estado real ("draft") e o vídeo precisa ser publicado à mão no Studio.
 *
 * Saída: exit 0 = vídeo enviado (inclusive quando só a capa falhou — vira
 * `[aviso]`); exit 1 = nada enviado (sem credencial, sem vídeo, erro de API)
 * ou enviado sem conseguir gravar o registro; exit 2 = uso inválido.
 *
 * Fora de escopo aqui: download do vídeo pelo Drive e passo no Stage 5 (a
 * convenção de nome do arquivo ainda não foi confirmada).
 *
 * Arquivo de vídeo: convenção `{editionDir}/diaria-comentada-{AAMMDD}.mp4`
 * (sobrescrevível com `--video`). Ausente → aviso (o passo do Stage 5 será
 * fail-soft quando o vídeo ainda não existir), não erro no dry-run.
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
  missingYouTubeCredentials,
  uploadYouTubeVideo,
  type YouTubeUploadDeps,
  type YouTubeUploadResult,
} from "./lib/diaria/youtube-upload.ts";

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
      `projeto GCP sem auditoria: o plano pede ${pedido}, mas o YouTube trava todo upload via API em private — ` +
        "o vídeo sairia como rascunho privado e precisaria ser publicado à mão no Studio do YouTube (#10659)",
    );
  }

  if (!input.video.exists) {
    warnings.push(`vídeo ausente em ${input.video.path} — o upload real seria pulado (fail-soft)`);
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
}

export interface RunUploadInput {
  plan: YouTubePublishPlan;
  editionDir: string;
  env: Record<string, string | undefined>;
  force: boolean;
  readFile: (p: string) => Buffer;
  log: (line: string) => void;
}

export interface RunUploadOutcome {
  exitCode: number;
  record: YouTubePublishedRecord | null;
  skipped: boolean;
}

/** Lê o registro anterior, se houver e for desta edição. */
export function readPublishedRecord(path: string, aammdd: string): YouTubePublishedRecord | null {
  if (!existsSync(path)) return null;
  let rec: YouTubePublishedRecord;
  try {
    rec = JSON.parse(readFileSync(path, "utf8")) as YouTubePublishedRecord;
  } catch (e) {
    // Registro corrompido: não dá pra saber se o vídeo já subiu — recusar é mais seguro que duplicar.
    throw new Error(`registro ${path} ilegível (${(e as Error).message}) — confira o canal e apague/corrija o arquivo antes de --upload`);
  }
  return rec && rec.aammdd === aammdd && typeof rec.videoId === "string" && rec.videoId ? rec : null;
}

/**
 * `--upload`: envia o plano de verdade e grava o registro. Separado do `main`
 * pra o teste injetar `deps.fetch` e o ambiente sem tocar a rede nem o `.env`.
 */
export async function runYouTubeUpload(deps: YouTubeUploadDeps, input: RunUploadInput): Promise<RunUploadOutcome> {
  const { plan, log } = input;
  const recordPath = join(input.editionDir, YOUTUBE_PUBLISHED_FILE);

  let previous: YouTubePublishedRecord | null;
  try {
    previous = readPublishedRecord(recordPath, plan.aammdd);
  } catch (e) {
    log(`publish-youtube: ${(e as Error).message}. Nada foi enviado.`);
    return { exitCode: 1, record: null, skipped: false };
  }
  if (previous && !input.force) {
    log(
      `[ok] vídeo desta edição já enviado (${previous.url}, estado relido em ${previous.rereadAt}: ${previous.state}) — nada enviado. ` +
        "Use --force para subir de novo (cria OUTRO vídeo no canal).",
    );
    return { exitCode: 0, record: previous, skipped: true };
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
      video: input.readFile(plan.video.path),
      contentType: "video/mp4",
      thumbnail: plan.thumbnail ? input.readFile(plan.thumbnail.path) : null,
    });
  } catch (e) {
    const msg = e instanceof YouTubeUploadError ? `${e.message} (etapa ${e.step})` : (e as Error).message;
    log(`publish-youtube: upload falhou — ${msg}. Nada foi publicado.`);
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
  };

  if (result.thumbnail.attempted && !result.thumbnail.ok) {
    log(`[aviso] vídeo enviado, mas a capa falhou: ${result.thumbnail.error} — suba ${plan.thumbnail?.path} à mão no Studio`);
  }
  if (result.rereadError) log(`[aviso] releitura do estado falhou: ${result.rereadError}`);
  log(`[ok] vídeo enviado: ${result.url} — estado relido: ${result.state} (${describeYouTubeState(result.state)})`);

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
  return { exitCode: 0, record, skipped: false };
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
  });
  if (outcome.record) console.log(JSON.stringify({ dry_run: false, skipped: outcome.skipped, ...outcome.record }, null, 2));
  return outcome.exitCode;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("publish-youtube:", e instanceof Error ? e.message : e) });
}
