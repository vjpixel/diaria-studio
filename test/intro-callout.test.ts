/**
 * test/intro-callout.test.ts (#1648, edição 260601)
 *
 * extractIntroCallout + renderIntroCallout: CTA de destaque no topo da edição
 * (ex: convite pro sorteio ao vivo). Bug 260601: o convite pro sorteio estava
 * embutido na coverage line (cinza itálico 15px) e o editor não o encontrava no
 * topo. Solução: parágrafo `**🎉 ...**` na intro vira callout com borda teal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractIntroCallout,
  renderIntroCallout,
} from "../scripts/render-newsletter-html.ts";

const SAMPLE = `TÍTULO

Título qualquer

SUBTÍTULO

Sub | qualquer

---

Para esta edição, eu (o editor) enviei 12 submissões e a Diar.ia encontrou outros 223 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.

**🎉 Sorteio de junho ao vivo: dia 2, às 13h, no [Google Meet](https://meet.google.com/awi-jter-dwm). Apareça para acompanhar o resultado.**

---

**DESTAQUE 1 | 📚 EDUCAÇÃO**

**[Título do destaque](https://exemplo.com)**

Corpo.`;

describe("extractIntroCallout (#1648)", () => {
  it("extrai o parágrafo 🎉 da intro, preservando markdown de link", () => {
    const cta = extractIntroCallout(SAMPLE);
    assert.ok(cta);
    assert.match(cta!, /^🎉 Sorteio de junho ao vivo/);
    assert.match(cta!, /\[Google Meet\]\(https:\/\/meet\.google\.com\/awi-jter-dwm\)/);
    // não vaza os ** delimitadores
    assert.doesNotMatch(cta!, /\*\*/);
  });

  it("aceita 📣 como marcador alternativo", () => {
    const cta = extractIntroCallout("Para esta edição...\n\n**📣 Aviso importante**\n\n**DESTAQUE 1 | X**");
    assert.equal(cta, "📣 Aviso importante");
  });

  it("ignora negrito dentro de um destaque (só olha a intro)", () => {
    const cta = extractIntroCallout("intro\n\n**DESTAQUE 1 | X**\n\n**🎉 isso é título de destaque, não CTA**");
    assert.equal(cta, null);
  });

  it("retorna null quando não há CTA", () => {
    assert.equal(extractIntroCallout("Para esta edição...\n\n**DESTAQUE 1 | X**"), null);
  });
});

describe("renderIntroCallout (#1648)", () => {
  it("renderiza callout como painel bege (DS #1936) e link clicável", () => {
    const html = renderIntroCallout(
      "🎉 Sorteio: [Google Meet](https://meet.google.com/awi-jter-dwm)",
    );
    // #1936: callout = box "painel" do DS (fundo bege #EBE5D0, sem borda teal).
    assert.match(html, /background:#EBE5D0/);
    assert.doesNotMatch(html, /border-left:[0-9]px solid #00A0A0/);
    assert.match(html, /<a href="https:\/\/meet\.google\.com\/awi-jter-dwm"/);
    assert.match(html, /font-weight:600/);
  });

  it("#3460: multi-parágrafo não-patrocinado e sem CTA pill forçado renderiza todos os parágrafos uniformemente (sem título serif/bold no 1º)", () => {
    // Bug 260715: renderIntroCallout sempre estilizava o 1º parágrafo como
    // título (serif grande / bold) só por estar na posição 0 — quebrava o
    // pedido do editor de tratar uma nota pessoal (ex: boas-vindas) como
    // texto corrido comum, sem destaque visual artificial no início.
    const html = renderIntroCallout(
      "Olá! Eu sou o Pixel, editor dessa newsletter.\n\nTodos os dias seleciono as notícias mais importantes.",
    );
    // Nenhum parágrafo em serif 26px (tamanho de título) nem font-weight:600 (sub-header)
    assert.doesNotMatch(html, /font-size:26px/);
    assert.doesNotMatch(html, /font-weight:600/);
    assert.match(html, /Olá! Eu sou o Pixel/);
    assert.match(html, /Todos os dias seleciono/);
  });

  it("#3475: sem marcador emoji, um callout multi-parágrafo qualquer (patrocinado ou não) sem CTA pill também cai no tratamento uniforme", () => {
    // #3460 introduziu a exceção pra notas pessoais; #3475 removeu o
    // allowlist de marcador emoji (📣/📚/📖/🎉) que antes distinguia "título
    // de box" de "nota pessoal" — agora só `sponsored` (link de afiliado) ou
    // `forceCtaPill` (estrutural) dão o tratamento de título. Um bloco
    // "Sorteio" sem link de afiliado e sem CTA-only paragraph, mesmo curto,
    // cai no mesmo caminho uniforme da nota pessoal (ver renderIntroCallout
    // em newsletter-render-html.ts).
    const html = renderIntroCallout("Sorteio\n\nlinha do sorteio.");
    assert.doesNotMatch(html, /font-size:26px/);
  });

  it("titleStyle='body' + forceCtaPill=true preserva o tratamento de título independente de marcador", () => {
    // Callouts de sorteio/CTA reais (ex: box de campeões do mês) continuam
    // com título quando o dispatcher os marca como forceCtaPill — não
    // dependem de emoji.
    const html = renderIntroCallout("Sorteio\n\nlinha do sorteio.", "body", true);
    assert.match(html, /font-size:16px/);
  });
});

// #260701: box de início de mês (campeões É IA? + sorteio) — title body-size
// serif, sub-cabeçalho fully-bold, e parser greedy aceitando `**bold**` interno.
const MONTHLY_BOX = `Para esta edição, eu enviei 1 e a Diar.ia achou 2.

**🎉 Sorteio

🥇 jorgemartinsfilho

**Os campeões do É IA?:**

🥈 Bruna Quevedo**

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[T](https://x.com)**

Corpo.`;

describe("box campeões/sorteio (#260701)", () => {
  it("extractIntroCallout greedy captura sub-linhas **bold** internas", () => {
    const cta = extractIntroCallout(MONTHLY_BOX);
    assert.ok(cta);
    // capturou até o último **$ (após 'Bruna Quevedo'), preservando o **Os campeões** interno
    assert.match(cta!, /^🎉 Sorteio/);
    assert.match(cta!, /\*\*Os campeões do É IA\?:\*\*/);
    assert.match(cta!, /🥈 Bruna Quevedo$/);
  });

  it("titleStyle='body' usa serif 16px (não serif 26px) no título", () => {
    const html = renderIntroCallout("🎉 Sorteio\n\nlinha do sorteio.", "body");
    // título serif tamanho de corpo (16px, peso 600), não o 26px do default
    assert.match(html, /font-size:16px/);
    assert.doesNotMatch(html, /font-size:26px/);
  });

  it("#3475: marcador 🎉 preserva o tratamento de TÍTULO (não cai no flat do #3460) mesmo sem sponsored/forceCtaPill", () => {
    // Regressão real encontrada ao remover o allowlist de marcadores dos
    // boxes de divulgação (#3475): o box de campeões/sorteio
    // (build-champions-callout.ts) é multi-parágrafo, NÃO patrocinado e NÃO
    // passa forceCtaPill — sem reconhecer 🎉 especificamente, caía no mesmo
    // branch "flat" do #3460 (nota pessoal), perdendo o <p> de título
    // dedicado (font-family Georgia + font-weight:600) e virando um `<p>`
    // de corpo comum como qualquer outro parágrafo.
    const titleTagRe = /<p style="[^"]*font-family:Georgia[^"]*font-weight:600[^"]*">Sorteio<\/p>/;
    const flat = renderIntroCallout("Sorteio\n\nlinha do sorteio.", "body"); // sem 🎉
    const withMarker = renderIntroCallout("🎉 Sorteio\n\nlinha do sorteio.", "body");
    assert.doesNotMatch(
      flat,
      titleTagRe,
      "sem o marcador 🎉, não há <p> de título dedicado (comportamento #3460, esperado)",
    );
    assert.match(
      withMarker,
      titleTagRe,
      "com o marcador 🎉, o box de campeões/sorteio mantém o <p> de título dedicado",
    );
  });

  it("parágrafo inteiramente **bold** vira sub-cabeçalho (titleStyle='body')", () => {
    const html = renderIntroCallout(
      "🎉 Sorteio\n\ntexto do sorteio.\n\n**Os campeões do É IA?:**\n\n🥇 jorgemartinsfilho",
      "body",
    );
    // 'Os campeões' renderiza sem os ** (negrito via sub-header), peso 600
    assert.match(html, /<strong>|font-weight:600/);
    assert.match(html, /Os campeões do É IA\?:/);
    assert.doesNotMatch(html, /\*\*Os campeões/);
  });
});
