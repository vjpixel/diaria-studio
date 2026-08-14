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
 * #4582 (mesma sessão, revisão do teste enviado por Brevo — box quebrava em
 * clientes de e-mail) reverteu/ajustou 3 coisas do #4570 dentro do HTML
 * RENDERIZADO (os helpers puros `buildWhatsappShareBlock`/
 * `buildWhatsappEditionUrl`/`buildWhatsappShareLink` NÃO mudaram — a URL
 * continua no bloco que alimenta o `wa.me/?text=`, só não é mais desenhada
 * como linha própria no box):
 *   1. A URL some da linha visível — só a manchete do D1 aparece no box.
 *   2. A manchete do D1 vai em `<strong>` (negrito).
 *   3. Botão volta a ser o MESMO pill contornado (fundo papel) dos demais
 *      CTAs do template, agora centralizado — revertendo o botão preenchido
 *      TEAL do #4570.
 *
 * #5152 (260813) mudou 2 coisas, pedido explícito do editor:
 *   1. Posição: entre D1 e D2 (elemento próprio) → DENTRO do D1, logo após
 *      "Por que isso importa" (`renderDestaque` injeta via o novo parâmetro
 *      `whatsappShareHtml`, só quando `d.n === 1`).
 *   2. Deixa de ser um "box": sem fundo bege (`SURFACE`), sem borda, sem
 *      padding `24px 28px` — vira conteúdo inner (kicker + manchete +
 *      botão), mesmo padrão de `renderAprofundeInner`/`renderHubLinkInner`.
 *   Os helpers puros (`buildWhatsappShareBlock`/`buildWhatsappEditionUrl`/
 *   `buildWhatsappShareLink`) e a UTM não mudaram.
 *
 * #5222 (260814) removeu o kicker "Compartilhe" e a manchete do D1 em
 * `<strong>` — pedido explícito do editor. Como o bloco vive DENTRO da seção
 * do D1 desde #5152, os dois repetiam o título que o leitor acabou de ler
 * logo acima; sobra só o botão. Os helpers puros (inclusive
 * `buildWhatsappShareBlock`, que segue alimentando o `wa.me/?text=` com
 * manchete + URL) não mudaram — some a linha visível, não o link
 * encaminhado.
 *
 * Cobertura do critério de pronto da issue original + #4570 + #4582 + #5152 + #5222:
 *   - Texto sem markdown (`**`, `#`, `- `) — regra "output final sem
 *     markdown" (context/editorial-rules.md) aplicada também aqui.
 *   - Link `wa.me/?text=` bem formado, com o bloco URL-encoded (título + URL
 *     da edição — a URL segue viajando nesse texto, mesmo não aparecendo
 *     como linha solta no box).
 *   - UTM conferindo com o contrato fixo da issue (utm_source=whatsapp,
 *     utm_medium=share, utm_campaign={AAMMDD}) — mantida por decisão
 *     explícita do coordenador no #4570 (atribuição de assinante novo).
 *   - URL aponta pra EDIÇÃO (diar.ia.br/p/{seoSlug(D1)}), não mais pra home.
 *   - Renderiza no HTML final, DENTRO da seção do D1 (após "Por que isso
 *     importa" — #5152), entre o título do D1 e o do D2.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWhatsappShareBlock,
  buildWhatsappEditionUrl,
  buildWhatsappShareLink,
  renderWhatsappShare,
  renderDestaque, // #5152
  renderHTML,
  resetRenderWarnings, // #4673
  getRenderWarnings, // #4673
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
  it("renderiza SÓ o botão de compartilhar (#5222), sem markdown cru", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.match(html, /Compartilhar no WhatsApp/);
    assert.match(html, /https:\/\/wa\.me\/\?text=/);
    // esc() escapa **/#/etc. corretamente — não deve sobrar markdown cru fora de atributo/URL.
    assert.ok(!/<p[^>]*>\s*\*\*/.test(html), "não deve haver ** cru dentro de um <p> renderizado");
  });

  it("sem emoji 📰 no HTML renderizado (#4570 item 2)", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.ok(!html.includes("📰"), "emoji não deve aparecer no bloco WhatsApp renderizado");
  });

  it("botão pill contornado, fundo papel — mesmo padrão dos demais CTAs (#4582, reverte o preenchido TEAL do #4570)", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    const btnMatch = html.match(/<a href="https:\/\/wa\.me\/\?text=[^"]*"\s+style="([^"]*)"/);
    assert.ok(btnMatch, "botão Compartilhar no WhatsApp não encontrado no HTML");
    const style = btnMatch![1];
    assert.match(style, /background:#FBFAF6/i, "botão deve usar o mesmo fundo papel dos demais CTAs (COLORS.paper)");
    assert.ok(!/background:#00A0A0/i.test(style), "botão não deve mais usar o preenchido TEAL do #4570");
    assert.match(style, /border-radius:999px/, "botão deve continuar sendo um pill");
  });

  it("botão centralizado (#4582 — antes ficava alinhado à esquerda)", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    // #5222: kicker + manchete saíram, então o `margin-top:16px` que só
    // existia pra separar o botão da manchete também saiu — o wrapper do
    // botão fica colado no <td> (só o margin-top do wrapper externo, herdado
    // do BOX_MARGIN_TOP da <table>, separa do parágrafo do D1 acima).
    assert.match(
      html,
      /<div style="text-align:center;">\s*<a href="https:\/\/wa\.me\/\?text=/,
      "botão deve estar envolto por um wrapper text-align:center",
    );
  });

  it("#5152: sem container de box (fundo bege, borda, padding 24px 28px) — vira conteúdo inner", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.ok(!html.includes("padding:24px 28px"), "não deve mais ter o padding do box bege");
    assert.ok(!/background:#EBE5D0/i.test(html), "não deve mais usar SURFACE (fundo bege do box)");
    assert.ok(!html.includes('<tr><td class="pad"'), "não deve mais ser uma seção própria (<tr><td class=\"pad\">) — vira conteúdo inner de renderDestaque");
  });

  it("#5222: sem kicker 'Compartilhe' nem manchete do D1 em <strong> — só o botão", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    assert.ok(!html.includes(`<strong>${D1_TITLE}</strong>`), "manchete do D1 NÃO deve mais aparecer como linha própria em <strong> (#5222)");
    // "Compartilhe<" só bate no kicker (`&nbsp;Compartilhe</td>`) — não colide
    // com o texto do botão "Compartilhar no WhatsApp" (Compartilh + AR, não + E).
    assert.ok(!html.includes("Compartilhe<"), "kicker 'Compartilhe' não deve mais aparecer como texto visível (#5222)");
    // A URL da edição não deve aparecer como texto/link solto no HTML — só
    // dentro do href URL-encoded do botão wa.me.
    const editionUrl = buildWhatsappEditionUrl(EDITION, D1_TITLE);
    assert.ok(!html.includes(editionUrl), "URL crua não deve aparecer como texto/link visível no box");
  });

  it("retorna string vazia quando não há destaques (defensivo)", () => {
    assert.equal(renderWhatsappShare([], EDITION), "");
  });

  it("#4673: getRenderWarnings() expõe whatsapp_share_no_d1 pra caller programático (não só console.error)", () => {
    resetRenderWarnings();
    renderWhatsappShare([], EDITION);
    const warnings = getRenderWarnings();
    assert.equal(warnings.length, 1, `esperado 1 evento coletado, obtido: ${JSON.stringify(warnings)}`);
    assert.equal(warnings[0].event, "whatsapp_share_no_d1");
    assert.equal(warnings[0].edition, EDITION);
  });

  it("#4673: caso normal (D1 presente) não deixa ruído — nenhum evento coletado", () => {
    resetRenderWarnings();
    renderWhatsappShare([makeD1()], EDITION);
    assert.deepEqual(getRenderWarnings(), [], "D1 presente não deve produzir nenhum evento coletado");
  });

  it("a URL da edição (diar.ia.br/p/{slug}) viaja dentro do texto do wa.me, mesmo não aparecendo crua no box (#4582)", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    const btnMatch = html.match(/<a href="(https:\/\/wa\.me\/\?text=[^"]*)"/);
    assert.ok(btnMatch, "botão wa.me não encontrado");
    const decoded = decodeURIComponent(btnMatch![1].slice("https://wa.me/?text=".length));
    assert.match(decoded, new RegExp(`https://diar\\.ia\\.br/p/${seoSlug(D1_TITLE)}`));
  });

  it("o texto do wa.me carrega a UTM correta (#4582: já não aparece crua no HTML, só dentro do link codificado)", () => {
    const html = renderWhatsappShare([makeD1()], EDITION);
    const btnMatch = html.match(/<a href="(https:\/\/wa\.me\/\?text=[^"]*)"/);
    assert.ok(btnMatch, "botão wa.me não encontrado");
    const decoded = decodeURIComponent(btnMatch![1].slice("https://wa.me/?text=".length));
    assert.match(decoded, new RegExp(`utm_source=whatsapp.*utm_medium=share.*utm_campaign=${EDITION}|utm_campaign=${EDITION}.*utm_medium=share.*utm_source=whatsapp`));
  });

  it("#4519/#5222: título do D1 com caracteres especiais (&, aspas, <tag>) nunca vaza como HTML cru — só viaja percent-encoded dentro do href", () => {
    const dangerousTitle = 'Título com & "aspas" e <tag>';
    const html = renderWhatsappShare([makeD1({ title: dangerousTitle })], EDITION);
    // #5222: a manchete deixou de ser renderizada como texto visível (sem
    // <p>/<strong> própria) — não há mais nada pra "esc()" no corpo do bloco.
    // O que importa agora é que o título nunca vaze cru (nem como HTML, nem
    // fora do encoding do wa.me) e que o href continue seguro.
    assert.ok(!html.includes("<tag>"), "título não deve vazar como tag HTML crua");
    assert.ok(!html.includes(dangerousTitle), "título cru não deve aparecer em lugar nenhum do HTML");
    // #4582: o box só tem 1 <a href> agora — o botão "Compartilhar no
    // WhatsApp →" (wa.me). A linha de URL da edição saiu do box (só segue
    // dentro do texto URL-encoded do próprio botão).
    const hrefMatches = html.match(/<a href="([^"]*)"/g) ?? [];
    assert.equal(hrefMatches.length, 1, `esperava exatamente 1 <a href> (botão wa.me), achou ${hrefMatches.length}`);
    assert.ok(
      hrefMatches.some((h) => /^<a href="https:\/\/wa\.me\/\?text=/.test(h)),
      "href do botão wa.me deve continuar apontando pro compartilhamento",
    );
    // O título especial continua viajando no texto do wa.me — só que
    // percent-encoded (encodeURIComponent), nunca como entidade HTML.
    const btnMatch = html.match(/<a href="(https:\/\/wa\.me\/\?text=[^"]*)"/);
    assert.ok(btnMatch, "botão wa.me não encontrado");
    const decoded = decodeURIComponent(btnMatch![1].slice("https://wa.me/?text=".length));
    assert.ok(decoded.includes(dangerousTitle), "título especial deve continuar íntegro dentro do texto do wa.me, uma vez decodificado");
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
    // #5222: a manchete não é mais texto visível — checar via o href do
    // botão wa.me (decodificado), não via substring cru no corpo do HTML.
    const btnMatch = html.match(/<a href="(https:\/\/wa\.me\/\?text=[^"]*)"/);
    assert.ok(btnMatch, "botão wa.me não encontrado");
    const decoded = decodeURIComponent(btnMatch![1].slice("https://wa.me/?text=".length));
    assert.ok(decoded.includes(D1_TITLE), "título do D1 deve estar no texto do wa.me");
    assert.ok(!html.includes(d2Title), "título do D2 nunca deve aparecer no bloco WhatsApp");
    assert.ok(!html.includes(d3Title), "título do D3 nunca deve aparecer no bloco WhatsApp");
  });
});

describe("#4570/#5152 — posição no corpo da newsletter: DENTRO do D1, entre D1 e D2", () => {
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

  it("#5152: bloco WhatsApp aparece DEPOIS de \"Por que isso importa\" do D1 (posição exata pedida pelo editor)", () => {
    const html = renderHTML(content);
    const idxWhy = html.indexOf("Por que importa."); // why do D1, ver makeD1()
    const idxWhatsapp = html.indexOf("Compartilhar no WhatsApp");
    assert.ok(idxWhy !== -1, "box \"Por que isso importa\" do D1 ausente do render completo");
    assert.ok(idxWhy < idxWhatsapp, "bloco WhatsApp deve vir DEPOIS do box \"Por que isso importa\"");
  });

  it("#5152: bloco WhatsApp está DENTRO da seção do D1 — antes do fechamento do <tr> do D1, não é mais uma seção própria entre D1 e D2", () => {
    const html = renderHTML(content);
    const idxD1Comment = html.indexOf("<!-- Destaque 1 -->");
    const idxWhatsapp = html.indexOf("Compartilhar no WhatsApp");
    const idxD1SectionClose = html.indexOf("</td></tr>", idxD1Comment);
    assert.ok(idxD1Comment !== -1 && idxWhatsapp !== -1 && idxD1SectionClose !== -1);
    assert.ok(
      idxD1Comment < idxWhatsapp && idxWhatsapp < idxD1SectionClose,
      "bloco WhatsApp deve estar entre a abertura e o fechamento da própria seção <tr> do D1",
    );
  });

  it("#5152 (achado silent-failure-hunter): sem divergência entre os 2 sinais de D1, nenhum evento whatsapp_share_d1_mismatch é coletado", () => {
    resetRenderWarnings();
    renderHTML(content);
    assert.deepEqual(
      getRenderWarnings().filter((w) => w.event === "whatsapp_share_d1_mismatch"),
      [],
      "caso normal (destaques[0].n === 1) não deve produzir esse evento",
    );
  });

  it("#5152 (achado silent-failure-hunter): destaques[0].n !== 1 (dado malformado, nunca deveria acontecer) dispara whatsapp_share_d1_mismatch em vez de sumir em silêncio", () => {
    const malformedContent: NewsletterContent = {
      ...content,
      // Simula os 2 sinais divergindo — posição 0 (o que decide ONDE
      // injetar) com n=2 (o que decide SE injeta). Nunca deveria acontecer
      // com dado real (destaques sempre vêm na ordem 1..3), mas o guard
      // defensivo precisa AVISAR, não só engolir o bloco.
      destaques: [makeD1({ n: 2 }), makeD2({ n: 1 })],
    };
    resetRenderWarnings();
    renderHTML(malformedContent);
    const warnings = getRenderWarnings().filter((w) => w.event === "whatsapp_share_d1_mismatch");
    assert.equal(warnings.length, 1, "divergência entre i===0 e d.n===1 deve emitir exatamente 1 evento");
    assert.equal(warnings[0].edition, EDITION);
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

describe("#4512 (fleet review round 2, achados comment-analyzer/code-reviewer), preservado no #4570/#4582: titleLine do HTML deriva de buildWhatsappShareBlock, não duplica", () => {
  it("#4582: a URL (2ª linha do bloco) NÃO aparece mais crua no HTML — só URL-encoded dentro do href do botão wa.me", () => {
    const url = buildWhatsappEditionUrl(EDITION, D1_TITLE);
    const block = buildWhatsappShareBlock(D1_TITLE, url);
    const [, urlLine] = block.split("\n\n");
    const html = renderWhatsappShare([makeD1()], EDITION);
    const escapedUrl = escHtml(urlLine);
    assert.ok(!html.includes(escapedUrl), "URL não deve mais aparecer como texto/link visível no box (#4582)");
    // Mas continua presente, URL-encoded, dentro do texto que alimenta o wa.me.
    const link = buildWhatsappShareLink(block);
    assert.ok(html.includes(escHtml(link)), "link wa.me com a URL embutida deve continuar no HTML");
  });

  it("#5222: o título (1ª linha do bloco wa.me) não é mais linha visível — migra pra checar o href do botão, byte-idêntico à 1ª linha de buildWhatsappShareBlock", () => {
    const block = buildWhatsappShareBlock(D1_TITLE, buildWhatsappEditionUrl(EDITION, D1_TITLE));
    const [titleLine] = block.split("\n\n");
    const html = renderWhatsappShare([makeD1()], EDITION);
    const btnMatch = html.match(/<a href="(https:\/\/wa\.me\/\?text=[^"]*)"/);
    assert.ok(btnMatch, "botão wa.me não encontrado");
    const decoded = decodeURIComponent(btnMatch![1].slice("https://wa.me/?text=".length));
    const [decodedTitleLine] = decoded.split("\n\n");
    assert.equal(decodedTitleLine, titleLine, "título embutido no href deve ser byte-idêntico à 1ª linha de buildWhatsappShareBlock");
  });
});

describe("#5152 — renderDestaque(d, whatsappShareHtml): injeção restrita ao D1", () => {
  const whatsappHtml = renderWhatsappShare([makeD1()], EDITION);

  it("d.n === 1: o conteúdo passado em whatsappShareHtml aparece no HTML do destaque", () => {
    const html = renderDestaque(makeD1(), whatsappHtml);
    assert.ok(html.includes("Compartilhar no WhatsApp"), "bloco WhatsApp ausente do D1 quando passado explicitamente");
  });

  it("d.n === 2: whatsappShareHtml é ignorado mesmo se passado (guard defensivo, no mesmo espírito anti-vazamento do #4519)", () => {
    const html = renderDestaque(makeD2(), whatsappHtml);
    assert.ok(!html.includes("Compartilhar no WhatsApp"), "bloco WhatsApp nunca deve aparecer em D2, mesmo se o caller passar por engano");
  });

  it("sem 2º argumento: D1 renderiza normalmente, sem bloco WhatsApp (default vazio)", () => {
    const html = renderDestaque(makeD1());
    assert.ok(!html.includes("Compartilhar no WhatsApp"), "sem o 2º argumento, nenhum bloco WhatsApp deve aparecer");
  });

  it("bloco WhatsApp vem DEPOIS de \"Por que isso importa\" dentro do HTML do D1", () => {
    const html = renderDestaque(makeD1(), whatsappHtml);
    const idxWhy = html.indexOf("Por que isso importa");
    const idxWhatsapp = html.indexOf("Compartilhar no WhatsApp");
    assert.ok(idxWhy !== -1 && idxWhatsapp !== -1);
    assert.ok(idxWhy < idxWhatsapp, "bloco WhatsApp deve vir depois do kicker \"Por que isso importa\"");
  });
});
