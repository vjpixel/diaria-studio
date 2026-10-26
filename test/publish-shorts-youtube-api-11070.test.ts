/**
 * test/publish-shorts-youtube-api-11070.test.ts (#11070, item 5 da #10941)
 *
 * O Short sobe pela YouTube Data API (`videos.insert` private + `publishAt` no
 * horário do vertical) em vez do passo guiado no Studio. Fail-soft: sem
 * `YOUTUBE_*` volta a ser guiado. A conferência do canal procura o SHORT da
 * edição (o horizontal da mesma edição, com `utm_campaign`, não conta). Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadShortsConfig } from "../scripts/lib/diaria/short-video.ts";
import { matchEditionVideo, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { planShortsPublish, publishYouTubeShort, youtubeShortUrl } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";

const SCHEDULE = { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo da OpenAI gastou o saldo de terceiros. O caso foi descoberto depois." };
const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1.title}](https://alignment.openai.com/x)

${D1.body}

Por que isso importa: porque sim.
`;
const SHORTS = { facebook_pages: [], instagram: false, linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: false, schedule: SCHEDULE };
const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
const base = {
  aammdd: "261022",
  reviewedMd: REVIEWED,
  config: { publishing: { shorts: SHORTS } },
  pages: [page("diaria")],
  instagramReady: false,
  published: { aammdd: "261022", entries: [] },
  video: { path: "v.mp4", exists: true, sizeBytes: 10 },
  editionUrl: "https://diar.ia.br/p/x",
  youtubeApi: { ready: true } as const,
};
const yt = (p: ReturnType<typeof planShortsPublish>) => p.items.find((i) => i.destination === "youtube_shorts") as any;
// 12:00 BRT de 22/10 = 15:00Z
const SLOT = "2026-10-22T15:00:00.000Z";

describe("#11070 plano do youtube_shorts", () => {
  it("credencial pronta e horário futuro: API, agendado no horário do vertical, título #Shorts", () => {
    const p = planShortsPublish({ ...base, now: new Date("2026-10-22T10:00:00Z") });
    const item = yt(p);
    assert.equal(item.mode, "api");
    assert.equal(item.action, "publish");
    assert.equal(item.scheduledAt, SLOT);
    assert.match(item.title, /#Shorts$/);
    assert.equal(item.caption, p.youtube.description);
    assert.ok(p.premises.some((l) => l.includes("youtube_shorts: Data API, agendado")));
  });

  it("horário já passou (ou --now): público na hora", () => {
    assert.equal(yt(planShortsPublish({ ...base, now: new Date("2026-10-22T16:00:00Z") })).scheduledAt, null);
    assert.equal(yt(planShortsPublish({ ...base, now: new Date("2026-10-22T10:00:00Z"), forceNow: true })).scheduledAt, null);
  });

  it("menos de 15 min de folga: na hora (o upload terminaria depois do publishAt)", () => {
    assert.equal(yt(planShortsPublish({ ...base, now: new Date("2026-10-22T14:50:00Z") })).scheduledAt, null);
  });

  it("sem YOUTUBE_*: volta ao passo guiado, com aviso (fail-soft)", () => {
    const p = planShortsPublish({ ...base, now: new Date("2026-10-22T10:00:00Z"), youtubeApi: { ready: false, reason: "faltam YOUTUBE_REFRESH_TOKEN no ambiente" } });
    assert.equal(yt(p).mode, "guided");
    assert.equal(yt(p).action, "guided");
    assert.ok(p.warnings.some((w) => w.startsWith("youtube_shorts: faltam YOUTUBE_REFRESH_TOKEN")));
  });

  it("credencial não conferida (campo ausente) também é guiado", () => {
    const { youtubeApi: _drop, ...rest } = base;
    assert.equal(yt(planShortsPublish({ ...rest, now: new Date("2026-10-22T10:00:00Z") })).action, "guided");
  });

  it("youtube_shorts_api: false força o guiado sem aviso", () => {
    const p = planShortsPublish({ ...base, config: { publishing: { shorts: { ...SHORTS, youtube_shorts_api: false } } }, now: new Date("2026-10-22T10:00:00Z") });
    assert.equal(yt(p).action, "guided");
    assert.ok(!p.warnings.some((w) => w.startsWith("youtube_shorts")));
  });

  it("config: default ligado; não-boolean lança", () => {
    assert.equal(loadShortsConfig(undefined).youtubeShortsApi, true);
    assert.throws(() => loadShortsConfig({ publishing: { shorts: { ...SHORTS, youtube_shorts_api: "sim" } } }), /youtube_shorts_api precisa ser boolean/);
  });

  it("já registrado: skip_done (nunca sobe de novo)", () => {
    const entry: ShortPublishedEntry = { destination: "youtube_shorts", status: "send_unknown", id: "send_unknown-x", at: "2026-10-22T10:00:00Z" };
    const p = planShortsPublish({ ...base, published: { aammdd: "261022", entries: [entry] }, now: new Date("2026-10-22T10:00:00Z") });
    assert.equal(yt(p).action, "skip_done");
  });
});

describe("#11070 conferência do canal procura o Short", () => {
  const long = { id: "long1", snippet: { title: D1.title, description: "x https://diar.ia.br/?utm_campaign=261022", tags: [], publishedAt: "2026-10-22T09:00:00Z" }, status: { uploadStatus: "processed", privacyStatus: "public" } };
  const short = (over: Record<string, unknown> = {}) => ({
    id: "short1",
    snippet: { title: `${D1.title} #Shorts`, description: "gancho\n#Shorts", tags: [], publishedAt: "2026-10-22T14:00:00Z" },
    status: { uploadStatus: "processed", privacyStatus: "private", publishAt: SLOT },
    ...over,
  });

  it("o horizontal da edição (utm_campaign, título do D1) não é o Short", () => {
    assert.equal(matchEditionVideo([long], { aammdd: "261022", title: `${D1.title} #Shorts`, kind: "short" }), null);
  });

  it("modo long segue achando o horizontal (sem regressão)", () => {
    assert.equal(matchEditionVideo([long], { aammdd: "261022", title: D1.title })?.matchedBy, "edition-tag");
  });

  it("Short com o mesmo título: title", () => {
    assert.equal(matchEditionVideo([long, short()], { aammdd: "261022", title: `${D1.title} #Shorts`, kind: "short" })?.videoId, "short1");
  });

  it("Short avulso no dia da edição: só period", () => {
    const s = short({ snippet: { title: "outra coisa #shorts", description: "", tags: [], publishedAt: "2026-10-22T14:00:00Z" } });
    assert.equal(matchEditionVideo([s], { aammdd: "261022", title: `${D1.title} #Shorts`, kind: "short" })?.matchedBy, "period");
  });
});

const ENV = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w" };
const NOW = new Date("2026-10-22T10:00:00Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deps(opts: { channelVideos?: unknown[]; put?: () => Response | Promise<Response> } = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const d: YouTubeUploadDeps = {
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body });
      if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
      if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: ENV.YOUTUBE_CHANNEL_ID }] });
      const vids = opts.channelVideos ?? [];
      if (url.includes("/youtube/v3/playlistItems")) return json(200, { items: vids.map((v) => ({ contentDetails: { videoId: (v as { id: string }).id } })) });
      if (url.includes("/youtube/v3/videos?part=snippet,status")) return json(200, { items: vids });
      if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://up/sess" } });
      if (url === "https://up/sess") return opts.put ? opts.put() : json(200, { id: "shortNew", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } });
      if (url.includes("/youtube/v3/videos?part=status")) return json(200, { items: [{ id: "shortNew", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } }] });
      throw new Error(`rota não mockada: ${url}`);
    },
  };
  return { d, calls };
}
const short = (d: YouTubeUploadDeps, extra: Partial<Parameters<typeof publishYouTubeShort>[0]> = {}) =>
  publishYouTubeShort({ deps: d, env: ENV, aammdd: "261022", title: `${D1.title} #Shorts`, description: "gancho\n#Shorts", scheduledAt: SLOT, file: Buffer.from("mp4"), force: false, ...extra });

describe("#11070 publishYouTubeShort", () => {
  it("sobe agendado: private + publishAt, sem thumbnails.set, marcador antes dos bytes", async () => {
    const { d, calls } = deps();
    const markers: ShortPublishedEntry[] = [];
    const out = await short(d, { onBeforeBytes: (m) => markers.push(m) });
    assert.equal(out.entry.status, "scheduled");
    assert.equal(out.entry.scheduled_at, SLOT);
    assert.equal(out.entry.id, "shortNew");
    assert.equal(out.entry.url, youtubeShortUrl("shortNew"));
    const insert = calls.find((c) => c.url.includes("uploadType=resumable"))!;
    const body = JSON.parse(String(insert.body));
    assert.equal(body.status.privacyStatus, "private");
    assert.equal(body.status.publishAt, SLOT);
    assert.match(body.snippet.title, /#Shorts$/);
    assert.ok(!calls.some((c) => c.url.includes("thumbnails")), "Short não recebe thumbnails.set");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].status, "send_unknown");
  });

  it("na hora: public, registro published", async () => {
    const { d, calls } = deps();
    const out = await short(d, { scheduledAt: null });
    assert.equal(out.entry.status, "published");
    const body = JSON.parse(String(calls.find((c) => c.url.includes("uploadType=resumable"))!.body));
    assert.equal(body.status.privacyStatus, "public");
    assert.equal(body.status.publishAt, undefined);
  });

  it("Short da edição já no canal: registra sem enviar nada", async () => {
    const existing = { id: "manualShort", snippet: { title: `${D1.title} #Shorts`, description: "", tags: [], publishedAt: "2026-10-22T09:30:00Z" }, status: { uploadStatus: "processed", privacyStatus: "private", publishAt: SLOT } };
    const { d, calls } = deps({ channelVideos: [existing] });
    const out = await short(d);
    assert.equal(out.entry.id, "manualShort");
    assert.equal(out.entry.status, "scheduled");
    assert.ok(!calls.some((c) => c.url.includes("uploadType=resumable")), "nenhuma sessão de upload");
  });

  it("só pelo dia: lança pedindo --mark ou --force-youtube, nada enviado", async () => {
    const avulso = { id: "avulso", snippet: { title: "bastidores #shorts", description: "", tags: [], publishedAt: "2026-10-22T09:30:00Z" }, status: { uploadStatus: "processed", privacyStatus: "public" } };
    const { d, calls } = deps({ channelVideos: [avulso] });
    await assert.rejects(short(d), /--mark youtube_shorts=URL.*--force-youtube/);
    assert.ok(!calls.some((c) => c.url.includes("uploadType=resumable")));
  });

  it("--force-youtube pula a conferência", async () => {
    const avulso = { id: "avulso", snippet: { title: "bastidores #shorts", description: "", tags: [], publishedAt: "2026-10-22T09:30:00Z" }, status: { uploadStatus: "processed", privacyStatus: "public" } };
    const { d, calls } = deps({ channelVideos: [avulso] });
    const out = await short(d, { force: true });
    assert.equal(out.entry.id, "shortNew");
    assert.ok(!calls.some((c) => c.url.includes("playlistItems")));
  });

  it("falha no PUT dos bytes: send_unknown (o Short pode existir; nunca re-envia)", async () => {
    const { d } = deps({ put: () => json(400, { error: { message: "bad" } }) });
    const out = await short(d);
    assert.equal(out.entry.status, "send_unknown");
    assert.ok(out.warnings?.some((w) => w.includes("--mark youtube_shorts=URL")));
  });

  it("sem credencial: lança antes de qualquer chamada", async () => {
    const { d, calls } = deps();
    await assert.rejects(short(d, { env: {} }), /faltam GOOGLE_CLIENT_ID/);
    assert.equal(calls.length, 0);
  });
});
