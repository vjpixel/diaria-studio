import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  reconcilePost,
  verifyPublished,
  inferIsPublished,
  resolveSocialPublishedPath,
  type PostEntry,
  type GraphPostResponse,
  type SocialPublished,
} from "../scripts/verify-facebook-posts.ts";

const now = new Date("2026-04-24T12:00:00Z");
const nowUnix = Math.floor(now.getTime() / 1000);

function scheduledEntry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "facebook",
    destaque: "d1",
    url: "https://facebook.com/...",
    status: "scheduled",
    scheduled_at: "2026-04-24T10:00:00Z",
    fb_post_id: "12345_67890",
    ...overrides,
  };
}

describe("reconcilePost", () => {
  it("scheduled no futuro: mantém scheduled", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      is_published: false,
      scheduled_publish_time: nowUnix + 3600,
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "scheduled");
  });

  it("scheduled_publish_time passou + is_published=true: vira published", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      is_published: true,
      scheduled_publish_time: nowUnix - 3600,
      created_time: "2026-04-24T11:00:00+0000",
      permalink_url: "https://facebook.com/post/123",
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "published");
    assert.equal(result.url, "https://facebook.com/post/123");
    assert.equal(result.published_at, "2026-04-24T11:00:00+0000");
  });

  it("scheduled_publish_time passou + is_published=false: vira failed", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      is_published: false,
      scheduled_publish_time: nowUnix - 3600,
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "failed");
    assert.ok(result.failure_reason?.includes("is_published=false"));
  });

  it("Graph API retorna erro: vira failed com mensagem", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      error: { message: "Invalid OAuth access token.", code: 190 },
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "failed");
    assert.equal(result.failure_reason, "Invalid OAuth access token.");
  });

  it("sem scheduled_publish_time + is_published=true: vira published", () => {
    const entry = scheduledEntry();
    const graph: GraphPostResponse = {
      is_published: true,
      created_time: "2026-04-24T11:00:00+0000",
      permalink_url: "https://facebook.com/post/456",
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.status, "published");
  });

  it("published preserva fb_post_id original", () => {
    const entry = scheduledEntry({ fb_post_id: "SPECIFIC_ID" });
    const graph: GraphPostResponse = {
      is_published: true,
      created_time: "2026-04-24T11:00:00+0000",
    };
    const result = reconcilePost(entry, graph, now);
    assert.equal(result.fb_post_id, "SPECIFIC_ID");
  });
});

describe("verifyPublished", () => {
  it("só verifica posts scheduled com fb_post_id do Facebook", async () => {
    const published: SocialPublished = {
      posts: [
        scheduledEntry({ destaque: "d1" }),
        { ...scheduledEntry({ destaque: "d2" }), status: "draft" },
        { ...scheduledEntry({ destaque: "d3", platform: "linkedin" }) },
      ],
    };

    const graphResponses: GraphPostResponse[] = [
      { is_published: true, scheduled_publish_time: nowUnix - 3600, permalink_url: "https://fb.com/1" },
    ];
    let callIndex = 0;
    const fetchPost = async () => graphResponses[callIndex++];

    const { updated, changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(changes, 1);
    // d1 atualizado
    const d1 = updated.posts.find((p) => p.destaque === "d1")!;
    assert.equal(d1.status, "published");
    // d2 intocado (era draft)
    const d2 = updated.posts.find((p) => p.destaque === "d2")!;
    assert.equal(d2.status, "draft");
    // d3 intocado (era linkedin)
    const d3 = updated.posts.find((p) => p.destaque === "d3")!;
    assert.equal(d3.status, "scheduled");
  });

  it("captura exceção do fetch e marca como failed", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1" })],
    };
    const fetchPost = async () => {
      throw new Error("Network timeout");
    };

    const { updated, changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(changes, 1);
    assert.equal(updated.posts[0].status, "failed");
    assert.ok(updated.posts[0].failure_reason?.includes("Network timeout"));
  });

  it("0 mudanças quando tudo ainda está scheduled", async () => {
    const published: SocialPublished = {
      posts: [scheduledEntry({ destaque: "d1" })],
    };
    const fetchPost = async (): Promise<GraphPostResponse> => ({
      is_published: false,
      scheduled_publish_time: nowUnix + 7200,
    });

    const { changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(changes, 0);
  });

  it("posts sem fb_post_id são pulados (não tenta verificar)", async () => {
    const published: SocialPublished = {
      posts: [{ ...scheduledEntry({ destaque: "d1" }), fb_post_id: undefined }],
    };
    let fetchCalled = false;
    const fetchPost = async () => {
      fetchCalled = true;
      return {} as GraphPostResponse;
    };

    const { changes } = await verifyPublished(published, "TOKEN", "v18.0", fetchPost, now);
    assert.equal(fetchCalled, false);
    assert.equal(changes, 0);
  });
});

describe("inferIsPublished (#600)", () => {
  const fakeNow = Math.floor(new Date("2026-05-05T12:00:00Z").getTime() / 1000);

  it("created_time presente + sem scheduled_publish_time → is_published=true", () => {
    const r = inferIsPublished({ created_time: "2026-05-05T11:00:00Z" }, fakeNow);
    assert.equal(r.is_published, true);
  });

  it("scheduled_publish_time no futuro → is_published=false", () => {
    const r = inferIsPublished(
      { created_time: "2026-05-05T11:00:00Z", scheduled_publish_time: fakeNow + 3600 },
      fakeNow,
    );
    assert.equal(r.is_published, false);
  });

  it("scheduled_publish_time passou + created_time → is_published=true", () => {
    const r = inferIsPublished(
      { created_time: "2026-05-05T11:00:00Z", scheduled_publish_time: fakeNow - 60 },
      fakeNow,
    );
    assert.equal(r.is_published, true);
  });

  it("error presente → não modifica (mantém undefined)", () => {
    const r = inferIsPublished(
      { error: { message: "(#100) Tried accessing nonexisting field (is_published)", code: 100 } },
      fakeNow,
    );
    assert.equal(r.is_published, undefined);
    assert.ok(r.error);
  });

  it("created_time ausente → não infere", () => {
    const r = inferIsPublished({ scheduled_publish_time: fakeNow + 3600 }, fakeNow);
    assert.equal(r.is_published, undefined);
  });
});

describe("resolveSocialPublishedPath (#920)", () => {
  it("prefere _internal/ quando existe (canonical write path de publish-facebook.ts)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-fb-path-"));
    const editionRel = "data/editions/260507";
    const editionAbs = join(root, editionRel);
    mkdirSync(join(editionAbs, "_internal"), { recursive: true });
    writeFileSync(
      join(editionAbs, "_internal", "06-social-published.json"),
      "{}",
    );
    try {
      const out = resolveSocialPublishedPath(root, editionRel);
      assert.equal(
        out,
        resolve(editionAbs, "_internal", "06-social-published.json"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cai pra root quando só legacy existe (compat com edições antigas)", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-fb-path-"));
    const editionRel = "data/editions/260507";
    const editionAbs = join(root, editionRel);
    mkdirSync(editionAbs, { recursive: true });
    writeFileSync(join(editionAbs, "06-social-published.json"), "{}");
    try {
      const out = resolveSocialPublishedPath(root, editionRel);
      assert.equal(out, resolve(editionAbs, "06-social-published.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna null quando não existe em nenhum dos paths", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-fb-path-"));
    const editionRel = "data/editions/260507";
    mkdirSync(join(root, editionRel), { recursive: true });
    try {
      const out = resolveSocialPublishedPath(root, editionRel);
      assert.equal(out, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefere _internal/ mesmo quando legacy também existe", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-fb-path-"));
    const editionRel = "data/editions/260507";
    const editionAbs = join(root, editionRel);
    mkdirSync(join(editionAbs, "_internal"), { recursive: true });
    writeFileSync(join(editionAbs, "06-social-published.json"), "{\"legacy\":true}");
    writeFileSync(
      join(editionAbs, "_internal", "06-social-published.json"),
      "{\"canonical\":true}",
    );
    try {
      const out = resolveSocialPublishedPath(root, editionRel);
      assert.equal(
        out,
        resolve(editionAbs, "_internal", "06-social-published.json"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
