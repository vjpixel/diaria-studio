/**
 * test/editorial-concentration-8370.test.ts (#8370, Peça 3)
 *
 * Cobre os dois pontos que o prompt de dispatch exigiu explicitamente:
 *
 * 1. Agrupamento por mês usa a data EDITORIAL do sitemap, não `publish_date`
 *    cru — inclui o caso da edição de agosto/2025 (importada em bloco em
 *    04/09/2025) que NÃO pode cair em setembro (mesmo achado que motivou o
 *    `beehiiv-publish-date-overrides.json`, #4796, e que a PR #8358
 *    confirmou pra `editorialDate()`).
 * 2. Degradação graciosa quando não há dado de `exploracao`/CTR — a Peça 2
 *    (campo `exploracao`) ainda não existe em nenhuma fonte do repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateByMonth,
  classifyItem,
  monthKey,
  parsePageSignal,
  parseSitemapEntries,
} from "../scripts/lib/editorial-concentration.ts";

describe("editorial-concentration — parsePageSignal", () => {
  it("decompõe título (D1) + description (D2 | D3) em 1-3 itens", () => {
    const html = `<title>OpenAI lança novo modelo</title><meta name="description" content="OpenAI lança novo modelo. Google atualiza Gemini | Startup brasileira capta rodada">`;
    const signal = parsePageSignal(html, "openai-lanca-novo-modelo");
    assert.deepEqual(signal?.items, [
      "OpenAI lança novo modelo",
      "Google atualiza Gemini",
      "Startup brasileira capta rodada",
    ]);
  });

  it("página só com D1 (sem D2/D3) vira 1 item, não duplica o título", () => {
    const html = `<title>Notícia solo</title><meta name="description" content="Notícia solo">`;
    const signal = parsePageSignal(html, "noticia-solo");
    assert.deepEqual(signal?.items, ["Notícia solo"]);
  });

  it("sem <title>, retorna null em vez de lançar (arquivo corrompido/truncado)", () => {
    assert.equal(parsePageSignal("<html><body>sem head</body></html>", "sem-title"), null);
  });
});

describe("editorial-concentration — classifyItem", () => {
  it("reconhece big-tech/lab (OpenAI, Google/Gemini, Anthropic/Claude, Meta, Microsoft, Nvidia)", () => {
    assert.equal(classifyItem("OpenAI lança GPT-6").bigTech, true);
    assert.equal(classifyItem("Google atualiza o Gemini").bigTech, true);
    assert.equal(classifyItem("Anthropic apresenta o Claude").bigTech, true);
    assert.equal(classifyItem("Nvidia bate recorde de receita").bigTech, true);
    assert.equal(classifyItem("Startup brasileira capta rodada").bigTech, false);
  });

  it("reconhece termos Brasil (instituições, empresas nacionais)", () => {
    assert.equal(classifyItem("Governo Federal lança programa de IA").brasil, true);
    assert.equal(classifyItem("Nubank usa IA para crédito").brasil, true);
    assert.equal(classifyItem("OpenAI lança novo modelo").brasil, false);
  });
});

describe("editorial-concentration — parseSitemapEntries", () => {
  it("extrai slug + lastmod de cada <url>, ignora entradas fora de /p/", () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://diar.ia.br/</loc></url>
      <url><loc>https://diar.ia.br/p/edicao-a</loc><lastmod>2025-08-27</lastmod></url>
      <url><loc>https://diar.ia.br/p/edicao-b</loc><lastmod>2025-09-04</lastmod></url>
    </urlset>`;
    const entries = parseSitemapEntries(xml);
    assert.deepEqual(entries, [
      { slug: "edicao-a", lastmod: "2025-08-27" },
      { slug: "edicao-b", lastmod: "2025-09-04" },
    ]);
  });

  it("lastmod ausente vira undefined, não quebra o parse", () => {
    const xml = `<urlset><url><loc>https://diar.ia.br/p/sem-data</loc></url></urlset>`;
    assert.deepEqual(parseSitemapEntries(xml), [{ slug: "sem-data", lastmod: undefined }]);
  });
});

describe("editorial-concentration — monthKey", () => {
  it("extrai YYYY-MM de uma data ISO", () => {
    assert.equal(monthKey("2025-08-27"), "2025-08");
    assert.equal(monthKey("2026-09-01"), "2026-09");
  });
});

describe("editorial-concentration — aggregateByMonth: data editorial, não import date", () => {
  it("edição de agosto/2025 (data EDITORIAL 27/08) não cai em setembro mesmo que publish_date cru fosse a data de importação em bloco (04/09/2025)", () => {
    // Reproduz o achado #4796/#8358: a 1ª edição real é 27/08/2025, mas
    // publish_date cru das edições importadas em bloco aponta pra
    // 04/09/2025 (data do IMPORT, não do envio). resolvePublishTimestampMs
    // já corrige isso via beehiiv-publish-date-overrides.json — o teste
    // aqui garante que ESTE módulo, ao consumir a data já resolvida do
    // sitemap (não publish_date cru), agrupa pelo lastmod do sitemap
    // corretamente: se o sitemap (que já passou pela resolução com
    // override) diz 27/08, a linha mensal tem que ser 2025-08, nunca 2025-09.
    const pages = [{ slug: "primeira-edicao", items: ["OpenAI lança modelo"] }];
    const lastmodBySlug = new Map([["primeira-edicao", "2025-08-27"]]);
    const rows = aggregateByMonth(pages, lastmodBySlug);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].month, "2025-08");
    assert.notEqual(rows[0].month, "2025-09");
  });

  it("agrupa 2 edições do mesmo mês e 1 de mês diferente em 2 linhas", () => {
    const pages = [
      { slug: "a", items: ["OpenAI lança modelo"] },
      { slug: "b", items: ["Startup brasileira capta rodada"] },
      { slug: "c", items: ["Google atualiza Gemini"] },
    ];
    const lastmodBySlug = new Map([
      ["a", "2026-01-05"],
      ["b", "2026-01-20"],
      ["c", "2026-02-01"],
    ]);
    const rows = aggregateByMonth(pages, lastmodBySlug);
    assert.deepEqual(
      rows.map((r) => [r.month, r.editions]),
      [
        ["2026-01", 2],
        ["2026-02", 1],
      ],
    );
  });

  it("página sem lastmod resolvido não entra em nenhuma linha (nunca vira mês 'undefined')", () => {
    const pages = [{ slug: "sem-data", items: ["Algo"] }];
    const rows = aggregateByMonth(pages, new Map());
    assert.equal(rows.length, 0);
  });
});

describe("editorial-concentration — aggregateByMonth: degradação graciosa (Peça 2 ausente)", () => {
  it("sem exploracaoFlags/ctrBySlug (undefined), exploracaoPct/CTRs saem null, nunca 0 ou NaN", () => {
    const pages = [{ slug: "a", items: ["OpenAI lança modelo"] }];
    const lastmodBySlug = new Map([["a", "2026-01-05"]]);
    const rows = aggregateByMonth(pages, lastmodBySlug);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].exploracaoPct, null);
    assert.equal(rows[0].exploracaoCtr, null);
    assert.equal(rows[0].restCtr, null);
  });

  it("com exploracaoFlags vazio (Map()), mesmo resultado — vazio não é diferente de ausente", () => {
    const pages = [{ slug: "a", items: ["OpenAI lança modelo"] }];
    const lastmodBySlug = new Map([["a", "2026-01-05"]]);
    const rows = aggregateByMonth(pages, lastmodBySlug, new Map(), new Map());
    assert.equal(rows[0].exploracaoPct, null);
  });

  it("com exploracaoFlags parcialmente populado, calcula exploracaoPct só sobre o conhecido e não quebra com CTR ausente", () => {
    const pages = [
      { slug: "a", items: ["OpenAI lança modelo"] },
      { slug: "b", items: ["Startup nicho capta rodada"] },
    ];
    const lastmodBySlug = new Map([
      ["a", "2026-01-05"],
      ["b", "2026-01-06"],
    ]);
    const exploracaoFlags = new Map([
      ["a", false],
      ["b", true],
    ]);
    const rows = aggregateByMonth(pages, lastmodBySlug, exploracaoFlags, new Map());
    assert.equal(rows[0].exploracaoPct, 0.5);
    // sem CTR, ambas as médias continuam null (nenhum CTR conhecido).
    assert.equal(rows[0].exploracaoCtr, null);
    assert.equal(rows[0].restCtr, null);
  });

  it("com CTR presente pros dois grupos, calcula a média de cada um separadamente", () => {
    const pages = [
      { slug: "a", items: ["OpenAI lança modelo"] },
      { slug: "b", items: ["Startup nicho capta rodada"] },
      { slug: "c", items: ["Outra notícia nicho"] },
    ];
    const lastmodBySlug = new Map([
      ["a", "2026-01-05"],
      ["b", "2026-01-06"],
      ["c", "2026-01-07"],
    ]);
    const exploracaoFlags = new Map([
      ["a", false],
      ["b", true],
      ["c", true],
    ]);
    const ctrBySlug = new Map([
      ["a", 0.02],
      ["b", 0.05],
      ["c", 0.03],
    ]);
    const rows = aggregateByMonth(pages, lastmodBySlug, exploracaoFlags, ctrBySlug);
    assert.equal(rows[0].restCtr, 0.02);
    assert.equal(rows[0].exploracaoCtr, 0.04);
  });
});
