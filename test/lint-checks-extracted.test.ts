/**
 * test/lint-checks-extracted.test.ts (#1737 item 2)
 *
 * Guarda a extração dos checks de lint-newsletter-md.ts pra módulos por-check
 * em scripts/lib/lint-checks/. Garante que (a) os módulos são auto-contidos e
 * importáveis direto, e (b) o re-export de back-compat de lint-newsletter-md.ts
 * aponta pra MESMA função (não uma cópia divergente).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  lintMultilineLinks as mlDirect,
} from "../scripts/lib/lint-checks/multiline-links.ts";
import {
  lintRelativeTime as rtDirect,
} from "../scripts/lib/lint-checks/relative-time.ts";
import {
  checkWhyMattersFormat as wmDirect,
} from "../scripts/lib/lint-checks/why-matters-format.ts";
import {
  checkEaiSection as eaiDirect,
} from "../scripts/lib/lint-checks/eai-section.ts";
import {
  checkCoverageLine as covDirect,
} from "../scripts/lib/lint-checks/coverage-line-format.ts";
import {
  checkDestaqueMinChars as minDirect,
  checkDestaqueMaxChars as maxDirect,
} from "../scripts/lib/lint-checks/destaque-chars.ts";
import {
  countTitlesPerHighlight as titlesDirect,
} from "../scripts/lib/lint-checks/titles-per-highlight.ts";
import {
  checkTitleLengths as tlenDirect,
} from "../scripts/lib/lint-checks/title-length.ts";
import {
  checkEiaAnswer as eiaAnsDirect,
} from "../scripts/lib/lint-checks/eia-answer-check.ts";
import {
  checkIntentionalError as ieDirect,
  extractFrontmatter as efDirect,
} from "../scripts/lib/lint-checks/intentional-error.ts";
import {
  checkSectionItemFormat as sifDirect,
} from "../scripts/lib/lint-checks/section-item-format.ts";
import {
  lintNewsletter as lnDirect,
  extractUrlsBySection as eubDirect,
  checkSectionCounts as scDirect,
} from "../scripts/lib/lint-checks/url-bucket.ts";
import {
  lintMultilineLinks as mlReexport,
  lintRelativeTime as rtReexport,
  checkWhyMattersFormat as wmReexport,
  checkEaiSection as eaiReexport,
  checkCoverageLine as covReexport,
  checkDestaqueMinChars as minReexport,
  checkDestaqueMaxChars as maxReexport,
  countTitlesPerHighlight as titlesReexport,
  checkTitleLengths as tlenReexport,
  checkEiaAnswer as eiaAnsReexport,
  checkIntentionalError as ieReexport,
  extractFrontmatter as efReexport,
  checkSectionItemFormat as sifReexport,
  lintNewsletter as lnReexport,
  extractUrlsBySection as eubReexport,
  checkSectionCounts as scReexport,
} from "../scripts/lint-newsletter-md.ts";

describe("lint-checks extraídos (#1737 item 2)", () => {
  it("re-export de lint-newsletter-md é a MESMA função do módulo", () => {
    assert.strictEqual(mlReexport, mlDirect);
    assert.strictEqual(rtReexport, rtDirect);
    assert.strictEqual(wmReexport, wmDirect);
    assert.strictEqual(eaiReexport, eaiDirect);
    assert.strictEqual(covReexport, covDirect);
    assert.strictEqual(minReexport, minDirect);
    assert.strictEqual(maxReexport, maxDirect);
    assert.strictEqual(titlesReexport, titlesDirect);
    assert.strictEqual(tlenReexport, tlenDirect);
    assert.strictEqual(eiaAnsReexport, eiaAnsDirect);
    assert.strictEqual(ieReexport, ieDirect);
    assert.strictEqual(efReexport, efDirect);
    assert.strictEqual(sifReexport, sifDirect);
    assert.strictEqual(lnReexport, lnDirect);
    assert.strictEqual(eubReexport, eubDirect);
    assert.strictEqual(scReexport, scDirect);
  });

  it("multiline-links: módulo auto-contido funciona standalone", () => {
    const broken = "[Label](\nhttps://example.com\n)";
    assert.equal(mlDirect(broken).ok, false);
    assert.equal(mlDirect("[Label](https://example.com)").ok, true);
  });

  it("relative-time: módulo auto-contido funciona standalone", () => {
    const r = rtDirect("A OpenAI lançou ontem o modelo.");
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].word.toLowerCase(), "ontem");
    assert.equal(rtDirect("A OpenAI lançou em 1º de junho.").ok, true);
  });

  it("why-matters-format: módulo auto-contido funciona standalone", () => {
    const bad = "Por que isso importa:\n\nPara desenvolvedores, o impacto é grande.";
    assert.equal(wmDirect(bad).ok, false);
    const good = "Por que isso importa:\n\nO custo por token muda o orçamento dos times.";
    assert.equal(wmDirect(good).ok, true);
  });

  it("eai-section: módulo auto-contido funciona standalone", () => {
    assert.equal(eaiDirect("**É IA?**\n\nFoto X.").ok, true);
    assert.equal(eaiDirect("# Newsletter\n\nSem seção.").ok, false);
  });

  it("coverage-line-format: módulo auto-contido funciona standalone", () => {
    const ok =
      "Para esta edição, eu (o editor) enviei 3 submissões e a Diar.ia encontrou outros 90 artigos. Selecionamos os 6 mais relevantes para as pessoas que assinam a newsletter.";
    assert.equal(covDirect(ok).ok, true);
    assert.equal(covDirect("Linha qualquer fora do formato.").ok, false);
  });

  it("destaque-chars: min/max exercitam a comparação (não só early-return)", () => {
    const destaque = (num: number, chars: number) =>
      [
        `**DESTAQUE ${num} | PRODUTO**`,
        "",
        `[Título](https://example.com/${num})`,
        "",
        `https://example.com/${num}`,
        "",
        "X".repeat(chars),
        "",
        "Por que isso importa: impacto.",
        "",
      ].join("\n");
    // D1 com body curtíssimo → abaixo do mínimo (1000) → min falha
    const tiny = minDirect(destaque(1, 50));
    assert.equal(tiny.ok, false);
    assert.equal(tiny.errors[0].destaque, 1);
    assert.ok(tiny.errors[0].chars < tiny.errors[0].min);
    // D1 com body enorme → acima do máximo (1200) → max falha
    const huge = maxDirect(destaque(1, 2000));
    assert.equal(huge.ok, false);
    assert.ok(huge.errors[0].chars > huge.errors[0].max);
    // dentro da faixa → ambos ok
    assert.equal(minDirect(destaque(1, 1100)).ok, true);
    assert.equal(maxDirect(destaque(1, 1100)).ok, true);
  });

  it("titles-per-highlight + title-length: módulos auto-contidos (shared highlight-parsing)", () => {
    const oneTitle = [
      "**DESTAQUE 1 | PRODUTO**",
      "",
      "[Título curto](https://x.com/1)",
      "",
      "https://x.com/1",
      "",
      "Corpo.",
    ].join("\n");
    // 1 destaque só → countTitles falha (espera 3) mas o destaque tem 1 título
    const tc = titlesDirect(oneTitle);
    assert.equal(tc.destaques[0].title_count, 1);
    assert.equal(tc.destaques[0].status, "ok");
    // título > 52 chars → title-length falha
    const longTitle =
      "**DESTAQUE 1 | PRODUTO**\n\n[" +
      "T".repeat(60) +
      "](https://x.com/1)\n\nhttps://x.com/1\n\nCorpo.";
    assert.equal(tlenDirect(longTitle).ok, false);
    assert.ok(tlenDirect(longTitle).errors[0].length > 52);
    assert.equal(tlenDirect(oneTitle).ok, true);
  });

  it("intentional-error: extractFrontmatter + checkIntentionalError standalone", () => {
    // extractFrontmatter: canonical line-1
    assert.equal(efDirect("---\nfoo: bar\n---\n\nbody"), "foo: bar");
    assert.equal(efDirect("# sem frontmatter"), null);
    // checkIntentionalError exige arquivo no disco → não-existente falha
    const r = ieDirect("/tmp/__nonexistent-edition__/02-reviewed.md");
    assert.equal(r.ok, false);
    assert.match(r.label ?? "", /not found/);
  });

  it("eia-answer: check é no-op (ok) quando 01-eia.md não existe", () => {
    // sem 01-eia.md no dir → check não aplicável → ok
    const r = eiaAnsDirect("/tmp/__nonexistent-edition__/02-reviewed.md");
    assert.equal(r.ok, true);
  });

  it("section-item-format: standalone detecta título+descrição na mesma linha", () => {
    const bad = [
      "**🛠️ USE MELHOR**",
      "",
      "**[Guia](https://u.com/1)** descrição colada na mesma linha.",
      "",
    ].join("\n");
    const r = sifDirect(bad);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].type, "title_and_description_same_line");
    assert.equal(r.errors[0].section, "USE MELHOR");
    // bem-formado → ok
    const good = "**🛠️ USE MELHOR**\n\n**[Guia](https://u.com/1)**\nDescrição.\n";
    assert.equal(sifDirect(good).ok, true);
  });

  it("url-bucket: extractUrlsBySection + lintNewsletter + checkSectionCounts standalone", () => {
    const md =
      "**📡 RADAR**\n\n" +
      "**[Notícia](https://r.com/1)**\nResumo.\n\n" +
      "https://r.com/1\n";
    const bySection = eubDirect(md);
    assert.ok(bySection["RADAR"].some((e) => e.url === "https://r.com/1"));
    // URL aprovada no bucket radar → lint ok (sem mismatch)
    const approved = { highlights: [], pesquisa: [{ url: "https://r.com/1" }] };
    assert.equal(lnDirect(md, approved).ok, true);
    // URL não-aprovada → erro "missing"
    assert.equal(lnDirect(md, { highlights: [] }).ok, false);
    // section-counts roda
    const sc = scDirect(md, { highlights: [{}, {}, {}] });
    assert.equal(typeof sc.ok, "boolean");
    assert.ok(sc.counts.radar >= 1);
  });
});
