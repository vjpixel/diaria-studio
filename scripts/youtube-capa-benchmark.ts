/**
 * scripts/youtube-capa-benchmark.ts (#13217)
 *
 * Benchmark visual de capas em canais de IA (PT-BR e inglês). Para cada canal
 * de `BENCHMARK_CHANNELS`: pega até 30 vídeos longos recentes (acima de 3 min,
 * com 7+ dias), calcula a mediana de views dessa amostra e separa os vídeos com
 * 2x ou mais a mediana ("acima da média", rótulo coloquial; o cálculo é sobre a
 * mediana) e os 3 mais perto dela ("típicos"). Baixa as miniaturas desses dois
 * grupos e monta uma folha de contato por canal (linha de cima = acima da
 * média, linha de baixo = típicos), para comparar a capa que performou com a
 * capa normal do MESMO canal.
 *
 * Só LÊ a YouTube Data API oficial: por canal, 1 `channels.list` + até 3
 * páginas de `playlistItems.list` + até 3 de `videos.list` (1 unidade cada),
 * até ~84 unidades para 12 canais. Usa o token do canal já existente
 * (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`; o escopo
 * do upload já cobre leitura), do `.env` do repo ou de `--dotenv`.
 *
 * Saída (fora do git, em `data/`; a data da pasta é UTC):
 *   data/youtube-capa-benchmark/{AAAA-MM-DD}/benchmark.json
 *   data/youtube-capa-benchmark/{AAAA-MM-DD}/thumbs/{videoId}.jpg   (só dos dois grupos)
 *   data/youtube-capa-benchmark/{AAAA-MM-DD}/sheets/{handle-sem-@}.jpg
 * `--no-images` grava só o JSON.
 *
 * Uso:
 *   npx tsx scripts/youtube-capa-benchmark.ts [--out-dir DIR] [--dotenv PATH] [--no-images]
 *
 * Falhas: erro de API ou de dado de um canal vira `status: "error"` no JSON e o
 * resto segue; falha de miniatura vira `missing_thumbs`/`sheet_error` no canal.
 * Erro sistêmico (401, cota, permissão) para a rodada nos canais restantes.
 * O JSON é regravado depois de cada canal, então nada coletado se perde.
 *
 * Exit: 0 com pelo menos 1 canal ok; 1 sem credencial, token ou nenhum canal
 * ok; 2 uso inválido (inclusive `--dotenv` inexistente). O nome não é `--env-file` porque o tsx repassa
 * essa flag para o Node.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  MIN_SAMPLE,
  SHORT_MAX_SECONDS,
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
const KNOWN_FLAGS = ["out-dir", "dotenv", "no-images", "help"] as const;
/** Quantos acima da média entram na folha de contato. */
const SHEET_OUTLIERS = 4;
/** Conexão pendurada não trava a rodada. */
const FETCH_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

/** Erro da API do YouTube, com a etapa e o `reason` que separa cota de permissão. */
class YouTubeApiError extends Error {
  constructor(readonly step: string, readonly status: number, readonly reason: string, message: string) {
    super(`${step}: YouTube API ${status}${reason ? ` (${reason})` : ""}: ${message}`);
  }
  /** Falha que se repetiria em todos os canais: não adianta seguir. */
  get systemic(): boolean {
    return this.status === 401 || /quotaExceeded|dailyLimitExceeded|insufficientPermissions|forbidden/.test(this.reason);
  }
}

async function getJson(step: string, url: string, token: string): Promise<Json> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch {
    throw new YouTubeApiError(step, res.status, "", `corpo não-JSON (${text.slice(0, 80)})`);
  }
  if (!res.ok) {
    const err = (body.error ?? {}) as Json;
    const reason = (((err.errors as Json[] | undefined)?.[0]?.reason as string | undefined) ?? "");
    throw new YouTubeApiError(step, res.status, reason, (err.message as string | undefined) ?? res.statusText);
  }
  return body;
}

/** Erro de dado do canal (não da API): o canal sai com `status: "error"`. */
class ChannelDataError extends Error {}

interface ChannelBase {
  handle: BenchmarkChannel["handle"];
  lang: BenchmarkChannel["lang"];
  why: string;
}
interface ChannelOk extends ChannelBase {
  status: "ok";
  channelId: string;
  title: string;
  /** `null` = o canal esconde a contagem. */
  subscribers: number | null;
  /** Vídeos descartados antes da amostra, por motivo. */
  dropped: Record<string, number>;
  ranking: ChannelRanking;
  missing_thumbs?: { id: string; reason: string }[];
  sheet_error?: string;
}
interface ChannelErr extends ChannelBase {
  status: "error";
  error: string;
}
type ChannelResult = ChannelOk | ChannelErr;

async function fetchChannel(ch: BenchmarkChannel, token: string, now: Date): Promise<ChannelOk> {
  const base = { handle: ch.handle, lang: ch.lang, why: ch.why };
  const chJson = await getJson(
    "channels.list",
    `${YOUTUBE_API_BASE}/channels?part=snippet,statistics,contentDetails&forHandle=${encodeURIComponent(ch.handle)}`,
    token,
  );
  const item = (chJson.items as Json[] | undefined)?.[0];
  if (!item) throw new ChannelDataError("handle não encontrado");
  const uploads = (((item.contentDetails as Json | undefined)?.relatedPlaylists as Json | undefined)?.uploads) as string | undefined;
  if (!uploads) throw new ChannelDataError("canal sem playlist de uploads");
  const ids: string[] = [];
  let pageToken = "";
  // Shorts entram na playlist de uploads: buscar até 150 itens para sobrar 30 longos.
  for (let page = 0; page < 3 && ids.length < 150; page++) {
    const pl = await getJson(
      "playlistItems.list",
      `${YOUTUBE_API_BASE}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${pageToken ? `&pageToken=${pageToken}` : ""}`,
      token,
    );
    for (const it of (pl.items as Json[] | undefined) ?? []) {
      const id = (it.contentDetails as Json | undefined)?.videoId;
      if (typeof id === "string") ids.push(id);
    }
    pageToken = (pl.nextPageToken as string | undefined) ?? "";
    if (!pageToken) break;
  }
  const dropped: Record<string, number> = {};
  const drop = (why: string) => (dropped[why] = (dropped[why] ?? 0) + 1);
  const videos: BenchmarkVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const vj = await getJson(
      "videos.list",
      `${YOUTUBE_API_BASE}/videos?part=snippet,statistics,contentDetails&id=${ids.slice(i, i + 50).join(",")}`,
      token,
    );
    for (const v of (vj.items as Json[] | undefined) ?? []) {
      const sn = (v.snippet ?? {}) as Json;
      const dur = parseIsoDuration(((v.contentDetails as Json | undefined)?.duration as string | undefined) ?? "");
      const views = Number((v.statistics as Json | undefined)?.viewCount ?? NaN);
      if (dur === null) { drop("duracao_invalida"); continue; }
      if (!Number.isFinite(views)) { drop("views_ocultas"); continue; }
      videos.push({
        id: v.id as string,
        title: String(sn.title ?? ""),
        publishedAt: String(sn.publishedAt ?? ""),
        durationSeconds: dur,
        views,
        thumbnailUrl: bestThumbnail(sn.thumbnails as Record<string, { url?: string }> | undefined),
      });
    }
  }
  const eligible = eligibleVideos(videos, now);
  const shorts = videos.filter((v) => v.durationSeconds <= SHORT_MAX_SECONDS).length;
  if (shorts) dropped.shorts = shorts;
  if (eligible.length < MIN_SAMPLE) {
    throw new ChannelDataError(`só ${eligible.length} vídeos longos elegíveis (${JSON.stringify(dropped)})`);
  }
  const ranking = rankChannel(eligible);
  if (ranking.medianViews <= 0) throw new ChannelDataError("mediana de views 0: ratio indefinido");
  const stats = (item.statistics ?? {}) as Json;
  return {
    ...base,
    status: "ok",
    channelId: item.id as string,
    title: String((item.snippet as Json | undefined)?.title ?? ch.handle),
    subscribers: stats.hiddenSubscriberCount || stats.subscriberCount === undefined ? null : Number(stats.subscriberCount),
    dropped,
    ranking,
  };
}

/** Baixa a miniatura (cache por id) ou diz por que não deu. Nunca lança. */
async function downloadThumb(v: RankedVideo, dir: string): Promise<{ path: string } | { reason: string }> {
  const path = join(dir, `${v.id}.jpg`);
  if (existsSync(path) && statSync(path).size > 0) return { path };
  if (!v.thumbnailUrl) return { reason: "API sem miniatura" };
  try {
    const res = await fetch(v.thumbnailUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { reason: `HTTP ${res.status}` };
    // Normaliza para 16:9 (as "high" vêm 4:3 com tarja preta).
    const buf = await sharp(Buffer.from(await res.arrayBuffer())).resize(640, 360, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
    // Grava em .tmp e renomeia: rodada interrompida não deixa jpg truncado no cache.
    writeFileSync(`${path}.tmp`, buf);
    renameSync(`${path}.tmp`, path);
    return { path };
  } catch (e) {
    return { reason: (e as Error).message };
  }
}

/** Folha de contato: linha 1 = acima da média, linha 2 = típicos, cada capa com o ratio. */
async function buildSheet(ch: ChannelOk, thumbsDir: string, out: string): Promise<void> {
  const r = ch.ranking;
  const rows = [r.outliers.slice(0, SHEET_OUTLIERS), r.typical];
  const W = 640, H = 360, LABEL = 40, COLS = Math.max(SHEET_OUTLIERS, r.typical.length, 1);
  const composites: sharp.OverlayOptions[] = [];
  const missing: { id: string; reason: string }[] = [];
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < rows[row].length; col++) {
      const v = rows[row][col];
      const got = await downloadThumb(v, thumbsDir);
      const top = row * (H + LABEL);
      if ("path" in got) composites.push({ input: got.path, left: col * W, top: top + LABEL });
      else missing.push({ id: v.id, reason: got.reason });
      const label = `${row === 0 ? "ACIMA" : "TIPICO"} ${v.ratio.toFixed(1)}x  ${v.views.toLocaleString("pt-BR")} views${"path" in got ? "" : "  SEM CAPA"}`;
      composites.push({
        input: Buffer.from(
          `<svg width="${W}" height="${LABEL}"><rect width="100%" height="100%" fill="${row === 0 ? "#00A0A0" : "#555"}"/><text x="10" y="28" font-family="sans-serif" font-size="24" fill="#fff">${label}</text></svg>`,
        ),
        left: col * W,
        top,
      });
    }
  }
  if (missing.length) ch.missing_thumbs = missing;
  await sharp({ create: { width: COLS * W, height: 2 * (H + LABEL), channels: 3, background: "#111" } })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toFile(out);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const usage = "Uso: npx tsx scripts/youtube-capa-benchmark.ts [--out-dir DIR] [--dotenv PATH] [--no-images]";
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  const args = parseArgs(argv);
  if (unknown.length || args.flags.has("help")) {
    console.error(unknown.length ? `flag desconhecida: ${unknown.join(", ")}\n${usage}` : usage);
    return unknown.length ? 2 : 0;
  }
  const envFile = resolve(args.values["dotenv"] ?? join(ROOT, ".env"));
  if (args.values["dotenv"] && !existsSync(envFile)) {
    console.error(`--dotenv não encontrado: ${envFile}`);
    return 2;
  }
  const fileVars = existsSync(envFile) ? dotenvParse(readFileSync(envFile, "utf8")) : {};
  const { credentials, missing, overridden } = resolveYouTubeReadCredentials(fileVars, process.env);
  if (overridden.length) console.error(`[premissa] ${overridden.join(", ")} do .env vencem o ambiente (#8237)`);
  if (!credentials) {
    console.error(`sem credencial do YouTube: faltam ${missing.join(", ")}`);
    return 1;
  }
  let token: string;
  try {
    token = await refreshYouTubeAccessToken(defaultYouTubeUploadDeps, { ...credentials, channelId: DIARIA_YOUTUBE_CHANNEL_ID });
  } catch (e) {
    console.error(`token do YouTube: ${(e as Error).message} (renovar com scripts/youtube-oauth-setup.ts)`);
    return 1;
  }
  const now = new Date();
  const outDir = resolve(args.values["out-dir"] ?? join(ROOT, "data", "youtube-capa-benchmark", now.toISOString().slice(0, 10)));
  const thumbsDir = join(outDir, "thumbs");
  const sheetsDir = join(outDir, "sheets");
  mkdirSync(outDir, { recursive: true });
  if (!args.flags.has("no-images")) {
    mkdirSync(thumbsDir, { recursive: true });
    mkdirSync(sheetsDir, { recursive: true });
  }
  const jsonPath = join(outDir, "benchmark.json");

  const results: ChannelResult[] = [];
  const save = () => writeFileSync(jsonPath, JSON.stringify({ schema_version: 1, generated_at: now.toISOString(), channels: results }, null, 2));
  let systemic: string | null = null;
  for (const ch of BENCHMARK_CHANNELS) {
    const base = { handle: ch.handle, lang: ch.lang, why: ch.why };
    if (systemic) {
      results.push({ ...base, status: "error", error: `não rodou: ${systemic}` });
      continue;
    }
    let r: ChannelResult;
    try {
      r = await fetchChannel(ch, token, now);
    } catch (e) {
      // Só erro de API ou de dado vira erro do canal; bug de código sobe com stack.
      if (!(e instanceof YouTubeApiError) && !(e instanceof ChannelDataError)) throw e;
      r = { ...base, status: "error", error: e.message };
      if (e instanceof YouTubeApiError && e.systemic) systemic = e.message;
    }
    results.push(r);
    if (r.status === "ok" && !args.flags.has("no-images")) {
      try {
        await buildSheet(r, thumbsDir, join(sheetsDir, `${ch.handle.slice(1)}.jpg`));
      } catch (e) {
        r.sheet_error = (e as Error).message;
      }
    }
    save();
    const summary = r.status === "ok"
      ? `${r.title}: mediana ${Math.round(r.ranking.medianViews)}, ${r.ranking.outliers.length} acima da média de ${r.ranking.sample}` +
        (r.missing_thumbs ? `, ${r.missing_thumbs.length} sem capa` : "") + (r.sheet_error ? `, folha falhou: ${r.sheet_error}` : "")
      : `ERRO ${r.error}`;
    console.error(`${ch.handle} — ${summary}`);
  }
  save();
  const ok = results.filter((r) => r.status === "ok").length;
  console.log(JSON.stringify({ path: jsonPath, ok, error: results.length - ok }));
  if (!ok) {
    console.error(systemic ? `nenhum canal ok: ${systemic}` : "nenhum canal ok");
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) void runCli(main);
