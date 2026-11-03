/**
 * #12069 — links de INSCRIÇÃO no canal do YouTube levam `?sub_confirmation=1`
 * (abre o pop-up "Inscrever-se em diar.ia.br?"). Trava:
 *   - a constante nova e a antiga (que segue sem query: identificação/vídeo);
 *   - o convite social e o rodapé mensal usando o link de inscrição;
 *   - o drift do Stage 4 aceitando o convite costurado antes desta mudança;
 *   - `build-link-ctr.ts` e `canonicalize` reconhecendo o canal com a query.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DIARIA_YOUTUBE_SLUG,
  DIARIA_YOUTUBE_URL,
  DIARIA_YOUTUBE_SUBSCRIBE_URL,
} from "../scripts/lib/canonical-urls.ts";
import {
  SOCIAL_INVITE,
  SOCIAL_INVITE_PLAIN_YOUTUBE_LEGACY,
  detectSocialInviteDrift,
  parseSocialInviteIcons,
} from "../scripts/lib/shared/encerramento-snippet.ts";
import { renderSocialFooter } from "../scripts/lib/mensal/monthly-render.ts";
import { isEditorial, extractLinks, matchClick } from "../scripts/build-link-ctr.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";
import { D1_VIDEO_FALLBACK_URL } from "../scripts/lib/diaria/d1-video-hero.ts";

describe("#12069 DIARIA_YOUTUBE_SUBSCRIBE_URL", () => {
  it("é o canal com ?sub_confirmation=1; a URL do canal segue sem query", () => {
    assert.equal(DIARIA_YOUTUBE_SUBSCRIBE_URL, "https://www.youtube.com/@diariabr?sub_confirmation=1");
    assert.equal(DIARIA_YOUTUBE_URL, "https://www.youtube.com/@diariabr");
    const u = new URL(DIARIA_YOUTUBE_SUBSCRIBE_URL);
    assert.equal(u.origin + u.pathname, DIARIA_YOUTUBE_URL);
    assert.equal(u.searchParams.get("sub_confirmation"), "1");
  });

  it("fallback do vídeo do D1 (assista, não inscreva-se) continua no canal sem query", () => {
    assert.equal(D1_VIDEO_FALLBACK_URL, DIARIA_YOUTUBE_URL);
  });
});

describe("#12069 convite social e rodapé mensal usam o link de inscrição", () => {
  it("SOCIAL_INVITE linka o YouTube com sub_confirmation e o parser de ícones preserva a query", () => {
    assert.ok(SOCIAL_INVITE.includes(`[YouTube](${DIARIA_YOUTUBE_SUBSCRIBE_URL})`));
    const parsed = parseSocialInviteIcons(SOCIAL_INVITE);
    assert.ok(parsed);
    const yt = parsed.links.find((l) => l.label === "YouTube");
    assert.equal(yt?.url, DIARIA_YOUTUBE_SUBSCRIBE_URL);
    assert.equal(yt?.icon, "youtube");
  });

  it("renderSocialFooter (mensal) aponta o YouTube pro link de inscrição", () => {
    const html = renderSocialFooter();
    assert.ok(html.includes("youtube.com/@diariabr?sub_confirmation=1"), html);
  });

  it("convite costurado antes do #12069 (mesma ordem, canal sem query) não vira drift", () => {
    assert.ok(SOCIAL_INVITE_PLAIN_YOUTUBE_LEGACY.includes(`[YouTube](${DIARIA_YOUTUBE_URL}) `));
    assert.notEqual(SOCIAL_INVITE_PLAIN_YOUTUBE_LEGACY, SOCIAL_INVITE);
    const md = `**PARA ENCERRAR**\n\nTexto.\n\n${SOCIAL_INVITE_PLAIN_YOUTUBE_LEGACY}\n`;
    assert.equal(detectSocialInviteDrift(md), null);
    assert.equal(detectSocialInviteDrift(`**PARA ENCERRAR**\n\nTexto.\n\n${SOCIAL_INVITE}\n`), null);
  });
});

describe("#12069 CTR e canonicalização reconhecem o canal com a query string", () => {
  it("isEditorial: o link de inscrição é canal próprio (fora do CTR editorial), com ou sem UTM", () => {
    assert.equal(isEditorial(DIARIA_YOUTUBE_SUBSCRIBE_URL), false);
    assert.equal(isEditorial(`${DIARIA_YOUTUBE_SUBSCRIBE_URL}&utm_source=newsletter`), false);
    assert.equal(isEditorial(DIARIA_YOUTUBE_URL), false);
    // controle: um vídeo de terceiro no YouTube continua editorial
    assert.equal(isEditorial("https://www.youtube.com/watch?v=abc123"), true);
  });

  it("extractLinks não conta o convite com o link de inscrição como link editorial", () => {
    const html = `<p><a href="${DIARIA_YOUTUBE_SUBSCRIBE_URL}">YouTube</a> <a href="https://example.com/noticia">Notícia</a></p>`;
    const urls = extractLinks(html).map((e) => e.url);
    assert.ok(!urls.some((u) => u.includes(DIARIA_YOUTUBE_SLUG)), JSON.stringify(urls));
    assert.ok(urls.some((u) => u.includes("example.com/noticia")));
  });

  it("matchClick soma o clique do link de inscrição na chave do canal (querystring fora da chave)", () => {
    const clicks = [
      { url: `${DIARIA_YOUTUBE_SUBSCRIBE_URL}&utm_source=newsletter`, email: { verified_clicks: 2, unique_verified_clicks: 2, unique_clicks: 3 } },
      { url: DIARIA_YOUTUBE_SUBSCRIBE_URL, email: { verified_clicks: 1, unique_verified_clicks: 1, unique_clicks: 1 } },
    ];
    assert.deepEqual(matchClick(DIARIA_YOUTUBE_URL, clicks), {
      verified_clicks: 3,
      unique_verified_clicks: 3,
      unique_clicks: 4,
    });
  });

  it("canonicalize mantém host/path do canal (o slug segue casando) e tira só o tracking", () => {
    const c = canonicalize(`${DIARIA_YOUTUBE_SUBSCRIBE_URL}&utm_source=newsletter&utm_medium=email`);
    assert.ok(c.includes(DIARIA_YOUTUBE_SLUG), c);
    assert.equal(new URL(c).searchParams.get("utm_source"), null);
    assert.equal(new URL(c).searchParams.get("sub_confirmation"), "1");
  });
});
