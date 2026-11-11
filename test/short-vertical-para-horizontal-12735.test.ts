/**
 * test/short-vertical-para-horizontal-12735.test.ts (#12735)
 *
 * Caminho do vertical até o horizontal do YouTube em cada rede (decisão do
 * editor no briefing do overnight 261110e: "link na bio + legenda"):
 *   - legenda com o horizontal DA edição (`05-video-url.txt`) onde a rede
 *     aceita link: LinkedIn pessoal, X, páginas e perfil do Facebook;
 *   - TikTok, Instagram e Threads: sem link na legenda, o caminho é o link da
 *     bio `diar.ia.br/video?utm_source={rede}`, servido pelo Worker do apex;
 *   - dry-run do `publish-shorts.ts` mostra o link usado por destino.
 * Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReelsCaption,
  buildShortSocialText,
  shortHorizontalLinkLine,
  shortHorizontalRoute,
} from "../scripts/lib/diaria/short-video.ts";
import { planScheduledUpdates } from "../scripts/lib/diaria/short-scheduled-update.ts";
import { planShortHorizontalLinks, planShortsPublish, readHorizontalVideoForShort } from "../scripts/publish-shorts.ts";
import { computeTwitterWeightedLength, TWITTER_CHAR_LIMIT } from "../scripts/lib/twitter-weight.ts";
import {
  LATEST_VIDEO_FALLBACK_URL,
  LATEST_VIDEO_KV_KEY,
  buildLatestVideoTarget,
  latestVideoBioLink,
  latestVideoClickCounterKey,
  latestVideoClickSource,
  parseLatestVideoRecord,
  shouldReplaceLatestVideo,
} from "../scripts/lib/shared/latest-video-redirect.ts";
import { updateLatestVideoRedirect, type LatestVideoKv } from "../scripts/set-latest-video-redirect.ts";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const URL_H = "https://youtu.be/AbCdEfGhIjK";
const LINE = `Assista no YouTube: ${URL_H}`;

const D1 = {
  title: "Você já viu IA mentir. Já viu roubar?",
  body: "Um modelo da **OpenAI** gastou o saldo de uma [carteira](https://x.com/a) de terceiros. O caso foi descoberto depois.",
};

const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1.title}](https://alignment.openai.com/x)

${D1.body}

Por que isso importa: porque sim.
`;

function page(slug: string): ResolvedFacebookPage {
  return { slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null };
}

const base = {
  aammdd: "261022",
  reviewedMd: REVIEWED,
  config: {
    publishing: {
      shorts: {
        facebook_pages: ["diaria", "vjpixel"],
        instagram: true,
        linkedin_profile: true,
        linkedin_page_repost: true,
        x: true,
        threads_profile: true,
        tiktok: true,
        tiktok_buffer_channel_id: "tiktokchan01",
        facebook_profile: true,
        schedule: { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" },
      },
    },
  },
  pages: [page("diaria"), page("vjpixel")],
  instagramReady: true,
  linkedinPersonal: { ready: true } as const,
  threadsPersonal: { ready: true } as const,
  publicVideo: { ready: true } as const,
  published: { aammdd: "261022", entries: [] },
  video: { path: "v.mp4", exists: true, sizeBytes: 10 },
  editionUrl: "https://diar.ia.br/p/x",
  now: new Date("2026-10-22T03:00:00Z"),
};

const byDest = (p: ReturnType<typeof planShortsPublish>) => Object.fromEntries(p.items.map((i) => [i.destination, i])) as Record<string, any>;

describe("#12735 legenda: horizontal da edição onde a rede aceita link", () => {
  it("rota por destino: legenda, bio, vídeo relacionado e repost", () => {
    for (const d of ["linkedin_profile", "x", "facebook:diaria", "facebook:vjpixel", "facebook_profile"]) assert.equal(shortHorizontalRoute(d), "caption", d);
    for (const d of ["tiktok", "instagram", "threads_profile"]) assert.equal(shortHorizontalRoute(d), "bio", d);
    assert.equal(shortHorizontalRoute("youtube_shorts"), "related_video");
    assert.equal(shortHorizontalRoute("linkedin_page_repost"), "repost");
    assert.equal(shortHorizontalLinkLine(null), "");
    assert.equal(shortHorizontalLinkLine(URL_H), LINE);
  });

  it("LinkedIn e X levam o link; Threads não", () => {
    const li = buildShortSocialText({ platform: "linkedin", d1: D1, horizontalLink: URL_H });
    assert.ok(li.includes(`\n\n${LINE}\n\n`), li);
    assert.ok(buildShortSocialText({ platform: "x", d1: D1, horizontalLink: URL_H }).endsWith(LINE));
    assert.ok(!buildShortSocialText({ platform: "threads", d1: D1, horizontalLink: URL_H }).includes("youtu"));
    // Sem link, o texto é o de antes.
    assert.ok(!buildShortSocialText({ platform: "linkedin", d1: D1 }).includes("youtu"));
  });

  it("X com título longo: o link nunca é cortado (sai o gancho antes) e o texto cabe em 280", () => {
    const longD1 = { title: "A".repeat(240), body: "Gancho longo que não cabe junto. Segunda frase." };
    const t = buildShortSocialText({ platform: "x", d1: longD1, horizontalLink: URL_H });
    assert.ok(t.endsWith(LINE), t);
    assert.ok(!t.includes("Gancho"));
    assert.ok(computeTwitterWeightedLength(t) <= TWITTER_CHAR_LIMIT);
  });

  it("Reels: Facebook leva o link, Instagram não (o caminho lá é a bio)", () => {
    assert.ok(buildReelsCaption({ platform: "facebook", d1: D1, horizontalLink: URL_H }).includes(LINE));
    assert.ok(!buildReelsCaption({ platform: "instagram", d1: D1, horizontalLink: URL_H }).includes("youtu"));
  });

  it("plano com 05-video-url.txt: legendas de LinkedIn, X e Facebook com o link; TikTok, Instagram e Threads sem", () => {
    const plan = planShortsPublish({ ...base, horizontalVideo: { recordTitle: null, noVideo: false, url: URL_H } });
    const p = byDest(plan);
    for (const d of ["linkedin_profile", "x", "facebook:diaria", "facebook:vjpixel", "facebook_profile"]) {
      assert.ok(typeof p[d].caption === "string" && p[d].caption.includes(LINE), `${d}: ${p[d].action} ${p[d].caption}`);
    }
    for (const d of ["tiktok", "instagram", "threads_profile"]) {
      assert.ok(!String(p[d].caption ?? "").includes("youtu"), `${d} não leva link na legenda`);
    }
  });

  it("dry-run mostra o link por destino (horizontalLinks + premissa)", () => {
    const plan = planShortsPublish({ ...base, horizontalVideo: { recordTitle: null, noVideo: false, url: URL_H } });
    const h = plan.horizontalLinks!;
    assert.deepEqual(Object.keys(h).sort(), plan.items.map((i) => i.destination).sort(), "um registro por destino do plano");
    assert.equal(h["linkedin_profile"].link, URL_H);
    assert.equal(h["x"].route, "caption");
    assert.equal(h["tiktok"].link, latestVideoBioLink("tiktok"));
    assert.equal(h["instagram"].link, latestVideoBioLink("instagram"));
    assert.equal(h["threads_profile"].link, latestVideoBioLink("threads"));
    assert.equal(h["youtube_shorts"].route, "related_video");
    assert.equal(h["youtube_shorts"].link, null);
    assert.ok(plan.premises.some((s) => s.startsWith("caminho até o horizontal (tiktok): bio https://diar.ia.br/video?utm_source=tiktok")));
  });

  it("sem 05-video-url.txt: legenda sem link e a nota diz por quê; edição sem vídeo idem", () => {
    const sem = planShortsPublish(base);
    assert.ok(!String(byDest(sem)["linkedin_profile"].caption).includes("youtu"));
    assert.equal(sem.horizontalLinks!["x"].link, null);
    assert.match(sem.horizontalLinks!["x"].note, /05-video-url\.txt ausente/);
    const noVideo = planShortsPublish({ ...base, horizontalVideo: { recordTitle: null, noVideo: true, url: URL_H } });
    assert.ok(!String(byDest(noVideo)["x"].caption).includes("youtu"));
    assert.match(noVideo.horizontalLinks!["x"].note, /sem vídeo/);
  });

  it("planShortHorizontalLinks: o repost herda o link do perfil", () => {
    assert.equal(planShortHorizontalLinks(["linkedin_page_repost"], URL_H, false)["linkedin_page_repost"].link, URL_H);
  });

  it("--update-scheduled mantém o link na legenda do Facebook e do X", () => {
    const items = planScheduledUpdates({
      entries: [
        { destination: "facebook:diaria", status: "scheduled", id: "v1", scheduled_at: "2026-10-22T15:00:00.000Z" } as any,
        { destination: "x", status: "scheduled", id: "buffer:b1", scheduled_at: "2026-10-22T15:00:00.000Z" } as any,
      ],
      d1: D1,
      now: new Date("2026-10-22T03:00:00Z"),
      coverPresent: false,
      horizontalLink: URL_H,
    });
    const fb = items.find((i) => i.destination === "facebook:diaria") as any;
    const x = items.find((i) => i.destination === "x") as any;
    assert.ok(fb.description.includes(LINE));
    assert.ok(x.text.includes(LINE));
  });

  it("readHorizontalVideoForShort lê o 05-video-url.txt; conteúdo inválido vira null (fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "short-12735-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "05-video-url.txt"), "https://www.youtube.com/watch?v=AbCdEfGhIjK\n");
      assert.equal(readHorizontalVideoForShort(dir).url, URL_H, "normalizado para youtu.be");
      writeFileSync(join(dir, "_internal", "05-video-url.txt"), "https://exemplo.com/nao-e-youtube\n");
      assert.equal(readHorizontalVideoForShort(dir).url, null);
      writeFileSync(join(dir, "_internal", "05-video-url.txt"), URL_H);
      writeFileSync(join(dir, "_internal", "no-video.json"), "{}");
      assert.equal(readHorizontalVideoForShort(dir).url, null, "edição sem vídeo não leva link");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12735 diar.ia.br/video: registro e redirect", () => {
  const rec = (aammdd: string, url = URL_H) => ({ url, aammdd, updated_at: "2026-11-10T00:00:00.000Z" });

  it("parseLatestVideoRecord aceita só youtu.be + AAMMDD; o resto vira null", () => {
    assert.deepEqual(parseLatestVideoRecord(JSON.stringify(rec("261110"))), rec("261110"));
    for (const raw of [null, "", "{", "[]", JSON.stringify({ url: "https://evil.example/x", aammdd: "261110" }), JSON.stringify({ url: URL_H, aammdd: "26111" })]) {
      assert.equal(parseLatestVideoRecord(raw), null, String(raw));
    }
  });

  it("shouldReplaceLatestVideo: só avança no tempo", () => {
    assert.equal(shouldReplaceLatestVideo(null, rec("261110")), true);
    assert.equal(shouldReplaceLatestVideo(rec("261110"), rec("261111")), true);
    assert.equal(shouldReplaceLatestVideo(rec("261111"), rec("261110")), false, "edição anterior nunca volta o link");
    assert.equal(shouldReplaceLatestVideo(rec("261110"), rec("261110")), false);
    assert.equal(shouldReplaceLatestVideo(rec("261110"), rec("261110", "https://youtu.be/ZZZZZZZZZZZ")), true, "reupload da mesma edição troca");
  });

  it("buildLatestVideoTarget: leva só os utm_*, cai na lista do canal sem registro", () => {
    const req = new URL("https://diar.ia.br/video?utm_source=tiktok&utm_medium=bio&next=https://evil.example");
    const t = new URL(buildLatestVideoTarget(req, rec("261110")));
    assert.equal(t.origin + t.pathname, URL_H);
    assert.equal(t.searchParams.get("utm_source"), "tiktok");
    assert.equal(t.searchParams.get("next"), null);
    assert.equal(new URL(buildLatestVideoTarget(new URL("https://diar.ia.br/video"), null)).toString(), LATEST_VIDEO_FALLBACK_URL);
  });

  it("latestVideoClickSource: lista fechada de redes", () => {
    assert.equal(latestVideoClickSource(new URL("https://diar.ia.br/video?utm_source=TikTok")), "tiktok");
    assert.equal(latestVideoClickSource(new URL("https://diar.ia.br/video?utm_source=qualquer")), "outro");
    assert.equal(latestVideoClickSource(new URL("https://diar.ia.br/video")), "outro");
  });

  function fakeKv(initial: Record<string, string> = {}): LatestVideoKv & { store: Record<string, string>; puts: number } {
    const store = { ...initial };
    const kv = {
      store,
      puts: 0,
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => {
        store[k] = v;
        kv.puts++;
      },
    };
    return kv;
  }

  function editionWithUrl(url: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "latest-video-12735-"));
    if (url !== null) {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "05-video-url.txt"), `${url}\n`);
    }
    return dir;
  }

  it("updateLatestVideoRedirect: sem link, plano, grava, sem mudança, edição anterior", async () => {
    const now = new Date("2026-11-11T09:00:00Z");
    const semLink = editionWithUrl(null);
    const comLink = editionWithUrl(URL_H);
    try {
      const kv = fakeKv();
      assert.equal((await updateLatestVideoRedirect({ editionDir: semLink, aammdd: "261111", kv, apply: true, now })).status, "no_link");
      assert.equal((await updateLatestVideoRedirect({ editionDir: comLink, aammdd: "261111", kv, apply: false, now })).status, "would_write");
      assert.equal(kv.puts, 0, "sem --apply não grava");
      assert.equal((await updateLatestVideoRedirect({ editionDir: comLink, aammdd: "261111", kv, apply: true, now })).status, "written");
      assert.deepEqual(parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY]), { url: URL_H, aammdd: "261111", updated_at: now.toISOString() });
      assert.equal((await updateLatestVideoRedirect({ editionDir: comLink, aammdd: "261111", kv, apply: true, now })).status, "unchanged");
      assert.equal((await updateLatestVideoRedirect({ editionDir: comLink, aammdd: "261110", kv, apply: true, now })).status, "older");
      assert.equal(kv.puts, 1);
    } finally {
      rmSync(semLink, { recursive: true, force: true });
      rmSync(comLink, { recursive: true, force: true });
    }
  });

  function workerEnv(record: string | null, counters?: Record<string, string>): { env: Env; assetCalls: number } {
    const state = { assetCalls: 0 };
    const env: Env = {
      ASSETS: { fetch: async () => { state.assetCalls++; return new Response("asset", { status: 200 }); } } as unknown as Env["ASSETS"],
      POLL: {
        get: async (key: string) => (key === LATEST_VIDEO_KV_KEY && record !== null ? (new TextEncoder().encode(record).buffer as ArrayBuffer) : null),
      },
      ...(counters
        ? { CURSOS_SUBSCRIBERS: { get: async (k: string) => counters[k] ?? null, put: async (k: string, v: string) => { counters[k] = v; } } as unknown as KVNamespace }
        : {}),
    };
    return {
      env,
      get assetCalls() {
        return state.assetCalls;
      },
    };
  }

  it("Worker: GET /video → 302 pro horizontal do KV com o UTM da bio, conta o clique por rede, nunca chega no ASSETS", async () => {
    const counters: Record<string, string> = {};
    const w = workerEnv(JSON.stringify(rec("261111")), counters);
    const res = await worker.fetch(new Request(latestVideoBioLink("instagram")), w.env);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("Location") ?? "");
    assert.equal(loc.origin + loc.pathname, URL_H);
    assert.equal(loc.searchParams.get("utm_source"), "instagram");
    assert.equal(loc.searchParams.get("utm_medium"), "bio");
    assert.equal(w.assetCalls, 0);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(counters[latestVideoClickCounterKey("instagram", day)], "1");
  });

  it("Worker: sem registro (ou ilegível) cai na lista de vídeos do canal; KV de contador ausente não derruba", async () => {
    for (const record of [null, "{lixo"]) {
      const res = await worker.fetch(new Request("https://diar.ia.br/video/"), workerEnv(record).env);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("Location"), LATEST_VIDEO_FALLBACK_URL);
    }
  });

  it("Worker: HEAD /video redireciona sem contar clique", async () => {
    const counters: Record<string, string> = {};
    const res = await worker.fetch(new Request("https://diar.ia.br/video?utm_source=tiktok", { method: "HEAD" }), workerEnv(JSON.stringify(rec("261111")), counters).env);
    assert.equal(res.status, 302);
    assert.deepEqual(counters, {});
  });
});
