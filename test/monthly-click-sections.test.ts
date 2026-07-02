/**
 * test/monthly-click-sections.test.ts (#1901/#1902)
 *
 * Regressão do ranking por cliques das seções mensais Use Melhor (3) e Radar (7):
 *  - normalização de URL (strip utm/hash/barra final, case-insensitive)
 *  - classificação de seção do 02-reviewed.md (destaque / use_melhor / outro)
 *    + filtro de links não-editoriais (beehiiv)
 *  - seleção: Use Melhor top-3 (incl. fonte emprestada), Radar top-7 excluindo
 *    Destaques (temas) e qualquer link de Use Melhor, de-dup por baseUrl, cap N.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  baseUrl,
  parseEdition,
  selectSections,
  replaceSectionsBlock,
  buildSectionsBlock,
  parseUseMelhorSource,
  parseUseMelhorMinClicks,
  useMelhorPrecedenceWarning,
  type LinkItem,
} from "../scripts/monthly-click-sections.ts";

describe("baseUrl", () => {
  it("strips query/hash/barra final e lowercaseia o HOST, preservando o case do path", () => {
    assert.equal(
      baseUrl("https://Example.com/Path/?utm_source=x&a=1#frag"),
      "https://example.com/Path",
    );
  });
  it("não funde URLs distintas que diferem só no case do path", () => {
    assert.notEqual(baseUrl("https://site.com/Foo"), baseUrl("https://site.com/foo"));
  });
  it("strip de pontuação final (vírgula/ponto coladas pela prosa)", () => {
    assert.equal(baseUrl("https://foo.com/bar/."), "https://foo.com/bar");
  });
  it("é idempotente p/ URL já limpa", () => {
    assert.equal(baseUrl("https://foo.com/bar"), "https://foo.com/bar");
  });
  it("casa a URL clicada (com utm) contra a URL limpa do 02-reviewed", () => {
    const clean = "https://canaltech.com.br/ia/artigo";
    const tracked =
      "https://canaltech.com.br/ia/artigo?utm_source=diaria.beehiiv.com&utm_medium=newsletter";
    assert.equal(baseUrl(clean), baseUrl(tracked));
  });
});

describe("parseEdition", () => {
  const md = [
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    "[**Foo lança bar**](https://foo.com/bar)",
    "",
    "corpo do destaque",
    "",
    "Por que isso importa:",
    "",
    "porque sim",
    "",
    "---",
    "",
    "**🛠️ USE MELHOR**",
    "",
    "[**Tutorial X: como usar**](https://tut.com/x)  ",
    "Passo a passo pra usar X.",
    "",
    "---",
    "",
    "**📰 OUTRAS NOTÍCIAS**",
    "",
    "[**Notícia Y**](https://news.com/y)  ",
    "Resumo da notícia Y.",
    "",
    "[**link interno**](https://diaria.beehiiv.com/p/foo)  ",
    "",
  ].join("\n");

  const items = parseEdition("260601", md);
  const bySection = (s: string) => items.filter((i) => i.section === s);

  it("classifica o destaque", () => {
    const d = bySection("destaque");
    assert.equal(d.length, 1);
    assert.equal(d[0].baseUrl, "https://foo.com/bar");
    assert.equal(d[0].title, "Foo lança bar");
  });
  it("classifica o use_melhor com título e descrição", () => {
    const u = bySection("use_melhor");
    assert.equal(u.length, 1);
    assert.equal(u[0].baseUrl, "https://tut.com/x");
    assert.equal(u[0].title, "Tutorial X: como usar");
    assert.equal(u[0].desc, "Passo a passo pra usar X.");
  });
  it("classifica notícia como 'outro'", () => {
    const o = bySection("outro");
    assert.equal(o.length, 1);
    assert.equal(o[0].baseUrl, "https://news.com/y");
  });
  it("filtra link não-editorial (beehiiv)", () => {
    assert.equal(
      items.some((i) => i.baseUrl.includes("beehiiv.com")),
      false,
    );
  });
  it("carrega a edição em cada item", () => {
    assert.ok(items.every((i) => i.edition === "260601"));
  });

  it("não trata linha de prosa começando com keyword como header de seção", () => {
    // "Acesse o tutorial..." NÃO pode flipar a seção e dropar o link seguinte.
    const md2 = [
      "**🛠️ USE MELHOR**",
      "",
      "[**Tutorial Z**](https://t.com/z)  ",
      "Acesse o passo a passo completo no link.",
      "",
      "[**Vídeo guia do produto**](https://t.com/v)  ",
      "Vídeos curtos ensinam o fluxo.",
      "",
    ].join("\n");
    const it2 = parseEdition("260602", md2);
    assert.equal(it2.length, 2);
    assert.ok(it2.every((i) => i.section === "use_melhor"));
  });

  it("preserva o case do path no link parseado", () => {
    const md3 = "**📰 OUTRAS NOTÍCIAS**\n\n[**X**](https://Site.com/Path/Slug)\ndesc\n";
    const it3 = parseEdition("260603", md3);
    assert.equal(it3[0].baseUrl, "https://site.com/Path/Slug");
  });
});

describe("replaceSectionsBlock", () => {
  const PRIORITIZED = [
    "## Destaques",
    "",
    "D1: tema",
    "- 260513 — Enter — https://x.com/enter",
    "",
    "## Outras Notícias",
    "",
    "Top 10 ...",
    "",
    "- 260525 — DeepSeek — https://x.com/deepseek",
    "",
    "## Warnings",
    "",
    "Pouca cobertura Brasil este mês.",
    "",
    "---",
    "",
    "## Apêndice — todos os temas",
    "",
    "- tema X: 3 artigos",
    "",
  ].join("\n");

  const block = buildSectionsBlock({
    use_melhor: [
      { url: "https://t.com/Claude-101", title: "Claude 101", desc: "", clicks: 4, editions: ["260601"], sections: ["use_melhor"] },
    ],
    radar: [
      { url: "https://x.com/n1", title: "N1", desc: "", clicks: 3, editions: ["260514"], sections: ["outro"] },
    ],
  } as any);

  const out = replaceSectionsBlock(PRIORITIZED, block);

  it("substitui Outras Notícias por Use Melhor + Radar", () => {
    assert.ok(out);
    assert.ok(out!.includes("## Use Melhor"));
    assert.ok(out!.includes("## Radar"));
    assert.ok(!out!.includes("## Outras Notícias"));
  });
  it("PRESERVA a seção ## Warnings (regressão #1903)", () => {
    assert.ok(out!.includes("## Warnings"));
    assert.ok(out!.includes("Pouca cobertura Brasil este mês."));
  });
  it("PRESERVA a seção ## Apêndice", () => {
    assert.ok(out!.includes("## Apêndice — todos os temas"));
    assert.ok(out!.includes("- tema X: 3 artigos"));
  });
  it("preserva o case do path da URL renderizada (sem 404 por lowercase)", () => {
    assert.ok(out!.includes("https://t.com/Claude-101"));
  });
  it("re-run é idempotente: o resultado patchado pode ser re-patchado", () => {
    const out2 = replaceSectionsBlock(out!, block);
    assert.ok(out2);
    assert.ok(out2!.includes("## Apêndice — todos os temas"));
    assert.ok(out2!.includes("## Warnings"));
    // não duplica os headings
    assert.equal(out2!.match(/## Use Melhor/g)?.length, 1);
    assert.equal(out2!.match(/## Radar/g)?.length, 1);
  });
  it("retorna null quando não há âncora", () => {
    assert.equal(replaceSectionsBlock("# Título\n\nsem seções", block), null);
  });
});

describe("parseUseMelhorSource", () => {
  it("parseia forma --flag=val e --flag val", () => {
    assert.deepEqual(parseUseMelhorSource(["--use-melhor-source=260601:32c6c918,260602:d7adab86"]), [
      { edition: "260601", prefix: "32c6c918" },
      { edition: "260602", prefix: "d7adab86" },
    ]);
    assert.deepEqual(parseUseMelhorSource(["--use-melhor-source", "260603:e8b02883"]), [
      { edition: "260603", prefix: "e8b02883" },
    ]);
  });
  it("descarta entradas malformadas (edição não-6-dígitos / prefixo não-hex)", () => {
    assert.deepEqual(parseUseMelhorSource(["--use-melhor-source", "abc:xyz,2606:zz,260604:a2fe05de"]), [
      { edition: "260604", prefix: "a2fe05de" },
    ]);
  });
  it("retorna [] sem a flag", () => {
    assert.deepEqual(parseUseMelhorSource(["2605"]), []);
  });
});

describe("selectSections", () => {
  const item = (
    baseUrlStr: string,
    section: LinkItem["section"],
    edition = "260510",
    title = baseUrlStr,
  ): LinkItem => ({
    url: baseUrlStr,
    baseUrl: baseUrlStr,
    title,
    desc: "",
    section,
    edition,
  });

  it("Use Melhor: top-3 por cliques, incluindo fonte emprestada", () => {
    const monthItems = [
      item("https://t.com/a", "use_melhor"),
      item("https://t.com/b", "use_melhor"),
    ];
    const sourceItems = [item("https://t.com/borrowed", "use_melhor", "260601")];
    const clicks = new Map([
      ["https://t.com/a", 1],
      ["https://t.com/b", 5],
      ["https://t.com/borrowed", 9],
    ]);
    const r = selectSections(monthItems, sourceItems, clicks, new Set());
    assert.deepEqual(
      r.use_melhor.map((x) => x.url),
      ["https://t.com/borrowed", "https://t.com/b", "https://t.com/a"],
    );
  });

  it("Radar exclui Destaques (temas) e qualquer link de Use Melhor", () => {
    const monthItems = [
      item("https://x.com/theme", "destaque"), // tema → excluído
      item("https://x.com/tut", "use_melhor"), // use_melhor → excluído do radar
      item("https://x.com/n1", "outro"),
      item("https://x.com/n2", "outro"),
    ];
    const clicks = new Map([
      ["https://x.com/theme", 99],
      ["https://x.com/tut", 50],
      ["https://x.com/n1", 3],
      ["https://x.com/n2", 7],
    ]);
    const themeUrls = new Set(["https://x.com/theme"]);
    const r = selectSections(monthItems, [], clicks, themeUrls);
    assert.deepEqual(
      r.radar.map((x) => x.url),
      ["https://x.com/n2", "https://x.com/n1"],
    );
  });

  it("Radar é capado em 7 e ordenado por cliques desc", () => {
    const monthItems = Array.from({ length: 10 }, (_, i) =>
      item(`https://r.com/${i}`, "outro"),
    );
    const clicks = new Map(monthItems.map((it, i) => [it.baseUrl, i]));
    const r = selectSections(monthItems, [], clicks, new Set());
    assert.equal(r.radar.length, 7);
    assert.equal(r.radar[0].url, "https://r.com/9");
    assert.equal(r.radar[6].url, "https://r.com/3");
  });

  it("de-dup por baseUrl: link repetido em 2 edições é 1 item", () => {
    const monthItems = [
      item("https://d.com/x", "outro", "260505"),
      item("https://d.com/x", "outro", "260512"),
    ];
    const clicks = new Map([["https://d.com/x", 4]]);
    const r = selectSections(monthItems, [], clicks, new Set());
    assert.equal(r.radar.length, 1);
    assert.deepEqual(r.radar[0].editions, ["260505", "260512"]);
  });

  it("emite warning quando há menos candidatos que o esperado", () => {
    const r = selectSections([item("https://w.com/1", "outro")], [], new Map(), new Set());
    assert.ok(r.warnings.some((w) => w.includes("Use Melhor")));
    assert.ok(r.warnings.some((w) => w.includes("Radar")));
  });

  // #2792: tamanho do Use Melhor configurável (flag + threshold por cliques).
  it("useMelhorCount custom (6) retorna 6 itens; caption reflete a contagem real", () => {
    const monthItems = Array.from({ length: 8 }, (_, i) => item(`https://u.com/${i}`, "use_melhor"));
    const clicks = new Map(monthItems.map((it, i) => [it.baseUrl, i]));
    const r = selectSections(monthItems, [], clicks, new Set(), 6);
    assert.equal(r.use_melhor.length, 6);
    // top-6 por cliques desc: 7,6,5,4,3,2 (índices 7..2)
    assert.deepEqual(
      r.use_melhor.map((x) => x.url),
      ["https://u.com/7", "https://u.com/6", "https://u.com/5", "https://u.com/4", "https://u.com/3", "https://u.com/2"],
    );
    const block = buildSectionsBlock({ use_melhor: r.use_melhor, radar: r.radar } as any);
    assert.ok(block.includes("Os 6 tutoriais mais clicados do mês"));
  });

  it("useMelhorMinClicks: inclui TODO tutorial com clicks >= N, empate na fronteira incluído", () => {
    const monthItems = [
      item("https://m.com/a", "use_melhor"), // 8
      item("https://m.com/b", "use_melhor"), // 6 (fronteira, incluído)
      item("https://m.com/c", "use_melhor"), // 6 (empate na fronteira, incluído)
      item("https://m.com/d", "use_melhor"), // 5 (abaixo, excluído)
    ];
    const clicks = new Map([
      ["https://m.com/a", 8],
      ["https://m.com/b", 6],
      ["https://m.com/c", 6],
      ["https://m.com/d", 5],
    ]);
    const r = selectSections(monthItems, [], clicks, new Set(), 3, 6);
    assert.deepEqual(
      new Set(r.use_melhor.map((x) => x.url)),
      new Set(["https://m.com/a", "https://m.com/b", "https://m.com/c"]),
    );
    assert.equal(r.use_melhor.length, 3);
  });

  it("useMelhorMinClicks tem precedência sobre useMelhorCount quando ambos são passados", () => {
    const monthItems = [
      item("https://p.com/a", "use_melhor"),
      item("https://p.com/b", "use_melhor"),
      item("https://p.com/c", "use_melhor"),
    ];
    const clicks = new Map([
      ["https://p.com/a", 10],
      ["https://p.com/b", 10],
      ["https://p.com/c", 1],
    ]);
    // count=1 pediria só 1 item, mas minClicks=10 deve vencer e incluir os 2 empatados.
    const r = selectSections(monthItems, [], clicks, new Set(), 1, 10);
    assert.equal(r.use_melhor.length, 2);
  });

  it("useMelhorMinClicks sem candidatos: warning específico do threshold, não o de count/esperado", () => {
    const r = selectSections([item("https://z.com/1", "use_melhor")], [], new Map([["https://z.com/1", 2]]), new Set(), 3, 6);
    assert.equal(r.use_melhor.length, 0);
    assert.ok(r.warnings.some((w) => w.includes("nenhum candidato com ≥6 cliques")));
    // não deve emitir o warning "esperado N" (esse é do modo count fixo, não do threshold)
    assert.ok(!r.warnings.some((w) => w.includes("Use Melhor") && w.includes("esperado")));
  });

  it("flag ausente: comportamento default (top-3) intacto", () => {
    const monthItems = Array.from({ length: 5 }, (_, i) => item(`https://d.com/${i}`, "use_melhor"));
    const clicks = new Map(monthItems.map((it, i) => [it.baseUrl, i]));
    const r = selectSections(monthItems, [], clicks, new Set());
    assert.equal(r.use_melhor.length, 3);
  });
});

describe("parseUseMelhorMinClicks", () => {
  it("--use-melhor-min-clicks 6", () => {
    assert.equal(parseUseMelhorMinClicks(["--cycle", "2606-07", "--use-melhor-min-clicks", "6"]), 6);
  });
  it("--use-melhor-min-clicks=6", () => {
    assert.equal(parseUseMelhorMinClicks(["--use-melhor-min-clicks=6"]), 6);
  });
  it("0 é um valor válido (inclui todo candidato)", () => {
    assert.equal(parseUseMelhorMinClicks(["--use-melhor-min-clicks", "0"]), 0);
  });
  it("ausência → undefined", () => {
    assert.equal(parseUseMelhorMinClicks(["--cycle", "2606-07"]), undefined);
  });
  it("valor inválido (negativo/NaN) → undefined", () => {
    assert.equal(parseUseMelhorMinClicks(["--use-melhor-min-clicks", "-2"]), undefined);
    assert.equal(parseUseMelhorMinClicks(["--use-melhor-min-clicks", "abc"]), undefined);
  });
});

describe("useMelhorPrecedenceWarning", () => {
  it("ambos passados: warning explícito nomeando os dois valores", () => {
    const w = useMelhorPrecedenceWarning(3, 6);
    assert.ok(w);
    assert.ok(w!.includes("--use-melhor-count (3)"));
    assert.ok(w!.includes("--use-melhor-min-clicks (6)"));
    assert.ok(w!.includes("precedência"));
  });
  it("só count passado: sem warning", () => {
    assert.equal(useMelhorPrecedenceWarning(3, undefined), undefined);
  });
  it("só min-clicks passado: sem warning", () => {
    assert.equal(useMelhorPrecedenceWarning(undefined, 6), undefined);
  });
  it("nenhum passado: sem warning", () => {
    assert.equal(useMelhorPrecedenceWarning(undefined, undefined), undefined);
  });
});
