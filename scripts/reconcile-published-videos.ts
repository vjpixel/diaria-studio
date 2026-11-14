/** #13009: leitura pós-disparo por ID de Reels, Shorts e YouTube horizontal.
 * Só GET nas plataformas. Erros de leitura preservam o registro; vencido sem
 * confirmação vira send_unknown (nunca failed/republicável). Stage 0 olha 3 dias.
 * Uso: tsx scripts/reconcile-published-videos.ts --edition-dir DIR [--lookback-days 3] [--dry-run]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { withFileLock } from "./lib/file-lock.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadResolvedFacebookPages } from "./lib/facebook-pages.ts";
import { lookbackEditions } from "./lib/social-reconcile-targets.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { resolveYouTubeReadCredentials } from "./lib/diaria/youtube-short-related.ts";
import { defaultYouTubeUploadDeps, refreshYouTubeAccessToken } from "./lib/diaria/youtube-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type RecordData = Record<string, any>;
export interface VideoObservation {
  published?: boolean;
  publishedAt?: string;
  url?: string;
  scheduledAt?: string;
}

/** Ausência de sinal não é evidência de falha. A API deve confirmar o estado. */
export function reconcileVideoRecord(entry: RecordData, observation: VideoObservation, now: Date, horizontal = false): RecordData {
  const statusKey = horizontal ? "state" : "status";
  if (entry.cancelled_at || !["scheduled", "send_unknown", "unknown"].includes(entry[statusKey])) return entry;
  if (observation.published === true) {
    return { ...entry, [statusKey]: "published", url: observation.url ?? entry.url,
      ...(observation.publishedAt ? { published_at: observation.publishedAt } : {}),
      verification_note: undefined };
  }
  const scheduledAt = observation.scheduledAt ?? entry.scheduled_at ?? entry.requested?.publishAt;
  const ms = Date.parse(scheduledAt ?? "");
  if (observation.published !== false || !Number.isFinite(ms) || now.getTime() - ms < 6 * 3_600_000) return entry;
  return { ...entry, [statusKey]: horizontal ? "unknown" : "send_unknown", verification_note: "video_not_public_after_schedule" };
}

export type VideoReader = (entry: RecordData, horizontal: boolean) => Promise<VideoObservation | null>;

/** Leitura fora do lock; reaplica só se a entrada não mudou nesse intervalo. */
export async function reconcileVideoFile(path: string, reader: VideoReader, now: Date, dryRun = false): Promise<number> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RecordData;
  const horizontal = !Array.isArray(raw.entries);
  const entries: RecordData[] = horizontal ? [raw] : raw.entries;
  const replacements = new Map<string, RecordData>();
  for (const entry of entries) {
    if (entry.cancelled_at || !["scheduled", "send_unknown", "unknown"].includes(entry[horizontal ? "state" : "status"])) continue;
    const due = Date.parse(entry.scheduled_at ?? entry.requested?.publishAt ?? "");
    if (!Number.isFinite(due) || due > now.getTime()) continue;
    try {
      const observation = await reader(entry, horizontal);
      if (!observation) continue;
      const next = reconcileVideoRecord(entry, observation, now, horizontal);
      if (JSON.stringify(next) === JSON.stringify(entry)) continue;
      replacements.set(JSON.stringify(entry), next);
      if (next.verification_note) console.error(`ALARME #13009: ${path} ${entry.id ?? entry.videoId}: ${next.verification_note}`);
    } catch {
      console.warn(`[reconcile-published-videos] ${path} ${entry.id ?? entry.videoId}: leitura inconclusiva, registro preservado.`);
    }
  }
  if (!dryRun && replacements.size) withFileLock(`${path}.lock`, () => {
    const current = JSON.parse(readFileSync(path, "utf8"));
    const replace = (e: RecordData) => replacements.get(JSON.stringify(e)) ?? e;
    const next = horizontal ? replace(current) : { ...current, entries: current.entries.map(replace) };
    writeFileAtomic(path, JSON.stringify(next, null, 2) + "\n");
  });
  return replacements.size;
}

export function videoRegistryPaths(dir: string): string[] {
  const internal = join(dir, "_internal");
  if (!existsSync(internal)) return [];
  return readdirSync(internal).filter((name) => name === "05-youtube-published.json" || /^06-shorts-published.*\.json$/.test(name)).sort().map((name) => join(internal, name));
}

async function main(): Promise<number> {
  loadProjectEnv(ROOT);
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (!values["edition-dir"]) throw new Error("--edition-dir obrigatório");
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const fb = loadResolvedFacebookPages(ROOT, config, process.env);
  const fileVars = existsSync(join(ROOT, ".env")) ? dotenvParse(readFileSync(join(ROOT, ".env"))) : {};
  const yt = resolveYouTubeReadCredentials(fileVars, process.env);
  let token: Promise<string> | undefined;
  const reader: VideoReader = async (entry, horizontal) => {
    const id = horizontal ? entry.videoId : entry.id;
    if (typeof id !== "string" || !id || id.startsWith("send_unknown-")) return null;
    if (horizontal || entry.destination === "youtube_shorts") {
      if (!yt.credentials) throw new Error("credenciais YouTube ausentes");
      token ??= refreshYouTubeAccessToken(defaultYouTubeUploadDeps, { ...yt.credentials, channelId: "" });
      const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${await token}` }, signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error("YouTube read failed");
      const data = await res.json() as RecordData;
      if (!Array.isArray(data.items)) throw new Error("YouTube response without items");
      const item = data.items.find((v: RecordData) => v.id === id);
      if (!item) return { published: false };
      if (!item?.status?.privacyStatus) return null;
      return { published: item.status.privacyStatus === "public", scheduledAt: item.status.publishAt,
        publishedAt: item.status.privacyStatus === "public" ? item.snippet?.publishedAt : undefined,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` };
    }
    if (typeof entry.destination !== "string" || !entry.destination.startsWith("facebook:")) return null;
    const page = fb.pages.find((p) => p.slug === entry.destination.slice("facebook:".length));
    if (!page || page.missing.length) throw new Error("credenciais Facebook ausentes");
    const res = await fetch(`https://graph.facebook.com/${fb.apiVersion}/${encodeURIComponent(id)}?fields=published,scheduled_publish_time,permalink_url`, {
      headers: { Authorization: `OAuth ${page.token}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error("Facebook read failed");
    const data = await res.json() as RecordData;
    if (data.error || typeof data.published !== "boolean") return null;
    return { published: data.published, url: data.permalink_url,
      scheduledAt: typeof data.scheduled_publish_time === "number" ? new Date(data.scheduled_publish_time * 1000).toISOString() : undefined };
  };
  const dir = resolve(ROOT, values["edition-dir"]);
  const lookback = Number(values["lookback-days"] ?? 1);
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > 30) throw new Error("--lookback-days deve ser 1–30");
  const dates = lookbackEditions(basename(dir), lookback);
  const dirs = [dir, ...dates.slice(1).map((date) => resolve(ROOT, editionDir(date)))];
  for (const d of dirs) for (const path of videoRegistryPaths(d)) {
    const changes = await reconcileVideoFile(path, reader, new Date(), flags.has("dry-run"));
    console.log(`[reconcile-published-videos] ${path}: ${changes} atualização(ões)${flags.has("dry-run") ? " (dry-run)" : ""}.`);
  }
  return 0;
}
if (isMainModule(import.meta.url)) runCli(main);
