/**
 * test/build-hub-page.test.ts (#4558 Parte A)
 *
 * Cobre `renderGeneratedModule` (build-hub-page.ts) e `buildAnthropicClaudeFaq`
 * (scripts/lib/hubs/anthropic-claude.ts). Um bloco roda contra o
 * `sources.generated.json` REAL commitado (o bug original de contagem de
 * "lançamentos" caindo pra 0 só aparece com o texto NFD real do cache
 * Beehiiv); outro roda contra um fixture SINTÉTICO — necessário desde que
 * `countMatching` passou a receber `sources` como parâmetro (antes fechava
 * sobre o `SOURCES` do módulo, então um fixture sintético não testaria nada
 * de verdade; achado do fleet review).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderGeneratedModule } from "../scripts/build-hub-page.ts";
import { renderHubPage } from "../scripts/lib/shared/hub-page.ts";
import { buildAnthropicClaudeFaq, getAnthropicClaudeHub } from "../scripts/lib/hubs/anthropic-claude.ts";
import { knownUtmSources, HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM } from "../scripts/lib/shared/utm-registry.ts";
import sourcesRaw from "../scripts/lib/hubs/anthropic-claude-sources.generated.json" with { type: "json" };

describe("renderGeneratedModule (#4558 Parte A)", () => {
  it("emite um módulo TS válido com a constante esperada", () => {
    const mod = renderGeneratedModule("anthropic-claude", "<html>oi</html>");
    assert.match(mod, /GERADO, NÃO EDITAR À MÃO/);
    assert.match(mod, /export const HUB_HTML_ANTHROPIC_CLAUDE = "<html>oi<\/html>";/);
  });

  it("nome da constante segue slug com hífen → SCREAMING_SNAKE_CASE", () => {
    const mod = renderGeneratedModule("foo-bar-baz", "x");
    assert.match(mod, /export const HUB_HTML_FOO_BAR_BAZ =/);
  });
});

describe("buildAnthropicClaudeFaq (#4558 Parte A) — regression do bug NFD/NFC", () => {
  const faq = buildAnthropicClaudeFaq(sourcesRaw as never);

  it("6-10 perguntas (issue #4558 item 3)", () => {
    assert.ok(faq.length >= 6 && faq.length <= 10, `esperado 6-10, veio ${faq.length}`);
  });

  it("conta lançamentos > 0 — regression: regex acentuado contra texto NFD batia 0/12 antes da normalização NFC", () => {
    // Busca pelo conteúdo da resposta, não pelo texto da pergunta — a
    // pergunta foi reformulada (achado do editor 260804: FAQ não pode
    // duplicar o H2 de uma section) e não pode mais ser um prefixo estável.
    const launchFaq = faq.find((f) => /noticiou \d+ lançamentos/.test(f.answer));
    assert.ok(launchFaq);
    assert.doesNotMatch(launchFaq.answer, /noticiou 0 lançamentos/);
    assert.match(launchFaq.answer, /noticiou 12 lançamentos/);
  });

  it("cada resposta do FAQ aparece idêntica no corpo visível da página (paridade com o JSON-LD)", () => {
    const hub = getAnthropicClaudeHub();
    // hub.faq é a MESMA lista usada pelo JSON-LD (renderGeoJsonLd) e pelo
    // bloco visível (renderGeoFaqSection) em hub-page.ts — checar aqui que
    // buildAnthropicClaudeFaq() não diverge do que getAnthropicClaudeHub()
    // efetivamente usa.
    assert.deepEqual(hub.faq, faq);
  });

  it("é genuinamente pura — opera sobre o `sources` recebido, não sobre o SOURCES real do módulo (regression: countMatching fechava sobre o módulo, ignorando o parâmetro)", () => {
    // Fixture SINTÉTICO em NFD, deliberadamente diferente do dado real
    // commitado — decoupla esta proteção do estado de
    // anthropic-claude-sources.generated.json (achado do pr-test-analyzer:
    // testar só contra dado real mascara uma regressão futura se o dado
    // mudar de forma). Antes do fix, `launches` aqui teria vindo do SOURCES
    // real (12), não do fixture (2).
    const synthetic = [
      {
        date: "2026-01-01",
        editionSlug: "edicao-1",
        url: "https://diar.ia.br/p/edicao-1",
        matchedHeadlines: ["Anthropic lança modelo X".normalize("NFD")],
      },
      {
        date: "2026-02-01",
        editionSlug: "edicao-2",
        url: "https://diar.ia.br/p/edicao-2",
        matchedHeadlines: ["Anthropic lança modelo Y".normalize("NFD"), "Claude Mythos causa polêmica"],
      },
    ];
    const syntheticFaq = buildAnthropicClaudeFaq(synthetic);
    const launchFaq = syntheticFaq.find((f) => /noticiou \d+ lançamentos/.test(f.answer));
    assert.ok(launchFaq);
    assert.match(launchFaq.answer, /noticiou 2 lançamentos/);
    const mythosFaq = syntheticFaq.find((f) => f.question.includes("Mythos"));
    assert.ok(mythosFaq);
    assert.match(mythosFaq.answer, /citado em 1 edições/);
  });
});

describe("consistência FAQ × prosa das sections/INTRO (#4558 Parte A)", () => {
  // Os números do FAQ são COMPUTADOS (buildAnthropicClaudeFaq sobre
  // SOURCES); os mesmos números citados na prosa de `sections`/`INTRO` são
  // TRANSCRITOS À MÃO (ver docstring do módulo) — corretos hoje, mas sem
  // nada automático religando os dois. Este teste é o "nada automático"
  // que falta: se `sources.generated.json` for regenerado com dado novo e
  // a prosa não for atualizada junto, este teste quebra (achado do fleet
  // review — code-reviewer + pr-test-analyzer, independentemente).
  const hub = getAnthropicClaudeHub();
  const faq = buildAnthropicClaudeFaq(sourcesRaw as never);
  const totalEditions = (sourcesRaw as unknown[]).length;
  const totalMentions = (sourcesRaw as { matchedHeadlines: string[] }[]).reduce(
    (n, s) => n + s.matchedHeadlines.length,
    0,
  );

  it("INTRO cita o mesmo total de edições e manchetes que o FAQ computa", () => {
    assert.match(hub.introParagraph, new RegExp(`destaque em ${totalEditions} edições`));
    assert.match(hub.introParagraph, new RegExp(`${totalMentions} manchetes ao todo`));
  });

  it("a seção de cadência de lançamento cita o mesmo número que o FAQ computa", () => {
    const launchFaq = faq.find((f) => /noticiou \d+ lançamentos/.test(f.answer));
    const launchMatch = /noticiou (\d+) lançamentos/.exec(launchFaq?.answer ?? "");
    assert.ok(launchMatch, "FAQ não tem a contagem de lançamentos no formato esperado");
    const launchSection = hub.sections.find((s) => s.heading.startsWith("Com que frequência"));
    assert.ok(launchSection);
    assert.match(launchSection.paragraphs[0], new RegExp(`noticiou ${launchMatch[1]} lançamentos`));
  });
});

describe("getAnthropicClaudeHub (#4558 Parte A)", () => {
  const hub = getAnthropicClaudeHub();

  it("sourceEditions não é vazio e está ordenado do mais recente pro mais antigo", () => {
    assert.ok(hub.sourceEditions.length > 0);
    for (let i = 1; i < hub.sourceEditions.length; i++) {
      assert.ok(hub.sourceEditions[i - 1].date >= hub.sourceEditions[i].date);
    }
  });

  it("toda sourceEdition aponta pro domínio de marca diar.ia.br", () => {
    for (const e of hub.sourceEditions) {
      assert.match(e.url, /^https:\/\/diar\.ia\.br\/p\//);
    }
  });

  it("contentDate é um literal estático YYYY-MM-DD (não Date.now())", () => {
    assert.match(hub.contentDate, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("ItemList do JSON-LD espelha hub.sourceEditions (#4558 Parte B — reforço de estrutura GEO nos hubs)", () => {
  it("todo item de hub.sourceEditions aparece no ItemList, na mesma ordem, com o mesmo nome e URL", () => {
    const hub = getAnthropicClaudeHub();
    const html = renderHubPage(hub);
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, "hub sem JSON-LD");
    const jsonLd = JSON.parse(m![1]);
    const listNode = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "ItemList");
    assert.ok(listNode, "hub sem node ItemList — sourceEditions não é vazio, deveria ter um");
    assert.equal(listNode.numberOfItems, hub.sourceEditions.length);
    assert.equal(listNode.itemListElement.length, hub.sourceEditions.length);
    for (let i = 0; i < hub.sourceEditions.length; i++) {
      assert.equal(listNode.itemListElement[i].position, i + 1);
      assert.equal(listNode.itemListElement[i].name, hub.sourceEditions[i].title);
      assert.equal(listNode.itemListElement[i].url, hub.sourceEditions[i].url);
    }
  });
});

describe("UTM do rodapé do hub está catalogado em UTM_EMITTERS (#4558 Parte A, mesmo padrão do #4312)", () => {
  // Regressão da MESMA classe que #4312 fechou pra arquivo/livros/cursos
  // (ver test/arquivo-render.test.ts): um literal solto de UTM no rodapé
  // fica invisível pros testes existentes porque knownUtmSources() DERIVA
  // de UTM_EMITTERS — sem a entrada, nada acusa o furo. Achado do fleet
  // review: esta classe de teste existia pras 3 páginas antigas, mas não
  // para o hub novo.
  it("o link 'diar.ia.br' do rodapé emite o triplo registrado, e o source está catalogado", () => {
    const html = renderHubPage(getAnthropicClaudeHub());
    const m = /href="https:\/\/diar\.ia\.br\/?\?(utm_source=[^"]+)"/.exec(html);
    assert.ok(m, "link 'diar.ia.br' do rodapé não tem UTM na URL");
    const params = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
    const utmSource = params.get("utm_source");
    const utmMedium = params.get("utm_medium");
    assert.equal(utmSource, HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM.source);
    assert.equal(utmMedium, HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM.medium);
    assert.ok(
      knownUtmSources().includes((utmSource ?? "").toLowerCase()),
      `utm_source="${utmSource}" emitido pelo render mas ausente de UTM_EMITTERS`,
    );
  });
});
