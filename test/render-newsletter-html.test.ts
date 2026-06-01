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
  extractTemplateBlock,
  extractCoverageLine,
  renderCoverage,
  unescapeMd,
  processInlineItalics,
  processInlineLinks,
  truncateAtSectionTerminator,
  joinMultilineLinks,
  singularizeSectionName,
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

describe("parseListItems (#1581 — Drive round-trip flattens title+summary)", () => {
  // Caso 260529: Drive pull reformata `**[Title](url)**  \nsummary` pra
  // `[**Title**](url) summary` (link wraps bold, summary inline mesma linha).
  // Pré-fix: parseInlineLink rejeita (texto após o link), fallback de URL-line
  // não encontra URL no início da linha → item com title=linha-bruta, url="",
  // que renderizava markdown raw em <p> no HTML.

  it("extrai title + url + summary quando inline na mesma linha", () => {
    const text =
      "[**NVIDIA Research avança robótica**](https://blogs.nvidia.com/x) " +
      "Robótica entra em nova fase: demos para produção real.";
    const items = parseListItems(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "NVIDIA Research avança robótica");
    assert.equal(items[0].url, "https://blogs.nvidia.com/x");
    assert.match(items[0].description, /^Robótica entra em nova fase/);
  });

  it("múltiplos items inline separados por blank lines", () => {
    const text = [
      "[**Paper 1**](https://arxiv.org/abs/1) Resumo do paper 1.",
      "",
      "[**Paper 2**](https://arxiv.org/abs/2) Resumo do paper 2.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Paper 1");
    assert.equal(items[0].description, "Resumo do paper 1.");
    assert.equal(items[1].title, "Paper 2");
    assert.equal(items[1].description, "Resumo do paper 2.");
  });

  it("formato mixed: alguns items com line break, outros inline (mesma seção)", () => {
    const text = [
      "[**Inline**](https://a.com) Summary inline.",
      "",
      "[**Com Linebreak**](https://b.com)",
      "Summary em linha separada.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].url, "https://a.com");
    assert.equal(items[0].description, "Summary inline.");
    assert.equal(items[1].url, "https://b.com");
    assert.equal(items[1].description, "Summary em linha separada.");
  });

  it("inline title + trailing + linhas adicionais junta tudo na description", () => {
    const text = [
      "[**Título**](https://x.com) Frase 1.",
      "Frase 2 em linha separada.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Título");
    assert.equal(items[0].description, "Frase 1. Frase 2 em linha separada.");
  });

  it("multi-items colapsados num bloco: M1 handler ainda vence sobre trailing", () => {
    // Regression guard: o branch parseInlineLinkWithTrailing roda antes do
    // M1 multi-URL handler, mas só quando block.slice(1) não tem outros
    // markdown links. Bloco com >1 link → M1 handler continua acessível.
    const text = [
      "[**Item A**](https://a.com) desc A",
      "[**Item B**](https://b.com)",
      "desc B",
    ].join("\n");
    const items = parseListItems(text);
    // Esperado: M1 handler / fallback detecta múltiplos URLs e quebra em
    // items separados (não engole tudo na description de A).
    assert.ok(items.length >= 2, `esperava >=2 items, got ${items.length}: ${JSON.stringify(items)}`);
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

  // #1363: parseSections deveria aceitar headers com emoji prefix e singular
  it("parseSections aceita **🚀 LANÇAMENTO** (emoji + singular) — #1363", () => {
    const md = [
      "**🚀 LANÇAMENTO**",
      "Item único",
      "https://x.com/y",
      "Descrição.",
      "",
      "---",
      "",
      "**📰 OUTRAS NOTÍCIAS**",
      "Notícia 1",
      "https://news.com/1",
      "Resumo 1.",
    ].join("\n");

    const sections = parseSections(md);
    assert.equal(sections.length, 2, JSON.stringify(sections));
    assert.equal(sections[0].name, "LANÇAMENTOS"); // normalized to plural
    assert.equal(sections[0].items.length, 1);
    assert.equal(sections[0].items[0].title, "Item único");
    assert.equal(sections[1].name, "OUTRAS NOTÍCIAS");
  });

  it("parseSections aceita variantes: **LANÇAMENTO**, NOTÍCIA, PESQUISA singular — #1363", () => {
    const md = [
      "**LANÇAMENTO**",
      "Lan único",
      "https://x.com/y",
      "Desc.",
      "",
      "---",
      "",
      "PESQUISA",
      "Pesq única",
      "https://arxiv.org/abs/1",
      "Resumo.",
    ].join("\n");

    const sections = parseSections(md);
    assert.equal(sections.length, 2, JSON.stringify(sections));
    assert.equal(sections[0].name, "LANÇAMENTOS");
    assert.equal(sections[1].name, "PESQUISAS");
  });

  // #1674: seção VÍDEOS era dropada silenciosamente — SECTION_HEADER_RE não
  // tinha VÍDEO(S) no grupo de captura. Mesma classe da falha 260519.
  it("parseSections preserva **📺 VÍDEOS** (não dropa) — #1674", () => {
    const md = [
      "**🚀 LANÇAMENTOS**",
      "Lan",
      "https://x.com/y",
      "Desc.",
      "",
      "---",
      "",
      "**📺 VÍDEOS**",
      "Canal explica o modelo novo",
      "https://youtube.com/watch?v=abc",
      "Resumo do vídeo.",
    ].join("\n");

    const sections = parseSections(md);
    assert.equal(sections.length, 2, JSON.stringify(sections));
    assert.equal(sections[1].name, "VÍDEOS");
    assert.equal(sections[1].emoji, "📺"); // do mapa canônico, não fallback 📰
    assert.equal(sections[1].items.length, 1);
    assert.equal(sections[1].items[0].title, "Canal explica o modelo novo");
  });

  it("parseSections aceita **📺 VÍDEO** singular → normaliza pra VÍDEOS — #1674", () => {
    const md = ["**📺 VÍDEO**", "Único", "https://youtube.com/watch?v=z", "Resumo."].join("\n");
    const sections = parseSections(md);
    assert.equal(sections.length, 1, JSON.stringify(sections));
    assert.equal(sections[0].name, "VÍDEOS");
    assert.equal(sections[0].emoji, "📺");
  });

  // #1689 review: header com trailing whitespace (editor/copy-paste) não pode
  // dropar a seção. O `\s*$` no SECTION_HEADER_RE tolera o espaço.
  it("parseSections tolera trailing whitespace no header — #1689", () => {
    const md = ["**📺 VÍDEOS** ", "Canal", "https://youtube.com/watch?v=ws", "Resumo."].join("\n");
    const sections = parseSections(md);
    assert.equal(sections.length, 1, JSON.stringify(sections));
    assert.equal(sections[0].name, "VÍDEOS");
    assert.equal(sections[0].items.length, 1);
  });

  // #1689 review: o `V[ÍI]DEOS?` aceita header SEM acento (compat teclado/OS,
  // espelho do C/Ç em LANÇAMENTOS). Comportamento by-design: a seção é
  // RECONHECIDA (não dropada) — degrada graceful pro emoji fallback 📰 porque o
  // SECTION_EMOJI_MAP só tem chaves acentuadas. Reconhecer-e-degradar > sumir.
  it("parseSections reconhece VIDEOS sem acento (degrada pra 📰, não dropa) — #1689", () => {
    const md = ["**VIDEOS**", "Canal", "https://youtube.com/watch?v=na", "Resumo."].join("\n");
    const sections = parseSections(md);
    assert.equal(sections.length, 1, JSON.stringify(sections)); // NÃO dropada
    assert.equal(sections[0].emoji, "📰"); // fallback graceful (sem acento → sem 📺)
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

  it("#1100: filtra linha '**É IA?**' (formato em negrito) do credit", () => {
    const dir = makeDir();
    try {
      const md = "**É IA?**\n\nApenas o crédito em bold.\n";
      const eia = parseEIA(md, dir);
      assert.equal(eia.credit, "Apenas o crédito em bold.");
      // Regression: o header em negrito NÃO deve vazar pro crédito
      assert.ok(!eia.credit.includes("**"), "credit não pode conter marcação de bold do header");
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
    // #1083: merge tags Beehiiv inline (substitui {{poll_X_url}} legacy)
    assert.match(html, /\{\{email\}\}/);
    assert.match(html, /\{\{poll_sig\}\}/);
  });

  it("renderHTML excludeEia=true: omite seção È IA? mesmo quando configurada", () => {
    const html = renderHTML(fixtureComEia, { excludeEia: true });
    assert.ok(!html.includes("É IA?"), "body não deve mencionar È IA?");
    assert.ok(!html.includes("{{email}}"), "body não deve ter merge tags Beehiiv");
    assert.ok(!html.includes("{{poll_sig}}"));
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
    // #1083: merge tags Beehiiv inline (substitui {{poll_X_url}} legacy)
    assert.match(html!, /\{\{email\}\}/);
    assert.match(html!, /\{\{poll_sig\}\}/);
    assert.match(html!, /É IA\?/);
  });

  it("renderEiaStandalone wrap em outer table própria (paste-ready)", () => {
    const html = renderEiaStandalone(fixtureComEia);
    // Deve começar com comment header + abrir <table> próprio
    assert.match(html!, /^<!-- Diar\.ia È IA\? section/);
    assert.match(html!, /<table role="none"[^>]*>/);
    assert.match(html!, /<\/table>$/);
  });

  it("#1422: caption do POTD em font-style:italic (legenda de foto)", () => {
    const html = renderHTML(fixtureComEia);
    // Localiza o <p> que envolve o credit ("Foto: Author / CC BY-SA 4.0.") e
    // valida que o style attribute inclui font-style:italic. Não pode validar
    // só substring "font-style:italic" no HTML inteiro porque renderImage
    // (line 662) já injeta italic em captions de destaques.
    const creditMatch = html.match(/<p style="([^"]+)">Foto: Author[^<]*<\/p>/);
    assert.ok(creditMatch, "credit <p> deve existir no HTML renderizado");
    assert.match(creditMatch![1], /font-style:italic/, "caption do POTD precisa de italic");
  });

  it("#1422: leaderboard row NÃO é italicizada (semântica de label, não caption)", () => {
    const fixtureWithLeaderboard = {
      ...fixtureComEia,
      eia: {
        ...fixtureComEia.eia,
        leaderboardPeriod: "Maio",
        leaderboardPodium: [
          { nickname: "Davyd Wilkerson", rank: 1 },
          { nickname: "Luisao P", rank: 2 },
        ],
      },
    };
    const html = renderHTML(fixtureWithLeaderboard);
    // Linha "🏆 Vencedores de Maio: 1º Davyd Wilkerson, 2º Luisao P" não pode ter italic.
    const leaderboardMatch = html.match(/<p style="([^"]+)">🏆 <strong>Vencedores/);
    assert.ok(leaderboardMatch, "leaderboard <p> deve existir");
    assert.ok(
      !/font-style:italic/.test(leaderboardMatch![1]),
      "leaderboard não pode ser italic — só caption do POTD"
    );
  });

  it("#1630: renderHTML emite a linha 'Resultado da última edição: X%'", () => {
    const fixtureWithPrevResult = {
      ...fixtureComEia,
      eia: {
        ...fixtureComEia.eia,
        prevResultLine: "Resultado da última edição: 67% das pessoas acertaram.",
      },
    };
    const html = renderHTML(fixtureWithPrevResult);
    // O bug #1630: prevResultLine era parseada mas nunca emitida no HTML.
    assert.match(html, /Resultado da última edição: 67% das pessoas acertaram\./);
    assert.match(html, /67%/);
  });

  it("#1630: sem prevResultLine → não emite a linha (graceful)", () => {
    const html = renderHTML(fixtureComEia);
    assert.doesNotMatch(html, /Resultado da última edição/);
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

describe("extractTemplateBlock (#1076)", () => {
  it("extrai bloco SORTEIO entre header e separador ---", () => {
    const md = `
**🎁 SORTEIO**

Texto parágrafo 1.

**Responda e concorra** a um livro.

---

**🙋🏼‍♀️ PARA ENCERRAR**

Outra coisa.
`;
    const block = extractTemplateBlock(md, "🎁 SORTEIO");
    assert.ok(block);
    assert.match(block!, /Texto parágrafo 1/);
    assert.match(block!, /Responda e concorra/);
    // Não inclui o separator nem o próximo header
    assert.doesNotMatch(block!, /PARA ENCERRAR/);
  });

  it("extrai PARA ENCERRAR até EOF (sem --- após)", () => {
    const md = `
**🙋🏼‍♀️ PARA ENCERRAR**

Texto final.

Mais texto.
`;
    const block = extractTemplateBlock(md, "🙋🏼‍♀️ PARA ENCERRAR");
    assert.ok(block);
    assert.match(block!, /Texto final/);
    assert.match(block!, /Mais texto/);
  });

  it("retorna null quando bloco ausente", () => {
    const md = "**DESTAQUE 1**\n\nTexto sem SORTEIO.";
    assert.equal(extractTemplateBlock(md, "🎁 SORTEIO"), null);
  });

  it("aceita header sem bold (back-compat com editores que removem markdown)", () => {
    const md = `
🎁 SORTEIO

Texto.

---
`;
    const block = extractTemplateBlock(md, "🎁 SORTEIO");
    assert.ok(block);
    assert.match(block!, /Texto/);
  });

  it("retorna null pra bloco vazio (header + ---)", () => {
    const md = "**🎁 SORTEIO**\n\n\n---\n";
    const block = extractTemplateBlock(md, "🎁 SORTEIO");
    assert.equal(block, null);
  });
});

describe("renderHTML com sorteio + encerrar (#1076)", () => {
  const baseDestaque = {
    n: 1 as const,
    category: "LANÇAMENTO",
    title: "T",
    body: "B",
    why: "W",
    url: "https://example.com/d1",
    emoji: "🚀",
    imageFile: "04-d1-2x1.jpg",
  };
  const fixt = (extras: Partial<{ sorteio: string | null; encerrar: string | null }>) => ({
    title: "X",
    subtitle: "X",
    coverImage: "04-d1-2x1.jpg",
    destaques: [baseDestaque],
    eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
    sections: [],
    sorteio: extras.sorteio ?? null,
    encerrar: extras.encerrar ?? null,
  });

  it("inclui SORTEIO no HTML quando presente", () => {
    const html = renderHTML(fixt({
      sorteio: "Você presta atenção ao conteúdo? **Responda** e ganhe um livro.",
    }));
    assert.match(html, /🎁 Sorteio/);
    assert.match(html, /Você presta atenção/);
    assert.match(html, /<b>Responda<\/b>/);
  });

  it("inclui PARA ENCERRAR com lista no HTML quando presente", () => {
    const html = renderHTML(fixt({
      encerrar: `Nessa edição da **Diar.ia**, usei Claude Code.

- [Cursos](https://example.com/cursos)
- [Livros](https://example.com/livros)

Agora interaja!`,
    }));
    assert.match(html, /🙋🏼‍♀️ Para encerrar/);
    assert.match(html, /<b>Diar\.ia<\/b>/);
    assert.match(html, /<ul/);
    assert.match(html, /href="https:\/\/example\.com\/cursos"/);
    assert.match(html, /href="https:\/\/example\.com\/livros"/);
    assert.match(html, /Agora interaja/);
  });

  it("graceful skip: sem sorteio nem encerrar, HTML sai sem esses blocos", () => {
    const html = renderHTML(fixt({}));
    assert.doesNotMatch(html, /🎁 Sorteio/);
    assert.doesNotMatch(html, /Para encerrar/);
  });

  it("renderiza ambos quando ambos presentes", () => {
    const html = renderHTML(fixt({
      sorteio: "Texto sorteio.",
      encerrar: "Texto encerrar.",
    }));
    assert.match(html, /🎁 Sorteio/);
    assert.match(html, /🙋🏼‍♀️ Para encerrar/);
    // Ordem: SORTEIO antes de ENCERRAR
    const sorteioIdx = html.indexOf("🎁 Sorteio");
    const encerrarIdx = html.indexOf("Para encerrar");
    assert.ok(sorteioIdx > 0 && encerrarIdx > sorteioIdx);
  });
});

describe("renderHTML erroIntencional reveal (#1279)", () => {
  const baseDestaque = {
    n: 1 as const,
    category: "LANÇAMENTO",
    title: "T",
    body: "B",
    why: "W",
    url: "https://example.com/d1",
    emoji: "🚀",
    imageFile: "04-d1-2x1.jpg",
  };
  const fixt = (extras: Partial<{ erroIntencional: string | null; sorteio: string | null; encerrar: string | null }>) => ({
    title: "X",
    subtitle: "X",
    coverImage: "04-d1-2x1.jpg",
    destaques: [baseDestaque],
    eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
    sections: [],
    sorteio: extras.sorteio ?? null,
    encerrar: extras.encerrar ?? null,
    erroIntencional: extras.erroIntencional ?? null,
  });

  it("inclui callout box bordered com 'Na última edição...' quando erroIntencional presente", () => {
    const html = renderHTML(fixt({
      erroIntencional: "Na última edição, disse X mas o correto era Y.\n\nNessa edição, {placeholder}.",
      sorteio: "Sorteio.",
      encerrar: "Encerrar.",
    }));
    assert.match(html, /Na última edição, disse X mas o correto era Y/);
    // Filtra o "Nessa edição, {placeholder}" — só reveal "Na última..." renderiza
    assert.doesNotMatch(html, /\{placeholder\}/);
    // Estilo callout box (#1a1a1a border + radius)
    assert.match(html, /border:1px solid #1a1a1a/);
    assert.match(html, /border-radius:10px/);
  });

  it("posicionamento: entre SORTEIO e PARA ENCERRAR", () => {
    const html = renderHTML(fixt({
      erroIntencional: "Na última edição, disse Z.",
      sorteio: "Sorteio.",
      encerrar: "Encerrar.",
    }));
    const sorteioIdx = html.indexOf("🎁 Sorteio");
    const revealIdx = html.indexOf("Na última edição");
    const encerrarIdx = html.indexOf("Para encerrar");
    assert.ok(sorteioIdx > 0, "sorteio renderizou");
    assert.ok(revealIdx > sorteioIdx, "reveal vem após sorteio");
    assert.ok(encerrarIdx > revealIdx, "encerrar vem após reveal");
  });

  it("graceful skip: sem erroIntencional, HTML não inclui o callout", () => {
    const html = renderHTML(fixt({ sorteio: "S.", encerrar: "E." }));
    assert.doesNotMatch(html, /Na última edição/);
    assert.doesNotMatch(html, /border:1px solid #1a1a1a/);
  });

  it("graceful skip: erroIntencional presente mas sem 'Na última edição', HTML não inclui callout", () => {
    const html = renderHTML(fixt({
      erroIntencional: "Nessa edição, {PREENCHER_NARRATIVA}.\n\nApenas placeholder do editor.",
      sorteio: "S.",
      encerrar: "E.",
    }));
    assert.doesNotMatch(html, /border:1px solid #1a1a1a/);
  });
});

describe("renderSection thin rule + bottom border (#1090)", () => {
  const baseDestaque = {
    n: 1 as const,
    category: "LANÇAMENTO",
    title: "T",
    body: "B",
    why: "W",
    url: "https://example.com/d1",
    emoji: "🚀",
    imageFile: "04-d1-2x1.jpg",
  };
  const fixt = () => ({
    title: "X",
    subtitle: "X",
    coverImage: "04-d1-2x1.jpg",
    destaques: [baseDestaque],
    eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
    sections: [
      { name: "PESQUISA", items: [{ title: "Foo", description: "Bar", url: "https://example.com/p" }] },
    ],
    sorteio: null,
    encerrar: null,
  });

  it("section header não usa rule grossa 2px solid (TEXT_COLOR)", () => {
    const html = renderHTML(fixt());
    // Encontra o BLOCO da section PESQUISA (comment + hr + tr).
    // #1328: kicker agora vem com emoji prefix — `<p>🔬 PESQUISA</p>`.
    const blockStart = html.indexOf("<!-- PESQUISA -->");
    assert.ok(blockStart > 0, "comment PESQUISA deve aparecer");
    const kickerIdx = html.indexOf("PESQUISA</p>", blockStart);
    assert.ok(kickerIdx > blockStart, "kicker contendo PESQUISA</p> deve vir após comment");
    const sectionBlock = html.slice(blockStart, kickerIdx);
    // Regression: rule grossa (2px solid TEXT_COLOR=#1A1A1A) não deve aparecer
    // dentro do bloco da section. Versão antiga usava `renderRule(true)`.
    assert.doesNotMatch(sectionBlock, /border-top:2px solid #1A1A1A/i, "rule grossa não deve aparecer dentro do bloco da section");
    // E o regex deve dar match na forma fina (sanity check do helper):
    assert.match(sectionBlock, /border-top:1px solid #E5E5E5/i, "rule fina (1px solid #E5E5E5) deve estar presente");
  });

  it("section header tem border-bottom (linha fina abaixo do kicker)", () => {
    const html = renderHTML(fixt());
    // O kicker é renderizado como `<p ...>🔬 PESQUISA</p>` com border-bottom no
    // próprio <p>. #1328: emoji prefix obrigatório.
    assert.match(html, /<p [^>]*border-bottom:1px solid[^>]*>🔬 PESQUISA<\/p>/u, "kicker <p> deve ter border-bottom 1px + emoji 🔬");
  });
});

describe("extractCoverageLine + renderCoverage (#1093)", () => {
  it("extrai a linha 'Para esta edição, eu (o editor) enviei ...'", () => {
    const md = [
      "TÍTULO",
      "",
      "Headline de teste",
      "",
      "SUBTÍTULO",
      "",
      "Subhead | Subhead 2",
      "",
      "---",
      "Para esta edição, eu (o editor) enviei 13 submissões e a Diar.ia encontrou outros 125 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.",
      "",
      "---",
      "",
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    ].join("\n");
    const line = extractCoverageLine(md);
    assert.ok(line, "coverage line deve ser extraída");
    assert.match(line!, /^Para esta edição, eu \(o editor\) enviei 13 submissões/);
    assert.match(line!, /Selecionamos os 12 mais relevantes/);
    // Não deve incluir os separadores --- nem o header DESTAQUE 1
    assert.doesNotMatch(line!, /---/);
    assert.doesNotMatch(line!, /DESTAQUE/);
  });

  it("retorna null quando ausente (edição antiga sem coverage)", () => {
    const md = [
      "TÍTULO",
      "",
      "Headline",
      "",
      "---",
      "",
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    ].join("\n");
    assert.equal(extractCoverageLine(md), null);
  });

  it("aceita números diferentes (regression — números não hardcoded)", () => {
    const md = "Para esta edição, eu (o editor) enviei 0 submissões e a Diar.ia encontrou outros 200 artigos. Selecionamos os 9 mais relevantes para as pessoas que assinam a newsletter.";
    const line = extractCoverageLine(md);
    assert.ok(line);
    assert.match(line!, /enviei 0 submissões/);
    assert.match(line!, /outros 200 artigos/);
    assert.match(line!, /os 9 mais relevantes/);
  });

  it("renderCoverage retorna <tr> com texto escapado", () => {
    const text = "Para esta edição, eu (o editor) enviei 5 submissões & a Diar.ia encontrou outros 80 artigos.";
    const html = renderCoverage(text);
    assert.match(html, /^<!-- #1093 coverage line -->/);
    assert.match(html, /<tr><td/);
    assert.match(html, /enviei 5 submissões/);
    // HTML escape do & → &amp; (segurança contra injection de entities)
    assert.match(html, /&amp; a Diar\.ia/);
  });

  it("renderHTML inclui o bloco de cobertura antes do primeiro destaque", () => {
    const baseDestaque = {
      n: 1 as const,
      category: "LANÇAMENTO",
      title: "Modelo X",
      body: "Body.",
      why: "Why.",
      url: "https://example.com/x",
      emoji: "🚀",
      imageFile: "04-d1-2x1.jpg",
    };
    const fixt = {
      title: "X",
      subtitle: "X",
      coverImage: "04-d1-2x1.jpg",
      destaques: [baseDestaque],
      eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
      sections: [],
      coverageLine: "Para esta edição, eu (o editor) enviei 13 submissões e a Diar.ia encontrou outros 125 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.",
    };
    const html = renderHTML(fixt);
    const coverageIdx = html.indexOf("Selecionamos os 12 mais relevantes");
    const destaqueIdx = html.indexOf("Modelo X");
    assert.ok(coverageIdx > 0, "coverage line presente no HTML");
    assert.ok(destaqueIdx > 0, "destaque presente no HTML");
    assert.ok(coverageIdx < destaqueIdx, "coverage line antes do destaque");
    // Confirma que tem o comment marcador
    assert.match(html, /<!-- #1093 coverage line -->/);
  });

  it("renderHTML sem coverageLine: graceful skip (edições antigas)", () => {
    const baseDestaque = {
      n: 1 as const,
      category: "LANÇAMENTO",
      title: "Modelo X",
      body: "Body.",
      why: "Why.",
      url: "https://example.com/x",
      emoji: "🚀",
      imageFile: "04-d1-2x1.jpg",
    };
    const fixt = {
      title: "X",
      subtitle: "X",
      coverImage: "04-d1-2x1.jpg",
      destaques: [baseDestaque],
      eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
      sections: [],
    };
    const html = renderHTML(fixt);
    assert.doesNotMatch(html, /<!-- #1093 coverage line -->/);
    // Destaque ainda presente
    assert.match(html, /Modelo X/);
  });
});

describe("unescapeMd (#1117)", () => {
  it("remove backslash escape de ponto", () => {
    assert.equal(unescapeMd("primeiro trimestre de 2026\\."), "primeiro trimestre de 2026.");
  });

  it("remove backslash escape de exclamação", () => {
    assert.equal(unescapeMd("ajuda bastante\\!"), "ajuda bastante!");
  });

  it("remove backslash escape de interrogação", () => {
    assert.equal(unescapeMd("É isso\\?"), "É isso?");
  });

  it("remove backslash escape de vírgula, ponto-e-vírgula, dois-pontos", () => {
    assert.equal(unescapeMd("um\\, dois\\; três\\:"), "um, dois; três:");
  });

  it("não toca backslash fora do set de pontuação", () => {
    // \n é newline real (não escape MD)
    assert.equal(unescapeMd("linha1\nlinha2"), "linha1\nlinha2");
    // \\ literal não é touchado (não é escape de pontuação)
    assert.equal(unescapeMd("path C:\\\\Users\\\\foo"), "path C:\\\\Users\\\\foo");
  });

  it("não toca backslash em letras (não é escape de pontuação)", () => {
    assert.equal(unescapeMd("\\a\\b\\c"), "\\a\\b\\c");
  });

  it("idempotente — segunda aplicação é no-op", () => {
    const input = "ajuda bastante\\!";
    const once = unescapeMd(input);
    const twice = unescapeMd(once);
    assert.equal(once, twice);
  });

  it("string vazia → string vazia", () => {
    assert.equal(unescapeMd(""), "");
  });

  it("string sem escapes → idêntica", () => {
    assert.equal(unescapeMd("Texto comum sem escapes."), "Texto comum sem escapes.");
  });

  it("URLs Markdown não são modificadas (não têm backslash escape)", () => {
    // URLs em markdown não usam \. — usam % encoding. unescapeMd sobre URL inteira é no-op.
    const url = "https://example.com/path?a=1&b=2";
    assert.equal(unescapeMd(url), url);
  });
});

describe("renderHTML + renderCoverage com escapes MD (#1117 integration)", () => {
  it("renderCoverage remove \\. e \\! do texto", () => {
    const html = renderCoverage("Para esta edição, 2026\\. Continua bastante\\!");
    assert.match(html, /2026\. Continua bastante!/);
    assert.doesNotMatch(html, /2026\\\./);
    assert.doesNotMatch(html, /bastante\\!/);
  });

  it("renderHTML aplica unescape no body do destaque", () => {
    const fixt = {
      title: "X",
      subtitle: "X",
      coverImage: "04-d1-2x1.jpg",
      destaques: [{
        n: 1 as const,
        category: "BRASIL",
        title: "Título sem escape",
        body: "Parágrafo termina em 2026\\.",
        why: "Importante porque ajuda bastante\\!",
        url: "https://example.com",
        emoji: "🇧🇷",
        imageFile: "04-d1-2x1.jpg",
      }],
      eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
      sections: [],
    };
    const html = renderHTML(fixt);
    // Escapes removidos
    assert.match(html, /termina em 2026\./);
    assert.doesNotMatch(html, /2026\\\./);
    assert.match(html, /ajuda bastante!/);
    assert.doesNotMatch(html, /bastante\\!/);
  });
});

describe("truncateAtSectionTerminator (#1118)", () => {
  it("trunca em **🎁 SORTEIO** (com bold)", () => {
    const input =
      "Texto comum\n\n[Item 1](https://x.com/1)\n\n**🎁 SORTEIO**\n\nConteúdo do sorteio.";
    assert.equal(
      truncateAtSectionTerminator(input),
      "Texto comum\n\n[Item 1](https://x.com/1)",
    );
  });

  it("trunca em 🎁 SORTEIO (sem bold)", () => {
    const input = "Item.\n\n🎁 SORTEIO\n\nSorteio body";
    assert.equal(truncateAtSectionTerminator(input), "Item.");
  });

  it("trunca em **🙋🏼‍♀️ PARA ENCERRAR**", () => {
    const input = "Items aqui.\n\n**🙋🏼‍♀️ PARA ENCERRAR**\n\nEncerramento";
    assert.equal(truncateAtSectionTerminator(input), "Items aqui.");
  });

  it("usa o primeiro marker que aparece (SORTEIO antes de PARA ENCERRAR)", () => {
    const input =
      "Items aqui.\n\n**🎁 SORTEIO**\n\nSorteio body\n\n**🙋🏼‍♀️ PARA ENCERRAR**\n\nEncerramento";
    assert.equal(truncateAtSectionTerminator(input), "Items aqui.");
  });

  it("sem marker → retorna texto inalterado (trimmed)", () => {
    const input = "Items aqui.\n\nMais items.";
    assert.equal(truncateAtSectionTerminator(input), "Items aqui.\n\nMais items.");
  });

  it("não trunca quando marker aparece no meio de uma linha (não é header solo)", () => {
    // Linha contém "🎁 SORTEIO" no meio — não deve truncar (só matchar header solo).
    const input = "Eu disse 🎁 SORTEIO inline, não é header.";
    assert.equal(
      truncateAtSectionTerminator(input),
      "Eu disse 🎁 SORTEIO inline, não é header.",
    );
  });

  it("string vazia → string vazia", () => {
    assert.equal(truncateAtSectionTerminator(""), "");
  });
});

describe("parseSections com terminator implícito (#1118)", () => {
  it("OUTRAS NOTÍCIAS sem --- antes de SORTEIO não engole o bloco SORTEIO", () => {
    // Cenário do bug 260512: writer omitiu `---` entre OUTRAS NOTÍCIAS e SORTEIO.
    const md = [
      "**OUTRAS NOTÍCIAS**",
      "",
      "[Item 1](https://x.com/1)",
      "Descrição do item 1.",
      "",
      "[Item 2](https://x.com/2)",
      "Descrição do item 2.",
      "",
      "**🎁 SORTEIO**",
      "",
      "Conteúdo do sorteio que não deve virar item.",
    ].join("\n");

    const sections = parseSections(md);
    assert.equal(sections.length, 1, "deve ter 1 section (OUTRAS NOTÍCIAS)");
    assert.equal(sections[0].name, "OUTRAS NOTÍCIAS");
    assert.equal(sections[0].items.length, 2, "exatamente 2 items, não 3+");
    assert.equal(sections[0].items[0].title, "Item 1");
    assert.equal(sections[0].items[1].title, "Item 2");
    // Nenhum item com texto de SORTEIO
    for (const item of sections[0].items) {
      assert.ok(!item.title.includes("SORTEIO"));
      assert.ok(!item.description.includes("Conteúdo do sorteio"));
    }
  });

  it("PESQUISAS sem --- antes de PARA ENCERRAR não engole o bloco", () => {
    const md = [
      "**PESQUISAS**",
      "",
      "[Paper 1](https://arxiv.org/1)",
      "Descrição do paper.",
      "",
      "**🙋🏼‍♀️ PARA ENCERRAR**",
      "",
      "Texto final.",
    ].join("\n");

    const sections = parseSections(md);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, "PESQUISAS");
    assert.equal(sections[0].items.length, 1);
    assert.equal(sections[0].items[0].title, "Paper 1");
  });

  it("comportamento correto preservado quando --- está presente", () => {
    const md = [
      "**OUTRAS NOTÍCIAS**",
      "",
      "[Item 1](https://x.com/1)",
      "Descrição.",
      "",
      "---",
      "",
      "**🎁 SORTEIO**",
      "",
      "Body sorteio.",
    ].join("\n");

    const sections = parseSections(md);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].items.length, 1);
    assert.equal(sections[0].items[0].title, "Item 1");
  });
});

describe("joinMultilineLinks (#1213)", () => {
  it("junta link em 3 linhas no formato `[label](\\nurl\\n)`", () => {
    const md = [
      "- [Melhores cursos grátis de IA](",
      "https://diaria.beehiiv.com/cursos-gratuitos-de-ia",
      ")",
    ].join("\n");
    const out = joinMultilineLinks(md);
    assert.equal(out, "- [Melhores cursos grátis de IA](https://diaria.beehiiv.com/cursos-gratuitos-de-ia)");
  });

  it("junta múltiplos links no mesmo arquivo (caso 260517)", () => {
    const md = [
      "- [Melhores cursos](",
      "https://diaria.beehiiv.com/cursos",
      ")",
      "- [Curadoria](",
      "https://diaria.beehiiv.com/livros",
      ")",
    ].join("\n");
    const out = joinMultilineLinks(md);
    assert.match(out, /- \[Melhores cursos\]\(https:\/\/diaria\.beehiiv\.com\/cursos\)/);
    assert.match(out, /- \[Curadoria\]\(https:\/\/diaria\.beehiiv\.com\/livros\)/);
    assert.ok(!out.includes("](\n"), "no remaining broken link");
  });

  it("preserva links que já estão em uma linha", () => {
    const md = "Link [já fechado](https://x.com) inline.";
    const out = joinMultilineLinks(md);
    assert.equal(out, md);
  });

  it("preserva texto sem links", () => {
    const md = "Parágrafo simples sem nenhum link markdown.\n\nOutra linha.";
    const out = joinMultilineLinks(md);
    assert.equal(out, md);
  });

  it("idempotente — re-aplicar não muda", () => {
    const md = [
      "- [Cursos](",
      "https://example.com",
      ")",
    ].join("\n");
    const first = joinMultilineLinks(md);
    const second = joinMultilineLinks(first);
    assert.equal(first, second);
  });
});

describe("singularizeSectionName (#1070)", () => {
  it("LANÇAMENTOS → LANÇAMENTO quando N=1", () => {
    assert.equal(singularizeSectionName("LANÇAMENTOS", 1), "LANÇAMENTO");
  });

  it("PESQUISAS → PESQUISA quando N=1", () => {
    assert.equal(singularizeSectionName("PESQUISAS", 1), "PESQUISA");
  });

  it("OUTRAS NOTÍCIAS → OUTRA NOTÍCIA quando N=1", () => {
    assert.equal(singularizeSectionName("OUTRAS NOTÍCIAS", 1), "OUTRA NOTÍCIA");
  });

  it("mantém plural quando N=0", () => {
    assert.equal(singularizeSectionName("LANÇAMENTOS", 0), "LANÇAMENTOS");
  });

  it("mantém plural quando N=2", () => {
    assert.equal(singularizeSectionName("PESQUISAS", 2), "PESQUISAS");
    assert.equal(singularizeSectionName("OUTRAS NOTÍCIAS", 5), "OUTRAS NOTÍCIAS");
  });

  it("nome desconhecido passa unchanged", () => {
    assert.equal(singularizeSectionName("FOO", 1), "FOO");
  });
});

describe("renderHTML — singular nas seções quando N=1 (#1070)", () => {
  const baseDestaque = {
    n: 1 as const,
    category: "LANÇAMENTO",
    title: "T",
    body: "B",
    why: "W",
    url: "https://example.com/d1",
    emoji: "🚀",
    imageFile: "04-d1-2x1.jpg",
  };
  const fixt = (sections: { name: string; emoji?: string; items: { title: string; description: string; url: string }[] }[]) => ({
    title: "X",
    subtitle: "X",
    coverImage: "04-d1-2x1.jpg",
    destaques: [baseDestaque],
    eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
    sections,
    sorteio: null,
    encerrar: null,
  });

  it("renderiza 🚀 LANÇAMENTO singular quando seção tem 1 item (#1324, #1328)", () => {
    const html = renderHTML(fixt([
      { name: "LANÇAMENTOS", items: [{ title: "Foo", description: "Bar", url: "https://example.com/x" }] },
    ]));
    assert.match(html, />🚀 LANÇAMENTO</u);
    assert.doesNotMatch(html, />🚀 LANÇAMENTOS</u);
  });

  it("mantém 🚀 LANÇAMENTOS plural quando seção tem 2 items (#1328)", () => {
    const html = renderHTML(fixt([
      { name: "LANÇAMENTOS", items: [
        { title: "A", description: "x", url: "https://example.com/a" },
        { title: "B", description: "y", url: "https://example.com/b" },
      ] },
    ]));
    assert.match(html, />🚀 LANÇAMENTOS</u);
  });

  it("renderiza 📰 OUTRA NOTÍCIA singular quando seção tem 1 item (#1324, #1328)", () => {
    const html = renderHTML(fixt([
      { name: "OUTRAS NOTÍCIAS", items: [{ title: "Foo", description: "Bar", url: "https://example.com/x" }] },
    ]));
    assert.match(html, />📰 OUTRA NOTÍCIA</u);
    assert.doesNotMatch(html, />📰 OUTRAS NOTÍCIAS</u);
  });
});

describe("processInlineItalics (#1364)", () => {
  it("converte *texto* em <em>", () => {
    assert.equal(
      processInlineItalics("Chacal-dourado (*Canis aureus*) em flores"),
      'Chacal-dourado (<em style="font-style:italic;">Canis aureus</em>) em flores',
    );
  });

  it("converte múltiplos *italics* na mesma linha", () => {
    assert.equal(
      processInlineItalics("foo *italic1* bar *italic2* baz"),
      'foo <em style="font-style:italic;">italic1</em> bar <em style="font-style:italic;">italic2</em> baz',
    );
  });

  it("não toca **bold** (asterisco duplo)", () => {
    assert.equal(
      processInlineItalics("**bold** stays as-is"),
      "**bold** stays as-is",
    );
  });

  it("não toca *** misto", () => {
    // ***x*** é bold+italic em CommonMark — não tratamos aqui (raro em pt-BR editorial)
    assert.equal(
      processInlineItalics("***triple*** middle"),
      "***triple*** middle",
    );
  });

  it("preserva texto sem italics", () => {
    assert.equal(
      processInlineItalics("Texto puro sem asteriscos"),
      "Texto puro sem asteriscos",
    );
  });

  it("não cruza newlines (italic em parágrafo único só)", () => {
    assert.equal(
      processInlineItalics("foo *open\nclose* bar"),
      "foo *open\nclose* bar",
    );
  });
});

describe("processInlineLinks — parênteses balanceados na URL (#1634)", () => {
  it("URL com '(1).pdf' não trunca o href (o bug do Founders Playbook)", () => {
    const url =
      "https://cdn.example.com/The-Founders-Playbook-05062026_v3%20(1).pdf";
    const html = processInlineLinks(`Baixe [The Founders Playbook](${url}) agora`);
    assert.match(html, /href="https:\/\/cdn\.example\.com\/The-Founders-Playbook-05062026_v3%20\(1\)\.pdf"/);
    assert.match(html, />The Founders Playbook<\/a>/);
    // o ')' final do .pdf não pode ter vazado como texto após o link
    assert.doesNotMatch(html, /\.pdf"[^>]*>The Founders Playbook<\/a>\)/);
    assert.match(html, /agora$/);
  });

  it("link simples sem parênteses continua funcionando", () => {
    const html = processInlineLinks("veja [Claude 101](https://anthropic.skilljar.com/claude-101)");
    assert.match(html, /href="https:\/\/anthropic\.skilljar\.com\/claude-101"/);
    assert.match(html, />Claude 101<\/a>/);
  });

  it("dois links na mesma string, um com parênteses", () => {
    const html = processInlineLinks(
      "[A](https://a.com/x(1).pdf) e [B](https://b.com/y)",
    );
    assert.match(html, /href="https:\/\/a\.com\/x\(1\)\.pdf"/);
    assert.match(html, /href="https:\/\/b\.com\/y"/);
    assert.match(html, />A<\/a> e <a /);
  });

  it("colchete sem fechamento de parêntese → não vira link (texto cru escapado)", () => {
    const html = processInlineLinks("[texto](sem-fechar");
    assert.doesNotMatch(html, /<a /);
    assert.match(html, /\[texto\]\(sem-fechar/);
  });

  it("URL vazia '[texto]()' → não vira link (paridade com regex antiga)", () => {
    const html = processInlineLinks("antes [texto]() depois [B](https://b.com)");
    assert.doesNotMatch(html, /href=""/);
    assert.match(html, /\[texto\]\(\)/); // preservado como texto literal
    assert.match(html, /href="https:\/\/b\.com"/); // link válido seguinte ainda funciona
  });
});
