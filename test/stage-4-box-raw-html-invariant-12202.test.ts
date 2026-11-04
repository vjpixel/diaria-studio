/**
 * test/stage-4-box-raw-html-invariant-12202.test.ts (#12202)
 *
 * `box-divulgacao-raw-html` (Stage 4, error): box de divulgação com HTML cru
 * no `02-reviewed.md` sairia com as tags visíveis como texto.
 *
 * Fixture REAL: `test/fixtures/box-raw-html-12202/02-reviewed-broken.md` é o
 * trecho D1 → box → D2 do snapshot `stage2-post-gate/02-reviewed.md` da
 * edição 261105 (box do slot 1 = `onboarding-2.md`, HTML cru, verbatim); o
 * corpo dos destaques foi trocado por placeholder (edição ainda não publicada
 * quando o fixture foi gravado). `02-reviewed-fixed.md` é o mesmo trecho com o
 * box trocado à mão pelo editor (livros-divulgacao, markdown).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBoxDivulgacaoRawHtml, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";
import { findRawHtmlTag, isNonBoxSnippetFileName } from "../scripts/lib/shared/non-box-snippets.ts";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "box-raw-html-12202");

function editionWith(source: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "box-raw-html-12202-"));
  copyFileSync(join(FIXTURE_DIR, source), join(dir, "02-reviewed.md"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("checkBoxDivulgacaoRawHtml (#12202)", () => {
  it("edição 261105 com onboarding-2 no slot 1 → error gate-blocking", () => {
    const { dir, cleanup } = editionWith("02-reviewed-broken.md");
    try {
      const v = checkBoxDivulgacaoRawHtml(dir);
      assert.equal(v.length, 1, JSON.stringify(v));
      assert.equal(v[0].rule, "box-divulgacao-raw-html");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /slot 1/);
      assert.match(v[0].message, /<p>/);
    } finally {
      cleanup();
    }
  });

  it("mesma edição depois da troca à mão (box em markdown) → sem violação", () => {
    const { dir, cleanup } = editionWith("02-reviewed-fixed.md");
    try {
      assert.deepEqual(checkBoxDivulgacaoRawHtml(dir), []);
    } finally {
      cleanup();
    }
  });

  it("02-reviewed.md ausente → []", () => {
    const dir = mkdtempSync(join(tmpdir(), "box-raw-html-12202-empty-"));
    try {
      assert.deepEqual(checkBoxDivulgacaoRawHtml(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("HTML cru fora de box (corpo de destaque) não é desta regra", () => {
    const dir = mkdtempSync(join(tmpdir(), "box-raw-html-12202-dest-"));
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nO tutorial explica a tag <p> do HTML.\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody",
      );
      assert.deepEqual(checkBoxDivulgacaoRawHtml(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registrada no STAGE_4_RULES como stage 4", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "box-divulgacao-raw-html");
    assert.ok(rule);
    assert.equal(rule.stage, 4);
    assert.equal(rule.source_issue, "#12202");
  });
});

describe("findRawHtmlTag / isNonBoxSnippetFileName (#12202)", () => {
  it("acusa <p>, <a …>, </p>, <br/>; ignora markdown, autolink e comparação", () => {
    assert.equal(findRawHtmlTag("<p>oi</p>"), "<p>");
    assert.match(findRawHtmlTag('veja <a href="https://x">x</a>') ?? "", /^<a href/);
    assert.equal(findRawHtmlTag("linha<br/>linha"), "<br/>");
    assert.equal(findRawHtmlTag("**Box** [Confira](https://livros.diar.ia.br)"), null);
    assert.equal(findRawHtmlTag("<https://livros.diar.ia.br>"), null);
    assert.equal(findRawHtmlTag("se a < b e b > c"), null);
    assert.equal(findRawHtmlTag("<pre>"), null, "só tags da lista, nome exato");
  });

  it("padrões de nome: onboarding-N e brevo-*-intro; caixas reais passam", () => {
    for (const f of ["onboarding-1.md", "onboarding-2.md", "onboarding-3.md", "brevo-diaria-pending-intro.md", "hub-divulgacao-rotativo.md"]) {
      assert.equal(isNonBoxSnippetFileName(f), true, f);
    }
    for (const f of ["livros-divulgacao.md", "youtube-comentario-destaque.md", "apoio-divulgacao.md", "brevo-diaria-oferta.md"]) {
      assert.equal(isNonBoxSnippetFileName(f), false, f);
    }
  });
});
