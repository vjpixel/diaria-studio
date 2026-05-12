/**
 * schemas-published.test.ts (#1132 P2.5)
 *
 * Tests dos schemas Zod novos pra outputs do Stage 4 + cache de imagens.
 * Cobre: parse de shape válido, erros com path descritivo em corruption.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PublishedNewsletterSchema,
  parsePublishedNewsletter,
} from "../scripts/lib/schemas/published-newsletter.ts";
import {
  PublishedSocialSchema,
  parsePublishedSocial,
} from "../scripts/lib/schemas/published-social.ts";
import {
  PublicImagesSchema,
  parsePublicImages,
} from "../scripts/lib/schemas/public-images.ts";

describe("PublishedNewsletterSchema (#1132 P2.5)", () => {
  it("aceita shape mínimo válido", () => {
    const valid = {
      draft_url: "https://app.beehiiv.com/posts/abc/edit",
      title: "Test edition",
      status: "draft" as const,
    };
    const parsed = parsePublishedNewsletter(valid);
    assert.equal(parsed.title, "Test edition");
    assert.equal(parsed.status, "draft");
  });

  it("aceita shape completo com unfixed_issues + body_paste", () => {
    const valid = {
      draft_url: "https://app.beehiiv.com/posts/abc/edit",
      title: "Test",
      subtitle: "Subtitle",
      subject_set: "Subject",
      template_used: "HTML",
      test_email_sent_to: "vjpixel@gmail.com",
      test_email_sent_at: "2026-05-12T01:30:00Z",
      status: "sent" as const,
      unfixed_issues: [
        { reason: "cover_image_pending", section: "header", details: "Manual upload" },
      ],
      body_paste: {
        inserted: true,
        html_bytes: 29534,
        has_poll_sig: true,
        has_imgA: true,
        has_imgB: true,
      },
      title_persisted: true,
    };
    const parsed = parsePublishedNewsletter(valid);
    assert.equal(parsed.unfixed_issues?.length, 1);
    assert.equal(parsed.body_paste?.inserted, true);
  });

  it("rejeita draft_url ausente com path descritivo", () => {
    const invalid = { title: "Test", status: "draft" as const };
    assert.throws(
      () => parsePublishedNewsletter(invalid),
      /draft_url/,
    );
  });

  it("rejeita draft_url não-URL", () => {
    const invalid = { draft_url: "not-a-url", title: "x", status: "draft" as const };
    assert.throws(
      () => parsePublishedNewsletter(invalid),
      /draft_url.*válida|invalid_string|URL/i,
    );
  });

  it("rejeita status fora do enum", () => {
    const invalid = { draft_url: "https://x.com", title: "x", status: "weird" };
    assert.throws(
      () => parsePublishedNewsletter(invalid),
      /status/,
    );
  });

  it("rejeita title vazio", () => {
    const invalid = { draft_url: "https://x.com", title: "", status: "draft" };
    assert.throws(
      () => parsePublishedNewsletter(invalid),
      /title/,
    );
  });

  it("aceita test_email_sent_at null (loop ainda não rodou)", () => {
    const valid = {
      draft_url: "https://x.com",
      title: "Test",
      status: "draft" as const,
      test_email_sent_at: null,
    };
    const parsed = parsePublishedNewsletter(valid);
    assert.equal(parsed.test_email_sent_at, null);
  });
});

describe("PublishedSocialSchema (#1132 P2.5)", () => {
  it("aceita posts array vazio (no auto-publish)", () => {
    const parsed = parsePublishedSocial({ posts: [] });
    assert.equal(parsed.posts.length, 0);
  });

  it("aceita entries de Facebook + LinkedIn mistas", () => {
    const valid = {
      posts: [
        { platform: "facebook", destaque: "d1", url: "https://fb.com/123", status: "draft" },
        {
          platform: "linkedin",
          destaque: "d1",
          subtype: "main",
          url: null,
          status: "scheduled",
          scheduled_at: "2026-05-13T09:00:00-03:00",
          route: "worker_queue",
          worker_queue_key: "queue:...",
          webhook_target: "diaria",
          action: "post",
        },
      ],
    };
    const parsed = parsePublishedSocial(valid);
    assert.equal(parsed.posts.length, 2);
    assert.equal(parsed.posts[0].platform, "facebook");
    assert.equal(parsed.posts[1].platform, "linkedin");
  });

  it("rejeita platform fora do enum", () => {
    assert.throws(
      () => parsePublishedSocial({ posts: [{ platform: "twitter", destaque: "d1", status: "draft" }] }),
      /platform/,
    );
  });

  it("rejeita posts ausente", () => {
    assert.throws(
      () => parsePublishedSocial({}),
      /posts/,
    );
  });

  it("aceita is_test=true (test mode #1056)", () => {
    const parsed = parsePublishedSocial({
      posts: [{ platform: "linkedin", destaque: "d1", status: "scheduled", is_test: true }],
    });
    assert.equal(parsed.posts[0].is_test, true);
  });
});

describe("PublicImagesSchema (#1132 P2.5)", () => {
  it("aceita shape Drive (legacy, sem target)", () => {
    const valid = {
      images: {
        d1: {
          file_id: "abc123",
          url: "https://drive.google.com/uc?id=abc",
          mime_type: "image/jpeg",
          filename: "04-d1-1x1.jpg",
        },
      },
    };
    const parsed = parsePublicImages(valid);
    assert.equal(parsed.images.d1.file_id, "abc123");
  });

  it("aceita shape Cloudflare (#1119, com target)", () => {
    const valid = {
      images: {
        cover: {
          file_id: "img-260512-04-d1-2x1.jpg",
          url: "https://diar-ia-poll.diaria.workers.dev/img/img-260512-04-d1-2x1.jpg",
          mime_type: "image/jpeg",
          filename: "04-d1-2x1.jpg",
          target: "cloudflare" as const,
        },
      },
    };
    const parsed = parsePublicImages(valid);
    assert.equal(parsed.images.cover.target, "cloudflare");
  });

  it("rejeita target fora do enum", () => {
    const invalid = {
      images: {
        d1: { file_id: "x", url: "https://x.com", mime_type: "image/jpeg", filename: "d1.jpg", target: "s3" },
      },
    };
    assert.throws(() => parsePublicImages(invalid), /target/);
  });

  it("rejeita file_id vazio", () => {
    const invalid = {
      images: { d1: { file_id: "", url: "https://x.com", mime_type: "image/jpeg", filename: "d1.jpg" } },
    };
    assert.throws(() => parsePublicImages(invalid), /file_id/);
  });

  it("aceita múltiplos slots simultaneamente", () => {
    const valid = {
      images: {
        cover: { file_id: "c", url: "https://x.com/c", mime_type: "image/jpeg", filename: "cover.jpg" },
        d2: { file_id: "d2", url: "https://x.com/d2", mime_type: "image/jpeg", filename: "d2.jpg" },
        d3: { file_id: "d3", url: "https://x.com/d3", mime_type: "image/jpeg", filename: "d3.jpg" },
        eia_a: { file_id: "a", url: "https://x.com/a", mime_type: "image/jpeg", filename: "eia-a.jpg" },
        eia_b: { file_id: "b", url: "https://x.com/b", mime_type: "image/jpeg", filename: "eia-b.jpg" },
      },
    };
    const parsed = parsePublicImages(valid);
    assert.equal(Object.keys(parsed.images).length, 5);
  });

  it("rejeita images ausente", () => {
    assert.throws(() => parsePublicImages({}), /images/);
  });
});
