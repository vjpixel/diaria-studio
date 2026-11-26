/**
 * test/fb-weekly-retro-reconciliacao-14170.test.ts (#14170)
 *
 * `publish-weekly-social.ts` e `publish-retrospectiva-social.ts` chamavam
 * `publishFacebookCarouselByUrl` direto, sem a reconciliação que o publicador
 * diário ganhou no #14131: um 5xx/timeout depois de a Graph criar o post
 * agendado fazia o laço (ou a reexecução) criar um 2º post igual. Agora os
 * dois passam por `dispatchFacebookCarousel` (mesmo helper do diário,
 * `scripts/lib/facebook-publish-retry.ts`):
 *   - 5xx após o commit + post na lista de `/scheduled_posts` → adota o id,
 *     sem 2º POST;
 *   - leitura de `/scheduled_posts` falha → `send_unknown`, sem repetir;
 *   - nada criado (a página confirma) → repete como antes.
 *
 * Graph API falsa via `globalThis.fetch`. Sem rede.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideWeeklyChannelDispatch, dispatchWeeklyFacebookPage } from "../scripts/publish-weekly-social.ts";
import {
  RETROSPECTIVA_SOCIAL_DESTAQUE,
  dispatchRetrospectivaFacebookPage,
  retrospectivaSocialPublishedPath,
  runRetrospectivaSocialDispatch,
  type HistoriaImages,
  type RunRetrospectivaSocialOptions,
  type SocialDispatchInput,
} from "../scripts/publish-retrospectiva-social.ts";
import { retrospectivaPublicCtaCurto } from "../scripts/lib/mensal/retrospectiva-social.ts";
import { resolveRetrospectivaPostScheduledAts } from "../scripts/lib/mensal/retrospectiva-schedule.ts";
import { readSocialPublished, type PostEntry } from "../scripts/lib/social-published-store.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

const noSleep = async () => {};
const CAPTION = "Os destaques da semana na diar.ia.br.\n\nPor que isso importa: o preço da API caiu pela metade.";
const SCHEDULED_AT = "2030-01-05T22:00:00.000Z";
const CAROUSEL = ["https://cdn/w/1.jpg", "https://cdn/w/2.jpg", "https://cdn/w/3.jpg"];
const PAGE = { slug: "diaria", pageId: "123", token: "tok" };

type FeedBehavior = "write_then_500" | "write_then_timeout" | "500_no_write" | "ok";

/** Página falsa: `/photos` sempre responde id; `/feed` grava conforme o comportamento; `/scheduled_posts` lista. */
function fakeFacebookPage(behaviors: FeedBehavior[], opts: { scheduledPostsStatus?: number } = {}) {
  const posts: Array<{ id: string; message: string; scheduled_publish_time: number }> = [];
  let feedCalls = 0;
  let lookupCalls = 0;
  let photoSeq = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url.includes("/scheduled_posts")) {
      lookupCalls++;
      if (opts.scheduledPostsStatus && opts.scheduledPostsStatus !== 200) {
        return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: opts.scheduledPostsStatus });
      }
      return new Response(JSON.stringify({ data: posts }), { status: 200 });
    }
    if (url.endsWith("/photos")) {
      photoSeq++;
      return new Response(JSON.stringify({ id: `photo-${photoSeq}` }), { status: 200 });
    }
    if (url.endsWith("/feed")) {
      const b = behaviors[Math.min(feedCalls, behaviors.length - 1)];
      feedCalls++;
      const form = init?.body as FormData;
      if (b === "500_no_write") return new Response(JSON.stringify({ error: { message: "unknown error", is_transient: true } }), { status: 500 });
      const id = `page_post-${feedCalls}`;
      posts.push({ id, message: String(form.get("message")), scheduled_publish_time: Number(form.get("scheduled_publish_time")) });
      if (b === "write_then_500") return new Response(JSON.stringify({ error: { message: "unknown error", is_transient: true } }), { status: 500 });
      if (b === "write_then_timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    throw new Error(`fetch inesperado: ${url}`);
  }) as typeof fetch;
  return {
    posts,
    get feedCalls() { return feedCalls; },
    get lookupCalls() { return lookupCalls; },
    restore: () => { globalThis.fetch = saved; },
  };
}

let page: ReturnType<typeof fakeFacebookPage> | null = null;
afterEach(() => { page?.restore(); page = null; });

// ── Semanal ──

function weekly() {
  return dispatchWeeklyFacebookPage({
    page: PAGE,
    apiVersion: "v25.0",
    caption: CAPTION,
    imageUrls: CAROUSEL,
    scheduledAt: SCHEDULED_AT,
    destaque: "highlights",
    sleep: noSleep,
    lookupDelayMs: 0,
  });
}

describe("#14170 — semanal: carrossel do Facebook não duplica após 5xx/timeout", () => {
  it("5xx depois de criar o post: adota o post da página, sem 2º POST (o bug da issue)", async () => {
    page = fakeFacebookPage(["write_then_500", "ok"]);
    const entry = await weekly();
    assert.equal(page.feedCalls, 1, "nunca um 2º POST /feed");
    assert.equal(page.posts.length, 1);
    assert.equal(entry.status, "scheduled");
    assert.equal(entry.fb_post_id, "page_post-1");
    assert.equal(entry.recovered, "page_lookup");
    assert.equal(entry.page, "diaria");
    assert.equal(entry.destaque, "highlights");
    assert.equal(entry.scheduled_at, SCHEDULED_AT);
  });

  it("timeout depois de criar o post: idem", async () => {
    page = fakeFacebookPage(["write_then_timeout", "ok"]);
    const entry = await weekly();
    assert.equal(page.feedCalls, 1);
    assert.equal(entry.status, "scheduled");
  });

  it("5xx e /scheduled_posts ilegível: send_unknown, sem repetir o POST", async () => {
    page = fakeFacebookPage(["write_then_500", "ok"], { scheduledPostsStatus: 500 });
    const entry = await weekly();
    assert.equal(page.feedCalls, 1);
    assert.equal(entry.status, "send_unknown");
    assert.equal(entry.scheduled_at, SCHEDULED_AT);
    assert.match(String(entry.reason), /send_unknown/);
  });

  it("5xx sem criar nada: a página confirma a ausência e o retry cria um post só (como antes)", async () => {
    page = fakeFacebookPage(["500_no_write", "ok"]);
    const entry = await weekly();
    assert.equal(page.feedCalls, 2);
    assert.equal(page.posts.length, 1);
    assert.equal(entry.status, "scheduled");
    assert.equal(entry.fb_post_id, "page_post-2");
  });

  it("a retomada do semanal pula o send_unknown do Facebook (não redespacha)", () => {
    const posts: PostEntry[] = [
      { platform: "facebook", page: "diaria", destaque: "highlights", url: null, status: "send_unknown", scheduled_at: SCHEDULED_AT },
    ];
    const plan = decideWeeklyChannelDispatch(posts, "highlights", ["diaria"], { skipExisting: true, retryChannels: null });
    assert.notEqual(plan.facebook[0].decision.action, "dispatch");
  });
});

// ── Retrospectiva ──

const INPUT: SocialDispatchInput = {
  historia: "d1",
  text: CAPTION,
  imageUrls: CAROUSEL.slice(0, 1),
  carouselUrls: CAROUSEL,
  scheduledAt: SCHEDULED_AT,
};
const retro = () => dispatchRetrospectivaFacebookPage(INPUT, PAGE, "v25.0", { sleep: noSleep, lookupDelayMs: 0 });

describe("#14170 — Retrospectiva: post do Facebook não duplica após 5xx/timeout", () => {
  it("5xx depois de criar o post: adota o post da página, sem 2º POST", async () => {
    page = fakeFacebookPage(["write_then_500", "ok"]);
    const entry = await retro();
    assert.equal(page.feedCalls, 1);
    assert.equal(entry.status, "scheduled");
    assert.equal(entry.fb_post_id, "page_post-1");
    assert.equal(entry.destaque, RETROSPECTIVA_SOCIAL_DESTAQUE);
    assert.equal(entry.page, "diaria");
  });

  it("5xx e /scheduled_posts ilegível: entry send_unknown, sem repetir o POST", async () => {
    page = fakeFacebookPage(["write_then_500", "ok"], { scheduledPostsStatus: 500 });
    const entry = await retro();
    assert.equal(page.feedCalls, 1);
    assert.equal(entry.status, "send_unknown");
  });

  it("5xx sem criar nada: repete e cria um post só", async () => {
    page = fakeFacebookPage(["500_no_write", "ok"]);
    const entry = await retro();
    assert.equal(page.feedCalls, 2);
    assert.equal(page.posts.length, 1);
    assert.equal(entry.status, "scheduled");
  });

  it("5xx nas 3 tentativas sem nada criado: lança (failed, re-run seguro), como antes", async () => {
    page = fakeFacebookPage(["500_no_write"]);
    await assert.rejects(retro(), /scheduled_posts sem o post/);
    assert.equal(page.feedCalls, 3);
    assert.equal(page.posts.length, 0);
  });
});

describe("#14170 — Retrospectiva: send_unknown sai como falha e a reexecução não reenvia", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "retro-14170-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  const NOW = Date.parse("2030-01-05T12:00:00Z");
  const CONFIG = {
    publishing: {
      social: {
        timezone: "America/Sao_Paulo",
        fallback_schedule: { d1_time: "10:00", d2_time: "12:30", d3_time: "17:30", day_offset: 0 },
      },
    },
  };
  const SCHEDULE = resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2030-01-12", now: NOW });
  const P1 = "Em setembro, pesquisadores acharam mais de 15 mil edições feitas por agentes num site alemão.";
  const P2 = "Em parte das mensagens, os próprios bots combinavam como contornar as regras da empresa que os criou.";
  const P3 = "A Retrospectiva de Setembro conta o resto. Arquivo em https://diar.ia.br/p/arquivo agora.";
  const CORPO = `${P1}\n\n${P2}\n\n${P3}\n`;
  const CURTO = `Agentes fizeram 15 mil edições num site alemão. A retrospectiva conta o resto.\n\n${retrospectivaPublicCtaCurto("2609-10")}\n`;
  const cards = (h: string) => ({
    cover: `https://img/${h}-cover.jpg`,
    p1: `https://img/${h}-p1.jpg`,
    p2: `https://img/${h}-p2.jpg`,
    p3: `https://img/${h}-p3.jpg`,
    cta: `https://img/${h}-cta.jpg`,
  });

  function opts(): RunRetrospectivaSocialOptions {
    return {
      cycle: "2609-10",
      cycleDir: tmp,
      posts: ["facebook:d1"],
      texts: { d1: { corpo: CORPO, curto: CURTO } },
      titles: { d1: "Agentes saem do teste e invadem governos" },
      resolveScheduledAts: () => SCHEDULE,
      prepareImages: async (hs) => Object.fromEntries(hs.map((h) => [h, { cards: cards(h), pendingUpload: false } satisfies HistoriaImages])),
      force: new Set(),
      dryRun: false,
      disabled: {},
      xChannelId: "buffer-x",
      missingCredentials: {},
      facebookPages: [{ slug: "diaria", utmContent: null, missing: null }],
      dispatchers: {
        linkedin: async () => { throw new Error("não usado"); },
        facebook: (i) => dispatchRetrospectivaFacebookPage(i, PAGE, "v25.0", { sleep: noSleep, lookupDelayMs: 0 }),
        worker: async () => { throw new Error("não usado"); },
        cancelWorker: async () => ({ alreadyGone: false }),
      },
      now: NOW,
    };
  }

  it("1ª execução: resultado failed com send_unknown e store send_unknown; 2ª: pulado, sem novo POST", async () => {
    page = fakeFacebookPage(["write_then_500", "ok"], { scheduledPostsStatus: 500 });
    const r1 = await runRetrospectivaSocialDispatch(opts());
    const fb1 = r1.results.find((x) => x.channel === "facebook");
    assert.equal(fb1?.action, "failed");
    if (fb1?.action === "failed") assert.match(fb1.reason, /send_unknown/);
    const store = readSocialPublished(retrospectivaSocialPublishedPath(tmp, "d1"));
    assert.equal(store.posts.filter((p) => p.platform === "facebook").map((p) => p.status).join(","), "send_unknown");
    assert.equal(page.feedCalls, 1);

    const r2 = await runRetrospectivaSocialDispatch(opts());
    const fb2 = r2.results.find((x) => x.channel === "facebook");
    assert.equal(fb2?.action, "skipped", "send_unknown no store segura a reexecução");
    assert.equal(page.feedCalls, 1, "nenhum 2º POST /feed na reexecução");
  });
});
