/**
 * test/monthly-apoiadores-brevo-render.test.ts (#4593)
 *
 * Cobre a variante Brevo do envio extra pra apoiadores
 * (`scripts/lib/mensal/monthly-apoiadores-brevo-render.ts`), sucessora de
 * `monthly-beehiiv-render.ts` (#4482, nunca enviado ao vivo). Não re-testa
 * `filterDraftForBeehiiv`/`isClariceOnlySection`/`stripRecomendacaoDiariaBlock`
 * aqui — são reusadas SEM modificação do módulo Beehiiv e já cobertas por
 * `test/monthly-beehiiv-render.test.ts`. O foco deste arquivo é o que é NOVO
 * nesta unidade: `draftToEmailApoiadoresBrevo` + `APOIADORES_BREVO_UTM_PROFILE`
 * (decisão do #4593 item 2, opção b — perfil UTM dedicado, sem tocar
 * `BEEHIIV_UTM_PROFILE`/`CLARICE_UTM_PROFILE`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  draftToEmailApoiadoresBrevo,
  APOIADORES_BREVO_UTM_PROFILE,
} from "../scripts/lib/mensal/monthly-apoiadores-brevo-render.ts";
import { BEEHIIV_UTM_PROFILE } from "../scripts/lib/mensal/monthly-beehiiv-render.ts";
import { CLARICE_UTM_PROFILE } from "../scripts/lib/mensal/monthly-render.ts";
import {
  MENSAL_APOIADORES_BREVO_UTM_SOURCE,
  MENSAL_APOIADORES_BREVO_UTM_MEDIUM,
  MENSAL_UTM_SOURCE,
  MENSAL_BEEHIIV_UTM_SOURCE,
  buildMensalApoiadoresBrevoCampaign,
} from "../scripts/lib/shared/utm-registry.ts";

const RECOMENDACAO_BLOCK = [
  "Recomendação da equipe da Clarice",
  "",
  "Você recebe esta curadoria uma vez por mês. Se quiser mais, a diar.ia.br publica uma edição diária.",
  "",
  "→ [Assinar a edição diária](https://diar.ia.br/?utm_source=clarice)",
].join("\n\n");

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
  "**É IA?**",
  "",
  "[...]",
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

describe("#4593 — draftToEmailApoiadoresBrevo", () => {
  it("HTML final não contém boilerplate/conteúdo Clarice-only (reusa filterDraftForBeehiiv)", () => {
    const { html } = draftToEmailApoiadoresBrevo(FULL_DRAFT, "Assunto", "2607");
    assert.doesNotMatch(html, /se cadastrou na Clarice/);
    assert.doesNotMatch(html, /Recomendação da equipe da Clarice/);
    assert.doesNotMatch(html, /Assine grátis/);
  });

  it("preserva destaques, radar e encerramento", () => {
    const { html } = draftToEmailApoiadoresBrevo(FULL_DRAFT, "Assunto", "2607");
    assert.match(html, /Título do destaque/);
    assert.match(html, /Descrição do item do radar/);
    assert.match(html, /Até o mês que vem/);
  });

  it("todo link de marca sai com utm_source=mensal-apoiadores-brevo, nunca clarice nem mensal-beehiiv", () => {
    const { html } = draftToEmailApoiadoresBrevo(FULL_DRAFT, "Assunto", "2607");
    const plain = html.replace(/&amp;/g, "&");
    const utmSources = [...plain.matchAll(/utm_source=([a-z0-9_-]+)/gi)].map((m) => m[1]);
    assert.ok(utmSources.length > 0, "nenhum utm_source emitido — draft de teste sem link de marca?");
    for (const s of utmSources) {
      assert.equal(s, MENSAL_APOIADORES_BREVO_UTM_SOURCE, `utm_source inesperado: ${s}`);
    }
    assert.ok(!plain.includes(`utm_source=${MENSAL_UTM_SOURCE}`), "vazou utm_source=clarice");
    assert.ok(!plain.includes(`utm_source=${MENSAL_BEEHIIV_UTM_SOURCE}`), "vazou utm_source=mensal-beehiiv");
  });

  // #4510 lesson (documentada em monthly-beehiiv-render.ts): o link de voto
  // do É IA? só é embutido no HTML quando há imagem (`imageCell`,
  // monthly-render.ts) — por isso passamos eiaImageUrlA/B aqui.
  it("link de voto do É IA? usa merge tag {{ contact.EMAIL }} (Brevo), nunca {{email}} (Beehiiv)", () => {
    const { html } = draftToEmailApoiadoresBrevo(
      FULL_DRAFT,
      "Assunto",
      "2607",
      "https://img/a.jpg",
      "https://img/b.jpg",
    );
    const plain = html.replace(/&amp;/g, "&");
    assert.match(plain, /\/vote\?email=\{\{ contact\.EMAIL \}\}&edition=/);
    assert.doesNotMatch(plain, /email=\{\{email\}\}/);
  });

  it("voto e leaderboard do É IA? vão pro brand=mensal-apoiadores-brevo, nunca clarice/mensal-beehiiv", () => {
    const { html } = draftToEmailApoiadoresBrevo(
      FULL_DRAFT,
      "Assunto",
      "2607",
      "https://img/a.jpg",
      "https://img/b.jpg",
    );
    const plain = html.replace(/&amp;/g, "&");
    const brands = [...plain.matchAll(/brand=([a-z0-9_-]+)/gi)].map((m) => m[1]);
    assert.ok(brands.length > 0, "nenhum brand emitido — draft de teste sem seção É IA?/leaderboard?");
    for (const b of brands) assert.equal(b, "mensal-apoiadores-brevo", `brand inesperado: ${b}`);
  });

  it("APOIADORES_BREVO_UTM_PROFILE bate com os valores do registry", () => {
    assert.equal(APOIADORES_BREVO_UTM_PROFILE.source, MENSAL_APOIADORES_BREVO_UTM_SOURCE);
    assert.equal(APOIADORES_BREVO_UTM_PROFILE.medium, MENSAL_APOIADORES_BREVO_UTM_MEDIUM);
    assert.equal(
      APOIADORES_BREVO_UTM_PROFILE.buildCampaign("2607-08", "cta"),
      buildMensalApoiadoresBrevoCampaign("2607-08", "cta"),
    );
    assert.equal(APOIADORES_BREVO_UTM_PROFILE.pollMergeTag, "{{ contact.EMAIL }}");
    assert.equal(APOIADORES_BREVO_UTM_PROFILE.pollBrand, "mensal-apoiadores-brevo");
  });
});

describe("#4593 self-review — decisão do item 2 (opção b) não toca perfis existentes", () => {
  it("BEEHIIV_UTM_PROFILE continua com os valores originais (Beehiiv, não Brevo)", () => {
    assert.equal(BEEHIIV_UTM_PROFILE.source, MENSAL_BEEHIIV_UTM_SOURCE);
    assert.equal(BEEHIIV_UTM_PROFILE.pollMergeTag, "{{email}}");
    assert.equal(BEEHIIV_UTM_PROFILE.pollBrand, "mensal-beehiiv");
  });

  it("CLARICE_UTM_PROFILE (envio mensal Clarice REAL, em produção) continua com os valores originais", () => {
    assert.equal(CLARICE_UTM_PROFILE.source, MENSAL_UTM_SOURCE);
    assert.equal(CLARICE_UTM_PROFILE.pollMergeTag, "{{ contact.EMAIL }}");
    assert.equal(CLARICE_UTM_PROFILE.pollBrand, "clarice");
  });

  it("os 3 perfis (Clarice, Beehiiv-legado, Brevo-apoiadores) têm utm_source distintos entre si", () => {
    const sources = [CLARICE_UTM_PROFILE.source, BEEHIIV_UTM_PROFILE.source, APOIADORES_BREVO_UTM_PROFILE.source];
    assert.equal(new Set(sources).size, 3, `utm_source deveria ser único por perfil: ${sources.join(", ")}`);
  });

  it("os 3 perfis têm pollBrand distintos entre si (isolamento do leaderboard É IA?)", () => {
    const brands = [CLARICE_UTM_PROFILE.pollBrand, BEEHIIV_UTM_PROFILE.pollBrand, APOIADORES_BREVO_UTM_PROFILE.pollBrand];
    assert.equal(new Set(brands).size, 3, `pollBrand deveria ser único por perfil: ${brands.join(", ")}`);
  });
});
