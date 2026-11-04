#!/usr/bin/env node
/**
 * clarice-video-do-mes.ts (#12092) — bloco "Vídeo do mês" na Clarice News.
 *
 * Dois passos, nenhum toca a Brevo:
 *
 *   1. Escolher o vídeo (só LEITURA na YouTube Data API, mesmo token do
 *      `publish-youtube.ts`): o horizontal público publicado no mês do
 *      conteúdo do ciclo (BRT) com mais views.
 *        npx tsx scripts/clarice-video-do-mes.ts --cycle 2610-11 --pick
 *
 *   2. Injetar o bloco no HTML renderizado do ciclo
 *      (`data/monthly/{ciclo}/_internal/cloudflare-preview.html`), logo depois
 *      do "Resumo do mês". `--image-url` é a imagem pública do destaque da
 *      edição que o vídeo comenta (a que saiu no e-mail, não a capa do
 *      YouTube). Sem `--write` só mostra o bloco; com `--write` grava
 *      (backup em `cloudflare-preview.pre-video-do-mes.html`, 1x). Idempotente.
 *        npx tsx scripts/clarice-video-do-mes.ts --cycle 2610-11 --inject \
 *          --video-id ID --title "..." [--image-url URL] [--frase "..."] [--html PATH] [--write]
 *      Sem `--video-id`, escolhe pelo passo 1 antes de injetar.
 *
 * Depois da injeção, as campanhas já agendadas recebem o HTML novo por
 * `clarice-reapply-scheduled-html.ts --cycle {ciclo}` (dry-run primeiro); os
 * envios ainda não agendados e o grupo `novos` leem o arquivo na hora.
 * Re-renderizar a mensal (`monthly-preview-cloudflare.ts`) apaga o bloco:
 * rodar o `--inject --write` de novo.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { monthlyDir } from "./lib/mensal/monthly-paths.ts";
import {
  YOUTUBE_API_BASE,
  defaultYouTubeUploadDeps,
  missingYouTubeCredentials,
  refreshYouTubeAccessToken,
  type YouTubeUploadDeps,
} from "./lib/diaria/youtube-upload.ts";
import {
  buildVideoDoMesHtml,
  contentMonthOfCycle,
  defaultVideoDoMesFrase,
  injectVideoDoMes,
  monthWindowBrtMs,
  pickVideoDoMes,
  videoDoMesUrl,
  type VideoDoMesPick,
  type YouTubeVideoItem,
} from "./lib/mensal/clarice-video-do-mes.ts";

/** Teto de páginas da playlist de uploads (50 por página, 1 unidade cada). */
const MAX_UPLOAD_PAGES = 10;

async function getJson(deps: YouTubeUploadDeps, token: string, url: string, what: string): Promise<Record<string, unknown>> {
  const res = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Lê a playlist de uploads do canal até passar do início do mês e devolve os
 * vídeos da janela com `snippet,contentDetails,statistics,status`.
 */
export async function fetchMonthVideos(
  deps: YouTubeUploadDeps,
  token: string,
  channelId: string,
  year: number,
  month: number,
): Promise<YouTubeVideoItem[]> {
  if (!/^UC/.test(channelId)) throw new Error(`YOUTUBE_CHANNEL_ID inesperado (${channelId})`);
  const { startMs } = monthWindowBrtMs(year, month);
  const uploads = `UU${channelId.slice(2)}`;
  const ids: string[] = [];
  let pageToken = "";
  let reachedBefore = false;
  for (let page = 0; page < MAX_UPLOAD_PAGES && !reachedBefore; page++) {
    const url =
      `${YOUTUBE_API_BASE}/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploads)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const json = await getJson(deps, token, url, "playlistItems.list");
    const items = (json.items ?? []) as Array<{ contentDetails?: { videoId?: string; videoPublishedAt?: string } }>;
    for (const it of items) {
      const id = it.contentDetails?.videoId;
      if (id) ids.push(id);
      const ms = Date.parse(it.contentDetails?.videoPublishedAt ?? "");
      if (!Number.isNaN(ms) && ms < startMs) reachedBefore = true;
    }
    pageToken = typeof json.nextPageToken === "string" ? json.nextPageToken : "";
    if (!pageToken) break;
  }
  if (!reachedBefore && pageToken) {
    throw new Error(`a playlist de uploads tem mais de ${MAX_UPLOAD_PAGES * 50} vídeos depois do início do mês: escolha incompleta, nada decidido`);
  }
  const videos: YouTubeVideoItem[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const json = await getJson(
      deps,
      token,
      `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails,statistics,status&id=${chunk.map(encodeURIComponent).join(",")}`,
      "videos.list",
    );
    videos.push(...((json.items ?? []) as YouTubeVideoItem[]));
  }
  return videos;
}

async function pickFromYouTube(cycle: string, env: Record<string, string | undefined>): Promise<VideoDoMesPick> {
  const missing = missingYouTubeCredentials(env);
  if (missing.length > 0) throw new Error(`faltam ${missing.join(", ")} no ambiente (Doppler → .env)`);
  const deps = defaultYouTubeUploadDeps;
  const token = await refreshYouTubeAccessToken(deps, {
    clientId: (env.GOOGLE_CLIENT_ID ?? "").trim(),
    clientSecret: (env.GOOGLE_CLIENT_SECRET ?? "").trim(),
    refreshToken: (env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
    channelId: (env.YOUTUBE_CHANNEL_ID ?? "").trim(),
  });
  const { year, month, label } = contentMonthOfCycle(cycle);
  const videos = await fetchMonthVideos(deps, token, (env.YOUTUBE_CHANNEL_ID ?? "").trim(), year, month);
  const pick = pickVideoDoMes(videos, year, month);
  if (!pick) throw new Error(`nenhum horizontal público publicado em ${label}/${year} no canal`);
  return pick;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cycle = args.values.cycle ?? "";
  contentMonthOfCycle(cycle); // valida antes de qualquer rede
  loadProjectEnv();

  if (args.flags.has("pick")) {
    const pick = await pickFromYouTube(cycle, process.env);
    console.log(JSON.stringify({ ...pick, url: videoDoMesUrl(pick.videoId, cycle) }, null, 2));
    return 0;
  }

  if (!args.flags.has("inject")) {
    console.error("uso: --cycle {ciclo} (--pick | --inject [--video-id ID --title T] [--image-url URL] [--frase F] [--html PATH] [--write])");
    return 2;
  }

  let videoId = args.values["video-id"] ?? "";
  let title = args.values.title ?? "";
  if (!videoId) {
    const pick = await pickFromYouTube(cycle, process.env);
    console.error(`[info] escolhido: ${pick.title} (${pick.videoId}, ${pick.views} views, publicado ${pick.publishedAt})`);
    videoId = pick.videoId;
    title = title || pick.title;
  }
  if (!title) throw new Error("--title obrigatório com --video-id");
  const frase = args.values.frase ?? defaultVideoDoMesFrase(cycle);
  const imageUrl = args.values["image-url"];
  if (!imageUrl) console.error("[aviso] sem --image-url: o bloco sai só com texto (a imagem é a do destaque da edição que o vídeo comenta)");
  const block = buildVideoDoMesHtml({ cycle, videoId, title, frase, imageUrl });

  const htmlPath = args.values.html
    ? resolve(args.values.html)
    : resolve(monthlyDir(cycle, { allowLegacyFallback: false }), "_internal", "cloudflare-preview.html");
  if (!existsSync(htmlPath)) throw new Error(`HTML não encontrado: ${htmlPath}`);
  const before = readFileSync(htmlPath, "utf8");
  const { html, replaced } = injectVideoDoMes(before, block);

  if (!args.flags.has("write")) {
    console.log(block);
    console.error(`[dry-run] ${replaced ? "trocaria o bloco existente" : "inseriria o bloco"} em ${htmlPath} (${before.length} → ${html.length} chars). --write grava.`);
    return 0;
  }
  if (html === before) {
    console.error(`[ok] ${htmlPath} já tem este bloco, nada a gravar`);
    return 0;
  }
  const backup = htmlPath.replace(/\.html$/, ".pre-video-do-mes.html");
  if (!existsSync(backup)) copyFileSync(htmlPath, backup);
  writeFileAtomic(htmlPath, html);
  console.error(`[ok] ${replaced ? "bloco trocado" : "bloco inserido"} em ${htmlPath} (backup: ${backup})`);
  return 0;
}

if (isMainModule(import.meta.url)) runCli(main);
