/**
 * test/slug.test.ts (#7280)
 *
 * Regressão pros exemplos EXATOS do corpo da issue #7280 ("41% do acervo tem
 * URL pública com acento destruído — e há dois padrões distintos"). Nenhum
 * teste unitário cobria `scripts/lib/slug.ts` até aqui — `slugify`/`seoSlug`
 * só eram exercitados indiretamente via `fix-post-slug.test.ts` (fixtures
 * sem acento) e `check-whatsapp-slug-guard.test.ts` (slug já pronto,
 * sem cobrir o cálculo de `seoSlug` a partir de título acentuado).
 *
 * Achado da investigação #7280: `slugify`/`seoSlug`, o caminho ATIVO hoje
 * (`context/publishers/beehiiv-playbook.md` §4a seta manualmente antes do
 * Schedule; §9/#4570 é gate-blocking pós-Schedule via
 * `scripts/lib/whatsapp-slug-guard.ts`), já produz o comportamento correto —
 * NFD-normaliza, remove os diacríticos combinantes, e NUNCA insere hífen no
 * lugar do caractere acentuado. Os dois padrões quebrados descritos na issue
 * ("decomposição": `lanc-a`, `na-o` — o diacrítico decomposto vira hífen em
 * vez de ser removido; "descarte": `amea-as`, `educa-o` — o caractere
 * acentuado inteiro some) nunca vieram de `slugify`/`seoSlug` — vinham do
 * wizard de Schedule da própria Beehiiv re-derivando o slug do título
 * (`context/publishers/beehiiv-playbook.md` §9, "bug confirmado 260610"),
 * fora deste repositório. Este teste apenas TRAVA que o caminho ativo segue
 * correto — não corrige um bug que já não existe no código.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugify, seoSlug, seoMetaDescription } from "../scripts/lib/slug.ts";

describe("slugify (#7280 — nunca hífen no lugar do acento)", () => {
  it("remove diacríticos PT-BR sem inserir separador (exemplos exatos da issue)", () => {
    assert.equal(slugify("lança agentes autônomos"), "lanca-agentes-autonomos");
    assert.equal(slugify("saúde e educação"), "saude-e-educacao");
    assert.equal(slugify("trará ameaças"), "trara-ameacas");
    assert.equal(slugify("expõe código"), "expoe-codigo");
    assert.equal(slugify("ações"), "acoes");
    assert.equal(slugify("geração Z ... mês"), "geracao-z-mes");
  });

  it("reproduz os títulos reais que geraram slug quebrado no acervo (#7280)", () => {
    // "ai.com lança agentes de IA autônomos" -> padrão decomposição
    // observado no acervo (ai-com-lanc-a-agentes-de-ia-auto-nomos).
    assert.equal(
      slugify("ai.com lança agentes de IA autônomos"),
      "ai-com-lanca-agentes-de-ia-autonomos",
    );
    // "Altman admite: a IA trará ameaças" -> padrão descarte observado
    // (altman-admite-a-ia-trar-amea-as).
    assert.equal(
      slugify("Altman admite: a IA trará ameaças"),
      "altman-admite-a-ia-trara-ameacas",
    );
    // "Anthropic e Gates: US$200 mi em saúde e educação" -> padrão descarte
    // observado (anthropic-e-gates-200-mi-em-sa-de-e-educa-o).
    assert.equal(
      slugify("Anthropic e Gates: US$200 mi em saúde e educação"),
      "anthropic-e-gates-us-200-mi-em-saude-e-educacao",
    );
  });

  it("nunca deixa combining mark sobrar como hífen isolado (regressão do padrão 'decomposição')", () => {
    // Título já em NFD (forma decomposta) não deve produzir hífen no lugar
    // do diacrítico — a regressão concreta era o combining mark escapar do
    // strip e cair no replace de "não-alfanumérico" como separador.
    const nfdTitle = "lança".normalize("NFD"); // "l a n c ̧ a" com cedilha combinante
    assert.equal(slugify(nfdTitle), "lanca");
  });

  it("nunca descarta o caractere acentuado inteiro (regressão do padrão 'descarte')", () => {
    assert.doesNotMatch(slugify("saúde e educação"), /--|^-|-$/);
    assert.doesNotMatch(slugify("saúde e educação"), /-o$|-a$/); // "educa-o" ficaria com esse sufixo
  });
});

describe("seoSlug (#7280 — mesmo algoritmo de slugify, com truncamento)", () => {
  it("aplica a mesma normalização acent-correta que slugify pros exemplos da issue", () => {
    assert.equal(seoSlug("lança agentes autônomos"), "lanca-agentes-autonomos");
    assert.equal(seoSlug("saúde e educação"), "saude-e-educacao");
    assert.equal(seoSlug("trará ameaças"), "trara-ameacas");
  });
});

describe("seoMetaDescription (smoke — não quebra com acento)", () => {
  it("preserva acentos no texto (não é slug, não precisa normalizar)", () => {
    assert.equal(
      seoMetaDescription("Saúde e educação"),
      "Saúde e educação",
    );
  });
});
