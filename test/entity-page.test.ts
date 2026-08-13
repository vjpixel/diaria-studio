/**
 * test/entity-page.test.ts (#5125 item 2/3)
 *
 * Cobertura de `scripts/lib/shared/entity-page.ts` — o validador
 * anti-thin-content (`validateEntityContent`) e o renderer
 * (`renderEntityPage`). Fixture sintética (não o conteúdo real da
 * Perplexity) pra testar cada violação isoladamente, mesmo padrão de
 * `describe("validateHubContent — ...")` em `test/build-hub-page.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateEntityContent,
  renderEntityPage,
  mentionHeadingLabel,
  MIN_ENTITY_MENTIONS,
  type EntityContent,
  type EntityMention,
} from "../scripts/lib/shared/entity-page.ts";
import { getPerplexityEntity } from "../scripts/lib/entities/perplexity.ts";
import { ENTITY_PERPLEXITY_FOOTER_NAV_UTM } from "../scripts/lib/shared/utm-registry.ts";

/** Menção sintética válida — cada teste sobrescreve só o campo sob teste. */
function mention(overrides: Partial<EntityMention> = {}): EntityMention {
  return {
    date: "2026-01-01",
    headline: "Empresa X lança produto Y",
    editionUrl: "https://diar.ia.br/p/edicao-teste",
    editionTitle: "Edição de teste",
    summary:
      "A Empresa X anunciou o produto Y com um conjunto de funcionalidades novas, incluindo suporte a múltiplos idiomas e integração com ferramentas de terceiros — o lançamento marca a entrada da empresa num mercado adjacente.",
    ...overrides,
  };
}

function validMentions(n: number): EntityMention[] {
  return Array.from({ length: n }, (_, i) =>
    mention({
      date: `2026-0${(i % 9) + 1}-01`,
      headline: `Empresa X faz anúncio número ${i}`,
      editionUrl: `https://diar.ia.br/p/edicao-${i}`,
      editionTitle: `Edição ${i}`,
      summary: `Síntese própria e específica do anúncio número ${i}, escrita a partir do corpo real da edição correspondente, não uma paráfrase da manchete.`,
    }),
  );
}

function baseEntity(overrides: Partial<EntityContent> = {}): EntityContent {
  return {
    slug: "empresa-teste",
    name: "Empresa X",
    metaDescription: "Linha do tempo da Empresa X na cobertura da diar.ia.br.",
    introHeading: "O que a Empresa X andou fazendo?",
    introParagraph: "A Empresa X apareceu diversas vezes na cobertura da diária, de um lançamento inicial a expansões sucessivas de produto.",
    mentions: validMentions(MIN_ENTITY_MENTIONS),
    faq: [],
    publishedDate: "2026-06-01",
    updatedDate: "2026-06-01",
    methodologyNote: "O levantamento vem do arquivo da diar.ia.br, não de verificação independente junto à empresa.",
    footerNavUtm: { source: "entity-empresa-teste", medium: "footer-nav" },
    ...overrides,
  };
}

describe("validateEntityContent — happy path", () => {
  it("aceita um EntityContent bem formado", () => {
    assert.deepEqual(validateEntityContent(baseEntity()), []);
  });
});

describe(`validateEntityContent — piso de menções (MIN_ENTITY_MENTIONS = ${MIN_ENTITY_MENTIONS})`, () => {
  it(`rejeita menos de ${MIN_ENTITY_MENTIONS} menções`, () => {
    const entity = baseEntity({ mentions: validMentions(MIN_ENTITY_MENTIONS - 1) });
    const errors = validateEntityContent(entity);
    assert.ok(errors.some((e) => /mínimo \d+ pra justificar página própria/.test(e)), errors.join("; "));
  });

  it(`aceita exatamente ${MIN_ENTITY_MENTIONS} menções`, () => {
    const entity = baseEntity({ mentions: validMentions(MIN_ENTITY_MENTIONS) });
    assert.deepEqual(validateEntityContent(entity), []);
  });
});

describe("validateEntityContent — ordem cronológica ascendente", () => {
  it("rejeita mentions fora de ordem (mais recente antes da mais antiga)", () => {
    const mentions = validMentions(MIN_ENTITY_MENTIONS);
    [mentions[0], mentions[1]] = [mentions[1], mentions[0]]; // troca as 2 primeiras
    const entity = baseEntity({ mentions });
    const errors = validateEntityContent(entity);
    assert.ok(errors.some((e) => /não está ordenado cronologicamente/.test(e)), errors.join("; "));
  });
});

describe("validateEntityContent — domínio de marca", () => {
  it("rejeita editionUrl fora de diar.ia.br", () => {
    const mentions = validMentions(MIN_ENTITY_MENTIONS);
    mentions[0] = mention({ ...mentions[0], editionUrl: "https://diaria.beehiiv.com/p/edicao-teste" });
    const entity = baseEntity({ mentions });
    const errors = validateEntityContent(entity);
    assert.ok(errors.some((e) => /fora do domínio de marca/.test(e)), errors.join("; "));
  });
});

describe("validateEntityContent — critério anti-thin-content: summary vs headline", () => {
  it("rejeita summary idêntico à headline (reempacotamento puro de manchete)", () => {
    const mentions = validMentions(MIN_ENTITY_MENTIONS);
    mentions[0] = mention({
      ...mentions[0],
      headline: "Empresa X lança produto revolucionário",
      summary: "Empresa X lança produto revolucionário",
    });
    const entity = baseEntity({ mentions });
    const errors = validateEntityContent(entity);
    assert.ok(errors.some((e) => /não é síntese própria/.test(e)), errors.join("; "));
  });

  it("rejeita summary que é só a headline com um sufixo colado (prefixo trivial)", () => {
    const mentions = validMentions(MIN_ENTITY_MENTIONS);
    mentions[0] = mention({
      ...mentions[0],
      headline: "Empresa X lança produto revolucionário",
      summary: "Empresa X lança produto revolucionário, segundo comunicado.",
    });
    const entity = baseEntity({ mentions });
    const errors = validateEntityContent(entity);
    assert.ok(errors.some((e) => /não é síntese própria/.test(e)), errors.join("; "));
  });

  it("rejeita summary curto demais (sem espaço pra carregar contexto próprio)", () => {
    const mentions = validMentions(MIN_ENTITY_MENTIONS);
    mentions[0] = mention({ ...mentions[0], summary: "Lançou algo novo." });
    const entity = baseEntity({ mentions });
    const errors = validateEntityContent(entity);
    assert.ok(errors.some((e) => /caracteres — mínimo \d+/.test(e)), errors.join("; "));
  });

  it("aceita summary genuinamente distinto e substancial, mesmo compartilhando palavras com a headline", () => {
    const mentions = validMentions(MIN_ENTITY_MENTIONS);
    mentions[0] = mention({
      ...mentions[0],
      headline: "Empresa X lança produto Y",
      summary:
        "O produto Y chega com integração nativa a 3 plataformas de terceiros e um plano gratuito mais generoso que o da concorrência direta, numa aposta explícita por adoção rápida antes de monetizar.",
    });
    const entity = baseEntity({ mentions });
    assert.deepEqual(validateEntityContent(entity), []);
  });
});

describe("validateEntityContent — campos obrigatórios e datas", () => {
  it("rejeita introParagraph vazio", () => {
    const errors = validateEntityContent(baseEntity({ introParagraph: "   " }));
    assert.ok(errors.some((e) => /introParagraph está vazio/.test(e)), errors.join("; "));
  });

  it("rejeita methodologyNote vazio", () => {
    const errors = validateEntityContent(baseEntity({ methodologyNote: "" }));
    assert.ok(errors.some((e) => /methodologyNote está vazio/.test(e)), errors.join("; "));
  });

  it("rejeita metaDescription > 160 caracteres", () => {
    const errors = validateEntityContent(baseEntity({ metaDescription: "x".repeat(161) }));
    assert.ok(errors.some((e) => /metaDescription tem 161 caracteres/.test(e)), errors.join("; "));
  });

  it("rejeita updatedDate anterior a publishedDate", () => {
    const errors = validateEntityContent(baseEntity({ publishedDate: "2026-06-10", updatedDate: "2026-06-01" }));
    assert.ok(errors.some((e) => /updatedDate .* anterior a publishedDate/.test(e)), errors.join("; "));
  });

  it("rejeita updatedDate anterior à menção mais recente", () => {
    const mentions = validMentions(MIN_ENTITY_MENTIONS);
    mentions[mentions.length - 1] = mention({ ...mentions[mentions.length - 1], date: "2026-12-01" });
    const errors = validateEntityContent(baseEntity({ mentions, publishedDate: "2026-06-01", updatedDate: "2026-06-01" }));
    assert.ok(errors.some((e) => /anterior à menção mais recente/.test(e)), errors.join("; "));
  });
});

describe("mentionHeadingLabel (#5195 self-review finding 1, mesmo padrão de sourceEditionLabel em hub-page.ts)", () => {
  it("editionTitle igual à headline não duplica", () => {
    const m = mention({ headline: "Mesmo texto", editionTitle: "Mesmo texto" });
    assert.equal(mentionHeadingLabel(m), "Mesmo texto");
  });

  it("editionTitle distinto da headline aparece junto — regression do achado: <h2> mostrava só editionTitle, sem relação óbvia com o summary (que é sobre headline)", () => {
    const m = mention({
      headline: "Perplexity levanta US$ 200 mi com avaliação de US$ 20 bi",
      editionTitle: "Profissionais brasileiros de TI são os menos preocupados com impacto da IA na carreira",
    });
    const label = mentionHeadingLabel(m);
    assert.match(label, /Perplexity levanta US\$ 200 mi/);
    assert.match(label, /Profissionais brasileiros de TI são os menos preocupados/);
  });
});

describe("renderEntityPage — fail-fast em EntityContent inválido", () => {
  it("lança com mensagem citando o slug e as violações", () => {
    const entity = baseEntity({ mentions: validMentions(1) });
    assert.throws(() => renderEntityPage(entity), /empresa-teste/);
  });

  it("renderiza normalmente quando válido", () => {
    const html = renderEntityPage(baseEntity());
    assert.match(html, /<!doctype html>/);
    assert.match(html, /<h1>Empresa X/);
  });
});

describe("renderEntityPage — timeline, JSON-LD e UTM", () => {
  const entity = baseEntity();
  const html = renderEntityPage(entity);

  it("renderiza 1 <article class=\"entity-mention\"> por menção, em ordem", () => {
    const count = (html.match(/<article class="entity-mention">/g) ?? []).length;
    assert.equal(count, entity.mentions.length);
  });

  it("cada link da timeline aponta pro editionUrl correspondente", () => {
    for (const m of entity.mentions) {
      assert.ok(html.includes(`href="${m.editionUrl}"`), `link ausente para ${m.editionUrl}`);
    }
  });

  it("o <h2> de cada menção mostra a headline que casou a entidade (#5195 self-review finding 1)", () => {
    for (const m of entity.mentions) {
      assert.ok(
        html.includes(`>${mentionHeadingLabel(m)}</a></h2>`),
        `headline ausente do <h2> para "${m.headline}"`,
      );
    }
  });

  it("ItemList do JSON-LD espelha entity.mentions, mesma ordem, nome = mentionHeadingLabel, mesmo url", () => {
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, "sem JSON-LD");
    const jsonLd = JSON.parse(m![1]);
    const listNode = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "ItemList");
    assert.ok(listNode, "sem node ItemList");
    assert.equal(listNode.numberOfItems, entity.mentions.length);
    for (let i = 0; i < entity.mentions.length; i++) {
      assert.equal(listNode.itemListElement[i].name, mentionHeadingLabel(entity.mentions[i]));
      assert.equal(listNode.itemListElement[i].url, entity.mentions[i].editionUrl);
    }
  });

  it("dateModified do JSON-LD é entity.updatedDate, NUNCA a data da menção mais recente (evita dateModified < datePublished)", () => {
    const m = /"datePublished":"([^"]*)","dateModified":"([^"]*)"/.exec(html);
    assert.ok(m, "sem datePublished/dateModified no JSON-LD");
    assert.equal(m![1], entity.publishedDate);
    assert.equal(m![2], entity.updatedDate);
  });

  it("o link diar.ia.br do rodapé emite o UTM de entity.footerNavUtm, catalogado (conhecido) no registry", () => {
    const linkMatch = /href="https:\/\/diar\.ia\.br\/?\?(utm_source=[^"]+)"/.exec(html);
    assert.ok(linkMatch, "link 'diar.ia.br' do rodapé sem UTM");
    const params = new URLSearchParams(linkMatch![1].replace(/&amp;/g, "&"));
    assert.equal(params.get("utm_source"), entity.footerNavUtm.source);
    assert.equal(params.get("utm_medium"), entity.footerNavUtm.medium);
  });

  it("FAQ vazio: nenhuma seção de FAQ é emitida", () => {
    assert.doesNotMatch(html, /class="geo-faq"/);
  });
});

describe("renderEntityPage — FAQ presente é emitido", () => {
  it("com faq não-vazio, a seção geo-faq aparece com as perguntas", () => {
    const entity = baseEntity({ faq: [{ question: "Pergunta de teste?", answer: "Resposta de teste." }] });
    const html = renderEntityPage(entity);
    assert.match(html, /class="geo-faq"/);
    assert.match(html, /Pergunta de teste\?/);
  });
});

describe("getPerplexityEntity (#5125 item 3 — PoC real)", () => {
  const entity = getPerplexityEntity();

  it("é um EntityContent válido (passa validateEntityContent sem violações)", () => {
    assert.deepEqual(validateEntityContent(entity), []);
  });

  it(`tem pelo menos ${MIN_ENTITY_MENTIONS} menções — lastro real, não thin content`, () => {
    assert.ok(entity.mentions.length >= MIN_ENTITY_MENTIONS);
  });

  it("todo summary é distinto da headline correspondente (síntese própria, não paráfrase)", () => {
    for (const m of entity.mentions) {
      assert.notEqual(m.summary.trim().toLowerCase(), m.headline.trim().toLowerCase());
    }
  });

  it("usa ENTITY_PERPLEXITY_FOOTER_NAV_UTM (source catalogado, não literal solto)", () => {
    assert.equal(entity.footerNavUtm, ENTITY_PERPLEXITY_FOOTER_NAV_UTM);
  });

  it("o link diar.ia.br do rodapé emite exatamente source/medium de ENTITY_PERPLEXITY_FOOTER_NAV_UTM", () => {
    // #5125: HUB_*/ENTITY_*_FOOTER_NAV_UTM não precisam estar em
    // UTM_EMITTERS pra serem válidos (é link de nav, não funil de
    // conversão — mesmo padrão já confirmado pros hubs em
    // test/utm-registry-4041.test.ts, que testa CURSOS_FOOTER_NAV_UTM/
    // LIVROS_FOOTER_NAV_UTM sem checar presença em UTM_EMITTERS). O guard
    // real aqui é que o HTML emite a constante do registry, não um literal
    // solto — já coberto por "renderEntityPage — timeline, JSON-LD e UTM"
    // acima; este teste é a versão desse guard contra o conteúdo REAL da
    // Perplexity, não a fixture sintética.
    const html = renderEntityPage(entity);
    const linkMatch = /href="https:\/\/diar\.ia\.br\/?\?(utm_source=[^"]+)"/.exec(html);
    assert.ok(linkMatch, "link 'diar.ia.br' do rodapé sem UTM");
    const params = new URLSearchParams(linkMatch![1].replace(/&amp;/g, "&"));
    assert.equal(params.get("utm_source"), ENTITY_PERPLEXITY_FOOTER_NAV_UTM.source);
    assert.equal(params.get("utm_medium"), ENTITY_PERPLEXITY_FOOTER_NAV_UTM.medium);
  });
});
