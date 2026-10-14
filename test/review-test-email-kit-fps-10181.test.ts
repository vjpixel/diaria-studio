/**
 * #10181 — falsos positivos dos lints determinísticos do review-test-email
 * (platform kit) na edição 261014, reproduzidos com o HTML real do Kit e o
 * `02-reviewed.md` real da edição como fixture:
 *
 *  - `char_dropped` do `Í` do rótulo estrutural `TÍTULO` (o bloco
 *    TÍTULO/SUBTÍTULO vira subject/preview, nunca o corpo do e-mail);
 *  - `section_missing` de LANÇAMENTOS/RADAR/USE MELHOR quando o e-mail chega
 *    do Gmail com o ponto do kicker já decodificado (`●` literal em vez de
 *    `&#9679;`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkEncoding,
  stripHtmlToText,
  stripStructuralLabels,
} from "../scripts/lint-test-email-encoding.ts";
import {
  compareStructure,
  extractEmailStructure,
  extractMdStructure,
} from "../scripts/lint-test-email-structure.ts";

const FIX = join(import.meta.dirname, "fixtures", "review-test-email-kit-10181");
const KIT_HTML = readFileSync(join(FIX, "newsletter-final-kit-261014.html"), "utf8");
const SOURCE_MD = readFileSync(join(FIX, "02-reviewed-261014.md"), "utf8");
/** Como o Gmail devolve o corpo do Kit: entidades do ponto e do nbsp decodificadas. */
const KIT_HTML_GMAIL = KIT_HTML.replace(/&#9679;/g, "●").replace(/&nbsp;/g, " ");

describe("lint-test-email-encoding — rótulos estruturais (#10181)", () => {
  it("HTML real do Kit da 261014: zero achados", () => {
    for (const html of [KIT_HTML, KIT_HTML_GMAIL]) {
      const issues = checkEncoding(SOURCE_MD, stripHtmlToText(html));
      assert.deepEqual(issues, []);
    }
  });

  it("remove só a linha do rótulo — o valor segue no source", () => {
    const md = "TÍTULO\n\nOAB-SP vai à Justiça\n\n**SUBTÍTULO:**\n\nÉ só isso";
    const out = stripStructuralLabels(md);
    assert.ok(!out.includes("TÍTULO"));
    assert.ok(out.includes("OAB-SP vai à Justiça"));
    assert.ok(out.includes("É só isso"));
  });

  it("acento real que some do valor do título continua acusado", () => {
    const md = "TÍTULO\n\nOAB-SP vai à Justiça\n";
    const issues = checkEncoding(md, "OAB-SP vai a Justica");
    assert.ok(issues.some((i) => i.char === "à"));
    assert.ok(issues.some((i) => i.char === "ç"));
    assert.ok(!issues.some((i) => i.char === "Í"));
  });

  it("TÍTULO no meio de uma frase não é rótulo", () => {
    const md = "O TÍTULO da obra mudou.";
    assert.equal(stripStructuralLabels(md), md);
    const issues = checkEncoding(md, "O TITULO da obra mudou.");
    assert.ok(issues.some((i) => i.char === "Í"));
  });
});

describe("lint-test-email-structure — kicker do Kit (#10181)", () => {
  const source = extractMdStructure(SOURCE_MD);

  it("o source da 261014 tem as 3 seções de pool", () => {
    assert.deepEqual(
      source.sections.map((s) => s.name).sort(),
      ["LANÇAMENTOS", "RADAR", "USE MELHOR"],
    );
  });

  it("HTML do Kit com `&#9679;` (render local): zero achados", () => {
    assert.deepEqual(compareStructure(source, extractEmailStructure(KIT_HTML)), []);
  });

  it("HTML do Kit como o Gmail devolve (`●` literal): zero achados", () => {
    assert.deepEqual(compareStructure(source, extractEmailStructure(KIT_HTML_GMAIL)), []);
  });

  it("aceita `&#x25CF;` hex", () => {
    const html = KIT_HTML.replace(/&#9679;/g, "&#x25CF;");
    assert.deepEqual(compareStructure(source, extractEmailStructure(html)), []);
  });

  it("seção realmente ausente continua acusada (RADAR removido)", () => {
    const html = KIT_HTML_GMAIL.replace(/<!-- RADAR -->[\s\S]*?(?=<!-- |$)/, "").replace(/RADAR/g, "");
    const issues = compareStructure(source, extractEmailStructure(html));
    assert.ok(issues.some((i) => i.type === "section_missing" && i.section === "RADAR"));
  });

  it("palavra solta em prosa sem âncora não cria seção fantasma", () => {
    const email = extractEmailStructure("<p>o radar da semana e use melhor seu tempo</p>");
    assert.deepEqual(email.sections, []);
  });
});
