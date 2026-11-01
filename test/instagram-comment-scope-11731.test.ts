/**
 * test/instagram-comment-scope-11731.test.ts (#11731)
 *
 * O 4º post (USE MELHOR) no Instagram troca a legenda para "Link da edição no
 * primeiro comentário." e publica o permalink como 1º comentário (#11724).
 * Sem `instagram_manage_comments` no token, o post prometeria um comentário
 * que não vai existir. O publish agora sonda `GET /me/permissions` e só passa
 * o permalink adiante quando o escopo está `granted`; sem escopo ou sonda com
 * falha → linha da bio, sem `firstComment` (fail-closed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INSTAGRAM_CTA_LINE,
  INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE,
  instagramUseMelhorEditionComment,
} from "../scripts/lib/social-cta-lines.ts";
import { buildUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import { useMelhorSlideImageKey } from "../scripts/lib/use-melhor-slide-files.ts";
import type { UseMelhorReadyPlan } from "../scripts/lib/use-melhor-dispatch.ts";
import {
  buildUseMelhorInstagramPost,
  gateEditionUrlOnCommentScope,
  hasInstagramCommentPermission,
  probeInstagramCommentPermission,
  type InstagramCommentScopeProbe,
} from "../scripts/publish-instagram.ts";

const TOKEN = "EAAsecret-token-11731";
const EDITION_URL = "https://diar.ia.br/p/um-titulo-da-edicao";
const TITLE = "Seis usos do assistente no trabalho";
const UM = [
  "1) **Peça o primeiro rascunho** de e-mails.\n2) **Resuma documentos longos** pedindo os pontos.",
  "3) **Prepare reuniões** pedindo a pauta.",
  "#Produtividade #IA",
].join("\n\n");
const MD = ["# Social", "", "## d1", "", "Texto do destaque.", "", "#Tag", "", "## um", "", UM, ""].join("\n");
const slots = buildUseMelhorSlides(UM, TITLE).map((s) => s.slot);
const plan: UseMelhorReadyPlan = {
  status: "ready",
  time: "07:45",
  item: { url: "https://example.com/guia", title: TITLE, summary: "S", score: 80 },
  slots,
  captionTitle: TITLE,
};
const images: Record<string, { url?: string }> = {};
for (const s of slots) images[useMelhorSlideImageKey(s)] = { url: `https://cdn/um-${s}.jpg` };

// Escopos medidos ao vivo no token do .env em 01/11/2026 (sem o de comentário).
const LIVE_SCOPES_WITHOUT_COMMENTS = {
  data: [
    "pages_show_list",
    "ads_management",
    "ads_read",
    "business_management",
    "instagram_basic",
    "instagram_content_publish",
    "pages_read_engagement",
    "pages_manage_ads",
    "pages_manage_posts",
    "public_profile",
  ].map((permission) => ({ permission, status: "granted" })),
};
const withScope = (permission: string, status = "granted") => ({
  data: [...LIVE_SCOPES_WITHOUT_COMMENTS.data, { permission, status }],
});

function jsonFetch(body: string, status = 200, calls: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
}

/** O fluxo do `main`: sonda → gate → build. */
async function buildWithProbe(fetchImpl: typeof fetch) {
  const probe = await probeInstagramCommentPermission(TOKEN, "v21.0", fetchImpl);
  const gated = gateEditionUrlOnCommentScope(EDITION_URL, probe);
  const post = buildUseMelhorInstagramPost({
    socialMd: MD,
    plan,
    images,
    editionDir: "x",
    editionUrl: gated.editionUrl,
    fileExists: () => true,
  });
  assert.ok(post.ok);
  return { probe, gated, post };
}

describe("#11731 — hasInstagramCommentPermission", () => {
  it("escopos reais do token de 01/11 (sem comentário) → false", () => {
    assert.equal(hasInstagramCommentPermission(LIVE_SCOPES_WITHOUT_COMMENTS), false);
  });
  it("instagram_manage_comments granted → true", () => {
    assert.equal(hasInstagramCommentPermission(withScope("instagram_manage_comments")), true);
  });
  it("instagram_business_manage_comments granted → true", () => {
    assert.equal(hasInstagramCommentPermission(withScope("instagram_business_manage_comments")), true);
  });
  it("escopo declined/expired → false", () => {
    assert.equal(hasInstagramCommentPermission(withScope("instagram_manage_comments", "declined")), false);
    assert.equal(hasInstagramCommentPermission(withScope("instagram_manage_comments", "expired")), false);
  });
  it("formato inesperado → false (fail-closed)", () => {
    for (const v of [null, undefined, {}, { data: "x" }, { data: [null, 1, "instagram_manage_comments"] }, []]) {
      assert.equal(hasInstagramCommentPermission(v), false);
    }
  });
});

describe("#11731 — sonda + 4º post do Instagram", () => {
  it("sem escopo: sem firstComment, legenda com a linha da bio, aviso citando #11731", async () => {
    const { probe, gated, post } = await buildWithProbe(jsonFetch(JSON.stringify(LIVE_SCOPES_WITHOUT_COMMENTS)));
    assert.deepEqual(probe, { ok: true, granted: false });
    assert.equal(gated.editionUrl, null);
    assert.match(gated.warning ?? "", /#11731/);
    assert.match(gated.warning ?? "", /instagram_manage_comments/);
    assert.ok(post.ok);
    assert.equal(post.firstComment, null);
    assert.ok(post.caption.includes(INSTAGRAM_CTA_LINE));
    assert.ok(!post.caption.includes(INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE));
  });

  it("com escopo: comportamento do #11724 (legenda aponta o comentário + firstComment)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { gated, post } = await buildWithProbe(
      jsonFetch(JSON.stringify(withScope("instagram_manage_comments")), 200, calls),
    );
    assert.equal(gated.editionUrl, EDITION_URL);
    assert.equal(gated.warning, null);
    assert.ok(post.ok);
    assert.equal(post.firstComment, instagramUseMelhorEditionComment(EDITION_URL));
    assert.ok(post.caption.includes(INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE));
    // Sonda é GET em /me/permissions, token no header — nunca na URL (#7779).
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v21\.0\/me\/permissions$/);
    assert.ok(!calls[0].url.includes(TOKEN));
    assert.equal(calls[0].init?.method, "GET");
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  });

  const failures: Array<[string, typeof fetch]> = [
    ["rede", (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch],
    ["erro da API (HTTP 400)", jsonFetch(JSON.stringify({ error: { message: "Invalid OAuth access token." } }), 400)],
    ["erro da API com HTTP 200", jsonFetch(JSON.stringify({ error: { message: "boom" } }), 200)],
    ["JSON inválido", jsonFetch("<html>bad gateway</html>", 502)],
  ];
  for (const [label, fetchImpl] of failures) {
    it(`sonda falhando (${label}) → fail-closed: sem firstComment, linha da bio`, async () => {
      const { probe, gated, post } = await buildWithProbe(fetchImpl);
      assert.equal(probe.ok, false);
      assert.equal(gated.editionUrl, null);
      assert.match(gated.warning ?? "", /sonda de permissões falhou/);
      assert.ok(!(gated.warning ?? "").includes(TOKEN), "aviso nunca carrega o token");
      assert.ok(post.ok);
      assert.equal(post.firstComment, null);
      assert.ok(post.caption.includes(INSTAGRAM_CTA_LINE));
    });
  }

  it("sem permalink: nada a decidir, sem aviso", () => {
    const granted: InstagramCommentScopeProbe = { ok: true, granted: true };
    assert.deepEqual(gateEditionUrlOnCommentScope(null, granted), { editionUrl: null, warning: null });
    assert.deepEqual(gateEditionUrlOnCommentScope(null, null), { editionUrl: null, warning: null });
  });

  it("permalink sem sonda (null) → fail-closed", () => {
    const gated = gateEditionUrlOnCommentScope(EDITION_URL, null);
    assert.equal(gated.editionUrl, null);
    assert.match(gated.warning ?? "", /#11731/);
  });
});
