/**
 * test/extract-hub-facts-5060.test.ts (#5060 Parte B2)
 *
 * Cobertura de `scripts/extract-hub-facts.ts`: o script achata um hub em
 * manifesto JSON que o agente `fact-checker` (`mode: "hub"`) consome sem
 * precisar parsear TypeScript. `classifyLinks` é testado isolado com um
 * `sourceEntries` sintético (modos de falha de classificação); `extractHubFacts`
 * é testado contra o hub REAL `brasil-regulacao` (regression guard — cobre
 * TODO hub de `HUB_LOADERS`, mesmo padrão de `test/hub-fact-gate-5060.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyLinks, extractHubFacts } from "../scripts/extract-hub-facts.ts";
import { HUB_LOADERS } from "../scripts/build-hub-page.ts";
import type { HubSourceEntry } from "../scripts/generate-hub-sources.ts";

function sourceEntry(overrides: Partial<HubSourceEntry> = {}): HubSourceEntry {
  return {
    date: "2026-06-01",
    editionSlug: "edicao-teste",
    url: "https://diar.ia.br/p/edicao-teste",
    matchedHeadlines: ["Manchete de teste"],
    primarySourceUrls: ["https://fonte-oficial.example/pagina"],
    editionTitle: "Edição de teste",
    ...overrides,
  };
}

describe("#5060 Parte B2 — classifyLinks", () => {
  it("classifica link diar.ia.br/p/ como 'edition' e o resto como 'external'", () => {
    const text = "[Evento na diária](https://diar.ia.br/p/edicao-teste) [fonte primária](https://fonte-oficial.example/pagina)";
    const links = classifyLinks(text, [sourceEntry()]);
    assert.equal(links.length, 2);
    assert.equal(links[0].kind, "edition");
    assert.equal(links[1].kind, "external");
  });

  it("link de edição com URL presente no dataset anexa matchedSource com primarySourceUrls", () => {
    const text = "[Evento](https://diar.ia.br/p/edicao-teste)";
    const links = classifyLinks(text, [sourceEntry()]);
    assert.equal(links.length, 1);
    assert.deepEqual(links[0].matchedSource, {
      date: "2026-06-01",
      editionSlug: "edicao-teste",
      matchedHeadlines: ["Manchete de teste"],
      primarySourceUrls: ["https://fonte-oficial.example/pagina"],
    });
  });

  it("link de edição SEM URL correspondente no dataset — kind 'edition', matchedSource ausente (nunca inventa metadado)", () => {
    const text = "[Evento órfão](https://diar.ia.br/p/nao-existe-no-dataset)";
    const links = classifyLinks(text, [sourceEntry()]);
    assert.equal(links.length, 1);
    assert.equal(links[0].kind, "edition");
    assert.equal("matchedSource" in links[0], false);
  });

  it("entrada do dataset SEM primarySourceUrls (campo omitido) — matchedSource.primarySourceUrls vira [] (nunca undefined)", () => {
    const entry = sourceEntry();
    delete (entry as { primarySourceUrls?: unknown }).primarySourceUrls;
    const links = classifyLinks("[Evento](https://diar.ia.br/p/edicao-teste)", [entry]);
    assert.deepEqual(links[0].matchedSource?.primarySourceUrls, []);
  });

  it("preserva `null` nas posições de primarySourceUrls sem âncora encontrada — nunca filtra silenciosamente", () => {
    const entry = sourceEntry({ primarySourceUrls: [null, "https://fonte-oficial.example/outra"] });
    const links = classifyLinks("[Evento](https://diar.ia.br/p/edicao-teste)", [entry]);
    assert.deepEqual(links[0].matchedSource?.primarySourceUrls, [null, "https://fonte-oficial.example/outra"]);
  });

  it("texto sem nenhum link -> []", () => {
    assert.deepEqual(classifyLinks("Um parágrafo qualquer sem link nenhum.", [sourceEntry()]), []);
  });

  it("#5060 fleet review item 5 — link redirecionador/UTM-wrapped contendo 'diar.ia.br/p/' como SUBSTRING (não como host+path real) é classificado 'external', não 'edition'", () => {
    const text = "[Link rastreado](https://tracker.example/go?dest=https://diar.ia.br/p/foo)";
    const links = classifyLinks(text, [sourceEntry()]);
    assert.equal(links.length, 1);
    assert.equal(links[0].kind, "external");
    assert.equal("matchedSource" in links[0], false);
  });

  it("URL malformada (não parseável) nunca é classificada 'edition'", () => {
    const text = "[Link quebrado](not a valid url diar.ia.br/p/foo)";
    const links = classifyLinks(text, [sourceEntry()]);
    // findParagraphLinks pode ou não extrair algo daqui — se extrair, tem que
    // ser "external" (isEditionUrl nunca lança nem retorna true pra input
    // não-parseável pelo construtor URL).
    for (const link of links) assert.equal(link.kind, "external");
  });
});

describe("#5060 Parte B2 — extractHubFacts contra o hub REAL brasil-regulacao", () => {
  it("hub existe em HUB_LOADERS (senão o teste abaixo testaria outra coisa)", () => {
    assert.ok(HUB_LOADERS["brasil-regulacao"]);
  });

  const manifest = extractHubFacts("brasil-regulacao");

  it("sections/faq/sourceEntries não-vazios e com a mesma contagem do hub carregado", () => {
    const hub = HUB_LOADERS["brasil-regulacao"]();
    assert.equal(manifest.sections.length, hub.sections.length);
    assert.equal(manifest.faq.length, hub.faq.length);
    assert.ok(manifest.sourceEntries.length > 0);
    assert.equal(manifest.updatedDate, hub.updatedDate);
  });

  it("todo parágrafo com link diar.ia.br/p/ tem esse link classificado como 'edition'", () => {
    for (const section of manifest.sections) {
      for (const para of section.paragraphs) {
        for (const link of para.links) {
          if (link.url.includes("diar.ia.br/p/")) assert.equal(link.kind, "edition");
        }
      }
    }
  });

  it("o link da edição que originou a contradição Câmara/Senado (#5060 Parte A) resolve matchedSource pra fonte oficial do Senado", () => {
    // #5627 reescreveu a errata: seção 1/intro pararam de narrar a manchete
    // de 22/05/2026 (soberania-ia-pu-blica-nacional) 4x — a cronologia
    // corrigida sai direto, sem citar de novo a edição que causou a
    // contradição. O link pra essa edição continua vivo no FAQ (a única
    // pergunta que ainda precisa nomeá-la, "o Marco Legal já tem autoridade
    // reguladora definida?"), então a garantia do #5060 Parte A — link
    // resolve matchedSource com a fonte oficial do Senado nas
    // primarySourceUrls — passa a valer sobre `manifest.faq`, não mais só
    // sobre `manifest.sections[0]`. Buscar pelo LINK, não por um substring de
    // prosa frágil a reescrita editorial (já reescrita 2x: #5258/#5259,
    // depois #5627).
    const allParagraphs = manifest.sections.flatMap((s) => s.paragraphs);
    const allFaqAnswers = manifest.faq;
    const holder =
      allParagraphs.find((p) => p.links.some((l) => l.url.includes("soberania-ia-pu-blica-nacional"))) ??
      allFaqAnswers.find((f) => f.links.some((l) => l.url.includes("soberania-ia-pu-blica-nacional")));
    assert.ok(
      holder,
      "nenhum parágrafo de seção nem resposta de FAQ linka a edição de 22/05/2026 (soberania-ia-pu-blica-nacional) — a correção da contradição Câmara/Senado saiu do hub inteiro?",
    );
    const editionLink = holder!.links.find((l) => l.url.includes("soberania-ia-pu-blica-nacional"));
    assert.ok(editionLink?.matchedSource, "link da edição de 22/05/2026 deveria resolver matchedSource");
    assert.ok(
      editionLink!.matchedSource!.primarySourceUrls.some((u) => u?.includes("senado.leg.br")),
      "fonte primária oficial do Senado deveria estar entre as primarySourceUrls dessa edição",
    );
    // A correção em si (a data real de aprovação do Plenário, o fato que
    // resolve a contradição) precisa continuar narrada em ALGUM parágrafo de
    // ALGUMA seção — não só o link solto sem a data corrigida ao lado.
    const hasCorrectionText = allParagraphs.some((p) =>
      p.text.includes("Plenário aprovou o PL 2338/23 em 10 de dezembro de 2024"),
    );
    assert.ok(hasCorrectionText, "a correção factual (data real de aprovação do Plenário, 10/12/2024) sumiu das seções");
  });

  it("cobre TODO hub de HUB_LOADERS sem lançar (regression guard, mesmo padrão de test/hub-fact-gate-5060.test.ts)", () => {
    for (const slug of Object.keys(HUB_LOADERS)) {
      assert.doesNotThrow(() => extractHubFacts(slug), `extractHubFacts("${slug}") não deveria lançar`);
    }
  });
});
