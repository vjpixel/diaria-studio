/**
 * test/minify-email-html-5232.test.ts (#5232 item 2)
 *
 * `minifyEmailHtml` (scripts/lib/newsletter-render-html.ts) enxuga bytes do
 * fragmento final SEM mexer no que renderiza — decisão do editor no #5232:
 * enxugar CSS/markup repetido, nunca cortar conteúdo editorial. Cobre:
 *
 *   1. Comentários de debug/tracing são removidos (nunca visíveis a leitor,
 *      em client nenhum).
 *   2. Comentários condicionais MSO (`<!--[if mso]>`/`<![endif]-->`) são
 *      PRESERVADOS — são markup real interpretado pelo Word/Outlook, não
 *      decoração (ver #260629b em newsletter-render-html.ts).
 *   3. Whitespace estrutural (newline + indentação) entre duas tags colapsa —
 *      cada nó de fluxo do template é block-level, então CSS 2.1 §8.2.1
 *      garante zero efeito visual.
 *   4. Whitespace DENTRO de texto (espaço simples entre duas tags na MESMA
 *      linha de origem, ex: dois `<a>` lado a lado) NÃO é tocado — cenário
 *      que hoje não ocorre no template real (ver docstring da função), mas
 *      que precisa continuar seguro se algum dia passar a ocorrer.
 *   5. Conteúdo do `<style>` sai intocado (sem `<`/`>` internos, regex não
 *      encontra nada pra colapsar ali).
 *   6. Idempotência.
 *   7. Integração: `renderHTML()` de uma edição sintética completa →
 *      `minifyEmailHtml()` reduz bytes de forma mensurável e preserva todo
 *      texto/URL visível (nenhum conteúdo editorial perdido).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  minifyEmailHtml,
  renderHTML,
} from "../scripts/lib/newsletter-render-html.ts";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";

describe("minifyEmailHtml — #5232 item 2", () => {
  it("remove comentário de debug isolado entre duas tags", () => {
    const input = "<table><tr><td>x</td></tr></table>\n<!-- RADAR -->\n<div>y</div>";
    const out = minifyEmailHtml(input);
    assert.doesNotMatch(out, /<!-- RADAR -->/);
    assert.match(out, /<\/table><div>y<\/div>/);
  });

  it("remove comentário de debug no início do documento", () => {
    const input = "<!-- diar.ia.br newsletter body — auto-generated -->\n<table></table>";
    const out = minifyEmailHtml(input);
    assert.doesNotMatch(out, /auto-generated/);
    assert.equal(out, "<table></table>");
  });

  it("preserva comentário condicional MSO de abertura verbatim", () => {
    const input =
      '<td align="center">\n<!--[if mso]><table role="presentation" align="center" width="656"><tr><td width="656"><![endif]-->\n<table class="container"></table>';
    const out = minifyEmailHtml(input);
    assert.match(
      out,
      /<!--\[if mso\]><table role="presentation" align="center" width="656"><tr><td width="656"><!\[endif\]-->/,
    );
  });

  it("preserva comentário condicional MSO de fechamento verbatim", () => {
    const input = "<table></table>\n<!--[if mso]></td></tr></table><![endif]-->\n</td></tr></table>";
    const out = minifyEmailHtml(input);
    assert.match(out, /<!--\[if mso\]><\/td><\/tr><\/table><!\[endif\]-->/);
  });

  it("colapsa newline + indentação entre duas tags (whitespace estrutural)", () => {
    const input = "<tr>\n  <td>a</td>\n</tr>\n<tr>\n  <td>b</td>\n</tr>";
    const out = minifyEmailHtml(input);
    assert.doesNotMatch(out, /\n/);
    assert.equal(out, "<tr><td>a</td></tr><tr><td>b</td></tr>");
  });

  it("NÃO toca espaço dentro de um nó de texto (mesma linha, sem tag entre as palavras)", () => {
    const input = "<p>Olá! Eu sou o <a href=\"x\">Pixel</a>, editor desta newsletter.</p>";
    const out = minifyEmailHtml(input);
    assert.equal(out, input, "texto com espaços internos não deveria mudar");
  });

  it("NÃO colapsa espaço único entre duas tags na MESMA linha (cenário hipotético hoje ausente do template real)", () => {
    const input = '<a href="x">A</a> <a href="y">B</a>';
    const out = minifyEmailHtml(input);
    assert.equal(out, input, "espaço visualmente significativo entre inline elements deve sobreviver");
  });

  it("conteúdo do <style> sai intocado (sem <, > internos — nada pro regex colapsar)", () => {
    const styleBlock =
      "<style>\n  body { margin:0; padding:0; }\n  img { border:0; }\n</style>";
    const input = `${styleBlock}\n<table></table>`;
    const out = minifyEmailHtml(input);
    assert.ok(out.includes(styleBlock), "bloco <style> deveria sair byte-a-byte idêntico");
  });

  it("é idempotente — aplicar 2x produz o mesmo resultado da 1ª", () => {
    const input =
      "<!-- comentário -->\n<table>\n  <tr>\n    <td>x</td>\n  </tr>\n</table>\n<!--[if mso]><table><![endif]-->";
    const once = minifyEmailHtml(input);
    const twice = minifyEmailHtml(once);
    assert.equal(once, twice);
  });
});

// ── Integração: fixture sintética completa ──────────────────────────────

const FIXTURE: NewsletterContent = {
  title: "Modelos se auto-replicam sem intervenção humana",
  subtitle: "Teste sintético #5232",
  coverImage: "04-d1-2x1.jpg",
  coverageLine:
    "Para esta edição, eu (o editor) enviei 4 submissões e a Diar.ia encontrou outros 12 artigos. Selecionamos os 9 mais relevantes.",
  destaques: [
    {
      n: 1,
      category: "PESQUISA",
      title: "Modelos se auto-replicam sem intervenção humana",
      body: "Pesquisadores detectaram replicação autônoma durante um teste de contenção controlado.\n\nO experimento foi repetido 3 vezes com resultados consistentes.",
      why: "A replicação autônoma representa um salto qualitativo no risco sistêmico.",
      url: "https://example.com/mit-auto-replication",
      emoji: "🧪",
      imageFile: "04-d1-2x1.jpg",
    },
    {
      n: 2,
      category: "PRODUTO",
      title: "Empresa lança agente autônomo para tarefas longas",
      body: "O novo produto opera por horas sem intervenção humana.\n\nDisponível a partir desta semana.",
      why: "Combina planejamento de longo prazo com execução de ferramentas.",
      url: "https://example.com/long-horizon-agent",
      emoji: "📦",
      imageFile: "04-d2-1x1.jpg",
    },
    {
      n: 3,
      category: "REGULAÇÃO",
      title: "Parlamento aprova texto final de lei de IA",
      body: "O texto definitivo foi aprovado por ampla maioria.\n\nFronteiras entre categorias de risco ainda geram controvérsia.",
      why: "Primeira lei abrangente de IA vai moldar legislações globais.",
      url: "https://example.com/ai-act-final",
      emoji: "🧮",
      imageFile: "04-d3-1x1.jpg",
    },
  ],
  boxDivulgacao1:
    "Nossa curadoria de livros sobre IA ganhou uma nova página. [Confira a nova página](https://livros.diaria.workers.dev).",
  eia: {
    credit: "Foto: Gerado com Gemini. Uma dessas imagens é artificial — qual é?",
    imageA: "01-eia-A.jpg",
    imageB: "01-eia-B.jpg",
    edition: "260999",
  },
  sections: [
    {
      name: "LANÇAMENTOS",
      emoji: "🚀",
      items: [
        {
          title: "Modelo novo é lançado com janela de contexto expandida",
          url: "https://example.com/modelo-novo",
          description: "Novo modelo com raciocínio prolongado.",
        },
      ],
    },
    {
      name: "OUTRAS NOTÍCIAS",
      emoji: "📰",
      items: [
        {
          title: "Startup levanta rodada de investimento",
          url: "https://example.com/startup-rodada",
          description: "Movimento sinaliza escalada de aposta em IA.",
        },
      ],
    },
  ],
  sorteio: "🎁 Participe do sorteio deste mês respondendo ao É IA?.",
  encerrar: "Chegou ao fim de mais uma edição. Compartilhe com alguém que precisa saber.",
};

describe("minifyEmailHtml — integração com renderHTML() (#5232 item 2)", () => {
  it("reduz bytes do fragmento (Beehiiv) de forma mensurável", () => {
    const raw = renderHTML(FIXTURE);
    const minified = minifyEmailHtml(raw);
    const rawBytes = Buffer.byteLength(raw, "utf8");
    const minifiedBytes = Buffer.byteLength(minified, "utf8");
    assert.ok(
      minifiedBytes < rawBytes,
      `esperava redução de bytes: raw=${rawBytes} minified=${minifiedBytes}`,
    );
    // Sinal de regressão grosseira: se a redução for ínfima, o passo de
    // minificação provavelmente não está encontrando nada pra colapsar
    // (ex: fixture mudou de forma que passou a violar a premissa "1 tag por
    // linha"). 3% é uma barra baixa de propósito — só pra pegar "não fez
    // nada", não travar em cima do número exato de bytes economizados.
    const reductionRatio = (rawBytes - minifiedBytes) / rawBytes;
    assert.ok(
      reductionRatio > 0.03,
      `redução de ${(reductionRatio * 100).toFixed(1)}% é baixa demais — checar se a fixture ainda exercita comentários/whitespace estrutural`,
    );
  });

  it("reduz bytes do documento completo (--full) de forma mensurável", () => {
    const raw = renderHTML(FIXTURE, { fullDocument: true });
    const minified = minifyEmailHtml(raw);
    assert.ok(Buffer.byteLength(minified, "utf8") < Buffer.byteLength(raw, "utf8"));
  });

  it("preserva todo texto/URL editorial visível — nenhum conteúdo perdido pela minificação", () => {
    const raw = renderHTML(FIXTURE);
    const minified = minifyEmailHtml(raw);
    for (const d of FIXTURE.destaques) {
      assert.ok(minified.includes(d.title), `título do destaque sumiu: ${d.title}`);
      assert.ok(minified.includes(d.url), `url do destaque sumiu: ${d.url}`);
    }
    for (const section of FIXTURE.sections) {
      for (const item of section.items) {
        assert.ok(minified.includes(item.title), `título de item de seção sumiu: ${item.title}`);
        assert.ok(minified.includes(item.url), `url de item de seção sumiu: ${item.url}`);
      }
    }
    // A frase inteira não sobrevive literal — "Diar.ia" vira spans de brand
    // wordmark (`applyBrandWordmark`) mesmo SEM minificação, então checamos
    // um trecho que não atravessa esse ponto.
    assert.ok(minified.includes("Selecionamos os 9 mais relevantes"));
  });

  it("preserva os comentários condicionais MSO no documento completo mesmo após minificação", () => {
    const raw = renderHTML(FIXTURE, { fullDocument: true });
    const minified = minifyEmailHtml(raw);
    assert.match(minified, /<!--\[if mso\]>/);
    assert.match(minified, /<!\[endif\]-->/);
  });

  it("minificar 2x (idempotência) sobre output real de renderHTML produz o mesmo resultado", () => {
    const raw = renderHTML(FIXTURE);
    const once = minifyEmailHtml(raw);
    const twice = minifyEmailHtml(once);
    assert.equal(once, twice);
  });
});
