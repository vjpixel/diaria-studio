/**
 * test/whatsapp-share-4486.test.ts (#4486)
 *
 * Bloco fixo, encaminhável por WhatsApp, adicionado a cada edição diária —
 * `scripts/lib/newsletter-render-html.ts::renderWhatsappShare` (+ os 3
 * helpers puros que ele compõe: `buildWhatsappShareBlock`,
 * `buildWhatsappSubscribeUrl`, `buildWhatsappShareLink`).
 *
 * Cobertura do critério de pronto da issue:
 *   - Texto sem markdown (`**`, `#`, `- `) — regra "output final sem
 *     markdown" (context/editorial-rules.md) aplicada também aqui.
 *   - Link `wa.me/?text=` bem formado, com o bloco URL-encoded.
 *   - UTM conferindo com o contrato fixo da issue (utm_source=whatsapp,
 *     utm_medium=share, utm_campaign={AAMMDD}).
 *   - Renderiza no HTML final, posicionado ANTES de "Para encerrar".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWhatsappShareBlock,
  buildWhatsappSubscribeUrl,
  buildWhatsappShareLink,
  renderWhatsappShare,
  renderHTML,
} from "../scripts/lib/newsletter-render-html.ts";
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

describe("#4486 — buildWhatsappSubscribeUrl", () => {
  it("monta https://diar.ia.br com os 3 params UTM do contrato fixo da issue", () => {
    const url = new URL(buildWhatsappSubscribeUrl(EDITION));
    assert.equal(url.origin, "https://diar.ia.br");
    assert.equal(url.searchParams.get("utm_source"), "whatsapp");
    assert.equal(url.searchParams.get("utm_medium"), "share");
    assert.equal(url.searchParams.get("utm_campaign"), EDITION);
  });

  it("utm_campaign muda por edição (AAMMDD)", () => {
    const a = new URL(buildWhatsappSubscribeUrl("260801"));
    const b = new URL(buildWhatsappSubscribeUrl("260802"));
    assert.notEqual(a.searchParams.get("utm_campaign"), b.searchParams.get("utm_campaign"));
  });
});

describe("#4486 — buildWhatsappShareBlock", () => {
  it("contém a manchete do D1 e o link de assinatura", () => {
    const url = buildWhatsappSubscribeUrl(EDITION);
    const block = buildWhatsappShareBlock(D1_TITLE, url);
    assert.ok(block.includes(D1_TITLE), "manchete do D1 ausente do bloco");
    assert.ok(block.includes(url), "link de assinatura ausente do bloco");
  });

  it("tem entre 3 e 4 linhas 'lógicas' (parágrafos separados por linha em branco)", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappSubscribeUrl(EDITION));
    const paragraphs = block.split(/\n\n+/).filter((p) => p.trim());
    assert.ok(paragraphs.length >= 3 && paragraphs.length <= 4, `esperado 3-4 parágrafos, teve ${paragraphs.length}`);
  });

  it("SEM markdown — nada de **, #, ou '- ' (regra de output final sem markdown)", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappSubscribeUrl(EDITION));
    assert.ok(!block.includes("**"), "bold markdown não deve aparecer no bloco WhatsApp");
    assert.ok(!/^#/m.test(block), "heading markdown não deve aparecer");
    assert.ok(!/^- /m.test(block), "bullet markdown não deve aparecer");
    assert.ok(!/\[.+?\]\(.+?\)/.test(block), "link markdown [texto](url) não deve aparecer — URL crua, texto puro");
  });

  it("quebras de linha simples (\\n\\n entre parágrafos, sem \\r\\n)", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappSubscribeUrl(EDITION));
    assert.ok(!block.includes("\r"), "sem CRLF — só \\n");
  });

  it("é autocontido — menciona 'diar.ia.br' e explica o que é (não pressupõe assinante)", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappSubscribeUrl(EDITION));
    assert.match(block, /diar\.ia\.br/i);
    assert.match(block, /newsletter|notícias de IA/i, "deve dar contexto do que é o produto pra quem nunca assinou");
  });
});

describe("#4486 — buildWhatsappShareLink", () => {
  it("é um link wa.me/?text= bem formado com o bloco URL-encoded", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappSubscribeUrl(EDITION));
    const link = buildWhatsappShareLink(block);
    assert.match(link, /^https:\/\/wa\.me\/\?text=/);
    const encoded = link.slice("https://wa.me/?text=".length);
    assert.equal(decodeURIComponent(encoded), block, "texto decodificado deve bater exatamente com o bloco original");
  });

  it("URL-encoda corretamente caracteres especiais (espaços, &, acentos, emoji)", () => {
    const block = buildWhatsappShareBlock("Título com & espaço, acentuação é assim", buildWhatsappSubscribeUrl(EDITION));
    const link = buildWhatsappShareLink(block);
    // Não deve conter espaço literal nem & cru fora do prefixo esperado da própria URL.
    assert.ok(!link.includes(" "), "wa.me link não deve ter espaço literal — precisa estar %20/+ encoded");
    assert.equal(decodeURIComponent(link.slice("https://wa.me/?text=".length)), block);
  });
});

describe("#4486 — renderWhatsappShare (HTML)", () => {
  it("renderiza um bloco com a manchete do D1, sem markdown cru, e com o botão de compartilhar", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.ok(html.includes(D1_TITLE), "manchete do D1 ausente do HTML");
    assert.match(html, /Compartilhar no WhatsApp/);
    assert.match(html, /https:\/\/wa\.me\/\?text=/);
    // esc() escapa **/#/etc. corretamente — não deve sobrar markdown cru fora de atributo/URL.
    assert.ok(!/<p[^>]*>\s*\*\*/.test(html), "não deve haver ** cru dentro de um <p> renderizado");
  });

  it("retorna string vazia quando não há destaques (defensivo)", () => {
    assert.equal(renderWhatsappShare([], EDITION), "");
  });

  it("o link de assinatura embutido no HTML carrega a UTM correta", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.match(html, new RegExp(`utm_source=whatsapp.*utm_medium=share.*utm_campaign=${EDITION}|utm_campaign=${EDITION}.*utm_medium=share.*utm_source=whatsapp`));
  });

  // #4519 (achado pr-test-analyzer, PR #4512, gap de baixa prioridade): o
  // título do D1 nunca foi testado com caracteres especiais no caminho HTML
  // — buildWhatsappShareLink já cobre URL-encoding (linha 104), mas
  // renderWhatsappShare tem seu próprio caminho de escaping (esc()) que
  // nenhum teste exercitava com &/aspas/<tag>.
  it("#4519: título do D1 com caracteres especiais (&, aspas, <tag>) é escapado — não vaza HTML nem quebra o href adjacente", () => {
    const dangerousTitle = 'Título com & "aspas" e <tag>';
    const html = renderWhatsappShare([makeD1({ title: dangerousTitle })], EDITION);
    assert.ok(!html.includes("<tag>"), "título não deve vazar como tag HTML crua");
    assert.ok(html.includes("&lt;tag&gt;"), "< e > do título devem virar entidades HTML");
    assert.ok(html.includes("&amp;"), "& do título deve virar &amp;");
    assert.ok(html.includes("&quot;"), "aspas do título devem virar &quot;");
    // O bloco tem 2 <a href> por desenho — o link de assinatura embutido no
    // texto (diar.ia.br) e o botão "Compartilhar no WhatsApp →" (wa.me) — nenhum
    // dos dois deve ser contaminado pelo conteúdo do título.
    const hrefMatches = html.match(/<a href="([^"]*)"/g) ?? [];
    assert.equal(hrefMatches.length, 2, `esperava exatamente 2 <a href> (assinatura + botão wa.me), achou ${hrefMatches.length}`);
    assert.ok(
      hrefMatches.some((h) => /^<a href="https:\/\/diar\.ia\.br/.test(h)),
      "href do link de assinatura não deve ser contaminado pelo título",
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

describe("#4486 — posição no corpo da newsletter: ANTES de 'Para encerrar'", () => {
  const baseDestaque: RenderDestaque = makeD1();
  const content: NewsletterContent = {
    title: "Edição teste",
    subtitle: "Teste",
    coverImage: "04-d1-2x1.jpg",
    destaques: [baseDestaque],
    eia: { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: EDITION },
    sections: [],
    sorteio: "**🎁 SORTEIO**\n\nTexto do sorteio.",
    encerrar: "Apoie a curadoria em [apoia.se/diaria](https://apoia.se/diaria).",
  };

  it("bloco WhatsApp aparece no HTML final, ANTES do kicker 'Para encerrar'", () => {
    const html = renderHTML(content);
    const idxWhatsapp = html.indexOf("Compartilhar no WhatsApp");
    const idxEncerrar = html.indexOf("Para encerrar");
    assert.ok(idxWhatsapp !== -1, "bloco WhatsApp ausente do render completo");
    assert.ok(idxEncerrar !== -1, "'Para encerrar' ausente do render completo");
    assert.ok(idxWhatsapp < idxEncerrar, "bloco WhatsApp deve vir ANTES de 'Para encerrar'");
  });

  it("bloco WhatsApp aparece DEPOIS de SORTEIO quando ambos presentes", () => {
    const html = renderHTML(content);
    const idxSorteio = html.indexOf("SORTEIO");
    const idxWhatsapp = html.indexOf("Compartilhar no WhatsApp");
    assert.ok(idxSorteio < idxWhatsapp, "bloco WhatsApp deve vir depois do Sorteio");
  });

  it("#4512 (achado pr-test-analyzer): bloco WhatsApp aparece ENTRE o reveal do ERRO INTENCIONAL e 'Para encerrar' — ordem exigida por context/templates/newsletter.md", () => {
    // Nenhum teste até aqui exercitava erroIntencional + WhatsApp juntos —
    // um `parts.push()` fora de ordem (ex: mover o push do WhatsApp pra
    // ANTES do reveal) passaria batido por todos os testes acima. Este
    // fixture combina os dois pra travar a ordem documentada.
    const contentComReveal: NewsletterContent = {
      ...content,
      erroIntencional: "Na última edição, disse X mas o correto era Y.",
    };
    const html = renderHTML(contentComReveal);
    const idxReveal = html.indexOf("ERRO INTENCIONAL — reveal");
    const idxWhatsapp = html.indexOf("Compartilhar no WhatsApp");
    const idxEncerrar = html.indexOf("Para encerrar");
    assert.ok(idxReveal !== -1, "reveal do ERRO INTENCIONAL ausente do render completo");
    assert.ok(idxWhatsapp !== -1, "bloco WhatsApp ausente do render completo");
    assert.ok(idxEncerrar !== -1, "'Para encerrar' ausente do render completo");
    assert.ok(
      idxReveal < idxWhatsapp && idxWhatsapp < idxEncerrar,
      `ordem esperada reveal < whatsapp < encerrar, achou reveal=${idxReveal} whatsapp=${idxWhatsapp} encerrar=${idxEncerrar}`,
    );
  });
});

describe("#4512 (fleet review round 2, achados comment-analyzer/code-reviewer): titleLine/hookLine do HTML derivam de buildWhatsappShareBlock, não duplicam", () => {
  it("o hook (2ª linha) do HTML renderizado é EXATAMENTE a 2ª linha do bloco wa.me — não uma cópia manual que pode divergir", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappSubscribeUrl(EDITION));
    const [, hookLine] = block.split("\n\n");
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.ok(html.includes(hookLine), "hook renderizado no HTML deve ser byte-idêntico à 2ª linha de buildWhatsappShareBlock");
  });

  it("o título (1ª linha) do HTML renderizado é EXATAMENTE a 1ª linha do bloco wa.me", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappSubscribeUrl(EDITION));
    const [titleLine] = block.split("\n\n");
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.ok(html.includes(titleLine), "título renderizado deve ser byte-idêntico à 1ª linha de buildWhatsappShareBlock");
  });
});
