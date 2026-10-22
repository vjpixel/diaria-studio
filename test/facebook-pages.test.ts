/**
 * #10458 — Facebook em mais de uma página (diaria + memelab), liga/desliga
 * por página no config. Cobre o helper único, a chave de idempotência
 * (platform, page, destaque) no store e no publisher, a UTM por página e o
 * default do config real (só `diaria` ligada — a PR não muda o que vai ao ar).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FACEBOOK_PAGE_SLUG,
  applyFacebookPageUtm,
  effectiveUtmContent,
  loadFacebookPagesConfig,
  resolveFacebookApiVersion,
  resolveFacebookPages,
  resolvePostPage,
} from "../scripts/lib/facebook-pages.ts";
import { appendSocialPosts, readSocialPublished, type PostEntry } from "../scripts/lib/social-published-store.ts";
import { composeUtmContentOnProjectLinks } from "../scripts/lib/use-melhor-dispatch.ts";
import {
  facebookLogLabel,
  findExistingFacebookPost,
  pageSummary,
  planFacebookPages,
} from "../scripts/publish-facebook.ts";
import { FACEBOOK_CTA_LINE } from "../scripts/lib/social-cta-lines.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TWO_PAGES = {
  publishing: {
    social: {
      facebook: {
        pages: [
          { slug: "diaria", enabled: true, page_id_env: "FACEBOOK_PAGE_ID", token_env: "FACEBOOK_PAGE_ACCESS_TOKEN", utm_content: null },
          { slug: "memelab", enabled: true, page_id_env: "FACEBOOK_MEMELAB_PAGE_ID", token_env: "FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN" },
        ],
      },
    },
  },
};

describe("loadFacebookPagesConfig (#10458)", () => {
  it("config sem a chave → só diaria habilitada com as env vars de sempre (compat)", () => {
    const pages = loadFacebookPagesConfig({ publishing: { social: {} } });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].slug, "diaria");
    assert.equal(pages[0].enabled, true);
    assert.equal(pages[0].page_id_env, "FACEBOOK_PAGE_ID");
    assert.equal(pages[0].token_env, "FACEBOOK_PAGE_ACCESS_TOKEN");
    assert.equal(effectiveUtmContent(pages[0]), null);
  });

  it("lê a lista de páginas", () => {
    const pages = loadFacebookPagesConfig(TWO_PAGES);
    assert.deepEqual(pages.map((p) => p.slug), ["diaria", "memelab"]);
  });

  it("lança em slug duplicado, slug inválido, enabled não-boolean, env var malformada e lista vazia", () => {
    const mk = (pages: unknown) => ({ publishing: { social: { facebook: { pages } } } });
    const ok = { slug: "a", enabled: true, page_id_env: "A_ID", token_env: "A_TOKEN" };
    assert.throws(() => loadFacebookPagesConfig(mk([ok, ok])), /duplicado/);
    assert.throws(() => loadFacebookPagesConfig(mk([{ ...ok, slug: "Diaria" }])), /slug inválido/);
    assert.throws(() => loadFacebookPagesConfig(mk([{ ...ok, enabled: "true" }])), /boolean/);
    assert.throws(() => loadFacebookPagesConfig(mk([{ ...ok, token_env: "EAAB-token-colado" }])), /NOME de uma env var/);
    assert.throws(() => loadFacebookPagesConfig(mk([])), /não vazia/);
  });

  it("utm_content: ausente → page-{slug}; null → sem tag", () => {
    const [diaria, memelab] = loadFacebookPagesConfig(TWO_PAGES);
    assert.equal(effectiveUtmContent(diaria), null);
    assert.equal(effectiveUtmContent(memelab), "page-memelab");
  });
});

describe("config REAL: default não muda o que vai ao ar (#10458)", () => {
  const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const pages = loadFacebookPagesConfig(config);

  it("diaria ligada, memelab e vjpixel desligadas (vjpixel só recebe o Reels, #10769)", () => {
    assert.deepEqual(
      pages.map((p) => [p.slug, p.enabled]),
      [["diaria", true], ["memelab", false], ["vjpixel", false]],
    );
  });

  it("diaria mantém FACEBOOK_PAGE_ID/FACEBOOK_PAGE_ACCESS_TOKEN e sai sem tag de página", () => {
    const d = pages.find((p) => p.slug === "diaria")!;
    assert.equal(d.page_id_env, "FACEBOOK_PAGE_ID");
    assert.equal(d.token_env, "FACEBOOK_PAGE_ACCESS_TOKEN");
    assert.equal(effectiveUtmContent(d), null);
  });

  it("memelab usa as env vars próprias", () => {
    const m = pages.find((p) => p.slug === "memelab")!;
    assert.equal(m.page_id_env, "FACEBOOK_MEMELAB_PAGE_ID");
    assert.equal(m.token_env, "FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN");
  });

  it("com todas as credenciais presentes, só a diaria é publicável", () => {
    const resolved = resolveFacebookPages(pages, {
      FACEBOOK_PAGE_ID: "1",
      FACEBOOK_PAGE_ACCESS_TOKEN: "t1",
      FACEBOOK_MEMELAB_PAGE_ID: "2",
      FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN: "t2",
      FACEBOOK_VJPIXEL_PAGE_ID: "3",
      FACEBOOK_VJPIXEL_PAGE_ACCESS_TOKEN: "t3",
    });
    const plan = planFacebookPages(resolved);
    assert.deepEqual(plan.publishable.map((p) => p.slug), ["diaria"]);
    assert.deepEqual(plan.disabled, ["memelab", "vjpixel"]);
    assert.deepEqual(plan.missingCredentials, []);
  });

  it("caption da diaria sai byte a byte igual (sem utm_content)", () => {
    const resolved = resolveFacebookPages(pages, { FACEBOOK_PAGE_ID: "1", FACEBOOK_PAGE_ACCESS_TOKEN: "t" });
    const diaria = resolved.find((p) => p.slug === "diaria")!;
    const caption = `Texto.\n\n${FACEBOOK_CTA_LINE}`;
    assert.equal(applyFacebookPageUtm(caption, diaria), caption);
  });
});

describe("resolveFacebookPages — credencial e falha isolada (#10458)", () => {
  const pages = loadFacebookPagesConfig(TWO_PAGES);

  it("arquivo legado vale só pra diaria", () => {
    const resolved = resolveFacebookPages(pages, {}, { page_id: "legacy-id", page_access_token: "legacy-tok" });
    const [d, m] = resolved;
    assert.equal(d.pageId, "legacy-id");
    assert.deepEqual(d.missing, []);
    assert.equal(m.pageId, "");
    assert.deepEqual(m.missing, ["FACEBOOK_MEMELAB_PAGE_ID", "FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN"]);
  });

  it("env tem precedência sobre o arquivo legado", () => {
    const [d] = resolveFacebookPages(pages, { FACEBOOK_PAGE_ID: "env-id", FACEBOOK_PAGE_ACCESS_TOKEN: "env-tok" }, { page_id: "legacy" });
    assert.equal(d.pageId, "env-id");
  });

  it("memelab habilitada sem token → missingCredentials, diaria segue publicável", () => {
    const resolved = resolveFacebookPages(pages, {
      FACEBOOK_PAGE_ID: "1",
      FACEBOOK_PAGE_ACCESS_TOKEN: "t",
      FACEBOOK_MEMELAB_PAGE_ID: "2",
    });
    const plan = planFacebookPages(resolved);
    assert.deepEqual(plan.publishable.map((p) => p.slug), ["diaria"]);
    assert.deepEqual(plan.missingCredentials.map((p) => [p.slug, p.missing]), [["memelab", ["FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN"]]]);
  });

  it("missing lista NOMES de env var, nunca valores", () => {
    const [d] = resolveFacebookPages(pages, { FACEBOOK_PAGE_ID: "segredo-id" });
    assert.deepEqual(d.missing, ["FACEBOOK_PAGE_ACCESS_TOKEN"]);
    assert.ok(!JSON.stringify(d.missing).includes("segredo"));
  });

  it("api version: env > arquivo > default", () => {
    assert.equal(resolveFacebookApiVersion({ FACEBOOK_API_VERSION: "v30.0" }, { api_version: "v20.0" }), "v30.0");
    assert.equal(resolveFacebookApiVersion({}, { api_version: "v20.0" }), "v20.0");
    assert.equal(resolveFacebookApiVersion({}, {}), "v25.0");
  });
});

describe("UTM por página (#10458)", () => {
  const memelab = { utmContent: "page-memelab" };

  it("acrescenta utm_content=page-memelab no CTA, mantendo utm_source=facebook e o ponto final fora da URL", () => {
    const out = applyFacebookPageUtm(FACEBOOK_CTA_LINE, memelab);
    const url = out.match(/https:\/\/\S+?(?=\.$)/)![0];
    const u = new URL(url);
    assert.equal(u.searchParams.get("utm_source"), "facebook");
    assert.equal(u.searchParams.get("utm_content"), "page-memelab");
    assert.ok(out.endsWith("."));
  });

  it("compõe com utm_content existente (4º post usemelhor) em vez de sobrescrever", () => {
    const out = composeUtmContentOnProjectLinks("Veja https://diar.ia.br/?utm_source=facebook&utm_content=usemelhor.", "page-memelab");
    assert.equal(new URL(out.slice(5, -1)).searchParams.get("utm_content"), "usemelhor_page-memelab");
  });

  it("idempotente e não toca link de terceiro", () => {
    const once = composeUtmContentOnProjectLinks("https://diar.ia.br/?utm_content=usemelhor", "page-memelab");
    assert.equal(composeUtmContentOnProjectLinks(once, "page-memelab"), once);
    const third = "Fonte: https://example.com/a?x=1";
    assert.equal(composeUtmContentOnProjectLinks(third, "page-memelab"), third);
  });
});

describe("idempotência (platform, page, destaque) (#10458)", () => {
  const posts: PostEntry[] = [
    { platform: "facebook", destaque: "d1", url: "u", status: "scheduled", scheduled_at: "x" }, // legado sem page
    { platform: "facebook", page: "memelab", destaque: "d2", url: "u", status: "scheduled", scheduled_at: "x" },
  ];

  it("entrada sem page é da diaria", () => {
    assert.equal(resolvePostPage(posts[0]), DEFAULT_FACEBOOK_PAGE_SLUG);
    assert.ok(findExistingFacebookPost(posts, "diaria", "d1"));
  });

  it("2ª página NÃO cai no skip da 1ª (o bug que a issue descreve)", () => {
    assert.equal(findExistingFacebookPost(posts, "memelab", "d1"), undefined);
    assert.ok(findExistingFacebookPost(posts, "memelab", "d2"));
    assert.equal(findExistingFacebookPost(posts, "diaria", "d2"), undefined);
  });

  it("store: upsert por página — memelab não sobrescreve diaria; diaria nova substitui a legada sem page", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-pages-"));
    try {
      const path = join(dir, "06-social-published.json");
      appendSocialPosts(path, [{ platform: "facebook", destaque: "d1", url: "old", status: "scheduled", scheduled_at: "x" }]);
      appendSocialPosts(path, [{ platform: "facebook", page: "memelab", destaque: "d1", url: "m", status: "scheduled", scheduled_at: "x" }]);
      assert.equal(readSocialPublished(path).posts.length, 2);
      appendSocialPosts(path, [{ platform: "facebook", page: "diaria", destaque: "d1", url: "new", status: "scheduled", scheduled_at: "x" }]);
      const after = readSocialPublished(path).posts;
      assert.equal(after.length, 2);
      assert.deepEqual(after.map((p) => [resolvePostPage(p), p.url]).sort(), [["diaria", "new"], ["memelab", "m"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("store: outras plataformas seguem com a chave de sempre", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-pages-"));
    try {
      const path = join(dir, "06-social-published.json");
      appendSocialPosts(path, [{ platform: "linkedin", destaque: "d1", url: "a", status: "scheduled", scheduled_at: "x" }]);
      appendSocialPosts(path, [{ platform: "linkedin", destaque: "d1", url: "b", status: "scheduled", scheduled_at: "x" }]);
      assert.deepEqual(readSocialPublished(path).posts.map((p) => p.url), ["b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resumo por página e rótulo de log (#10458)", () => {
  it("pageSummary separa dispatched / missing_credentials / disabled", () => {
    const resolved = resolveFacebookPages(loadFacebookPagesConfig(TWO_PAGES), { FACEBOOK_PAGE_ID: "1", FACEBOOK_PAGE_ACCESS_TOKEN: "t" });
    const plan = planFacebookPages(resolved);
    const summary = pageSummary(plan, [
      { platform: "facebook", page: "diaria", destaque: "d1", url: "u", status: "scheduled", scheduled_at: "x" },
      { platform: "facebook", page: "diaria", destaque: "d2", url: null, status: "failed", scheduled_at: null },
    ]);
    assert.deepEqual(summary, [
      { slug: "diaria", status: "dispatched", scheduled: 1, draft: 0, failed: 1 },
      { slug: "memelab", status: "missing_credentials", missing: ["FACEBOOK_MEMELAB_PAGE_ID", "FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN"] },
    ]);
  });

  it("rótulo da diaria mantém o formato de sempre", () => {
    assert.equal(facebookLogLabel("diaria", "d1"), "facebook/d1");
    assert.equal(facebookLogLabel("memelab", "d1"), "facebook[memelab]/d1");
  });
});
