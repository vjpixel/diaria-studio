/**
 * test/monthly-apoiadores-kit-render.test.ts (#7633)
 *
 * Cobre a variante KIT do envio extra pra apoiadores
 * (`scripts/lib/mensal/monthly-apoiadores-kit-render.ts`), sucessora da
 * variante Brevo (#4593). Não re-testa `filterDraftForApoiadores` e vizinhas
 * — reusadas SEM modificação, já cobertas por `test/monthly-draft-filter.test.ts`.
 *
 * O foco é o que diferencia ESTE canal, e cada item é um bug conhecido se
 * sair errado:
 *
 *   - merge tag do voto: `{{ subscriber.email_address }}` (Liquid do Kit). A
 *     sintaxe da Brevo aqui reproduz o #4510 — 100% dos votos do canal
 *     chegando com a string literal, rejeitados por `isValidVoteEmailFormat`.
 *   - `utm_source`/`pollBrand` próprios: `clarice` vazando misturaria a
 *     atribuição e o leaderboard de duas audiências distintas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  draftToEmailApoiadoresKit,
  extractDestaqueTitle,
  deriveApoiadoresKitSubject,
  APOIADORES_KIT_UTM_PROFILE,
} from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";
import { APOIADORES_BREVO_UTM_PROFILE } from "../scripts/lib/mensal/monthly-apoiadores-brevo-render.ts";
import { CLARICE_UTM_PROFILE } from "../scripts/lib/mensal/monthly-render.ts";
import {
  MENSAL_APOIADORES_KIT_UTM_SOURCE,
  MENSAL_APOIADORES_KIT_UTM_MEDIUM,
  MENSAL_APOIADORES_BREVO_UTM_SOURCE,
  MENSAL_UTM_SOURCE,
  MENSAL_BEEHIIV_UTM_SOURCE,
  buildMensalApoiadoresKitCampaign,
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

describe("#7633 — draftToEmailApoiadoresKit", () => {
  it("HTML final não contém boilerplate/conteúdo Clarice-only (reusa filterDraftForApoiadores)", () => {
    const { html } = draftToEmailApoiadoresKit(FULL_DRAFT, "Assunto", "2607");
    assert.doesNotMatch(html, /se cadastrou na Clarice/);
    assert.doesNotMatch(html, /Recomendação da equipe da Clarice/);
    assert.doesNotMatch(html, /Assine grátis/);
  });

  it("preserva destaques, radar e encerramento", () => {
    const { html } = draftToEmailApoiadoresKit(FULL_DRAFT, "Assunto", "2607");
    assert.match(html, /Título do destaque/);
    assert.match(html, /Descrição do item do radar/);
    assert.match(html, /Até o mês que vem/);
  });

  it("todo link de marca sai com utm_source=mensal-apoiadores-kit, nunca clarice/mensal-beehiiv/mensal-apoiadores-brevo", () => {
    const { html } = draftToEmailApoiadoresKit(FULL_DRAFT, "Assunto", "2607");
    const plain = html.replace(/&amp;/g, "&");
    const utmSources = [...plain.matchAll(/utm_source=([a-z0-9_-]+)/gi)].map((m) => m[1]);
    assert.ok(utmSources.length > 0, "nenhum utm_source emitido — draft de teste sem link de marca?");
    for (const s of utmSources) {
      assert.equal(s, MENSAL_APOIADORES_KIT_UTM_SOURCE, `utm_source inesperado: ${s}`);
    }
    assert.ok(!plain.includes(`utm_source=${MENSAL_UTM_SOURCE}`), "vazou utm_source=clarice");
    assert.ok(!plain.includes(`utm_source=${MENSAL_BEEHIIV_UTM_SOURCE}`), "vazou utm_source=mensal-beehiiv");
    assert.ok(!plain.includes(`utm_source=${MENSAL_APOIADORES_BREVO_UTM_SOURCE}`), "vazou utm_source=mensal-apoiadores-brevo");
  });

  // O link de voto do É IA? só é embutido quando há imagem (`imageCell`,
  // monthly-render.ts) — daí os eiaImageUrlA/B (mesma nota do teste Brevo).
  it("link de voto do É IA? usa merge tag Liquid do Kit, nunca a da Brevo nem a do Beehiiv (regressão #4510)", () => {
    const { html } = draftToEmailApoiadoresKit(
      FULL_DRAFT,
      "Assunto",
      "2607",
      "https://img/a.jpg",
      "https://img/b.jpg",
    );
    const plain = html.replace(/&amp;/g, "&");
    assert.match(plain, /\/vote\/[^"]+\/A\?email=\{\{ subscriber\.email_address \}\}/);
    assert.doesNotMatch(plain, /email=\{\{ contact\.EMAIL \}\}/);
    assert.doesNotMatch(plain, /email=\{\{email\}\}/);
  });

  it("voto e leaderboard do É IA? vão pro brand=mensal-apoiadores-kit", () => {
    const { html } = draftToEmailApoiadoresKit(
      FULL_DRAFT,
      "Assunto",
      "2607",
      "https://img/a.jpg",
      "https://img/b.jpg",
    );
    const plain = html.replace(/&amp;/g, "&");
    const brands = [...plain.matchAll(/brand=([a-z0-9_-]+)/gi)].map((m) => m[1]);
    assert.ok(brands.length > 0, "nenhum brand emitido — draft de teste sem seção É IA?/leaderboard?");
    for (const b of brands) assert.equal(b, "mensal-apoiadores-kit", `brand inesperado: ${b}`);
  });

  it("APOIADORES_KIT_UTM_PROFILE bate com os valores do registry", () => {
    assert.equal(APOIADORES_KIT_UTM_PROFILE.source, MENSAL_APOIADORES_KIT_UTM_SOURCE);
    assert.equal(APOIADORES_KIT_UTM_PROFILE.medium, MENSAL_APOIADORES_KIT_UTM_MEDIUM);
    assert.equal(
      APOIADORES_KIT_UTM_PROFILE.buildCampaign("2607-08", "cta"),
      buildMensalApoiadoresKitCampaign("2607-08", "cta"),
    );
    assert.equal(APOIADORES_KIT_UTM_PROFILE.pollMergeTag, "{{ subscriber.email_address }}");
    assert.equal(APOIADORES_KIT_UTM_PROFILE.pollBrand, "mensal-apoiadores-kit");
  });
});

describe("#7633 — isolamento entre os 3 perfis que coexistem no repo", () => {
  const PROFILES = [CLARICE_UTM_PROFILE, APOIADORES_BREVO_UTM_PROFILE, APOIADORES_KIT_UTM_PROFILE];

  it("utm_source é único por perfil", () => {
    const sources = PROFILES.map((p) => p.source);
    assert.equal(new Set(sources).size, PROFILES.length, `utm_source deveria ser único por perfil: ${sources.join(", ")}`);
  });

  it("pollBrand é único por perfil (isolamento do leaderboard É IA?)", () => {
    const brands = PROFILES.map((p) => p.pollBrand);
    assert.equal(new Set(brands).size, PROFILES.length, `pollBrand deveria ser único por perfil: ${brands.join(", ")}`);
  });

  it("CLARICE_UTM_PROFILE (envio Clarice REAL, em produção) segue intocado pela migração", () => {
    assert.equal(CLARICE_UTM_PROFILE.source, MENSAL_UTM_SOURCE);
    assert.equal(CLARICE_UTM_PROFILE.pollMergeTag, "{{ contact.EMAIL }}");
    assert.equal(CLARICE_UTM_PROFILE.pollBrand, "clarice");
  });
});

// ── #7867 item 3 — subject próprio, derivado do título do Destaque 1 ───────

describe("#7867 item 3 — extractDestaqueTitle", () => {
  it("extrai o título (linha após o header) do destaque pedido", () => {
    assert.equal(extractDestaqueTitle(FULL_DRAFT, 1), "Título do destaque");
  });

  it("destaque inexistente -> null", () => {
    assert.equal(extractDestaqueTitle(FULL_DRAFT, 2), null);
  });

  it("tolera '**' de negrito Drive ao redor do título", () => {
    const draft = ["**DESTAQUE 1 | BRASIL**", "", "**Título em negrito**", "", "Corpo."].join("\n");
    assert.equal(extractDestaqueTitle(draft, 1), "Título em negrito");
  });
});

describe("#7867 item 3 — deriveApoiadoresKitSubject", () => {
  it('formato "Retrospectiva de {mês}: {título do D1}"', () => {
    assert.equal(deriveApoiadoresKitSubject(FULL_DRAFT, "2608"), "Retrospectiva de agosto: Título do destaque");
  });

  it("mês por extenso em minúsculas, do yymm — não do subject herdado", () => {
    assert.equal(deriveApoiadoresKitSubject(FULL_DRAFT, "2601"), "Retrospectiva de janeiro: Título do destaque");
    assert.equal(deriveApoiadoresKitSubject(FULL_DRAFT, "2612"), "Retrospectiva de dezembro: Título do destaque");
  });

  it("yymm inválido -> lança (nunca gera subject com mês incorreto)", () => {
    assert.throws(() => deriveApoiadoresKitSubject(FULL_DRAFT, "2613"), /yymm inválido/);
  });

  it("draft sem Destaque 1 -> lança (subject vazio num canal pago não é fallback silencioso)", () => {
    const semDestaque = ["**ASSUNTO**", "1. Assunto", "", "**PREVIEW**", "", "Preview."].join("\n");
    assert.throws(() => deriveApoiadoresKitSubject(semDestaque, "2608"), /Destaque 1/);
  });

  it("ignora completamente o chosenSubject/ASSUNTO do draft — nunca herda do Clarice", () => {
    // FULL_DRAFT tem "**ASSUNTO (3 OPÇÕES)**\n1. Assunto de teste" — o subject
    // derivado não pode conter esse texto.
    const subject = deriveApoiadoresKitSubject(FULL_DRAFT, "2608");
    assert.doesNotMatch(subject, /Assunto de teste/);
  });
});
