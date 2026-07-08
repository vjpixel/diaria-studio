/**
 * build-livros-page.test.ts (#1744)
 *
 * Helpers puros da página de livros: validação de schema, escaping, formatação
 * de nota, temas distintos e render (filtros, cards, badges, nota, highlight,
 * CTA de afiliado, empty-state via style.display).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateBooks,
  renderLivrosPage,
  esc,
  isSafeUrl,
  fmtRating,
  distinctThemes,
  availableThemes,
  loadBooks,
  type Book,
} from "../scripts/build-livros-page.ts";

const SEED = resolve(dirname(fileURLToPath(import.meta.url)), "..", "seed/books/livros-ia.json");

function book(over: Partial<Book> = {}): Book {
  return {
    id: "b1",
    title: "Livro Teste",
    link: "https://amzn.to/abc123",
    language: "pt-br",
    level: "iniciante",
    themes: ["História"],
    rating: 4.5,
    highlight: "Bestseller.",
    summary: "Para quem quer testar.",
    ...over,
  };
}

describe("validateBooks (#1744)", () => {
  it("aceita um livro completo", () => {
    const v = validateBooks([book()]);
    assert.equal(v.ok, true);
    assert.equal(v.errors.length, 0);
  });

  it("erro em campos obrigatórios ausentes (title/link/summary)", () => {
    const v = validateBooks([book({ title: "", link: "", summary: "" })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("title")));
    assert.ok(v.errors.some((e) => e.includes("link")));
    assert.ok(v.errors.some((e) => e.includes("summary")));
  });

  it("erro em id duplicado", () => {
    const v = validateBooks([book({ id: "dup" }), book({ id: "dup", title: "Outro" })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("duplicado")));
  });

  it("erro em language/level fora do enum", () => {
    const v = validateBooks([book({ language: "fr" as never, level: "deus" as never })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("language")));
    assert.ok(v.errors.some((e) => e.includes("level")));
  });

  it("themes vazio é permitido (alguns livros não têm tema)", () => {
    const v = validateBooks([book({ themes: [] })]);
    assert.equal(v.ok, true);
  });

  it("link não-http e rating fora de 0-5 são warning, não erro", () => {
    const v = validateBooks([book({ link: "javascript:alert(1)", rating: 9 })]);
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some((w) => w.includes("esquema inválido")));
    assert.ok(v.warnings.some((w) => w.includes("rating")));
  });
});

describe("esc / isSafeUrl / fmtRating (#1744)", () => {
  it("esc escapa metacaracteres HTML", () => {
    assert.equal(esc(`<b>"x" & 'y'`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;");
  });
  it("isSafeUrl: http(s) sim, resto não", () => {
    assert.equal(isSafeUrl("https://amzn.to/x"), true);
    assert.equal(isSafeUrl("javascript:alert(1)"), false);
    assert.equal(isSafeUrl(""), false);
    assert.equal(isSafeUrl(undefined), false);
  });
  it("fmtRating: número → vírgula PT; ausente → null", () => {
    assert.equal(fmtRating(4.5), "4,5");
    assert.equal(fmtRating(5), "5,0");
    assert.equal(fmtRating(undefined), null);
  });
});

describe("distinctThemes / availableThemes (#1744)", () => {
  const sample = [
    book({ id: "a", language: "pt-br", level: "iniciante", themes: ["História"] }),
    book({ id: "b", language: "en", level: "avancado", themes: ["Engenharia"] }),
    book({ id: "c", language: "pt-br", level: "avancado", themes: ["Design", "Ciência"] }),
  ];

  it("distinctThemes coleta todos os temas ordenados", () => {
    assert.deepEqual(distinctThemes(sample), ["Ciência", "Design", "Engenharia", "História"]);
  });

  it("availableThemes filtra por idioma — Engenharia (só EN) some do recorte PT", () => {
    assert.deepEqual(availableThemes(sample, "pt-br"), ["Ciência", "Design", "História"]);
  });

  it("availableThemes filtra por nível", () => {
    assert.deepEqual(availableThemes(sample, "", "avancado"), ["Ciência", "Design", "Engenharia"]);
  });

  it("availableThemes combina idioma+nível", () => {
    assert.deepEqual(availableThemes(sample, "pt-br", "avancado"), ["Ciência", "Design"]);
  });
});

describe("renderLivrosPage (#1744)", () => {
  const html = renderLivrosPage([
    book({ id: "a", title: "Alpha", language: "pt-br", level: "iniciante", themes: ["História"], rating: 4.7, link: "https://amzn.to/aaa" }),
    book({ id: "b", title: "Beta", language: "en", level: "avancado", themes: ["Engenharia"], rating: 4.2, highlight: "", link: "https://amzn.to/bbb" }),
  ]);

  it("cards com data-* pros filtros + títulos linkados ao amzn.to", () => {
    assert.match(html, /data-lang="pt-br"/);
    assert.match(html, /data-lang="en"/);
    assert.match(html, /data-themes="Engenharia"/);
    assert.match(html, /href="https:\/\/amzn\.to\/aaa"/);
  });
  it("inclui os 3 filtros + tema derivado dos dados", () => {
    assert.match(html, /id="f-lang"/);
    assert.match(html, /id="f-level"/);
    assert.match(html, /id="f-theme"/);
    assert.match(html, /<option value="Engenharia">Engenharia<\/option>/);
  });
  it("mostra a nota da Amazon (★)", () => {
    assert.match(html, /★ 4,7/);
    assert.match(html, /★ 4,2/);
  });
  it("badges de idioma/nível/tema", () => {
    assert.match(html, /badge--lang">Português/);
    assert.match(html, /class="badge">Iniciante/);
  });
  it("highlight aparece quando presente, some quando vazio", () => {
    assert.match(html, /class="highlight">Bestseller\./); // Alpha tem
    // Beta com highlight "" não deve gerar <p class="highlight">
    const betaBlock = html.slice(html.indexOf("Beta"));
    assert.doesNotMatch(betaBlock.slice(0, 400), /class="highlight"/);
  });
  it("links de afiliado marcados rel=sponsored", () => {
    assert.match(html, /rel="noopener noreferrer sponsored"/);
  });
  it("filtro via style.display; empty-state inline display:none", () => {
    assert.match(html, /\.style\.display\s*=/);
    assert.doesNotMatch(html, /c\.hidden\s*=/);
    assert.match(html, /id="empty"[^>]*style="display:none"/);
  });
  it("self-contained (sem fetch de dados)", () => {
    assert.doesNotMatch(html, /fetch\(/);
  });
  it("escapa conteúdo (sem injeção)", () => {
    const evil = renderLivrosPage([book({ title: "<script>alert(1)</script>", summary: "x & y" })]);
    assert.doesNotMatch(evil, /<script>alert\(1\)<\/script>/);
    assert.match(evil, /&lt;script&gt;/);
  });
  it("badge de idioma SEM teal (#1994 followup — pedido do editor 2026-06-09)", () => {
    // O editor pediu pra remover o teal do badge de idioma: volta ao .badge
    // padrão (texto ink + borda bege). A classe `badge--lang` segue no HTML.
    assert.doesNotMatch(html, /\.badge--lang\s*\{[^}]*var\(--teal\)/, "badge--lang não pode reintroduzir teal");
    assert.match(html, /badge--lang">/, "a classe badge--lang segue no HTML (hook)");
  });

  it("CTA segue DS: 16px, Geist, sem uppercase nem letter-spacing (#2079)", () => {
    // DS: CTAs são corpo (16px sans bold), não labels uppercase (12px).
    // Referência: newsletter-render-html.ts boxDivulgacao1 CTA — font-size:16px, font-weight:bold, sem uppercase.
    assert.match(html, /\.cta\s*\{[^}]*font-size:\s*16px/, "CTA deve ser 16px");
    assert.doesNotMatch(html, /\.cta\s*\{[^}]*font-size:\s*12px/, "CTA não pode ser 12px");
    assert.doesNotMatch(html, /\.cta\s*\{[^}]*text-transform:\s*uppercase/, "CTA não pode ser uppercase");
    assert.doesNotMatch(html, /\.cta\s*\{[^}]*letter-spacing:\s*0\.12em/, "CTA não pode ter letter-spacing 0.12em");
  });

  it("papéis de fonte do DS: CORPO em Geist sans, TÍTULOS em Georgia serif", () => {
    // DS canônico (#1936): serif (Georgia) SÓ em títulos; corpo + UI = sans (Geist).
    // Pedido do editor 2026-06-09: body herdava serif → descrições em serif; corrigido.
    assert.match(html, /body\s*\{\s*font-family:\s*'Geist'/, "corpo (body) deve ser Geist sans");
    assert.match(html, /\bh1\s*\{\s*font-family:\s*Georgia/, "h1 (título) deve ser Georgia serif");
    assert.match(html, /\.title-row h2\s*\{\s*font-family:\s*Georgia/, "h2 do card (título) deve ser Georgia serif");
    assert.match(html, /\.filters select\s*\{\s*font-family:\s*'Geist'/, "dropdown (UI) deve ser Geist sans");
    assert.doesNotMatch(html, /body\s*\{\s*font-family:\s*Georgia/, "body não pode ser serif");
  });
});

describe("SEO/compartilhamento — meta tags (#3106)", () => {
  const html = renderLivrosPage([book()]);

  it("tem meta description não-vazia", () => {
    const m = html.match(/<meta name="description" content="([^"]+)">/);
    assert.ok(m, "deve ter <meta name=\"description\">");
    assert.ok(m![1].length > 20, "description não pode ser curta demais/vazia");
  });

  it("og:title, og:description e og:url presentes", () => {
    assert.match(html, /<meta property="og:title" content="Livros sobre IA · Diar\.ia">/);
    assert.match(html, /<meta property="og:description" content="[^"]+">/);
    assert.match(html, /<meta property="og:url" content="https:\/\/livros\.diaria\.workers\.dev\/">/);
    assert.match(html, /<meta property="og:type" content="website">/);
  });

  it("canonical aponta pro domínio certo (livros.diaria.workers.dev)", () => {
    assert.match(html, /<link rel="canonical" href="https:\/\/livros\.diaria\.workers\.dev\/">/);
  });

  it("twitter card presente (summary, sem imagem grande)", () => {
    assert.match(html, /<meta name="twitter:card" content="summary">/);
  });

  it("favicon presente (SVG data-URI inline — sem asset externo)", () => {
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  });

  it("og:image/twitter:image OMITIDOS de propósito (data-URI não é buscável por crawlers de unfurling)", () => {
    assert.doesNotMatch(html, /property="og:image"/);
    assert.doesNotMatch(html, /name="twitter:image"/);
  });
});

describe("seed real seed/books/livros-ia.json (#1744)", () => {
  const books = loadBooks(SEED);

  it("tem 29 livros e passa a validação", () => {
    assert.equal(books.length, 29);
    assert.equal(validateBooks(books).ok, true);
  });
  it("todo link é afiliado (amzn.to OU amazon.com.br?tag=vjpixel-20)", () => {
    // 23 da planilha master usam amzn.to (links curtos); os 6 canônicos
    // adicionados depois usam amazon.com.br/dp/{ASIN}?tag=vjpixel-20 (formato
    // afiliado aprovado quando a geração de amzn.to via SiteStripe ficou
    // bloqueada). Ambos rendem comissão.
    const AMZN_SHORT = /^https:\/\/amzn\.to\//;
    const AMZN_BR_TAGGED = /^https:\/\/www\.amazon\.com\.br\/.*[?&]tag=vjpixel-20(\b|&|$)/;
    for (const b of books) {
      assert.ok(isSafeUrl(b.link), `${b.id}: link inseguro ${b.link}`);
      assert.ok(
        AMZN_SHORT.test(b.link) || AMZN_BR_TAGGED.test(b.link),
        `${b.id}: link não é afiliado (nem amzn.to nem amazon.com.br?tag=vjpixel-20): ${b.link}`,
      );
    }
  });
  it("todo livro tem rating numérico 0-5", () => {
    for (const b of books) {
      assert.ok(typeof b.rating === "number" && b.rating >= 0 && b.rating <= 5, `${b.id}: rating ${b.rating}`);
    }
  });
  it("ids únicos", () => {
    assert.equal(new Set(books.map((b) => b.id)).size, books.length);
  });

  it("todo livro tem ao menos 1 tema (nenhum box sem tema)", () => {
    const semTema = books.filter((b) => !b.themes || b.themes.length === 0).map((b) => b.id);
    assert.deepEqual(semTema, [], `livros sem tema: ${semTema.join(", ")}`);
  });

  it("nenhuma opção de tema zera a lista no recorte de cada idioma (dropdown dinâmico)", () => {
    for (const lang of ["pt-br", "en"]) {
      for (const t of availableThemes(books, lang)) {
        const n = books.filter((b) => b.language === lang && b.themes.includes(t)).length;
        assert.ok(n >= 1, `tema "${t}" zera no idioma ${lang}`);
      }
    }
  });
});
