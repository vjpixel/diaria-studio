/**
 * linkedin-page-comment-v2-13101.test.ts
 *
 * #13101 — o comentário da página ("Assista no YouTube" no D1) saía por
 * `POST /rest/socialActions/{urn}/comments` com `LinkedIn-Version`, e o
 * LinkedIn devolvia 403 `partnerApiSocialActions.CREATE.20260901`: o
 * `/rest` versionado exige o produto Community Management API, que o app da
 * página não tem. Nenhum comentário saiu de 07/11 a 17/11/2026. O mesmo token
 * passa na permissão do endpoint legado `/v2/socialActions` (medido em 17/11).
 *
 * Regressão: o comentário vai para `/v2/socialActions`, sem `LinkedIn-Version`,
 * com `X-Restli-Protocol-Version: 2.0.0`; o repost e a busca do post seguem no
 * `/rest` (não foram medidos como bloqueados e não mudam aqui).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fireQueueEntry, LINKEDIN_PAGE_COMMENT_BASE, V2_COMMENT_5XX_HINT, type LinkedInCreds } from "../src/dispatch.ts";
import type { QueueEntry } from "../src/index.ts";

const CREDS: LinkedInCreds = {
  accessToken: "test-li-token",
  authorUrn: "urn:li:organization:110742958",
  apiVersion: "202609",
};

type Call = { url: string; method: string; headers: Headers; body: string };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(route: (url: string, method: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" });
    return route(url, method);
  }) as typeof fetch;
  return calls;
}

const config = { webhookUrl: "https://make.test/hook", linkedin: CREDS };

function commentEntry(extra: Partial<QueueEntry> = {}): QueueEntry {
  return {
    action: "comment",
    destaque: "d1",
    parent_destaque: "d1",
    text: "Assista no YouTube: https://youtu.be/abcdefghijk",
    image_url: null,
    scheduled_at: "2026-11-17T12:00:00.000Z",
    created_at: "2026-11-17T10:00:00.000Z",
    target_post_urn: "urn:li:share:7396000000000000001",
    ...extra,
  };
}

describe("#13101 comentário da página pelo /v2/socialActions", () => {
  it("POST vai para /v2/socialActions/{urn}/comments, sem LinkedIn-Version", async () => {
    const calls = installFetch(() => new Response("", { status: 201, headers: { "x-restli-id": "7396000000000000999" } }));
    const out = await fireQueueEntry(commentEntry(), config);
    assert.equal(out.status, "fired");
    assert.equal(calls.length, 1);
    const [c] = calls;
    assert.equal(LINKEDIN_PAGE_COMMENT_BASE, "https://api.linkedin.com/v2/socialActions");
    assert.equal(c.url, `https://api.linkedin.com/v2/socialActions/${encodeURIComponent("urn:li:share:7396000000000000001")}/comments`);
    assert.ok(!c.url.includes("/rest/"), "nunca o /rest versionado (exige Community Management API)");
    assert.equal(c.method, "POST");
    assert.equal(c.headers.get("LinkedIn-Version"), null);
    assert.equal(c.headers.get("Authorization"), "Bearer test-li-token");
    assert.equal(c.headers.get("X-Restli-Protocol-Version"), "2.0.0");
    assert.equal(c.headers.get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(c.body), {
      actor: CREDS.authorUrn,
      object: "urn:li:share:7396000000000000001",
      message: { text: "Assista no YouTube: https://youtu.be/abcdefghijk" },
    });
  });

  it("403 do LinkedIn → dlq com o endpoint novo na mensagem", async () => {
    installFetch(() => new Response('{"status":403,"code":"ACCESS_DENIED"}', { status: 403 }));
    const out = await fireQueueEntry(commentEntry(), config);
    assert.equal(out.status, "dlq");
    assert.match((out as { reason: string }).reason, /POST \/v2\/socialActions\/comments: HTTP 403/);
  });

  it("5xx do /v2 → send_unknown (sem reclassificar), citando o endpoint, o HTTP 500 e o aviso de corpo inválido", async () => {
    installFetch(() => new Response('{"status":500}', { status: 500 }));
    const out = await fireQueueEntry(commentEntry(), config);
    assert.equal(out.status, "send_unknown");
    const reason = (out as { reason: string }).reason;
    assert.match(reason, /^send_unknown:/);
    assert.match(reason, /POST \/v2\/socialActions\/comments: HTTP 500/);
    assert.ok(reason.includes(V2_COMMENT_5XX_HINT), reason);
    assert.ok(reason.includes("o /v2 devolve 500 também para corpo inválido"), reason);
  });

  it("4xx do /v2 não leva o aviso de 5xx", async () => {
    installFetch(() => new Response("bad", { status: 400 }));
    const out = await fireQueueEntry(commentEntry(), config);
    assert.equal(out.status, "dlq");
    assert.ok(!(out as { reason: string }).reason.includes(V2_COMMENT_5XX_HINT));
  });

  it("busca do post pelo horário segue no /rest/posts; só o comentário vai para o /v2", async () => {
    const at = "2026-11-17T12:00:00.000Z";
    const calls = installFetch((url, method) => {
      if (method === "GET") {
        return new Response(
          JSON.stringify({ elements: [{ id: "urn:li:share:77", publishedAt: Date.parse(at) + 60_000, lifecycleState: "PUBLISHED" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("", { status: 201 });
    });
    const out = await fireQueueEntry(commentEntry({ target_post_urn: undefined, parent_scheduled_at: at }), config);
    assert.equal(out.status, "fired");
    assert.ok(calls[0].url.startsWith("https://api.linkedin.com/rest/posts?"));
    assert.equal(calls[0].headers.get("LinkedIn-Version"), "202609");
    assert.equal(calls[1].url, `https://api.linkedin.com/v2/socialActions/${encodeURIComponent("urn:li:share:77")}/comments`);
    assert.equal(calls[1].headers.get("LinkedIn-Version"), null);
  });
});
