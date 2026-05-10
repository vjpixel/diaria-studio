import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseListItems,
  parseSections,
  parseEIA,
  fallbackEIA,
  renderHTML,
  renderEiaStandalone,
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

describe("parseListItems (#599 — inline link)", () => {
  it("extrai title+url de `[Título](URL)` na primeira linha do bloco", () => {
    const text = [
      "[GPT-5 lançado](https://openai.com/gpt5)",
      "OpenAI anuncia modelo mais avançado.",
      "",
      "[DeepSeek v4 disponível](https://deepseek.com/v4)",
      "Open-source com benchmark superior.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "GPT-5 lançado");
    assert.equal(items[0].url, "https://openai.com/gpt5");
    assert.equal(items[0].description, "OpenAI anuncia modelo mais avançado.");
    assert.equal(items[1].title, "DeepSeek v4 disponível");
    assert.equal(items[1].url, "https://deepseek.com/v4");
  });

  it("bloco de inline link sem descrição retorna description vazio", () => {
    const text = "[Título](https://example.com)";
    const items = parseListItems(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Título");
    assert.equal(items[0].url, "https://example.com");
    assert.equal(items[0].description, "");
  });

  it("mistura de formato inline e legacy no mesmo texto", () => {
    const text = [
      "[Item novo](https://a.com)",
      "Descrição inline.",
      "",
      "Item legacy",
      "https://b.com",
      "Descrição legacy.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].url, "https://a.com");
    assert.equal(items[1].url, "https://b.com");
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

describe("parseEIA (#192 — frontmatter + runtime detection)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eia-parse-"));
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
      const eia = parseEIA(md, dir);
      assert.equal(eia.imageA, "01-eia-A.jpg");
      assert.equal(eia.imageB, "01-eia-B.jpg");
      assert.match(eia.credit, /Credit line/);
      // Frontmatter NÃO entra no credit (escondido do leitor)
      assert.ok(!eia.credit.includes("eia_answer"));
      assert.ok(!eia.credit.includes("real"));
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
      const eia = parseEIA(md, dir);
      assert.equal(eia.imageA, "01-eia-real.jpg");
      assert.equal(eia.imageB, "01-eia-ia.jpg");
      assert.match(eia.credit, /Legacy credit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("md sem frontmatter funciona (edições antigas)", () => {
    const dir = makeDir();
    try {
      const md = "É IA?\n\nNo frontmatter here.\n";
      const eia = parseEIA(md, dir);
      assert.match(eia.credit, /No frontmatter/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filtra linha 'É IA?' do credit", () => {
    const dir = makeDir();
    try {
      const md = "É IA?\n\nApenas o crédito.\n";
      const eia = parseEIA(md, dir);
      assert.equal(eia.credit, "Apenas o crédito.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fallbackEIA (#192)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eia-fallback-"));
  }

  function touch(path: string): void {
    writeFileSync(path, "x");
  }

  it("retorna A/B quando ambos existem", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      const eia = fallbackEIA(dir);
      assert.equal(eia.imageA, "01-eia-A.jpg");
      assert.equal(eia.imageB, "01-eia-B.jpg");
      assert.equal(eia.credit, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna legacy real/ia como fallback default", () => {
    const dir = makeDir();
    try {
      // dir vazio
      const eia = fallbackEIA(dir);
      assert.equal(eia.imageA, "01-eia-real.jpg");
      assert.equal(eia.imageB, "01-eia-ia.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseEIA prevResultLine (#107)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eia-prev-"));
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
      const eia = parseEIA(md, dir);
      assert.match(eia.credit, /Foto da paisagem/);
      assert.ok(
        !eia.credit.includes("Resultado da última edição"),
        "credit não pode conter a linha de resultado",
      );
      assert.equal(
        eia.prevResultLine,
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
      const eia = parseEIA(md, dir);
      assert.equal(eia.prevResultLine, undefined);
      assert.match(eia.credit, /Foto sem result line/);
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
      const eia = parseEIA(md, dir);
      assert.match(
        eia.prevResultLine ?? "",
        /resultado da última edição: 0%/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("E2E: md gerado por buildEiaMd com prevResultLine roundtrip via parseEIA", async () => {
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
      const eia = parseEIA(md, dir);
      assert.equal(
        eia.prevResultLine,
        "Resultado da última edição: 42% das pessoas acertaram.",
      );
      assert.equal(eia.credit, "Crédito da foto.");
      assert.equal(eia.imageA, "01-eia-A.jpg");
      assert.equal(eia.imageB, "01-eia-B.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── #1046 — paste híbrido: split body/È IA? ──

describe("renderHTML excludeEia + renderEiaStandalone (#1046)", () => {
  // Fixture mínima reusada — destaques sem È IA? configurada e com.
  // RenderDestaque extends Destaque (de extract-destaques) com `emoji` + `imageFile`.
  const baseDestaque = {
    n: 1 as const,
    category: "RISCO",
    title: "Modelos se replicam sozinhos",
    body: "Parágrafo 1.\nParágrafo 2.",
    why: "Por que importa.",
    url: "https://example.com/d1",
    emoji: "⚠️",
    imageFile: "04-d1-2x1.jpg",
  };
  const fixtureSemEia = {
    title: "Edição teste",
    subtitle: "Teste sem È IA?",
    coverImage: "04-d1-2x1.jpg",
    destaques: [baseDestaque],
    eia: { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260999" },
    sections: [],
  };

  const fixtureComEia = {
    ...fixtureSemEia,
    eia: {
      credit: "Foto: Author / CC BY-SA 4.0.",
      imageA: "01-eia-A.jpg",
      imageB: "01-eia-B.jpg",
      edition: "260999",
    },
  };

  it("renderHTML default: inclui È IA? quando eia.credit não-vazio", () => {
    const html = renderHTML(fixtureComEia);
    assert.match(html, /É IA\?/);
    assert.match(html, /\{\{poll_a_url\}\}/);
    assert.match(html, /\{\{poll_b_url\}\}/);
  });

  it("renderHTML excludeEia=true: omite seção È IA? mesmo quando configurada", () => {
    const html = renderHTML(fixtureComEia, { excludeEia: true });
    assert.ok(!html.includes("É IA?"), "body não deve mencionar È IA?");
    assert.ok(!html.includes("{{poll_a_url}}"), "body não deve ter merge tags");
    assert.ok(!html.includes("{{poll_b_url}}"));
    // Mas deve ter o destaque
    assert.match(html, /Modelos se replicam/);
  });

  it("renderHTML excludeEia=true sem eia configurada: idêntico ao default", () => {
    const a = renderHTML(fixtureSemEia, { excludeEia: true });
    const b = renderHTML(fixtureSemEia);
    assert.equal(a, b, "sem È IA? configurada, excludeEia é no-op");
  });

  it("renderEiaStandalone retorna null quando eia.credit vazio", () => {
    assert.equal(renderEiaStandalone(fixtureSemEia), null);
  });

  it("renderEiaStandalone retorna HTML com merge tags preservadas", () => {
    const html = renderEiaStandalone(fixtureComEia);
    assert.ok(html, "deve retornar HTML não-null pra eia configurada");
    assert.match(html!, /\{\{poll_a_url\}\}/);
    assert.match(html!, /\{\{poll_b_url\}\}/);
    assert.match(html!, /É IA\?/);
  });

  it("renderEiaStandalone wrap em outer table própria (paste-ready)", () => {
    const html = renderEiaStandalone(fixtureComEia);
    // Deve começar com comment header + abrir <table> próprio
    assert.match(html!, /^<!-- Diar\.ia È IA\? section/);
    assert.match(html!, /<table role="none"[^>]*>/);
    assert.match(html!, /<\/table>$/);
  });

  it("split: body + standalone juntos têm os mesmos destaques que renderHTML default", () => {
    // Soma das partes ≈ todo: garantia que split não perde conteúdo.
    const fullDefault = renderHTML(fixtureComEia);
    const body = renderHTML(fixtureComEia, { excludeEia: true });
    const eia = renderEiaStandalone(fixtureComEia);
    // Destaque presente em body
    assert.match(body, /Modelos se replicam/);
    // È IA? credit presente em eia standalone
    assert.match(eia!, /Foto: Author/);
    // Default tem ambos, body só destaque, eia só È IA?
    assert.match(fullDefault, /Modelos se replicam/);
    assert.match(fullDefault, /Foto: Author/);
  });

  it("split: tamanhos somados ficam dentro dos limites do paste híbrido", () => {
    // Limite spike: body via ClipboardEvent ~25KB OK, È IA? via insertContent ~10KB OK.
    const body = renderHTML(fixtureComEia, { excludeEia: true });
    const eia = renderEiaStandalone(fixtureComEia)!;
    assert.ok(body.length < 25_000, `body ${body.length} bytes < 25KB`);
    assert.ok(eia.length < 10_000, `eia ${eia.length} bytes < 10KB`);
  });
});
