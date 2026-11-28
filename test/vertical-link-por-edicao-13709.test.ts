/**
 * test/vertical-link-por-edicao-13709.test.ts (#13709)
 *
 * Decisão do editor no briefing do overnight 261120, opção (b): o vertical
 * deixa de prometer "link na bio" (o `diar.ia.br/video` da bio leva sempre ao
 * horizontal MAIS RECENTE). O link por edição `diar.ia.br/video/{AAMMDD}` vai
 * no 1º comentário do Reels (Instagram) e na resposta ao próprio post
 * (Threads, #13209); TikTok sem link. Cobre: o link e o Worker do apex, o
 * registro por edição no KV, o plano do publish-shorts (sem o aviso "bio NÃO
 * conferida", com o texto do comentário e o passo manual onde ele não sai
 * sozinho) e o 1º comentário depois do `media_publish`. Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDITION_VIDEO_KV_KEY_PREFIX,
  LATEST_VIDEO_FALLBACK_URL,
  editionVideoClickCounterKey,
  editionVideoKvKey,
  editionVideoLink,
  effectiveEditionVideoRecord,
  matchEditionVideoPath,
  parseEditionVideoRecord,
} from "../scripts/lib/shared/latest-video-redirect.ts";
import { UTM_EMITTERS } from "../scripts/lib/shared/utm-registry.ts";
import { updateEditionVideoRedirect, type LatestVideoKv } from "../scripts/set-latest-video-redirect.ts";
import { planShortsPublish } from "../scripts/publish-shorts/plan.ts";
import { postInstagramReelFirstComment, publishInstagramReel } from "../scripts/publish-shorts/instagram.ts";
import { type GraphDeps } from "../scripts/publish-shorts/facebook.ts";
import { VERTICAL_COMMENT_CTA_LINE, VERTICAL_REPLY_CTA_LINE, buildReelsCaption, buildShortSocialText, buildTikTokPost } from "../scripts/lib/diaria/short-video.ts";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const URL_H = "https://youtu.be/AbCdEfGhIjK";
const D1 = {
  title: "Você já viu IA mentir. Já viu roubar?",
  body: "Um modelo da **OpenAI** gastou o saldo de uma carteira de terceiros. O caso foi descoberto depois.",
};
const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1.title}](https://alignment.openai.com/x)

${D1.body}

Por que isso importa: porque sim.
`;

describe("#13709 link por edição diar.ia.br/video/{AAMMDD}", () => {
  it("editionVideoLink: caminho da edição + UTM próprio (comentario), registrado no inventário", () => {
    const ig = new URL(editionVideoLink("261120", "instagram"));
    assert.equal(ig.origin + ig.pathname, "https://diar.ia.br/video/261120");
    assert.equal(ig.searchParams.get("utm_source"), "instagram");
    assert.equal(ig.searchParams.get("utm_medium"), "comentario");
    assert.equal(ig.searchParams.get("utm_campaign"), "video-horizontal");
    assert.throws(() => editionVideoLink("2611", "threads"), /AAMMDD/);
    for (const source of ["instagram", "threads"]) {
      const e = UTM_EMITTERS.find((x) => x.id === `${source}-comentario-video-horizontal-13709`);
      assert.ok(e, source);
      assert.equal(e.medium, "comentario");
      assert.equal(e.noSignupExpected, true);
    }
  });

  it("matchEditionVideoPath: só /video/{6 dígitos}, com ou sem barra", () => {
    assert.equal(matchEditionVideoPath("/video/261120"), "261120");
    assert.equal(matchEditionVideoPath("/video/261120/"), "261120");
    for (const p of ["/video", "/video/", "/videos", "/video/2611", "/video/26112000", "/video/abcdef", "/video/261120/x"]) assert.equal(matchEditionVideoPath(p), null, p);
    assert.equal(editionVideoKvKey("261120"), `${EDITION_VIDEO_KV_KEY_PREFIX}261120`);
  });

  it("registro por edição: só público conta; previous é ignorado", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const pub = parseEditionVideoRecord(JSON.stringify({ url: URL_H, aammdd: "261120", updated_at: "x", previous: { url: URL_H, aammdd: "261119" } }));
    assert.ok(pub && !("previous" in pub));
    assert.equal(effectiveEditionVideoRecord(pub, now)?.url, URL_H);
    const priv = parseEditionVideoRecord(JSON.stringify({ url: URL_H, aammdd: "261121", updated_at: "x", public_at: "2026-11-21T09:00:00Z" }));
    assert.equal(effectiveEditionVideoRecord(priv, now), null);
    assert.equal(parseEditionVideoRecord("{lixo"), null);
  });

  function workerEnv(store: Record<string, string>, counters: Record<string, string>): Env {
    return {
      ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } as unknown as Env["ASSETS"],
      POLL: { get: async (key: string) => (key in store ? (new TextEncoder().encode(store[key]).buffer as ArrayBuffer) : null) },
      CURSOS_SUBSCRIBERS: { get: async (k: string) => counters[k] ?? null, put: async (k: string, v: string) => { counters[k] = v; } } as unknown as KVNamespace,
    } as Env;
  }

  it("Worker: GET /video/{AAMMDD} → 302 pro horizontal DAQUELA edição, conta o clique por rede", async () => {
    const counters: Record<string, string> = {};
    const store = {
      [editionVideoKvKey("261120")]: JSON.stringify({ url: URL_H, aammdd: "261120", updated_at: "x" }),
      // O mais recente é outro vídeo: o link por edição nunca o usa.
      "video:latest-horizontal": JSON.stringify({ url: "https://youtu.be/ZZZZZZZZZZZ", aammdd: "261121", updated_at: "x" }),
    };
    const res = await worker.fetch(new Request(editionVideoLink("261120", "instagram")), workerEnv(store, counters));
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("Location") ?? "");
    assert.equal(loc.origin + loc.pathname, URL_H);
    assert.equal(loc.searchParams.get("utm_medium"), "comentario");
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(counters[editionVideoClickCounterKey("instagram", day)], "1");
  });

  it("Worker: edição sem registro ou horizontal ainda privado cai na lista do canal", async () => {
    const counters: Record<string, string> = {};
    const semRegistro = await worker.fetch(new Request("https://diar.ia.br/video/261119"), workerEnv({}, counters));
    assert.equal(semRegistro.status, 302);
    assert.equal(semRegistro.headers.get("Location"), LATEST_VIDEO_FALLBACK_URL);
    const futuro = new Date(Date.now() + 86_400_000).toISOString();
    const priv = await worker.fetch(
      new Request("https://diar.ia.br/video/261121/"),
      workerEnv({ [editionVideoKvKey("261121")]: JSON.stringify({ url: URL_H, aammdd: "261121", updated_at: "x", public_at: futuro }) }, counters),
    );
    assert.equal(priv.headers.get("Location"), LATEST_VIDEO_FALLBACK_URL);
  });

  it("updateEditionVideoRedirect grava a chave da edição (inclusive edição antiga) e não regrava sem mudança", async () => {
    const dir = mkdtempSync(join(tmpdir(), "video-edicao-13709-"));
    try {
      mkdirSync(join(dir, "_internal"));
      writeFileSync(join(dir, "_internal/05-video-url.txt"), `${URL_H}\n`);
      const kvStore: Record<string, string> = { "video:latest-horizontal": JSON.stringify({ url: "https://youtu.be/ZZZZZZZZZZZ", aammdd: "261125", updated_at: "x" }) };
      const kv: LatestVideoKv = { get: async (k) => kvStore[k] ?? null, put: async (k, v) => { kvStore[k] = v; } };
      const now = new Date("2026-11-20T12:00:00Z");
      const plan = await updateEditionVideoRedirect({ editionDir: dir, aammdd: "261120", kv, apply: false, now });
      assert.equal(plan.status, "would_write");
      assert.equal(kvStore[editionVideoKvKey("261120")], undefined, "dry-run não grava");
      const w = await updateEditionVideoRedirect({ editionDir: dir, aammdd: "261120", kv, apply: true, now });
      assert.equal(w.status, "written");
      assert.equal(JSON.parse(kvStore[editionVideoKvKey("261120")]).url, URL_H);
      const again = await updateEditionVideoRedirect({ editionDir: dir, aammdd: "261120", kv, apply: true, now });
      assert.equal(again.status, "unchanged");
      rmSync(join(dir, "_internal/05-video-url.txt"));
      assert.equal((await updateEditionVideoRedirect({ editionDir: dir, aammdd: "261120", kv, apply: true, now })).status, "no_link");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13709 legendas: nunca 'link na bio'", () => {
  it("Instagram aponta o 1º comentário, Threads a resposta, TikTok a chamada sem link", () => {
    const ig = buildReelsCaption({ platform: "instagram", d1: D1, ctaVertical: true });
    assert.ok(ig.includes(VERTICAL_COMMENT_CTA_LINE));
    const th = buildShortSocialText({ platform: "threads", d1: D1, ctaVertical: true });
    assert.ok(th.includes(VERTICAL_REPLY_CTA_LINE));
    const tk = buildTikTokPost({ d1: D1, ctaVertical: true }).caption;
    for (const t of [ig, th, tk]) {
      assert.doesNotMatch(t, /Vídeo completo: link na bio/);
      assert.ok(!t.includes("diar.ia.br/video"));
    }
  });
});

function page(slug: string): ResolvedFacebookPage {
  return { slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null };
}
const shortsCfg = {
  facebook_pages: ["diaria"],
  instagram: true,
  linkedin_profile: false,
  linkedin_page_repost: false,
  x: false,
  threads_profile: true,
  tiktok: true,
  tiktok_buffer_channel_id: "tiktokchan01",
  facebook_profile: false,
  schedule: { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" },
};
function plan(extra: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) {
  return planShortsPublish({
    aammdd: "261022",
    reviewedMd: REVIEWED,
    config: { publishing: { shorts: { ...shortsCfg, ...cfg } } },
    pages: [page("diaria")],
    instagramReady: true,
    linkedinPersonal: { ready: true } as const,
    threadsPersonal: { ready: true } as const,
    publicVideo: { ready: true } as const,
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/x",
    now: new Date("2026-10-22T03:00:00Z"),
    horizontalVideo: { recordTitle: D1.title, noVideo: false, url: URL_H, ctaVertical: true },
    ...extra,
  } as Parameters<typeof planShortsPublish>[0]);
}

describe("#13709 plano do publish-shorts", () => {
  it("sem o aviso 'bio NÃO conferida'; comentário e resposta com o link por edição", () => {
    const p = plan({ only: ["instagram", "threads_profile", "tiktok"], writer: "instagram-timer" });
    assert.ok(!p.warnings.some((w) => /bio NÃO conferida/.test(w)), p.warnings.join("\n"));
    assert.equal(p.horizontalLinks?.instagram.commentText, `Vídeo completo: ${editionVideoLink("261022", "instagram")}`);
    assert.equal(p.horizontalLinks?.threads_profile.replyText, `Vídeo completo: ${editionVideoLink("261022", "threads")}`);
    assert.equal(p.horizontalLinks?.tiktok.link, null);
    // O timer do 300 comenta sozinho: nada de passo manual.
    assert.ok(!p.warnings.some((w) => w.startsWith("instagram: o 1º comentário NÃO sai sozinho")));
  });

  it("fila do Worker (não comenta Reels) e rota à mão avisam o comentário manual", () => {
    const fila = plan({ only: ["instagram"], instagramQueue: { ready: true, account: "diaria" } }, { instagram_backend: "worker-r2" });
    assert.equal(fila.items.find((i) => i.destination === "instagram")?.action, "enqueue");
    assert.ok(fila.warnings.some((w) => w.startsWith("instagram: o 1º comentário NÃO sai sozinho") && w.includes("fila do Worker") && w.includes("diar.ia.br/video/261022")), fila.warnings.join("\n"));
    const mao = plan({ only: ["instagram"], writer: "instagram-timer", videoDurationSeconds: 600 }, { instagram_api_max_seconds_by_account: { diaria: 40 } });
    assert.equal(mao.items.find((i) => i.destination === "instagram")?.action, "guided");
    assert.ok(mao.warnings.some((w) => w.startsWith("instagram: o 1º comentário NÃO sai sozinho") && w.includes("postagem à mão")), mao.warnings.join("\n"));
  });

  it("sem a chamada (título diferente) não planeja comentário nem resposta", () => {
    const p = plan({ only: ["instagram", "threads_profile"], writer: "instagram-timer", horizontalVideo: { recordTitle: "Outro", noVideo: false, url: URL_H, ctaVertical: true } });
    assert.equal(p.horizontalLinks?.instagram.commentText, undefined);
    assert.equal(p.horizontalLinks?.threads_profile.replyText, undefined);
  });
});

describe("#13709 1º comentário do Reels depois do media_publish", () => {
  type Call = { url: string; body: Record<string, string> | null };
  function fakeDeps(responses: Array<() => Record<string, unknown>>): { deps: GraphDeps; calls: Call[] } {
    const calls: Call[] = [];
    let i = 0;
    const deps: GraphDeps = {
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null });
        const r = responses[i++];
        if (!r) throw new Error(`chamada inesperada: ${url}`);
        const { __http, ...json } = r() as { __http?: number };
        return new Response(JSON.stringify(json), { status: __http ?? 200 });
      },
      sleep: async () => {},
      now: () => new Date("2026-10-22T15:00:00Z"),
      log: () => {},
    };
    return { deps, calls };
  }
  const COMMENT = `Vídeo completo: ${editionVideoLink("261022", "instagram")}`;

  it("comenta no media id publicado e registra o id do comentário", async () => {
    const { deps, calls } = fakeDeps([
      () => ({ id: "c1" }),
      () => ({ status_code: "FINISHED" }),
      () => ({ id: "m1" }),
      () => ({ permalink: "https://instagram.com/reel/m1" }),
      () => ({ id: "cm1" }),
    ]);
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", { videoUrl: "https://media.diar.ia.br/v.mp4" }, "legenda", [], undefined, { firstComment: COMMENT });
    const last = calls[calls.length - 1];
    assert.match(last.url, /\/v25\.0\/m1\/comments$/);
    assert.equal(last.body?.message, COMMENT);
    assert.equal(out.entry.first_comment_id, "cm1");
    assert.equal(out.warnings, undefined);
  });

  it("falha do comentário vira aviso, nunca derruba o Reels já publicado", async () => {
    const { deps } = fakeDeps([
      () => ({ id: "c1" }),
      () => ({ status_code: "FINISHED" }),
      () => ({ id: "m1" }),
      () => ({ permalink: "https://instagram.com/reel/m1" }),
      () => ({ __http: 403, error: { message: "(#10) sem instagram_manage_comments" } }),
    ]);
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", { videoUrl: "https://media.diar.ia.br/v.mp4" }, "legenda", [], undefined, { firstComment: COMMENT });
    assert.equal(out.entry.status, "published");
    assert.equal(out.entry.first_comment_id, undefined);
    assert.ok(out.warnings?.some((w) => w.includes("1º comentário não saiu") && w.includes(COMMENT)), JSON.stringify(out.warnings));
  });

  it("sem firstComment não comenta (chamada a mais seria erro)", async () => {
    const { deps, calls } = fakeDeps([() => ({ id: "c1" }), () => ({ status_code: "FINISHED" }), () => ({ id: "m1" }), () => ({ permalink: "p" })]);
    await publishInstagramReel(deps, "ig", "tok", "v25.0", { videoUrl: "https://media.diar.ia.br/v.mp4" }, "legenda");
    assert.equal(calls.length, 4);
  });

  it("postInstagramReelFirstComment: resposta sem id é aviso", async () => {
    const { deps } = fakeDeps([() => ({})]);
    const r = await postInstagramReelFirstComment(deps, "m1", "tok", "v25.0", COMMENT);
    assert.equal(r.ok, false);
  });
});
