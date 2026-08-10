/**
 * test/hub-match.test.ts (#4907)
 *
 * Cobre a parte PURA de `scripts/lib/hub-match.ts` — a função `matchEditionHub`
 * (decide se as manchetes do dia casam `HUB_KEYWORD_PATTERNS` de algum hub
 * existente) e `extractBoldLinkTitles` (extrai as opções de título de um
 * draft de destaque). Fixtures cobrem os 3 casos exigidos pela issue: nenhum
 * match, um match, e mais de um match (regra explícita — ambíguo → `null`,
 * não escolha implícita pela ordem do Record).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { matchEditionHub, extractBoldLinkTitles, buildHubContextualUrl } from "../scripts/lib/hub-match.ts";
import { HUB_KEYWORD_PATTERNS } from "../scripts/generate-hub-sources.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

describe("#4907 — matchEditionHub", () => {
  it("nenhuma manchete casa nenhum hub -> null", () => {
    const result = matchEditionHub([
      ["Governo anuncia nova política de dados abertos"],
      ["Startup brasileira levanta rodada seed"],
    ]);
    assert.equal(result, null);
  });

  it("uma manchete casa exatamente 1 hub -> match com slug/label/url/destaqueIndex corretos", () => {
    const result = matchEditionHub([
      ["Anthropic lança novo modelo Claude Opus"],
      ["Startup brasileira levanta rodada seed"],
    ]);
    assert.ok(result);
    assert.equal(result.slug, "anthropic-claude");
    assert.equal(result.label, "Anthropic e Claude");
    assert.equal(result.destaqueIndex, 0);
    assert.match(result.url, /^https:\/\/arquivo\.diar\.ia\.br\/temas\/anthropic-claude\?/);
  });

  it("match no 2º destaque (não no 1º) devolve destaqueIndex=1", () => {
    const result = matchEditionHub([
      ["Governo anuncia nova política de dados abertos"],
      ["OpenAI atualiza o ChatGPT com novo recurso"],
    ]);
    assert.ok(result);
    assert.equal(result.slug, "openai-chatgpt");
    assert.equal(result.destaqueIndex, 1);
  });

  it("manchetes casam MAIS DE UM hub -> null (regra explícita, não ordem do Record)", () => {
    const result = matchEditionHub([
      ["Anthropic lança novo modelo Claude"],
      ["Google atualiza o Gemini com nova versão"],
    ]);
    assert.equal(result, null);
  });

  it("múltiplas manchetes do MESMO destaque casando o MESMO hub ainda conta como 1 match", () => {
    const result = matchEditionHub([
      ["Anthropic lança novo modelo", "Claude Opus chega com mais contexto", "Anthropic e a corrida de IA"],
    ]);
    assert.ok(result);
    assert.equal(result.slug, "anthropic-claude");
  });

  it("array vazio de manchetes por destaque não quebra (defensivo)", () => {
    const result = matchEditionHub([[], []]);
    assert.equal(result, null);
  });

  it("aceita 2 ou 3 destaques (edição de 2 destaques é o edge case legítimo, #3369)", () => {
    const twoDestaques = matchEditionHub([["Meta anuncia atualização do Llama"], ["Notícia qualquer"]]);
    assert.ok(twoDestaques);
    assert.equal(twoDestaques.slug, "meta-ai");

    const threeDestaques = matchEditionHub([
      ["Notícia qualquer"],
      ["Outra notícia qualquer"],
      ["Meta anuncia atualização do Llama"],
    ]);
    assert.ok(threeDestaques);
    assert.equal(threeDestaques.destaqueIndex, 2);
  });

  it("cobre TODOS os hubs de HUB_KEYWORD_PATTERNS — cada slug tem entrada correspondente em HUB_META", () => {
    // Regressão defensiva: se um hub novo for adicionado a HUB_KEYWORD_PATTERNS
    // sem entrada em HUB_META, matchEditionHub descarta o match silenciosamente
    // (ver `if (!meta) return null` no módulo sob teste) — este teste torna
    // esse drift visível em vez de deixá-lo como null indistinguível.
    for (const slug of Object.keys(HUB_KEYWORD_PATTERNS)) {
      assert.ok(
        HUB_META.some((h) => h.slug === slug),
        `HUB_META não tem entrada pro slug "${slug}" (presente em HUB_KEYWORD_PATTERNS)`,
      );
    }
  });
});

describe("#4907 — buildHubContextualUrl", () => {
  it("monta URL do hub com UTM contextual distinguível (source=newsletter, campaign=hub-{slug}-contextual)", () => {
    const url = buildHubContextualUrl("google-gemini");
    assert.equal(
      url,
      "https://arquivo.diar.ia.br/temas/google-gemini?utm_source=newsletter&utm_medium=email&utm_campaign=hub-google-gemini-contextual",
    );
  });
});

describe("#4907 — extractBoldLinkTitles", () => {
  it("extrai as 3 opções de título do draft pré-gate (bold + link)", () => {
    const draft = `**DESTAQUE 1 | 💰 MERCADO**

**[Anthropic levanta rodada de US$ 2 bi](https://exemplo.com/a)**

**[Rodada bilionária eleva valuation da Anthropic](https://exemplo.com/a)**

**[Anthropic capta US$ 2 bi em nova rodada](https://exemplo.com/a)**

Corpo do destaque com texto qualquer.

Por que isso importa:

Explicação qualquer.`;
    assert.deepEqual(extractBoldLinkTitles(draft), [
      "Anthropic levanta rodada de US$ 2 bi",
      "Rodada bilionária eleva valuation da Anthropic",
      "Anthropic capta US$ 2 bi em nova rodada",
    ]);
  });

  it("extrai o título único do formato pós-gate (sem bold)", () => {
    const draft = `**DESTAQUE 1 | 💰 MERCADO**

[Anthropic levanta rodada de US$ 2 bi](https://exemplo.com/a)

Corpo do destaque.

Por que isso importa:

Explicação.`;
    assert.deepEqual(extractBoldLinkTitles(draft), ["Anthropic levanta rodada de US$ 2 bi"]);
  });

  it("NÃO casa itens do bloco Aprofunde (bullet + link + fonte)", () => {
    const draft = `**DESTAQUE 1 | 💰 MERCADO**

**[Título](https://exemplo.com/a)**

Corpo.

Por que isso importa:

Explicação.

Aprofunde:

* [Outro artigo do cluster](https://exemplo.com/b) - Fonte X`;
    assert.deepEqual(extractBoldLinkTitles(draft), ["Título"]);
  });

  it("string sem nenhum link -> array vazio", () => {
    assert.deepEqual(extractBoldLinkTitles("texto qualquer sem links"), []);
  });
});
