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
 *
 * ## Estado atual: só `--dry-run`
 *
 * O dry-run lê a edição (`02-reviewed.md`), deriva título/descrição/tags do
 * D1, decide o agendamento (06:00 BRT do dia da edição, ou na hora se já
 * passou) e imprime o request de `videos.insert` + o passo de
 * `thumbnails.set` como JSON — SEM chamar a API e sem escrever nada.
 *
 * O upload real ainda NÃO existe: depende do OAuth da conta dona do
 * `@diariabr` (refresh token no Doppler) e da auditoria do projeto GCP (sem
 * ela, todo upload via API sai forçado `private`). Sem `--dry-run` o script
 * recusa com exit 2 — nunca sobe nada por acidente. Pendências no #10659.
 *
 * Arquivo de vídeo: convenção `{editionDir}/diaria-comentada-{AAMMDD}.mp4`
 * (sobrescrevível com `--video`). Ausente → aviso (o passo do Stage 5 será
 * fail-soft quando o vídeo ainda não existir), não erro no dry-run.
 * Capa: `{editionDir}/04-youtube-thumb.jpg` (1280x720), opcional.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error("uso: publish-youtube.ts AAMMDD --dry-run [--edition-dir DIR] [--video PATH] [--episode N] [--edition-url URL] [--publish-at ISO]");
    return 2;
  }
  if (!flags.has("dry-run")) {
    console.error(
      "publish-youtube: upload real ainda não implementado — pendente OAuth da conta @diariabr " +
        "(refresh token youtube.upload no Doppler) e auditoria do projeto GCP (#10659). Use --dry-run.",
    );
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
  console.log(JSON.stringify({ dry_run: true, ...plan }, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("publish-youtube:", e instanceof Error ? e.message : e) });
}
