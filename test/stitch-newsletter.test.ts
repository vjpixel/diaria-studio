import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSection, renderUseMelhorSection, stitchNewsletter, loadClariceCallout, loadDailyCallout } from "../scripts/stitch-newsletter.ts";
import { extractBoxDivulgacao1, extractBoxDivulgacao2, extractBoxDivulgacao3 } from "../scripts/render-newsletter-html.ts";
import { stripHtml } from "../scripts/lib/clean-summary.ts";

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

  it("#1790: summary EN CURTO (4-9 palavras, sem summary_lang) ainda recebe [TRADUZIR]", () => {
    // Regressão da unificação do looksEnglish (review #1818): o call-site do
    // [TRADUZIR] precisa de minWords:4 — senão summary EN curto escapa.
    const out = renderSection("📰", "OUTRA NOTÍCIA", "OUTRAS NOTÍCIAS", [
      { title: "Título PT", url: "https://x.com/en", summary: "Use the new API to ship faster." },
    ]);
    assert.match(out, /\[TRADUZIR\] Use the new API/);
  });

  it("#1697: título EN com descrição PT NÃO recebe [TRADUZIR] (detecção por summary)", () => {
    const out = renderSection("📰", "OUTRA NOTÍCIA", "OUTRAS NOTÍCIAS", [
      { title: "GPT-5 Turbo", url: "https://x.com/en", summary: "Modelo lançado pela OpenAI nesta terça." },
    ]);
    assert.doesNotMatch(out, /\[TRADUZIR\]/);
    assert.match(out, /\*\*\[GPT-5 Turbo\]/);
  });

  it("#1855: USE MELHOR renderiza tutorial EN (revert do PT-only #1632) com [TRADUZIR] na descrição", () => {
    const out = renderSection("🛠️", "USE MELHOR", "USE MELHOR", [
      { title: "Como usar o Claude para planilhas", url: "https://pt.com/1", summary: "Tutorial em português sobre como automatizar planilhas." },
      { title: "How to fine-tune your first model", url: "https://en.com/2", summary: "A step-by-step guide to training and deploying a model with the new API." },
    ]);
    // Ambos os tutoriais aparecem — EN não é mais descartado.
    assert.match(out, /https:\/\/pt\.com\/1/);
    assert.match(out, /https:\/\/en\.com\/2/);
    // Título EN verbatim (sem [TRADUZIR]), descrição EN marcada [TRADUZIR].
    assert.match(out, /\*\*\[How to fine-tune your first model\]/);
    assert.match(out, /\[TRADUZIR\] A step-by-step guide/);
    // Plural porque há 2 itens.
    assert.match(out, /\*\*🛠️ USE MELHOR\*\*/);
  });

  it("#1855: USE MELHOR 100% EN renderiza (não some — era o bug #1851)", () => {
    const out = renderSection("🛠️", "USE MELHOR", "USE MELHOR", [
      { title: "Prompt engineering basics", url: "https://en.com/x", summary: "A short guide.", summary_lang: "en" },
      { title: "Build an agent with the new SDK", url: "https://en.com/y", summary: "Step by step how to wire the tools.", summary_lang: "en" },
    ]);
    assert.notEqual(out, "");
    assert.match(out, /\*\*🛠️ USE MELHOR\*\*/);
    assert.match(out, /https:\/\/en\.com\/x/);
    assert.match(out, /https:\/\/en\.com\/y/);
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
      // Ordem canonical (#2546, VÍDEO/RADAR trocados em #3100, VÍDEO subiu pra
      // antes de LANÇAMENTOS em #3820): coverage > D1 > D2 > D3 >
      // É IA? > USE MELHOR > VÍDEO > LANÇAMENTOS > RADAR > ERRO > SORTEIO > PARA ENCERRAR
      // RADAR mergea radar + radar em uma só seção (papers + notícias).
      assert.match(result, /enviei 5 e a Diar\.ia 100/);
      const d2Pos = result.indexOf("DESTAQUE 2");
      const eiaPos = result.indexOf("É IA?");
      const d3Pos = result.indexOf("DESTAQUE 3");
      const radarPos = result.indexOf("📡 RADAR");
      const erroPos = result.indexOf("ERRO INTENCIONAL");
      const sortPos = result.indexOf("SORTEIO");
      const encerrarPos = result.indexOf("PARA ENCERRAR");
      assert.ok(d2Pos > 0 && d2Pos < d3Pos, `D2 antes de D3 (d2=${d2Pos} d3=${d3Pos})`);
      assert.ok(d3Pos < eiaPos, "D3 antes de É IA? (#2546)");
      assert.ok(eiaPos < radarPos, "É IA? antes de RADAR (#2546)");
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

  it("#1855: USE MELHOR com tutoriais EN sobrevive ao stitch completo (bug #1851 era na camada do stitch)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Coverage." },
          use_melhor: [
            { title: "How to fine-tune your first model", url: "https://en.com/1", summary: "A step-by-step guide to training and deploying with the new API.", summary_lang: "en" },
            { title: "Build an agent with the new SDK", url: "https://en.com/2", summary: "How to wire the tools end to end.", summary_lang: "en" },
          ],
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
      // A seção NÃO some com tutoriais 100% EN (era o #1851).
      assert.match(result, /🛠️ USE MELHOR/, "USE MELHOR não pode sumir com EN");
      assert.match(result, /https:\/\/en\.com\/1/);
      assert.match(result, /https:\/\/en\.com\/2/);
      // Título EN verbatim, descrição EN com [TRADUZIR].
      assert.match(result, /\*\*\[How to fine-tune your first model\]/);
      assert.match(result, /\[TRADUZIR\] A step-by-step guide/);
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

  // ─── #2355 fix 1: empty D3 file on 3-destaque edition ──────────────────────

  it("#2355 fix 1: D3 vazio (whitespace-only) em edição de 3 destaques → erro, não bloco vazio", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      // D3 exists but is empty (whitespace-only)
      writeFileSync(join(internalDir, "02-d3-draft.md"), "   \n  \t  ");
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
        /02-d3-draft\.md vazio/,
        "D3 vazio (esperado) deve lançar erro explícito",
      );
    } finally {
      cleanup();
    }
  });

  it("#2355 fix 1: edição de 2 destaques (d3Path=null) sem D3 → OK, sem falso erro", () => {
    // Legitimate 2-destaque edition: d3Path=null, no D3 file. Must NOT throw.
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      // No D3 file written — 2-destaque edition
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          highlights: [{ article: { url: "https://a.com", title: "T1" } }, { article: { url: "https://b.com", title: "T2" } }],
          coverage: { line: "c" }, lancamento: [], radar: [],
        }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: null, // 2-destaque: no D3 expected
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      assert.ok(result.length > 0, "resultado não vazio");
      assert.match(result, /D1/);
      assert.match(result, /D2/);
      // D3 block should be absent
      assert.doesNotMatch(result, /D3/);
    } finally {
      cleanup();
    }
  });

  it("#2355 finding 2: D1 vazio (whitespace-only) → erro, não bloco vazio", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "   \n  \t  ");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
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
        /02-d1-draft\.md vazio/,
        "D1 vazio deve lançar erro explícito",
      );
    } finally {
      cleanup();
    }
  });

  it("#2355 finding 2: D2 vazio (whitespace-only) → erro, não bloco vazio", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "   \n  \t  ");
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
        /02-d2-draft\.md vazio/,
        "D2 vazio deve lançar erro explícito",
      );
    } finally {
      cleanup();
    }
  });

  // ─── #2355 fix 2: missing/corrupt approved-capped.json → explicit error ──────

  it("#2355 fix 2: approved-capped.json ausente → erro nomeia o capped JSON (não D3)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      // Do NOT write approved-capped.json
      assert.throws(
        () =>
          stitchNewsletter({
            d1Path: join(internalDir, "02-d1-draft.md"),
            d2Path: join(internalDir, "02-d2-draft.md"),
            d3Path: join(internalDir, "02-d3-draft.md"),
            approvedCappedPath: join(internalDir, "01-approved-capped.json"),
            editionDir: dir,
          }),
        /01-approved-capped\.json/,
        "erro deve mencionar approved-capped.json, não D3",
      );
    } finally {
      cleanup();
    }
  });

  it("#2355 fix 2: stitchNewsletter() com approved-capped.json ausente → erro nomeia capped JSON (não D3)", () => {
    // Validates stitchNewsletter(): missing JSON should not produce "input ausente: 02-d3-draft.md"
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      // No approved-capped.json → should throw naming the capped JSON as the problem
      assert.throws(
        () =>
          stitchNewsletter({
            d1Path: join(internalDir, "02-d1-draft.md"),
            d2Path: join(internalDir, "02-d2-draft.md"),
            d3Path: join(internalDir, "02-d3-draft.md"),
            approvedCappedPath: join(internalDir, "01-approved-capped.json"),
            editionDir: dir,
          }),
        (e: Error) => {
          assert.ok(!/02-d3-draft\.md/.test(e.message), `D3 não deve ser citado; foi: ${e.message}`);
          assert.ok(/01-approved-capped\.json/.test(e.message), `capped JSON deve ser citado; foi: ${e.message}`);
          return true;
        },
      );
    } finally {
      cleanup();
    }
  });

  it("#2355 fix 2: approved-capped.json corrompido (JSON inválido) → erro nomeia capped JSON", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
      writeFileSync(join(internalDir, "01-approved-capped.json"), "{ CORRUPT JSON {{");
      assert.throws(
        () =>
          stitchNewsletter({
            d1Path: join(internalDir, "02-d1-draft.md"),
            d2Path: join(internalDir, "02-d2-draft.md"),
            d3Path: join(internalDir, "02-d3-draft.md"),
            approvedCappedPath: join(internalDir, "01-approved-capped.json"),
            editionDir: dir,
          }),
        /01-approved-capped\.json.*corrompido|corrompido.*01-approved-capped\.json/i,
        "erro deve mencionar capped JSON corrompido",
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
      // 260611: páginas Beehiiv extintas → links fixos apontam pros Workers
      // #3698: e agora pro domínio de marca (era *.diaria.workers.dev).
      assert.match(result, /cursos\.diar\.ia\.br/);
      assert.match(result, /livros\.diar\.ia\.br/);
    } finally {
      cleanup();
    }
  });
});

describe("#3100 — VÍDEO antes de RADAR (ordem canônica permanente, gate 260708)", () => {
  function setupEdition() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-video-radar-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
    writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
    writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("com RADAR e VÍDEO presentes, VÍDEO aparece antes de RADAR no MD final", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Coverage." },
          radar: [{ title: "R1", url: "https://r.com/1", summary: "rdesc" }],
          video: [{ title: "V1", url: "https://v.com/1", summary: "vdesc" }],
        }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      const videoPos = result.indexOf("📺 VÍDEO");
      const radarPos = result.indexOf("📡 RADAR");
      assert.ok(videoPos > 0, "seção VÍDEO deve aparecer");
      assert.ok(radarPos > 0, "seção RADAR deve aparecer");
      assert.ok(videoPos < radarPos, `VÍDEO deve vir antes de RADAR (video=${videoPos} radar=${radarPos})`);
    } finally {
      cleanup();
    }
  });

  it("só RADAR presente (sem VÍDEO) — renderiza normalmente, sem quebrar", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Coverage." },
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
      assert.match(result, /📡 RADAR/);
      assert.doesNotMatch(result, /📺 VÍDEO/);
    } finally {
      cleanup();
    }
  });

  it("só VÍDEO presente (sem RADAR) — renderiza normalmente, sem quebrar", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Coverage." },
          video: [{ title: "V1", url: "https://v.com/1", summary: "vdesc" }],
        }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      assert.match(result, /📺 VÍDEO/);
      assert.doesNotMatch(result, /📡 RADAR/);
    } finally {
      cleanup();
    }
  });
});

describe("#3820 — VÍDEOS antes de LANÇAMENTOS (ordem canônica permanente, decisão editorial 260722)", () => {
  function setupEdition() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-video-lancamentos-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
    writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
    writeFileSync(join(internalDir, "02-d3-draft.md"), "D3");
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("com LANÇAMENTOS e VÍDEO presentes, VÍDEO aparece antes de LANÇAMENTOS no MD final", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Coverage." },
          lancamento: [{ title: "L1", url: "https://l.com/1", summary: "ldesc" }],
          video: [{ title: "V1", url: "https://v.com/1", summary: "vdesc" }],
        }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      const videoPos = result.indexOf("📺 VÍDEO");
      const lancPos = result.indexOf("🚀 LANÇAMENTO");
      assert.ok(videoPos > 0, "seção VÍDEO deve aparecer");
      assert.ok(lancPos > 0, "seção LANÇAMENTOS deve aparecer");
      assert.ok(videoPos < lancPos, `VÍDEO deve vir antes de LANÇAMENTOS (video=${videoPos} lanc=${lancPos})`);
    } finally {
      cleanup();
    }
  });
});

describe("#2978 — boxes_divulgacao config-driven (slot1/slot2)", () => {
  function setupEdition() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-boxes-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(internalDir, "02-d1-draft.md"), "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**T1**](https://e.com/d1)\n\nbody1");
    writeFileSync(join(internalDir, "02-d2-draft.md"), "**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2");
    writeFileSync(join(internalDir, "02-d3-draft.md"), "**DESTAQUE 3 | ⚖️ REGULAÇÃO**\n\n[**T3**](https://e.com/d3)\n\nbody3");
    writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify({ coverage: { line: "cov" } }));
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const base = (dir: string, internalDir: string, extra: Record<string, unknown> = {}) => ({
    d1Path: join(internalDir, "02-d1-draft.md"),
    d2Path: join(internalDir, "02-d2-draft.md"),
    d3Path: join(internalDir, "02-d3-draft.md"),
    approvedCappedPath: join(internalDir, "01-approved-capped.json"),
    editionDir: dir,
    ...extra,
  });

  it("config default do platform.config.json (slot1=recomendacao-leitura, slot2=livros, #3212): injeta os 2 slots", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir));
      const slot1 = extractBoxDivulgacao1(out);
      assert.ok(slot1, "slot1 (recomendação de leitura) injetado por default");
      assert.match(slot1!, /Recomendação de leitura/);
      const slot2 = extractBoxDivulgacao2(out);
      assert.ok(slot2, "slot2 (curadoria de livros) injetado por default");
      assert.match(slot2!, /curadoria de livros/);
    } finally {
      cleanup();
    }
  });

  it("#3306: loadDivulgacaoSnippet aceita formato multi-parágrafo sem bold-wrap total (📖 recomendacao-leitura.md) — antes retornava null e a edição saía sem o box", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir, {
        boxesDivulgacao: { slot1: "recomendacao-leitura.md", slot2: null },
      }));
      const slot1 = extractBoxDivulgacao1(out);
      assert.ok(slot1, "slot1 (📖, formato genérico) injetado, não mais null");
      assert.match(slot1!, /Recomendação de leitura/);
    } finally {
      cleanup();
    }
  });

  it("config custom: slot1 também recebe snippet (Alexa+)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir, {
        boxesDivulgacao: { slot1: "alexa-plus-divulgacao.md", slot2: "livros-divulgacao.md" },
      }));
      const slot1 = extractBoxDivulgacao1(out);
      assert.ok(slot1, "slot1 injetado");
      assert.match(slot1!, /Alexa\+/);
      const slot2 = extractBoxDivulgacao2(out);
      assert.ok(slot2, "slot2 injetado");
      assert.match(slot2!, /curadoria de livros/);
    } finally {
      cleanup();
    }
  });

  it("snippet ausente/null num slot → esse slot fica vazio, sem erro (graceful)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir, {
        boxesDivulgacao: { slot1: null, slot2: null },
      }));
      assert.equal(extractBoxDivulgacao1(out), null);
      assert.equal(extractBoxDivulgacao2(out), null);
    } finally {
      cleanup();
    }
  });

  it("idempotência: box 🛒 já presente na região do slot2 (D2/D3) não é duplo-injetado", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "02-d2-draft.md"),
        "**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2\n\n🛒 Já colado [x](https://link.amazon/x)",
      );
      const out = stitchNewsletter(base(dir, internalDir, {
        boxesDivulgacao: { slot1: null, slot2: "livros-divulgacao.md" },
      }));
      assert.equal((out.match(/🛒/g) || []).length, 1, "só 1 marcador 🛒 (não dupla-injeta)");
      assert.ok(!out.includes("curadoria de livros"), "livros não injetado por cima do box manual");
    } finally {
      cleanup();
    }
  });

  it("sponsor=false suprime AMBOS os slots", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir, {
        sponsor: false,
        boxesDivulgacao: { slot1: "alexa-plus-divulgacao.md", slot2: "livros-divulgacao.md" },
      }));
      assert.equal(extractBoxDivulgacao1(out), null, "slot1 suprimido");
      assert.equal(extractBoxDivulgacao2(out), null, "slot2 suprimido");
    } finally {
      cleanup();
    }
  });

  it("2 destaques (sem D3): slot2 nunca injeta (sem gap D2/D3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stitch-boxes-2d-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**T1**](https://e.com/d1)\n\nbody1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2");
      writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify({ coverage: { line: "cov" }, highlights: [{}, {}] }));
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: null,
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        boxesDivulgacao: { slot1: "alexa-plus-divulgacao.md", slot2: "livros-divulgacao.md" },
      });
      assert.ok(extractBoxDivulgacao1(out), "slot1 (D1/D2) ainda existe em edição de 2 destaques");
      assert.equal(extractBoxDivulgacao2(out), null, "slot2 nunca injeta sem gap D2/D3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#3476 — 3 boxes de divulgação sempre presentes + É IA? depois de USE MELHOR", () => {
  function setupEdition() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-3476-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(internalDir, "02-d1-draft.md"), "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**T1**](https://e.com/d1)\n\nbody1");
    writeFileSync(join(internalDir, "02-d2-draft.md"), "**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2");
    writeFileSync(join(internalDir, "02-d3-draft.md"), "**DESTAQUE 3 | ⚖️ REGULAÇÃO**\n\n[**T3**](https://e.com/d3)\n\nbody3");
    writeFileSync(
      join(internalDir, "01-approved-capped.json"),
      JSON.stringify({
        coverage: { line: "cov" },
        use_melhor: [{ title: "UM1", url: "https://um.com/1", summary: "umdesc" }],
      }),
    );
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const base = (dir: string, internalDir: string, extra: Record<string, unknown> = {}) => ({
    d1Path: join(internalDir, "02-d1-draft.md"),
    d2Path: join(internalDir, "02-d2-draft.md"),
    d3Path: join(internalDir, "02-d3-draft.md"),
    approvedCappedPath: join(internalDir, "01-approved-capped.json"),
    editionDir: dir,
    ...extra,
  });

  it("#3212/#3476: config default de platform.config.json injeta os 3 slots (recomendação de leitura, livros, indicação de ferramenta)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      // Sem override — lê boxes_divulgacao direto de platform.config.json.
      const out = stitchNewsletter(base(dir, internalDir));
      const slot1 = extractBoxDivulgacao1(out);
      assert.ok(slot1, "slot1 (recomendação de leitura) injetado por default");
      assert.match(slot1!, /Recomendação de leitura/);
      const slot2 = extractBoxDivulgacao2(out);
      assert.ok(slot2, "slot2 (curadoria de livros) injetado por default");
      assert.match(slot2!, /curadoria de livros/);
      const slot3 = extractBoxDivulgacao3(out);
      assert.ok(slot3, "slot3 (indicação de ferramenta) injetado por default");
      assert.match(slot3!, /Indicação de ferramenta/);
      assert.match(slot3!, /Não recebi comissão/);
    } finally {
      cleanup();
    }
  });

  it("#3476: box3 posicionado entre D3 e USE MELHOR (não entre D2/D3, não depois de USE MELHOR)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir));
      const d3Pos = out.indexOf("DESTAQUE 3");
      const slot3Pos = out.indexOf("Indicação de ferramenta");
      const umPos = out.indexOf("USE MELHOR");
      assert.ok(slot3Pos > 0, "box3 deveria estar presente");
      assert.ok(
        d3Pos < slot3Pos && slot3Pos < umPos,
        `box3 deve ficar entre D3 (${d3Pos}) e USE MELHOR (${umPos}); achou em ${slot3Pos}`,
      );
    } finally {
      cleanup();
    }
  });

  it("#3476: USE MELHOR renderiza ANTES de É IA? (antes do #3476 era o inverso, #2546)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir));
      const umPos = out.indexOf("USE MELHOR");
      const eiaPos = out.indexOf("É IA?");
      assert.ok(umPos > 0 && eiaPos > 0, "USE MELHOR e É IA? devem estar presentes");
      assert.ok(umPos < eiaPos, `USE MELHOR (${umPos}) deve vir antes de É IA? (${eiaPos})`);
    } finally {
      cleanup();
    }
  });

  it("#3476: sem USE MELHOR na edição, É IA? cai logo após box3 (nunca desaparece)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      // Sobrescreve o approved-capped.json sem use_melhor.
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "cov" } }),
      );
      const out = stitchNewsletter(base(dir, internalDir));
      assert.doesNotMatch(out, /USE MELHOR/);
      const slot3Pos = out.indexOf("Indicação de ferramenta");
      const eiaPos = out.indexOf("É IA?");
      assert.ok(slot3Pos > 0 && eiaPos > 0);
      assert.ok(slot3Pos < eiaPos, "É IA? deve vir logo após box3 quando USE MELHOR está ausente");
    } finally {
      cleanup();
    }
  });

  it("#3476: box3 injeta mesmo em edição de 2 destaques (após D2, diferente do slot2 que exige D3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stitch-3476-2d-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**T1**](https://e.com/d1)\n\nbody1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2");
      writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify({ coverage: { line: "cov" }, highlights: [{}, {}] }));
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: null,
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      const slot3 = extractBoxDivulgacao3(out);
      assert.ok(slot3, "slot3 deve injetar mesmo sem D3 (é pós-último-destaque, não uma lacuna D2/D3)");
      assert.match(slot3!, /Indicação de ferramenta/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("idempotência: box3 já glúado ao fim de D3 não é dupla-injetado", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "02-d3-draft.md"),
        "**DESTAQUE 3 | ⚖️ REGULAÇÃO**\n\n[**T3**](https://e.com/d3)\n\nbody3\n\n**🔧 Já colado. [Ver](https://exemplo.com/ferramenta).**",
      );
      const out = stitchNewsletter(base(dir, internalDir));
      assert.equal((out.match(/🔧/g) || []).length, 1, "só 1 marcador 🔧 (não dupla-injeta)");
      assert.ok(!out.includes("Não recebi comissão"), "não injeta o snippet default por cima do box já colado");
    } finally {
      cleanup();
    }
  });

  it("sponsor=false suprime os 3 slots (não só os 2 antigos)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir, { sponsor: false }));
      assert.equal(extractBoxDivulgacao1(out), null, "slot1 suprimido");
      assert.equal(extractBoxDivulgacao2(out), null, "slot2 suprimido");
      assert.equal(extractBoxDivulgacao3(out), null, "slot3 suprimido");
    } finally {
      cleanup();
    }
  });
});

describe("#1938 — boxDivulgacao1 CLARICE auto-injetado entre D1 e D2", () => {
  function setupEdition() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-clarice-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(internalDir, "02-d1-draft.md"), "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**T1**](https://e.com/d1)\n\nbody1");
    writeFileSync(join(internalDir, "02-d2-draft.md"), "**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2");
    writeFileSync(join(internalDir, "02-d3-draft.md"), "**DESTAQUE 3 | ⚖️ REGULAÇÃO**\n\n[**T3**](https://e.com/d3)\n\nbody3");
    writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify({ coverage: { line: "cov" } }));
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const base = (dir: string, internalDir: string, sponsor?: boolean) => ({
    d1Path: join(internalDir, "02-d1-draft.md"),
    d2Path: join(internalDir, "02-d2-draft.md"),
    d3Path: join(internalDir, "02-d3-draft.md"),
    approvedCappedPath: join(internalDir, "01-approved-capped.json"),
    editionDir: dir,
    sponsor,
  });

  it("loadClariceCallout retorna o bloco **… ** com cupons + link (#3475: sem marcador emoji)", () => {
    const block = loadClariceCallout();
    assert.ok(block, "snippet existe");
    assert.match(block!, /^\*\*\s*Escreva melhor/);
    assert.match(block!, /\*\*$/);
    assert.match(block!, /NEWS25|NEWS50/);
    assert.match(block!, /clarice\.ai\/precos-planos\?via=diaria/);
  });

  it("loadDailyCallout (#2527): retorna o bloco **… ** de curadoria de livros (#3475: sem marcador emoji)", () => {
    const block = loadDailyCallout();
    assert.ok(block, "snippet de livros existe");
    assert.match(block!, /^\*\*\s*A diar\.ia\.br mantém/);
    assert.match(block!, /\*\*$/);
    assert.match(block!, /curadoria de livros/i);
    assert.match(block!, /livros\.diar\.ia\.br/); // #3698: domínio de marca (era livros.diaria.workers.dev)
  });

  it("default (sponsor on, #3212): injeta o callout de recomendação de leitura entre D1 e D2 + extractBoxDivulgacao1 o acha", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir));
      const d1Pos = out.indexOf("DESTAQUE 1");
      const calloutPos = out.indexOf("Recomendação de leitura");
      const d2Pos = out.indexOf("DESTAQUE 2");
      assert.ok(d1Pos < calloutPos && calloutPos < d2Pos, "callout entre D1 e D2");
      // acceptance #3212: slot1 default agora é a recomendação de leitura específica,
      // curadoria geral de livros move pro slot2 — boxDivulgacao1 acha o box no HTML final.
      const mid = extractBoxDivulgacao1(out);
      assert.ok(mid, "extractBoxDivulgacao1 acha o box");
      // 260717: título volta a sair em negrito (bold-wrap kicker, ver
      // context/snippets/recomendacao-leitura.md) — reverte o efeito
      // colateral do #3475 sem detecção por emoji.
      assert.match(mid!, /^\*\*Recomendação de leitura\*\*/);
    } finally {
      cleanup();
    }
  });

  it("sponsor=false (kill-switch): NÃO injeta nenhum dos 2 slots", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir, false));
      assert.ok(!out.includes("Recomendação de leitura"), "sem callout slot1 quando sponsor=false");
      assert.ok(!out.includes("curadoria de livros"), "sem callout slot2 quando sponsor=false");
      assert.equal(extractBoxDivulgacao1(out), null);
    } finally {
      cleanup();
    }
  });

  it("idempotente: D1 já tem **📣 … → não dupla-injeta", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      // editor colou o callout à mão no fim do D1
      writeFileSync(
        join(internalDir, "02-d1-draft.md"),
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**T1**](https://e.com/d1)\n\nbody1\n\n**📣 Já colado [x](https://clarice.ai/precos-planos?via=diaria)**",
      );
      const out = stitchNewsletter(base(dir, internalDir));
      const count = (out.match(/📣/g) || []).length;
      assert.equal(count, 1, "só 1 callout (não dupla-injeta)");
    } finally {
      cleanup();
    }
  });

  it("code-review: callout pré-existente (qualquer conteúdo) também suprime injeção (não cria 2º boxDivulgacao1)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      // um box de livros já colado na região do D1 → NÃO injetar recomendação de
      // leitura por cima (dois midCallouts orfanariam um)
      writeFileSync(
        join(internalDir, "02-d2-draft.md"),
        "**Curadoria de livros [ver](https://livros.diaria.workers.dev)**\n\n**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2",
      );
      const out = stitchNewsletter(base(dir, internalDir));
      assert.ok(!out.includes("Recomendação de leitura"), "não injeta slot1 quando já há box pré-existente");
      // #3212: slot2 (D2/D3) default também é livros agora — o box pré-existente
      // (colado manualmente na região do slot1) NÃO deve duplicar, mas o slot2
      // segue injetando seu próprio box independentemente (posições/gaps diferentes).
      // Total esperado: 1 (pré-existente, slot1 suprimido) + 1 (auto-injetado, slot2) = 2.
      assert.equal((out.match(/curadoria de livros/gi) || []).length, 2);
    } finally {
      cleanup();
    }
  });
});

describe("#3232 — idempotência de boxes_divulgacao marcador-agnóstica (substitui o calloutRe antigo)", () => {
  function setupEdition() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-3232-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(internalDir, "02-d1-draft.md"), "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**T1**](https://e.com/d1)\n\nbody1");
    writeFileSync(join(internalDir, "02-d2-draft.md"), "**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2");
    writeFileSync(join(internalDir, "02-d3-draft.md"), "**DESTAQUE 3 | ⚖️ REGULAÇÃO**\n\n[**T3**](https://e.com/d3)\n\nbody3");
    writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify({ coverage: { line: "cov" } }));
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const base = (dir: string, internalDir: string, extra: Record<string, unknown> = {}) => ({
    d1Path: join(internalDir, "02-d1-draft.md"),
    d2Path: join(internalDir, "02-d2-draft.md"),
    d3Path: join(internalDir, "02-d3-draft.md"),
    approvedCappedPath: join(internalDir, "01-approved-capped.json"),
    editionDir: dir,
    ...extra,
  });

  it("marcador NOVO (🎥, nunca esteve em nenhum allowlist) glúado ao fim de D1 suprime injeção do slot1 — mesma técnica do #3204", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      // editor colou um callout com marcador inédito no fim do próprio draft do D1
      // (sem `---` isolando — caso real 260609, mesma forma que o #3204 corrigiu
      // pro render; aqui é a MESMA forma na camada de stitch/idempotência).
      writeFileSync(
        join(internalDir, "02-d1-draft.md"),
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**T1**](https://e.com/d1)\n\nbody1\n\n**🎥 Já colado, marcador novo. [Assista](https://exemplo.com/v).**",
      );
      const out = stitchNewsletter(base(dir, internalDir));
      // Não deve injetar o snippet default do slot1 (#3212: recomendação de leitura) por cima do box já presente.
      assert.ok(!out.includes("Recomendação de leitura"), "não injeta slot1 por cima de um box com marcador novo já colado");
      const count = (out.match(/🎥/g) || []).length;
      assert.equal(count, 1, "só 1 marcador 🎥 (não dupla-injeta)");
    } finally {
      cleanup();
    }
  });

  it("marcador NOVO (🎥) PREPENDED ao início de D2 (antes do próprio header) também suprime injeção do slot1", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "02-d2-draft.md"),
        "**🎥 Já colado ANTES do header de D2, marcador novo. [Assista](https://exemplo.com/v).**\n\n**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2",
      );
      const out = stitchNewsletter(base(dir, internalDir));
      assert.ok(!out.includes("Recomendação de leitura"), "não injeta slot1 por cima do box com marcador novo prepended a D2");
      assert.equal((out.match(/🎥/g) || []).length, 1, "só 1 marcador 🎥 (não dupla-injeta)");
    } finally {
      cleanup();
    }
  });

  it("box SEM nenhum marcador emoji (texto puro, bold-wrap com link) glúado ao fim de D2 suprime injeção do slot2", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "02-d2-draft.md"),
        "**DESTAQUE 2 | 🔬 PESQUISA**\n\n[**T2**](https://e.com/d2)\n\nbody2\n\n**Recomendação de leitura sem emoji nenhum. [Leia](https://exemplo.com/leitura).**",
      );
      const out = stitchNewsletter(base(dir, internalDir, {
        boxesDivulgacao: { slot1: null, slot2: "livros-divulgacao.md" },
      }));
      assert.ok(!out.includes("curadoria de livros"), "não injeta livros por cima do box sem marcador já colado no slot2");
      assert.equal((out.match(/Recomendação de leitura sem emoji nenhum/g) || []).length, 1, "box original preservado, não duplicado");
    } finally {
      cleanup();
    }
  });

  it("🛒 (carrinho, formato preservado explicitamente — sinal de FORMATO, não de categoria de conteúdo) continua suprimindo injeção", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "02-d1-draft.md"),
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**T1**](https://e.com/d1)\n\nbody1\n\n🛒 Já colado formato carrinho. [Compre](https://exemplo.com/produto).",
      );
      const out = stitchNewsletter(base(dir, internalDir));
      assert.ok(!out.includes("Recomendação de leitura"), "não injeta slot1 por cima do box 🛒 já colado");
      assert.equal((out.match(/🛒/g) || []).length, 1, "só 1 marcador 🛒 (não dupla-injeta)");
    } finally {
      cleanup();
    }
  });

  it("SEM nenhum box pré-existente (marcador nenhum), injeção normal continua funcionando", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      const out = stitchNewsletter(base(dir, internalDir));
      assert.ok(extractBoxDivulgacao1(out), "slot1 injetado normalmente quando não há box pré-existente");
    } finally {
      cleanup();
    }
  });
});

// ─── #2151 — stripHtml: sanitização de HTML cru em campos de texto ────────────

describe("#2151 — stripHtml: sanitiza HTML cru antes do stitch", () => {
  it("caso real 260612: anchor truncada (<a href=...) → sem HTML cru no output", () => {
    // Caso exato do bug: entity extraction capturou início de <a href sem fechar.
    const raw = "Acesse o tutorial <a href=\"https://example.com/tutorial";
    const out = stripHtml(raw);
    // Nenhum `<` solto deve restar
    assert.ok(!out.includes("<"), `sem < solto; got: ${out}`);
    assert.ok(!out.includes(">"), `sem > solto; got: ${out}`);
    // Texto antes da tag deve sobrar
    assert.match(out, /Acesse o tutorial/);
  });

  it("anchor completa → extrai texto interno, descarta markup", () => {
    const raw = 'Clique <a href="https://example.com">aqui</a> para saber mais.';
    const out = stripHtml(raw);
    assert.doesNotMatch(out, /<a/i);
    assert.match(out, /Clique aqui para saber mais\./);
  });

  it("summary limpo → inalterado (sem regressão)", () => {
    const raw = "Pesquisadores apresentaram nova técnica de fine-tuning com 30% menos dados.";
    const out = stripHtml(raw);
    assert.equal(out, raw);
  });

  it("entities HTML comuns → decodificadas corretamente", () => {
    // &nbsp; → ' ', &amp; → '&' — entities sem tags ao redor são decodificadas.
    // &lt;/&gt; ao redor de texto simples (não tag real) → decodificadas para < >
    // (tag-strip roda antes do decode, então <especiais> pós-decode não é retag-strippado — correto).
    const raw = "Texto&nbsp;com&nbsp;espaços &amp; caracteres.";
    const out = stripHtml(raw);
    assert.doesNotMatch(out, /&nbsp;|&amp;/);
    assert.match(out, /Texto com espaços & caracteres\./);
  });

  it("tag bem-formada genérica → removida, texto preservado", () => {
    const raw = "Um <strong>resultado</strong> importante foi publicado.";
    const out = stripHtml(raw);
    assert.doesNotMatch(out, /<strong>|<\/strong>/);
    assert.match(out, /Um resultado importante foi publicado\./);
  });
});

describe("#2151 — renderSection: summary com HTML cru não vaza pro markdown", () => {
  it("anchor truncada no summary → output sem HTML cru", () => {
    const out = renderSection("🛠️", "USE MELHOR", "USE MELHOR", [
      {
        title: "Tutorial de fine-tuning",
        url: "https://example.com/tutorial",
        summary: 'Aprenda a treinar modelos. <a href="https://example.com/deep',
      },
    ]);
    assert.ok(!out.includes("<"), `sem < solto; got: ${out}`);
    assert.match(out, /Aprenda a treinar modelos/);
  });

  it("anchor completa no summary → texto extraído sem markup", () => {
    const out = renderSection("📡", "RADAR", "RADAR", [
      {
        title: "Novo modelo lançado",
        url: "https://example.com/news",
        summary: 'Veja o <a href="https://example.com/full">artigo completo</a> sobre o modelo.',
      },
    ]);
    assert.doesNotMatch(out, /<a/i);
    assert.match(out, /artigo completo/);
  });
});

// ─── #2166 pass2 — 7 bugs no sanitizador corrigidos ──────────────────────────

describe("#2166 pass2 — stripHtml: 7 bugs corrigidos", () => {
  // Finding #1: RangeError crash em code point inválido
  it("finding 1: code point inválido (>0x10FFFF) não crasha — retorna string vazia p/ entidade", () => {
    // &#2000000; está além do máximo Unicode (0x10FFFF = 1114111)
    assert.doesNotThrow(() => stripHtml("foo &#2000000; bar"));
    const out = stripHtml("foo &#2000000; bar");
    assert.doesNotMatch(out, /&#2000000;/, "entidade inválida não deve restar literal");
    assert.match(out, /foo.*bar/, "texto ao redor deve ser preservado");
  });

  it("finding 1b: surrogate solto (&#55296; = U+D800) não crasha", () => {
    assert.doesNotThrow(() => stripHtml("texto &#55296; aqui"));
    const out = stripHtml("texto &#55296; aqui");
    assert.doesNotMatch(out, /&#55296;/, "surrogate não deve restar literal");
  });

  // Finding #2: Double-decode — &amp;lt; não deve virar < final
  it("finding 2: double-encoded &amp;lt; → não vira < após strip", () => {
    // &amp;lt; em texto: se decodificar entities ANTES de strip, vira &lt; → depois <
    // O correto: strip tags ANTES de decode → &amp;lt; sobrevive como texto literal "&lt;"
    // ou é decodificado para "&lt;" sem criar uma tag.
    const out = stripHtml("texto &amp;lt;b&amp;gt; fim");
    // Não deve haver < ou > soltos no output (indicativo de tag que escapou o strip)
    assert.ok(!out.includes("<b>"), `não deve ter tag <b> no output; got: ${out}`);
    // O texto que sobrar pode ter & ou < como caracteres literais — isso é aceitável.
    // O que NÃO pode é ter tags HTML funcionais.
    assert.doesNotMatch(out, /<[a-zA-Z]/, "nenhuma tag HTML deve sobrar");
  });

  it("finding 2b: &amp;amp; sobrevive como & literal (não double-decode)", () => {
    const out = stripHtml("a &amp;amp; b");
    // Deve resultar em "a &amp; b" ou "a & b" — nunca em &amp;&amp; ou crash
    assert.doesNotThrow(() => stripHtml("a &amp;amp; b"));
    assert.ok(out.length > 0, "não deve esvaziar completamente");
  });

  // Finding #3: tag truncada no MEIO da string (bug central do #2151)
  it("finding 3: tag truncada NO MEIO da string é strippada (não só no fim)", () => {
    // Caso real: extração de conteúdo captura meio de tag entre texto
    const raw = "foo <img src='x' bar more text";
    const out = stripHtml(raw);
    assert.ok(!out.includes("<"), `sem < solto no meio; got: ${out}`);
    assert.match(out, /foo/, "texto antes da tag truncada deve sobrar");
    // O texto DEPOIS de uma tag truncada sem fechar pode ser perdido (parte da tag) — ok
  });

  it("finding 3b: múltiplos < soltos ao longo da string", () => {
    const raw = "inicio <div class='x' texto do meio <span foo fim";
    const out = stripHtml(raw);
    assert.ok(!out.includes("<"), `sem < solto; got: ${out}`);
    assert.match(out, /inicio/, "texto inicial deve sobrar");
  });

  // Finding #4: entidades PT-BR acentuadas preservadas, não deletadas
  it("finding 4: &eacute; → é (não deletado)", () => {
    const out = stripHtml("&eacute;");
    assert.equal(out, "é", `&eacute; deve virar é; got: ${out}`);
  });

  it("finding 4b: &ccedil; → ç, &atilde; → ã, &otilde; → õ", () => {
    const out = stripHtml("cora&ccedil;&atilde;o est&atilde;o p&otilde;e");
    assert.match(out, /coração/, `&ccedil;&atilde;o deve virar ção; got: ${out}`);
    assert.match(out, /estão/);
    assert.match(out, /põe/);
  });

  it("finding 4c: todas as entidades PT-BR comuns decodificadas corretamente", () => {
    const cases: [string, string][] = [
      ["&aacute;", "á"],
      ["&agrave;", "à"],
      ["&acirc;", "â"],
      ["&iacute;", "í"],
      ["&oacute;", "ó"],
      ["&uacute;", "ú"],
      ["&uuml;", "ü"],
      ["&hellip;", "…"],
      ["&mdash;", "—"],
      ["&ndash;", "–"],
      ["&rsquo;", "’"],  // RIGHT SINGLE QUOTATION MARK U+2019
      ["&ldquo;", "“"],  // LEFT DOUBLE QUOTATION MARK U+201C
    ];
    for (const [entity, expected] of cases) {
      const out = stripHtml(entity);
      assert.equal(out, expected, `${entity} deve virar ${expected}; got: ${out}`);
    }
  });

  // Finding #5: block elements sem separador → "AB" devia ser "A B"
  it("finding 5: <p>A</p><p>B</p> → 'A B' com espaço entre parágrafos", () => {
    const out = stripHtml("<p>A</p><p>B</p>");
    assert.match(out, /A\s+B/, `parágrafos devem ter espaço; got: "${out}"`);
  });

  it("finding 5b: <br> entre frases → espaço preservado", () => {
    const out = stripHtml("Frase um.<br>Frase dois.");
    assert.match(out, /Frase um\.\s+Frase dois\./, `<br> deve virar espaço; got: "${out}"`);
  });

  it("finding 5c: <div>texto</div> inline → sem colagem de palavras", () => {
    const out = stripHtml("<div>Primeiro</div><div>Segundo</div>");
    assert.match(out, /Primeiro\s+Segundo/, `divs devem ter espaço; got: "${out}"`);
  });

  // Finding #6: entidades hex &#x41; etc
  it("finding 6: &#x41; → 'A' (hex entity decodificada)", () => {
    const out = stripHtml("&#x41;");
    assert.equal(out, "A", `&#x41; deve virar A; got: ${out}`);
  });

  it("finding 6b: &#x00E9; → é (hex PT-BR)", () => {
    const out = stripHtml("&#x00E9;");
    assert.equal(out, "é", `&#x00E9; deve virar é; got: ${out}`);
  });

  it("finding 6c: hex maiúsculo &#X41; → 'A'", () => {
    const out = stripHtml("&#X41;");
    assert.equal(out, "A", `&#X41; deve virar A; got: ${out}`);
  });

  it("finding 6d: hex code point inválido não crasha", () => {
    assert.doesNotThrow(() => stripHtml("&#xD800;"));  // surrogate hex
    assert.doesNotThrow(() => stripHtml("&#x200000;")); // beyond unicode range
  });

  // Finding #7: whitespace collapse incluindo \n\r
  it("finding 7: newlines embutidos em og:description são colapsados para espaço", () => {
    const raw = "Primeira linha\nSegunda linha\r\nTerceira linha";
    const out = stripHtml(raw);
    assert.doesNotMatch(out, /\n|\r/, `newlines devem sumir; got: "${out}"`);
    assert.match(out, /Primeira linha\s+Segunda linha\s+Terceira linha/);
  });

  it("finding 7b: múltiplos espaços/tabs colapsados para espaço único", () => {
    const raw = "texto\t\t\tcom\t   tabs   e   espaços";
    const out = stripHtml(raw);
    assert.doesNotMatch(out, /\t/, "tabs devem sumir");
    assert.doesNotMatch(out, / {2,}/, "múltiplos espaços devem colapsar");
    assert.match(out, /texto com tabs e espaços/);
  });

  // Caso real do #2151 — anchor truncada no MEIO (não no fim)
  it("caso real #2151: anchor truncada NO MEIO + texto depois → sem HTML cru", () => {
    const raw = "Veja mais em <a href='https://site.com/page' class='link' bar more relevant text after";
    const out = stripHtml(raw);
    assert.ok(!out.includes("<"), `sem < solto; got: "${out}"`);
    assert.match(out, /Veja mais em/, "texto antes da tag deve sobrar");
  });
});

// ---------------------------------------------------------------------------
// renderUseMelhorSection (#2447/#2450)
// ---------------------------------------------------------------------------

describe("renderUseMelhorSection (#2447/#2450)", () => {
  it("retorna string vazia para array vazio", () => {
    assert.equal(renderUseMelhorSection([]), "");
  });

  it("injeta estimativa auto '(5 min)' quando summary sem tempo (regressão #2447)", () => {
    // Regressão: edição 260622, itens vieram sem tempo — editor teve que pedir manual.
    // Agora o stitch injeta automaticamente.
    const out = renderUseMelhorSection([
      {
        url: "https://example.com/tutorial",
        title: "Como usar ChatGPT no trabalho",
        summary: "Guia prático para usar ChatGPT no dia a dia",
      },
    ]);
    assert.match(out, /\(5 min\)/, "deve injetar '(5 min)' quando sem tempo");
    assert.ok(!out.includes("— 5 min"), "não deve usar formato dash");
  });

  it("injeta '(15 min)' para tutorial/guia completo (sinal médio)", () => {
    const out = renderUseMelhorSection([
      {
        url: "https://realpython.com/python-tutorial",
        title: "Tutorial passo a passo de Python para iniciantes",
        summary: "Aprenda Python do zero com exemplos práticos.",
      },
    ]);
    assert.match(out, /\(15 min\)/, "deve injetar '(15 min)' para tutorial médio");
  });

  it("NÃO injeta duplicata quando summary já tem '(N min)'", () => {
    const out = renderUseMelhorSection([
      {
        url: "https://example.com/t",
        title: "Tutorial de RAG",
        summary: "Como construir RAG do zero com LangChain (30 min)",
      },
    ]);
    // Deve ter exatamente 1 ocorrência de "(N min)" — não duplicata
    const matches = out.match(/\(\d+\s*min\)/g) ?? [];
    assert.equal(matches.length, 1, `não deve duplicar o tempo; got: ${out}`);
    assert.match(out, /\(30 min\)/, "deve preservar o tempo original do summary");
  });

  it("normaliza '— X min' do summary para '(X min)' (#2450)", () => {
    const out = renderUseMelhorSection([
      {
        url: "https://example.com/guia",
        title: "Guia de Prompt Engineering",
        summary: "Técnicas essenciais de prompt para ChatGPT — 10 min",
      },
    ]);
    assert.match(out, /\(10 min\)/, "deve normalizar '— 10 min' → '(10 min)'");
    assert.ok(!out.includes("— 10 min"), "não deve manter o formato dash");
  });

  it("injeta estimativa mesmo quando summary está em EN marcado [TRADUZIR]", () => {
    const out = renderUseMelhorSection([
      {
        url: "https://cookbook.openai.com/examples/api",
        title: "Getting Started with the OpenAI API",
        summary: "A step-by-step guide to using the OpenAI API for the first time.",
        summary_lang: "en",
      },
    ]);
    // Deve ter [TRADUZIR] E estimativa de tempo
    assert.match(out, /\[TRADUZIR\]/, "deve marcar EN summary com [TRADUZIR]");
    assert.ok(/\(\d+\s*min\)/.test(out), `deve ter estimativa de tempo; got: ${out}`);
  });

  it("injeta '[DESCRIÇÃO PENDENTE] (N min)' quando item sem summary", () => {
    const out = renderUseMelhorSection([
      {
        url: "https://example.com/t",
        title: "Tutorial de RAG",
      },
    ]);
    assert.match(out, /\[DESCRIÇÃO PENDENTE\]/, "deve ter placeholder de descrição");
    assert.ok(/\(\d+\s*min\)/.test(out), `deve ter estimativa mesmo sem summary; got: ${out}`);
  });

  it("header 'USE MELHOR' presente na saída", () => {
    const out = renderUseMelhorSection([
      {
        url: "https://example.com/t",
        title: "Tutorial ChatGPT",
        summary: "Como usar ChatGPT (5 min)",
      },
    ]);
    assert.match(out, /🛠️ USE MELHOR/, "deve ter o header da seção");
  });

  // #2464 finding 3: header órfão quando todos os items são inválidos
  it("#2464 finding 3: retorna string vazia quando TODOS os items são inválidos (sem url/title)", () => {
    // Sem este guard, a função emitia "**🛠️ USE MELHOR**" sem itens abaixo.
    const out = renderUseMelhorSection([
      { summary: "sem url e sem titulo" }, // inválido: sem url
      { url: "https://x.com/t" }, // inválido: sem title
    ] as Parameters<typeof renderUseMelhorSection>[0]);
    assert.equal(out, "", `deve retornar string vazia quando todos inválidos; got: ${JSON.stringify(out)}`);
    assert.ok(!out.includes("USE MELHOR"), "header orphan não deve aparecer quando sem itens válidos");
  });

  // #2464 finding 1 via renderUseMelhorSection: dash-tempo no meio do summary normalizado
  it("#2464 finding 1: dash-tempo no meio do summary é normalizado para '(X min)'", () => {
    const out = renderUseMelhorSection([
      {
        url: "https://example.com/guia",
        title: "Guia de Prompt Engineering",
        // dash-tempo no meio da frase, não no fim
        summary: "Técnicas essenciais — 10 min para iniciantes avançados",
      },
    ]);
    assert.match(out, /\(10 min\)/, "dash-tempo no meio deve ser normalizado para '(10 min)'");
    assert.ok(!out.includes("— 10 min"), "não deve manter o formato dash");
  });
});
