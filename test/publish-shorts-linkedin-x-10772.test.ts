/**
 * test/publish-shorts-linkedin-x-10772.test.ts (#10772)
 *
 * Vertical nativo no LinkedIn pessoal (Videos API) + repost da página + X via
 * Buffer, dentro do `publish-shorts.ts`. Nenhum teste toca rede: a LinkedIn é
 * um `fetch` falso que grava as chamadas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LINKEDIN_PAGE_ACCOUNT,
  buildShortSocialText,
  isDestinationDone,
  loadShortsConfig,
  parseShortsPublishedFile,
  planLinkedInRepostSlot,
  upsertShortEntry,
} from "../scripts/lib/diaria/short-video.ts";
import { parseMarkArg, planShortsPublish, publishLinkedInProfileVideo } from "../scripts/publish-shorts.ts";
import { postVideoToPersonalProfile, validateUploadInstructions, LINKEDIN_VIDEOS_FINALIZE_URL, LINKEDIN_VIDEOS_INIT_URL } from "../scripts/lib/linkedin-video.ts";
import { LINKEDIN_POSTS_URL } from "../scripts/lib/linkedin-personal.ts";
import { gridFromLinkedInPersonalIntent, gridFromShortsPublished, type ScheduledSlot } from "../scripts/lib/social-slot-planner.ts";
import { computeTwitterWeightedLength } from "../scripts/lib/twitter-weight.ts";
import { resolveShortEntryState } from "../scripts/lib/publish-state.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo da **OpenAI** gastou o saldo de terceiros. O caso foi descoberto depois." };
const EDITION_URL = "https://diar.ia.br/p/voce-ja-viu-ia-mentir-ja-viu-roubar";
const YT = "https://youtu.be/MMyBVHVQELI";
const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1.title}](https://alignment.openai.com/x)

${D1.body}

Por que isso importa: porque sim.
`;

function page(slug: string): ResolvedFacebookPage {
  return { slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null };
}

const CREDS = { accessToken: "tok-pessoal", personUrn: "urn:li:person:abc", expiresAt: null };
const brt = (hhmm: string) => new Date(`2026-10-22T${hhmm}:00-03:00`).toISOString();

describe("#10772 texto do vertical no LinkedIn e no X", () => {
  it("LinkedIn: vídeo completo do YouTube + edição com UTM linkedin/video/{AAMMDD}", () => {
    const t = buildShortSocialText({ platform: "linkedin", aammdd: "261022", d1: D1, editionUrl: EDITION_URL, videoUrl: YT });
    assert.match(t, /^Você já viu IA mentir/);
    assert.ok(t.includes(`Vídeo completo no YouTube: ${YT}`));
    assert.ok(t.includes(`${EDITION_URL}?utm_source=linkedin&utm_medium=video&utm_campaign=261022`));
  });

  it("sem URL do vídeo completo, o texto aponta pro canal", () => {
    const t = buildShortSocialText({ platform: "linkedin", aammdd: "261022", d1: D1, editionUrl: EDITION_URL, videoUrl: null });
    assert.ok(t.includes("https://www.youtube.com/@diariabr"));
  });

  it("X: utm_source=twitter e ≤280 ponderado mesmo com título enorme", () => {
    const t = buildShortSocialText({ platform: "x", aammdd: "261022", d1: { title: "palavra ".repeat(60), body: "" }, editionUrl: EDITION_URL, videoUrl: YT });
    assert.ok(computeTwitterWeightedLength(t) <= 280);
    assert.ok(t.includes("utm_source=twitter&utm_medium=video&utm_campaign=261022"));
    assert.ok(t.includes(YT));
  });
});

describe("#10772 config", () => {
  const mk = (extra: object) => ({ publishing: { shorts: { facebook_pages: ["diaria"], instagram: true, ...extra } } });
  it("o platform.config.json real liga LinkedIn pessoal, repost e X (decisão do briefing 261022b)", () => {
    const cfg = loadShortsConfig(JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")));
    assert.equal(cfg.linkedinProfile, true);
    assert.equal(cfg.linkedinPageRepost, true);
    assert.equal(cfg.x, true);
  });
  it("repost sem o vídeo do perfil lança; não-boolean lança", () => {
    assert.throws(() => loadShortsConfig(mk({ linkedin_profile: false, linkedin_page_repost: true })), /exige linkedin_profile/);
    assert.throws(() => loadShortsConfig(mk({ x: "sim" })), /x precisa ser boolean/);
  });
});

describe("#10772 plano", () => {
  // 4 posts da página no dia (rotação #10305): 08:00, 10:00, 12:15, 17:15 BRT.
  const pageGrid: ScheduledSlot[] = ["08:00", "10:00", "12:15", "17:15"].map((h) => ({ account: LINKEDIN_PAGE_ACCOUNT, at: brt(h) }));
  const base = {
    aammdd: "261022",
    reviewedMd: REVIEWED,
    config: {},
    pages: [page("diaria"), page("vjpixel")],
    instagramReady: true,
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: EDITION_URL,
    youtubeVideoUrl: YT,
    linkedinPersonal: { ready: true } as const,
    publicVideo: { ready: true } as const,
    grid: pageGrid,
  };
  const by = (p: ReturnType<typeof planShortsPublish>) => Object.fromEntries(p.items.map((i) => [i.destination, i])) as Record<string, any>;

  it("antes do horário: LinkedIn pessoal pendente (Posts API não agenda), X vai pra Buffer com dueAt", () => {
    const p = by(planShortsPublish({ ...base, now: new Date("2026-10-22T03:00:00Z") }));
    assert.equal(p.linkedin_profile.action, "pending_schedule");
    assert.equal(p.x.action, "buffer");
    assert.equal(p.x.scheduledAt, brt("12:00"));
    assert.ok(p.x.caption.includes("utm_source=twitter"));
  });

  it("depois do horário (ou --now): LinkedIn pessoal publica com o texto e o título do D1", () => {
    const p = by(planShortsPublish({ ...base, now: new Date("2026-10-22T03:00:00Z"), forceNow: true }));
    assert.equal(p.linkedin_profile.action, "publish");
    assert.equal(p.linkedin_profile.title, D1.title);
    assert.ok(p.linkedin_profile.caption.includes("utm_source=linkedin&utm_medium=video&utm_campaign=261022"));
    assert.equal(p.x.scheduledAt, null);
  });

  it("repost da página: ≥30 min depois do perfil e ≥2 h de cada um dos 4 posts da página", () => {
    const plan = planShortsPublish({ ...base, now: new Date("2026-10-22T03:00:00Z") });
    const repost = by(plan).linkedin_page_repost;
    assert.equal(repost.action, "guided");
    const t = Date.parse(repost.at);
    assert.ok(t >= Date.parse(brt("12:30")), `repost ${repost.at} antes de 30 min do perfil (12:00)`);
    for (const s of pageGrid) assert.ok(Math.abs(t - Date.parse(s.at)) >= 120 * 60_000, `repost ${repost.at} colado em ${s.at}`);
    assert.ok(!plan.slots.some((s) => s.destination === "linkedin_page_repost"), "o repost não é slot do vertical");
  });

  it("sem credencial do LinkedIn e sem R2: os dois são pulados com aviso, nunca somem", () => {
    const p = planShortsPublish({
      ...base,
      now: new Date("2026-10-22T16:00:00Z"),
      linkedinPersonal: { ready: false, reason: "LINKEDIN_PERSONAL_ACCESS_TOKEN ausente" },
      publicVideo: { ready: false, reason: "falta SHORTS_R2_BUCKET" },
    });
    const items = by(p);
    assert.equal(items.linkedin_profile.action, "skip_missing_credentials");
    assert.equal(items.x.action, "skip_missing_credentials");
    assert.ok(p.warnings.some((w) => w.startsWith("linkedin_profile: LINKEDIN_PERSONAL_ACCESS_TOKEN ausente")));
    assert.ok(p.warnings.some((w) => w.startsWith("x:") && w.includes("SHORTS_R2_BUCKET")));
  });

  it("envio ambíguo registrado (send_unknown) nunca é re-postado na rodada seguinte", () => {
    const published = upsertShortEntry({ aammdd: "261022", entries: [] }, { destination: "linkedin_profile", status: "send_unknown", id: "send_unknown-x", at: "2026-10-22T15:00:00Z" });
    const roundTrip = parseShortsPublishedFile(JSON.stringify(published), "261022");
    assert.equal(isDestinationDone(roundTrip, "linkedin_profile"), true);
    const p = by(planShortsPublish({ ...base, now: new Date("2026-10-22T16:00:00Z"), published: roundTrip }));
    assert.equal(p.linkedin_profile.action, "skip_done");
  });
});

describe("#10772 grade", () => {
  it("destinos do vertical viram contas da grade; o 4º post pessoal ocupa linkedin:pessoal", () => {
    const g = gridFromShortsPublished({
      entries: [
        { destination: "linkedin_profile", at: "2026-10-22T15:00:00Z" },
        { destination: "linkedin_page_repost", at: "2026-10-22T17:00:00Z" },
        { destination: "x", scheduled_at: "2026-10-22T15:00:00Z", at: "2026-10-22T03:00:00Z" },
      ],
    });
    assert.deepEqual(g.map((s) => s.account), ["linkedin:pessoal", "linkedin:diaria", "twitter:diaria"]);
    assert.equal(g[2].at, "2026-10-22T15:00:00Z");
    assert.deepEqual(gridFromLinkedInPersonalIntent({ status: "armed", scheduled_at: "2026-10-22T20:15:00Z" }).map((s) => s.account), ["linkedin:pessoal"]);
    assert.deepEqual(gridFromLinkedInPersonalIntent({ status: "expired", scheduled_at: "2026-10-22T20:15:00Z" }), []);
  });

  it("repost sem horário com 2 h de folga na janela: cai em 30 min depois do perfil, com aviso", () => {
    const s = planLinkedInRepostSlot({ aammdd: "261022", profileAt: brt("21:50"), grid: [] });
    assert.equal(s.at, brt("22:20"));
    assert.match(s.warning ?? "", /não achou horário/);
  });
});

/** LinkedIn falsa: grava cada chamada e responde pela URL. */
function fakeLinkedIn(opts: { statuses?: string[]; postStatus?: number; postThrows?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const statuses = [...(opts.statuses ?? ["PROCESSING", "AVAILABLE"])];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method, body });
    if (url === LINKEDIN_VIDEOS_INIT_URL) {
      return Response.json({
        value: {
          video: "urn:li:video:V1",
          uploadToken: "",
          uploadInstructions: [
            { uploadUrl: "https://up.example/p1", firstByte: 0, lastByte: 5 },
            { uploadUrl: "https://up.example/p2", firstByte: 6, lastByte: 9 },
          ],
        },
      });
    }
    if (url.startsWith("https://up.example/")) return new Response(null, { status: 200, headers: { etag: `etag-${url.slice(-2)}` } });
    if (url === LINKEDIN_VIDEOS_FINALIZE_URL) return new Response(null, { status: 200 });
    if (url.startsWith("https://api.linkedin.com/rest/videos/")) return Response.json({ status: statuses.shift() ?? "AVAILABLE" });
    if (url === LINKEDIN_POSTS_URL) {
      if (opts.postThrows) throw new Error("socket hang up");
      return new Response(null, { status: opts.postStatus ?? 201, headers: { "x-restli-id": "urn:li:share:99" } });
    }
    throw new Error(`URL inesperada ${url}`);
  };
  return { calls, deps: { fetchFn, sleep: async () => {}, log: () => {}, now: () => new Date("2026-10-22T15:00:00Z") } };
}

describe("#10772 Videos API do LinkedIn", () => {
  const bytes = new Uint8Array(10);

  it("initializeUpload → PUT das partes → finalize com os ETags → espera AVAILABLE → post com a URN do vídeo", async () => {
    const li = fakeLinkedIn();
    const r = await postVideoToPersonalProfile({ deps: li.deps, creds: CREDS, apiVersion: "202608", text: "Texto", title: "Título", bytes });
    assert.deepEqual(r, { ok: true, postUrn: "urn:li:share:99", imageUsed: false });
    assert.equal(li.calls[0].body.initializeUploadRequest.owner, "urn:li:person:abc");
    assert.equal(li.calls[0].body.initializeUploadRequest.fileSizeBytes, 10);
    const fin = li.calls.find((c) => c.url === LINKEDIN_VIDEOS_FINALIZE_URL)!;
    assert.deepEqual(fin.body.finalizeUploadRequest.uploadedPartIds, ["etag-p1", "etag-p2"]);
    const post = li.calls.find((c) => c.url === LINKEDIN_POSTS_URL)!;
    assert.equal(post.body.author, "urn:li:person:abc");
    assert.deepEqual(post.body.content, { media: { id: "urn:li:video:V1", title: "Título" } });
  });

  it("PROCESSING_FAILED aborta ANTES do post (nada no perfil)", async () => {
    const li = fakeLinkedIn({ statuses: ["PROCESSING_FAILED"] });
    await assert.rejects(publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título"), /PROCESSING_FAILED/);
    assert.ok(!li.calls.some((c) => c.url === LINKEDIN_POSTS_URL));
  });

  it("timeout no POST do post vira send_unknown (registrado, nunca re-tentado)", async () => {
    const li = fakeLinkedIn({ postThrows: true });
    const out = await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título");
    assert.equal(out.entry.status, "send_unknown");
    assert.match(out.warnings?.[0] ?? "", /confira o perfil/);
    assert.equal(resolveShortEntryState(out.entry), "unknown");
  });

  it("sucesso registra published com a URL do post", async () => {
    const out = await publishLinkedInProfileVideo(fakeLinkedIn().deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título");
    assert.equal(out.entry.status, "published");
    assert.equal(out.entry.url, "https://www.linkedin.com/feed/update/urn:li:share:99/");
  });

  it("instruções de upload com buraco ou que não cobrem o arquivo são recusadas antes do 1º PUT", () => {
    assert.throws(() => validateUploadInstructions([{ uploadUrl: "https://a", firstByte: 0, lastByte: 3 }, { uploadUrl: "https://b", firstByte: 5, lastByte: 9 }], 10), /não contíguas/);
    assert.throws(() => validateUploadInstructions([{ uploadUrl: "https://a", firstByte: 0, lastByte: 3 }], 10), /cobrem 4 bytes/);
  });
});

describe("#10772 registro e estado", () => {
  it("--mark x=buffer:{id} aceita o id do post da Buffer (ainda sem URL)", () => {
    assert.deepEqual(parseMarkArg("x=buffer:abc_123"), { destination: "x", url: null, bufferId: "abc_123" });
    assert.deepEqual(parseMarkArg("linkedin_page_repost=https://www.linkedin.com/feed/update/x"), { destination: "linkedin_page_repost", url: "https://www.linkedin.com/feed/update/x" });
    assert.throws(() => parseMarkArg("youtube_shorts=buffer:abc"), /DESTINO=URL/);
  });

  it("estado normalizado (#573): agendado no passado ou sem horário não é 'publicado'", () => {
    const now = new Date("2026-10-22T16:00:00Z");
    assert.equal(resolveShortEntryState({ status: "published" }, now), "published");
    assert.equal(resolveShortEntryState({ status: "scheduled", scheduled_at: "2026-10-22T22:00:00Z" }, now), "scheduled");
    assert.equal(resolveShortEntryState({ status: "scheduled", scheduled_at: "2026-10-22T15:00:00Z" }, now), "unknown");
    assert.equal(resolveShortEntryState({ status: "scheduled", scheduled_at: null }, now), "unknown");
  });
});
