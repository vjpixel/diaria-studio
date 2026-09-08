/**
 * test/render-monthly-apoiadores-kit.test.ts (#7633)
 *
 * Espelho de `test/render-monthly-apoiadores-brevo.test.ts` para o canal Kit,
 * e existe pelo mesmo motivo concreto que aquele: no #4482/#4510 um review
 * achou que `buildRelink`/`relinkMonthlyEditionHtml` hardcodavam
 * `utm_source=clarice` nos links de destaque relinkados MESMO na variante
 * apoiadores — e nem o teste do `buildRelink` puro nem o do
 * `draftToEmailApoiadores*` puro pegavam isso. Só um teste que reproduz o
 * pipeline REAL do script de render (draft → `draftToEmailApoiadoresKit` →
 * `relinkMonthlyEditionHtml(..., sourceOverride)`) fecha essa lacuna.
 *
 * `test/monthly-apoiadores-kit-render.test.ts` cobre a peça pura
 * (`draftToEmailApoiadoresKit`); `test/publish-monthly-apoiadores-kit.test.ts`
 * injeta um `renderEmail` fake. Sem este arquivo, ninguém exercitaria a
 * passagem de `APOIADORES_KIT_UTM_PROFILE.source` como `sourceOverride` — e
 * perdê-la num refactor faria os links do e-mail dos apoiadores contaminarem
 * a atribuição da audiência Clarice, em silêncio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { draftToEmailApoiadoresKit, APOIADORES_KIT_UTM_PROFILE } from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";
import { buildRelink, type RelinkMaps, normUrl } from "../scripts/monthly-relink-to-diaria.ts";
import { MENSAL_APOIADORES_KIT_UTM_SOURCE, MENSAL_UTM_SOURCE } from "../scripts/lib/shared/utm-registry.ts";

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

/** Os mesmos argumentos que `relinkMonthlyEditionHtml` repassa pra
 *  `buildRelink` — exercitados aqui direto pra não depender de fixture em
 *  disco (raw-destaques.json + índice de posts) só pra provar o contrato do
 *  `sourceOverride`. Mesma abordagem do teste da variante Brevo. */
function maps(): RelinkMaps {
  return {
    urlToEdition: new Map([[normUrl("https://exame.com/artigo-brasil"), "260701"]]),
    servicoUrls: new Set<string>(),
    editionUrl: (ed) => `https://diar.ia.br/p/edicao-${ed}`,
  };
}

describe("#7633 — fluxo end-to-end draftToEmailApoiadoresKit + relink", () => {
  it("reproduz o pipeline de render-monthly-apoiadores-kit.ts: destaque relinkado sai com utm_source=mensal-apoiadores-kit, nunca clarice", () => {
    const { html: rendered } = draftToEmailApoiadoresKit(DRAFT, "Assunto", "2607");
    const relinked = buildRelink(rendered, maps(), undefined, APOIADORES_KIT_UTM_PROFILE.source);

    assert.equal(relinked.relinked, 1, "o link do destaque devia ter sido relinkado pra edição diária");
    const relinkedHref = relinked.html.match(/href="(https:\/\/diar\.ia\.br\/p\/edicao-260701[^"]*)"/)?.[1];
    assert.ok(relinkedHref, "não achei o href relinkado no HTML final");
    assert.match(relinkedHref!, new RegExp(`utm_source=${MENSAL_APOIADORES_KIT_UTM_SOURCE}(&|$)`));
    assert.ok(
      !relinkedHref!.includes(`utm_source=${MENSAL_UTM_SOURCE}&`) && !relinkedHref!.endsWith(`utm_source=${MENSAL_UTM_SOURCE}`),
      `o link relinkado vazou utm_source=clarice na variante Kit: ${relinkedHref}`,
    );
  });

  it("o HTML relinkado continua sem nenhum utm_source de outro canal do mesmo envio", () => {
    const { html: rendered } = draftToEmailApoiadoresKit(DRAFT, "Assunto", "2607");
    const { html } = buildRelink(rendered, maps(), undefined, APOIADORES_KIT_UTM_PROFILE.source);
    const plain = html.replace(/&amp;/g, "&");
    for (const alheio of ["clarice", "mensal-beehiiv", "mensal-apoiadores-brevo"]) {
      assert.ok(!plain.includes(`utm_source=${alheio}`), `vazou utm_source=${alheio} depois do relink`);
    }
  });
});
