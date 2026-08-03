/**
 * test/monthly-beehiiv-render.test.ts (#4482)
 *
 * Cobre a variante Beehiiv do digest mensal (`scripts/lib/mensal/monthly-beehiiv-render.ts`):
 *   - `isClariceOnlySection`/`filterDraftForBeehiiv` removem APRESENTAÇÃO e
 *     CLARICE — * por inteiro, sem tocar as demais seções.
 *   - `stripRecomendacaoDiariaBlock` remove o box colado manualmente sem
 *     label própria, sem afetar o resto do corpo da seção.
 *   - `draftToEmailBeehiiv` emite `utm_source=mensal-beehiiv` (não `clarice`)
 *     e nunca vaza conteúdo Clarice-only no HTML final.
 *   - `draftToEmail` (Clarice, perfil default) continua idêntico — regressão
 *     contra a mudança de assinatura em monthly-render.ts (#633).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClariceOnlySection,
  stripRecomendacaoDiariaBlock,
  filterDraftForBeehiiv,
  draftToEmailBeehiiv,
  BEEHIIV_UTM_PROFILE,
} from "../scripts/lib/mensal/monthly-beehiiv-render.ts";
import { draftToEmail, splitByLabels, normalizeLabel } from "../scripts/lib/mensal/monthly-render.ts";
import {
  MENSAL_BEEHIIV_UTM_SOURCE,
  MENSAL_BEEHIIV_UTM_MEDIUM,
  MENSAL_UTM_SOURCE,
  buildMensalBeehiivCampaign,
} from "../scripts/lib/shared/utm-registry.ts";

const RECOMENDACAO_BLOCK = [
  "Recomendação da equipe da Clarice",
  "",
  "Você recebe esta curadoria uma vez por mês. Se quiser mais, a diar.ia.br publica uma edição diária.",
  "",
  "→ [Assinar a edição diária](https://diar.ia.br/?utm_source=clarice)",
].join("\n\n");

describe("#4482 — isClariceOnlySection", () => {
  it("APRESENTAÇÃO (com e sem acento) é Clarice-only", () => {
    assert.equal(isClariceOnlySection("APRESENTAÇÃO"), true);
    assert.equal(isClariceOnlySection("APRESENTACAO"), true);
  });

  it("CLARICE — DIVULGAÇÃO e CLARICE — TUTORIAL são Clarice-only (em-dash)", () => {
    assert.equal(isClariceOnlySection("CLARICE — DIVULGAÇÃO"), true);
    assert.equal(isClariceOnlySection("CLARICE — TUTORIAL"), true);
  });

  it("CLARICE - com hífen ASCII também é Clarice-only", () => {
    assert.equal(isClariceOnlySection("CLARICE - DIVULGAÇÃO"), true);
  });

  it("seções normais (DESTAQUE, RADAR, LABORATÓRIO CLARICE) não são Clarice-only", () => {
    assert.equal(isClariceOnlySection("DESTAQUE 1 | ANTHROPIC"), false);
    assert.equal(isClariceOnlySection("RADAR"), false);
    assert.equal(isClariceOnlySection("USE MELHOR"), false);
    assert.equal(isClariceOnlySection("PARA ENCERRAR"), false);
    // LABORATÓRIO CLARICE não começa com "CLARICE —" (o label é outro) — fora
    // do escopo decidido do #4482 (só DIVULGAÇÃO/TUTORIAL foram removidas).
    assert.equal(isClariceOnlySection("LABORATÓRIO CLARICE"), false);
  });
});

describe("#4482 — stripRecomendacaoDiariaBlock", () => {
  it("remove o bloco (título + corpo + CTA) quando presente", () => {
    const body = ["Parágrafo antes.", "", RECOMENDACAO_BLOCK, "", "Parágrafo depois."].join("\n\n");
    const out = stripRecomendacaoDiariaBlock(body);
    assert.doesNotMatch(out, /Recomendação da equipe da Clarice/);
    assert.doesNotMatch(out, /Assinar a edição diária/);
    assert.match(out, /Parágrafo antes\./);
    assert.match(out, /Parágrafo depois\./);
  });

  it("texto sem o bloco volta intacto (fail-soft)", () => {
    const body = "Parágrafo 1.\n\nParágrafo 2.";
    assert.equal(stripRecomendacaoDiariaBlock(body), body);
  });

  it("idempotente — 2ª chamada não remove nada a mais", () => {
    const body = ["Antes.", "", RECOMENDACAO_BLOCK, "", "Depois."].join("\n\n");
    const once = stripRecomendacaoDiariaBlock(body);
    const twice = stripRecomendacaoDiariaBlock(once);
    assert.equal(once, twice);
  });

  it("remove mesmo com corpo de tamanho diferente do snippet original", () => {
    const custom = [
      "Recomendação da equipe da Clarice",
      "",
      "Um corpo bem mais longo, escrito diferente do snippet canônico, com duas frases. E outra frase aqui.",
      "",
      "→ [Assine já](https://diar.ia.br)",
    ].join("\n\n");
    const body = ["Antes.", "", custom, "", "Depois."].join("\n\n");
    const out = stripRecomendacaoDiariaBlock(body);
    assert.doesNotMatch(out, /Recomendação da equipe/);
    assert.doesNotMatch(out, /Assine já/);
    assert.match(out, /Antes\./);
    assert.match(out, /Depois\./);
  });
});

const FULL_DRAFT = [
  "**ASSUNTO (3 OPÇÕES)**",
  "1. Assunto de teste",
  "",
  "**PREVIEW**",
  "",
  "Preview de teste.",
  "",
  "**APRESENTAÇÃO**",
  "",
  "Esta é a newsletter mensal da Clarice, em parceria com a diar.ia.br. Você está recebendo esse e-mail porque se cadastrou na Clarice.",
  "",
  "**INTRO**",
  "",
  "Resumo do mês.",
  "",
  "**DESTAQUE 1 | BRASIL**",
  "",
  "Título do destaque",
  "",
  "Parágrafo com [link de fonte](https://exemplo.com/artigo).",
  "",
  RECOMENDACAO_BLOCK,
  "",
  "O fio condutor:",
  "Síntese do tema.",
  "",
  "**CLARICE — DIVULGAÇÃO**",
  "",
  "**Subtítulo Clarice**",
  "",
  "Conheça o produto.",
  "",
  "→ [Assine grátis](https://diar.ia.br)",
  "",
  "**DESTAQUE 2 | OPENAI**",
  "",
  "Outro título",
  "",
  "Outro parágrafo.",
  "",
  "O fio condutor:",
  "Outra síntese.",
  "",
  "**CLARICE — TUTORIAL**",
  "",
  "**Tutorial**",
  "",
  "Passo a passo.",
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
  "",
  "cadastre-se gratuitamente [aqui](https://diar.ia.br).",
].join("\n");

describe("#4482 — filterDraftForBeehiiv", () => {
  it("remove APRESENTAÇÃO e as 2 seções CLARICE — * por inteiro", () => {
    const filtered = filterDraftForBeehiiv(FULL_DRAFT);
    const labels = splitByLabels(filtered).map((c) => normalizeLabel(c.split("\n")[0]));
    assert.ok(!labels.includes("APRESENTAÇÃO"), labels.join(","));
    assert.ok(!labels.some((l) => l.startsWith("CLARICE —")), labels.join(","));
    // Seções normais preservadas.
    for (const expected of ["ASSUNTO (3 OPÇÕES)", "PREVIEW", "INTRO", "RADAR", "PARA ENCERRAR"]) {
      assert.ok(labels.includes(expected), `faltou "${expected}" — labels: ${labels.join(", ")}`);
    }
    assert.ok(labels.some((l) => l.startsWith("DESTAQUE 1")), labels.join(","));
    assert.ok(labels.some((l) => l.startsWith("DESTAQUE 2")), labels.join(","));
  });

  it("remove o box de recomendação da diária colado dentro do DESTAQUE 1", () => {
    const filtered = filterDraftForBeehiiv(FULL_DRAFT);
    assert.doesNotMatch(filtered, /Recomendação da equipe da Clarice/);
  });

  it("preserva o conteúdo real dos destaques (título, parágrafo, fio condutor)", () => {
    const filtered = filterDraftForBeehiiv(FULL_DRAFT);
    assert.match(filtered, /Título do destaque/);
    assert.match(filtered, /Síntese do tema\./);
    assert.match(filtered, /Outro título/);
  });

  it("é idempotente (2ª passada não muda nada)", () => {
    const once = filterDraftForBeehiiv(FULL_DRAFT);
    const twice = filterDraftForBeehiiv(once);
    assert.equal(once, twice);
  });
});

describe("#4482 — draftToEmailBeehiiv", () => {
  it("HTML final não contém boilerplate/conteúdo Clarice-only", () => {
    const { html } = draftToEmailBeehiiv(FULL_DRAFT, "Assunto", "2607");
    assert.doesNotMatch(html, /se cadastrou na Clarice/);
    assert.doesNotMatch(html, /Recomendação da equipe da Clarice/);
    assert.doesNotMatch(html, /Assine grátis/); // CTA da seção CLARICE — DIVULGAÇÃO
    assert.doesNotMatch(html, /Passo a passo/); // corpo da CLARICE — TUTORIAL
  });

  it("preserva os destaques, radar e encerramento", () => {
    const { html } = draftToEmailBeehiiv(FULL_DRAFT, "Assunto", "2607");
    assert.match(html, /Título do destaque/);
    assert.match(html, /Outro título/);
    assert.match(html, /Descrição do item do radar/);
    assert.match(html, /Até o mês que vem/);
  });

  it("todo link de marca sai com utm_source=mensal-beehiiv, nunca clarice", () => {
    const { html } = draftToEmailBeehiiv(FULL_DRAFT, "Assunto", "2607");
    const plain = html.replace(/&amp;/g, "&");
    const utmSources = [...plain.matchAll(/utm_source=([a-z0-9_-]+)/gi)].map((m) => m[1]);
    assert.ok(utmSources.length > 0, "nenhum utm_source emitido — draft de teste sem link de marca?");
    for (const s of utmSources) {
      assert.equal(s, MENSAL_BEEHIIV_UTM_SOURCE, `utm_source inesperado: ${s}`);
    }
    assert.ok(!plain.includes(`utm_source=${MENSAL_UTM_SOURCE}`), "vazou utm_source=clarice na variante Beehiiv");
  });

  it("BEEHIIV_UTM_PROFILE bate com os valores do registry", () => {
    assert.equal(BEEHIIV_UTM_PROFILE.source, MENSAL_BEEHIIV_UTM_SOURCE);
    assert.equal(BEEHIIV_UTM_PROFILE.medium, MENSAL_BEEHIIV_UTM_MEDIUM);
    assert.equal(BEEHIIV_UTM_PROFILE.buildCampaign("2607-08", "cta"), buildMensalBeehiivCampaign("2607-08", "cta"));
  });
});

describe("#4482 — regressão: draftToEmail (Clarice, perfil default) inalterado", () => {
  it("continua emitindo utm_source=clarice sem passar utmProfile", () => {
    const { html } = draftToEmail(FULL_DRAFT, "Assunto", "2607");
    const plain = html.replace(/&amp;/g, "&");
    assert.match(plain, /utm_source=clarice/);
    assert.doesNotMatch(plain, /utm_source=mensal-beehiiv/);
  });

  it("continua renderizando APRESENTAÇÃO e as seções CLARICE — * (nada removido pro envio Clarice)", () => {
    const { html } = draftToEmail(FULL_DRAFT, "Assunto", "2607");
    assert.match(html, /se cadastrou na/);
    assert.match(html, /Assine grátis/);
    assert.match(html, /Passo a passo/);
  });
});
