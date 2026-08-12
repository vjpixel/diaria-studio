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
  computeFirstSeenMap,
  computeAgedStale,
  filterOverdue,
  shouldAlarmStaleness,
  computeStalenessFingerprint,
  advanceStalenessState,
  buildStalenessAlarmEmail,
  emptyStalenessAlarmState,
  staleEntryKey,
  type StaleHubEdition,
  type AgedStaleHubEdition,
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

// ─── Persistência + alarme (#5123) ─────────────────────────────────────────

const STALE_A: StaleHubEdition = {
  hubSlug: "anthropic-claude",
  date: "2026-08-06",
  editionSlug: "modelo-fictício-06-08",
  editionTitle: "Modelo da Anthropic finge ser humano em teste (fixture)",
  matchedHeadlines: ["Modelo da Anthropic finge ser humano em teste (fixture)"],
};

const STALE_B: StaleHubEdition = {
  hubSlug: "openai-chatgpt",
  date: "2026-08-09",
  editionSlug: "openai-fixture",
  editionTitle: "OpenAI lança algo (fixture)",
  matchedHeadlines: ["OpenAI lança algo (fixture)"],
};

describe("staleEntryKey (#5123)", () => {
  it("chave estável hubSlug:editionSlug", () => {
    assert.equal(staleEntryKey(STALE_A), "anthropic-claude:modelo-fictício-06-08");
  });
});

describe("computeFirstSeenMap (#5123)", () => {
  it("entrada nova (sem chave no mapa anterior) ganha a data de hoje", () => {
    const map = computeFirstSeenMap([STALE_A], {}, "2026-08-10");
    assert.deepEqual(map, { [staleEntryKey(STALE_A)]: "2026-08-10" });
  });

  it("entrada já conhecida MANTÉM a data original (não reseta o relógio a cada execução)", () => {
    const prior = { [staleEntryKey(STALE_A)]: "2026-08-06" };
    const map = computeFirstSeenMap([STALE_A], prior, "2026-08-10");
    assert.deepEqual(map, { [staleEntryKey(STALE_A)]: "2026-08-06" });
  });

  it("entrada que saiu de `stale` (regenerada) é removida do mapa — sem acumular lixo", () => {
    const prior = { [staleEntryKey(STALE_A)]: "2026-08-06", [staleEntryKey(STALE_B)]: "2026-08-06" };
    const map = computeFirstSeenMap([STALE_A], prior, "2026-08-10");
    assert.deepEqual(map, { [staleEntryKey(STALE_A)]: "2026-08-06" });
  });
});

describe("computeAgedStale (#5123)", () => {
  it("calcula ageDays a partir de firstSeenDate — 4 dias corridos", () => {
    const firstSeen = { [staleEntryKey(STALE_A)]: "2026-08-06" };
    const aged = computeAgedStale([STALE_A], firstSeen, "2026-08-10");
    assert.equal(aged.length, 1);
    assert.equal(aged[0].firstSeenDate, "2026-08-06");
    assert.equal(aged[0].ageDays, 4);
  });

  it("entrada detectada hoje -> ageDays 0", () => {
    const firstSeen = { [staleEntryKey(STALE_A)]: "2026-08-10" };
    const aged = computeAgedStale([STALE_A], firstSeen, "2026-08-10");
    assert.equal(aged[0].ageDays, 0);
  });
});

describe("filterOverdue (#5123)", () => {
  it("threshold 3: entrada com 4 dias entra, com 2 dias não", () => {
    const aged: AgedStaleHubEdition[] = [
      { ...STALE_A, firstSeenDate: "2026-08-06", ageDays: 4 },
      { ...STALE_B, firstSeenDate: "2026-08-08", ageDays: 2 },
    ];
    const overdue = filterOverdue(aged, 3);
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].hubSlug, "anthropic-claude");
  });

  it("exatamente no limiar (ageDays === threshold) conta como vencida (>=, não >)", () => {
    const aged: AgedStaleHubEdition[] = [{ ...STALE_A, firstSeenDate: "2026-08-07", ageDays: 3 }];
    assert.equal(filterOverdue(aged, 3).length, 1);
  });
});

describe("idempotência do alarme (#5123, mesmo padrão de hub-drift-check.ts)", () => {
  const overdueA: AgedStaleHubEdition[] = [{ ...STALE_A, firstSeenDate: "2026-08-06", ageDays: 4 }];
  const overdueAB: AgedStaleHubEdition[] = [
    { ...STALE_A, firstSeenDate: "2026-08-06", ageDays: 4 },
    { ...STALE_B, firstSeenDate: "2026-08-06", ageDays: 4 },
  ];

  it("sem pendência -> nunca alarma, independente do estado", () => {
    assert.equal(shouldAlarmStaleness(emptyStalenessAlarmState(), []), false);
  });

  it("pendência nova (estado vazio) -> alarma", () => {
    assert.equal(shouldAlarmStaleness(emptyStalenessAlarmState(), overdueA), true);
  });

  it("MESMO conjunto já alarmado -> não re-alarma", () => {
    const fp = computeStalenessFingerprint(overdueA);
    const state = advanceStalenessState(fp, new Date("2026-08-10T09:30:00Z"));
    assert.equal(shouldAlarmStaleness(state, overdueA), false);
  });

  it("conjunto MUDOU (nova entrada cruzou o limiar) -> alarma de novo", () => {
    const fp = computeStalenessFingerprint(overdueA);
    const state = advanceStalenessState(fp, new Date("2026-08-10T09:30:00Z"));
    assert.equal(shouldAlarmStaleness(state, overdueAB), true);
  });

  it("fingerprint é independente da ordem de chegada", () => {
    assert.equal(computeStalenessFingerprint(overdueAB), computeStalenessFingerprint([...overdueAB].reverse()));
  });

  it("fingerprint NÃO muda com ageDays (só as chaves) — não re-alarma diariamente pelo mesmo conjunto ainda não resolvido", () => {
    const overdueAmanha: AgedStaleHubEdition[] = [{ ...STALE_A, firstSeenDate: "2026-08-06", ageDays: 5 }];
    assert.equal(computeStalenessFingerprint(overdueA), computeStalenessFingerprint(overdueAmanha));
  });

  it("re-arma quando volta a ficar sem pendência (advanceStalenessState(null, ...))", () => {
    const state = advanceStalenessState(null, new Date("2026-08-11T09:30:00Z"));
    assert.equal(state.lastAlarmedFingerprint, null);
    assert.equal(shouldAlarmStaleness(state, overdueA), true);
  });
});

describe("buildStalenessAlarmEmail (#5123)", () => {
  it("assunto cita a contagem + threshold; corpo lista hub/data/slug/ageDays + comandos de regen", () => {
    const overdue: AgedStaleHubEdition[] = [{ ...STALE_A, firstSeenDate: "2026-08-06", ageDays: 4 }];
    const { subject, body } = buildStalenessAlarmEmail(overdue, 3, new Date("2026-08-10T09:30:00Z"));
    assert.match(subject, /1 edição/);
    assert.match(subject, /3\+ dias/);
    assert.match(body, /anthropic-claude:/);
    assert.match(body, /2026-08-06 modelo-fictício-06-08/);
    assert.match(body, /defasada há 4 dia\(s\)/);
    assert.match(body, /npx tsx scripts\/generate-hub-sources\.ts --hub anthropic-claude/);
    assert.match(body, /npx tsx scripts\/build-hub-page\.ts --all/);
  });
});
