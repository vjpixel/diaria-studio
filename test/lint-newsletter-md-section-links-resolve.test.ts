/**
 * lint-newsletter-md-section-links-resolve.test.ts (#3821)
 *
 * Regressão: item de seção secundária que degrada pro fallback legado de
 * `parseListItems` (formato não reconhecido por nenhum branch do parser
 * real) deve disparar o check `--check section-links-resolve`
 * (GATE-BLOCKING).
 *
 * Caso real (260722): item de VÍDEOS escrito seguindo o template ANTES do
 * fix — `**[Título do Vídeo]** — [Canal](URL)` (2 pares `[texto](...)` na
 * mesma linha, o primeiro sem URL própria) não bate em nenhum branch de
 * `parseListItems`. Cada linha do bloco virou um item quebrado (`title` =
 * texto cru com colchetes/asteriscos literais, `url: ""`, `description: ""`)
 * — os lints existentes (`video-links-are-youtube`,
 * `secondary-items-have-summary`, `section-item-format`) passaram "ok" nesse
 * item quebrado porque usam regex/extração permissiva, não o parser real.
 *
 * Este lint roda `parseSections` (importado, não reimplementado) e falha se
 * QUALQUER item de seção secundária sair com `url` vazia — pega o caso
 * específico de VÍDEOS acima e qualquer degradação futura do mesmo tipo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkSectionLinksResolve } from "../scripts/lint-newsletter-md.ts";

describe("checkSectionLinksResolve — CENÁRIO REAL #3821", () => {
  it("acusa item VÍDEOS no formato pré-fix (2 links na mesma linha, blank line até a descrição)", () => {
    const md = [
      "**📺 VÍDEOS**",
      "",
      "**[Pesquisadores estudam o real impacto das demissões por IA]** — [BBC Global](https://youtube.com/c/bbcglobal)",
      "",
      "Pesquisadores analisam o real impacto das demissões causadas por IA no mercado.",
      "",
      "---",
    ].join("\n");

    const result = checkSectionLinksResolve(md);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 1, JSON.stringify(result));
    assert.equal(result.errors[0].section, "VÍDEOS");
  });

  it("passa quando o item VÍDEOS já usa o formato corrigido (#3821): link único no título + canal como prefixo da descrição, sem blank line entre título e descrição", () => {
    const md = [
      "**📺 VÍDEOS**",
      "",
      "**[Pesquisadores estudam o real impacto das demissões por IA](https://youtube.com/watch?v=xyz)**",
      "BBC Global — Pesquisadores analisam o real impacto das demissões causadas por IA no mercado.",
      "",
      "---",
    ].join("\n");

    const result = checkSectionLinksResolve(md);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.errors.length, 0);
  });
});

describe("checkSectionLinksResolve — não dá falso positivo em formatos corretos já existentes", () => {
  it("LANÇAMENTOS no formato canônico (título + descrição em linhas adjacentes)", () => {
    const md = [
      "**🚀 LANÇAMENTOS**",
      "",
      "**[Agentes Claude para serviços financeiros](https://www.anthropic.com/news/finance-agents)**",
      "Anthropic lança dez novos plugins para Cowork e Claude Code.",
      "",
      "**[Gemini Robotics-ER 1.6](https://deepmind.google/blog/gemini-robotics-er-1-6/)**",
      "DeepMind lançou nova versão do modelo de robótica.",
      "",
      "---",
    ].join("\n");

    const result = checkSectionLinksResolve(md);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("RADAR no formato canônico", () => {
    const md = [
      "**📡 RADAR**",
      "",
      "**[Notícia genérica](https://news.com/x)**",
      "Resumo da notícia.",
      "",
      "---",
    ].join("\n");

    const result = checkSectionLinksResolve(md);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("USE MELHOR no formato canônico (com tempo estimado entre parênteses)", () => {
    const md = [
      "**🛠️ USE MELHOR**",
      "",
      "**[Como usar o Claude Code](https://anthropic.com/claude-code)**",
      "Guia rápido de setup (5 min).",
      "",
      "---",
    ].join("\n");

    const result = checkSectionLinksResolve(md);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("formato legacy (Título / Descrição / URL em linhas separadas, sem blank entre elas) continua ok", () => {
    const md = [
      "**🚀 LANÇAMENTOS**",
      "",
      "Item legado",
      "Descrição do item legado.",
      "https://legacy.example.com/x",
      "",
      "---",
    ].join("\n");

    const result = checkSectionLinksResolve(md);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("ok=true quando não há nenhuma seção secundária no MD", () => {
    const md = "DESTAQUE 1 | 🚀 LANÇAMENTO\n\nTítulo\n\nhttps://x.com/y\n\nCorpo.\n";
    const result = checkSectionLinksResolve(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("multi-item VÍDEOS corrigido: 2 vídeos, ambos com url populada", () => {
    const md = [
      "**📺 VÍDEOS**",
      "",
      "**[Título A](https://youtube.com/watch?v=a)**",
      "Canal A — Frase A.",
      "",
      "**[Título B](https://youtube.com/watch?v=b)**",
      "Canal B — Frase B.",
      "",
      "---",
    ].join("\n");

    const result = checkSectionLinksResolve(md);
    assert.equal(result.ok, true, JSON.stringify(result));
  });
});
