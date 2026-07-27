/**
 * test/assert-brand-font.test.ts (#4090)
 *
 * Guard de fonte dos scripts que rasterizam arte de marca.
 *
 * ## O cuidado que define este arquivo
 *
 * O guard existe justamente porque Georgia **não existe em toda máquina** — e o
 * CI roda em Linux, onde ela tipicamente NÃO está instalada. Um teste que
 * afirmasse "Georgia resolve" passaria na máquina do editor e falharia no CI,
 * que é o pior tipo de teste: vermelho sem defeito, treinando todo mundo a
 * ignorar.
 *
 * Então aqui se testa o **mecanismo da sonda**, não o resultado dela nesta
 * máquina:
 *   - duas fontes inexistentes produzem raster IDÊNTICO (é o que permite
 *     detectar fallback por comparação);
 *   - a sonda devolve boolean sem lançar, seja qual for o ambiente;
 *   - o escape hatch por variável de ambiente curto-circuita antes da sonda.
 *
 * O único ponto ambiente-dependente (`Georgia resolve aqui?`) é reportado como
 * informação, nunca como asserção.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  isBrandSerifAvailable,
  assertBrandSerifAvailable,
  BRAND_SERIF_PRIMARY,
  ALLOW_FALLBACK_ENV,
} from "../scripts/lib/shared/assert-brand-font.ts";

function probeSvg(fontFamily: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="60">` +
      `<text x="4" y="42" font-family="${fontFamily}" font-size="34">Handgloves 123</text>` +
      `</svg>`,
  );
}

describe("#4090 — sonda de fonte de marca", () => {
  it("duas famílias inexistentes produzem o MESMO raster (base do mecanismo)", async () => {
    // É esta propriedade que torna a comparação um detector de fallback: se a
    // fonte pedida não resolve, o renderer cai no mesmo default que qualquer
    // outro nome inexistente cairia.
    const [a, b] = await Promise.all([
      sharp(probeSvg("__nao_existe_font_a__")).png().toBuffer(),
      sharp(probeSvg("__nao_existe_font_b__")).png().toBuffer(),
    ]);
    assert.ok(
      a.equals(b),
      "duas fontes inexistentes deveriam cair no mesmo fallback e render igual — " +
        "sem isso a sonda não consegue distinguir 'resolveu' de 'caiu no fallback'",
    );
  });

  it("onde a fonte de marca EXISTE, a sonda discrimina de uma inexistente", async () => {
    // Condicional de propósito. Não há família que resolva em TODO ambiente:
    // genéricas CSS (`monospace`/`serif`) caem no mesmo default do librsvg —
    // verificado, `monospace` produz raster IDÊNTICO ao de uma fonte
    // inexistente nesta máquina. Então a prova de discriminação só é possível
    // onde alguma fonte real de fato resolve, e é exatamente aí que ela importa.
    if (!(await isBrandSerifAvailable())) {
      console.log(
        `      [skip] ${BRAND_SERIF_PRIMARY} ausente neste ambiente (esperado em CI Linux) — ` +
          `discriminação não é testável aqui, e o guard corretamente vai barrar a geração`,
      );
      return;
    }
    const [brand, absent] = await Promise.all([
      sharp(probeSvg(BRAND_SERIF_PRIMARY)).png().toBuffer(),
      sharp(probeSvg("__nao_existe_font_c__")).png().toBuffer(),
    ]);
    assert.ok(
      !brand.equals(absent),
      `${BRAND_SERIF_PRIMARY} deveria render diferente do fallback — se der igual, a sonda ` +
        "não discrimina neste renderer e o guard daria falso negativo",
    );
  });

  it("isBrandSerifAvailable devolve boolean sem lançar, em qualquer ambiente", async () => {
    const got = await isBrandSerifAvailable();
    assert.equal(typeof got, "boolean");
    // Informativo, NÃO asserção: em Windows/macOS tende a true, em CI Linux a false.
    console.log(`      [info] ${BRAND_SERIF_PRIMARY} resolve neste ambiente: ${got}`);
  });

  it(`${ALLOW_FALLBACK_ENV}=1 curto-circuita e não lança nem com a fonte ausente`, async () => {
    const prev = process.env[ALLOW_FALLBACK_ENV];
    process.env[ALLOW_FALLBACK_ENV] = "1";
    try {
      // Não lança independente do ambiente — é o ponto do escape hatch.
      await assertBrandSerifAvailable("teste");
    } finally {
      if (prev === undefined) delete process.env[ALLOW_FALLBACK_ENV];
      else process.env[ALLOW_FALLBACK_ENV] = prev;
    }
  });

  it("sem o escape hatch, o comportamento acompanha a disponibilidade real", async () => {
    const prev = process.env[ALLOW_FALLBACK_ENV];
    delete process.env[ALLOW_FALLBACK_ENV];
    try {
      const available = await isBrandSerifAvailable();
      if (available) {
        // Ambiente com a fonte: não pode lançar.
        await assertBrandSerifAvailable("teste");
      } else {
        // Ambiente sem a fonte (ex: CI Linux): TEM que lançar, com mensagem
        // que nomeia o script e a saída — é o valor inteiro do guard.
        await assert.rejects(
          () => assertBrandSerifAvailable("teste"),
          (err: Error) => {
            assert.match(err.message, /teste/, "erro deve nomear o script que parou");
            assert.match(err.message, new RegExp(BRAND_SERIF_PRIMARY), "erro deve nomear a fonte");
            assert.match(err.message, new RegExp(ALLOW_FALLBACK_ENV), "erro deve oferecer a saída");
            return true;
          },
        );
      }
    } finally {
      if (prev !== undefined) process.env[ALLOW_FALLBACK_ENV] = prev;
    }
  });
});
