#!/usr/bin/env node
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
 *   npx tsx scripts/publish-shorts.ts AAMMDD --publish      # publica os destinos de API
 *     [--only facebook:diaria,instagram] [--now] [--video PATH]
 *     [--edition-dir DIR] [--edition-url URL]
 *   npx tsx scripts/publish-shorts.ts AAMMDD --from-drive FILE_ID
 *                                                           # baixa o vertical do Drive pro nome da convenção
 *   npx tsx scripts/publish-shorts.ts AAMMDD --mark youtube_shorts=URL
 *                                                           # registra destino guiado já feito
 *
 * Destinos (config `publishing.shorts`, default = decisão do editor):
 *   - `facebook:{slug}` (API) — cada slug de `publishing.shorts.facebook_pages`,
 *     credencial pelas env vars da página em `publishing.social.facebook.pages`
 *     (`scripts/lib/facebook-pages.ts`). O `enabled` de lá NÃO vale aqui: ele
 *     liga os posts diários da página, não o Reels. Página sem credencial =
 *     aviso e segue (rode `scripts/facebook-page-token-setup.ts`).
 *   - `instagram` (API) — Reels no Instagram da diar.ia.br
 *     (`INSTAGRAM_BUSINESS_ACCOUNT_ID` + `INSTAGRAM_ACCESS_TOKEN`).
 *   - `youtube_shorts` e `facebook_profile` (guiados) — o JSON traz título,
 *     descrição, comentário fixado e legenda; o skill `/diaria-shorts` executa
 *     no Chrome e grava com `--mark`.
 *
 * Horário: 06:00 BRT do dia da edição se ainda não passou (Facebook agenda);
 * senão publica na hora. O Instagram não agenda Reels pela API — com horário
 * futuro ele fica pendente até rodar de novo depois das 06:00 (ou `--now`).
 *
 * Upload: as duas redes aceitam o arquivo local (upload resumable em
 * `rupload.facebook.com`), sem precisar de URL pública. Registro por destino
 * em `{edição}/_internal/06-shorts-published.json` — destino já
 * publicado/agendado é pulado (idempotente, re-rodável).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDestaques } from "./extract-destaques.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { deriveEditionUrl } from "./lib/edition-url.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import { loadResolvedFacebookPages, type ResolvedFacebookPage } from "./lib/facebook-pages.ts";
import {
  SHORTS_PUBLISHED_FILE,
  buildReelsCaption,
  buildYouTubeShortMetadata,
  isDestinationDone,
  listShortDestinations,
  loadShortsConfig,
  resolveReelsSchedule,
  shortVideoFileName,
  upsertShortEntry,
  type ShortDestination,
  type ShortPublishedEntry,
  type ShortsPublishedFile,
  type YouTubeShortMetadata,
} from "./lib/diaria/short-video.ts";
import { youtubeVideoFileName } from "./lib/diaria/youtube-video.ts";
import { gFetchRetry } from "./lib/drive-helpers.ts";
import { DRIVE_API } from "./lib/drive-constants.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH = "https://graph.facebook.com";
const RUPLOAD = "https://rupload.facebook.com";

export interface ShortsPlanItem {
  destination: string;
  mode: "api" | "guided";
  action: "publish" | "skip_done" | "skip_missing_credentials" | "pending_schedule" | "guided";
  caption?: string;
  scheduledAt?: string | null;
  detail?: string;
}

export interface ShortsPlan {
  aammdd: string;
  editionUrl: string;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  longVideo: string;
  youtube: YouTubeShortMetadata;
  items: ShortsPlanItem[];
  premises: string[];
  warnings: string[];
}

export interface ShortsPlanInput {
  aammdd: string;
  reviewedMd: string;
  now: Date;
  config: unknown;
  pages: ResolvedFacebookPage[];
  instagramReady: boolean;
  published: ShortsPublishedFile;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  editionUrl?: string;
  forceNow?: boolean;
  only?: string[] | null;
}

/** Miolo puro: o que cada destino faria, sem I/O. */
export function planShortsPublish(input: ShortsPlanInput): ShortsPlan {
  const premises: string[] = [];
  const warnings: string[] = [];
  const d1 = parseDestaques(input.reviewedMd).find((d) => d.n === 1);
  if (!d1) throw new Error("02-reviewed.md sem DESTAQUE 1 — nada para derivar o vídeo curto");

  let editionUrl = input.editionUrl;
  if (!editionUrl) {
    editionUrl = deriveEditionUrl(d1.title);
    premises.push(`link da edição derivado do slug do título do D1: ${editionUrl} (passe --edition-url se divergir)`);
  }
  const d1In = { title: d1.title, body: d1.body };
  const youtube = buildYouTubeShortMetadata({ aammdd: input.aammdd, d1: d1In, editionUrl });

  const schedule = input.forceNow
    ? ({ mode: "immediate" } as const)
    : resolveReelsSchedule(resolveEditionScheduledAt(input.aammdd), input.now);
  premises.push(
    schedule.mode === "scheduled"
      ? `Reels agendado para ${schedule.at} (06:00 BRT do dia da edição)`
      : input.forceNow
        ? "--now: publica na hora"
        : "06:00 BRT do dia da edição já passou (ou falta <10 min) — publica na hora",
  );
  if (!input.video.exists) warnings.push(`vídeo curto ausente em ${input.video.path} — nada a publicar até ele existir`);

  const cfg = loadShortsConfig(input.config);
  const only = input.only && input.only.length ? new Set(input.only) : null;
  const items: ShortsPlanItem[] = [];
  for (const dest of listShortDestinations(cfg)) {
    if (only && !only.has(dest.id)) continue;
    items.push(planDestination(dest));
  }

  function planDestination(dest: ShortDestination): ShortsPlanItem {
    if (isDestinationDone(input.published, dest.id)) {
      return { destination: dest.id, mode: dest.mode, action: "skip_done" };
    }
    if (dest.kind === "youtube_shorts") {
      return { destination: dest.id, mode: "guided", action: "guided", detail: "YouTube Studio no Chrome (API trava em private sem auditoria, #10659)" };
    }
    if (dest.kind === "facebook_profile") {
      return {
        destination: dest.id,
        mode: "guided",
        action: "guided",
        caption: buildReelsCaption({ platform: "facebook", aammdd: input.aammdd, d1: d1In, editionUrl: editionUrl!, utmContent: "perfil" }),
        detail: "perfil pessoal: a Graph API não publica em perfil de pessoa — Chrome, ou compartilhar o Reels da página",
      };
    }
    if (dest.kind === "facebook_page") {
      const page = input.pages.find((p) => p.slug === dest.slug);
      if (!page) {
        warnings.push(`página "${dest.slug}" não existe em publishing.social.facebook.pages`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: "página desconhecida" };
      }
      if (page.missing.length) {
        warnings.push(`${dest.id}: sem credencial (${page.missing.join(", ")}) — rode scripts/facebook-page-token-setup.ts`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: page.missing.join(", ") };
      }
      return {
        destination: dest.id,
        mode: "api",
        action: "publish",
        caption: buildReelsCaption({ platform: "facebook", aammdd: input.aammdd, d1: d1In, editionUrl: editionUrl!, utmContent: page.utmContent }),
        scheduledAt: schedule.mode === "scheduled" ? schedule.at : null,
      };
    }
    // instagram
    if (!input.instagramReady) {
      warnings.push("instagram: sem INSTAGRAM_BUSINESS_ACCOUNT_ID/INSTAGRAM_ACCESS_TOKEN");
      return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: "INSTAGRAM_*" };
    }
    const caption = buildReelsCaption({ platform: "instagram", aammdd: input.aammdd, d1: d1In, editionUrl: editionUrl! });
    if (schedule.mode === "scheduled") {
      return {
        destination: dest.id,
        mode: "api",
        action: "pending_schedule",
        caption,
        scheduledAt: schedule.at,
        detail: "o Instagram não agenda Reels pela API — rode de novo depois das 06:00 BRT (ou use --now)",
      };
    }
    return { destination: dest.id, mode: "api", action: "publish", caption, scheduledAt: null };
  }

  return {
    aammdd: input.aammdd,
    editionUrl,
    video: input.video,
    longVideo: youtubeVideoFileName(input.aammdd),
    youtube,
    items,
    premises,
    warnings,
  };
}

// ── Graph API ────────────────────────────────────────────────────────────────

async function graphPost(path: string, params: Record<string, string>, apiVersion: string): Promise<any> {
  const res = await fetch(`${GRAPH}/${apiVersion}/${path}`, { method: "POST", body: new URLSearchParams(params) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`POST ${path}: ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

async function graphGet(path: string, params: Record<string, string>, apiVersion: string): Promise<any> {
  const res = await fetch(`${GRAPH}/${apiVersion}/${path}?${new URLSearchParams(params)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`GET ${path}: ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

/** Envia o arquivo inteiro num POST ao rupload (offset 0). */
async function ruploadBinary(url: string, token: string, file: Buffer): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(file.length) },
    body: new Uint8Array(file),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error || json.success === false) throw new Error(`rupload: ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reels numa Página: start → upload binário → finish (PUBLISHED ou SCHEDULED). */
async function publishFacebookReel(
  page: ResolvedFacebookPage,
  apiVersion: string,
  file: Buffer,
  caption: string,
  scheduledAt: string | null,
): Promise<ShortPublishedEntry> {
  const start = await graphPost(`${page.pageId}/video_reels`, { upload_phase: "start", access_token: page.token }, apiVersion);
  const videoId: string = start.video_id;
  if (!videoId) throw new Error(`video_reels start sem video_id: ${JSON.stringify(start)}`);
  await ruploadBinary(start.upload_url ?? `${RUPLOAD}/video-upload/${apiVersion}/${videoId}`, page.token, file);
  const finish: Record<string, string> = {
    upload_phase: "finish",
    video_id: videoId,
    description: caption,
    access_token: page.token,
  };
  if (scheduledAt) {
    finish.video_state = "SCHEDULED";
    finish.scheduled_publish_time = String(Math.floor(Date.parse(scheduledAt) / 1000));
  } else {
    finish.video_state = "PUBLISHED";
  }
  const done = await graphPost(`${page.pageId}/video_reels`, finish, apiVersion);
  if (done.success === false) throw new Error(`video_reels finish recusado: ${JSON.stringify(done)}`);
  return {
    destination: `facebook:${page.slug}`,
    status: scheduledAt ? "scheduled" : "published",
    id: videoId,
    url: `https://www.facebook.com/reel/${videoId}`,
    scheduled_at: scheduledAt,
    at: new Date().toISOString(),
  };
}

/** Reels no Instagram: container resumable → upload binário → espera FINISHED → media_publish. */
async function publishInstagramReel(
  igUserId: string,
  token: string,
  apiVersion: string,
  file: Buffer,
  caption: string,
): Promise<ShortPublishedEntry> {
  const container = await graphPost(
    `${igUserId}/media`,
    { media_type: "REELS", upload_type: "resumable", caption, share_to_feed: "true", access_token: token },
    apiVersion,
  );
  const containerId: string = container.id;
  if (!containerId) throw new Error(`media (REELS) sem id: ${JSON.stringify(container)}`);
  await ruploadBinary(container.uri ?? `${RUPLOAD}/ig-api-upload/${apiVersion}/${containerId}`, token, file);
  for (let i = 0; ; i++) {
    const st = await graphGet(containerId, { fields: "status_code,status", access_token: token }, apiVersion);
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(`container ${containerId}: ${st.status_code} ${st.status ?? ""}`);
    if (i >= 60) throw new Error(`container ${containerId} não ficou pronto em 10 min (último: ${st.status_code})`);
    await sleep(10_000);
  }
  const pub = await graphPost(`${igUserId}/media_publish`, { creation_id: containerId, access_token: token }, apiVersion);
  let url: string | undefined;
  try {
    url = (await graphGet(pub.id, { fields: "permalink", access_token: token }, apiVersion)).permalink;
  } catch {
    // permalink é cosmético — o id já identifica o Reels
  }
  return { destination: "instagram", status: "published", id: pub.id, url, scheduled_at: null, at: new Date().toISOString() };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function readPublished(path: string, aammdd: string): ShortsPublishedFile {
  if (!existsSync(path)) return { aammdd, entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ShortsPublishedFile;
  return { aammdd, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

function writePublished(path: string, file: ShortsPublishedFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
}

const USAGE =
  "uso: publish-shorts.ts AAMMDD [--publish] [--only dest1,dest2] [--now] [--video PATH] [--edition-dir DIR] [--edition-url URL]\n" +
  "     publish-shorts.ts AAMMDD --mark DESTINO=URL";

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error(USAGE);
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  const publishedPath = join(dir, SHORTS_PUBLISHED_FILE);
  let published = readPublished(publishedPath, aammdd);

  if (values["mark"]) {
    const m = values["mark"].match(/^([a-z_]+(?::[a-z0-9-]+)?)=(\S+)$/);
    if (!m) {
      console.error(`--mark espera DESTINO=URL, recebido ${JSON.stringify(values["mark"])}`);
      return 2;
    }
    published = upsertShortEntry(published, { destination: m[1], status: "published", id: m[2], url: m[2], at: new Date().toISOString() });
    writePublished(publishedPath, published);
    console.log(JSON.stringify({ marked: m[1], url: m[2] }));
    return 0;
  }

  const reviewedPath = join(dir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) {
    console.error(`publish-shorts: ${reviewedPath} não existe`);
    return 1;
  }
  const videoPath = resolve(values["video"] ?? join(dir, shortVideoFileName(aammdd)));
  if (values["from-drive"]) {
    const id = values["from-drive"];
    if (!/^[\w-]{10,}$/.test(id)) {
      console.error(`--from-drive espera o id do arquivo no Drive, recebido ${JSON.stringify(id)}`);
      return 2;
    }
    const res = await gFetchRetry(`${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`);
    if (!res.ok) {
      console.error(`publish-shorts: download do Drive falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return 1;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(videoPath), { recursive: true });
    writeFileSync(videoPath, buf);
    console.error(`[ok] vídeo curto baixado do Drive (${(buf.length / 1e6).toFixed(1)} MB) → ${videoPath}`);
  }
  const videoExists = existsSync(videoPath);
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config);
  const igUserId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? "";
  const igToken = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
  const igApiVersion = process.env.INSTAGRAM_API_VERSION || apiVersion;

  const plan = planShortsPublish({
    aammdd,
    reviewedMd: readFileSync(reviewedPath, "utf8"),
    now: new Date(),
    config,
    pages,
    instagramReady: Boolean(igUserId && igToken),
    published,
    video: { path: videoPath, exists: videoExists, sizeBytes: videoExists ? statSync(videoPath).size : null },
    editionUrl: values["edition-url"],
    forceNow: flags.has("now"),
    only: values["only"] ? values["only"].split(",").map((s) => s.trim()).filter(Boolean) : null,
  });
  for (const p of plan.premises) console.error(`[premissa] ${p}`);
  for (const w of plan.warnings) console.error(`[aviso] ${w}`);

  if (!flags.has("publish")) {
    console.log(JSON.stringify({ dry_run: true, ...plan }, null, 2));
    return 0;
  }
  if (!videoExists) {
    console.error(`publish-shorts: vídeo curto ausente em ${videoPath}`);
    return 1;
  }

  const file = readFileSync(videoPath);
  const results: Array<{ destination: string; ok: boolean; entry?: ShortPublishedEntry; error?: string }> = [];
  for (const item of plan.items) {
    if (item.action !== "publish") continue;
    try {
      let entry: ShortPublishedEntry;
      if (item.destination === "instagram") {
        entry = await publishInstagramReel(igUserId, igToken, igApiVersion, file, item.caption!);
      } else {
        const slug = item.destination.slice("facebook:".length);
        const page = pages.find((p) => p.slug === slug)!;
        entry = await publishFacebookReel(page, apiVersion, file, item.caption!, item.scheduledAt ?? null);
      }
      published = upsertShortEntry(published, entry);
      writePublished(publishedPath, published); // grava a cada destino — crash no meio não republica o que já saiu
      results.push({ destination: item.destination, ok: true, entry });
      console.error(`[ok] ${item.destination}: ${entry.status} ${entry.url ?? entry.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ destination: item.destination, ok: false, error: msg });
      console.error(`[erro] ${item.destination}: ${msg}`);
    }
  }
  console.log(JSON.stringify({ dry_run: false, ...plan, results }, null, 2));
  return results.some((r) => !r.ok) ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("publish-shorts:", e instanceof Error ? e.message : e) });
}
