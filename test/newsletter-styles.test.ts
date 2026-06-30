/**
 * test/newsletter-styles.test.ts (#2635)
 *
 * Regressão para a extração do CSS base compartilhado em newsletter-styles.ts:
 *
 *   (a) Ambos os renderers emitem o MESMO bloco base de estilo — body/img/table
 *       reset com os mesmos tokens. Fonte única (emailBaseRules) em vez de CSS
 *       duplicado independente em cada renderer.
 *
 *   (b) DS_STYLE_BLOCK da diária permanece byte-idêntico ao anterior (buildDiariaStyleBlock
 *       deve produzir exatamente o mesmo string que o template literal que substituiu).
 *       O golden de hash em ds-golden-full-render.test.ts cobre o renderHTML completo;
 *       este teste cobre o bloco <style> isolado.
 *
 *   (c) O HTML de wrapEmail() do renderer mensal contém a base compartilhada no <style>.
 *
 * #633: refactor em scripts/lib/ exige teste de regressão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  emailBaseRules,
  buildDiariaStyleBlock,
  buildMensalStyleBlock,
  BRAND_COLOR,
} from "../scripts/lib/newsletter-styles.ts";
import { DS_STYLE_BLOCK } from "../scripts/lib/newsletter-render-html.ts";
import { draftToEmail } from "../scripts/lib/monthly-render.ts";

// Tokens canônicos (de design-tokens.ts, hardcoded para estabilidade do teste — se
// os tokens mudarem, este teste falha intencionalmente pra chamar atenção).
const PAGE_BG = "#FFFFFF";  // canonical email bg após #1943/#1955
const EXPECTED_BRAND = "#00A0A0"; // COLORS.brand

// Bloco base esperado (primeiro bloco de qualquer <style> de email Diar.ia).
const EXPECTED_BASE_BODY = `body { margin:0; padding:0; width:100% !important; background:${PAGE_BG}; }`;
const EXPECTED_BASE_IMG  = `img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }`;
const EXPECTED_BASE_TABLE = `table { border-collapse:collapse; }`;

describe("newsletter-styles — base CSS compartilhado (#2635)", () => {

  // ── emailBaseRules ──────────────────────────────────────────────────────────

  it("BRAND_COLOR exportado = #00A0A0 (COLORS.brand canônico)", () => {
    assert.equal(BRAND_COLOR, EXPECTED_BRAND);
  });

  it("emailBaseRules contém reset de body com pageBg correto", () => {
    const rules = emailBaseRules(PAGE_BG);
    assert.ok(rules.includes(EXPECTED_BASE_BODY), `body reset ausente:\n${rules}`);
  });

  it("emailBaseRules contém reset de img", () => {
    const rules = emailBaseRules(PAGE_BG);
    assert.ok(rules.includes(EXPECTED_BASE_IMG), `img reset ausente:\n${rules}`);
  });

  it("emailBaseRules contém reset de table", () => {
    const rules = emailBaseRules(PAGE_BG);
    assert.ok(rules.includes(EXPECTED_BASE_TABLE), `table reset ausente:\n${rules}`);
  });

  // ── buildDiariaStyleBlock ──────────────────────────────────────────────────

  it("buildDiariaStyleBlock é byte-idêntico ao DS_STYLE_BLOCK", () => {
    // Esta é a asserção central da regressão da diária: refatorar o template literal
    // em função não pode alterar nenhum caractere do output (snapshot hash depende disso).
    assert.equal(
      buildDiariaStyleBlock(PAGE_BG, BRAND_COLOR),
      DS_STYLE_BLOCK,
      "buildDiariaStyleBlock divergiu do DS_STYLE_BLOCK — o golden de hash vai falhar",
    );
  });

  it("DS_STYLE_BLOCK contém a base body/img/table", () => {
    assert.ok(DS_STYLE_BLOCK.includes(EXPECTED_BASE_BODY), `body reset ausente no DS_STYLE_BLOCK`);
    assert.ok(DS_STYLE_BLOCK.includes(EXPECTED_BASE_IMG),  `img reset ausente no DS_STYLE_BLOCK`);
    assert.ok(DS_STYLE_BLOCK.includes(EXPECTED_BASE_TABLE), `table reset ausente no DS_STYLE_BLOCK`);
  });

  it("DS_STYLE_BLOCK contém overrides específicos da diária", () => {
    assert.ok(DS_STYLE_BLOCK.includes("a.headline:hover"),        "hover da manchete ausente");
    assert.ok(DS_STYLE_BLOCK.includes(".container"),               ".container ausente");
    assert.ok(DS_STYLE_BLOCK.includes(".pad"),                     ".pad ausente");
    assert.ok(DS_STYLE_BLOCK.includes(".hero"),                    ".hero ausente");
  });

  it("DS_STYLE_BLOCK NÃO contém .mob-stack (override exclusivo da mensal)", () => {
    assert.ok(!DS_STYLE_BLOCK.includes(".mob-stack"), ".mob-stack não deve aparecer no bloco da diária");
  });

  // ── buildMensalStyleBlock ──────────────────────────────────────────────────

  it("buildMensalStyleBlock contém a mesma base body/img/table", () => {
    const style = buildMensalStyleBlock(PAGE_BG);
    assert.ok(style.includes(EXPECTED_BASE_BODY),  `body reset ausente no bloco mensal`);
    assert.ok(style.includes(EXPECTED_BASE_IMG),   `img reset ausente no bloco mensal`);
    assert.ok(style.includes(EXPECTED_BASE_TABLE), `table reset ausente no bloco mensal`);
  });

  it("buildMensalStyleBlock contém override específico da mensal (.mob-stack)", () => {
    const style = buildMensalStyleBlock(PAGE_BG);
    assert.ok(style.includes(".mob-stack"), ".mob-stack ausente no bloco mensal");
  });

  it("buildMensalStyleBlock NÃO contém .container/.pad/.hero (overrides exclusivos da diária)", () => {
    const style = buildMensalStyleBlock(PAGE_BG);
    assert.ok(!style.includes(".container"), ".container não deve aparecer no bloco mensal");
    assert.ok(!style.includes(".hero"),      ".hero não deve aparecer no bloco mensal");
  });

  // ── wrapEmail integração ────────────────────────────────────────────────────

  it("mensal wrapEmail: <style> contém a base CSS compartilhada", () => {
    const { html } = draftToEmail("**ASSUNTO**\nTeste #2635\n", null, "2605");
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(styleMatch, "Bloco <style> ausente no HTML do wrapEmail mensal");
    const styleContent = styleMatch[1];
    assert.ok(styleContent.includes("body { margin:0; padding:0;"),
      `body reset ausente no <style> do wrapEmail:\n${styleContent}`);
    assert.ok(styleContent.includes("img { border:0;"),
      `img reset ausente no <style> do wrapEmail:\n${styleContent}`);
    assert.ok(styleContent.includes("table { border-collapse:collapse;"),
      `table reset ausente no <style> do wrapEmail:\n${styleContent}`);
    assert.ok(styleContent.includes(".mob-stack"),
      `.mob-stack ausente no <style> do wrapEmail:\n${styleContent}`);
  });

  it("mensal wrapEmail: fundo branco (#FFFFFF) e sem papel (#FBFAF6) — regressão #1955", () => {
    const { html } = draftToEmail("**ASSUNTO**\nTeste #2635\n", null, "2605");
    assert.match(html, /#FFFFFF/i, "fundo branco ausente no HTML mensal");
    assert.doesNotMatch(html, /#FBFAF6/i, "#FBFAF6 (paper token web) não deve aparecer no email mensal");
  });

  it("mensal wrapEmail: bege de contraste (#EBE5D0) presente — regressão #1955", () => {
    // Mesmo com o novo bloco <style>, os boxes bege (kicker, É IA?, fio condutor)
    // seguem usando BEGE = COLORS.paperAlt (#EBE5D0) nos estilos inline.
    // Um destaque qualquer já tem kicker → gera bege.
    const draft = [
      "**ASSUNTO**",
      "Teste #2635",
      "",
      "**DESTAQUE 1 | TECH**",
      "Título tech",
      "Corpo do destaque.",
      "",
      "O fio condutor: Conclusão.",
    ].join("\n");
    const { html } = draftToEmail(draft, null, "2605");
    assert.match(html, /#EBE5D0/i, "#EBE5D0 (bege de contraste) ausente no HTML mensal");
  });
});
