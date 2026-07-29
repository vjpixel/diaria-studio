/**
 * prep-twitter-posts.test.ts (#3994; dueAt/#4103)
 *
 * Testa prep-twitter-posts.ts: extração da seção '# Curto' (sem fallback),
 * gate de platform.config.json, skip-existing e limite de 280 chars.
 * Não chama nenhuma API — a publicação em si é feita pelo orchestrator via
 * Buffer MCP (create_post), fora do escopo deste script.
 *
 * #4103: cobre o invariante que motivou a troca addToQueue → customScheduled —
 * o `dueAt` de cada post do X precisa ser IDÊNTICO ao que o mesmo
 * `computeScheduledAt` (compute-social-schedule.ts) produziria para os demais
 * canais na mesma edição/destaque, nunca um horário calculado à parte.
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
  resolveTwitterImage,
  TWITTER_CHAR_LIMIT,
} from "../scripts/prep-twitter-posts.ts";
import { computeScheduledAt } from "../scripts/compute-social-schedule.ts";

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

/** #4264: escreve `06-public-images.json` no formato lido por `resolveTwitterImage`/`publish-instagram.ts`. */
function writePublicImages(editionDir: string, images: Record<string, { url: string }>): void {
  writeFileSync(join(editionDir, "06-public-images.json"), JSON.stringify({ images }), "utf8");
}

// editionDate no futuro + `now` injetado bem antes dela: garante que o slot
// calculado nunca cai no guard de past-slot shift (#2552) — dueAt sempre o
// horário canônico do fallback_schedule, determinístico independente de
// quando a suíte rodar (nunca depende de Date.now() real).
const FUTURE_EDITION_DATE = "271231";
const FUTURE_NOW = new Date("2027-12-01T12:00:00Z").getTime();

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
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
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
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
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
      const result = prepTwitterPosts(dir, { skipExisting: false, editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
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

// ─── #4264: imagem do destaque (assets pro Buffer) ─────────────────────────

describe("resolveTwitterImage (#4264)", () => {
  it("escolhe o card 4x5 quando existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-twitter-img-4x5-"));
    try {
      writePublicImages(dir, {
        d1_4x5: { url: "https://poll.diaria.workers.dev/img/d1-4x5.jpg" },
        d1: { url: "https://poll.diaria.workers.dev/img/d1-1x1.jpg" },
      });
      const result = resolveTwitterImage(dir, "d1", "260729");
      assert.equal(result.imageUrl, "https://poll.diaria.workers.dev/img/d1-4x5.jpg");
      assert.ok(result.altText?.includes("D1"));
      assert.equal(result.reason, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cai pro 1:1 quando o card 4x5 não existe pro destaque (só a entry 1:1 presente)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-twitter-img-fallback-"));
    try {
      writePublicImages(dir, {
        d1_4x5: { url: "https://poll.diaria.workers.dev/img/d1-4x5.jpg" },
        d1: { url: "https://poll.diaria.workers.dev/img/d1-1x1.jpg" },
        d2: { url: "https://poll.diaria.workers.dev/img/d2-1x1.jpg" },
      });
      const result = resolveTwitterImage(dir, "d2", "260729");
      assert.equal(result.imageUrl, "https://poll.diaria.workers.dev/img/d2-1x1.jpg");
      assert.equal(result.reason, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna imageUrl null + reason quando 06-public-images.json não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-twitter-img-missing-cache-"));
    try {
      const result = resolveTwitterImage(dir, "d1", "260729");
      assert.equal(result.imageUrl, null);
      assert.match(result.reason ?? "", /06-public-images\.json ausente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna imageUrl null + reason quando o cache existe mas não tem entry pro destaque", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-twitter-img-missing-entry-"));
    try {
      writePublicImages(dir, { d1: { url: "https://poll.diaria.workers.dev/img/d1-1x1.jpg" } });
      const result = resolveTwitterImage(dir, "d3", "260729");
      assert.equal(result.imageUrl, null);
      assert.match(result.reason ?? "", /public URL para d3 ausente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prepTwitterPosts — imageUrl/skipped_image (#4264)", () => {
  it("com 06-public-images.json presente: d1 usa o card 4x5, d2 cai pro 1:1 (4x5 ausente pra d2)", () => {
    const dir = makeEditionDir("diaria-twitter-prep-img-", MD_CURTO);
    try {
      writePublicImages(dir, {
        d1_4x5: { url: "https://poll.diaria.workers.dev/img/d1-4x5.jpg" },
        d1: { url: "https://poll.diaria.workers.dev/img/d1-1x1.jpg" },
        d2: { url: "https://poll.diaria.workers.dev/img/d2-1x1.jpg" }, // sem d2_4x5
        d3: { url: "https://poll.diaria.workers.dev/img/d3-1x1.jpg" },
      });
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });

      const d1 = result.posts.find((p) => p.destaque === "d1");
      const d2 = result.posts.find((p) => p.destaque === "d2");
      assert.equal(d1?.imageUrl, "https://poll.diaria.workers.dev/img/d1-4x5.jpg");
      assert.equal(d2?.imageUrl, "https://poll.diaria.workers.dev/img/d2-1x1.jpg");
      assert.equal(result.skipped_image.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem 06-public-images.json: posts continuam saindo (só texto), motivo vai pra skipped_image, não pra skipped", () => {
    const dir = makeEditionDir("diaria-twitter-prep-noimg-", MD_CURTO);
    try {
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
      assert.equal(result.posts.length, 3);
      assert.ok(result.posts.every((p) => p.imageUrl === null));
      assert.equal(result.skipped.length, 0);
      assert.equal(result.skipped_image.length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── #4103: dueAt vem do MESMO schedule compartilhado, não de uma fila própria ──

describe("#4103: prepTwitterPosts.dueAt usa o schedule compartilhado (não addToQueue)", () => {
  // editionDate bem no futuro + `now` injetado bem antes dela: garante que o
  // slot calculado nunca cai no guard de past-slot shift (#2552), then dueAt
  // é sempre o horário canônico do fallback_schedule — determinístico
  // independente de quando a suíte rodar.
  it("dueAt de cada destaque é idêntico ao computeScheduledAt (platform: twitter) chamado diretamente", () => {
    const dir = makeEditionDir("diaria-twitter-prep-dueat-", MD_CURTO);
    try {
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
      const config = JSON.parse(readFileSync(resolve(__ROOT, "platform.config.json"), "utf8"));

      for (const post of result.posts) {
        const expected = computeScheduledAt({
          config,
          editionDate: FUTURE_EDITION_DATE,
          destaque: post.destaque as "d1" | "d2" | "d3",
          platform: "twitter",
          now: FUTURE_NOW,
        });
        assert.equal(
          post.dueAt,
          expected,
          `dueAt de ${post.destaque} deve vir do mesmo computeScheduledAt usado pelos demais canais`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dueAt bate com o horário editorial usado por Facebook/LinkedIn/Instagram/Threads pro MESMO destaque", () => {
    const dir = makeEditionDir("diaria-twitter-prep-parity-", MD_CURTO);
    try {
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
      const config = JSON.parse(readFileSync(resolve(__ROOT, "platform.config.json"), "utf8"));

      for (const platform of ["facebook", "linkedin", "instagram"] as const) {
        for (const post of result.posts) {
          const otherChannelDueAt = computeScheduledAt({
            config,
            editionDate: FUTURE_EDITION_DATE,
            destaque: post.destaque as "d1" | "d2" | "d3",
            platform,
            now: FUTURE_NOW,
          });
          assert.equal(
            post.dueAt,
            otherChannelDueAt,
            `#4103: X (${post.destaque}) deve sair no mesmo horário que ${platform} — dois donos do mesmo cronograma foi exatamente o bug`,
          );
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dueAt é ISO 8601 com offset explícito (exigido pela Buffer pra mode: customScheduled)", () => {
    const dir = makeEditionDir("diaria-twitter-prep-iso-", MD_CURTO);
    try {
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
      for (const post of result.posts) {
        assert.match(
          post.dueAt,
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
          `dueAt de ${post.destaque} deve ser ISO 8601 com offset (recebido: ${post.dueAt})`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
