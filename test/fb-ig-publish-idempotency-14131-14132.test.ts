/**
 * test/fb-ig-publish-idempotency-14131-14132.test.ts (#14131, #14132)
 *
 * #14131 — `publish-facebook.ts` repetia o POST agendado (`/photos`, `/feed` do
 * carrossel) em 5xx/timeout: a Graph criava o post e perdia a resposta, a 2ª
 * tentativa criava um 2º post igual no mesmo horário. Agora a falha ambígua
 * consulta `/{page-id}/scheduled_posts` antes de repetir, e na dúvida grava
 * `send_unknown` (pulado na retomada) em vez de `failed`.
 *
 * #14132 — `publish-instagram.ts` sem `--schedule` refazia container +
 * publicação quando o `/media_publish` publicava e a resposta se perdia.
 * Agora o `/media_publish` só se repete sobre o mesmo container e o estado
 * depois da falha vem do `status_code` do container.
 *
 * Graph API falsa via `globalThis.fetch` (Facebook) e dependências injetadas
 * (Instagram). Sem rede.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { dispatchFacebookPost, findExistingFacebookPost } from "../scripts/publish-facebook.ts";
import {
  FacebookPublishError,
  isAmbiguousFacebookFailure,
  matchFacebookScheduledPost,
  publishFacebookWithReconciliation,
} from "../scripts/lib/facebook-publish-retry.ts";
import {
  matchInstagramMediaByCaption,
  publishInstagramImmediate,
  type InstagramContainerStatusResult,
} from "../scripts/lib/instagram-immediate-publish.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const noSleep = async () => {};
const CAPTION = "A OpenAI lançou um modelo novo hoje.\n\nPor que isso importa: muda o preço da API para quem constrói.";
const SCHEDULED_AT = "2030-01-02T12:15:00.000Z";
const SCHEDULED_UNIX = Math.floor(Date.parse(SCHEDULED_AT) / 1000);
const CAROUSEL = ["https://cdn/x/1.jpg", "https://cdn/x/2.jpg"];

type FeedBehavior = "write_then_500" | "write_then_timeout" | "500_no_write" | "ok" | "400";

/**
 * Página do Facebook falsa: `/photos` (fotos não publicadas do carrossel)
 * sempre responde id; `/feed` grava o post agendado conforme o comportamento
 * da tentativa; `/scheduled_posts` lista o que foi gravado.
 */
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
      if (b === "400") return new Response(JSON.stringify({ error: { message: "bad", code: 100 } }), { status: 400 });
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

function dispatch(scheduledAt: string | null = SCHEDULED_AT) {
  return dispatchFacebookPost({
    pageId: "123",
    pageToken: "tok",
    apiVersion: "v25.0",
    caption: CAPTION,
    scheduledAt,
    imagePath: "/nao/usado.jpg",
    carouselImageUrls: CAROUSEL,
    label: "facebook/d1",
    sleep: noSleep,
    lookupDelayMs: 0,
  });
}

describe("#14131 — Facebook: retry do POST agendado não duplica o post", () => {
  let page: ReturnType<typeof fakeFacebookPage> | null = null;
  afterEach(() => { page?.restore(); page = null; });

  it("5xx depois de criar o post: adota o post da página, sem 2º POST (o bug da issue)", async () => {
    page = fakeFacebookPage(["write_then_500", "ok"]);
    const out = await dispatch();
    assert.equal(out.kind, "created");
    assert.equal(page.feedCalls, 1, "nunca um 2º POST /feed");
    assert.equal(page.posts.length, 1, "um post só na página");
    if (out.kind === "created") {
      assert.equal(out.recovered, "page_lookup");
      assert.equal(out.result.id, "page_post-1");
    }
  });

  it("timeout depois de criar o post: idem", async () => {
    page = fakeFacebookPage(["write_then_timeout", "ok"]);
    const out = await dispatch();
    assert.equal(out.kind, "created");
    assert.equal(page.feedCalls, 1);
    assert.equal(page.posts.length, 1);
  });

  it("5xx sem criar nada: a página confirma a ausência e o retry cria um post só", async () => {
    page = fakeFacebookPage(["500_no_write", "ok"]);
    const out = await dispatch();
    assert.equal(out.kind, "created");
    assert.equal(page.feedCalls, 2);
    assert.equal(page.posts.length, 1);
    assert.ok(page.lookupCalls >= 1);
  });

  it("5xx e /scheduled_posts ilegível: send_unknown, sem novo POST", async () => {
    page = fakeFacebookPage(["write_then_500", "ok"], { scheduledPostsStatus: 500 });
    const out = await dispatch();
    assert.equal(out.kind, "send_unknown");
    assert.equal(page.feedCalls, 1);
    assert.equal(page.posts.length, 1);
    if (out.kind === "send_unknown") assert.match(out.reason, /send_unknown/);
  });

  it("post sem agendamento (sem o que consultar): falha ambígua vira send_unknown, sem novo POST", async () => {
    page = fakeFacebookPage(["write_then_500", "ok"]);
    const out = await dispatch(null);
    assert.equal(out.kind, "send_unknown");
    assert.equal(page.feedCalls, 1);
    assert.equal(page.lookupCalls, 0);
  });

  it("4xx prova a recusa: repete sem consultar e termina failed (re-run seguro)", async () => {
    page = fakeFacebookPage(["400"]);
    const out = await dispatch();
    assert.equal(out.kind, "failed");
    assert.equal(page.feedCalls, 3);
    assert.equal(page.lookupCalls, 0);
    assert.equal(page.posts.length, 0);
  });

  it("5xx nas 3 tentativas sem nada criado: failed (provado), um POST por tentativa", async () => {
    page = fakeFacebookPage(["500_no_write"]);
    const out = await dispatch();
    assert.equal(out.kind, "failed");
    assert.equal(page.feedCalls, 3);
    assert.equal(page.posts.length, 0);
    if (out.kind === "failed") assert.match(out.reason, /scheduled_posts sem o post/);
  });

  it("a retomada pula send_unknown e published; só failed é refeito", () => {
    const mk = (status: PostEntry["status"], destaque: string): PostEntry => ({
      platform: "facebook", destaque, url: null, status, scheduled_at: null,
    });
    const posts = [mk("send_unknown", "d1"), mk("published", "d2"), mk("failed", "d3")];
    assert.ok(findExistingFacebookPost(posts, "diaria", "d1"));
    assert.ok(findExistingFacebookPost(posts, "diaria", "d2"));
    assert.equal(findExistingFacebookPost(posts, "diaria", "d3"), undefined);
  });
});

describe("#14131 — peças puras", () => {
  it("classificação: 5xx/rede ambíguos; 4xx e DNS/conexão recusada não", () => {
    assert.equal(isAmbiguousFacebookFailure(new FacebookPublishError("x", { ambiguous: true, httpStatus: 500 })), true);
    assert.equal(isAmbiguousFacebookFailure(new FacebookPublishError("x", { ambiguous: false, httpStatus: 400 })), false);
    assert.equal(isAmbiguousFacebookFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })), false);
    assert.equal(isAmbiguousFacebookFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), true);
    assert.equal(isAmbiguousFacebookFailure(new Error("inesperado")), true);
  });

  it("match exige o mesmo horário e o mesmo início de legenda", () => {
    const items = [
      { id: "a", message: CAPTION, scheduled_publish_time: SCHEDULED_UNIX + 60 },
      { id: "b", message: "outra legenda", scheduled_publish_time: SCHEDULED_UNIX },
      { id: "c", message: CAPTION.replace(/\n/g, " \n "), scheduled_publish_time: SCHEDULED_UNIX },
    ];
    assert.equal(matchFacebookScheduledPost(items, CAPTION, SCHEDULED_UNIX), "c");
    assert.equal(matchFacebookScheduledPost(items.slice(0, 2), CAPTION, SCHEDULED_UNIX), null);
  });

  it("leitura com o post ausente na 1ª e presente na 2ª: adota (a listagem atrasa)", async () => {
    let reads = 0;
    let sends = 0;
    const out = await publishFacebookWithReconciliation({
      label: "facebook/d1",
      send: async () => { sends++; throw new FacebookPublishError("HTTP 500", { ambiguous: true, httpStatus: 500 }); },
      lookup: async () => (++reads >= 2 ? { status: "found", id: "p1" } : { status: "absent" }),
      sleep: noSleep,
      log: () => {},
    });
    assert.equal(out.kind, "created");
    assert.equal(sends, 1);
    assert.equal(reads, 2);
  });
});

describe("#14132 — Instagram imediato: /media_publish falho nunca republica", () => {
  function igDeps(publish: Array<"ok" | "throw">, statuses: InstagramContainerStatusResult[], media: string | null = "media-1") {
    const calls = { create: 0, publish: 0, status: 0, find: 0 };
    let p = 0;
    let s = 0;
    return {
      calls,
      deps: {
        label: "instagram/d1",
        createContainer: async () => `container-${++calls.create}`,
        publishContainer: async (id: string) => {
          calls.publish++;
          const b = publish[Math.min(p++, publish.length - 1)];
          if (b === "throw") throw new Error("Instagram /media_publish HTTP 500: unknown");
          return `published-from-${id}`;
        },
        containerStatus: async () => {
          calls.status++;
          return statuses[Math.min(s++, statuses.length - 1)];
        },
        findPublishedMedia: async () => { calls.find++; return media; },
        sleep: noSleep,
        log: () => {},
      },
    };
  }

  it("publicou mas a resposta se perdeu: container PUBLISHED, adota o post, sem novo container nem nova publicação (o bug da issue)", async () => {
    const { calls, deps } = igDeps(["throw", "ok"], [{ status: "ok", statusCode: "PUBLISHED" }]);
    const out = await publishInstagramImmediate(deps);
    assert.equal(out.kind, "published");
    assert.equal(calls.create, 1, "um container só");
    assert.equal(calls.publish, 1, "um /media_publish só");
    if (out.kind === "published") {
      assert.equal(out.mediaId, "media-1");
      assert.equal(out.recovered, "container_status");
    }
  });

  it("PUBLISHED sem localizar o post na listagem: published sem id, sem republicar", async () => {
    const { calls, deps } = igDeps(["throw"], [{ status: "ok", statusCode: "PUBLISHED" }], null);
    const out = await publishInstagramImmediate(deps);
    assert.equal(out.kind, "published");
    assert.equal(calls.publish, 1);
    if (out.kind === "published") assert.equal(out.mediaId, null);
  });

  it("container FINISHED (não publicou): repete o /media_publish do MESMO container", async () => {
    const { calls, deps } = igDeps(["throw", "ok"], [{ status: "ok", statusCode: "FINISHED" }]);
    const out = await publishInstagramImmediate(deps);
    assert.equal(out.kind, "published");
    assert.equal(calls.create, 1);
    assert.equal(calls.publish, 2);
    if (out.kind === "published") assert.equal(out.mediaId, "published-from-container-1");
  });

  it("leitura do container falhou: send_unknown com o container, sem nova tentativa", async () => {
    const { calls, deps } = igDeps(["throw", "ok"], [{ status: "error", error: "HTTP 503" }]);
    const out = await publishInstagramImmediate(deps);
    assert.equal(out.kind, "send_unknown");
    assert.equal(calls.publish, 1);
    if (out.kind === "send_unknown") assert.equal(out.containerId, "container-1");
  });

  it("container ERROR/EXPIRED: failed (nada publicado), re-run seguro", async () => {
    const { calls, deps } = igDeps(["throw"], [{ status: "ok", statusCode: "EXPIRED" }]);
    const out = await publishInstagramImmediate(deps);
    assert.equal(out.kind, "failed");
    assert.equal(calls.publish, 1);
  });

  it("FINISHED nas 3 tentativas: failed, sempre o mesmo container", async () => {
    const { calls, deps } = igDeps(["throw"], [{ status: "ok", statusCode: "FINISHED" }]);
    const out = await publishInstagramImmediate(deps);
    assert.equal(out.kind, "failed");
    assert.equal(calls.create, 1);
    assert.equal(calls.publish, 3);
  });

  it("falha na criação do container repete só a criação", async () => {
    let creates = 0;
    const { calls, deps } = igDeps(["ok"], [{ status: "ok", statusCode: "FINISHED" }]);
    const out = await publishInstagramImmediate({
      ...deps,
      createContainer: async () => {
        creates++;
        if (creates < 2) throw new Error("Instagram /media HTTP 500");
        return "container-ok";
      },
    });
    assert.equal(out.kind, "published");
    assert.equal(creates, 2);
    assert.equal(calls.publish, 1);
  });

  it("match da listagem pela legenda", () => {
    const items = [{ id: "x", caption: "outra" }, { id: "y", caption: CAPTION }];
    assert.equal(matchInstagramMediaByCaption(items, CAPTION), "y");
    assert.equal(matchInstagramMediaByCaption(items.slice(0, 1), CAPTION), null);
  });
});
