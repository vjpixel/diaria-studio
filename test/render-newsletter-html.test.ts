import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseListItems,
  parseSections,
  parseEAI,
  fallbackEAI,
} from "../scripts/render-newsletter-html.ts";

describe("parseListItems (#172)", () => {
  it("formato novo: Título / URL / Descrição", () => {
    const text = [
      "Item Um",
      "https://example.com/1",
      "Descrição do item um.",
      "",
      "Item Dois",
      "https://example.com/2",
      "Descrição do item dois.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Item Um");
    assert.equal(items[0].url, "https://example.com/1");
    assert.equal(items[0].description, "Descrição do item um.");
    assert.equal(items[1].title, "Item Dois");
    assert.equal(items[1].url, "https://example.com/2");
    assert.equal(items[1].description, "Descrição do item dois.");
  });

  it("formato legacy: Título / Descrição / URL (compat)", () => {
    const text = [
      "Item Um",
      "Descrição do item um.",
      "https://example.com/1",
      "",
      "Item Dois",
      "Descrição do item dois.",
      "https://example.com/2",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Item Um");
    assert.equal(items[0].url, "https://example.com/1");
    assert.equal(items[0].description, "Descrição do item um.");
    assert.equal(items[1].title, "Item Dois");
    assert.equal(items[1].url, "https://example.com/2");
    assert.equal(items[1].description, "Descrição do item dois.");
  });

  it("item sem descrição (formato novo, só título + URL)", () => {
    const text = [
      "Item curto",
      "https://example.com/x",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Item curto");
    assert.equal(items[0].url, "https://example.com/x");
    assert.equal(items[0].description, "");
  });

  it("item sem URL: descrição vazia, URL vazio", () => {
    const text = [
      "Título sem link",
      "Descrição sem link.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Título sem link");
    assert.equal(items[0].url, "");
    assert.equal(items[0].description, "Descrição sem link.");
  });

  it("descrição em múltiplas linhas é concatenada com espaço", () => {
    const text = [
      "Título",
      "https://example.com/x",
      "Linha 1 da descrição.",
      "Linha 2 da descrição.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 1);
    assert.equal(
      items[0].description,
      "Linha 1 da descrição. Linha 2 da descrição.",
    );
  });

  it("M1: 2 items colapsados num único bloco (sem blank) viram 2 items", () => {
    const text = [
      "Item Um",
      "https://example.com/1",
      "Descrição do item um.",
      "Item Dois",
      "https://example.com/2",
      "Descrição do item dois.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Item Um");
    assert.equal(items[0].url, "https://example.com/1");
    assert.equal(items[1].title, "Item Dois");
    assert.equal(items[1].url, "https://example.com/2");
  });

  it("M1: 3 items legacy colapsados (Título/Desc/URL × 3 sem blanks)", () => {
    const text = [
      "Item Um",
      "Descrição um.",
      "https://example.com/1",
      "Item Dois",
      "Descrição dois.",
      "https://example.com/2",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].url, "https://example.com/1");
    assert.equal(items[1].url, "https://example.com/2");
  });
});

describe("parseSections (#172)", () => {
  it("parseia múltiplas seções com formato novo", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título d1",
      "https://destaque.com/d1",
      "",
      "Corpo do destaque.",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item lançamento",
      "https://lancamento.com/x",
      "Descrição do lançamento.",
      "",
      "---",
      "",
      "PESQUISAS",
      "Paper interessante",
      "https://arxiv.org/abs/1234.5678",
      "Resumo da pesquisa.",
      "",
      "---",
      "",
      "OUTRAS NOTÍCIAS",
      "Notícia genérica",
      "https://news.com/x",
      "Resumo da notícia.",
    ].join("\n");

    const sections = parseSections(md);
    assert.equal(sections.length, 3);
    assert.equal(sections[0].name, "LANÇAMENTOS");
    assert.equal(sections[0].items.length, 1);
    assert.equal(sections[0].items[0].title, "Item lançamento");
    assert.equal(sections[0].items[0].url, "https://lancamento.com/x");
    assert.equal(sections[0].items[0].description, "Descrição do lançamento.");
    assert.equal(sections[1].name, "PESQUISAS");
    assert.equal(sections[2].name, "OUTRAS NOTÍCIAS");
  });
});

describe("parseEAI (#192 — frontmatter + runtime detection)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eai-parse-"));
  }

  function touch(path: string): void {
    writeFileSync(path, "x");
  }

  it("parseia frontmatter YAML e detecta A/B em disco", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      const md = [
        "---",
        "eia_answer:",
        "  A: real",
        "  B: ia",
        "---",
        "",
        "É IA?",
        "",
        "Credit line com [link](https://x.com).",
        "",
      ].join("\n");
      const eai = parseEAI(md, dir);
      assert.equal(eai.imageA, "01-eia-A.jpg");
      assert.equal(eai.imageB, "01-eia-B.jpg");
      assert.match(eai.credit, /Credit line/);
      // Frontmatter NÃO entra no credit (escondido do leitor)
      assert.ok(!eai.credit.includes("eia_answer"));
      assert.ok(!eai.credit.includes("real"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fallback para legacy real/ia quando A/B não existem em disco", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-real.jpg"));
      touch(join(dir, "01-eia-ia.jpg"));
      const md = "É IA?\n\nLegacy credit.\n";
      const eai = parseEAI(md, dir);
      assert.equal(eai.imageA, "01-eia-real.jpg");
      assert.equal(eai.imageB, "01-eia-ia.jpg");
      assert.match(eai.credit, /Legacy credit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("md sem frontmatter funciona (edições antigas)", () => {
    const dir = makeDir();
    try {
      const md = "É IA?\n\nNo frontmatter here.\n";
      const eai = parseEAI(md, dir);
      assert.match(eai.credit, /No frontmatter/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filtra linha 'É IA?' do credit", () => {
    const dir = makeDir();
    try {
      const md = "É IA?\n\nApenas o crédito.\n";
      const eai = parseEAI(md, dir);
      assert.equal(eai.credit, "Apenas o crédito.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fallbackEAI (#192)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eai-fallback-"));
  }

  function touch(path: string): void {
    writeFileSync(path, "x");
  }

  it("retorna A/B quando ambos existem", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      const eai = fallbackEAI(dir);
      assert.equal(eai.imageA, "01-eia-A.jpg");
      assert.equal(eai.imageB, "01-eia-B.jpg");
      assert.equal(eai.credit, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna legacy real/ia como fallback default", () => {
    const dir = makeDir();
    try {
      // dir vazio
      const eai = fallbackEAI(dir);
      assert.equal(eai.imageA, "01-eia-real.jpg");
      assert.equal(eai.imageB, "01-eia-ia.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseEAI prevResultLine (#107)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eai-prev-"));
  }

  function touch(path: string): void {
    writeFileSync(path, "x");
  }

  it("separa a linha 'Resultado da última edição:' do crédito", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      const md = [
        "---",
        "eia_answer:",
        "  A: real",
        "  B: ia",
        "---",
        "",
        "É IA?",
        "",
        "Foto da paisagem — [Author](https://x.com/u) / CC BY-SA 4.0.",
        "",
        "Resultado da última edição: 85% das pessoas acertaram.",
        "",
      ].join("\n");
      const eai = parseEAI(md, dir);
      assert.match(eai.credit, /Foto da paisagem/);
      assert.ok(
        !eai.credit.includes("Resultado da última edição"),
        "credit não pode conter a linha de resultado",
      );
      assert.equal(
        eai.prevResultLine,
        "Resultado da última edição: 85% das pessoas acertaram.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prevResultLine fica undefined quando o md não tem a linha", () => {
    const dir = makeDir();
    try {
      const md = "É IA?\n\nFoto sem result line.\n";
      const eai = parseEAI(md, dir);
      assert.equal(eai.prevResultLine, undefined);
      assert.match(eai.credit, /Foto sem result line/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regex case-insensitive (tolera variação 'Resultado' vs 'resultado')", () => {
    const dir = makeDir();
    try {
      const md = [
        "É IA?",
        "",
        "Foto.",
        "",
        "resultado da última edição: 0% das pessoas acertaram.",
        "",
      ].join("\n");
      const eai = parseEAI(md, dir);
      assert.match(
        eai.prevResultLine ?? "",
        /resultado da última edição: 0%/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("E2E: md gerado por buildEiaMd com prevResultLine roundtrip via parseEAI", async () => {
    // Simula o fluxo completo: eia-compose escreve, render-newsletter-html lê.
    // Garante que o contrato writer↔reader não quebra silenciosamente.
    const { buildEiaMd } = await import("../scripts/eia-compose.ts");
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      const md = buildEiaMd(
        { realSide: "A", aiSide: "B" },
        "Crédito da foto.",
        "Resultado da última edição: 42% das pessoas acertaram.",
      );
      const eai = parseEAI(md, dir);
      assert.equal(
        eai.prevResultLine,
        "Resultado da última edição: 42% das pessoas acertaram.",
      );
      assert.equal(eai.credit, "Crédito da foto.");
      assert.equal(eai.imageA, "01-eia-A.jpg");
      assert.equal(eai.imageB, "01-eia-B.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
