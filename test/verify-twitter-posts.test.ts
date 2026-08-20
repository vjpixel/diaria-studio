import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileTwitterPost,
  verifyTwitterPublished,
  resolveSocialPublishedPath,
  defaultFetchBufferPost,
  type BufferPostResponse,
} from "../scripts/verify-twitter-posts.ts";
import type { PostEntry, SocialPublished } from "../scripts/lib/social-published-store.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function scheduledEntry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "twitter",
    destaque: "d1",
    url: null,
    status: "scheduled",
    scheduled_at: "2026-08-20T10:00:00Z",
    buffer_post_id: "6a668bb2ecad4329a917a05f",
    ...overrides,
  };
}

describe("reconcileTwitterPost", () => {
  it("status=sent: vira published, grava url e published_at", () => {
    const entry = scheduledEntry();
    const buffer: BufferPostResponse = {
      status: "sent",
      sentAt: "2026-08-20T10:00:05Z",
      externalLink: "https://x.com/diariabr/status/123",
    };
    const result = reconcileTwitterPost(entry, buffer);
    assert.equal(result.status, "published");
    assert.equal(result.url, "https://x.com/diariabr/status/123");
    assert.equal(result.published_at, "2026-08-20T10:00:05Z");
    assert.equal(result.failure_reason, undefined);
  });

  it("status=error: vira failed com a mensagem do Buffer", () => {
    const entry = scheduledEntry();
    const buffer: BufferPostResponse = {
      status: "error",
      error: { message: "Twitter API rejected the media." },
    };
    const result = reconcileTwitterPost(entry, buffer);
    assert.equal(result.status, "failed");
    assert.equal(result.failure_reason, "Twitter API rejected the media.");
  });

  it("status=scheduled: mantém scheduled (ainda não conclusivo)", () => {
    const entry = scheduledEntry();
    const buffer: BufferPostResponse = { status: "scheduled" };
    const result = reconcileTwitterPost(entry, buffer);
    assert.equal(result.status, "scheduled");
  });

  it("status=sending: mantém status atual, não regride nem declara sucesso cedo", () => {
    const entry = scheduledEntry();
    const buffer: BufferPostResponse = { status: "sending" };
    const result = reconcileTwitterPost(entry, buffer);
    assert.equal(result.status, "scheduled");
  });

  it("queryError (ex: 'Post not found'): preserva status, anota inconclusividade — nunca declara failed sem evidência", () => {
    const entry = scheduledEntry();
    const buffer: BufferPostResponse = { queryError: "Post not found" };
    const result = reconcileTwitterPost(entry, buffer);
    assert.equal(result.status, "scheduled");
    assert.equal(result.verification_note, "buffer_query_error: Post not found");
  });

  it("promove published já publicado permanece intocado (fora do RECONCILABLE_STATUSES)", () => {
    const entry = scheduledEntry({ status: "published", url: "https://x.com/diariabr/status/999" });
    // reconcileTwitterPost em si não filtra por status (verifyTwitterPublished
    // que filtra) — mas se chamado direto com sent, deve seguir promovendo
    // coerentemente (não há regra especial pra manter "published" imutável
    // nesta função pura).
    const buffer: BufferPostResponse = { status: "sent", sentAt: "x", externalLink: "y" };
    const result = reconcileTwitterPost(entry, buffer);
    assert.equal(result.status, "published");
  });
});

describe("verifyTwitterPublished", () => {
  it("só reconcilia entries platform=twitter com status reconciliável e buffer_post_id presente", async () => {
    const published: SocialPublished = {
      posts: [
        scheduledEntry({ destaque: "d1" }),
        scheduledEntry({ destaque: "d2", platform: "facebook", fb_post_id: "1_2" }),
        scheduledEntry({ destaque: "d3", status: "published", url: "https://x.com/1" }),
        scheduledEntry({ destaque: "d4", buffer_post_id: undefined }),
      ],
    };
    let calls = 0;
    const fetchPost = async (): Promise<BufferPostResponse> => {
      calls++;
      return { status: "sent", sentAt: "2026-08-20T10:00:05Z", externalLink: "https://x.com/diariabr/status/1" };
    };
    const { updated, changes } = await verifyTwitterPublished(published, "fake-token", fetchPost);
    assert.equal(calls, 1, "só d1 deveria disparar fetch (facebook, já published, e sem buffer_post_id ficam de fora)");
    assert.equal(changes, 1);
    assert.equal(updated.posts[0].status, "published");
    assert.equal(updated.posts[1].status, "scheduled"); // facebook intocado
    assert.equal(updated.posts[2].status, "published"); // já published, intocado
  });

  it("erro de rede no fetch vira verification_note, não crasha o script", async () => {
    const published: SocialPublished = { posts: [scheduledEntry()] };
    const fetchPost = async (): Promise<BufferPostResponse> => {
      throw new Error("fetch failed: ECONNRESET");
    };
    const { updated, changes } = await verifyTwitterPublished(published, "fake-token", fetchPost);
    assert.equal(changes, 1);
    assert.equal(updated.posts[0].status, "scheduled"); // status preservado
    assert.ok((updated.posts[0].verification_note as string).includes("buffer_api_error"));
  });
});

describe("defaultFetchBufferPost", () => {
  it("HTTP não-ok (ex: 401 token expirado) vira queryError, nunca é interpretado como 'resposta sem data.post' genérico", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as typeof fetch;
    try {
      const result = await defaultFetchBufferPost("some-id", "expired-token");
      assert.ok(result.queryError?.startsWith("HTTP 401"), `esperava queryError com HTTP 401, veio: ${result.queryError}`);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("HTTP ok com body GraphQL válido: passa direto, sem queryError espúrio", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ data: { post: { status: "sent" } } }), { status: 200 })) as typeof fetch;
    try {
      const result = await defaultFetchBufferPost("some-id", "valid-token");
      assert.equal(result.queryError, undefined);
      assert.equal(result.status, "sent");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("resolveSocialPublishedPath", () => {
  it("prefere _internal/06-social-published.json quando ambos existem", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-twitter-"));
    try {
      const editionDir = "data/editions/260820";
      mkdirSync(resolve(root, editionDir, "_internal"), { recursive: true });
      writeFileSync(resolve(root, editionDir, "_internal", "06-social-published.json"), "{}");
      writeFileSync(resolve(root, editionDir, "06-social-published.json"), "{}");
      const result = resolveSocialPublishedPath(root, editionDir);
      assert.equal(result, resolve(root, editionDir, "_internal", "06-social-published.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna null quando nenhum dos dois existe", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-twitter-"));
    try {
      const result = resolveSocialPublishedPath(root, "data/editions/260820");
      assert.equal(result, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
