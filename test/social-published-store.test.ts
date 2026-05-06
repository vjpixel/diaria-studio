import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSocialPosts,
  readSocialPublished,
  PostEntry,
} from "../scripts/lib/social-published-store.ts";

function tmpFile(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "social-store-"));
  const path = join(dir, "06-social-published.json");
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("appendSocialPosts (#758)", () => {
  it("cria arquivo novo quando não existe", () => {
    const { path, cleanup } = tmpFile();
    try {
      const post: PostEntry = {
        platform: "facebook",
        destaque: "d1",
        url: "https://fb.com/post/1",
        status: "scheduled",
        scheduled_at: "2026-05-06T10:00:00-03:00",
      };
      appendSocialPosts(path, [post]);
      assert.ok(existsSync(path));
      const content = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(content.posts.length, 1);
      assert.equal(content.posts[0].platform, "facebook");
      assert.equal(content.posts[0].destaque, "d1");
    } finally {
      cleanup();
    }
  });

  it("appenda post diferente sem sobrescrever existente", () => {
    const { path, cleanup } = tmpFile();
    try {
      const p1: PostEntry = { platform: "facebook", destaque: "d1", url: "https://fb.com/1", status: "scheduled", scheduled_at: null };
      const p2: PostEntry = { platform: "linkedin", destaque: "d1", url: "https://li.com/1", status: "draft", scheduled_at: null };
      appendSocialPosts(path, [p1]);
      appendSocialPosts(path, [p2]);
      const content = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(content.posts.length, 2);
      const platforms = content.posts.map((p: PostEntry) => p.platform);
      assert.ok(platforms.includes("facebook"));
      assert.ok(platforms.includes("linkedin"));
    } finally {
      cleanup();
    }
  });

  it("upsert: mesmo platform+destaque substitui entry existente", () => {
    const { path, cleanup } = tmpFile();
    try {
      const p1: PostEntry = { platform: "facebook", destaque: "d1", url: "https://fb.com/OLD", status: "draft", scheduled_at: null };
      appendSocialPosts(path, [p1]);
      const p2: PostEntry = { platform: "facebook", destaque: "d1", url: "https://fb.com/NEW", status: "scheduled", scheduled_at: "2026-05-06T10:00:00Z" };
      appendSocialPosts(path, [p2]);
      const content = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(content.posts.length, 1, "should have exactly 1 entry after upsert");
      assert.equal(content.posts[0].url, "https://fb.com/NEW");
      assert.equal(content.posts[0].status, "scheduled");
    } finally {
      cleanup();
    }
  });

  it("plataformas diferentes com mesmo destaque ficam separadas", () => {
    const { path, cleanup } = tmpFile();
    try {
      const fb: PostEntry = { platform: "facebook", destaque: "d2", url: "https://fb.com/d2", status: "scheduled", scheduled_at: null };
      const li: PostEntry = { platform: "linkedin", destaque: "d2", url: "https://li.com/d2", status: "draft", scheduled_at: null };
      appendSocialPosts(path, [fb, li]);
      const content = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(content.posts.length, 2);
    } finally {
      cleanup();
    }
  });

  it("lista vazia é no-op — não cria arquivo", () => {
    const { path, cleanup } = tmpFile();
    try {
      appendSocialPosts(path, []);
      assert.ok(!existsSync(path), "should not create file for empty posts");
    } finally {
      cleanup();
    }
  });

  it("arquivo resultante é JSON válido após múltiplas escritas", () => {
    const { path, cleanup } = tmpFile();
    try {
      const destaques = ["d1", "d2", "d3"];
      for (const d of destaques) {
        const entry: PostEntry = { platform: "facebook", destaque: d, url: `https://fb.com/${d}`, status: "scheduled", scheduled_at: null };
        appendSocialPosts(path, [entry]);
      }
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.posts.length, 3);
      assert.ok(raw.endsWith("\n"), "file should end with newline");
    } finally {
      cleanup();
    }
  });

  it("simula escrita concurrent sequencial (Facebook + LinkedIn) — nenhum dado perdido", () => {
    const { path, cleanup } = tmpFile();
    try {
      // Simulate Facebook writing d1, d2, d3
      for (const d of ["d1", "d2", "d3"]) {
        appendSocialPosts(path, [{ platform: "facebook", destaque: d, url: `https://fb.com/${d}`, status: "scheduled", scheduled_at: null }]);
      }
      // Simulate LinkedIn writing d1, d2, d3 (interleaved, sequential)
      for (const d of ["d1", "d2", "d3"]) {
        appendSocialPosts(path, [{ platform: "linkedin", destaque: d, url: `https://li.com/${d}`, status: "draft", scheduled_at: null }]);
      }
      const content = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(content.posts.length, 6, "should have 3 facebook + 3 linkedin");
      const fb = content.posts.filter((p: PostEntry) => p.platform === "facebook");
      const li = content.posts.filter((p: PostEntry) => p.platform === "linkedin");
      assert.equal(fb.length, 3);
      assert.equal(li.length, 3);
    } finally {
      cleanup();
    }
  });
});

describe("readSocialPublished (#758)", () => {
  it("retorna { posts: [] } quando arquivo não existe", () => {
    const { path, cleanup } = tmpFile();
    try {
      const result = readSocialPublished(path);
      assert.deepEqual(result, { posts: [] });
    } finally {
      cleanup();
    }
  });

  it("lê arquivo existente corretamente", () => {
    const { path, cleanup } = tmpFile();
    try {
      appendSocialPosts(path, [{ platform: "facebook", destaque: "d1", url: "https://fb.com/1", status: "scheduled", scheduled_at: null }]);
      const result = readSocialPublished(path);
      assert.equal(result.posts.length, 1);
      assert.equal(result.posts[0].platform, "facebook");
    } finally {
      cleanup();
    }
  });
});
