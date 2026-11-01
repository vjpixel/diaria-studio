/**
 * test/use-melhor-permalink-11724.test.ts (#11724)
 *
 * O 4º post (USE MELHOR, `## um`) leva o leitor à edição (#11667). O publish
 * passa a pôr o permalink da edição:
 *   - Facebook: linha de canal com `{edition_url}` (UTM) no lugar do CTA de
 *     assinatura;
 *   - Instagram: legenda aponta o 1º comentário (não a bio) e o publish deixa
 *     o comentário com o permalink logo depois do `media_publish`, fail-soft.
 * Sem `05-edition-url.txt`, as linhas de sempre (nunca apontar link que não existe).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACEBOOK_CTA_LINE,
  INSTAGRAM_CTA_LINE,
  INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE,
  INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE,
  channelPublishLines,
  facebookUseMelhorEditionLine,
  instagramUseMelhorEditionComment,
} from "../scripts/lib/social-cta-lines.ts";
import { detectCommentDeliveryPromise } from "../scripts/lib/comment-delivery-promise.ts";
import { readResolvedEditionUrl } from "../scripts/lib/edition-url.ts";
import { buildUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import { useMelhorSlideImageKey } from "../scripts/lib/use-melhor-slide-files.ts";
import type { UseMelhorReadyPlan } from "../scripts/lib/use-melhor-dispatch.ts";
import { buildUseMelhorFacebookPost } from "../scripts/publish-facebook.ts";
import {
  buildUseMelhorInstagramPost,
  postInstagramComment,
  truncateCaption,
} from "../scripts/publish-instagram.ts";

const EDITION_URL = "https://diar.ia.br/p/um-titulo-da-edicao";
const TITLE = "Seis usos do assistente no trabalho";
const UM = [
  "1) **Peça o primeiro rascunho** de e-mails.\n2) **Resuma documentos longos** pedindo os pontos.",
  "3) **Prepare reuniões** pedindo a pauta. O guia completo está na edição de 02/11.",
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

describe("#11724 — linhas de canal do 4º post com o permalink", () => {
  it("Facebook um + permalink: linha com a URL e UTM edicao-diaria, sem o CTA de assinatura", () => {
    const lines = channelPublishLines("facebook", { useMelhor: true, editionUrl: EDITION_URL });
    assert.ok(!lines.includes(FACEBOOK_CTA_LINE));
    const line = lines[0];
    assert.equal(line, facebookUseMelhorEditionLine(EDITION_URL));
    const url = new URL(line.match(/https:\/\/\S+?(?=\.$)/)![0]);
    assert.equal(url.origin + url.pathname, EDITION_URL);
    assert.equal(url.searchParams.get("utm_source"), "facebook");
    assert.equal(url.searchParams.get("utm_medium"), "organic_social");
    assert.equal(url.searchParams.get("utm_campaign"), "edicao-diaria");
  });

  it("Instagram um + permalink: legenda aponta o comentário, não a bio", () => {
    const lines = channelPublishLines("instagram", { useMelhor: true, editionUrl: EDITION_URL });
    assert.deepEqual(lines, [INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE, INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE]);
    assert.doesNotMatch(lines.join("\n"), /bio/);
  });

  it("sem permalink (ou vazio), o 4º post fica com as linhas de sempre", () => {
    for (const editionUrl of [undefined, null, "", "   "]) {
      assert.equal(channelPublishLines("facebook", { useMelhor: true, editionUrl })[0], FACEBOOK_CTA_LINE);
      assert.equal(channelPublishLines("instagram", { useMelhor: true, editionUrl })[0], INSTAGRAM_CTA_LINE);
    }
  });

  it("destaques (d1/d2/d3) e LinkedIn ignoram o permalink", () => {
    assert.equal(channelPublishLines("facebook", { editionUrl: EDITION_URL })[0], FACEBOOK_CTA_LINE);
    assert.equal(channelPublishLines("instagram", { editionUrl: EDITION_URL })[0], INSTAGRAM_CTA_LINE);
    assert.deepEqual(channelPublishLines("linkedin", { useMelhor: true, editionUrl: EDITION_URL }), []);
  });

  it("comentário do Instagram: permalink com UTM do instagram e utm_content=usemelhor", () => {
    const comment = instagramUseMelhorEditionComment(EDITION_URL);
    const url = new URL(comment.match(/https:\/\/\S+$/)![0]);
    assert.equal(url.origin + url.pathname, EDITION_URL);
    assert.equal(url.searchParams.get("utm_source"), "instagram");
    assert.equal(url.searchParams.get("utm_campaign"), "edicao-diaria");
    assert.equal(url.searchParams.get("utm_content"), "usemelhor");
  });

  it("guard comment-delivery-promise (#8681) segue coerente: a linha e o comentário não são promessa de entrega", () => {
    assert.equal(detectCommentDeliveryPromise(INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE).promise, false);
    assert.equal(detectCommentDeliveryPromise(instagramUseMelhorEditionComment(EDITION_URL)).promise, false);
    // e o caso real que motivou o guard continua pego
    assert.equal(
      detectCommentDeliveryPromise("Quer receber o link da edição do dia? Siga @diar.ia.br e comente “quero” neste post.").promise,
      true,
    );
  });
});

describe("#11724 — publicadores", () => {
  it("Facebook: buildUseMelhorFacebookPost com permalink leva a URL (com utm_content=usemelhor) e não o CTA de assinatura", () => {
    const fb = buildUseMelhorFacebookPost({ socialMd: MD, plan, images, editionDir: "x", editionUrl: EDITION_URL, fileExists: () => false });
    assert.ok(fb.ok, JSON.stringify(fb));
    if (!fb.ok) return;
    assert.ok(!fb.caption.includes("assine grátis"), fb.caption);
    const url = new URL(fb.caption.match(/https:\/\/diar\.ia\.br\/p\/\S+?(?=\.(?:\s|$))/)![0]);
    assert.equal(url.searchParams.get("utm_source"), "facebook");
    assert.equal(url.searchParams.get("utm_content"), "usemelhor");
  });

  it("Facebook sem permalink: CTA de assinatura de sempre", () => {
    const fb = buildUseMelhorFacebookPost({ socialMd: MD, plan, images, editionDir: "x", fileExists: () => false });
    assert.ok(fb.ok && fb.caption.includes("assine grátis"));
  });

  it("Instagram: com permalink, legenda aponta o comentário e o post carrega o comentário", () => {
    const ig = buildUseMelhorInstagramPost({ socialMd: MD, plan, images, editionDir: "x", editionUrl: EDITION_URL, fileExists: () => true });
    assert.ok(ig.ok, JSON.stringify(ig));
    if (!ig.ok) return;
    assert.ok(ig.caption.includes(INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE));
    assert.ok(!ig.caption.includes(INSTAGRAM_CTA_LINE));
    assert.equal(ig.firstComment, instagramUseMelhorEditionComment(EDITION_URL));
  });

  it("Instagram sem permalink: linha da bio e nenhum comentário (legenda nunca promete o que não sai)", () => {
    const ig = buildUseMelhorInstagramPost({ socialMd: MD, plan, images, editionDir: "x", fileExists: () => true });
    assert.ok(ig.ok);
    if (!ig.ok) return;
    assert.ok(ig.caption.includes(INSTAGRAM_CTA_LINE));
    assert.equal(ig.firstComment, null);
  });

  it("truncateCaption protege a linha do comentário como protege a da bio", () => {
    const body = "palavra ".repeat(400).trim();
    const caption = `${body}\n\n${INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE}\n\n#Tag`;
    const out = truncateCaption(caption);
    assert.ok(out.length <= 2200);
    assert.ok(out.includes(INSTAGRAM_USE_MELHOR_COMMENT_CTA_LINE));
  });
});

describe("#11724 — postInstagramComment (publish imediato) é fail-soft", () => {
  it("sucesso: POST /{media}/comments com message e token no header", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const r = await postInstagramComment("m1", "Edição completa: x", "tok", "v21.0", (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: "c1" }), { status: 200 });
    }) as unknown as typeof fetch);
    assert.deepEqual(r, { ok: true, id: "c1" });
    assert.ok(seen);
    const s = seen as { url: string; init?: RequestInit };
    assert.match(s.url, /\/m1\/comments$/);
    assert.ok(!s.url.includes("tok"), "token nunca na URL (#7779)");
    assert.equal((s.init?.headers as Record<string, string>).Authorization, "Bearer tok");
    assert.equal(new URLSearchParams(String(s.init?.body)).get("message"), "Edição completa: x");
  });

  it("permissão ausente (HTTP 403), resposta sem id e fetch que lança: ok:false, nunca lança", async () => {
    const cases: Array<typeof fetch> = [
      (async () => new Response(JSON.stringify({ error: { message: "(#10) Application does not have permission" } }), { status: 403 })) as unknown as typeof fetch,
      (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch,
      (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch,
      (async () => {
        throw new Error("rede caiu");
      }) as unknown as typeof fetch,
    ];
    for (const f of cases) {
      const r = await postInstagramComment("m1", "x", "tok", "v21.0", f);
      assert.equal(r.ok, false);
    }
  });
});

describe("#11724 — readResolvedEditionUrl", () => {
  it("lê _internal/05-edition-url.txt (trim) e devolve null se ausente ou vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "edition-url-11724-"));
    assert.equal(readResolvedEditionUrl(dir), null);
    mkdirSync(join(dir, "_internal"));
    writeFileSync(join(dir, "_internal", "05-edition-url.txt"), "  \n");
    assert.equal(readResolvedEditionUrl(dir), null);
    writeFileSync(join(dir, "_internal", "05-edition-url.txt"), `${EDITION_URL}\n`);
    assert.equal(readResolvedEditionUrl(dir), EDITION_URL);
  });
});
