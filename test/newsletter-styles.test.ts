/**
 * test/newsletter-styles.test.ts (#2635)
 *
 * Regressão para a extração do CSS de email em newsletter-styles.ts:
 *
 *   (a) A base compartilhada (emailBaseRules) é a fonte única do reset body/img/table;
 *       o renderer DIÁRIO a consome. A asserção é contra um literal GROUND-TRUTH (o
 *       bloco <style> exato pré-refactor), NÃO contra DS_STYLE_BLOCK — este último é
 *       definido como buildDiariaStyleBlock(...), então comparar contra ele seria
 *       tautológico (f(x) === f(x)) e não pegaria bug no builder.
 *
 *   (b) O output renderizado de cada renderer NÃO regrediu (#633):
 *       - diária: DS_STYLE_BLOCK byte-idêntico ao literal pré-refactor.
 *       - mensal: wrapEmail() preserva o <style> atual (só .mob-stack), fundo branco,
 *         bege de contraste. Confirma que a mensal NÃO ganhou o reset body/img/table
 *         (decisão de escopo conservador: adotar a base na mensal é follow-up editorial).
 *
 * #633: refactor em scripts/lib/ — teste de regressão demonstrando que o output de
 * ambos os renderers permanece o esperado e a base é uma fonte única.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  emailBaseRules,
  buildDiariaStyleBlock,
  buildMensalStyleBlock,
} from "../scripts/lib/shared/newsletter-styles.ts";
import { DS_STYLE_BLOCK } from "../scripts/lib/newsletter-render-html.ts";
import { draftToEmail } from "../scripts/lib/mensal/monthly-render.ts";

// Tokens canônicos (de design-tokens.ts; hardcoded aqui para servir de GROUND TRUTH —
// se os tokens mudarem, este teste falha intencionalmente pra chamar atenção).
const PAGE_BG = "#FFFFFF"; // COLORS.paperEmail / email bg canonical (#1943/#1955)
const BRAND = "#00A0A0"; // COLORS.brand

// Bloco <style> EXATO da diária ANTES do refactor (#2635). Ground truth independente:
// não é derivado de nenhuma função sob teste, então pega qualquer divergência no builder.
const DIARIA_STYLE_BEFORE = `<style>
  body { margin:0; padding:0; width:100% !important; background:${PAGE_BG}; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  table { border-collapse:collapse; }
  a.headline:hover { color:${BRAND} !important; }
  @media only screen and (max-width:480px) {
    .container { width:100% !important; }
    .pad { padding-left:12px !important; padding-right:12px !important; }
    .hero { height:auto !important; }
  }
</style>`;

const EXPECTED_BASE_BODY = `body { margin:0; padding:0; width:100% !important; background:${PAGE_BG}; }`;
const EXPECTED_BASE_IMG = `img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }`;
const EXPECTED_BASE_TABLE = `table { border-collapse:collapse; }`;

describe("newsletter-styles — CSS de email compartilhado (#2635)", () => {

  // ── emailBaseRules: fonte única do reset ────────────────────────────────────

  it("emailBaseRules emite o reset body/img/table com o pageBg passado", () => {
    const rules = emailBaseRules(PAGE_BG);
    assert.ok(rules.includes(EXPECTED_BASE_BODY), `body reset ausente:\n${rules}`);
    assert.ok(rules.includes(EXPECTED_BASE_IMG), `img reset ausente:\n${rules}`);
    assert.ok(rules.includes(EXPECTED_BASE_TABLE), `table reset ausente:\n${rules}`);
  });

  it("emailBaseRules interpola o pageBg recebido (não hardcoda branco)", () => {
    const rules = emailBaseRules("#123456");
    assert.ok(rules.includes("background:#123456;"), `pageBg não interpolado:\n${rules}`);
  });

  // ── buildDiariaStyleBlock: byte-idêntico ao literal pré-refactor (ground truth) ──

  it("buildDiariaStyleBlock é byte-idêntico ao bloco <style> pré-refactor (ground truth)", () => {
    // Asserção central da não-regressão da diária: o builder deve reproduzir EXATAMENTE
    // o literal que substituiu. Comparar contra DIARIA_STYLE_BEFORE (não DS_STYLE_BLOCK)
    // evita a tautologia f(x) === f(x), já que DS_STYLE_BLOCK = buildDiariaStyleBlock(...).
    assert.equal(buildDiariaStyleBlock(PAGE_BG, BRAND), DIARIA_STYLE_BEFORE);
  });

  it("DS_STYLE_BLOCK exportado pela diária é byte-idêntico ao literal pré-refactor", () => {
    // Garante que o export de produção (newsletter-render-html.ts) chama o builder com
    // PAGE_BG/TEAL corretos — protege o golden de hash em ds-golden-full-render.test.ts.
    assert.equal(DS_STYLE_BLOCK, DIARIA_STYLE_BEFORE);
  });

  it("DS_STYLE_BLOCK consome a base compartilhada (emailBaseRules)", () => {
    // Liga o output de produção à fonte única: o reset emitido é exatamente o de emailBaseRules.
    assert.ok(DS_STYLE_BLOCK.includes(emailBaseRules(PAGE_BG)),
      "DS_STYLE_BLOCK não contém o output de emailBaseRules — base não compartilhada");
  });

  it("DS_STYLE_BLOCK tem os overrides específicos da diária e NÃO o da mensal", () => {
    assert.ok(DS_STYLE_BLOCK.includes("a.headline:hover"), "hover da manchete ausente");
    assert.ok(DS_STYLE_BLOCK.includes(".container"), ".container ausente");
    assert.ok(DS_STYLE_BLOCK.includes(".pad"), ".pad ausente");
    assert.ok(DS_STYLE_BLOCK.includes(".hero"), ".hero ausente");
    assert.ok(!DS_STYLE_BLOCK.includes(".mob-stack"), ".mob-stack não pertence à diária");
  });

  // ── buildMensalStyleBlock: preserva o output atual (só .mob-stack) ──────────

  it("buildMensalStyleBlock preserva o output atual: só .mob-stack, SEM reset base", () => {
    // Escopo conservador (#2635): a mensal hoje NÃO emite o reset body/img/table.
    // buildMensalStyleBlock preserva exatamente isso — adotar a base é follow-up editorial
    // (mudaria o render por border-collapse em tabelas arredondadas sem guard).
    const style = buildMensalStyleBlock(PAGE_BG);
    assert.ok(style.includes(".mob-stack"), ".mob-stack ausente no bloco mensal");
    assert.ok(!style.includes(EXPECTED_BASE_BODY), "mensal NÃO deve ganhar o reset body (regressão visual)");
    assert.ok(!style.includes(EXPECTED_BASE_IMG), "mensal NÃO deve ganhar o reset img");
    assert.ok(!style.includes(EXPECTED_BASE_TABLE), "mensal NÃO deve ganhar table{border-collapse:collapse} (quadra cantos arredondados)");
    assert.ok(!style.includes(".container") && !style.includes(".hero"),
      "overrides exclusivos da diária não pertencem à mensal");
  });

  // ── wrapEmail integração: output mensal não regrediu ────────────────────────

  it("mensal wrapEmail: <style> tem .mob-stack e NÃO o reset base (output preservado)", () => {
    const { html } = draftToEmail("**ASSUNTO**\nTeste #2635\n", null, "2605");
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(styleMatch, "Bloco <style> ausente no HTML do wrapEmail mensal");
    const styleContent = styleMatch[1];
    assert.ok(styleContent.includes(".mob-stack"), `.mob-stack ausente:\n${styleContent}`);
    assert.ok(!styleContent.includes("border-collapse:collapse"),
      `mensal não deve ter table{border-collapse:collapse} no <style> (regressão):\n${styleContent}`);
  });

  it("mensal wrapEmail: fundo branco (#FFFFFF) e sem papel (#FBFAF6) — regressão #1955", () => {
    const { html } = draftToEmail("**ASSUNTO**\nTeste #2635\n", null, "2605");
    assert.match(html, /#FFFFFF/i, "fundo branco ausente no HTML mensal");
    assert.doesNotMatch(html, /#FBFAF6/i, "#FBFAF6 (paper token web) não deve aparecer no email mensal");
  });

  it("mensal wrapEmail: bege de contraste (#EBE5D0) presente — regressão #1955", () => {
    // Os boxes bege (kicker, É IA?, fio condutor) seguem usando BEGE (#EBE5D0) inline.
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
