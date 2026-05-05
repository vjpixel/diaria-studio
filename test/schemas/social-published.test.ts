import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSocialPublished } from "../../scripts/lib/schemas/social-published.ts";

describe("social-published schema (#632)", () => {
  it("parse 3 posts válidos", () => {
    const result = parseSocialPublished({
      posts: [
        { platform: "linkedin", destaque: "d1", url: "https://linkedin.com/x", status: "draft" },
        { platform: "facebook", destaque: "d2", url: null, status: "scheduled", scheduled_at: "2026-05-05T09:00:00-03:00", fb_post_id: "123" },
        { platform: "facebook", destaque: "d3", url: null, status: "failed", failure_reason: "(#100) error" },
      ],
    });
    assert.equal(result.posts.length, 3);
    assert.equal(result.posts[0].status, "draft");
  });

  it("rejeita status inválido", () => {
    assert.throws(
      () => parseSocialPublished({ posts: [{ platform: "linkedin", destaque: "d1", url: null, status: "unknown" }] }),
      /invalid_enum_value|invalid/i,
    );
  });

  it("rejeita plataforma inválida", () => {
    assert.throws(
      () => parseSocialPublished({ posts: [{ platform: "twitter", destaque: "d1", url: null, status: "draft" }] }),
      /invalid_enum_value|invalid/i,
    );
  });

  it("aceita posts vazio", () => {
    const result = parseSocialPublished({ posts: [] });
    assert.deepEqual(result.posts, []);
  });

  it("aceita url null (posts não publicados)", () => {
    const result = parseSocialPublished({ posts: [{ platform: "linkedin", destaque: "d1", url: null, status: "draft" }] });
    assert.equal(result.posts[0].url, null);
  });
});
