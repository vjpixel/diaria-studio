/**
 * test/render-newsletter-html-kit-inline-styles-6506.test.ts (#6506)
 *
 * O e-mail do canal Kit passa de 102 KB (limite de clipping do Gmail) e
 * ~50,3% do corpo são atributos `style=""` inline. `extractRepeatedInlineStyles`
 * troca os `style=""` mais repetidos (botão pill CTA, link inline de corpo)
 * por `class=""` curtas — SÓ pro fragmento `esp: "kit"`, nunca Beehiiv/Brevo
 * (a Beehiiv remove o `<style>` inteiro do e-mail entregue; um link sem
 * style inline sairia sem estilo nenhum lá).
 *
 * Guard central: o fragmento Beehiiv (esp default) tem que sair BYTE-
 * IDÊNTICO ao que saía antes deste PR — a extração de constante
 * (`CTA_BUTTON_STYLE`/`INLINE_LINK_STYLE`) não deve, por si só, mudar
 * nenhum output fora do caminho `esp: "kit"`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderHTML } from "../scripts/render-newsletter-html.ts";
import {
  extractRepeatedInlineStyles,
  buildKitInlineClassStyleBlock,
  KIT_INLINE_STYLE_CLASS_MAP,
} from "../scripts/lib/newsletter-render-html.ts";

function d(n: 1 | 2 | 3, url: string) {
  return {
    n,
    category: "NOTÍCIAS",
    title: `Título do destaque ${n}`,
    body: `Corpo do destaque ${n} com um [link de teste](https://example.com/${n}) no meio do texto.`,
    why: `Por que importa ${n}`,
    url,
    emoji: "🤖",
    imageFile: `04-d${n}-2x1.jpg`,
  };
}

const fixt = (extras: Partial<Record<string, unknown>> = {}) => ({
  title: "X",
  subtitle: "X",
  coverImage: "04-d1-2x1.jpg",
  // 3 destaques × 1 link markdown cada = 3 ocorrências de INLINE_LINK_STYLE,
  // acima do piso de 2 (`extractRepeatedInlineStyles` default) — garante que
  // o caminho de extração REALMENTE dispare nestes testes, não fique preso
  // no piso de segurança.
  destaques: [d(1, "https://example.com/d1"), d(2, "https://example.com/d2"), d(3, "https://example.com/d3")],
  eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
  sections: [],
  ...extras,
});

describe("extractRepeatedInlineStyles (pure) (#6506)", () => {
  it("2+ ocorrências: substitui style=\"<valor exato>\" por class=\"<nome>\" em toda ocorrência", () => {
    const html = `<a style="color:red;">a</a><a style="color:red;">b</a><a style="color:blue;">c</a>`;
    const out = extractRepeatedInlineStyles(html, { r: "color:red;" });
    assert.equal(out, `<a class="r">a</a><a class="r">b</a><a style="color:blue;">c</a>`);
  });

  it("< minOccurrences (default 2): 1 ocorrência isolada NÃO é trocada (nunca piora bytes sozinha)", () => {
    const html = `<a style="color:red;">a</a><a style="color:blue;">c</a>`;
    const out = extractRepeatedInlineStyles(html, { r: "color:red;" });
    assert.equal(out, html);
  });

  it("minOccurrences customizável — 1 força a troca mesmo com 1 ocorrência só", () => {
    const html = `<a style="color:red;">a</a>`;
    const out = extractRepeatedInlineStyles(html, { r: "color:red;" }, { minOccurrences: 1 });
    assert.equal(out, `<a class="r">a</a>`);
  });

  it("não casa substring parcial (só o atributo inteiro entre aspas)", () => {
    const html = `<a style="color:red;font-weight:bold;">a</a><a style="color:red;font-weight:bold;">b</a>`;
    const out = extractRepeatedInlineStyles(html, { r: "color:red;" });
    // o style aqui tem MAIS propriedades que o valor buscado — não deve casar
    // mesmo com 2 ocorrências do padrão MAIOR (não é substring do alvo).
    assert.equal(out, html);
  });

  it("sem ocorrência → html inalterado", () => {
    const html = `<p>sem estilos aqui</p>`;
    assert.equal(extractRepeatedInlineStyles(html, { r: "color:red;" }), html);
  });
});

describe("buildKitInlineClassStyleBlock (pure) (#6506)", () => {
  it("lista vazia → string vazia (0 classes usadas, 0 bytes de <style> gastos à toa)", () => {
    assert.equal(buildKitInlineClassStyleBlock([]), "");
  });

  it("só emite regra pras classes efetivamente passadas (não as 3 sempre)", () => {
    const block = buildKitInlineClassStyleBlock(["dl"]);
    assert.match(block, /\.dl\{/);
    assert.doesNotMatch(block, /\.cb\{/);
    assert.doesNotMatch(block, /\.cbm\{/);
  });
});

describe("renderHTML esp:\"kit\" — classes em vez de style repetido (#6506)", () => {
  it("fragmento kit: link inline de corpo (`.dl`, 3 ocorrências na fixture) sai via class, não style repetido", () => {
    const html = renderHTML(fixt(), { esp: "kit" });
    // Nenhuma ocorrência LITERAL do valor completo de INLINE_LINK_STYLE
    // deveria sobrar como style="" no fragmento kit — foi trocada por class="dl".
    assert.doesNotMatch(html, new RegExp(`style="${KIT_INLINE_STYLE_CLASS_MAP.dl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(html, /class="dl"/, "link inline do destaque usa class=\"dl\"");
    // A regra .dl precisa estar presente no <style> — sem ela a classe fica
    // sem CSS nenhum (Kit nunca teria o que inlinar).
    assert.ok(html.includes(".dl{"), "regra .dl presente no <style> do fragmento kit");
    // .cb/.cbm não aparecem nesta fixture (sem CTA pill) — a regra correspondente
    // não deveria ser emitida à toa.
    assert.doesNotMatch(html, /\.cb\{/);
    assert.doesNotMatch(html, /\.cbm\{/);
  });

  it("fragmento beehiiv (esp default): NENHUMA classe kit-only — style inline continua completo (Beehiiv remove o <style> do e-mail entregue)", () => {
    const html = renderHTML(fixt());
    assert.doesNotMatch(html, /class="dl"/);
    assert.doesNotMatch(html, /class="cb"/);
    // o valor completo do link inline deve sobreviver INLINE — é o que
    // sustenta a cor/sublinhado quando a Beehiiv apaga o <style>.
    assert.ok(html.includes(`style="${KIT_INLINE_STYLE_CLASS_MAP.dl}"`), "link inline segue com style completo no Beehiiv");
  });

  it("fragmento brevo: mesma disciplina do beehiiv — sem classes kit-only", () => {
    const html = renderHTML(fixt(), { esp: "brevo" });
    assert.doesNotMatch(html, /class="dl"/);
    assert.doesNotMatch(html, /class="cb"/);
  });

  it("fragmento kit sai MENOR que o mesmo conteúdo sem a extração de classe (regressão de tamanho, #6506)", () => {
    // Compara contra o fragmento SEM aplicar extractRepeatedInlineStyles —
    // simula "como seria se #6506 não tivesse mexido nisso" reconstruindo o
    // valor completo inline no lugar da classe. Serve de guarda: se o
    // mecanismo parar de substituir nada (regressão silenciosa), este teste
    // falha porque os dois tamanhos ficam iguais.
    const kitHtml = renderHTML(fixt(), { esp: "kit" });
    const withoutExtraction = Object.entries(KIT_INLINE_STYLE_CLASS_MAP).reduce(
      (acc, [name, style]) => acc.split(`class="${name}"`).join(`style="${style}"`),
      kitHtml,
    );
    assert.ok(
      Buffer.byteLength(kitHtml, "utf8") < Buffer.byteLength(withoutExtraction, "utf8"),
      "extração de classe reduz bytes do fragmento kit",
    );
  });

  it("fragmento kit com só 1 link (abaixo do piso de 2): fica inline, SEM <style> extra pra .dl (nunca regride)", () => {
    const single = renderHTML(
      fixt({ destaques: [d(1, "https://example.com/d1")] }),
      { esp: "kit" },
    );
    assert.doesNotMatch(single, /class="dl"/);
    assert.doesNotMatch(single, /\.dl\{/);
    assert.ok(single.includes(`style="${KIT_INLINE_STYLE_CLASS_MAP.dl}"`));
  });
});
