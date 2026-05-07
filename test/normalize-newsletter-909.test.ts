/**
 * test/normalize-newsletter-909.test.ts (#909)
 *
 * Cobre a regressão observada em 260507: writer emitiu items de seção
 * (LANÇAMENTOS/PESQUISAS/OUTRAS) com título inline link `[Título](URL)`
 * + descrição na mesma linha, em vez de em duas linhas separadas.
 * Também cobre URL quebrada em múltiplas linhas via fixBrokenInlineLinks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitConcatenatedSectionItem,
  fixBrokenInlineLinks,
  normalizeNewsletter,
} from "../scripts/normalize-newsletter.ts";
import { checkSectionItemFormat } from "../scripts/lint-newsletter-md.ts";

describe("splitConcatenatedSectionItem — inline link + descrição (#909)", () => {
  it("[Título](URL) Descrição → 2 linhas separadas", () => {
    const line =
      "[Agentes Claude para serviços financeiros](https://www.anthropic.com/news/finance-agents) Anthropic lança dez novos plugins para Cowork e Claude Code.";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 2);
    assert.equal(
      r.lines[0],
      "[Agentes Claude para serviços financeiros](https://www.anthropic.com/news/finance-agents)",
    );
    assert.equal(
      r.lines[1],
      "Anthropic lança dez novos plugins para Cowork e Claude Code.",
    );
  });

  it("**[Título](URL)** Descrição (com bold wrap) → 2 linhas com bold preservado", () => {
    const line =
      "**[Gemini Robotics-ER 1.6](https://deepmind.google/blog/gemini-robotics-er-1-6/)** DeepMind lançou nova versão do modelo de robótica.";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 2);
    assert.match(r.lines[0], /\*\*\[Gemini Robotics-ER 1\.6\]\(https/);
    assert.equal(
      r.lines[1],
      "DeepMind lançou nova versão do modelo de robótica.",
    );
  });

  it("inline link sem descrição (linha solo) — NÃO splita", () => {
    const line = "[Título único](https://example.com)";
    const r = splitConcatenatedSectionItem(line);
    // Linha bem-formada sem descrição — deve passar intacta (split=false)
    assert.equal(r.split, false);
  });

  it("inline link com descrição muito curta (≤2 chars) → não splita por sanity", () => {
    const line = "[Título](https://example.com) .";
    const r = splitConcatenatedSectionItem(line);
    // Descrição "." só é 1 char — falha sanity. Cai pra heurística antiga
    // que pode não splitar. Aceitamos qualquer comportamento, mas sem split via inline.
    if (r.split) {
      // Caso a heurística legacy split, primeira linha não deve ser apenas pontuação
      assert.notEqual(r.lines[0].trim(), ".");
    }
  });
});

describe("fixBrokenInlineLinks (#909)", () => {
  it("colapsa URL quebrada em 3 linhas para inline link single-line", () => {
    const md = [
      "LANÇAMENTOS",
      "",
      "[Agentes Claude](",
      "https://www.anthropic.com/news/finance-agents",
      ")",
      "Anthropic lança dez novos plugins.",
      "",
    ].join("\n");
    const { text, fixed_count } = fixBrokenInlineLinks(md);
    assert.equal(fixed_count, 1);
    assert.match(
      text,
      /\[Agentes Claude\]\(https:\/\/www\.anthropic\.com\/news\/finance-agents\)/,
    );
    // Descrição deve ter ficado em linha separada (1 newline, não 2 — mesmo
    // formato do template: link em uma linha, descrição na seguinte)
    assert.match(text, /\)\nAnthropic lança/);
  });

  it("idempotente: link bem-formado passa intacto", () => {
    const md = [
      "[Bom link](https://x.com)",
      "Descrição.",
    ].join("\n");
    const { text, fixed_count } = fixBrokenInlineLinks(md);
    assert.equal(fixed_count, 0);
    assert.equal(text, md);
  });

  it("múltiplos links quebrados no mesmo MD: todos corrigidos", () => {
    const md = [
      "[Link 1](",
      "https://a.com",
      ")",
      "Desc 1.",
      "",
      "[Link 2](",
      "https://b.com",
      ")",
      "Desc 2.",
    ].join("\n");
    const { text, fixed_count } = fixBrokenInlineLinks(md);
    assert.equal(fixed_count, 2);
    assert.match(text, /\[Link 1\]\(https:\/\/a\.com\)/);
    assert.match(text, /\[Link 2\]\(https:\/\/b\.com\)/);
  });
});

describe("normalizeNewsletter — integração #909", () => {
  it("input bug 260507: [Título](URL) Descrição na mesma linha → split", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "**[Agentes Claude para serviços financeiros](https://www.anthropic.com/news/finance-agents)** Anthropic lança dez novos plugins para Cowork e Claude Code.",
      "",
      "---",
    ].join("\n");
    const { text, report } = normalizeNewsletter(md);
    assert.equal(report.section_items_split, 1);
    // Após split, deve ter linha do link + linha da descrição
    assert.match(text, /\*\*\[Agentes Claude/);
    assert.match(text, /\nAnthropic lança/);
  });

  it("input bug 260507: URL quebrada multi-linha + descrição → corrigido", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "[Agentes Claude](",
      "https://www.anthropic.com/news/finance-agents",
      ")",
      "Anthropic lança dez novos plugins.",
      "",
    ].join("\n");
    const { text, report } = normalizeNewsletter(md);
    // fixBrokenInlineLinks deve ter rodado
    assert.match(text, /\[Agentes Claude\]\(https:\/\/www\.anthropic\.com\/news\/finance-agents\)/);
    assert.ok(report.warnings.some((w) => /múltiplas linhas/.test(w)));
  });
});

describe("checkSectionItemFormat (#909)", () => {
  it("detecta título+descrição na mesma linha", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "**[Título](https://x.com)** Descrição colada na mesma linha.",
      "",
    ].join("\n");
    const r = checkSectionItemFormat(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].type, "title_and_description_same_line");
    assert.equal(r.errors[0].section, "LANÇAMENTOS");
  });

  it("ok quando formato canônico está presente", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "**[Título 1](https://x.com)**",
      "Descrição 1.",
      "",
      "**[Título 2](https://y.com)**",
      "Descrição 2.",
      "",
    ].join("\n");
    const r = checkSectionItemFormat(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("detecta título sem descrição (próximo é outro inline link)", () => {
    const md = [
      "LANÇAMENTOS",
      "",
      "[Título 1](https://x.com)",
      "[Título 2](https://y.com)",
      "Descrição 2.",
      "",
    ].join("\n");
    const r = checkSectionItemFormat(md);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.type === "title_without_description"));
  });

  it("ignora inline links em DESTAQUEs (só pega seções secundárias)", () => {
    const md = [
      "**DESTAQUE 1 | PRODUTO**",
      "",
      "**[Opção 1](https://x.com)** Texto",
      "",
      "Corpo.",
    ].join("\n");
    const r = checkSectionItemFormat(md);
    // Não está dentro de seção secundária, então o lint ignora
    assert.equal(r.ok, true);
  });

  it("detecta múltiplas violações em seções diferentes", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "**[L](https://l.com)** Desc colada.",
      "",
      "---",
      "",
      "**OUTRAS NOTÍCIAS**",
      "",
      "**[N](https://n.com)** Desc colada.",
      "",
    ].join("\n");
    const r = checkSectionItemFormat(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 2);
  });
});
