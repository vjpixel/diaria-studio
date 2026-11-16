/**
 * scripts/youtube-capa-benchmark.ts (#13217)
 *
 * Benchmark visual de capas em canais de IA (PT-BR e inglês). Para cada canal
 * de `BENCHMARK_CHANNELS`: pega os últimos vídeos longos (acima de 3 min, com
 * 7+ dias), calcula a mediana de views do canal e separa os vídeos com 2x ou
 * mais da mediana ("acima da média") e os 3 mais perto da mediana ("típicos").
 * Baixa as miniaturas dos dois grupos e monta uma folha de contato por canal
 * (linha de cima = acima da média, linha de baixo = típicos), para comparar a
 * capa que performou com a capa normal do MESMO canal.
 *
 * Só LÊ a YouTube Data API oficial (`channels.list` 1 unidade,
 * `playlistItems.list` 1, `videos.list` 1 por página; ~60 unidades no total).
 * Credenciais do canal (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
 * `YOUTUBE_REFRESH_TOKEN`, escopo `youtube.readonly`), lidas do `.env` do repo
 * ou de `--env-file`.
 *
 * Saída (fora do git, em `data/`):
 *   data/youtube-capa-benchmark/{AAAA-MM-DD}/benchmark.json
 *   data/youtube-capa-benchmark/{AAAA-MM-DD}/thumbs/{videoId}.jpg
 *   data/youtube-capa-benchmark/{AAAA-MM-DD}/sheets/{handle}.jpg
 *
 * Uso:
 *   npx tsx scripts/youtube-capa-benchmark.ts [--out-dir DIR] [--env-file PATH] [--no-images]
 *
 * Exit: 0 ok (canal que falha vira `error` no JSON e o resto segue);
 * 1 sem credencial ou token; 2 uso inválido.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";
import sharp from "sharp";
import { findUnknownFlags, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { DIARIA_YOUTUBE_CHANNEL_ID, resolveYouTubeReadCredentials } from "./lib/diaria/youtube-short-related.ts";
import { YOUTUBE_API_BASE, defaultYouTubeUploadDeps, refreshYouTubeAccessToken } from "./lib/diaria/youtube-upload.ts";
import {
  BENCHMARK_CHANNELS,
  bestThumbnail,
  eligibleVideos,
  parseIsoDuration,
  rankChannel,
  type BenchmarkChannel,
  type BenchmarkVideo,
  type ChannelRanking,
  type RankedVideo,
} from "./lib/diaria/youtube-capa-benchmark.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_FLAGS = ["out-dir", "env-file", "no-images", "help"] as const;
/** Quantos acima da média entram na folha de contato. */
const SHEET_OUTLIERS = 4;

type Json = Record<string, unknown>;

async function getJson(url: string, token: string): Promise<Json> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const msg = ((body.error as Json | undefined)?.message as string | undefined) ?? res.statusText;
    throw new Error(`YouTube API ${res.status}: ${msg}`);
  }
  return body;
}

interface ChannelResult {
  handle: string;
  lang: BenchmarkChannel["lang"];
  why: string;
  status: "ok" | "error";
  error?: string;
  channelId?: string;
  title?: string;
  subscribers?: number;
  ranking?: ChannelRanking;
}

async function fetchChannel(ch: BenchmarkChannel, token: string, now: Date): Promise<ChannelResult> {
  const base = { handle: ch.handle, lang: ch.lang, why: ch.why };
  try {
    const chJson = await getJson(
      `${YOUTUBE_API_BASE}/channels?part=snippet,statistics,contentDetails&forHandle=${encodeURIComponent(ch.handle)}`,
      token,
    );
    const item = (chJson.items as Json[] | undefined)?.[0];
    if (!item) return { ...base, status: "error", error: "handle não encontrado" };
    const uploads = ((item.contentDetails as Json).relatedPlaylists as Json).uploads as string;
    const ids: string[] = [];
    let pageToken = "";
    // Shorts entram na playlist de uploads: buscar até 150 itens para sobrar 30 longos.
    for (let page = 0; page < 3 && ids.length < 150; page++) {
      const pl = await getJson(
        `${YOUTUBE_API_BASE}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${pageToken ? `&pageToken=${pageToken}` : ""}`,
        token,
      );
      for (const it of (pl.items as Json[] | undefined) ?? []) ids.push((it.contentDetails as Json).videoId as string);
      pageToken = (pl.nextPageToken as string | undefined) ?? "";
      if (!pageToken) break;
    }
    const videos: BenchmarkVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const vj = await getJson(
        `${YOUTUBE_API_BASE}/videos?part=snippet,statistics,contentDetails&id=${ids.slice(i, i + 50).join(",")}`,
        token,
      );
      for (const v of (vj.items as Json[] | undefined) ?? []) {
        const sn = v.snippet as Json;
        const dur = parseIsoDuration(((v.contentDetails as Json).duration as string) ?? "");
        const views = Number((v.statistics as Json | undefined)?.viewCount ?? NaN);
        if (dur === null || !Number.isFinite(views)) continue;
        videos.push({
          id: v.id as string,
          title: sn.title as string,
          publishedAt: sn.publishedAt as string,
          durationSeconds: dur,
          views,
          thumbnailUrl: bestThumbnail(sn.thumbnails as Record<string, { url?: string }>),
        });
      }
    }
    const eligible = eligibleVideos(videos, now);
    if (eligible.length < 10) return { ...base, status: "error", error: `só ${eligible.length} vídeos longos elegíveis` };
    return {
      ...base,
      status: "ok",
      channelId: item.id as string,
      title: (item.snippet as Json).title as string,
      subscribers: Number((item.statistics as Json).subscriberCount ?? 0),
      ranking: rankChannel(eligible),
    };
  } catch (e) {
    return { ...base, status: "error", error: (e as Error).message };
  }
}

async function downloadThumb(v: RankedVideo, dir: string): Promise<string | null> {
  const path = join(dir, `${v.id}.jpg`);
  if (existsSync(path)) return path;
  if (!v.thumbnailUrl) return null;
  const res = await fetch(v.thumbnailUrl);
  if (!res.ok) return null;
  // Normaliza para 16:9 (as "high" vêm 4:3 com tarja preta).
  const buf = await sharp(Buffer.from(await res.arrayBuffer())).resize(640, 360, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
  writeFileSync(path, buf);
  return path;
}

/** Folha de contato: linha 1 = acima da média, linha 2 = típicos, cada capa com o ratio. */
async function buildSheet(ch: ChannelResult, thumbsDir: string, out: string): Promise<void> {
  const r = ch.ranking!;
  const rows = [r.outliers.slice(0, SHEET_OUTLIERS), r.typical];
  const W = 640, H = 360, LABEL = 40, COLS = Math.max(SHEET_OUTLIERS, r.typical.length, 1);
  const composites: sharp.OverlayOptions[] = [];
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < rows[row].length; col++) {
      const v = rows[row][col];
      const p = await downloadThumb(v, thumbsDir);
      const top = row * (H + LABEL);
      if (p) composites.push({ input: p, left: col * W, top: top + LABEL });
      const label = `${row === 0 ? "ACIMA" : "TIPICO"} ${v.ratio.toFixed(1)}x  ${v.views.toLocaleString("pt-BR")} views`;
      composites.push({
        input: Buffer.from(
          `<svg width="${W}" height="${LABEL}"><rect width="100%" height="100%" fill="${row === 0 ? "#00A0A0" : "#555"}"/><text x="10" y="28" font-family="sans-serif" font-size="24" fill="#fff">${label}</text></svg>`,
        ),
        left: col * W,
        top,
      });
    }
  }
  await sharp({ create: { width: COLS * W, height: 2 * (H + LABEL), channels: 3, background: "#111" } })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toFile(out);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const usage = "Uso: npx tsx scripts/youtube-capa-benchmark.ts [--out-dir DIR] [--env-file PATH] [--no-images]";
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  const args = parseArgs(argv);
  if (unknown.length || args.flags.has("help")) {
    console.error(unknown.length ? `flag desconhecida: ${unknown.join(", ")}\n${usage}` : usage);
    return unknown.length ? 2 : 0;
  }
  const envFile = resolve(args.values["env-file"] ?? join(ROOT, ".env"));
  const fileVars = existsSync(envFile) ? dotenvParse(readFileSync(envFile, "utf8")) : {};
  const { credentials, missing } = resolveYouTubeReadCredentials(fileVars, process.env);
  if (!credentials) {
    console.error(`sem credencial do YouTube: faltam ${missing.join(", ")}`);
    return 1;
  }
  const token = await refreshYouTubeAccessToken(defaultYouTubeUploadDeps, { ...credentials, channelId: DIARIA_YOUTUBE_CHANNEL_ID });
  const now = new Date();
  const outDir = resolve(args.values["out-dir"] ?? join(ROOT, "data", "youtube-capa-benchmark", now.toISOString().slice(0, 10)));
  const thumbsDir = join(outDir, "thumbs");
  const sheetsDir = join(outDir, "sheets");
  mkdirSync(thumbsDir, { recursive: true });
  mkdirSync(sheetsDir, { recursive: true });

  const results: ChannelResult[] = [];
  for (const ch of BENCHMARK_CHANNELS) {
    const r = await fetchChannel(ch, token, now);
    results.push(r);
    const summary = r.status === "ok"
      ? `${r.title}: mediana ${Math.round(r.ranking!.medianViews)}, ${r.ranking!.outliers.length} acima da média de ${r.ranking!.sample}`
      : `ERRO ${r.error}`;
    console.error(`${ch.handle} — ${summary}`);
    if (r.status === "ok" && !args.flags.has("no-images")) {
      await buildSheet(r, thumbsDir, join(sheetsDir, `${ch.handle.slice(1)}.jpg`));
    }
  }
  const jsonPath = join(outDir, "benchmark.json");
  writeFileSync(jsonPath, JSON.stringify({ generated_at: now.toISOString(), channels: results }, null, 2));
  console.log(JSON.stringify({ path: jsonPath, ok: results.filter((r) => r.status === "ok").length, error: results.filter((r) => r.status === "error").length }));
  return 0;
}

if (isMainModule(import.meta.url)) void runCli(main);
