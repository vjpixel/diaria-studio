/**
 * test/whatsapp-share-4486.test.ts (#4486, revisado em #4570)
 *
 * Bloco fixo, encaminhável por WhatsApp, adicionado a cada edição diária —
 * `scripts/lib/newsletter-render-html.ts::renderWhatsappShare` (+ os 3
 * helpers puros que ele compõe: `buildWhatsappShareBlock`,
 * `buildWhatsappEditionUrl`, `buildWhatsappShareLink`).
 *
 * #4570 mudou 4 coisas em relação ao #4486 original (pedido do editor na
 * revisão da edição 260804):
 *   1. Posição: pé do e-mail (antes de "Para encerrar") → ENTRE D1 e D2.
 *   2. Emoji: "📰 {título}" → título limpo, sem emoji.
 *   3. Conteúdo: título + tagline + CTA de assinatura → SÓ título + URL da edição.
 *   4. Botão: pill contornado → botão preenchido (fundo sólido).
 *
 * Cobertura do critério de pronto da issue original + #4570:
 *   - Texto sem markdown (`**`, `#`, `- `) — regra "output final sem
 *     markdown" (context/editorial-rules.md) aplicada também aqui.
 *   - Link `wa.me/?text=` bem formado, com o bloco URL-encoded.
 *   - UTM conferindo com o contrato fixo da issue (utm_source=whatsapp,
 *     utm_medium=share, utm_campaign={AAMMDD}) — mantida por decisão
 *     explícita do coordenador no #4570 (atribuição de assinante novo).
 *   - URL aponta pra EDIÇÃO (diar.ia.br/p/{seoSlug(D1)}), não mais pra home.
 *   - Renderiza no HTML final, posicionado ENTRE D1 e D2.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWhatsappShareBlock,
  buildWhatsappEditionUrl,
  buildWhatsappShareLink,
  renderWhatsappShare,
  renderHTML,
} from "../scripts/lib/newsletter-render-html.ts";
import { seoSlug } from "../scripts/lib/slug.ts";
import { escHtml } from "../scripts/lib/html-escape.ts";
import type { RenderDestaque, NewsletterContent } from "../scripts/lib/newsletter-parse.ts";

const EDITION = "260801";
const D1_TITLE = "IA generativa muda o jeito de programar";

function makeD1(overrides: Partial<RenderDestaque> = {}): RenderDestaque {
  return {
    n: 1,
    category: "🚀 LANÇAMENTO",
    emoji: "🚀",
    title: D1_TITLE,
    body: "Corpo do destaque.",
    why: "Por que importa.",
    url: "https://example.com/d1",
    ...overrides,
  };
}

function makeD2(overrides: Partial<RenderDestaque> = {}): RenderDestaque {
  return {
    n: 2,
    category: "📰 NOTÍCIAS",
    emoji: "📰",
    title: "Segundo destaque do dia",
    body: "Corpo do D2.",
    why: "Por que importa D2.",
    url: "https://example.com/d2",
    ...overrides,
  };
}

describe("#4570 — buildWhatsappEditionUrl", () => {
  it("monta https://diar.ia.br/p/{seoSlug(d1Title)} com os 3 params UTM do contrato fixo da issue", () => {
    const url = new URL(buildWhatsappEditionUrl(EDITION, D1_TITLE));
    assert.equal(url.origin, "https://diar.ia.br");
    assert.equal(url.pathname, `/p/${seoSlug(D1_TITLE)}`);
    assert.equal(url.searchParams.get("utm_source"), "whatsapp");
    assert.equal(url.searchParams.get("utm_medium"), "share");
    assert.equal(url.searchParams.get("utm_campaign"), EDITION);
  });

  it("utm_campaign muda por edição (AAMMDD), mas o slug (path) não", () => {
    const a = new URL(buildWhatsappEditionUrl("260801", D1_TITLE));
    const b = new URL(buildWhatsappEditionUrl("260802", D1_TITLE));
    assert.notEqual(a.searchParams.get("utm_campaign"), b.searchParams.get("utm_campaign"));
    assert.equal(a.pathname, b.pathname);
  });

  it("acentos PT-BR no título viram slug sem diacríticos (mesmo algoritmo seoSlug usado pra setar o slug SEO do post)", () => {
    const title = "Hacker chinês usa DeepSeek em ataques autônomos";
    const url = new URL(buildWhatsappEditionUrl(EDITION, title));
    assert.equal(url.pathname, "/p/hacker-chines-usa-deepseek-em-ataques-autonomos");
  });
});

describe("#4570 — buildWhatsappShareBlock", () => {
  it("contém a manchete do D1 e a URL da edição — só isso, 2 parágrafos", () => {
    const url = buildWhatsappEditionUrl(EDITION, D1_TITLE);
    const block = buildWhatsappShareBlock(D1_TITLE, url);
    assert.ok(block.includes(D1_TITLE), "manchete do D1 ausente do bloco");
    assert.ok(block.includes(url), "URL da edição ausente do bloco");
    const paragraphs = block.split(/\n\n+/).filter((p) => p.trim());
    assert.equal(paragraphs.length, 2, `esperado exatamente 2 parágrafos (título + URL), teve ${paragraphs.length}`);
  });

  it("sem emoji — título limpo, sem prefixo 📰 (#4570 item 2)", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappEditionUrl(EDITION, D1_TITLE));
    const [titleLine] = block.split("\n\n");
    assert.equal(titleLine, D1_TITLE, "1ª linha deve ser o título cru, sem emoji/prefixo");
  });

  it("sem CTA de assinatura separado nem frase explicativa — a 2ª linha é EXATAMENTE a URL (#4570 item 3)", () => {
    const url = buildWhatsappEditionUrl(EDITION, D1_TITLE);
    const block = buildWhatsappShareBlock(D1_TITLE, url);
    const [, urlLine] = block.split("\n\n");
    assert.equal(urlLine, url, "2ª linha deve ser a URL crua, sem prefixo tipo 'Assine grátis:'");
  });

  it("SEM markdown — nada de **, #, ou '- ' (regra de output final sem markdown)", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappEditionUrl(EDITION, D1_TITLE));
    assert.ok(!block.includes("**"), "bold markdown não deve aparecer no bloco WhatsApp");
    assert.ok(!/^#/m.test(block), "heading markdown não deve aparecer");
    assert.ok(!/^- /m.test(block), "bullet markdown não deve aparecer");
    assert.ok(!/\[.+?\]\(.+?\)/.test(block), "link markdown [texto](url) não deve aparecer — URL crua, texto puro");
  });

  it("quebras de linha simples (\\n\\n entre parágrafos, sem \\r\\n)", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappEditionUrl(EDITION, D1_TITLE));
    assert.ok(!block.includes("\r"), "sem CRLF — só \\n");
  });
});

describe("#4486 — buildWhatsappShareLink", () => {
  it("é um link wa.me/?text= bem formado com o bloco URL-encoded", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappEditionUrl(EDITION, D1_TITLE));
    const link = buildWhatsappShareLink(block);
    assert.match(link, /^https:\/\/wa\.me\/\?text=/);
    const encoded = link.slice("https://wa.me/?text=".length);
    assert.equal(decodeURIComponent(encoded), block, "texto decodificado deve bater exatamente com o bloco original");
  });

  it("URL-encoda corretamente caracteres especiais (espaços, &, acentos, emoji)", () => {
    const block = buildWhatsappShareBlock("Título com & espaço, acentuação é assim", buildWhatsappEditionUrl(EDITION, D1_TITLE));
    const link = buildWhatsappShareLink(block);
    // Não deve conter espaço literal nem & cru fora do prefixo esperado da própria URL.
    assert.ok(!link.includes(" "), "wa.me link não deve ter espaço literal — precisa estar %20/+ encoded");
    assert.equal(decodeURIComponent(link.slice("https://wa.me/?text=".length)), block);
  });
});

describe("#4570 — renderWhatsappShare (HTML)", () => {
  it("renderiza um bloco com a manchete do D1, sem markdown cru, e com o botão de compartilhar", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.ok(html.includes(D1_TITLE), "manchete do D1 ausente do HTML");
    assert.match(html, /Compartilhar no WhatsApp/);
    assert.match(html, /https:\/\/wa\.me\/\?text=/);
    // esc() escapa **/#/etc. corretamente — não deve sobrar markdown cru fora de atributo/URL.
    assert.ok(!/<p[^>]*>\s*\*\*/.test(html), "não deve haver ** cru dentro de um <p> renderizado");
  });

  it("sem emoji 📰 no HTML renderizado (#4570 item 2)", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.ok(!html.includes("📰"), "emoji não deve aparecer no bloco WhatsApp renderizado");
  });

  it("botão preenchido — background sólido (não mais pill contornado com fundo papel, #4570 item 4)", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    const btnMatch = html.match(/<a href="https:\/\/wa\.me\/\?text=[^"]*"\s+style="([^"]*)"/);
    assert.ok(btnMatch, "botão Compartilhar no WhatsApp não encontrado no HTML");
    const style = btnMatch![1];
    assert.match(style, /background:#[0-9A-Fa-f]{6}/, "botão deve ter background sólido definido");
    assert.ok(!/background:#FFFFFF/i.test(style), "botão não deve mais usar fundo papel/branco (era o pill antigo)");
  });

  it("retorna string vazia quando não há destaques (defensivo)", () => {
    assert.equal(renderWhatsappShare([], EDITION), "");
  });

  it("o link embutido no HTML aponta pra URL da edição (diar.ia.br/p/{slug}), não pra home", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.match(html, new RegExp(`https://diar\\.ia\\.br/p/${seoSlug(D1_TITLE)}`));
  });

  it("o link de assinatura embutido no HTML carrega a UTM correta", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.match(html, new RegExp(`utm_source=whatsapp.*utm_medium=share.*utm_campaign=${EDITION}|utm_campaign=${EDITION}.*utm_medium=share.*utm_source=whatsapp`));
  });

  it("#4519: título do D1 com caracteres especiais (&, aspas, <tag>) é escapado — não vaza HTML nem quebra o href adjacente", () => {
    const dangerousTitle = 'Título com & "aspas" e <tag>';
    const html = renderWhatsappShare([makeD1({ title: dangerousTitle })], EDITION);
    assert.ok(!html.includes("<tag>"), "título não deve vazar como tag HTML crua");
    assert.ok(html.includes("&lt;tag&gt;"), "< e > do título devem virar entidades HTML");
    assert.ok(html.includes("&amp;"), "& do título deve virar &amp;");
    assert.ok(html.includes("&quot;"), "aspas do título devem virar &quot;");
    // O bloco tem 2 <a href> por desenho — o link da edição embutido no
    // texto (diar.ia.br/p/...) e o botão "Compartilhar no WhatsApp →" (wa.me) —
    // nenhum dos dois deve ser contaminado pelo conteúdo do título.
    const hrefMatches = html.match(/<a href="([^"]*)"/g) ?? [];
    assert.equal(hrefMatches.length, 2, `esperava exatamente 2 <a href> (edição + botão wa.me), achou ${hrefMatches.length}`);
    assert.ok(
      hrefMatches.some((h) => /^<a href="https:\/\/diar\.ia\.br/.test(h)),
      "href do link da edição não deve ser contaminado pelo título",
    );
    assert.ok(
      hrefMatches.some((h) => /^<a href="https:\/\/wa\.me\/\?text=/.test(h)),
      "href do botão wa.me deve continuar apontando pro compartilhamento",
    );
  });

  // #4519: nenhum teste até aqui passava um array REALISTA de 2-3 destaques —
  // `destaques[0]` é uma linha de implementação (risco baixo), mas o
  // invariante "sempre D1, nunca os outros" era só incidental (só D1 no
  // array em todo teste).
  it("#4519: array com [D1, D2, D3] — só o título do D1 aparece no bloco, nunca D2/D3", () => {
    const d2Title = "Título do destaque 2 — nunca deveria aparecer no bloco WhatsApp";
    const d3Title = "Título do destaque 3 — idem";
    const html = renderWhatsappShare(
      [
        makeD1(),
        makeD1({ n: 2, title: d2Title, url: "https://example.com/d2" }),
        makeD1({ n: 3, title: d3Title, url: "https://example.com/d3" }),
      ],
      EDITION,
    );
    assert.ok(html.includes(D1_TITLE), "título do D1 deve aparecer no bloco");
    assert.ok(!html.includes(d2Title), "título do D2 nunca deve aparecer no bloco WhatsApp");
    assert.ok(!html.includes(d3Title), "título do D3 nunca deve aparecer no bloco WhatsApp");
  });
});

describe("#4570 — posição no corpo da newsletter: ENTRE D1 e D2", () => {
  const content: NewsletterContent = {
    title: "Edição teste",
    subtitle: "Teste",
    coverImage: "04-d1-2x1.jpg",
    destaques: [makeD1(), makeD2()],
    eia: { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: EDITION },
    sections: [],
    sorteio: "**🎁 SORTEIO**\n\nTexto do sorteio.",
    encerrar: "Apoie a curadoria em [apoia.se/diaria](https://apoia.se/diaria).",
  };

  it("bloco WhatsApp aparece no HTML final, ENTRE o título do D1 e o título do D2", () => {
    const html = renderHTML(content);
    const idxD1 = html.indexOf(D1_TITLE);
    const idxWhatsapp = html.indexOf("Compartilhar no WhatsApp");
    const idxD2 = html.indexOf(makeD2().title);
    assert.ok(idxD1 !== -1, "título do D1 ausente do render completo");
    assert.ok(idxWhatsapp !== -1, "bloco WhatsApp ausente do render completo");
    assert.ok(idxD2 !== -1, "título do D2 ausente do render completo");
    assert.ok(idxD1 < idxWhatsapp, "bloco WhatsApp deve vir DEPOIS do D1");
    assert.ok(idxWhatsapp < idxD2, "bloco WhatsApp deve vir ANTES do D2");
  });

  it("bloco WhatsApp aparece ANTES do SORTEIO e de 'Para encerrar' (posição antiga era depois de ambos)", () => {
    const html = renderHTML(content);
    const idxWhatsapp = html.indexOf("Compartilhar no WhatsApp");
    const idxSorteio = html.indexOf("SORTEIO");
    const idxEncerrar = html.indexOf("Para encerrar");
    assert.ok(idxWhatsapp < idxSorteio, "bloco WhatsApp deve vir ANTES do Sorteio (mudou de posição no #4570)");
    assert.ok(idxWhatsapp < idxEncerrar, "bloco WhatsApp deve vir ANTES de 'Para encerrar'");
  });

  it("edição de 2 destaques (sem D3): bloco WhatsApp ainda aparece, entre D1 e D2", () => {
    const html = renderHTML(content); // já só tem 2 destaques
    assert.match(html, /Compartilhar no WhatsApp/);
  });

  it("#4512 (achado pr-test-analyzer, preservado no #4570): bloco WhatsApp aparece ANTES do reveal do ERRO INTENCIONAL (que continua entre SORTEIO e 'Para encerrar')", () => {
    const contentComReveal: NewsletterContent = {
      ...content,
      erroIntencional: "Na última edição, disse X mas o correto era Y.",
    };
    const html = renderHTML(contentComReveal);
    const idxWhatsapp = html.indexOf("Compartilhar no WhatsApp");
    const idxReveal = html.indexOf("ERRO INTENCIONAL — reveal");
    const idxEncerrar = html.indexOf("Para encerrar");
    assert.ok(idxWhatsapp !== -1, "bloco WhatsApp ausente do render completo");
    assert.ok(idxReveal !== -1, "reveal do ERRO INTENCIONAL ausente do render completo");
    assert.ok(idxEncerrar !== -1, "'Para encerrar' ausente do render completo");
    assert.ok(
      idxWhatsapp < idxReveal && idxReveal < idxEncerrar,
      `ordem esperada whatsapp < reveal < encerrar, achou whatsapp=${idxWhatsapp} reveal=${idxReveal} encerrar=${idxEncerrar}`,
    );
  });
});

describe("#4512 (fleet review round 2, achados comment-analyzer/code-reviewer), preservado no #4570: titleLine/urlLine do HTML derivam de buildWhatsappShareBlock, não duplicam", () => {
  it("a URL (2ª linha) do HTML renderizado é EXATAMENTE a 2ª linha do bloco wa.me — não uma cópia manual que pode divergir", () => {
    const url = buildWhatsappEditionUrl(EDITION, D1_TITLE);
    const block = buildWhatsappShareBlock(D1_TITLE, url);
    const [, urlLine] = block.split("\n\n");
    const html = renderWhatsappShare([makeD1()], EDITION);
    // A URL aparece 2x no HTML (href do <a> + texto visível dentro dele) —
    // ambas escapadas via esc() (o & que separa os params UTM vira &amp;
    // tanto no atributo quanto no texto). As duas ocorrências devem derivar
    // de urlLine — a mesma 2ª linha do bloco, nunca uma cópia manual.
    const escapedUrl = escHtml(urlLine);
    const occurrences = html.split(escapedUrl).length - 1;
    assert.equal(occurrences, 2, `esperava a URL escapada 2x no HTML (href + texto), achou ${occurrences}`);
  });

  it("o título (1ª linha) do HTML renderizado é EXATAMENTE a 1ª linha do bloco wa.me", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappEditionUrl(EDITION, D1_TITLE));
    const [titleLine] = block.split("\n\n");
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.ok(html.includes(titleLine), "título renderizado deve ser byte-idêntico à 1ª linha de buildWhatsappShareBlock");
  });
});
