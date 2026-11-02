/**
 * test/social-invite-ordem-superficies-11807.test.ts (#11807, #11791)
 *
 * O "Siga a diar.ia.br:" saía como links de texto na página da retrospectiva
 * enquanto o e-mail mostrava ícones (corrigido na PR #11803); a ordem das
 * redes virou YouTube, Instagram, LinkedIn, Threads, Facebook, X (#11791,
 * PR #11799). Este teste fixa as duas coisas em TODA superfície que renderiza
 * o PARA ENCERRAR com o convite atual, pelo caminho real de cada uma:
 *
 *   - e-mail diário (`renderEncerrar`);
 *   - e-mail mensal, Clarice e apoiadores (`renderEncerramento` via
 *     `draftToEmail`/`draftToEmailApoiadoresKit`);
 *   - página da retrospectiva (`buildArticleHtml` inteiro, não só o render
 *     web: os sanitizadores de rodapé de e-mail não podem engolir o convite);
 *   - arquivo público da diária (`buildArchivePageHtml`, que serve o HTML do
 *     e-mail, `newsletter-final.html`, como página).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOCIAL_INVITE,
  SOCIAL_INVITE_ICON_KEYS,
  SOCIAL_INVITE_ICONS_ORDER_LEGACY,
  CURADORIA_PILLS,
} from "../scripts/lib/shared/encerramento-snippet.ts";
import { renderEncerrar } from "../scripts/lib/newsletter-render-html.ts";
import { draftToEmail } from "../scripts/lib/mensal/monthly-render.ts";
import { draftToEmailApoiadoresKit } from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";
import { buildArticleHtml } from "../scripts/lib/mensal/build-article-page.ts";
import { buildArchivePageHtml, type ArchivePost } from "../scripts/lib/site-archive-pages.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const ORDEM = ["youtube", "instagram", "linkedin", "threads", "facebook", "x"];

/** Chaves dos ícones sociais na ordem em que aparecem no HTML. */
function iconOrder(html: string): string[] {
  return [...html.matchAll(/<img src="https:\/\/diar\.ia\.br\/icons\/social\/([a-z]+)\.png"/g)].map((m) => m[1]);
}

const DRAFT = readFileSync(resolve(__dir, "fixtures/publish-monthly/2604/draft.md"), "utf-8").replace(
  "Fim da edição de teste.",
  `Fim da edição de teste.\n\n${CURADORIA_PILLS}\n\n${SOCIAL_INVITE}`,
);

describe("#11791 — ordem canônica do convite", () => {
  it("SOCIAL_INVITE_ICON_KEYS é YouTube, Instagram, LinkedIn, Threads, Facebook, X", () => {
    assert.deepEqual([...SOCIAL_INVITE_ICON_KEYS], ORDEM);
  });

  it("edição costurada na ordem anterior continua com ícones, na ordem em que foi escrita", () => {
    const html = renderEncerrar(`Texto de apoio.\n\n${SOCIAL_INVITE_ICONS_ORDER_LEGACY}`);
    assert.deepEqual(iconOrder(html), ["linkedin", "instagram", "threads", "facebook", "x", "youtube"]);
  });
});

describe("#11807 — convite com ícones, na ordem, em todas as superfícies", () => {
  it("e-mail diário", () => {
    assert.deepEqual(iconOrder(renderEncerrar(`Texto de apoio.\n\n${CURADORIA_PILLS}\n\n${SOCIAL_INVITE}`)), ORDEM);
  });

  it("e-mail mensal Clarice", () => {
    assert.deepEqual(iconOrder(draftToEmail(DRAFT, null, "2604").html), ORDEM);
  });

  it("e-mail mensal dos apoiadores (Kit)", () => {
    assert.deepEqual(iconOrder(draftToEmailApoiadoresKit(DRAFT, null, "2604").html), ORDEM);
  });

  it("página da retrospectiva (build completo): ícones na ordem, centralizados, sem link de texto das redes", () => {
    const { html } = buildArticleHtml(DRAFT, "2604-05");
    assert.deepEqual(iconOrder(html), ORDEM);
    assert.match(html, /panel-body" style="text-align:center;"/);
    for (const rede of ["YouTube", "Instagram", "LinkedIn", "Threads", "Facebook"]) {
      assert.doesNotMatch(html, new RegExp(`>${rede}</a>`), `${rede} saiu como link de texto`);
    }
  });

  it("arquivo público da diária serve o convite do e-mail com os ícones na ordem", () => {
    const email = `<html><body>${renderEncerrar(`Texto de apoio.\n\n${CURADORIA_PILLS}\n\n${SOCIAL_INVITE}`)}</body></html>`;
    const post: ArchivePost = {
      slug: "edicao-teste-11807",
      title: "Edição de teste",
      subtitle: null,
      preview_text: null,
      meta_default_title: null,
      meta_default_description: null,
      status: "confirmed",
      web_url: "https://diar.ia.br/p/edicao-teste-11807",
      displayed_date: null,
      publish_date: 1700000000,
      thumbnail_url: null,
      content: { free: { web: email } },
    };
    assert.deepEqual(iconOrder(buildArchivePageHtml(post)), ORDEM);
  });
});
