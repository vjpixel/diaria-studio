/**
 * box-click-report.test.ts (#4354)
 *
 * Cobre a lógica pura de matching/ranking de box-click-report.ts com
 * fixtures em memória — nenhum acesso a `data/editions/` ou
 * `data/beehiiv-cache/` real (ambos ausentes num worktree fresco).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractUrls,
  toBaseUrl,
  parseSnippetContent,
  matchSnippetForBox,
  sumClicksForUrl,
  editionAammddFromPublishDate,
  findPostForEdition,
  extractEditionBoxUsages,
  buildBoxClickReport,
  renderMarkdownTable,
  type SnippetInfo,
  type PostCacheLike,
} from "../scripts/box-click-report.ts";

describe("extractUrls", () => {
  it("extrai URL nua e URL dentro de markdown link", () => {
    const text = "Veja https://example.com/a e também [aqui](https://example.com/b?x=1).";
    assert.deepEqual(extractUrls(text), ["https://example.com/a", "https://example.com/b?x=1"]);
  });

  it("extrai URL de link markdown com título em negrito", () => {
    const text = "[**A História da IA Para Quem Tem Pressa**](https://link.amazon/B057LAnK0), de Peter J. Bentley.";
    assert.deepEqual(extractUrls(text), ["https://link.amazon/B057LAnK0"]);
  });

  it("retorna array vazio quando não há URL", () => {
    assert.deepEqual(extractUrls("texto sem link nenhum"), []);
  });
});

describe("toBaseUrl", () => {
  it("remove query string e hash", () => {
    assert.equal(toBaseUrl("https://clarice.ai/precos-planos?via=diaria#foo"), "https://clarice.ai/precos-planos");
  });

  it("remove trailing slash", () => {
    assert.equal(toBaseUrl("https://example.com/path/"), "https://example.com/path");
  });

  it("colapsa 2 variantes de query pra mesma identidade", () => {
    const a = toBaseUrl("https://link.amazon/B057LAnK0?tag=diaria-20");
    const b = toBaseUrl("https://link.amazon/B057LAnK0?bhcl_id=xyz");
    assert.equal(a, b);
  });

  it("devolve a string como está quando não é URL parseável", () => {
    assert.equal(toBaseUrl("não é url"), "não é url");
  });
});

describe("parseSnippetContent", () => {
  it("extrai nome do header e URLs só do corpo (não do header)", () => {
    const content = `<!--
nome: Clarice
categoria: Divulgação
Nota interna sem link nenhum.
-->

Texto do box com [link](https://clarice.ai/precos-planos?via=diaria).`;
    const info = parseSnippetContent("clarice-divulgacao.md", content);
    assert.equal(info.nome, "Clarice");
    assert.deepEqual(info.urls, ["https://clarice.ai/precos-planos"]);
  });

  it("cai pro nome do arquivo quando não há header nome:", () => {
    const info = parseSnippetContent("sem-header.md", "Texto puro, sem comentário de header.");
    assert.equal(info.nome, "sem-header");
    assert.deepEqual(info.urls, []);
  });

  it("dedup de URLs repetidas no corpo (base-url)", () => {
    const content =
      "[Título](https://livro.com/x?ref=1) — leia também [de novo](https://livro.com/x?ref=2).";
    const info = parseSnippetContent("livro.md", content);
    assert.deepEqual(info.urls, ["https://livro.com/x"]);
  });
});

describe("matchSnippetForBox", () => {
  const snippets: SnippetInfo[] = [
    { file: "clarice-divulgacao.md", nome: "Clarice", urls: ["https://clarice.ai/precos-planos"] },
    { file: "livro.md", nome: "Livro X", urls: ["https://link.amazon/B057LAnK0"] },
  ];

  it("acha o snippet cuja URL bate (ignorando query string)", () => {
    const box = "**Escreva melhor → [Acesse](https://clarice.ai/precos-planos?via=diaria&bhcl_id=abc)**";
    const found = matchSnippetForBox(box, snippets);
    assert.equal(found?.file, "clarice-divulgacao.md");
  });

  it("retorna null quando o box não tem URL", () => {
    assert.equal(matchSnippetForBox("texto puro sem link", snippets), null);
  });

  it("retorna null quando a URL do box não bate com nenhum snippet cadastrado", () => {
    const box = "[link avulso](https://outro-dominio.com/pagina)";
    assert.equal(matchSnippetForBox(box, snippets), null);
  });
});

describe("sumClicksForUrl", () => {
  it("soma cliques de múltiplas rows com a mesma base-URL (variantes de query)", () => {
    const clicks = [
      { url: "https://clarice.ai/precos-planos?bhcl_id=1", email: { verified_clicks: 10, unique_verified_clicks: 8 } },
      { url: "https://clarice.ai/precos-planos?bhcl_id=2", email: { verified_clicks: 5, unique_verified_clicks: 4 } },
      { url: "https://outro.com/", email: { verified_clicks: 99, unique_verified_clicks: 99 } },
    ];
    const sum = sumClicksForUrl("https://clarice.ai/precos-planos?via=diaria", clicks);
    assert.equal(sum.verified_clicks, 15);
    assert.equal(sum.unique_verified_clicks, 12);
  });

  it("zera quando não há clique nenhum pra URL", () => {
    const sum = sumClicksForUrl("https://sem-clique.com/", []);
    assert.deepEqual(sum, { verified_clicks: 0, unique_verified_clicks: 0 });
  });

  it("usa base_url do click record quando presente, preferencialmente a url", () => {
    const clicks = [
      { url: "https://x.com/a?ignorar=1", base_url: "https://x.com/a", email: { verified_clicks: 3, unique_verified_clicks: 2 } },
    ];
    const sum = sumClicksForUrl("https://x.com/a", clicks);
    assert.equal(sum.verified_clicks, 3);
  });
});

describe("editionAammddFromPublishDate", () => {
  it("converte unix seconds (UTC) pra AAMMDD", () => {
    // 2026-07-31T09:00:00Z (envio ~06:00 BRT)
    const ts = Date.UTC(2026, 6, 31, 9, 0, 0) / 1000;
    assert.equal(editionAammddFromPublishDate(ts), "260731");
  });
});

describe("findPostForEdition", () => {
  const posts: PostCacheLike[] = [
    { id: "post_a", publish_date: Date.UTC(2026, 6, 30, 9) / 1000, stats: { clicks: [] } },
    { id: "post_b", publish_date: Date.UTC(2026, 6, 31, 9) / 1000, stats: { clicks: [] } },
  ];

  it("acha o post cujo publish_date cai na data da edição", () => {
    const found = findPostForEdition("260731", posts);
    assert.equal(found?.id, "post_b");
  });

  it("retorna null quando nenhum post bate com a data", () => {
    assert.equal(findPostForEdition("260801", posts), null);
  });

  it("prefere o publish_date mais recente em caso de duplicata (não deveria ocorrer)", () => {
    const dup: PostCacheLike[] = [
      { id: "early", publish_date: Date.UTC(2026, 6, 31, 8) / 1000 },
      { id: "late", publish_date: Date.UTC(2026, 6, 31, 20) / 1000 },
    ];
    assert.equal(findPostForEdition("260731", dup)?.id, "late");
  });
});

describe("extractEditionBoxUsages", () => {
  const snippets: SnippetInfo[] = [
    { file: "clarice-divulgacao.md", nome: "Clarice", urls: ["https://clarice.ai/precos-planos"] },
  ];

  it("extrai o box do slot 1 (gap D1/D2) e casa com o snippet", () => {
    const md = [
      "**DESTAQUE 1 | CAT**",
      "Título 1",
      "Corpo do destaque 1.",
      "Por que isso importa: teste.",
      "---",
      "**Use a Clarice → [Acesse](https://clarice.ai/precos-planos?via=diaria)**",
      "---",
      "**DESTAQUE 2 | CAT**",
      "Título 2",
      "Corpo do destaque 2.",
      "Por que isso importa: teste.",
    ].join("\n");

    const usages = extractEditionBoxUsages(md, snippets);
    assert.equal(usages.length, 1);
    assert.equal(usages[0].slot, 1);
    assert.equal(usages[0].snippet?.file, "clarice-divulgacao.md");
    assert.equal(usages[0].url, "https://clarice.ai/precos-planos?via=diaria");
  });

  it("devolve lista vazia quando nenhum destaque tem box na lacuna", () => {
    const md = [
      "**DESTAQUE 1 | CAT**",
      "Título 1",
      "Corpo.",
      "Por que isso importa: teste.",
      "---",
      "**DESTAQUE 2 | CAT**",
      "Título 2",
      "Corpo.",
      "Por que isso importa: teste.",
    ].join("\n");
    assert.deepEqual(extractEditionBoxUsages(md, snippets), []);
  });
});

describe("buildBoxClickReport", () => {
  const snippets: SnippetInfo[] = [
    { file: "clarice-divulgacao.md", nome: "Clarice", urls: ["https://clarice.ai/precos-planos"] },
    { file: "livro.md", nome: "Livro X", urls: ["https://link.amazon/B057LAnK0"] },
  ];

  const mdWithClarice = [
    "**DESTAQUE 1 | CAT**",
    "T1",
    "Corpo.",
    "Por que isso importa: x.",
    "---",
    "**Use a Clarice → [Acesse](https://clarice.ai/precos-planos?via=diaria)**",
    "---",
    "**DESTAQUE 2 | CAT**",
    "T2",
    "Corpo.",
    "Por que isso importa: x.",
  ].join("\n");

  const mdWithLivro = [
    "**DESTAQUE 1 | CAT**",
    "T1",
    "Corpo.",
    "Por que isso importa: x.",
    "---",
    "[**Livro X**](https://link.amazon/B057LAnK0), recomendação de leitura.",
    "---",
    "**DESTAQUE 2 | CAT**",
    "T2",
    "Corpo.",
    "Por que isso importa: x.",
  ].join("\n");

  const mdSemBox = ["**DESTAQUE 1 | CAT**", "T1", "Corpo.", "Por que isso importa: x."].join("\n");

  function reviewedMdByEdition(map: Record<string, string>) {
    return (aammdd: string) => map[aammdd] ?? null;
  }

  it("ranqueia por cliques únicos verificados, agregando por snippet através de edições", () => {
    const readReviewedMd = reviewedMdByEdition({
      "260729": mdWithClarice,
      "260730": mdWithLivro,
      "260731": mdWithClarice,
    });

    const posts: Record<string, PostCacheLike> = {
      "260729": {
        id: "p1",
        stats: {
          clicks: [
            { url: "https://clarice.ai/precos-planos?bhcl_id=1", email: { verified_clicks: 5, unique_verified_clicks: 4 } },
          ],
        },
      },
      "260730": {
        id: "p2",
        stats: {
          clicks: [
            { url: "https://link.amazon/B057LAnK0?tag=a", email: { verified_clicks: 2, unique_verified_clicks: 2 } },
          ],
        },
      },
      "260731": {
        id: "p3",
        stats: {
          clicks: [
            { url: "https://clarice.ai/precos-planos?bhcl_id=2", email: { verified_clicks: 10, unique_verified_clicks: 9 } },
          ],
        },
      },
    };

    const { rows, unmatchedBoxes } = buildBoxClickReport({
      aammddList: ["260731", "260730", "260729"],
      readReviewedMd,
      snippets,
      findPost: (aammdd) => posts[aammdd] ?? null,
    });

    assert.equal(unmatchedBoxes.length, 0);
    assert.equal(rows.length, 2);
    // Clarice: 4 (260729) + 9 (260731) = 13 unique verified, em 2 edições.
    assert.equal(rows[0].snippet, "clarice-divulgacao.md");
    assert.equal(rows[0].total_unique_verified_clicks, 13);
    assert.equal(rows[0].editions_appeared, 2);
    assert.equal(rows[0].avg_unique_verified_clicks, 6.5);
    // Livro: 2 unique verified, em 1 edição — 2º lugar.
    assert.equal(rows[1].snippet, "livro.md");
    assert.equal(rows[1].total_unique_verified_clicks, 2);
    assert.equal(rows[1].editions_appeared, 1);
  });

  it("reporta edições sem box como não-mensuráveis, sem quebrar o ranking", () => {
    const readReviewedMd = reviewedMdByEdition({ "260731": mdSemBox });
    const { rows, unmatchedBoxes } = buildBoxClickReport({
      aammddList: ["260731"],
      readReviewedMd,
      snippets,
      findPost: () => null,
    });
    assert.deepEqual(rows, []);
    assert.deepEqual(unmatchedBoxes, []);
  });

  it("reporta box usado mas sem post Beehiiv cacheado como unmatched, com cliques zero (não trava o ranking)", () => {
    const readReviewedMd = reviewedMdByEdition({ "260731": mdWithClarice });
    const { rows, unmatchedBoxes } = buildBoxClickReport({
      aammddList: ["260731"],
      readReviewedMd,
      snippets,
      findPost: () => null, // cache incompleto — post ainda não sincronizado
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_unique_verified_clicks, 0);
    assert.equal(rows[0].editions_appeared, 1); // apareceu, mesmo sem dado de clique
    assert.equal(unmatchedBoxes.length, 1);
    assert.match(unmatchedBoxes[0].reason, /nenhum post Beehiiv cacheado/);
  });

  it("ignora edições ausentes de 02-reviewed.md (readReviewedMd retorna null)", () => {
    const { rows, unmatchedBoxes } = buildBoxClickReport({
      aammddList: ["260601"], // não existe no map — retorna null
      readReviewedMd: () => null,
      snippets,
      findPost: () => null,
    });
    assert.deepEqual(rows, []);
    assert.deepEqual(unmatchedBoxes, []);
  });
});

describe("renderMarkdownTable", () => {
  it("renderiza mensagem quando não há rows", () => {
    assert.match(renderMarkdownTable([]), /nenhum box/);
  });

  it("renderiza 1 linha por row, com nome + snippet + métricas", () => {
    const table = renderMarkdownTable([
      {
        snippet: "clarice-divulgacao.md",
        nome: "Clarice",
        editions_appeared: 2,
        editions: ["260730", "260731"],
        total_verified_clicks: 15,
        total_unique_verified_clicks: 13,
        avg_unique_verified_clicks: 6.5,
      },
    ]);
    assert.match(table, /Clarice/);
    assert.match(table, /clarice-divulgacao\.md/);
    assert.match(table, /13/);
    assert.match(table, /6\.5/);
  });
});
