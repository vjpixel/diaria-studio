/**
 * linkedin-carousel.test.ts (#8052, substitui linkedin-no-carousel.test.ts
 * do #8050)
 *
 * #8050 tinha adicionado um guard fail-fast que rejeitava `channel:
 * "linkedin"` + `image_urls` com mais de 1 item — `fireLinkedIn` só
 * encaminhava `image_url` singular ao Make.com, nunca lia `image_urls`. O
 * #8052 (decisão do editor: API direta do LinkedIn, sem depender de módulo
 * multi-imagem no Make) REVERTE esse guard: agora `image_urls > 1` publica
 * via `fireLinkedInCarousel` (Images API + Posts API do LinkedIn, sem
 * passar pelo webhook Make).
 *
 * Cobertura:
 *   - 1 imagem (via `image_url` OU `image_urls[1]`) → continua indo pro
 *     Make normalmente, comportamento antigo preservado, ZERO chamada às
 *     APIs REST do LinkedIn.
 *   - >1 imagem SEM credenciais LinkedIn configuradas (`config.linkedin`
 *     ausente) → dlq fail-fast com motivo claro, sem nenhum fetch.
 *   - >1 imagem COM credenciais → `fireLinkedInCarousel`: initializeUpload +
 *     PUT de bytes por imagem (na ordem), depois POST /rest/posts com
 *     `content.multiImage.images[]` na mesma ordem — outcome "fired".
 *   - falha no meio do carrossel (upload da 2ª imagem) → dlq, NENHUMA
 *     chamada a POST /rest/posts é feita.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fireQueueEntry, type LinkedInCreds } from "../src/dispatch.ts";
import type { QueueEntry } from "../src/index.ts";

const LINKEDIN_CREDS: LinkedInCreds = {
  accessToken: "test-li-token",
  authorUrn: "urn:li:organization:12345",
  apiVersion: "202401",
};

function bodyOf(init: RequestInit | undefined): string {
  if (init?.body instanceof ArrayBuffer) return "<binary>";
  return String(init?.body ?? "");
}

describe("#8052: channel=linkedin + image_urls[1] (não-carrossel) continua indo pro Make", () => {
  it("1 imagem via image_urls[1] — ZERO chamada às APIs REST do LinkedIn", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | Request) => {
      calls.push(typeof url === "string" ? url : url.url);
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "post normal",
      image_url: null,
      image_urls: ["https://x.test/only.jpg"],
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      channel: "linkedin",
    };

    try {
      const outcome = await fireQueueEntry(entry, { webhookUrl: "https://make.test/diaria", linkedin: LINKEDIN_CREDS });
      assert.deepEqual(outcome, { status: "fired" });
      assert.equal(calls.length, 1);
      assert.match(calls[0], /make\.test/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("#8052: channel=linkedin + image_urls[>1] sem credenciais LinkedIn → dlq fail-fast", () => {
  it("rejeita antes de qualquer fetch quando config.linkedin está ausente", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "carrossel semanal",
      image_url: null,
      image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg", "https://x.test/4.jpg"],
      scheduled_at: new Date().toISOString(),
      destaque: "weekly-highlights",
      created_at: new Date().toISOString(),
      channel: "linkedin",
    };

    try {
      const outcome = await fireQueueEntry(entry, { webhookUrl: "https://make.test/diaria" });
      assert.equal(outcome.status, "dlq");
      assert.match((outcome as { reason: string }).reason, /LINKEDIN_ACCESS_TOKEN|LINKEDIN_AUTHOR_URN|credenciais/i);
      assert.equal(fetchCalled, false, "não deveria ter tentado nenhum fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("#8052: channel=linkedin + image_urls[>1] com credenciais → fireLinkedInCarousel via API direta", () => {
  it("happy path: 3 imagens — initializeUpload+PUT por imagem, na ordem, depois POST /rest/posts com multiImage", async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = [];
    let uploadCounter = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      calls.push({ url: u, method: init?.method, body: bodyOf(init) });

      if (u === "https://api.linkedin.com/rest/images?action=initializeUpload") {
        uploadCounter++;
        return new Response(
          JSON.stringify({
            value: {
              uploadUrl: `https://li-upload.test/${uploadCounter}`,
              image: `urn:li:image:img-${uploadCounter}`,
            },
          }),
          { status: 200 },
        );
      }
      if (u.startsWith("https://li-upload.test/")) {
        return new Response("", { status: 201 });
      }
      if (u.startsWith("https://x.test/")) {
        // fetch dos bytes da imagem hospedada
        return new Response(new ArrayBuffer(8), { status: 200 });
      }
      if (u === "https://api.linkedin.com/rest/posts") {
        return new Response("", { status: 201 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "carrossel semanal: 3 destaques",
      image_url: null,
      image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg"],
      scheduled_at: new Date().toISOString(),
      destaque: "weekly-highlights",
      created_at: new Date().toISOString(),
      channel: "linkedin",
    };

    try {
      const outcome = await fireQueueEntry(entry, { webhookUrl: "https://make.test/diaria", linkedin: LINKEDIN_CREDS });
      assert.deepEqual(outcome, { status: "fired" });

      // 3× (initializeUpload + fetch bytes + PUT upload) + 1× POST /rest/posts = 10 chamadas
      assert.equal(calls.length, 10);

      const postCall = calls.find((c) => c.url === "https://api.linkedin.com/rest/posts");
      assert.ok(postCall, "deveria ter chamado POST /rest/posts");
      const postBody = JSON.parse(postCall!.body);
      assert.equal(postBody.author, LINKEDIN_CREDS.authorUrn);
      assert.equal(postBody.lifecycleState, "PUBLISHED");
      assert.deepEqual(
        postBody.content.multiImage.images.map((i: { id: string }) => i.id),
        ["urn:li:image:img-1", "urn:li:image:img-2", "urn:li:image:img-3"],
        "ordem das imagens no post deve bater com a ordem de upload",
      );

      // Nenhuma chamada ao webhook Make — o carrossel usa API direta.
      assert.ok(!calls.some((c) => c.url.includes("make.test")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falha no upload da 2ª imagem → dlq, NENHUMA chamada a POST /rest/posts", async () => {
    const calls: string[] = [];
    let initCounter = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      calls.push(u);
      if (u === "https://api.linkedin.com/rest/images?action=initializeUpload") {
        initCounter++;
        return new Response(
          JSON.stringify({ value: { uploadUrl: `https://li-upload.test/${initCounter}`, image: `urn:li:image:img-${initCounter}` } }),
          { status: 200 },
        );
      }
      if (u === "https://li-upload.test/2") {
        // 2ª imagem falha no PUT
        return new Response("upload rejected", { status: 500 });
      }
      if (u.startsWith("https://li-upload.test/")) {
        return new Response("", { status: 201 });
      }
      if (u.startsWith("https://x.test/")) {
        return new Response(new ArrayBuffer(8), { status: 200 });
      }
      if (u === "https://api.linkedin.com/rest/posts") {
        return new Response("", { status: 201 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "carrossel com falha",
      image_url: null,
      image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg"],
      scheduled_at: new Date().toISOString(),
      destaque: "weekly-highlights",
      created_at: new Date().toISOString(),
      channel: "linkedin",
    };

    try {
      const outcome = await fireQueueEntry(entry, { webhookUrl: "https://make.test/diaria", linkedin: LINKEDIN_CREDS });
      assert.equal(outcome.status, "dlq");
      assert.match((outcome as { reason: string }).reason, /upload da imagem 2\/3/);
      assert.ok(!calls.includes("https://api.linkedin.com/rest/posts"), "nunca deveria chegar ao POST /rest/posts");
      // 3ª imagem nunca deveria ser processada
      assert.ok(!calls.includes("https://x.test/3.jpg"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
