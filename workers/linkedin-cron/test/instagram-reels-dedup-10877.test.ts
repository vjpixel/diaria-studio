/**
 * instagram-reels-dedup-10877.test.ts (#10877)
 *
 * Reels em dobro: se `/media_publish` estoura o tempo (ou cai) mas a Meta
 * publicou, o disparo voltava `failed` e o retry da fila criava um 2º
 * container e outro Reels público. Duas redes em `fireInstagramReels`
 * (`src/dispatch.ts`):
 *   1. logo depois da falha, o `status_code` do container — `PUBLISHED` = sucesso;
 *   2. no início de toda volta, a lista de mídias da conta — Reels com a mesma
 *      legenda na janela = já disparado, sem criar container.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { QueueEntry } from "../src/index.ts";
import { fireQueueEntry, findPublishedReel, REELS_DEDUP_LOOKBACK_MS, type FireConfig } from "../src/dispatch.ts";

const CAPTION = "O vídeo de hoje\n\nhttps://diar.ia.br/p/x?utm_source=instagram";

function reelsEntry(over: Partial<QueueEntry> = {}): QueueEntry {
  const past = new Date(Date.now() - 60_000).toISOString();
  return {
    text: CAPTION,
    image_url: null,
    scheduled_at: past,
    destaque: "shorts",
    created_at: past,
    retry_count: 0,
    channel: "instagram",
    media_type: "REELS",
    video_url: "https://eia.diar.ia.br/video/261022-short.mp4",
    ...over,
  };
}

const config: FireConfig = {
  webhookUrl: "https://make.test/diaria",
  instagram: { igUserId: "ig-diaria", accessToken: "token-diaria", apiVersion: "v25.0" },
  reelsPollIntervalMs: 0,
};

const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

interface GraphState {
  /** Mídias que a conta "tem" — a lista de dedup devolve isto. */
  media: Array<{ id: string; caption: string; timestamp: string; media_product_type?: string }>;
  /** Status do container depois do media_publish. */
  containerAfterPublish: "PUBLISHED" | "FINISHED";
  /** media_publish estoura o tempo mas a Meta publica mesmo assim. */
  publishTimesOutButLands: boolean;
  /** Resposta forçada da lista de mídias (sobrepõe `media`). */
  mediaListResponse?: () => Response | Promise<Response>;
  containersCreated: number;
  publishCalls: number;
  published: boolean;
  urls: string[];
}

function mockGraph(over: Partial<GraphState> = {}): GraphState {
  const st: GraphState = {
    media: [],
    containerAfterPublish: "PUBLISHED",
    publishTimesOutButLands: false,
    containersCreated: 0,
    publishCalls: 0,
    published: false,
    urls: [],
    ...over,
  };
  globalThis.fetch = (async (url: string | Request) => {
    const u = typeof url === "string" ? url : url.url;
    st.urls.push(u);
    if (/\/media\?fields=/.test(u)) {
      if (st.mediaListResponse) return st.mediaListResponse();
      return new Response(JSON.stringify({ data: st.media }), { status: 200 });
    }
    if (u.endsWith("/media_publish")) {
      st.publishCalls++;
      // A Meta publica o container do lado de lá...
      st.published = true;
      st.media.unshift({ id: `reel-${st.publishCalls}`, caption: CAPTION, timestamp: new Date().toISOString(), media_product_type: "REELS" });
      // ...mas a resposta não chega a tempo.
      if (st.publishTimesOutButLands) throw timeoutError();
      return new Response(JSON.stringify({ id: `reel-${st.publishCalls}` }), { status: 200 });
    }
    if (u.includes("status_code")) {
      const code = st.published ? st.containerAfterPublish : "FINISHED";
      return new Response(JSON.stringify({ status_code: code }), { status: 200 });
    }
    if (u.endsWith("/media")) {
      st.containersCreated++;
      return new Response(JSON.stringify({ id: `container-${st.containersCreated}` }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return st;
}

describe("#10877 Reels: media_publish estoura o tempo mas a Meta publicou", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("container PUBLISHED depois do timeout → fired na mesma volta (sem retry)", async () => {
    const st = mockGraph({ publishTimesOutButLands: true, containerAfterPublish: "PUBLISHED" });
    const out = await fireQueueEntry(reelsEntry(), config);
    assert.deepEqual(out, { status: "fired" });
    assert.equal(st.publishCalls, 1);
    assert.equal(st.containersCreated, 1);
  });

  it("timeout + retry: a 2ª volta acha o Reels pela legenda e NÃO cria outro (cenário da issue)", async () => {
    // Container ainda não reflete PUBLISHED na conferência imediata → failed.
    const st = mockGraph({ publishTimesOutButLands: true, containerAfterPublish: "FINISHED" });
    const first = await fireQueueEntry(reelsEntry(), config);
    assert.equal(first.status, "failed", "1ª volta: falha ambígua vira retry");
    assert.match((first as { reason: string }).reason, /media_publish fetch timeout/);

    // Retry da fila (mesma entry, retry_count incrementado pelo cron).
    const second = await fireQueueEntry(reelsEntry({ retry_count: 1 }), config);
    assert.deepEqual(second, { status: "fired" }, "2ª volta: Reels já publicado conta como disparado");
    assert.equal(st.containersCreated, 1, "nenhum container novo no retry");
    assert.equal(st.publishCalls, 1, "um único media_publish — sem Reels em dobro");
  });

  it("mesma checagem vale sem retry_count (caminho do alarm do DO não incrementa)", async () => {
    const st = mockGraph({
      media: [{ id: "reel-old", caption: CAPTION, timestamp: new Date(Date.now() - 30_000).toISOString(), media_product_type: "REELS" }],
    });
    const out = await fireQueueEntry(reelsEntry({ retry_count: 0 }), config);
    assert.deepEqual(out, { status: "fired" });
    assert.equal(st.containersCreated, 0);
    assert.equal(st.publishCalls, 0);
  });

  it("media_publish com erro explícito e container não publicado → failed (retry normal)", async () => {
    const st = mockGraph({ containerAfterPublish: "FINISHED" });
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.endsWith("/media_publish")) {
        st.publishCalls++;
        return new Response(JSON.stringify({ error: { message: "Media ID is not available" } }), { status: 400 });
      }
      if (u.includes("status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
      if (/\/media\?fields=/.test(u)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (u.endsWith("/media")) return new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
      void init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const out = await fireQueueEntry(reelsEntry(), config);
    assert.equal(out.status, "failed");
    assert.match((out as { reason: string }).reason, /HTTP 400: Media ID is not available \(container_id=container-1\)/);
  });
});

describe("#10877 Reels: busca de dedup antes de criar o container", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("legenda diferente não conta — publica normalmente", async () => {
    const st = mockGraph({
      media: [{ id: "outro", caption: "outro post", timestamp: new Date().toISOString(), media_product_type: "REELS" }],
    });
    const out = await fireQueueEntry(reelsEntry(), config);
    assert.deepEqual(out, { status: "fired" });
    assert.equal(st.containersCreated, 1);
    assert.equal(st.publishCalls, 1);
  });

  it("mesma legenda fora da janela (antes de scheduled_at - 24h) não conta", async () => {
    const old = new Date(Date.now() - 60_000 - REELS_DEDUP_LOOKBACK_MS - 3_600_000).toISOString();
    const st = mockGraph({ media: [{ id: "antigo", caption: CAPTION, timestamp: old, media_product_type: "REELS" }] });
    const out = await fireQueueEntry(reelsEntry(), config);
    assert.deepEqual(out, { status: "fired" });
    assert.equal(st.publishCalls, 1);
  });

  it("mesma legenda num post de imagem (FEED) não conta", async () => {
    const st = mockGraph({ media: [{ id: "img", caption: CAPTION, timestamp: new Date().toISOString(), media_product_type: "FEED" }] });
    await fireQueueEntry(reelsEntry(), config);
    assert.equal(st.publishCalls, 1);
  });

  it("lista de mídias com 5xx → failed sem criar container (não publica no escuro)", async () => {
    const st = mockGraph({ mediaListResponse: () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }) });
    const out = await fireQueueEntry(reelsEntry(), config);
    assert.equal(out.status, "failed");
    assert.match((out as { reason: string }).reason, /dedup inconclusivo/);
    assert.equal(st.containersCreated, 0);
    assert.equal(st.publishCalls, 0);
  });

  it("lista de mídias com timeout → failed sem criar container", async () => {
    const st = mockGraph({ mediaListResponse: () => Promise.reject(timeoutError()) });
    const out = await fireQueueEntry(reelsEntry(), config);
    assert.equal(out.status, "failed");
    assert.equal(st.containersCreated, 0);
  });

  it("lista de mídias com 4xx (sem permissão) → segue publicando (não trava todo Reels na DLQ)", async () => {
    const st = mockGraph({
      mediaListResponse: () => new Response(JSON.stringify({ error: { message: "(#10) permission" } }), { status: 403 }),
    });
    const out = await fireQueueEntry(reelsEntry(), config);
    assert.deepEqual(out, { status: "fired" });
    assert.equal(st.publishCalls, 1);
  });

  it("token da busca vai no header Authorization, nunca na query (#7779)", async () => {
    let auth: string | undefined;
    let listUrl = "";
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      listUrl = typeof url === "string" ? url : url.url;
      auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const r = await findPublishedReel("https://graph.facebook.com/v25.0", config.instagram!, CAPTION, 0);
    assert.deepEqual(r, { kind: "absent" });
    assert.equal(auth, "Bearer token-diaria");
    assert.ok(!listUrl.includes("token-diaria"));
    assert.match(listUrl, /\/ig-diaria\/media\?fields=id,caption,timestamp,media_product_type&limit=25$/);
  });

  it("timestamp ilegível conta como dentro da janela (na dúvida, não publica de novo)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m1", caption: `  ${CAPTION}\n`, timestamp: "???", media_product_type: "REELS" }] }), {
        status: 200,
      })) as typeof fetch;
    const r = await findPublishedReel("https://g.test", config.instagram!, CAPTION, Date.now());
    assert.deepEqual(r, { kind: "found", mediaId: "m1" });
  });
});
