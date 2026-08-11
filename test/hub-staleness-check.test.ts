/**
 * test/hub-staleness-check.test.ts (#4924)
 *
 * Cobre a parte PURA de `scripts/lib/hub-staleness-check.ts` — sem tocar
 * `data/beehiiv-cache/` nem os datasets reais de `scripts/lib/hubs/`.
 *
 * Fixture sintética reproduzindo o cenário histórico da issue (janela
 * 04/08 → 10/08/2026): dataset `anthropic-claude` terminando em 2026-08-03,
 * cache com uma edição de 2026-08-06 que casa `HUB_KEYWORD_PATTERNS["anthropic-claude"]`
 * e não está no dataset — detecção deve reportar exatamente 1 edição
 * faltante. **Fixture, não a edição real** — a edição real de 06/08 já
 * entrou no dataset commitado em 10/08 (achado do fleet review anterior),
 * então um teste ancorado nela testaria zero desde então.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findStaleHubEditions,
  buildRegenCommands,
  formatStaleHubReport,
  type StaleHubEdition,
} from "../scripts/lib/hub-staleness-check.ts";
import type { HubSourceEntry } from "../scripts/generate-hub-sources.ts";
import type { RawCachedPost } from "../scripts/generate-arquivo-titles.ts";
import type { PublishDateOverridesResult } from "../scripts/lib/beehiiv-publish-date.ts";

// Nenhum override em jogo nestes testes — passado explicitamente pra manter
// a função inteiramente sintética (sem depender do arquivo commitado real).
const NO_OVERRIDES: PublishDateOverridesResult = { overrides: {}, discarded: [] };

/** Dataset `anthropic-claude` commitado, terminando em 2026-08-03 (fixture
 * — replica a forma real de `anthropic-claude-sources.generated.json` sem
 * usar dado real). */
const ANTHROPIC_DATASET_STALE: HubSourceEntry[] = [
  {
    date: "2026-08-03",
    editionSlug: "edicao-antiga-anthropic",
    url: "https://diar.ia.br/p/edicao-antiga-anthropic",
    matchedHeadlines: ["Anthropic anuncia parceria"],
    editionTitle: "Anthropic anuncia parceria",
  },
];

describe("findStaleHubEditions (#4924)", () => {
  it("cenário histórico 04/08→10/08: cache com edição de 06/08 casando anthropic-claude, ausente do dataset -> 1 stale reportada", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "edicao-antiga-anthropic",
        title: "Anthropic anuncia parceria",
        status: "confirmed",
        publish_date: Date.UTC(2026, 7, 3, 12) / 1000,
      },
      {
        slug: "modelo-fictício-06-08",
        title: "Modelo da Anthropic finge ser humano em teste (fixture)",
        status: "confirmed",
        publish_date: Date.UTC(2026, 7, 6, 12) / 1000,
      },
    ];
    const datasets = { "anthropic-claude": ANTHROPIC_DATASET_STALE };

    const { stale, warnings } = findStaleHubEditions(posts, datasets, NO_OVERRIDES);

    assert.deepEqual(warnings, []);
    // A edição de 03/08 já está no dataset -> não conta. Só a de 06/08 é nova.
    assert.equal(stale.length, 1);
    assert.equal(stale[0].hubSlug, "anthropic-claude");
    assert.equal(stale[0].date, "2026-08-06");
    assert.equal(stale[0].editionSlug, "modelo-fictício-06-08");
    assert.match(stale[0].matchedHeadlines[0], /Anthropic/);
  });

  it("caso negativo: dataset em dia (mesma edição já presente) -> lista vazia", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "edicao-antiga-anthropic",
        title: "Anthropic anuncia parceria",
        status: "confirmed",
        publish_date: Date.UTC(2026, 7, 3, 12) / 1000,
      },
    ];
    const datasets = { "anthropic-claude": ANTHROPIC_DATASET_STALE };

    const { stale, warnings } = findStaleHubEditions(posts, datasets, NO_OVERRIDES);

    assert.deepEqual(stale, []);
    assert.deepEqual(warnings, []);
  });

  it("hub sem entrada em datasetsBySlug é tratado como dataset vazio (tudo que casar conta como stale)", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "primeira-openai",
        title: "OpenAI lança novo modelo",
        status: "confirmed",
        publish_date: Date.UTC(2026, 7, 5, 12) / 1000,
      },
    ];
    // datasets vazio de propósito — nenhum hub tem entrada.
    const { stale } = findStaleHubEditions(posts, {}, NO_OVERRIDES);

    const openaiEntry = stale.find((s) => s.hubSlug === "openai-chatgpt");
    assert.ok(openaiEntry, "esperava entrada stale pra openai-chatgpt");
    assert.equal(openaiEntry?.editionSlug, "primeira-openai");
  });

  it("posts não-confirmados nunca contam como stale (delegado a collectHubSources)", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "rascunho-anthropic",
        title: "Anthropic testando algo",
        status: "draft",
        publish_date: Date.UTC(2026, 7, 7, 12) / 1000,
      },
    ];
    const { stale } = findStaleHubEditions(posts, {}, NO_OVERRIDES);
    assert.deepEqual(stale, []);
  });

  it("casa via subtitle (D2/D3 hooks), não só title — reusa collectHubSources sem duplicar a lógica de split", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "d2-anthropic",
        title: "Governo anuncia nova política de dados abertos",
        subtitle: "Anthropic atualiza o Claude com novo recurso | Outra notícia qualquer",
        status: "confirmed",
        publish_date: Date.UTC(2026, 7, 8, 12) / 1000,
      },
    ];
    const { stale } = findStaleHubEditions(posts, {}, NO_OVERRIDES);
    const entry = stale.find((s) => s.hubSlug === "anthropic-claude");
    assert.ok(entry, "esperava match via subtitle pro hub anthropic-claude");
    assert.equal(entry?.editionSlug, "d2-anthropic");
  });

  it("warnings de collectHubSources são propagados, prefixados por hub", () => {
    const posts: RawCachedPost[] = [
      // casa o pattern anthropic-claude, mas sem slug -> warning, nunca drop mudo.
      { title: "Anthropic lança algo", status: "confirmed", publish_date: 1_800_000_000 },
    ];
    const { warnings } = findStaleHubEditions(posts, {}, NO_OVERRIDES);
    assert.ok(warnings.some((w) => w.startsWith("[anthropic-claude]") && /sem slug resolvível/.test(w)));
  });

  it("múltiplas edições faltantes ordenam por data crescente, depois hubSlug", () => {
    const posts: RawCachedPost[] = [
      { slug: "b-later", title: "OpenAI atualiza o ChatGPT", status: "confirmed", publish_date: Date.UTC(2026, 7, 9, 12) / 1000 },
      { slug: "a-earlier", title: "Anthropic lança Claude novo", status: "confirmed", publish_date: Date.UTC(2026, 7, 5, 12) / 1000 },
    ];
    const { stale } = findStaleHubEditions(posts, {}, NO_OVERRIDES);
    assert.equal(stale.length, 2);
    assert.equal(stale[0].editionSlug, "a-earlier");
    assert.equal(stale[1].editionSlug, "b-later");
  });
});

describe("buildRegenCommands (#4924)", () => {
  it("lista vazia -> nenhum comando", () => {
    assert.deepEqual(buildRegenCommands([]), []);
  });

  it("1 hub -> comando de regen do hub + build-hub-page --all", () => {
    const commands = buildRegenCommands(["anthropic-claude"]);
    assert.deepEqual(commands, [
      "npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude",
      "npx tsx scripts/build-hub-page.ts --all",
    ]);
  });

  it("múltiplos hubs, com duplicata -> dedup + ordem alfabética + 1 único build-hub-page --all no fim", () => {
    const commands = buildRegenCommands(["openai-chatgpt", "anthropic-claude", "openai-chatgpt"]);
    assert.deepEqual(commands, [
      "npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude",
      "npx tsx scripts/generate-hub-sources.ts --hub openai-chatgpt",
      "npx tsx scripts/build-hub-page.ts --all",
    ]);
  });
});

describe("formatStaleHubReport (#4924)", () => {
  it("lista vazia -> string vazia (caller decide se omite a seção)", () => {
    assert.equal(formatStaleHubReport([]), "");
  });

  it("formata bloco legível com data, slug, título e comandos de regen", () => {
    const stale: StaleHubEdition[] = [
      {
        hubSlug: "anthropic-claude",
        date: "2026-08-06",
        editionSlug: "modelo-fictício-06-08",
        editionTitle: "Modelo da Anthropic finge ser humano em teste (fixture)",
        matchedHeadlines: ["Modelo da Anthropic finge ser humano em teste (fixture)"],
      },
    ];
    const report = formatStaleHubReport(stale);
    assert.match(report, /HUBS DEFASADOS/);
    assert.match(report, /anthropic-claude:/);
    assert.match(report, /2026-08-06 modelo-fictício-06-08/);
    assert.match(report, /npx tsx scripts\/generate-hub-sources\.ts --hub anthropic-claude/);
    assert.match(report, /npx tsx scripts\/build-hub-page\.ts --all/);
  });
});
