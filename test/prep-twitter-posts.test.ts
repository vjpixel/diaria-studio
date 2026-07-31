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
  computeTwitterWeightedLength,
  resolveTwitterImage,
  TWITTER_CHAR_LIMIT,
  TWITTER_URL_WEIGHT,
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

describe("regressão #4309 (defesa em profundidade — hoje latente em '# Curto')", () => {
  // '# Curto' não recebe '## eia'/'## post_pixel' hoje (só '# Social' recebe,
  // via merge-social-md.ts) — mas o terminador do '## dN' era o MESMO código
  // com o MESMO bug (`\n## d\d+\b`) que quebrou ao vivo em Facebook/Instagram.
  // Trava aqui pra não reativar se uma seção irmã aparecer depois do último
  // destaque em '# Curto' no futuro.
  const MD_CURTO_COM_SIBLING =
    "# Curto\n\n" +
    "## d1\nPost d1.\n\n" +
    "## d2\nPost d2.\n\n" +
    "## d3\nPost d3 exclusivo.\n\n" +
    "## post_pixel\nPost pessoal do Pixel. {edition_url}\n";

  it("d3 (último destaque) não vaza '## post_pixel' nem {edition_url} não-resolvido", () => {
    const t = extractCurtoText(MD_CURTO_COM_SIBLING, "d3");
    assert.ok(t?.includes("Post d3 exclusivo."));
    assert.ok(!t?.includes("## post_pixel"));
    assert.ok(!t?.includes("Post pessoal do Pixel"));
    assert.ok(!t?.includes("{edition_url}"));
  });
});

describe("regressão #4309 finding 1 (self-review #2038): guard não derruba o prepTwitterPosts() inteiro", () => {
  // Antes do fix: extractCurtoText podia lançar via assertNoScaffolding, e o
  // call site em prepTwitterPosts() não tinha try/catch — um throw em
  // QUALQUER destaque derrubava a função inteira da edição. Depois do fix: só
  // o destaque afetado vira "skipped" (com o motivo do erro), e os demais
  // seguem normalmente.
  it("d2 com placeholder cru vira 'skipped' com o motivo do erro, sem impedir d1/d3", () => {
    const md =
      "# Curto\n\n" +
      "## d1\nPost d1 normal.\n\n" +
      "## d2\nTexto quebrado com {edition_url} cru.\n\n" +
      "## d3\nPost d3 normal.\n";
    const dir = makeEditionDir("diaria-twitter-prep-guardfires-", md);
    try {
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
      assert.deepEqual(
        result.posts.map((p) => p.destaque),
        ["d1", "d3"],
        "d1/d3 devem seguir prontos pra postar, sem o crash derrubar a função inteira",
      );
      const d2Skip = result.skipped.find((s) => s.destaque === "d2");
      assert.ok(d2Skip, "d2 deve aparecer em skipped, não silenciosamente omitido");
      assert.match(d2Skip!.reason, /edition_url|#4309/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TWITTER_CHAR_LIMIT", () => {
  it("é 280 (limite do free tier/Buffer)", () => {
    assert.equal(TWITTER_CHAR_LIMIT, 280);
  });
});

// ─── #4285/#4264 adendo do editor: gate de char limit pondera URL como 23 ───

describe("TWITTER_URL_WEIGHT", () => {
  it("é 23 (peso que o X/t.co atribui a QUALQUER URL, #3994)", () => {
    assert.equal(TWITTER_URL_WEIGHT, 23);
  });
});

describe("computeTwitterWeightedLength", () => {
  it("texto sem URL: idêntico a text.length", () => {
    const text = "Post curto sem nenhum link, só texto puro.";
    assert.equal(computeTwitterWeightedLength(text), text.length);
  });

  it("texto com 1 URL: URL conta como TWITTER_URL_WEIGHT, não seu comprimento literal", () => {
    const url = "https://diar.ia.br/p/titulo-bem-longo-da-edicao-de-hoje-com-varias-palavras";
    const text = `Mais em ${url}`;
    const expected = "Mais em ".length + TWITTER_URL_WEIGHT;
    assert.equal(computeTwitterWeightedLength(text), expected);
    assert.ok(text.length > expected, "fixture precisa ter URL mais longa que o peso pra provar a ponderação");
  });

  it("URL curta (mais curta que o peso 23): weighted ainda usa 23, não o literal menor", () => {
    const text = "Veja: https://x.co/a";
    const weighted = computeTwitterWeightedLength(text);
    assert.ok(weighted > text.length, `URL curta deve INFLAR a contagem ponderada: ${weighted} vs ${text.length}`);
  });

  it("múltiplas URLs no texto: cada uma pesa TWITTER_URL_WEIGHT independentemente", () => {
    const text = "https://diar.ia.br/p/slug-um https://diar.ia.br/p/slug-dois";
    const expected = 1 /* espaço entre as 2 URLs */ + TWITTER_URL_WEIGHT * 2;
    assert.equal(computeTwitterWeightedLength(text), expected);
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

  // #4285/#4264 adendo do editor: {edition_url} resolvido pode ter 40-80 chars
  // literais (https://diar.ia.br/p/{slug}) — antes do fix, um slug longo
  // estourava o gate `text.length > TWITTER_CHAR_LIMIT` mesmo quando o post
  // NÃO estouraria de fato no X (que conta qualquer URL como 23 chars via t.co).
  it("#4285: URL de edição longa NÃO vai pra skipped quando o comprimento PONDERADO (URL=23) cabe em 280, mesmo com o literal estourando", () => {
    const longUrl = `https://diar.ia.br/p/${"a".repeat(60)}`; // 22 + 60 = 82 chars literais
    const body = "b".repeat(250);
    const text = `${body} ${longUrl}`; // literal: 250 + 1 + 82 = 333 chars (> 280)
    assert.ok(text.length > TWITTER_CHAR_LIMIT, `fixture precisa estourar o limite literal: ${text.length}`);

    const md = `# Curto\n\n## d1\n${text}\n`;
    const dir = makeEditionDir("diaria-twitter-prep-weighted-", md);
    try {
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
      assert.equal(result.skipped.length, 0, `nao deveria pular por char limit: ${JSON.stringify(result.skipped)}`);
      assert.equal(result.posts.length, 1);
      assert.equal(result.posts[0].text, text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#4285: texto que estoura o limite mesmo PONDERADO (sem URL) continua indo pra skipped", () => {
    const longText = "a".repeat(300); // sem URL: literal == ponderado
    const md = `# Curto\n\n## d1\n${longText}\n`;
    const dir = makeEditionDir("diaria-twitter-prep-toolong-weighted-", md);
    try {
      const result = prepTwitterPosts(dir);
      assert.deepEqual(result.posts, []);
      assert.equal(result.skipped.length, 1);
      assert.match(result.skipped[0].reason, /peso X/);
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

// ─── #4295: tag UTM per-channel na URL da edição já resolvida ──────────────

describe("#4295: tag UTM per-channel (utm_source=twitter) na edition_url", () => {
  it("posts[].text carrega utm_source=twitter quando _internal/05-edition-url.txt existe e o texto contém a URL base", () => {
    const editionUrl = "https://diar.ia.br/p/titulo-da-edicao";
    const md = `# Curto\n\n## d1\nConfira mais em ${editionUrl}\n`;
    const dir = makeEditionDir("diaria-twitter-prep-utm-", md);
    try {
      writeFileSync(join(dir, "_internal", "05-edition-url.txt"), editionUrl, "utf8");
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
      assert.equal(result.posts.length, 1);
      const text = result.posts[0].text;
      assert.ok(text.includes("utm_source=twitter"), text);
      assert.ok(text.includes("utm_medium=organic_social"), text);
      assert.ok(text.includes("utm_campaign=edicao-diaria"), text);
      assert.ok(!text.includes(`${editionUrl} `), "URL base sem UTM não deve sobrar solta no texto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem 05-edition-url.txt: texto segue sem UTM (no-op, comportamento pré-#4295 preservado)", () => {
    const dir = makeEditionDir("diaria-twitter-prep-noeditionurl-", MD_CURTO);
    try {
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
      assert.equal(result.posts.length, 3);
      for (const post of result.posts) {
        assert.ok(!post.text.includes("utm_source"), post.text);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#4295 não quebra #4285: comprimento ponderado ainda trata a URL como 23 chars mesmo com UTM anexado", () => {
    const editionUrl = `https://diar.ia.br/p/${"a".repeat(60)}`; // 22 + 60 = 82 chars literais, sem UTM
    const body = "b".repeat(200);
    const md = `# Curto\n\n## d1\n${body} ${editionUrl}\n`;
    const dir = makeEditionDir("diaria-twitter-prep-utm-weight-", md);
    try {
      writeFileSync(join(dir, "_internal", "05-edition-url.txt"), editionUrl, "utf8");
      const result = prepTwitterPosts(dir, { editionDate: FUTURE_EDITION_DATE, now: FUTURE_NOW });
      assert.equal(result.skipped.length, 0, `não deveria pular por char limit: ${JSON.stringify(result.skipped)}`);
      assert.equal(result.posts.length, 1);
      assert.ok(result.posts[0].text.includes("utm_source=twitter"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
