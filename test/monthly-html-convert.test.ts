/**
 * test/monthly-html-convert.test.ts (#2791)
 *
 * Regressão do fallback cloud HTML→markdown: a REST API v2 do Beehiiv só
 * expõe HTML (sem endpoint markdown), então `fetch-monthly-posts.ts`
 * precisa converter pro pseudo-markdown que `collect-monthly.ts`
 * (parsePost/splitSections) já sabe parsear, ANTES de gravar o raw-post.
 * Conservador: bloco que não converte limpo (sem why, sem corpo) vira
 * warning explícito — nunca falha silenciosa (#2794).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertBeehiivHtmlToMarkdown, htmlToLines } from "../scripts/lib/mensal/monthly-html-convert.ts";
import { parsePost, type MonthlyDestaque } from "../scripts/collect-monthly.ts";

// Recorte pequeno e representativo do HTML de e-mail do Beehiiv: 3 blocos —
// dois convertem limpo, um sem "Por que isso importa:" (propositalmente
// sujo, pra testar o warning conservador).
const BEEHIIV_HTML = `
<html><body>
<table><tr><td>
<h6>LANÇAMENTO</h6>
<h1><a href="https://example.com/a">Título Um</a></h1>
<p>Primeiro parágrafo do corpo.</p>
<p>Segundo parágrafo do corpo.</p>
<p><strong>Por que isso importa:</strong></p>
<p>Texto do porquê um.</p>
</td></tr>
<tr><td>
<h6>BRASIL</h6>
<h1><a href="https://exemplo.com.br/b">Título Dois</a></h1>
<p>Corpo do segundo destaque.</p>
<p>Por que isso importa:</p>
<p>Outro porquê.</p>
</td></tr>
<tr><td>
<h6>SEM WHY</h6>
<h1><a href="https://example.com/c">Título Três Sem Porquê</a></h1>
<p>Corpo sem seção why &mdash; deve gerar warning.</p>
</td></tr>
</table>
</body></html>
`;

describe("htmlToLines", () => {
  it("preserva links como markdown e separa blocos por linha", () => {
    const lines = htmlToLines(
      '<p>texto</p><p><a href="https://x.com/y">Link Texto</a></p><p>fim</p>',
    );
    assert.ok(lines.includes("texto"));
    assert.ok(lines.includes("[Link Texto](https://x.com/y)"));
    assert.ok(lines.includes("fim"));
  });

  it("decodifica entidades HTML comuns", () => {
    const lines = htmlToLines("<p>A &amp; B &mdash; C</p>");
    assert.equal(lines[0], "A & B — C");
  });
});

describe("convertBeehiivHtmlToMarkdown", () => {
  it("extrai categoria/título/url/porquê dos blocos que convertem limpo", () => {
    const result = convertBeehiivHtmlToMarkdown(BEEHIIV_HTML, "post_teste.txt");
    assert.equal(result.destaquesFound, 2, "só os 2 blocos com why convertem");

    assert.match(result.markdown, /##### LANÇAMENTO/);
    assert.match(result.markdown, /# \[Título Um\]\(https:\/\/example\.com\/a\)/);
    assert.match(result.markdown, /Texto do porquê um\./);

    assert.match(result.markdown, /##### BRASIL/);
    assert.match(result.markdown, /# \[Título Dois\]\(https:\/\/exemplo\.com\.br\/b\)/);
    assert.match(result.markdown, /Outro porquê\./);
  });

  it("é conservador: bloco sem 'Por que isso importa:' vira warning, não crasha e não aparece no markdown", () => {
    const result = convertBeehiivHtmlToMarkdown(BEEHIIV_HTML, "post_teste.txt");
    assert.ok(!result.markdown.includes("SEM WHY"));
    assert.ok(!result.markdown.includes("Título Três"));
    assert.ok(
      result.warnings.some((w) => /post_teste\.txt.*SEM WHY.*sem "Por que isso importa/.test(w)),
      `esperava warning sobre bloco sem why, recebeu: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("HTML sem nenhum destaque conversível: destaquesFound=0 + warning explícito (nunca silencioso)", () => {
    const result = convertBeehiivHtmlToMarkdown("<html><body><p>só um parágrafo solto</p></body></html>", "vazio.txt");
    assert.equal(result.destaquesFound, 0);
    assert.equal(result.markdown, "");
    assert.ok(result.warnings.some((w) => /vazio\.txt.*não encontrou nenhum destaque/.test(w)));
  });

  it("round-trip: o markdown convertido é parseável por parsePost (collect-monthly.ts)", () => {
    const result = convertBeehiivHtmlToMarkdown(BEEHIIV_HTML, "post_abcdef01_260701.txt");
    assert.equal(result.destaquesFound, 2);

    const file = {
      path: "data/monthly/2607-08/raw-posts/post_abcdef01_260701.txt",
      filename: "post_abcdef01_260701.txt",
      beehiiv_post_id: "abcdef01",
      edition: "260701",
    };
    const warnings: string[] = [];
    const dest: MonthlyDestaque[] = parsePost(file, result.markdown, warnings);

    assert.equal(dest.length, 2, "parsePost deve reconhecer os 2 blocos convertidos");
    assert.equal(dest[0].category, "LANÇAMENTO");
    assert.equal(dest[0].title, "Título Um");
    assert.equal(dest[0].url, "https://example.com/a");
    assert.equal(dest[0].why, "Texto do porquê um.");
    assert.equal(dest[1].category, "BRASIL");
    assert.equal(dest[1].is_brazil, true, "categoria BRASIL deve flagar is_brazil");
  });
});
