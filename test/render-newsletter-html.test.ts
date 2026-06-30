import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseListItems,
  parseSections,
  parseEIA,
  fallbackEIA,
  resolvePrevResultLine,
  extractContent,
  renderHTML,
  renderBodyParasInner,
  renderWhyBoxInner,
  renderEiaStandalone,
  renderLeaderboardTop1Row,
  extractTemplateBlock,
  extractCoverageLine,
  reconcileCoverageCount,
  renderCoverage,
  unescapeMd,
  processInlineItalics,
  processInlineLinks,
  applyBrandWordmark,
  truncateAtSectionTerminator,
  joinMultilineLinks,
  singularizeSectionName,
  pickErroIntencionalReveal,
} from "../scripts/render-newsletter-html.ts";
import { DS_STYLE_BLOCK, mdInlineToHtml } from "../scripts/lib/newsletter-render-html.ts";

describe("pickErroIntencionalReveal (#1859)", () => {
  it("caminho feliz: parágrafo com prefixo 'Na última edição'", () => {
    const text = [
      "Na última edição, escrevi X onde deveria ser Y.",
      "",
      "Nessa edição, plantamos outro erro.",
    ].join("\n\n");
    assert.equal(
      pickErroIntencionalReveal(text),
      "Na última edição, escrevi X onde deveria ser Y.",
    );
  });

  it("fallback: reveal reescrito sem o prefixo literal → 1º parágrafo não-teaser", () => {
    // #1859: editor reescreveu o reveal sem começar com "Na última edição".
    // Antes o bloco inteiro sumia; agora cai no 1º parágrafo que não é teaser.
    const text = [
      "Há duas edições atrás, atribuímos a citação ao CEO errado.",
      "",
      "Nessa edição, tem mais um erro escondido.",
    ].join("\n\n");
    assert.equal(
      pickErroIntencionalReveal(text),
      "Há duas edições atrás, atribuímos a citação ao CEO errado.",
    );
  });

  it("ignora teaser 'Nessa edição', boilerplate e placeholder", () => {
    const text = [
      "Esta edição tem um erro proposital.",
      "",
      "Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.",
    ].join("\n\n");
    assert.equal(pickErroIntencionalReveal(text), null);
  });

  it("retorna null quando só há teaser da edição corrente", () => {
    const text = "Nessa edição, escondemos um erro pra você achar.";
    assert.equal(pickErroIntencionalReveal(text), null);
  });

  it("fallback casa 'última' ACENTUADO (regressão do \\b ASCII-only)", () => {
    // Sem o `u` flag, JS `\b` não cria boundary antes do "ú" (U+00FA); um
    // `\b[úu]ltim` jamais casaria "última". Reveal reescrito que NÃO começa
    // com "Na última edição" mas menciona "última" acentuada não pode sumir.
    const text = "Erramos na última edição: o ano de fundação estava trocado.";
    // Não começa com "Na última edição" → cai no fallback, que precisa casar
    // o "última" acentuado.
    assert.equal(
      pickErroIntencionalReveal(text),
      "Erramos na última edição: o ano de fundação estava trocado.",
    );
  });

  it("fallback casa reveal reescrito com 'edição anterior'", () => {
    const text = "Na edição anterior, atribuímos a frase à pessoa errada.";
    assert.equal(
      pickErroIntencionalReveal(text),
      "Na edição anterior, atribuímos a frase à pessoa errada.",
    );
  });
});

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

  // #1737: tightening INTENCIONAL do prefixo de emoji (era o loose
  // `[^\sA-Za-zÁ-ú]+` que casava dígitos/pontuação). Agora alinhado ao lint
  // (#1691). Headers com prefixo NÃO-emoji deixam de casar. Headers canônicos
  // (emoji no range) seguem casando — coberto pelos testes acima.
  it("parseSections NÃO trata prefixo de dígito/pontuação como header (#1737/#1691)", () => {
    const mk = (header: string) =>
      parseSections([header, "**[T](https://x.com)**", "Resumo."].join("\n"));
    assert.equal(mk("**123 RADAR**").length, 0); // dígito-prefixo não é header
    assert.equal(mk("**### RADAR**").length, 0); // pontuação não é header
    // sanity: o canônico ainda casa
    assert.equal(mk("**📡 RADAR**").length, 1);
  });
});

describe("resolvePrevResultLine (#1707 — fallback do % da edição anterior)", () => {
  function makeEdition(stats: unknown | null): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-prevresult-"));
    if (stats !== null) {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "04-eia-poll-stats.json"), JSON.stringify(stats), "utf8");
    }
    return dir;
  }

  it("#1763: poll-stats (fresh) vence a linha do MD (que pode ficar stale)", () => {
    // 01-eia.md é baked uma vez no Stage 1; se os stats forem corrigidos depois
    // (rebuild-stats #1757), a linha do MD fica stale. Caso real 260603:
    // MD="44%" (counter inflado), poll-stats corrigido pra "57%" → usa 57%.
    const dir = makeEdition({ pct_correct: 57, total_responses: 7 });
    try {
      const staleMdLine = "Resultado da última edição: 44% das pessoas acertaram.";
      assert.equal(
        resolvePrevResultLine(staleMdLine, dir),
        "Resultado da última edição: 57% das pessoas acertaram.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#1763 fallback: usa a linha do MD quando NÃO há poll-stats (anti-race #1707)", () => {
    const dir = makeEdition(null); // sem 04-eia-poll-stats.json
    try {
      const mdLine = "Resultado da última edição: 80% das pessoas acertaram.";
      assert.equal(resolvePrevResultLine(mdLine, dir), mdLine);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#1763 fallback: usa a linha do MD quando poll-stats below_threshold", () => {
    const dir = makeEdition({ pct_correct: null, total_responses: 3, below_threshold: true });
    try {
      const mdLine = "Resultado da última edição: 80% das pessoas acertaram.";
      assert.equal(resolvePrevResultLine(mdLine, dir), mdLine);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#1707: injeta do poll-stats quando a linha falta no MD (anti-race)", () => {
    const dir = makeEdition({ pct_correct: 75, total_responses: 120 });
    try {
      assert.equal(
        resolvePrevResultLine(undefined, dir),
        "Resultado da última edição: 75% das pessoas acertaram.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("undefined quando não há linha nem poll-stats", () => {
    const dir = makeEdition(null);
    try {
      assert.equal(resolvePrevResultLine(undefined, dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("undefined quando poll-stats below_threshold (não inventa %)", () => {
    const dir = makeEdition({ pct_correct: null, total_responses: 3, below_threshold: true });
    try {
      assert.equal(resolvePrevResultLine(undefined, dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#1707 E2E: extractContent injeta a linha no eia quando 01-eia.md não tem mas poll-stats tem", () => {
    // Guarda o WIRING (extractContent → resolvePrevResultLine) — não só o helper.
    const dir = mkdtempSync(join(tmpdir(), "diaria-prevresult-e2e-"));
    try {
      const reviewed = [
        "**DESTAQUE 1 | LANÇAMENTO**", "",
        "**[Título um](https://example.com/1)**", "",
        "Corpo do destaque um com contexto suficiente pra render.", "",
        "Por que isso importa: razão um.", "",
        "---", "",
        "**DESTAQUE 2 | RADAR**", "",
        "**[Título dois](https://example.com/2)**", "",
        "Corpo dois.", "",
        "Por que isso importa: razão dois.", "",
        "---", "",
        "**DESTAQUE 3 | PESQUISA**", "",
        "**[Título três](https://example.com/3)**", "",
        "Corpo três.", "",
        "Por que isso importa: razão três.", "",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
      // 01-eia.md SEM a linha "Resultado da última edição" (só crédito).
      writeFileSync(join(dir, "01-eia.md"), "É IA?\n\nCrédito da imagem [link](https://x.com).\n", "utf8");
      writeFileSync(join(dir, "01-eia-A.jpg"), "x", "utf8");
      writeFileSync(join(dir, "01-eia-B.jpg"), "x", "utf8");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "04-eia-poll-stats.json"),
        JSON.stringify({ pct_correct: 75, total_responses: 120 }),
        "utf8",
      );
      const content = extractContent(dir);
      assert.equal(
        content.eia.prevResultLine,
        "Resultado da última edição: 75% das pessoas acertaram.",
        "extractContent deve injetar a linha do poll-stats (wiring do #1707)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    // #1186: modo merge-tag — vote URL tem {{email}}, SEM sig HMAC.
    assert.match(html, /\{\{email\}\}/);
    assert.ok(!html.includes("{{poll_sig}}"), "{{poll_sig}} presente — removido em #1186");
    assert.ok(!html.includes("&sig="), "sig= presente — removido em #1186");
  });

  it("#1970: link persistente da leaderboard mesmo SEM pódio (edição não-1ª-do-mês)", () => {
    // fixtureComEia não tem leaderboardPodium nem leaderboardPeriodSlug → o pódio
    // (renderLeaderboardTop1Row) é omitido, mas o link persistente DEVE aparecer.
    const html = renderHTML(fixtureComEia);
    assert.match(html, /href="https:\/\/poll\.diaria\.workers\.dev\/leaderboard"/);
    assert.match(html, /Veja o ranking de quem mais acerta/);
    // sem pódio nesta edição (sem "Vencedores")
    assert.doesNotMatch(html, /Vencedores/);
  });

  it("#1936: emite o marcador exato <!-- Destaque N --> (contrato do lint)", () => {
    // checkRequiredSections (lint-newsletter-html.ts) busca o substring exato
    // `<!-- Destaque 1 -->`. Acoplado de propósito — se o comentário do render
    // mudar, este teste falha antes do lint dar falso-positivo de seção faltando.
    const html = renderHTML(fixtureComEia);
    assert.match(html, /<!-- Destaque 1 -->/);
  });

  it("renderHTML excludeEia=true: omite seção È IA? mesmo quando configurada", () => {
    const html = renderHTML(fixtureComEia, { excludeEia: true });
    assert.ok(!html.includes("É IA?"), "body não deve mencionar È IA?");
    assert.ok(!html.includes("{{email}}"), "body não deve ter merge tags Beehiiv");
    assert.ok(!html.includes("{{poll_sig}}"), "{{poll_sig}} não deve aparecer (removido em #1186)");
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

  it("renderEiaStandalone retorna HTML com merge tag {{email}} (modo merge-tag #1186)", () => {
    const html = renderEiaStandalone(fixtureComEia);
    assert.ok(html, "deve retornar HTML não-null pra eia configurada");
    // #1186: modo merge-tag — vote URL tem {{email}}, SEM sig HMAC.
    assert.match(html!, /\{\{email\}\}/);
    assert.ok(!html!.includes("{{poll_sig}}"), "{{poll_sig}} presente — removido em #1186");
    assert.ok(!html!.includes("&sig="), "sig= presente — removido em #1186");
    assert.match(html!, /É IA\?/);
  });

  it("renderEiaStandalone wrap em outer table própria (paste-ready)", () => {
    const html = renderEiaStandalone(fixtureComEia);
    // Deve começar com comment header + abrir <table> próprio
    assert.match(html!, /^<!-- Diar\.ia È IA\? section/);
    assert.match(html!, /<table role="none"[^>]*>/);
    assert.match(html!, /<\/table>$/);
  });

  it("título do É IA? ('Clique na imagem...') em 26px serif (DS h4)", () => {
    // #DS callout/É IA? title h4: heading do painel subiu de 22px (h5) pra 26px (h4).
    const html = renderEiaStandalone(fixtureComEia);
    assert.ok(html, "deve retornar HTML pra eia configurada");
    const headingMatch = html!.match(/<p style="([^"]+)">Clique na imagem que foi gerada por IA\.<\/p>/);
    assert.ok(headingMatch, "heading do É IA? deve existir no render standalone");
    assert.match(headingMatch![1], /font-size:26px/, "heading do É IA? é 26px (DS h4)");
    assert.doesNotMatch(headingMatch![1], /font-size:22px/, "não deve mais ser 22px (h5)");
  });

  it("#1936: caption do É IA? em sans 12px ink (DS, sem itálico)", () => {
    const html = renderHTML(fixtureComEia);
    // #1936: o template do DS usa legenda sans 12px ink (não itálico) no painel.
    const creditMatch = html.match(/<p style="([^"]+)">Foto: Author[^<]*<\/p>/);
    assert.ok(creditMatch, "credit <p> deve existir no HTML renderizado");
    assert.match(creditMatch![1], /font-size:12px/, "caption do DS é 12px");
    assert.doesNotMatch(creditMatch![1], /font-style:italic/, "DS não italiciza a legenda");
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

  it("#2541: É IA? empilha A acima de B em layout de 1 coluna (desktop e mobile)", () => {
    // O fix #2541 trocou o layout 2-colunas (poll-col) por 2 <tr> independentes.
    const html = renderHTML(fixtureComEia);
    // 1. Não usa mais largura de 50% (layout 2-colunas)
    assert.doesNotMatch(html, /width="50%"/, "largura de 50% não deve existir (layout 2-colunas removido)");
    // 2. Não usa classes poll-col (CSS de 2-colunas)
    assert.doesNotMatch(html, /class="poll-col"/, "classe poll-col não deve existir (#2541)");
    // 3. Imagem A com link choice=A está presente
    assert.match(html, /choice=A.*01-eia-A\.jpg|01-eia-A\.jpg.*choice=A/s, "imagem A com link choice=A ausente");
    // 4. Imagem B com link choice=B está presente
    assert.match(html, /choice=B.*01-eia-B\.jpg|01-eia-B\.jpg.*choice=B/s, "imagem B com link choice=B ausente");
    // 5. merge tag {{email}} preservada nos dois links de voto
    const emailMatches = [...html.matchAll(/\{\{email\}\}/g)];
    assert.ok(emailMatches.length >= 2, `merge tag {{email}} deve aparecer em ambos os links de voto (encontrado ${emailMatches.length}x)`);
    // 6. A aparece antes de B no HTML (empilhamento correto: A acima de B)
    const idxA = html.indexOf("01-eia-A.jpg");
    const idxB = html.indexOf("01-eia-B.jpg");
    assert.ok(idxA !== -1, "01-eia-A.jpg ausente");
    assert.ok(idxB !== -1, "01-eia-B.jpg ausente");
    assert.ok(idxA < idxB, `Imagem A (${idxA}) deve vir antes de B (${idxB}) no HTML`);
    // 7. Legenda (crédito), resultado anterior e leaderboard preservados
    assert.match(html, /Foto: Author/, "legenda (credit) ausente");
  });

  it("#2541: É IA? standalone também usa layout empilhado (1 coluna)", () => {
    const html = renderEiaStandalone(fixtureComEia)!;
    assert.ok(html, "standalone deve retornar HTML");
    assert.doesNotMatch(html, /width="50%"/, "largura de 50% não deve existir no standalone");
    assert.doesNotMatch(html, /class="poll-col"/, "classe poll-col não deve existir no standalone");
    // Ambos os links com {{email}} e choice correto
    assert.match(html, /choice=A/);
    assert.match(html, /choice=B/);
    const emailMatches = [...html.matchAll(/\{\{email\}\}/g)];
    assert.ok(emailMatches.length >= 2, `{{email}} deve aparecer em ambos os links (encontrado ${emailMatches.length}x)`);
    // A antes de B
    assert.ok(html.indexOf("01-eia-A.jpg") < html.indexOf("01-eia-B.jpg"), "A deve preceder B no standalone");
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
    assert.match(html, /Sorteio/); // #1936: kicker sem emoji (DS usa ●)
    assert.match(html, /Você presta atenção/);
    assert.match(html, /<b>Responda<\/b>/);
  });

  it("#2080 — SORTEIO: kicker fora do box, corpo dentro de painel bege (DS)", () => {
    const html = renderHTML(fixt({
      sorteio: "Participe e ganhe uma caneca.\n\nResponda a esta edição.",
    }));
    // kicker "Sorteio" presente (DS ● sem emoji)
    assert.match(html, /Sorteio/);
    // conteúdo está presente
    assert.match(html, /Participe e ganhe uma caneca/);
    assert.match(html, /Responda a esta edição/);
    // box painel DS: fundo SURFACE (#EBE5D0) + border-radius:12px (inline style email)
    assert.match(html, /background:#EBE5D0.*border-radius:12px|border-radius:12px.*background:#EBE5D0/, "caixa painel bege");
    // conteúdo do sorteio está DENTRO do box (vem depois do background #EBE5D0)
    const boxIdx = html.indexOf("background:#EBE5D0");
    assert.ok(boxIdx > -1, "box markup presente");
    assert.ok(html.indexOf("Participe e ganhe uma caneca") > boxIdx, "texto dentro do box");
  });

  it("#2080 bug fix — sorteio só-whitespace não emite box vazio", () => {
    // guard: content.sorteio?.trim() — whitespace-only não deve renderizar nada
    const html = renderHTML(fixt({ sorteio: "   " }));
    assert.ok(!html.includes("background:#EBE5D0"), "box vazio não deve aparecer");
    assert.ok(!html.includes("<!-- Sorteio -->"), "bloco sorteio não deve ser emitido");
  });

  it("inclui PARA ENCERRAR com pills no HTML quando presente", () => {
    const html = renderHTML(fixt({
      encerrar: `Nessa edição da **Diar.ia**, usei Claude Code.

- [Cursos](https://example.com/cursos)
- [Livros](https://example.com/livros)

Agora interaja!`,
    }));
    assert.match(html, /Para encerrar/); // #1936: kicker sem emoji
    // #2532: "**Diar.ia**" → bold preservado + wordmark diar.ia.br (pontos teal) interno.
    assert.match(html, /<b><strong>diar<span style="color:#00A0A0">\.<\/span>ia<span style="color:#00A0A0">\.br<\/span><\/strong><\/b>/);
    // #1936: lista vira PILLS (DS), precedidas de "Acesse nossas curadorias:" (#1942)
    assert.match(html, /Acesse nossas curadorias:/);
    assert.match(html, /border-radius:999px/);
    assert.match(html, /href="https:\/\/example\.com\/cursos"/);
    assert.match(html, /href="https:\/\/example\.com\/livros"/);
    assert.match(html, /Agora interaja/);
    // #2138: pills com font-size:16px (não 12px)
    assert.match(html, /border-radius:999px[^>]*font-size:16px/, "pills devem ter font-size:16px (#2138)");
    assert.doesNotMatch(html, /border-radius:999px[^>]*font-size:12px/, "pills não devem ter font-size:12px (#2138)");
    // #2139/#2160: table de pills centralizada via align="center" + margin:0 auto (Outlook fix).
    // Ancorada no bloco ENCERRAR (href das curadorias na mesma table) pra não casar mid-callout.
    assert.match(
      html,
      /align="center"[^>]*cellpadding="0"[^>]*style="margin:0 auto;"[^]*?https:\/\/example\.com\/cursos/,
      "table de pills deve ter align=center + margin:0 auto, com pills do ENCERRAR (#2139/#2160)",
    );
    // kicker permanece em 12px (label de seção — NÃO é botão)
    assert.match(html, /font-size:12px[^>]*>Acesse nossas curadorias:/, "kicker deve permanecer em 12px");
  });

  it("#1936: item de pill com conteúdo misto NÃO vaza markdown cru", () => {
    const html = renderHTML(fixt({
      encerrar: `Texto.

- [Cursos](https://example.com/c) — novidades
- Veja o **catálogo**`,
    }));
    // Regressão: o parser de pill só casava link puro; o resto caía em esc(cru).
    // Agora mdInlineToHtml renderiza link/bold — nunca [..](..) nem ** literais.
    assert.doesNotMatch(html, /\[Cursos\]\(/, "não vaza markdown de link");
    assert.doesNotMatch(html, /\*\*catálogo\*\*/, "não vaza markdown de bold");
    assert.match(html, /<b>catálogo<\/b>/, "bold renderizado");
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
    assert.match(html, /Sorteio/);
    assert.match(html, /Para encerrar/);
    // Ordem: SORTEIO antes de ENCERRAR
    const sorteioIdx = html.indexOf("Sorteio");
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
    // #1936/#1943: box "contorno" do DS — borda bege, sem teal. O fundo acompanha
    // o container: paper #FBFAF6 na web/mensal, branco #FFFFFF no e-mail (#1943).
    assert.match(html, /background:#FFFFFF;border:1px solid #EBE5D0/);
    assert.doesNotMatch(html, /border:1px solid #00A0A0/);
    assert.match(html, /border-radius:12px/);
  });

  it("posicionamento: entre SORTEIO e PARA ENCERRAR", () => {
    const html = renderHTML(fixt({
      erroIntencional: "Na última edição, disse Z.",
      sorteio: "Sorteio.",
      encerrar: "Encerrar.",
    }));
    const sorteioIdx = html.indexOf("Sorteio");
    const revealIdx = html.indexOf("Na última edição");
    const encerrarIdx = html.indexOf("Para encerrar");
    assert.ok(sorteioIdx > 0, "sorteio renderizou");
    assert.ok(revealIdx > sorteioIdx, "reveal vem após sorteio");
    assert.ok(encerrarIdx > revealIdx, "encerrar vem após reveal");
  });

  it("graceful skip: sem erroIntencional, HTML não inclui o callout", () => {
    const html = renderHTML(fixt({ sorteio: "S.", encerrar: "E." }));
    assert.doesNotMatch(html, /Na última edição/);
    assert.doesNotMatch(html, /border:1px solid #171411/);
  });

  it("graceful skip: erroIntencional presente mas sem 'Na última edição', HTML não inclui callout", () => {
    const html = renderHTML(fixt({
      erroIntencional: "Nessa edição, {PREENCHER_NARRATIVA}.\n\nApenas placeholder do editor.",
      sorteio: "S.",
      encerrar: "E.",
    }));
    assert.doesNotMatch(html, /border:1px solid #171411/);
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

  it("#1936: kicker do DS — sem rule grossa, hairline bege, nunca teal", () => {
    const html = renderHTML(fixt());
    // #1936: kicker = `<td>●&nbsp;PESQUISA</td>` + `<td ...border-bottom bege>`.
    const blockStart = html.indexOf("<!-- PESQUISA -->");
    assert.ok(blockStart > 0, "comment PESQUISA deve aparecer");
    const kickerIdx = html.indexOf("PESQUISA</td>", blockStart);
    assert.ok(kickerIdx > blockStart, "kicker contendo PESQUISA</td> deve vir após comment");
    const sectionBlock = html.slice(blockStart, kickerIdx + 200);
    assert.doesNotMatch(sectionBlock, /2px solid #1A1A1A/i, "sem rule grossa 2px tinta");
    assert.match(sectionBlock, /border-bottom:1px solid #EBE5D0/i, "hairline do kicker = bege --rule");
    assert.doesNotMatch(sectionBlock, /border-bottom:1px solid #00A0A0/i, "régua nunca é teal");
  });

  it("#1936: kicker tem ponto ● + label sem emoji + hairline bege", () => {
    const html = renderHTML(fixt());
    // DS: ponto teal ● + label uppercase (emoji removido) + régua bege preenchendo.
    assert.match(html, /&#9679;<\/span>&nbsp;PESQUISA<\/td>/u, "kicker ● + label PESQUISA sem emoji");
    assert.match(html, /<td style="width:100%;border-bottom:1px solid #EBE5D0;[^>]*>&nbsp;<\/td>/, "régua bege preenche a linha do kicker");
  });
});

describe("reconcileCoverageCount (#1761)", () => {
  const base =
    "Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 157 artigos. ";

  it("corrige o N stale para o nº real de itens renderizados", () => {
    // Caso 260603: linha dizia 15, mas após remover itens no gate o real era 12.
    const stale = base + "Selecionamos os 15 mais relevantes para as pessoas que assinam a newsletter.";
    const out = reconcileCoverageCount(stale, 12);
    assert.match(out, /Selecionamos os 12 mais relevantes/);
    assert.doesNotMatch(out, /os 15 mais/);
    // preserva X e Y
    assert.match(out, /enviei 5 submissões e a Diar\.ia encontrou outros 157 artigos/);
  });

  it("concordância singular: 1 item → 'Selecionamos o artigo mais relevante'", () => {
    const stale = base + "Selecionamos os 9 mais relevantes para as pessoas que assinam a newsletter.";
    const out = reconcileCoverageCount(stale, 1);
    assert.match(out, /Selecionamos o artigo mais relevante para as pessoas/);
    assert.doesNotMatch(out, /os \d+ mais/);
  });

  it("idempotente quando já bate", () => {
    const ok = base + "Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.";
    assert.equal(reconcileCoverageCount(ok, 12), ok);
  });

  it("linha sem o padrão 'Selecionamos ...' fica inalterada", () => {
    const weird = "Para esta edição, eu (o editor) enviei 0 submissões.";
    assert.equal(reconcileCoverageCount(weird, 12), weird);
  });

  it("string vazia → retorna vazia (sem crash)", () => {
    assert.equal(reconcileCoverageCount("", 12), "");
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
    assert.match(html, /^<!-- INTRO \(coverage\) -->/);
    assert.match(html, /<tr><td/);
    assert.match(html, /enviei 5 submissões/);
    // HTML escape do & → &amp; (segurança contra injection de entities)
    // #2532: a marca "Diar.ia" renderiza como wordmark diar.ia.br (pontos teal);
    // o escape do & precede o wordmark, garantindo que ambos coexistem.
    assert.match(html, /&amp; a <strong>diar<span style="color:#00A0A0">\.<\/span>ia<span style="color:#00A0A0">\.br<\/span><\/strong> encontrou/);
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
    // Confirma que tem o comment marcador (#1936: INTRO)
    assert.match(html, /<!-- INTRO \(coverage\) -->/);
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

  it("renderiza LANÇAMENTO singular quando seção tem 1 item (#1324, #1936: sem emoji)", () => {
    const html = renderHTML(fixt([
      { name: "LANÇAMENTOS", items: [{ title: "Foo", description: "Bar", url: "https://example.com/x" }] },
    ]));
    // #1936: kicker do DS — emoji removido, label no `&nbsp;…</td>`.
    assert.match(html, /&nbsp;LANÇAMENTO<\/td>/u);
    assert.doesNotMatch(html, /&nbsp;LANÇAMENTOS<\/td>/u);
  });

  it("mantém LANÇAMENTOS plural quando seção tem 2 items (#1328)", () => {
    const html = renderHTML(fixt([
      { name: "LANÇAMENTOS", items: [
        { title: "A", description: "x", url: "https://example.com/a" },
        { title: "B", description: "y", url: "https://example.com/b" },
      ] },
    ]));
    assert.match(html, /&nbsp;LANÇAMENTOS<\/td>/u);
  });

  it("renderiza OUTRA NOTÍCIA singular quando seção tem 1 item (#1324, #1936: sem emoji)", () => {
    const html = renderHTML(fixt([
      { name: "OUTRAS NOTÍCIAS", items: [{ title: "Foo", description: "Bar", url: "https://example.com/x" }] },
    ]));
    assert.match(html, /&nbsp;OUTRA NOTÍCIA<\/td>/u);
    assert.doesNotMatch(html, /&nbsp;OUTRAS NOTÍCIAS<\/td>/u);
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

describe("renderLeaderboardTop1Row top1 fallback (#1672)", () => {
  const PARA = "margin:0;";
  it("top1 com 3 empatados em 1º → todos '1º', não fabrica 2º/3º", () => {
    const eia: any = {
      leaderboardTop1: [
        { nickname: "Ana", pct: 100, correct: 5, total: 5 },
        { nickname: "Bruno", pct: 100, correct: 5, total: 5 },
        { nickname: "Caio", pct: 100, correct: 5, total: 5 },
      ],
      leaderboardPeriod: "maio",
    };
    const html = renderLeaderboardTop1Row(eia, PARA);
    assert.match(html, /1º Ana/);
    assert.match(html, /1º Bruno/);
    assert.match(html, /1º Caio/);
    assert.doesNotMatch(html, /2º/, "não deve fabricar 2º pra empatados em 1º");
    assert.doesNotMatch(html, /3º/, "não deve fabricar 3º pra empatados em 1º");
  });

  it("podium (ranks reais) preferido sobre top1 — preserva 1º/2º/3º", () => {
    const eia: any = {
      leaderboardPodium: [
        { nickname: "Ana", rank: 1 },
        { nickname: "Bruno", rank: 2 },
        { nickname: "Caio", rank: 3 },
      ],
      leaderboardTop1: [{ nickname: "X", pct: 100, correct: 5, total: 5 }],
    };
    const html = renderLeaderboardTop1Row(eia, PARA);
    assert.match(html, /1º Ana/);
    assert.match(html, /2º Bruno/);
    assert.match(html, /3º Caio/);
  });
});

// ── #2316 — 2-destaque render regression ─────────────────────────────────────

describe("#2316: extractContent aceita 2 destaques + renderHTML produz HTML coerente", () => {
  const twoDestaquesMd = [
    "**DESTAQUE 1 | LANÇAMENTO**",
    "",
    "**[IA chega às fábricas brasileiras](https://example.com/1)**",
    "",
    "Corpo do primeiro destaque com contexto suficiente.",
    "",
    "Por que isso importa: automatização industrial tem impacto direto no emprego.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | PESQUISA**",
    "",
    "**[Modelos de linguagem superam humanos em diagnóstico](https://example.com/2)**",
    "",
    "Corpo do segundo destaque.",
    "",
    "Por que isso importa: abre caminho para triagem automatizada em clínicas.",
    "",
  ].join("\n");

  it("extractContent não lança para 2 destaques", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-2dest-"));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), twoDestaquesMd, "utf8");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      // Não deve lançar — antes lançaria 'Expected 3 destaques, got 2'
      assert.doesNotThrow(() => extractContent(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renderHTML com 2 destaques produz HTML com cover + 2 heroes + subtitle só de D2", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-2dest-render-"));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), twoDestaquesMd, "utf8");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const content = extractContent(dir);

      // 2 destaques, não 3
      assert.equal(content.destaques.length, 2);

      // Title = D1, subtitle = D2 (sem " | D3")
      assert.equal(content.title, "IA chega às fábricas brasileiras");
      assert.equal(content.subtitle, "Modelos de linguagem superam humanos em diagnóstico");
      assert.ok(!content.subtitle.includes("|"), "subtitle sem separador | quando só 2 destaques");

      // HTML não lança e contém as 2 manchetes
      const html = renderHTML(content);
      assert.match(html, /IA chega às fábricas brasileiras/);
      assert.match(html, /Modelos de linguagem superam humanos em diagnóstico/);

      // Cover image (D1 2x1) presente
      assert.match(html, /\{\{IMG:04-d1-2x1\.jpg\}\}/);
      // D2 hero presente
      assert.match(html, /\{\{IMG:04-d2-2x1\.jpg\}\}/);
      // D3 hero ausente (não há terceiro destaque)
      assert.doesNotMatch(html, /\{\{IMG:04-d3-2x1\.jpg\}\}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderBodyParasInner — inter-parágrafo 8px (#2456)", () => {
  it("1º parágrafo tem margin-top 18px (espaço após manchete/hero)", () => {
    const html = renderBodyParasInner("Parágrafo único.");
    assert.match(html, /margin:18px 0 0/, "1º <p> deve ter margin-top 18px");
  });

  it("2º+ parágrafos têm margin-top 8px (#2456 — reduzido de 16px)", () => {
    const html = renderBodyParasInner("Parágrafo 1.\n\nParágrafo 2.\n\nParágrafo 3.");
    // Conta ocorrências de 8px 0 0 (deve haver 2: parágrafos 2 e 3)
    const matches = html.match(/margin:8px 0 0/g);
    assert.ok(matches && matches.length === 2, `esperava 2 ocorrências de margin:8px 0 0, got ${matches?.length ?? 0}: ${html}`);
    // Garante que 16px NÃO aparece mais (regressão do valor antigo)
    assert.doesNotMatch(html, /margin:16px 0 0/, "margem antiga 16px não deve mais aparecer");
  });

  it("parágrafo único: só 18px, sem nenhum 8px nem 16px", () => {
    // Guard: a margem 8px é EXCLUSIVA de parágrafos 2º+. Corpo de 1 parágrafo
    // não pode emitir 8px (regressão se a condição i===0 inverter).
    const html = renderBodyParasInner("Único.");
    assert.doesNotMatch(html, /margin:8px 0 0/, "1 parágrafo não deve ter margem inter-parágrafo");
    assert.doesNotMatch(html, /margin:16px 0 0/);
  });

  it("box 'Por que isso importa' NÃO é afetado: mantém margin-top:28px + <p> margin:0", () => {
    // renderWhyBoxInner é independente de renderBodyParasInner. O bug #2456 era
    // só nos parágrafos de corpo dos destaques — o box why deve preservar seu
    // espaçamento. Testa o helper direto (exportado), sem full render.
    const html = renderWhyBoxInner("Razão do destaque.");
    assert.match(html, /margin-top:28px/, "box why mantém margin-top:28px (separação do corpo acima)");
    // o <p> interno do box usa margin:0 (não herda 8px/16px do corpo)
    assert.doesNotMatch(html, /margin:8px 0 0/, "box why não deve emitir a margem de corpo");
    assert.doesNotMatch(html, /margin:16px 0 0/);
  });

  it("integração renderHTML: corpo 8px e box why 28px coexistem (sem EIA na fixture)", () => {
    // Fixture sem EIA (eia.credit vazio → seção É IA? omitida), então o
    // `margin:8px 0 0` do lbStyle do leaderboard NÃO aparece. Assim a contagem
    // de 8px reflete EXCLUSIVAMENTE os parágrafos de corpo (2 destaques × 1
    // parágrafo extra cada = 2), tornando a asserção exata e não-frágil.
    const baseDestaque = {
      n: 1 as const,
      category: "LANÇAMENTO",
      title: "Título",
      body: "Parágrafo A.\n\nParágrafo B.",
      why: "Por que isso importa.",
      url: "https://example.com/d1",
      emoji: "🚀",
    };
    const content = {
      title: "X",
      subtitle: "X",
      coverImage: "04-d1-2x1.jpg",
      destaques: [
        baseDestaque,
        { ...baseDestaque, n: 2 as const, url: "https://example.com/d2" },
      ],
      eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
      sections: [],
    };
    const html = renderHTML(content);
    // Sem EIA → o único produtor de `margin:8px 0 0` são os 2º parágrafos de
    // corpo (1 por destaque = 2). Contagem exata, não >= (guard anti-fragilidade).
    assert.doesNotMatch(html, /Clique na imagem que foi gerada por IA/, "fixture não deve ter É IA?");
    const bodyMatches = html.match(/margin:8px 0 0/g);
    assert.ok(
      bodyMatches && bodyMatches.length === 2,
      `esperava exatamente 2 margin:8px 0 0 (2º parágrafo de cada destaque), got ${bodyMatches?.length ?? 0}`,
    );
    // box "Por que isso importa" preserva margin-top:28px (não afetado)
    assert.match(html, /margin-top:28px/);
    assert.doesNotMatch(html, /margin:16px 0 0/, "valor antigo não deve aparecer no render completo");
  });
});

describe("DS_STYLE_BLOCK — padding lateral mobile (#2514)", () => {
  it("usa .pad de 12px no mobile (max-width:480px), não 24px", () => {
    // #2514 (pedido do editor 260623): o corpo aparecia estreito demais no celular
    // por causa do padding lateral de 24px. Reduzido para 12px para usar mais
    // largura horizontal. Desktop continua 32px (inline nos helpers PAD_*).
    assert.match(
      DS_STYLE_BLOCK,
      /\.pad\s*\{\s*padding-left:12px\s*!important;\s*padding-right:12px\s*!important;\s*\}/,
      "mobile .pad deve ser 12px (#2514)",
    );
    assert.doesNotMatch(
      DS_STYLE_BLOCK,
      /padding-left:24px\s*!important;\s*padding-right:24px/,
      "mobile .pad não deve mais ser 24px",
    );
  });
});

describe("applyBrandWordmark (#2532 — Diar.ia → diar.ia.br teal)", () => {
  // #2674: wordmark agora em <strong> (negrito) — `.` e `.br` no teal.
  const WM =
    '<strong>diar<span style="color:#00A0A0">.</span>ia<span style="color:#00A0A0">.br</span></strong>';

  it("token da marca em texto puro → wordmark com pontos teal", () => {
    assert.equal(applyBrandWordmark("a Diar.ia encontrou"), `a ${WM} encontrou`);
  });

  it("os separadores '.' e '.br' ficam teal; 'diar'/'ia' ficam ink (sem span)", () => {
    const out = applyBrandWordmark("Diar.ia");
    assert.equal(out, WM);
    // exatamente 2 spans teal (o '.' e o '.br'), nada mais.
    assert.equal((out.match(/<span style="color:#00A0A0">/g) || []).length, 2);
  });

  it("caso bold: <b>Diar.ia</b> (pós-** do mdInlineToHtml) → <b>{wordmark}</b>", () => {
    assert.equal(applyBrandWordmark("<b>Diar.ia</b>"), `<b>${WM}</b>`);
  });

  it("NÃO casa URL lowercase diar.ia.br (domínio já existente)", () => {
    const url = 'href="https://diar.ia.br/p/post"';
    assert.equal(applyBrandWordmark(url), url);
  });

  it("#2674: casa 'diar.ia.br' minúsculo em PROSA (ex: linha de comissão)", () => {
    assert.equal(
      applyBrandWordmark("a diar.ia.br recebe comissão"),
      `a ${WM} recebe comissão`,
    );
    // entre `**` (negrito do MD) também casa
    assert.equal(applyBrandWordmark("da **diar.ia.br**"), `da **${WM}**`);
  });

  it("#2674: URL-safe — diar.ia.br precedido por / ou . ou seguido por /path NÃO casa", () => {
    assert.equal(applyBrandWordmark("www.diar.ia.br"), "www.diar.ia.br");
    assert.equal(applyBrandWordmark("visite diar.ia.br/livros hoje"), "visite diar.ia.br/livros hoje");
    assert.equal(applyBrandWordmark("user@diar.ia.br"), "user@diar.ia.br");
  });

  it("NÃO casa 'diaria' sem ponto (livros.diaria.workers.dev)", () => {
    const url = "https://livros.diaria.workers.dev";
    assert.equal(applyBrandWordmark(url), url);
  });

  it("NÃO casa o comentário HTML <!-- Diar.ia newsletter body --> não é entrada das primitivas, mas o regex tampouco quebra se aparecer parcial sem boundary", () => {
    // 'Diaria' (sem ponto) e 'Diar.iax' (sufixo) não casam o token \bDiar\.ia\b.
    assert.equal(applyBrandWordmark("Diaria"), "Diaria");
    assert.equal(applyBrandWordmark("Diar.iax"), "Diar.iax");
  });

  it("idempotente — re-aplicar no output lowercase não re-transforma", () => {
    const once = applyBrandWordmark("da Diar.ia,");
    assert.equal(applyBrandWordmark(once), once);
  });

  it("#2533: 'Diar.ia.br' capital absorve o sufixo .br — 1 wordmark, sem '.br' duplicado", () => {
    const out = applyBrandWordmark("Visite o Diar.ia.br hoje");
    assert.equal(out, `Visite o ${WM} hoje`);
    // guard explícito contra a regressão do '.br.br'
    assert.doesNotMatch(out, /\.br<\/span>\.br/);
  });

  it("#2533: 'Diar.ia' em fim de frase (seguido de '.') ainda casa", () => {
    assert.equal(applyBrandWordmark("uma edição da Diar.ia."), `uma edição da ${WM}.`);
  });

  it("#2533: mdInlineToHtml NÃO brandmarka o label de [Diar.ia](url) — só o texto fora do link", () => {
    const out = mdInlineToHtml("Diar.ia: veja [Diar.ia](https://diar.ia.br) agora");
    // texto fora do link vira wordmark
    assert.ok(out.includes(`${WM}: veja`), "texto antes do link é wordmark");
    // label dentro do <a> permanece literal "Diar.ia" (simétrico com processInlineLinks)
    assert.match(out, /<a [^>]*>Diar\.ia<\/a>/, "label do link permanece plain");
    // href lowercase intacto
    assert.match(out, /href="https:\/\/diar\.ia\.br"/, "href intacto");
  });

  it("múltiplas ocorrências numa string", () => {
    assert.equal(
      applyBrandWordmark("Diar.ia e Diar.ia"),
      `${WM} e ${WM}`,
    );
  });

  it("integração processInlineLinks: marca no texto vira wordmark, URL do link intacta", () => {
    const out = processInlineLinks(
      "A Diar.ia mantém [livros](https://livros.diaria.workers.dev).",
    );
    assert.ok(out.includes(WM), "wordmark no texto");
    assert.ok(
      out.includes('href="https://livros.diaria.workers.dev"'),
      "URL do link preservada (sem span injetado)",
    );
  });

  it("integração renderCoverage (escText): coverage com a marca renderiza wordmark", () => {
    const out = renderCoverage("Para esta edição, a Diar.ia encontrou 12 artigos.");
    assert.ok(out.includes(WM), "wordmark na coverage line");
  });
});
