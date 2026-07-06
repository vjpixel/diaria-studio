/**
 * render-newsletter-midcallout.test.ts
 *
 * Cobre o box do meio (entre D1 e D2) adicionado ao render-newsletter-html.ts:
 * promo da página de livros com imagem + texto + botão CTA. Sem imagem, cai
 * no box só-texto (renderIntroCallout). Regressão pro caso 260604.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractBoxDivulgacao1,
  stripBoxDivulgacao1,
  renderMidCallout,
  renderBoxDivulgacao,
  renderHTML,
  readBoxDivulgacao1Image,
  readBoxDivulgacao2Image,
  isBoxDivulgacaoLivros,
  renderIntroCallout,
} from "../scripts/render-newsletter-html.ts";
import type { NewsletterContent } from "../scripts/render-newsletter-html.ts";
import { parseDestaques } from "../scripts/extract-destaques.ts";

const MD = `Para esta edição, selecionamos 15 itens.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Corpo do destaque 1.

Por que isso importa:

Algo importante.

---

**📚 Nossa curadoria de livros sobre IA ganhou página nova. [Confira a nova página](https://livros.diaria.workers.dev).**

---

**DESTAQUE 2 | 🚀 LANÇAMENTO**

**[Título D2](https://example.com/d2)**

Corpo do destaque 2.
`;

describe("boxDivulgacao1 — box entre D1 e D2", () => {
  it("extractBoxDivulgacao1 pega o box bold-wrapped 📚 entre D1 e D2", () => {
    const c = extractBoxDivulgacao1(MD);
    assert.ok(c, "deveria achar o box");
    assert.match(c!, /^📚 Nossa curadoria/);
    assert.match(c!, /\[Confira a nova página\]\(https:\/\/livros\.diaria\.workers\.dev\)/);
  });

  it("extractBoxDivulgacao1 retorna null quando não há box", () => {
    const semBox = MD.replace(/\*\*📚[^\n]*\n/, "");
    assert.equal(extractBoxDivulgacao1(semBox), null);
  });

  it("extractBoxDivulgacao1 não casa títulos de destaque (começam com [)", () => {
    const c = extractBoxDivulgacao1(MD);
    assert.ok(!/Título D1/.test(c ?? ""), "não deve capturar o título do destaque");
  });

  it("renderMidCallout sem imagem cai no box só-texto (sem <img> nem botão)", () => {
    const html = renderMidCallout("📚 Promo. [Confira](https://livros.diaria.workers.dev).", null);
    assert.ok(!html.includes("<img"), "não deve ter imagem");
    // #2067: sem imagem, não há CTA pill (border-radius:999px é o marcador do pill)
    assert.ok(!html.includes("border-radius:999px"), "não deve ter botão CTA pill");
    // ainda deve renderizar o texto + link inline
    assert.ok(html.includes("Confira") || html.includes("livros.diaria.workers.dev"));
  });

  it("renderMidCallout com imagem inclui <img>, botão CTA e o link do box", () => {
    const url = "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo.jpg";
    const html = renderMidCallout(
      "📚 Promo da página. [Confira a nova página](https://livros.diaria.workers.dev).",
      url,
    );
    assert.match(html, new RegExp(`<img[^>]+src="${url.replace(/[.?*+^$()[\]{}|\\/]/g, "\\$&")}"`));
    // #2067: CTA label derivado do anchor text do 1º link
    assert.ok(html.includes("Confira a nova página"), "deve ter o botão CTA com o texto do link");
    assert.ok(html.includes("https://livros.diaria.workers.dev"), "imagem/botão linkam pro destino do box");
    // o texto do body não deve mais conter o markdown-link cru
    assert.ok(!html.includes("[Confira a nova página]"), "markdown-link removido do corpo");
  });

  it("single-parágrafo COM imagem: marcador 📚 removido e corpo em peso normal/1.62 (DS body, 260611)", () => {
    const html = renderMidCallout(
      "📚 Promo da página. [Confira a nova página](https://livros.diaria.workers.dev).",
      "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo.jpg",
    );
    assert.ok(!html.includes("📚"), "emoji do marcador não deve renderizar no box com imagem");
    // #2067: corpo (parágrafo antes do CTA) não usa bold 600 — checa no bloco inteiro
    // excluindo o CTA pill (que pode ser bold). Nenhum <p> de 16px deve ter font-weight:600.
    assert.ok(!/font-size:16px[^"]*font-weight:600/.test(html), "corpo não usa bold 600 nos parágrafos");
    assert.match(html, /line-height:1\.62/);
  });

  it("review #2066: corpo que é só marcador+link não emite <p> fantasma", () => {
    const html = renderMidCallout(
      "📚 [Confira a nova página](https://livros.diaria.workers.dev).",
      "https://img.example/p.jpg",
    );
    assert.ok(!/<p[^>]*>\s*<\/p>/.test(html), "sem parágrafo vazio entre imagem e CTA");
    // #2067: CTA derivado do anchor text; "Confira a nova página" é o label do link
    assert.ok(html.includes("Confira a nova página"), "CTA preservado com label do link");
  });

  it("review #2066: stripCalloutMarker consome VS15 (U+FE0E) além do VS16", () => {
    const html = renderMidCallout(
      "📚︎ Promo da página. [Confira](https://livros.diaria.workers.dev).",
      "https://img.example/p.jpg",
    );
    assert.ok(!html.includes("︎"), "variation selector não vaza pro HTML");
    assert.ok(html.includes("Promo da página"), "corpo preservado");
  });

  it("callout multi-parágrafo (ex: Clarice) renderiza título serif em 26px (DS h4)", () => {
    // #DS callout/É IA? title h4: o 1º parágrafo vira título serif; antes 22px (h5), agora 26px (h4).
    const html = renderMidCallout(
      "📣 Escreva melhor com a Clarice.ai\n\nA IA brasileira que revisa textos.\n\n[Acesse](https://clarice.ai/precos-planos?via=diaria).",
      null,
    );
    const titleMatch = html.match(/<p style="([^"]+)">Escreva melhor com a Clarice\.ai<\/p>/);
    assert.ok(titleMatch, "título do callout multi-parágrafo deve sair num <p> próprio (marcador 📣 removido)");
    assert.match(titleMatch![1], /font-size:26px/, "título do callout é 26px (DS h4)");
    assert.doesNotMatch(titleMatch![1], /font-size:22px/, "não deve mais ser 22px (h5)");
  });

  it("callout multi-parágrafo COM imagem também renderiza título em 26px (DS h4)", () => {
    // O caminho com imagem (renderMidCallout, paras.length>1) espelha o sem imagem (#1938)
    // — o título serif deve sair em 26px igual, não 22px.
    const html = renderMidCallout(
      "📚 Curadoria de livros sobre IA\n\nPágina nova com filtros. [Confira](https://livros.diaria.workers.dev).",
      "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo.jpg",
    );
    const titleMatch = html.match(/<p style="([^"]+)">Curadoria de livros sobre IA<\/p>/);
    assert.ok(titleMatch, "título serif do callout com imagem deve sair num <p> próprio (marcador 📚 removido)");
    assert.match(titleMatch![1], /font-size:26px/, "título do callout com imagem é 26px (DS h4)");
    assert.doesNotMatch(titleMatch![1], /font-size:22px/, "não deve mais ser 22px (h5)");
  });

  // ── Regressão dos achados de code-review do PR #1807 ──────────────────

  it("link com parênteses na URL não trunca (#1634-safe, #3I)", () => {
    const html = renderMidCallout(
      "📚 Promo. [Baixe o guia](https://ex.com/Founders-Playbook%20(1).pdf).",
      "https://img.example/p.jpg",
    );
    assert.ok(
      html.includes("https://ex.com/Founders-Playbook%20(1).pdf"),
      "URL completa (com parênteses) deve sobreviver no href",
    );
    assert.ok(!html.includes(">.pdf"), "não deve vazar resto da URL como texto");
  });

  it("escapa aspas/< no src e href (#3G)", () => {
    const html = renderMidCallout(
      `📚 Promo. [Confira](https://ex.com/a"onmouseover=x).`,
      `https://img.example/p.jpg"><script>`,
    );
    assert.ok(!html.includes(`p.jpg"><script>`), "src cru não deve aparecer");
    assert.ok(html.includes("&quot;"), "aspas devem ser escapadas no atributo");
  });

  // ── #1808: produtor (06-public-images.json) → consumidor (render) ──────

  it("e2e: entry livros_promo no JSON → readBoxDivulgacao1Image → renderMidCallout emite <img> + botão", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-"));
    try {
      // como o produtor (upload-images-public.ts --mode newsletter) grava:
      const cfUrl = "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo.jpg";
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { livros_promo: { cloudflare_url: cfUrl, url: cfUrl } } }),
      );
      // #finding-6: agora o caller precisa passar o texto do callout explicitamente.
      const url = readBoxDivulgacao1Image(dir, "📚 Curadoria de livros. [Ver a página](https://livros.diaria.workers.dev).");
      assert.equal(url, cfUrl, "readBoxDivulgacao1Image deve ler a cloudflare_url do produtor");
      const html = renderMidCallout(
        "📚 Curadoria de livros. [Ver a página](https://livros.diaria.workers.dev).",
        url,
      );
      assert.match(html, /<img[^>]+src="[^"]*livros-promo/, "box deve emitir <img> da promo");
      // #2067: CTA label derivado do anchor text do link no texto do box
      assert.ok(html.includes("Ver a página"), "box deve ter o botão CTA com label do link");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("e2e: sem entry livros_promo → readBoxDivulgacao1Image null → box só-texto (degradação graciosa)", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-"));
    try {
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images: { d1: { url: "x" } } }));
      // No livros_promo entry → null even for livros callout.
      assert.equal(readBoxDivulgacao1Image(dir, "📚 Promo. [Ver](https://livros.diaria.workers.dev)."), null);
      const html = renderMidCallout("📚 Promo. [Ver](https://livros.diaria.workers.dev).", null);
      assert.ok(!html.includes("<img"), "sem produtor → box degrada pra só-texto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remove TODOS os links do corpo, não só o primeiro (#3J)", () => {
    const html = renderMidCallout(
      "📚 Veja [aqui](https://a.com) e também [ali](https://b.com).",
      "https://img.example/p.jpg",
    );
    assert.ok(!html.includes("[aqui]"), "1º markdown-link removido do corpo");
    assert.ok(!html.includes("[ali]"), "2º markdown-link também removido do corpo");
    // o destino da imagem/CTA é o primeiro link
    assert.ok(html.includes("https://a.com"), "CTA usa o primeiro link");
  });
});

// ── #2136 — regressão: imagem livros_promo não contamina box CLARICE ─────────

const CLARICE_CALLOUT = `📣 Escreva melhor em português com a Clarice.ai

A única IA criada por brasileiros para brasileiros. A Clarice.ai foi treinada para entender as nuances da língua portuguesa.

Use a Clarice.ai para revisar, refinar e humanizar seus textos.

→ [Acesse e use os cupons NEWS25 ou NEWS50](https://clarice.ai/precos-planos?via=diaria)`;

const LIVROS_CALLOUT = `📚 Nossa curadoria de livros sobre IA ganhou página nova. [Confira a nova página](https://livros.diaria.workers.dev).`;

describe("#2136 — discriminação livros vs CLARICE + setas", () => {
  // (a) boxDivulgacao1 CLARICE → readBoxDivulgacao1Image retorna null (sem hero)
  it("readBoxDivulgacao1Image: CLARICE callout (📣, link não-livros) → null, mesmo com livros_promo no cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-2136-"));
    try {
      const cfUrl = "https://poll.diaria.workers.dev/img/img-260612-04-livros-promo.jpg";
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { livros_promo: { cloudflare_url: cfUrl } } }),
      );
      const url = readBoxDivulgacao1Image(dir, CLARICE_CALLOUT);
      assert.equal(url, null, "box CLARICE NÃO deve receber a imagem livros_promo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // (b) boxDivulgacao1 livros → readBoxDivulgacao1Image retorna URL
  it("readBoxDivulgacao1Image: livros callout (📚 + livros.diaria.workers.dev) → retorna URL da imagem", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-2136-livros-"));
    try {
      const cfUrl = "https://poll.diaria.workers.dev/img/img-260612-04-livros-promo.jpg";
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { livros_promo: { cloudflare_url: cfUrl } } }),
      );
      const url = readBoxDivulgacao1Image(dir, LIVROS_CALLOUT);
      assert.equal(url, cfUrl, "box livros deve receber a imagem livros_promo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // isBoxDivulgacaoLivros: discriminação correta
  it("isBoxDivulgacaoLivros: 📚 com link livros.diaria.workers.dev → true", () => {
    assert.equal(isBoxDivulgacaoLivros(LIVROS_CALLOUT), true);
  });

  it("isBoxDivulgacaoLivros: 📣 CLARICE (link clarice.ai) → false", () => {
    assert.equal(isBoxDivulgacaoLivros(CLARICE_CALLOUT), false);
  });

  it("isBoxDivulgacaoLivros: null/undefined → false (sem crash)", () => {
    assert.equal(isBoxDivulgacaoLivros(null), false);
    assert.equal(isBoxDivulgacaoLivros(undefined), false);
    assert.equal(isBoxDivulgacaoLivros(""), false);
  });

  // (c) corpo CLARICE não termina com → orphan (renderMidCallout sem imagem)
  it("renderMidCallout CLARICE sem imagem: corpo não termina com → orphan", () => {
    const html = renderMidCallout(CLARICE_CALLOUT, null);
    // o → antes do link não deve aparecer no HTML como texto solto
    assert.ok(!/→\s*<\/p>/.test(html), "→ orphan não deve aparecer no fim de parágrafo de corpo");
    // o link CTA deve ser renderizado (como botão ou inline), não desaparecer
    assert.ok(html.includes("clarice.ai"), "URL da Clarice deve estar no HTML");
  });

  // (d) ctaLabel sem seta — renderMidCallout COM imagem (livros box)
  it("renderMidCallout COM imagem (livros): ctaLabel sem seta →", () => {
    const html = renderMidCallout(
      LIVROS_CALLOUT,
      "https://img.example/livros.jpg",
    );
    // O CTA deve ter o label do link sem "→"
    assert.ok(html.includes("Confira a nova página"), "label do CTA presente");
    // Deve ter botão pill (border-radius:999px) sem "→" no texto do botão
    // #finding-5: assert não-vacuo — se o regex falhar, o teste falha explicitamente.
    const pillMatch = html.match(/border-radius:999px[^>]*>([^<]*)</);
    assert.ok(pillMatch, "deve ter botão pill (border-radius:999px) no HTML");
    assert.ok(!pillMatch![1].includes("→"), "texto do botão pill não deve ter seta →");
  });

  // Regressão completa: e2e CLARICE com livros_promo no cache → cai em renderIntroCallout com botão
  it("e2e #2136: boxDivulgacao1 CLARICE + livros_promo presente → box SEM imagem hero", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-2136-e2e-"));
    try {
      const cfUrl = "https://poll.diaria.workers.dev/img/img-260612-04-livros-promo.jpg";
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { livros_promo: { cloudflare_url: cfUrl } } }),
      );
      // Simula o fluxo real: readBoxDivulgacao1Image com texto da Clarice → null
      const url = readBoxDivulgacao1Image(dir, CLARICE_CALLOUT);
      assert.equal(url, null, "readBoxDivulgacao1Image deve retornar null para CLARICE");
      const html = renderMidCallout(CLARICE_CALLOUT, url);
      assert.ok(!html.includes("<img"), "HTML não deve ter <img> de livros_promo");
      assert.ok(!html.includes(cfUrl), "URL da imagem livros_promo não deve aparecer");
      assert.ok(html.includes("clarice.ai"), "link da Clarice deve estar presente");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // (e) CLARICE sem imagem → botão pill DS centralizado (renderIntroCallout com sponsored)
  it("renderIntroCallout CLARICE multi-para: último link vira botão pill centralizado, sem seta", () => {
    const html = renderIntroCallout(CLARICE_CALLOUT);
    // Deve ter botão pill (border-radius:999px)
    assert.ok(html.includes("border-radius:999px"), "deve ter botão pill DS");
    // Deve estar centralizado (text-align:center)
    assert.ok(html.includes("text-align:center"), "botão deve ser centralizado");
    // Label do botão = anchor text do link, sem →
    assert.ok(html.includes("Acesse e use os cupons NEWS25 ou NEWS50"), "label do botão correto");
    assert.ok(!html.match(/border-radius:999px[^>]*>[^<]*→/), "botão sem seta →");
    // O → da fonte (snippet) não deve vazar no HTML como texto
    assert.ok(!html.match(/→\s*<\/p>/), "→ orphan não vaza pro corpo HTML");
    // O parágrafo com só o link CTA não fica inline no corpo
    assert.ok(!html.includes("[Acesse e use os cupons"), "markdown-link não vaza cru");
  });

  // #finding-1: CTA deve funcionar com pontuação diferente de `.` (!, ?, ,)
  it("renderIntroCallout: CTA com ! final → botão pill gerado sem seta", () => {
    const callout = `📣 Teste de pontuação\n\nCorpo do callout.\n\n→ [Veja agora!](https://clarice.ai/precos-planos?via=diaria)!`;
    const html = renderIntroCallout(callout);
    assert.ok(html.includes("border-radius:999px"), "deve ter botão pill mesmo com ! final");
    assert.ok(html.includes("Veja agora!"), "label do botão preservado");
    assert.ok(!html.match(/→\s*<\/p>/), "→ orphan não vaza");
  });

  it("renderIntroCallout: CTA com ? final → botão pill gerado sem seta", () => {
    const callout = `📣 Teste de pontuação\n\nCorpo do callout.\n\n→ [Quer saber mais?](https://clarice.ai/precos-planos?via=diaria)?`;
    const html = renderIntroCallout(callout);
    assert.ok(html.includes("border-radius:999px"), "deve ter botão pill mesmo com ? final");
    assert.ok(html.includes("Quer saber mais?"), "label do botão preservado");
    assert.ok(!html.match(/→\s*<\/p>/), "→ orphan não vaza");
  });

  // #finding-2: fall-through (pontuação extra que impede detecção CTA) NÃO deixa → orphan
  it("renderIntroCallout: fall-through (extra texto após link) NÃO deixa → orphan no corpo", () => {
    // Tem → + link + texto extra — não vai virar botão pill. Mas o → NÃO deve vazar.
    const callout = `📣 Título do callout\n\nCorpo aqui.\n\n→ [Acesse](https://clarice.ai) e aproveite agora`;
    const html = renderIntroCallout(callout);
    // O → do prefixo não deve aparecer como texto solto no HTML
    assert.ok(!html.match(/→\s*<\/p>/), "→ orphan não deve aparecer no fim de parágrafo");
    assert.ok(!html.match(/>\s*→\s*\[/), "markdown prefixado com → não deve vazar cru");
    // O link deve estar presente (inline, já que não virou pill)
    assert.ok(html.includes("clarice.ai"), "link ainda presente no corpo");
  });

  // #finding-6: readBoxDivulgacao1Image com undefined (sem texto) → null por segurança
  it("readBoxDivulgacao1Image: undefined midCalloutText → null (sem crash, contrato seguro)", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-f6-"));
    try {
      const cfUrl = "https://poll.diaria.workers.dev/img/img-260612-04-livros-promo.jpg";
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { livros_promo: { cloudflare_url: cfUrl } } }),
      );
      // undefined (caller não passou texto) → null, nunca reaproveita imagem silenciosamente
      assert.equal(readBoxDivulgacao1Image(dir, undefined), null, "undefined deve retornar null");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1972 — callout colado ANTES do --- do D1 não duplica (de-dup determinístico)", () => {
  // Caso real 260609: o box da Clarice (**📣 …**) foi colado na região do D1
  // ANTES do `---` de fechamento. parseDestaques (que fatia em ^---$) absorveu
  // o bloco no why do D1 (corpo quebrado) E extractBoxDivulgacao1 o pegou (box teal)
  // → render 2×. O fix: stripBoxDivulgacao1 remove o bloco antes do parse.
  const MD_MISPLACED = `Para esta edição, selecionamos 15 itens.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Corpo do destaque 1.

Por que isso importa:

Algo importante sobre o D1.

**📣 Escreva melhor com a Clarice.ai. Cupons NEWS25/NEWS50. [Acesse](https://clarice.ai/precos-planos?via=diaria).**

---

**DESTAQUE 2 | 🚀 LANÇAMENTO**

**[Título D2](https://example.com/d2)**

Corpo do destaque 2.
`;

  it("sem strip o callout VAZA pro corpo/why do D1 (demonstra o bug)", () => {
    const raw = parseDestaques(MD_MISPLACED);
    assert.ok(
      raw[0].why.includes("Clarice.ai") || raw[0].body.includes("Clarice.ai"),
      "sem strip, o parser absorve o callout no D1 (bug original)",
    );
  });

  it("stripBoxDivulgacao1 remove o bloco → callout NÃO vaza pro D1", () => {
    const cleaned = stripBoxDivulgacao1(MD_MISPLACED);
    const d = parseDestaques(cleaned);
    assert.ok(!d[0].body.includes("Clarice.ai"), "callout fora do body do D1");
    assert.ok(!d[0].why.includes("Clarice.ai"), "callout fora do why do D1");
  });

  it("extractBoxDivulgacao1 ainda acha o callout no texto original (render 1×)", () => {
    const c = extractBoxDivulgacao1(MD_MISPLACED);
    assert.ok(c, "callout extraído como boxDivulgacao1");
    assert.match(c!, /^📣 Escreva melhor com a Clarice\.ai/);
  });

  it("stripBoxDivulgacao1 é idempotente quando o callout já está isolado", () => {
    // Posição correta: callout em sua própria seção entre dois `---`.
    const MD_OK = MD_MISPLACED.replace(
      /Algo importante sobre o D1\.\n\n(\*\*📣[^\n]*\*\*)\n/,
      "Algo importante sobre o D1.\n\n---\n\n$1\n",
    );
    const cleaned = stripBoxDivulgacao1(MD_OK);
    const d = parseDestaques(cleaned);
    assert.ok(!d[0].why.includes("Clarice.ai"), "callout não está no D1 (já isolado)");
    assert.match(extractBoxDivulgacao1(MD_OK)!, /^📣 Escreva melhor/);
  });

  it("idempotente quando não há callout nenhum (texto inalterado)", () => {
    const semCallout = MD_MISPLACED.replace(/\n\*\*📣[^\n]*\*\*\n/, "\n");
    assert.equal(stripBoxDivulgacao1(semCallout), semCallout);
  });

  it("CRLF: strip não deixa seam órfão (\\r\\n intercalado) nem vaza pro D1", () => {
    // Sob CRLF o `\s*$` do MID_CALLOUT_BLOCK come o `\r` mas para antes do `\n`,
    // deixando o seam `\r\n\r\n\n\r\n` — newlines intercalados com `\r` que um
    // collapse `/\n{3,}/` não casaria. Regressão do collapse `(?:\r?\n){3,}`.
    const crlf = MD_MISPLACED.replace(/\n/g, "\r\n");
    const cleaned = stripBoxDivulgacao1(crlf);
    assert.ok(!/(?:\r?\n){3,}/.test(cleaned), "sem run de 3+ newlines órfão após o strip");
    const d = parseDestaques(cleaned);
    assert.ok(!d[0].body.includes("Clarice.ai"), "callout fora do body do D1 (CRLF)");
    assert.ok(!d[0].why.includes("Clarice.ai"), "callout fora do why do D1 (CRLF)");
    // extractBoxDivulgacao1 ainda acha no original CRLF (render 1×).
    assert.match(extractBoxDivulgacao1(crlf)!, /^📣 Escreva melhor/);
  });
});

// ── #2978-slot2-parity — regressão: boxDivulgacao2 (slot 2, gap D2/D3) não ────
// tinha paridade com boxDivulgacao1: renderHTML nunca passava a imagem pro
// slot 2 (renderBoxDivulgacao(content.boxDivulgacao2) sem 2º argumento), então
// o box de livros (📚) que caísse no slot 2 sempre degradava pra
// renderIntroCallout SEM forceCtaPill — perdia a imagem E o botão pill virava
// link sublinhado inline. Fix: readBoxDivulgacao2Image (novo) + renderHTML
// passa content.boxDivulgacao2Image pro dispatcher, igual ao slot 1.

function minimalDestaque(n: 1 | 2 | 3, title: string) {
  return {
    n,
    category: "PESQUISA",
    title,
    body: `Corpo do destaque ${n}.`,
    why: `Por que importa ${n}.`,
    url: `https://example.com/d${n}`,
    emoji: "🧪",
  };
}

function fixtureWithBoxes(opts: {
  boxDivulgacao1?: string | null;
  boxDivulgacao1Image?: string | null;
  boxDivulgacao2?: string | null;
  boxDivulgacao2Image?: string | null;
}): NewsletterContent {
  return {
    title: "Título de teste",
    subtitle: "Subtítulo de teste",
    coverImage: "04-d1-2x1.jpg",
    destaques: [
      minimalDestaque(1, "Destaque 1"),
      minimalDestaque(2, "Destaque 2"),
      minimalDestaque(3, "Destaque 3"),
    ],
    eia: {
      credit: "",
      imageA: "01-eia-A.jpg",
      imageB: "01-eia-B.jpg",
      edition: "260999",
    },
    sections: [],
    ...opts,
  } as NewsletterContent;
}

describe("#2978-slot2-parity — box de livros (📚) no slot 2 recupera separador + imagem + pill", () => {
  it("readBoxDivulgacao2Image: livros callout (📚 + livros.diaria.workers.dev) → retorna URL da imagem", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-slot2-livros-"));
    try {
      const cfUrl = "https://poll.diaria.workers.dev/img/img-260703-04-livros-promo.jpg";
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { livros_promo: { cloudflare_url: cfUrl } } }),
      );
      const url = readBoxDivulgacao2Image(dir, LIVROS_CALLOUT);
      assert.equal(url, cfUrl, "box de livros no slot 2 deve receber a imagem livros_promo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readBoxDivulgacao2Image: CLARICE callout (📣, link não-livros) → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-slot2-clarice-"));
    try {
      const cfUrl = "https://poll.diaria.workers.dev/img/img-260703-04-livros-promo.jpg";
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { livros_promo: { cloudflare_url: cfUrl } } }),
      );
      const url = readBoxDivulgacao2Image(dir, CLARICE_CALLOUT);
      assert.equal(url, null, "box CLARICE no slot 2 não deve receber a imagem livros_promo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renderBoxDivulgacao com imagem (slot 2): emite <img> + botão pill (paridade com slot 1)", () => {
    const html = renderBoxDivulgacao(LIVROS_CALLOUT, "https://img.example/livros.jpg");
    assert.ok(html.includes("<img"), "slot 2 com imagem deve emitir <img>");
    assert.ok(html.includes("https://img.example/livros.jpg"), "src da imagem presente");
    assert.match(html, /border-radius:999px/, "botão pill presente");
    assert.ok(html.includes("Confira a nova página"), "label do CTA presente");
  });

  it("renderHTML e2e: boxDivulgacao2 = 📚 com imagem → separador DIVULGAÇÃO + <img> + pill entre D2 e D3", () => {
    const content = fixtureWithBoxes({
      boxDivulgacao2: LIVROS_CALLOUT,
      boxDivulgacao2Image: "https://img.example/livros-slot2.jpg",
    });
    const html = renderHTML(content);

    const d2Idx = html.indexOf("Destaque 2");
    const d3Idx = html.indexOf("Destaque 3");
    const divulgacaoIdx = html.indexOf("Divulgação", d2Idx);
    const imgIdx = html.indexOf("https://img.example/livros-slot2.jpg");
    const pillIdx = html.indexOf("border-radius:999px", d2Idx);

    assert.ok(d2Idx !== -1 && d3Idx !== -1, "D2 e D3 presentes no HTML");
    assert.ok(
      divulgacaoIdx !== -1 && divulgacaoIdx > d2Idx && divulgacaoIdx < d3Idx,
      "separador ● Divulgação deve aparecer entre D2 e D3",
    );
    assert.ok(
      imgIdx !== -1 && imgIdx > d2Idx && imgIdx < d3Idx,
      "imagem promo deve aparecer entre D2 e D3",
    );
    assert.ok(
      pillIdx !== -1 && pillIdx < d3Idx,
      "botão pill deve aparecer entre D2 e D3",
    );
    assert.ok(html.includes("Confira a nova página"), "label do CTA (pill) presente");
  });

  it("renderHTML e2e: slot 1 (🛒 Alexa) permanece intacto quando slot 2 (📚 com imagem) também está presente — sem regressão", () => {
    const ALEXA_CALLOUT = `🛒 Equipe sua casa com a Alexa+.

Corpo do box de afiliados.

[Ver ofertas](https://amazon.com.br/alexa)`;
    const content = fixtureWithBoxes({
      boxDivulgacao1: ALEXA_CALLOUT,
      boxDivulgacao2: LIVROS_CALLOUT,
      boxDivulgacao2Image: "https://img.example/livros-slot2.jpg",
    });
    const html = renderHTML(content);

    const d1Idx = html.indexOf("Destaque 1");
    const d2Idx = html.indexOf("Destaque 2");
    const d3Idx = html.indexOf("Destaque 3");

    // slot 1 (box 🛒) continua sem imagem promo (nunca teve esse recurso —
    // comportamento legado preservado; a paridade nova é só pro box 📚/📣/🎉
    // no slot 2). D1 tem sua PRÓPRIA hero image (04-d1-2x1.jpg) — não checar
    // ausência total de <img> no slice, só que a imagem do box de afiliados
    // (que não existe pra 🛒) não vaza e o CTA/pill do box seguem intactos.
    const slot1Html = html.slice(d1Idx, d2Idx);
    assert.ok(!slot1Html.includes("livros-slot2.jpg"), "slot 1 não deve ter a imagem promo do slot 2");
    assert.ok(slot1Html.includes("border-radius:999px"), "slot 1 (🛒) mantém botão pill");
    assert.ok(slot1Html.includes("Ver ofertas"), "slot 1 (🛒) mantém CTA");

    // slot 2 (entre D2 e D3) tem a imagem + pill.
    const slot2Html = html.slice(d2Idx, d3Idx);
    assert.ok(slot2Html.includes("<img"), "slot 2 (📚) deve ter <img>");
    assert.ok(slot2Html.includes("https://img.example/livros-slot2.jpg"), "src correto no slot 2");
    assert.ok(slot2Html.includes("border-radius:999px"), "slot 2 (📚) mantém botão pill");
  });

  it("renderBoxDivulgacao sem imagem (slot 2, livros): degrada pra box só-texto (comportamento pré-existente preservado)", () => {
    const html = renderBoxDivulgacao(LIVROS_CALLOUT, null);
    assert.ok(!html.includes("<img"), "sem imagem, slot 2 não deve ter <img>");
  });
});
