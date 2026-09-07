/**
 * test/collect-annual-precedence.test.ts (#7569)
 *
 * `destaquesForPost` decide de QUAL das três fontes os destaques de uma
 * edição saem — e essa é a lógica mais sutil da coleta anual, porque a
 * escolha entre o parser atual e o legado é por RENDIMENTO, não por data de
 * corte. Uma regressão aqui (trocar `>=` por `>`, inverter a comparação
 * entre os dois parsers) não quebra nada visivelmente: a retrospectiva só
 * sai com menos material, ou com material pior, e ninguém nota.
 *
 * Os fixtures abaixo são mínimos de propósito — o que está sob teste é a
 * PRECEDÊNCIA, não os parsers (que têm testes próprios em
 * `legacy-edition-parse.test.ts` e `collect-monthly.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { destaquesForPost, dominantSource } from "../scripts/collect-annual.ts";
import type { UnifiedCachedPost } from "../scripts/lib/shared/edition-cache-reader.ts";
import type { AnnualMonthSource } from "../scripts/lib/anual/annual-collect.ts";

/**
 * Edição no formato ATUAL. A moldura `<table><tr><td>` por destaque é a que
 * o HTML publicado do Beehiiv usa de verdade — é dela que
 * `convertBeehiivHtmlToMarkdown` deriva os blocos (ver
 * `test/edition-html-convert.test.ts`).
 */
function modernHtml(n: number): string {
  // Categorias sem dígito de propósito: o conversor só reconhece cabeçalho
  // feito de MAIÚSCULAS e espaço (`CATEGORY_LINE_RE`), então "CATEGORIA 1"
  // não casa e o bloco inteiro é descartado — foi assim que a 1ª versão
  // deste fixture passou "verde" com zero destaque extraído.
  const CATS = ["ENERGIA", "TRABALHO", "REGULACAO", "PESQUISA", "MERCADO"];
  const blocos = Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    return [
      "<tr><td>",
      `<h6>${CATS[i % CATS.length]}</h6>`,
      `<h1><a href="https://exemplo.com/moderno-${k}">Título moderno ${k}</a></h1>`,
      `<p>Corpo do destaque moderno ${k}.</p>`,
      "<p><strong>Por que isso importa:</strong></p>",
      `<p>O porquê do destaque ${k}.</p>`,
      "</td></tr>",
    ].join("");
  });
  return `<html><body><table>${blocos.join("")}</table></body></html>`;
}

/** Edição no formato ANTIGO (título em texto puro + link "Aprofunde" no fim). */
function legacyHtml(n: number): string {
  const linhas: string[] = ["<p>1 de outubro de 2025</p>"];
  for (let i = 1; i <= n; i++) {
    linhas.push(
      "<p>SEÇÃO</p>",
      "<p>________________________</p>",
      `<p>Título legado número ${i}</p>`,
      `<p>Corpo do destaque legado ${i}, com texto suficiente.</p>`,
      `<p>Por que isso importa: o porquê do legado ${i}.</p>`,
      `<p>[Aprofunde](https://exemplo.com/legado-${i})</p>`,
    );
  }
  return `<html><body>${linhas.join("")}</body></html>`;
}

function post(html: string): UnifiedCachedPost {
  return { origin: "beehiiv", status: "confirmed", slug: "post-x", content: { free: { web: html } } };
}

/** `02-reviewed.md` no formato do pipeline (bloco `**DESTAQUE N | CAT**`). */
function reviewedMd(n: number): string {
  return Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    return [
      `**DESTAQUE ${k} | CATEGORIA**`,
      "",
      `[Título local ${k}](https://exemplo.com/local-${k})`,
      "",
      `Corpo do destaque local ${k}.`,
      "",
      "**Por que isso importa:**",
      `O porquê do local ${k}.`,
    ].join("\n");
  }).join("\n\n---\n\n");
}

/** Diretório temporário com uma edição local; devolve o mapa que a coleta usa. */
function withLocalEdition(edition: string, md: string | null): { dirs: Map<string, string>; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "annual-prec-"));
  const dir = join(root, edition);
  mkdirSync(dir, { recursive: true });
  if (md !== null) writeFileSync(join(dir, "02-reviewed.md"), md);
  return {
    dirs: new Map([[edition, dir]]),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("precedência de fonte por edição", () => {
  it("markdown local publicado vence o cache", () => {
    const { dirs, cleanup } = withLocalEdition("260715", reviewedMd(3));
    try {
      const warnings: string[] = [];
      // O cache traz conteúdo DIFERENTE — se o local não vencesse, os títulos
      // seriam os do cache, e o teste veria isso.
      const r = destaquesForPost(post(modernHtml(3)), "260715", dirs, warnings);
      assert.equal(r.source, "edicoes-locais");
      assert.equal(r.destaques.length, 3);
      assert.ok(r.destaques[0].title.startsWith("Título local"));
      assert.deepEqual(warnings, []);
    } finally {
      cleanup();
    }
  });

  it("local presente mas sem destaque parseável cai pro cache, com aviso", () => {
    const { dirs, cleanup } = withLocalEdition("260715", "# Um markdown qualquer\n\nsem bloco de destaque.\n");
    try {
      const warnings: string[] = [];
      const r = destaquesForPost(post(modernHtml(3)), "260715", dirs, warnings);
      assert.equal(r.source, "cache-html");
      assert.equal(r.destaques.length, 3);
      assert.ok(
        warnings.some((w) => w.includes("02-reviewed.md presente mas sem destaque parseável")),
        "cair pro cache em silêncio esconderia um 02-reviewed.md corrompido",
      );
    } finally {
      cleanup();
    }
  });

  it("edição sem cópia local usa o cache direto, sem aviso", () => {
    const warnings: string[] = [];
    const r = destaquesForPost(post(modernHtml(3)), "251001", new Map(), warnings);
    assert.equal(r.source, "cache-html");
    assert.deepEqual(warnings, [], "não ter a edição em disco é o normal, não uma anomalia");
  });

  it("formato atual com 3 destaques nunca consulta o parser legado", () => {
    // O fixture moderno NÃO tem link "Aprofunde"; se o legado fosse
    // consultado e vencesse, a fonte seria outra.
    const r = destaquesForPost(post(modernHtml(3)), "251001", new Map(), []);
    assert.equal(r.source, "cache-html");
    assert.equal(r.destaques.length, 3, "sem esta checagem o `every` abaixo passaria com lista vazia");
    assert.ok(r.destaques.every((d) => d.title.startsWith("Título moderno")));
  });

  it("formato antigo: o legado vence quando extrai mais que o atual", () => {
    const warnings: string[] = [];
    const r = destaquesForPost(post(legacyHtml(3)), "251001", new Map(), warnings);
    assert.equal(r.source, "cache-html-legado");
    assert.equal(r.destaques.length, 3);
    assert.ok(r.destaques[0].title.startsWith("Título legado"));
    assert.deepEqual(warnings, []);
  });

  it("legado preenche is_brazil (a detecção não se perde no caminho alternativo)", () => {
    const html = [
      "<html><body>",
      "<p>1 de outubro de 2025</p>",
      "<p>BRASIL</p>",
      "<p>________________________</p>",
      "<p>Governo brasileiro anuncia investimento em IA</p>",
      "<p>O Ministério da Gestão assinou acordo para soluções de IA.</p>",
      "<p>Por que isso importa: pode democratizar o acesso.</p>",
      "<p>[Aprofunde](https://g1.globo.com/tecnologia/ia)</p>",
      "</body></html>",
    ].join("");
    const r = destaquesForPost(post(html), "251001", new Map(), []);
    assert.equal(r.source, "cache-html-legado");
    assert.equal(r.destaques[0].is_brazil, true);
  });

  it("nenhum dos dois parsers extrai nada: avisa, não fica calado", () => {
    const warnings: string[] = [];
    const r = destaquesForPost(post("<html><body><p>Texto solto.</p></body></html>"), "251001", new Map(), warnings);
    assert.deepEqual(r.destaques, []);
    assert.ok(warnings.some((w) => w.includes("nenhum destaque extraído")));
  });

  it("extração PARCIAL (1-2 de 3) também avisa — meia edição é fácil de não notar", () => {
    const warnings: string[] = [];
    const r = destaquesForPost(post(modernHtml(1)), "251001", new Map(), warnings);
    assert.equal(r.destaques.length, 1);
    assert.ok(warnings.some((w) => w.includes("só 1 destaque")));
  });

  it("post sem conteúdo no cache é ignorado com aviso, não quebra a coleta", () => {
    const warnings: string[] = [];
    const semConteudo: UnifiedCachedPost = { origin: "beehiiv", status: "confirmed", slug: "x" };
    const r = destaquesForPost(semConteudo, "251001", new Map(), warnings);
    assert.equal(r.source, "vazio");
    assert.deepEqual(r.destaques, []);
    assert.ok(warnings.some((w) => w.includes("sem conteúdo no cache")));
  });

  it("o mês do destaque vem da edição, não de onde o texto foi lido", () => {
    const r = destaquesForPost(post(legacyHtml(2)), "251001", new Map(), []);
    assert.ok(r.destaques.every((d) => d.month === "2510" && d.edition === "251001"));
  });
});

describe("dominantSource", () => {
  const s = (...v: AnnualMonthSource[]) => dominantSource(v);

  it("mês sem edição nenhuma é 'vazio'", () => {
    assert.equal(s(), "vazio");
    assert.equal(s("vazio", "vazio"), "vazio");
  });

  it("reporta a fonte mais frequente do mês", () => {
    assert.equal(s("cache-html-legado", "cache-html-legado", "cache-html"), "cache-html-legado");
    assert.equal(s("edicoes-locais", "cache-html", "cache-html"), "cache-html");
  });

  it("edições vazias não contam para a moda", () => {
    assert.equal(s("vazio", "vazio", "edicoes-locais"), "edicoes-locais");
  });

  it("empate é determinístico: vence a fonte mais confiável", () => {
    // Sem esse desempate o rótulo do relatório do gate oscilaria entre
    // execuções com a mesma entrada.
    assert.equal(s("cache-html", "edicoes-locais"), "edicoes-locais");
    assert.equal(s("cache-html-legado", "cache-html"), "cache-html");
  });
});
