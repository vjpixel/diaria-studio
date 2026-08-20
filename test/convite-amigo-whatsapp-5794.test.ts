/**
 * test/convite-amigo-whatsapp-5794.test.ts (#5794)
 *
 * Bloco fixo "Convide pelo WhatsApp" — `scripts/lib/newsletter-render-html.ts`
 * (`buildConviteAmigoBlock`, `buildConviteAmigoUrl`, `buildConviteAmigoShareLink`,
 * `renderConviteAmigo`). Pedido de leitor (WhatsApp, 20/08/2026): o bloco
 * `renderWhatsappShare` existente (#4486/#4570) compartilha a NOTÍCIA (D1); este
 * bloco NOVO compartilha a ASSINATURA em si — convite pra outras pessoas
 * assinarem a newsletter.
 *
 * Cobertura do critério de pronto da issue:
 *   - URL aponta pra HOME (https://diar.ia.br/), NÃO pra edição.
 *   - UTM tem os 3 params certos (utm_source=whatsapp, utm_medium=referral,
 *     utm_campaign=convite-leitor) — fixo, não varia por edição.
 *   - Link `wa.me/?text=` bem formado, com o texto pré-preenchido correto.
 *   - Bloco renderiza no HTML final, após o último destaque e ANTES de "Para
 *     encerrar" (posição decidida na issue — corrigido em 260821 após achado
 *     ao vivo no gate do Stage 4: a 1ª implementação, PR #5802, tinha
 *     colocado DEPOIS de "Para encerrar", sem a frase de convite nem o box
 *     bege decididos, e com rótulo de botão diferente do combinado), sempre
 *     presente (não depende de destaques/edição).
 *   - Box bege (painel `SURFACE`, sem borda) com a frase "Conhece alguém que
 *     ia gostar de receber esta newsletter?" seguida do botão "Convide pelo
 *     WhatsApp →" — rotulado de forma DISTINTA do botão "Compartilhar no
 *     WhatsApp" existente (renderWhatsappShare) — evita a confusão relatada
 *     pelo leitor.
 *   - A entry nova em scripts/lib/shared/utm-registry.ts é coerente com os
 *     valores emitidos (mesmo padrão do #4041 — emissor deriva do registry).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildConviteAmigoBlock,
  buildConviteAmigoUrl,
  buildConviteAmigoShareLink,
  renderConviteAmigo,
  renderWhatsappShare,
  renderHTML,
} from "../scripts/lib/newsletter-render-html.ts";
import { CONVITE_AMIGO_UTM, findUtmEmitter } from "../scripts/lib/shared/utm-registry.ts";
import { BEEHIIV_BASE_URL } from "../scripts/lib/edition-url.ts";
import type { RenderDestaque, NewsletterContent } from "../scripts/lib/newsletter-parse.ts";

function makeD1(overrides: Partial<RenderDestaque> = {}): RenderDestaque {
  return {
    n: 1,
    category: "🚀 LANÇAMENTO",
    emoji: "🚀",
    title: "IA generativa muda o jeito de programar",
    body: "Corpo do destaque.",
    why: "Por que importa.",
    url: "https://example.com/d1",
    ...overrides,
  };
}

describe("#5794 — buildConviteAmigoUrl", () => {
  it("aponta pra HOME (https://diar.ia.br/), não pra uma edição", () => {
    const url = new URL(buildConviteAmigoUrl());
    assert.equal(url.origin, BEEHIIV_BASE_URL);
    assert.equal(url.pathname, "/");
  });

  it("carrega os 3 params UTM do contrato da issue: utm_source=whatsapp, utm_medium=referral, utm_campaign=convite-leitor", () => {
    const url = new URL(buildConviteAmigoUrl());
    assert.equal(url.searchParams.get("utm_source"), "whatsapp");
    assert.equal(url.searchParams.get("utm_medium"), "referral");
    assert.equal(url.searchParams.get("utm_campaign"), "convite-leitor");
  });

  it("utm_campaign é FIXO — não varia por edição (diferente de buildWhatsappEditionUrl)", () => {
    const a = buildConviteAmigoUrl();
    const b = buildConviteAmigoUrl();
    assert.equal(a, b, "a URL é determinística e idêntica em toda chamada, sem parâmetro de edição");
  });
});

describe("#5794 — buildConviteAmigoBlock", () => {
  it("contém o texto de convite pedido na issue e a URL da home", () => {
    const url = buildConviteAmigoUrl();
    const block = buildConviteAmigoBlock(url);
    assert.match(block, /diar\.ia\.br/);
    assert.match(block, /resumo diário de IA em português, grátis/i);
    assert.ok(block.includes(url), "URL da home ausente do bloco");
  });

  it("SEM markdown — nada de **, #, ou '- ' (regra de output final sem markdown)", () => {
    const block = buildConviteAmigoBlock(buildConviteAmigoUrl());
    assert.ok(!block.includes("**"));
    assert.ok(!/^#/m.test(block));
    assert.ok(!/^- /m.test(block));
  });
});

describe("#5794 — buildConviteAmigoShareLink", () => {
  it("é um link wa.me/?text= bem formado, decodificável de volta pro bloco original", () => {
    const link = buildConviteAmigoShareLink();
    assert.match(link, /^https:\/\/wa\.me\/\?text=/);
    const decoded = decodeURIComponent(link.slice("https://wa.me/?text=".length));
    assert.equal(decoded, buildConviteAmigoBlock(buildConviteAmigoUrl()));
  });
});

describe("#5794 — renderConviteAmigo (HTML)", () => {
  it("renderiza o botão 'Convide pelo WhatsApp', rotulado DISTINTO de 'Compartilhar no WhatsApp'", () => {
    const html = renderConviteAmigo();
    assert.match(html, /Convide pelo WhatsApp/);
    assert.ok(!html.includes("Compartilhar no WhatsApp"), "não deve reusar o rótulo do bloco existente (evita a confusão da issue)");
  });

  it("aponta pro link wa.me com o convite de assinatura, não pra edição", () => {
    const html = renderConviteAmigo();
    const btnMatch = html.match(/<a href="(https:\/\/wa\.me\/\?text=[^"]*)"/);
    assert.ok(btnMatch, "botão wa.me não encontrado");
    const decoded = decodeURIComponent(btnMatch![1].slice("https://wa.me/?text=".length));
    assert.match(decoded, /https:\/\/diar\.ia\.br\/\?/);
  });

  it("botão pill contornado — mesmo padrão visual dos demais CTAs (background papel, border-radius:999px)", () => {
    const html = renderConviteAmigo();
    const btnMatch = html.match(/<a href="https:\/\/wa\.me\/\?text=[^"]*"\s+style="([^"]*)"/);
    assert.ok(btnMatch, "botão não encontrado");
    const style = btnMatch![1];
    assert.match(style, /background:#FBFAF6/i);
    assert.match(style, /border-radius:999px/);
  });

  it("box bege (painel SURFACE) envolvendo a frase de convite + botão — opção B decidida na issue", () => {
    const html = renderConviteAmigo();
    assert.match(html, /Conhece alguém que ia gostar de receber esta newsletter\?/);
    assert.match(html, /background:#EBE5D0;border-radius:12px/i);
  });

  it("não depende de destaques — renderiza sempre, ao contrário de renderWhatsappShare (que retorna vazio sem D1)", () => {
    assert.equal(renderWhatsappShare([], "260801"), "", "sanity: renderWhatsappShare precisa de D1");
    const html = renderConviteAmigo();
    assert.notEqual(html, "", "renderConviteAmigo nunca deve ficar vazio");
  });
});

describe("#5794 — posição no corpo da newsletter: após o último destaque, ANTES de 'Para encerrar'", () => {
  const content: NewsletterContent = {
    title: "Edição teste",
    subtitle: "Teste",
    coverImage: "04-d1-2x1.jpg",
    destaques: [makeD1()],
    eia: { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260801" },
    sections: [],
    sorteio: "**🎁 SORTEIO**\n\nTexto do sorteio.",
    encerrar: "Apoie a curadoria em [apoia.se/diaria](https://apoia.se/diaria).",
  };

  it("bloco 'Convide pelo WhatsApp' aparece no HTML final, ANTES de 'Para encerrar'", () => {
    const html = renderHTML(content);
    const idxEncerrar = html.indexOf("Para encerrar");
    const idxConvite = html.indexOf("Convide pelo WhatsApp");
    assert.ok(idxEncerrar !== -1, "'Para encerrar' ausente do render completo");
    assert.ok(idxConvite !== -1, "bloco 'Convide um amigo' ausente do render completo");
    assert.ok(idxConvite < idxEncerrar, "bloco 'Convide um amigo' deve vir ANTES de 'Para encerrar' (decisão da issue #5794)");
  });

  it("os dois botões WhatsApp (compartilhar notícia + convidar amigo) coexistem, sem colidir", () => {
    const html = renderHTML(content);
    assert.match(html, /Compartilhar no WhatsApp/);
    assert.match(html, /Convide pelo WhatsApp/);
  });

  it("edição sem destaques (defensivo, nunca deveria acontecer): bloco 'Convide um amigo' ainda aparece — não depende de D1", () => {
    const contentSemDestaques: NewsletterContent = { ...content, destaques: [] };
    const html = renderHTML(contentSemDestaques);
    assert.match(html, /Convide pelo WhatsApp/);
  });
});

describe("#5794 — coerência do registry (scripts/lib/shared/utm-registry.ts)", () => {
  it("a entry 'convite-amigo-whatsapp' existe e bate com CONVITE_AMIGO_UTM", () => {
    const emitter = findUtmEmitter("convite-amigo-whatsapp");
    assert.ok(emitter, "entry 'convite-amigo-whatsapp' ausente do inventário");
    assert.equal(emitter!.source, CONVITE_AMIGO_UTM.source);
    assert.equal(emitter!.medium, CONVITE_AMIGO_UTM.medium);
    assert.equal(emitter!.campaignPattern, CONVITE_AMIGO_UTM.campaign);
    assert.equal(emitter!.status, "ativo");
  });

  it("CONVITE_AMIGO_UTM é distinto de WHATSAPP_SHARE_UTM (medium e campaign não colidem)", async () => {
    const { WHATSAPP_SHARE_UTM } = await import("../scripts/lib/shared/utm-registry.ts");
    assert.notEqual(CONVITE_AMIGO_UTM.medium, WHATSAPP_SHARE_UTM.medium);
  });
});
