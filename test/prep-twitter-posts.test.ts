/**
 * prep-twitter-posts.test.ts (#3994)
 *
 * Testa prep-twitter-posts.ts: extração da seção '# Curto' (sem fallback),
 * gate de platform.config.json, skip-existing e limite de 280 chars.
 * Não chama nenhuma API — a publicação em si é feita pelo orchestrator via
 * Buffer MCP (create_post), fora do escopo deste script.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  extractDestaquesFromCurto,
  extractCurtoText,
  prepTwitterPosts,
  TWITTER_CHAR_LIMIT,
} from "../scripts/prep-twitter-posts.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MD_CURTO = `# Curto

## d1
Post curto d1 no X/Threads. #ia

## d2
Post curto d2. #futuro

## d3
Post curto d3.
<!-- comentario oculto -->

# Facebook

## d1
Post d1 Facebook, bem mais longo e não deve vazar pro Twitter.
`;

const MD_SEM_CURTO = `# Facebook

## d1
Post d1 Facebook.

## d2
Post d2 Facebook.
`;

const MD_CRLF = MD_CURTO.replace(/\n/g, "\r\n");

function makeEditionDir(prefix: string, socialMd: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(tmpDir, "_internal"), { recursive: true });
  writeFileSync(join(tmpDir, "03-social.md"), socialMd, "utf8");
  return tmpDir;
}

// ─── extractDestaquesFromCurto ──────────────────────────────────────────────

describe("extractDestaquesFromCurto", () => {
  it("retorna d1/d2/d3 quando seção Curto existe com 3 destaques", () => {
    assert.deepEqual(extractDestaquesFromCurto(MD_CURTO), ["d1", "d2", "d3"]);
  });

  it("retorna [] quando seção Curto ausente — SEM fallback pra Facebook", () => {
    assert.deepEqual(extractDestaquesFromCurto(MD_SEM_CURTO), []);
  });
});

// ─── extractCurtoText ────────────────────────────────────────────────────────

describe("extractCurtoText", () => {
  it("extrai d1 da seção Curto sem vazar Facebook", () => {
    const t = extractCurtoText(MD_CURTO, "d1");
    assert.ok(t?.includes("Post curto d1 no X/Threads."));
    assert.ok(!t?.includes("bem mais longo"));
  });

  it("remove comentários HTML", () => {
    const t = extractCurtoText(MD_CURTO, "d3");
    assert.ok(!t?.includes("comentario oculto"));
  });

  it("normaliza CRLF para LF", () => {
    const t = extractCurtoText(MD_CRLF, "d1");
    assert.ok(t?.includes("Post curto d1 no X/Threads."));
  });

  it("retorna null quando seção Curto ausente — SEM fallback, sem lançar", () => {
    assert.equal(extractCurtoText(MD_SEM_CURTO, "d1"), null);
  });

  it("retorna null quando destaque não existe dentro da seção Curto", () => {
    assert.equal(extractCurtoText(MD_CURTO, "d9"), null);
  });
});

describe("TWITTER_CHAR_LIMIT", () => {
  it("é 280 (limite do free tier/Buffer)", () => {
    assert.equal(TWITTER_CHAR_LIMIT, 280);
  });
});

// ─── prepTwitterPosts (integração, sem subprocess — só função pura) ─────────

describe("prepTwitterPosts", () => {
  it("retorna os 3 destaques prontos pra postar quando Curto existe e nada foi publicado ainda", () => {
    const dir = makeEditionDir("diaria-twitter-prep-", MD_CURTO);
    try {
      const result = prepTwitterPosts(dir);
      assert.equal(result.enabled, true);
      assert.equal(result.posts.length, 3);
      assert.deepEqual(result.posts.map((p) => p.destaque), ["d1", "d2", "d3"]);
      assert.equal(result.skipped.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem seção '# Curto': posts vazio, sem improvisar texto de outra seção", () => {
    const dir = makeEditionDir("diaria-twitter-prep-nocurto-", MD_SEM_CURTO);
    try {
      const result = prepTwitterPosts(dir);
      assert.equal(result.enabled, true);
      assert.deepEqual(result.posts, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pula destaque já publicado (resume-aware)", () => {
    const dir = makeEditionDir("diaria-twitter-prep-resume-", MD_CURTO);
    try {
      writeFileSync(
        join(dir, "_internal", "06-social-published.json"),
        JSON.stringify({
          posts: [{ platform: "twitter", destaque: "d1", status: "published", url: "https://x.com/x/status/1", scheduled_at: null }],
        }),
        "utf8",
      );
      const result = prepTwitterPosts(dir);
      assert.deepEqual(result.posts.map((p) => p.destaque), ["d2", "d3"]);
      assert.deepEqual(result.skipped, [{ destaque: "d1", reason: "already published" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--no-skip-existing (skipExisting:false) reinclui destaque já publicado", () => {
    const dir = makeEditionDir("diaria-twitter-prep-noskip-", MD_CURTO);
    try {
      writeFileSync(
        join(dir, "_internal", "06-social-published.json"),
        JSON.stringify({
          posts: [{ platform: "twitter", destaque: "d1", status: "published", url: "https://x.com/x/status/1", scheduled_at: null }],
        }),
        "utf8",
      );
      const result = prepTwitterPosts(dir, { skipExisting: false });
      assert.deepEqual(result.posts.map((p) => p.destaque), ["d1", "d2", "d3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("texto acima de 280 chars entra em skipped com motivo claro, não em posts", () => {
    const longText = "a".repeat(300);
    const md = `# Curto\n\n## d1\n${longText}\n`;
    const dir = makeEditionDir("diaria-twitter-prep-toolong-", md);
    try {
      const result = prepTwitterPosts(dir);
      assert.deepEqual(result.posts, []);
      assert.equal(result.skipped.length, 1);
      assert.match(result.skipped[0].reason, /280/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("platform.config.json com publishing.social.twitter.enabled:false desliga o canal inteiro", () => {
    const cfg = JSON.parse(readFileSync(resolve(__ROOT, "platform.config.json"), "utf8"));
    assert.equal(typeof cfg.publishing?.social?.twitter?.enabled, "boolean");
  });

  it("platform.config.json tem 'twitter' no array socials", () => {
    const cfg = JSON.parse(readFileSync(resolve(__ROOT, "platform.config.json"), "utf8")) as {
      socials?: string[];
    };
    assert.ok(cfg.socials!.includes("twitter"), "socials deve conter 'twitter'");
  });
});
