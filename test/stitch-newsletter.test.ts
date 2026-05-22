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

  it("formato canonical: [**title**](url) + summary linha abaixo", () => {
    const out = renderSection("📰", "OUTRA NOTÍCIA", "OUTRAS NOTÍCIAS", [
      { title: "Notícia X", url: "https://example.com/n1", summary: "Desc da N1." },
    ]);
    assert.match(out, /\[\*\*Notícia X\*\*\]\(https:\/\/example\.com\/n1\)/);
    assert.match(out, /Desc da N1\./);
  });

  it("skip items sem URL ou title", () => {
    const out = renderSection("🚀", "LANÇAMENTO", "LANÇAMENTOS", [
      { title: "OK", url: "https://x.com/y", summary: "s" },
      { title: "" } as { title: string }, // no URL
      { url: "https://no-title.com" } as { url: string }, // no title
    ]);
    assert.match(out, /\[\*\*OK\*\*\]/);
    assert.doesNotMatch(out, /no-title\.com/);
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
          pesquisa: [
            { title: "P1", url: "https://p.com/1", summary: "p1desc" },
            { title: "P2", url: "https://p.com/2", summary: "p2desc" },
          ],
          noticias: [{ title: "N1", url: "https://n.com/1", summary: "ndesc" }],
        }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      // Ordem canonical: coverage > D1 > D2 > É IA? > D3 > LANÇAMENTOS > PESQUISAS > OUTRAS > ERRO > SORTEIO > PARA ENCERRAR
      assert.match(result, /enviei 5 e a Diar\.ia 100/);
      const d1Pos = result.indexOf("DESTAQUE 1");
      const d2Pos = result.indexOf("DESTAQUE 2");
      const eiaPos = result.indexOf("É IA?");
      const d3Pos = result.indexOf("DESTAQUE 3");
      const lancPos = result.indexOf("🚀 LANÇAMENTO");
      const pesqPos = result.indexOf("PESQUISAS");
      const notPos = result.indexOf("OUTRA NOTÍCIA");
      const erroPos = result.indexOf("ERRO INTENCIONAL");
      const sortPos = result.indexOf("SORTEIO");
      const encerrarPos = result.indexOf("PARA ENCERRAR");
      // Skip d1Pos check — "DESTAQUE 1" aparece no 🚀 LANÇAMENTO header também
      assert.ok(d2Pos > 0 && d2Pos < eiaPos, `D2 antes de É IA? (d2=${d2Pos} eia=${eiaPos})`);
      assert.ok(eiaPos < d3Pos, "É IA? antes de D3");
      assert.ok(d3Pos < pesqPos, "D3 antes de PESQUISAS");
      assert.ok(pesqPos < notPos, "PESQUISAS antes de OUTRA NOTÍCIA");
      assert.ok(notPos < erroPos, "OUTRA antes de ERRO");
      assert.ok(erroPos < sortPos, "ERRO antes de SORTEIO");
      assert.ok(sortPos < encerrarPos, "SORTEIO antes de PARA ENCERRAR");
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
          pesquisa: [{ title: "P", url: "https://p.com", summary: "x" }],
          noticias: [],
        }),
      );
      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });
      assert.doesNotMatch(result, /LANÇAMENTOS|LANÇAMENTO/);
      assert.match(result, /PESQUISA/);
      assert.doesNotMatch(result, /OUTRA NOTÍCIA|OUTRAS NOTÍCIAS/);
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
        JSON.stringify({ coverage: { line: "c" }, lancamento: [], pesquisa: [], noticias: [] }),
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
        JSON.stringify({ coverage: { line: "c" }, lancamento: [], pesquisa: [], noticias: [] }),
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
        JSON.stringify({ coverage: { line: "c" }, lancamento: [], pesquisa: [], noticias: [] }),
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
        JSON.stringify({ coverage: { line: "c" }, lancamento: [], pesquisa: [], noticias: [] }),
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
