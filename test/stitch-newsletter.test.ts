import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSection, stitchNewsletter } from "../scripts/stitch-newsletter.ts";

describe("renderSection (#1463)", () => {
  it("retorna vazio quando não há items", () => {
    assert.equal(renderSection("🚀", "LANÇAMENTO", "LANÇAMENTOS", []), "");
  });

  it("usa singular quando count === 1", () => {
    const out = renderSection("🚀", "LANÇAMENTO", "LANÇAMENTOS", [
      { title: "T", url: "https://x.com/y", summary: "desc" },
    ]);
    assert.match(out, /\*\*🚀 LANÇAMENTO\*\*/);
    assert.doesNotMatch(out, /LANÇAMENTOS/);
  });

  it("usa plural quando count > 1", () => {
    const out = renderSection("🔬", "PESQUISA", "PESQUISAS", [
      { title: "T1", url: "https://a.com", summary: "d1" },
      { title: "T2", url: "https://b.com", summary: "d2" },
    ]);
    assert.match(out, /\*\*🔬 PESQUISAS\*\*/);
  });

  it("formato canonical: **[title](url)** + summary linha abaixo", () => {
    const out = renderSection("📰", "OUTRA NOTÍCIA", "OUTRAS NOTÍCIAS", [
      { title: "Notícia X", url: "https://example.com/n1", summary: "Desc da N1." },
    ]);
    // Format canonical: bold OUTSIDE link (matches template + edições publicadas)
    assert.match(out, /\*\*\[Notícia X\]\(https:\/\/example\.com\/n1\)\*\*/);
    assert.match(out, /Desc da N1\./);
  });

  it("skip items sem URL ou title", () => {
    const out = renderSection("🚀", "LANÇAMENTO", "LANÇAMENTOS", [
      { title: "OK", url: "https://x.com/y", summary: "s" },
      { title: "" } as { title: string }, // no URL
      { url: "https://no-title.com" } as { url: string }, // no title
    ]);
    assert.match(out, /\*\*\[OK\]/);
    assert.doesNotMatch(out, /no-title\.com/);
  });

  it("#1697: [TRADUZIR] vai na DESCRIÇÃO em EN, NUNCA no título (regra #1634)", () => {
    const out = renderSection("📰", "OUTRA NOTÍCIA", "OUTRAS NOTÍCIAS", [
      { title: "The rise in plastic surgeons asked to create AI face", url: "https://x.com/en", summary: "The number of people who want the face that the chatbot has generated for them is on the rise." },
      { title: "IA generativa no Brasil avança", url: "https://x.com/pt", summary: "O mercado brasileiro de IA cresce." },
    ]);
    // Título do recurso EN preservado verbatim — SEM prefixo [TRADUZIR].
    assert.match(out, /\*\*\[The rise in plastic surgeons asked to create AI face\]/);
    assert.doesNotMatch(out, /\[TRADUZIR\] The rise in plastic surgeons/);
    assert.doesNotMatch(out, /\*\*\[\[TRADUZIR\]/); // nunca dentro do link do título
    // Descrição em EN recebe [TRADUZIR] (a descrição pode ser PT, #1634).
    assert.match(out, /\[TRADUZIR\] The number of people/);
    // Item PT não recebe prefixo em lugar nenhum.
    assert.doesNotMatch(out, /\[TRADUZIR\].*mercado brasileiro/);
  });

  it("#1697: summary_lang=en dispara [TRADUZIR] na descrição (não no título)", () => {
    const out = renderSection("📰", "OUTRA NOTÍCIA", "OUTRAS NOTÍCIAS", [
      { title: "Short EN title", url: "https://x.com/en", summary: "Brief.", summary_lang: "en" },
    ]);
    assert.match(out, /\[TRADUZIR\] Brief\./);
    assert.match(out, /\*\*\[Short EN title\]\(https:\/\/x\.com\/en\)\*\*/); // título limpo
  });

  it("#1697: título EN com descrição PT NÃO recebe [TRADUZIR] (detecção por summary)", () => {
    const out = renderSection("📰", "OUTRA NOTÍCIA", "OUTRAS NOTÍCIAS", [
      { title: "GPT-5 Turbo", url: "https://x.com/en", summary: "Modelo lançado pela OpenAI nesta terça." },
    ]);
    assert.doesNotMatch(out, /\[TRADUZIR\]/);
    assert.match(out, /\*\*\[GPT-5 Turbo\]/);
  });
});

describe("stitchNewsletter (#1463)", () => {
  function setupEdition() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("une 3 destaque drafts + seções secundárias na ordem do template", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "02-d1-draft.md"),
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**Title 1**](https://example.com/d1)\n\nbody1",
      );
      writeFileSync(
        join(internalDir, "02-d2-draft.md"),
        "**DESTAQUE 2 | ⚖️ REGULAÇÃO**\n\n[**Title 2**](https://example.com/d2)\n\nbody2",
      );
      writeFileSync(
        join(internalDir, "02-d3-draft.md"),
        "**DESTAQUE 3 | 🔬 PESQUISA**\n\n[**Title 3**](https://example.com/d3)\n\nbody3",
      );
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Para esta edição, eu enviei 5 e a Diar.ia 100. Selecionamos os 10." },
          lancamento: [{ title: "L1", url: "https://l.com/1", summary: "ldesc" }],
          radar: [
            { title: "P1", url: "https://p.com/1", summary: "p1desc" },
            { title: "P2", url: "https://p.com/2", summary: "p2desc" },
            { title: "N1", url: "https://n.com/1", summary: "ndesc" }
          ],
        }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      // Ordem canonical (#1569): coverage > D1 > D2 > É IA? > D3 > LANÇAMENTOS > RADAR > ERRO > SORTEIO > PARA ENCERRAR
      // RADAR mergea radar + radar em uma só seção (papers + notícias).
      assert.match(result, /enviei 5 e a Diar\.ia 100/);
      const d2Pos = result.indexOf("DESTAQUE 2");
      const eiaPos = result.indexOf("É IA?");
      const d3Pos = result.indexOf("DESTAQUE 3");
      const radarPos = result.indexOf("📡 RADAR");
      const erroPos = result.indexOf("ERRO INTENCIONAL");
      const sortPos = result.indexOf("SORTEIO");
      const encerrarPos = result.indexOf("PARA ENCERRAR");
      assert.ok(d2Pos > 0 && d2Pos < eiaPos, `D2 antes de É IA? (d2=${d2Pos} eia=${eiaPos})`);
      assert.ok(eiaPos < d3Pos, "É IA? antes de D3");
      assert.ok(d3Pos < radarPos, "D3 antes de RADAR");
      assert.ok(radarPos < erroPos, "RADAR antes de ERRO");
      assert.ok(erroPos < sortPos, "ERRO antes de SORTEIO");
      assert.ok(sortPos < encerrarPos, "SORTEIO antes de PARA ENCERRAR");
      // RADAR deve incluir items das duas categorias (radar + radar)
      assert.match(result, /https:\/\/p\.com\/1/);
      assert.match(result, /https:\/\/n\.com\/1/);
      // #1702: prêmio do sorteio é caneca da Diar.ia, não livro.
      assert.match(result, /uma caneca da Diar\.ia/);
      assert.doesNotMatch(result, /livro sobre IA/);
      assert.doesNotMatch(result, /sorteio mensal de livros/);
    } finally {
      cleanup();
    }
  });

  it("#1752: renderiza USE MELHOR (bucket use_melhor) antes de LANÇAMENTOS", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Coverage." },
          use_melhor: [{ title: "UM1", url: "https://um.com/1", summary: "umdesc" }],
          lancamento: [{ title: "L1", url: "https://l.com/1", summary: "ldesc" }],
          radar: [{ title: "R1", url: "https://r.com/1", summary: "rdesc" }],
        }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      // Bug #1752: a seção sumia. Agora renderiza + item presente.
      assert.match(result, /USE MELHOR/, "seção USE MELHOR deve aparecer");
      assert.match(result, /https:\/\/um\.com\/1/, "item do use_melhor deve aparecer");
      // Ordem editorial (260603): USE MELHOR antes de LANÇAMENTOS.
      const umPos = result.indexOf("USE MELHOR");
      const lancPos = result.indexOf("LANÇAMENTO");
      assert.ok(umPos > 0 && umPos < lancPos, `USE MELHOR antes de LANÇAMENTOS (um=${umPos} lanc=${lancPos})`);
    } finally {
      cleanup();
    }
  });

  it("omite section vazia (LANÇAMENTOS sem items)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Coverage." },
          lancamento: [], // vazio
          radar: [
            { title: "P", url: "https://p.com", summary: "x" }
          ],
        }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      // #1569: PESQUISA agora vai em RADAR (sem seção PESQUISAS dedicada).
      assert.doesNotMatch(result, /LANÇAMENTOS|LANÇAMENTO/);
      assert.match(result, /📡 RADAR/);
      assert.match(result, /https:\/\/p\.com/);
      // PESQUISAS antigo header não aparece mais
      assert.doesNotMatch(result, /\*\*🔬 PESQUISAS\*\*|\*\*🔬 PESQUISA\*\*/);
      assert.doesNotMatch(result, /OUTRA NOTÍCIA|OUTRAS NOTÍCIAS/);
    } finally {
      cleanup();
    }
  });

  it("#1463 review fix: strip YAML frontmatter do 01-eia.md", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "c" }, lancamento: [], radar: [] }),
      );
      // 01-eia.md em formato real de produção (com YAML frontmatter)
      writeFileSync(
        join(dir, "01-eia.md"),
        `---
eia_answer:
  A: ia
  B: real
---

É IA?

Foto descrição.

> Gabarito: **A é a IA**`,
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      // Frontmatter NÃO deve aparecer no output
      assert.doesNotMatch(result, /eia_answer:/);
      assert.doesNotMatch(result, /A: ia/);
      // Mas o conteúdo do bloco É IA? sim
      assert.match(result, /Foto descrição\./);
      assert.match(result, /Gabarito.*A é a IA/);
    } finally {
      cleanup();
    }
  });

  it("lê É IA? do 01-eia.md quando existe", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "c" }, lancamento: [], radar: [] }),
      );
      writeFileSync(
        join(dir, "01-eia.md"),
        "É IA?\n\nFoto descrição customizada\n\n> Gabarito: **B é a IA**",
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      assert.match(result, /Foto descrição customizada/);
      assert.match(result, /Gabarito.*B é a IA/);
    } finally {
      cleanup();
    }
  });

  it("placeholder É IA? quando 01-eia.md ausente", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "c" }, lancamento: [], radar: [] }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      assert.match(result, /É IA\? ainda processando/);
    } finally {
      cleanup();
    }
  });

  it("erro quando destaque draft ausente", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      // D2 ausente
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "c" }, lancamento: [], radar: [] }),
      );
      assert.throws(
        () =>
          stitchNewsletter({
            d1Path: join(internalDir, "02-d1-draft.md"),
            d2Path: join(internalDir, "02-d2-draft.md"),
            d3Path: join(internalDir, "02-d3-draft.md"),
            approvedCappedPath: join(internalDir, "01-approved-capped.json"),
            editionDir: dir,
          }),
        /input ausente/,
      );
    } finally {
      cleanup();
    }
  });

  it("inclui blocos fixos (ERRO INTENCIONAL placeholder + SORTEIO + PARA ENCERRAR)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "c" }, lancamento: [], radar: [] }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      assert.match(result, /\{placeholder, script render-erro-intencional/);
      assert.match(result, /SORTEIO/);
      assert.match(result, /PARA ENCERRAR/);
      assert.match(result, /diaria\.beehiiv\.com\/cursos-gratuitos-de-ia/);
    } finally {
      cleanup();
    }
  });
});
