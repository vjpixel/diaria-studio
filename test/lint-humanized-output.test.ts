/**
 * test/lint-humanized-output.test.ts (#1439)
 *
 * Cobre `computeHumanizerMetrics` e `compareHumanizerOutput` — lint defensivo
 * que detecta regressões estruturais do humanizador (perda de trailing 2-space,
 * remoção de section headers, mudança de aninhação bold+link, etc).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeHumanizerMetrics,
  compareHumanizerOutput,
} from "../scripts/lint-humanized-output.ts";

describe("computeHumanizerMetrics (#1439)", () => {
  it("conta linhas com trailing 2 espaços", () => {
    const md = "Linha 1  \nLinha 2  \nLinha 3 sem trailing\nLinha 4  ";
    const m = computeHumanizerMetrics(md);
    assert.equal(m.trailing_2space_lines, 3);
  });

  it("conta aninhação **[Title](url)**", () => {
    const md = "**[A](https://x.com/a)** texto **[B](https://x.com/b)**";
    const m = computeHumanizerMetrics(md);
    assert.equal(m.bold_link_nesting, 2);
  });

  it("conta [**Title**](url) separadamente", () => {
    const md = "[**A**](https://x.com/a) e [**B**](https://x.com/b)";
    const m = computeHumanizerMetrics(md);
    assert.equal(m.link_with_inner_bold, 2);
    assert.equal(m.bold_link_nesting, 0);
  });

  it("detecta frontmatter YAML", () => {
    const md = "---\ntitle: x\n---\n\nBody";
    const m = computeHumanizerMetrics(md);
    assert.equal(m.has_frontmatter, true);
  });

  it("frontmatter ausente retorna false", () => {
    const md = "Body sem frontmatter";
    const m = computeHumanizerMetrics(md);
    assert.equal(m.has_frontmatter, false);
  });

  it("conta section headers fixos (SORTEIO/ASSINE/ERRO INTENCIONAL/PARA ENCERRAR/TÍTULO/SUBTÍTULO)", () => {
    const md = [
      "**🎁 SORTEIO**",
      "x",
      "**🙋🏼‍♀️ PARA ENCERRAR**",
      "y",
      "**ERRO INTENCIONAL**",
      "z",
      "**ASSINE**",
      "w",
    ].join("\n");
    const m = computeHumanizerMetrics(md);
    assert.equal(m.fixed_section_headers, 4);
  });

  it("conta section headers principais (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS)", () => {
    const md = [
      "**🚀 LANÇAMENTOS**",
      "x",
      "**🔬 PESQUISAS**",
      "y",
      "**📰 OUTRAS NOTÍCIAS**",
      "z",
    ].join("\n");
    const m = computeHumanizerMetrics(md);
    assert.equal(m.main_section_headers, 3);
  });

  it("section header detection ignora conteúdo dentro de [...] (não confunde título com header)", () => {
    const md = [
      "**[Título A com OUTRAS NOTÍCIAS no meio](https://x.com/a)**",
      "",
      "**📰 OUTRAS NOTÍCIAS**",
    ].join("\n");
    const m = computeHumanizerMetrics(md);
    assert.equal(m.main_section_headers, 1, "só o header de seção real conta");
  });
});

describe("compareHumanizerOutput (#1439)", () => {
  it("OK quando métricas estão idênticas", () => {
    const md = "**[A](https://x.com/a)**  \nDesc  ";
    const r = compareHumanizerOutput(md, md);
    assert.equal(r.ok, true);
    assert.equal(r.violations.length, 0);
  });

  it("FLAGS quando humanizador perde 7 trailing 2-space (caso 260521)", () => {
    const pre = Array.from({ length: 16 }, (_, i) => `**[Item ${i}](https://x.com/${i})**  `).join("\n");
    const post = pre.replace(/  $/gm, "").split("\n").slice(0, 9).join("\n") + "\n";
    // Restore só 9 com trailing
    const post9 = Array.from({ length: 9 }, (_, i) => `**[Item ${i}](https://x.com/${i})**  `).join("\n");
    const r = compareHumanizerOutput(pre, post9);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => /trailing-whitespace-loss/.test(v)));
    assert.match(r.violations[0], /pre=16/);
    assert.match(r.violations[0], /post=9/);
  });

  it("OK quando trailing loss está dentro da tolerância (default 2)", () => {
    const pre = "L1  \nL2  \nL3  \nL4  ";
    const post = "L1  \nL2  \nL3 sem trailing\nL4"; // perdeu 2 — exatamente tolerância
    const r = compareHumanizerOutput(pre, post);
    assert.equal(r.ok, true);
  });

  it("FLAGS perda de frontmatter", () => {
    const pre = "---\ntitle: x\n---\n\nBody";
    const post = "Body sem frontmatter";
    const r = compareHumanizerOutput(pre, post);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => /frontmatter-loss/.test(v)));
  });

  it("FLAGS perda de section header fixo", () => {
    const pre = "**🎁 SORTEIO**\n\nx\n\n**ASSINE**\n\ny";
    const post = "x\n\ny"; // headers sumiram
    const r = compareHumanizerOutput(pre, post);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => /fixed-section-header-loss/.test(v)));
  });

  it("FLAGS perda de main section header", () => {
    const pre = "**🚀 LANÇAMENTOS**\nx\n**🔬 PESQUISAS**\ny";
    const post = "x\ny";
    const r = compareHumanizerOutput(pre, post);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => /main-section-header-loss/.test(v)));
  });

  it("OK quando humanizador troca **[X](url)** por [**X**](url) — equivalente em renderer", () => {
    const pre = "**[A](https://x.com/a)** **[B](https://x.com/b)**";
    const post = "[**A**](https://x.com/a) [**B**](https://x.com/b)";
    const r = compareHumanizerOutput(pre, post);
    // Total combinado preservado (2 → 2) → ok
    assert.equal(r.ok, true);
  });

  it("FLAGS quando humanizador remove bold-link nesting por completo", () => {
    const pre = "**[A](https://x.com/a)** **[B](https://x.com/b)** **[C](https://x.com/c)**";
    const post = "[A](https://x.com/a) [B](https://x.com/b) [C](https://x.com/c)";
    // perda de 3 (acima do default tolerance 1)
    const r = compareHumanizerOutput(pre, post);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => /bold-link-nesting-loss/.test(v)));
  });

  it("opts: max_trailing_loss customizável", () => {
    const pre = "L1  \nL2  \nL3  \nL4  \nL5  ";
    const post = "L1\nL2\nL3\nL4\nL5"; // perdeu 5
    const looseR = compareHumanizerOutput(pre, post, { max_trailing_loss: 10 });
    assert.equal(looseR.ok, true);
    const strictR = compareHumanizerOutput(pre, post, { max_trailing_loss: 0 });
    assert.equal(strictR.ok, false);
  });

  it("opts: max_bold_link_nesting_loss customizável", () => {
    const pre = "**[A](https://x.com/a)** **[B](https://x.com/b)**";
    const post = "A B"; // perdeu 2 nestings
    const looseR = compareHumanizerOutput(pre, post, { max_bold_link_nesting_loss: 5 });
    assert.equal(looseR.ok, true);
    const strictR = compareHumanizerOutput(pre, post, { max_bold_link_nesting_loss: 0 });
    assert.equal(strictR.ok, false);
  });
});
