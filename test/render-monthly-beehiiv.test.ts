/**
 * test/render-monthly-beehiiv.test.ts (#4510)
 *
 * Cobre 2 achados do review pré-merge do #4482 que não tinham teste:
 *
 *   - CRÍTICO 2 (code-reviewer): `buildRelink`/`relinkMonthlyEditionHtml`
 *     hardcodavam `utm_source=clarice` nos links de destaque relinkados,
 *     mesmo na variante Beehiiv. `test/monthly-relink-to-diaria.test.ts` e
 *     `test/monthly-beehiiv-render.test.ts` cobrem cada peça isolada
 *     (`buildRelink` puro, `draftToEmailBeehiiv` puro) mas nenhum dos dois
 *     exercitava o fluxo REAL de `render-monthly-beehiiv.ts`: draft →
 *     `draftToEmailBeehiiv` → `relinkMonthlyEditionHtml` com
 *     `sourceOverride: BEEHIIV_UTM_PROFILE.source`. Este arquivo fecha essa
 *     lacuna com um teste de integração que reproduz esse pipeline.
 *
 *   - MÉDIO (silent-failure-hunter): `readPublicImages`/o código que
 *     consome o manifest de imagens degradava em silêncio quando alguma
 *     chave esperada (`d1`/`d2`/`d3`/`eia_a`/`eia_b`/`livros_promo`) estava
 *     ausente. `missingImageKeys` (função pura extraída) cobre isso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { missingImageKeys, EXPECTED_IMAGE_KEYS } from "../scripts/render-monthly-beehiiv.ts";
import type { MonthlyPublicImage } from "../scripts/monthly-preview-cloudflare.ts";
import { draftToEmailBeehiiv, BEEHIIV_UTM_PROFILE } from "../scripts/lib/mensal/monthly-beehiiv-render.ts";
import { buildRelink, type RelinkMaps, normUrl } from "../scripts/monthly-relink-to-diaria.ts";
import { MENSAL_BEEHIIV_UTM_SOURCE, MENSAL_UTM_SOURCE } from "../scripts/lib/shared/utm-registry.ts";

describe("#4510 — missingImageKeys", () => {
  const img = (url = "https://img/x.jpg"): MonthlyPublicImage => ({ url, filename: "x.jpg", mime_type: "image/jpeg" });

  it("manifest completo → nenhuma chave faltando", () => {
    const images: Record<string, MonthlyPublicImage> = {};
    for (const k of EXPECTED_IMAGE_KEYS) images[k] = img();
    assert.deepEqual(missingImageKeys(images), []);
  });

  it("manifest vazio → todas as 6 chaves faltando", () => {
    assert.deepEqual(missingImageKeys({}), [...EXPECTED_IMAGE_KEYS]);
  });

  it("enumera só as chaves ausentes (não as presentes)", () => {
    const images: Record<string, MonthlyPublicImage> = { d1: img(), d2: img(), eia_a: img() };
    assert.deepEqual(missingImageKeys(images), ["d3", "eia_b", "livros_promo"]);
  });

  it("chave presente mas sem url conta como ausente", () => {
    const images: Record<string, MonthlyPublicImage> = { d1: { url: "", filename: "x", mime_type: "image/jpeg" } };
    assert.ok(missingImageKeys(images).includes("d1"));
  });
});

describe("#4510 — fluxo end-to-end draftToEmailBeehiiv + relink (CRÍTICO 2)", () => {
  const DRAFT = [
    "**ASSUNTO (3 OPÇÕES)**",
    "1. Assunto de teste",
    "",
    "**PREVIEW**",
    "",
    "Preview de teste.",
    "",
    "**DESTAQUE 1 | BRASIL**",
    "",
    "Título do destaque",
    "",
    "Parágrafo com [link de fonte](https://exame.com/artigo-brasil).",
    "",
    "O fio condutor:",
    "Síntese do tema.",
    "",
    "**RADAR**",
    "",
    "[Assine a diária](https://diar.ia.br)",
    "",
    "Descrição do item do radar.",
    "",
    "**PARA ENCERRAR**",
    "",
    "Até o mês que vem, com a diar.ia.br.",
  ].join("\n");

  it("reproduz o pipeline real de render-monthly-beehiiv.ts: destaque relinkado sai com utm_source=mensal-beehiiv, nunca clarice", () => {
    // Passo 1 (igual ao main() de render-monthly-beehiiv.ts): renderiza a
    // variante Beehiiv do draft.
    const { html: rendered } = draftToEmailBeehiiv(DRAFT, "Assunto", "2607");

    // Passo 2 (igual ao main(): relinkMonthlyEditionHtml(html, monthlyDir, ROOT,
    // undefined, BEEHIIV_UTM_PROFILE.source)) — aqui exercitado via buildRelink
    // (a peça pura) com os MESMOS argumentos que relinkMonthlyEditionHtml passa
    // adiante, pra não depender de fixtures em disco (raw-destaques.json/índice
    // de posts) só pra provar o contrato de `sourceOverride`.
    const maps: RelinkMaps = {
      urlToEdition: new Map([[normUrl("https://exame.com/artigo-brasil"), "260701"]]),
      servicoUrls: new Set<string>(),
      editionUrl: (ed) => `https://diar.ia.br/p/edicao-${ed}`,
    };
    const relinked = buildRelink(rendered, maps, undefined, BEEHIIV_UTM_PROFILE.source);

    assert.equal(relinked.relinked, 1, "o link do destaque devia ter sido relinkado pra edição diária");
    const relinkedHref = relinked.html.match(/href="(https:\/\/diar\.ia\.br\/p\/edicao-260701[^"]*)"/)?.[1];
    assert.ok(relinkedHref, "não achei o href relinkado no HTML final");
    assert.match(relinkedHref!, new RegExp(`utm_source=${MENSAL_BEEHIIV_UTM_SOURCE}(&|$)`));
    assert.ok(
      !relinkedHref!.includes(`utm_source=${MENSAL_UTM_SOURCE}&`) && !relinkedHref!.endsWith(`utm_source=${MENSAL_UTM_SOURCE}`),
      `o link relinkado do destaque vazou utm_source=clarice na variante Beehiiv: ${relinkedHref}`,
    );
  });

  it("regressão: SEM sourceOverride (uso antigo/Clarice), buildRelink continua utm_source=clarice", () => {
    const maps: RelinkMaps = {
      urlToEdition: new Map([[normUrl("https://exame.com/artigo-brasil"), "260701"]]),
      servicoUrls: new Set<string>(),
      editionUrl: (ed) => `https://diar.ia.br/p/edicao-${ed}`,
    };
    const r = buildRelink(`<a href="https://exame.com/artigo-brasil">Brasil</a>`, maps);
    assert.match(r.html, new RegExp(`utm_source=${MENSAL_UTM_SOURCE}&`));
  });
});
