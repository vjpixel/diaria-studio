/**
 * test/entity-staleness-check.test.ts (#5125 — condição do editor
 * 14/08/2026, "regeneração automática")
 *
 * Cobre a parte PURA de `scripts/lib/entity-staleness-check.ts` — sem
 * tocar `data/beehiiv-cache/` nem os módulos reais de `scripts/lib/entities/`.
 * Mesmo molde de `test/hub-staleness-check.test.ts` (#4924/#5123).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findStaleEntityMentions,
  staleEntryKey,
  computeFirstSeenMap,
  computeAgedStale,
  filterOverdue,
  shouldAlarmEntityStaleness,
  computeEntityStalenessFingerprint,
  advanceEntityStalenessState,
  buildEntityStalenessAlarmEmail,
  emptyEntityStalenessAlarmState,
  type StaleEntityEdition,
  type AgedStaleEntityEdition,
} from "../scripts/lib/entity-staleness-check.ts";
import type { RawCachedPost } from "../scripts/generate-arquivo-titles.ts";
import type { PublishDateOverridesResult } from "../scripts/lib/beehiiv-publish-date.ts";

// Nenhum override em jogo nestes testes — passado explicitamente pra manter
// a função inteiramente sintética (sem depender do arquivo commitado real).
const NO_OVERRIDES: PublishDateOverridesResult = { overrides: {}, discarded: [] };

describe("findStaleEntityMentions (#5125)", () => {
  it("edição confirmada casando o padrão de uma entidade, ausente de mentions -> 1 stale reportada", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "perplexity-lanca-algo-novo",
        title: "Perplexity lança novo recurso de busca",
        status: "confirmed",
        publish_date: Date.UTC(2026, 7, 20, 12) / 1000,
      },
    ];
    const known = { perplexity: new Set<string>() };

    const { stale, warnings } = findStaleEntityMentions(posts, known, NO_OVERRIDES);

    assert.deepEqual(warnings, []);
    const perplexityStale = stale.filter((s) => s.entitySlug === "perplexity");
    assert.equal(perplexityStale.length, 1);
    assert.equal(perplexityStale[0].date, "2026-08-20");
    assert.equal(perplexityStale[0].editionSlug, "perplexity-lanca-algo-novo");
  });

  it("edição já presente em mentions -> não conta como stale", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "perplexity-lanca-algo-novo",
        title: "Perplexity lança novo recurso de busca",
        status: "confirmed",
        publish_date: Date.UTC(2026, 7, 20, 12) / 1000,
      },
    ];
    const known = { perplexity: new Set(["perplexity-lanca-algo-novo"]) };

    const { stale } = findStaleEntityMentions(posts, known, NO_OVERRIDES);
    assert.deepEqual(
      stale.filter((s) => s.entitySlug === "perplexity"),
      [],
    );
  });

  it("edição em ENTITY_EXCLUDED_EDITIONS (exclusão editorial conhecida) -> nunca conta como stale, mesmo ausente de mentions", () => {
    // apple.ts exclui de propósito "siri-agora-tera-gemini" (ver
    // scripts/lib/entities/patterns.ts) — regression guard: sem o filtro de
    // exclusão, este teste falharia (a edição casaria \bsiri\b e apareceria
    // como stale pra sempre, mesmo tendo sido lida e descartada).
    const posts: RawCachedPost[] = [
      {
        slug: "siri-agora-tera-gemini",
        title: "Siri agora terá Gemini",
        status: "confirmed",
        publish_date: Date.UTC(2025, 10, 6, 12) / 1000,
      },
    ];
    const known = { apple: new Set<string>() };

    const { stale } = findStaleEntityMentions(posts, known, NO_OVERRIDES);
    assert.deepEqual(
      stale.filter((s) => s.entitySlug === "apple"),
      [],
    );
  });

  it("entidade sem entrada em mentionEditionSlugsBySlug é tratada como vazia (tudo que casar conta como stale)", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "samsung-lanca-algo",
        title: "Samsung lança novo recurso de IA",
        status: "confirmed",
        publish_date: Date.UTC(2026, 7, 21, 12) / 1000,
      },
    ];
    const { stale } = findStaleEntityMentions(posts, {}, NO_OVERRIDES);
    const entry = stale.find((s) => s.entitySlug === "samsung");
    assert.ok(entry, "esperava entrada stale pra samsung");
    assert.equal(entry?.editionSlug, "samsung-lanca-algo");
  });

  it("posts não-confirmados nunca contam como stale (delegado a collectHubSources)", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "rascunho-samsung",
        title: "Samsung testando algo",
        status: "draft",
        publish_date: Date.UTC(2026, 7, 22, 12) / 1000,
      },
    ];
    const { stale } = findStaleEntityMentions(posts, {}, NO_OVERRIDES);
    assert.deepEqual(stale, []);
  });

  it("warnings de collectHubSources são propagados, prefixados por entidade", () => {
    const posts: RawCachedPost[] = [
      // casa o pattern samsung, mas sem slug -> warning, nunca drop mudo.
      { title: "Samsung lança algo", status: "confirmed", publish_date: 1_800_000_000 },
    ];
    const { warnings } = findStaleEntityMentions(posts, {}, NO_OVERRIDES);
    assert.ok(warnings.some((w) => w.startsWith("[samsung]") && /sem slug resolvível/.test(w)));
  });
});

describe("aging — computeFirstSeenMap/computeAgedStale/filterOverdue (#5125, espelha #5123)", () => {
  const STALE_A: StaleEntityEdition = {
    entitySlug: "samsung",
    date: "2026-08-10",
    editionSlug: "samsung-fixture",
    editionTitle: "Samsung lança algo (fixture)",
    matchedHeadlines: ["Samsung lança algo (fixture)"],
  };

  it("staleEntryKey — chave estável entitySlug:editionSlug", () => {
    assert.equal(staleEntryKey(STALE_A), "samsung:samsung-fixture");
  });

  it("entrada nova ganha a data de hoje; entrada conhecida mantém a original", () => {
    const map1 = computeFirstSeenMap([STALE_A], {}, "2026-08-13");
    assert.deepEqual(map1, { [staleEntryKey(STALE_A)]: "2026-08-13" });

    const map2 = computeFirstSeenMap([STALE_A], { [staleEntryKey(STALE_A)]: "2026-08-10" }, "2026-08-13");
    assert.deepEqual(map2, { [staleEntryKey(STALE_A)]: "2026-08-10" });
  });

  it("computeAgedStale calcula ageDays a partir de firstSeenDate", () => {
    const firstSeen = { [staleEntryKey(STALE_A)]: "2026-08-10" };
    const aged = computeAgedStale([STALE_A], firstSeen, "2026-08-14");
    assert.equal(aged[0].ageDays, 4);
    assert.equal(aged[0].firstSeenDate, "2026-08-10");
  });

  it("filterOverdue: threshold 3, ageDays >= 3 entra (inclusive no limiar)", () => {
    const aged: AgedStaleEntityEdition[] = [
      { ...STALE_A, firstSeenDate: "2026-08-10", ageDays: 3 },
      { ...STALE_A, editionSlug: "outra", firstSeenDate: "2026-08-13", ageDays: 1 },
    ];
    const overdue = filterOverdue(aged, 3);
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].editionSlug, "samsung-fixture");
  });
});

describe("idempotência do alarme (#5125, mesmo padrão de hub-staleness-check.ts)", () => {
  const overdueA: AgedStaleEntityEdition[] = [
    {
      entitySlug: "samsung",
      date: "2026-08-10",
      editionSlug: "samsung-fixture",
      matchedHeadlines: ["Samsung lança algo (fixture)"],
      firstSeenDate: "2026-08-10",
      ageDays: 4,
    },
  ];
  const overdueAB: AgedStaleEntityEdition[] = [
    ...overdueA,
    {
      entitySlug: "apple",
      date: "2026-08-11",
      editionSlug: "apple-fixture",
      matchedHeadlines: ["Apple lança algo (fixture)"],
      firstSeenDate: "2026-08-10",
      ageDays: 4,
    },
  ];

  it("sem pendência vencida -> nunca alarma", () => {
    assert.equal(shouldAlarmEntityStaleness(emptyEntityStalenessAlarmState(), []), false);
  });

  it("pendência nova (estado vazio) -> alarma", () => {
    assert.equal(shouldAlarmEntityStaleness(emptyEntityStalenessAlarmState(), overdueA), true);
  });

  it("MESMO conjunto já alarmado -> não re-alarma", () => {
    const fp = computeEntityStalenessFingerprint(overdueA);
    const state = advanceEntityStalenessState(fp, new Date("2026-08-14T09:00:00Z"));
    assert.equal(shouldAlarmEntityStaleness(state, overdueA), false);
  });

  it("conjunto MUDOU (nova entrada) -> alarma de novo", () => {
    const fp = computeEntityStalenessFingerprint(overdueA);
    const state = advanceEntityStalenessState(fp, new Date("2026-08-14T09:00:00Z"));
    assert.equal(shouldAlarmEntityStaleness(state, overdueAB), true);
  });

  it("fingerprint independente da ordem de chegada", () => {
    assert.equal(computeEntityStalenessFingerprint(overdueAB), computeEntityStalenessFingerprint([...overdueAB].reverse()));
  });

  it("fingerprint NÃO muda com ageDays — não re-alarma diariamente pelo mesmo conjunto ainda não resolvido", () => {
    const amanha: AgedStaleEntityEdition[] = [{ ...overdueA[0], ageDays: 5 }];
    assert.equal(computeEntityStalenessFingerprint(overdueA), computeEntityStalenessFingerprint(amanha));
  });

  it("re-arma quando volta a ficar sem pendência", () => {
    const state = advanceEntityStalenessState(null, new Date("2026-08-15T09:00:00Z"));
    assert.equal(state.lastAlarmedFingerprint, null);
    assert.equal(shouldAlarmEntityStaleness(state, overdueA), true);
  });
});

describe("buildEntityStalenessAlarmEmail (#5125)", () => {
  it("assunto cita a contagem + threshold; corpo lista entidade/data/slug/ageDays + instrução de correção", () => {
    const overdue: AgedStaleEntityEdition[] = [
      {
        entitySlug: "samsung",
        date: "2026-08-10",
        editionSlug: "samsung-fixture",
        editionTitle: "Samsung lança algo (fixture)",
        matchedHeadlines: ["Samsung lança algo (fixture)"],
        firstSeenDate: "2026-08-10",
        ageDays: 4,
      },
    ];
    const { subject, body } = buildEntityStalenessAlarmEmail(overdue, 3, new Date("2026-08-14T09:00:00Z"));
    assert.match(subject, /1 edição/);
    assert.match(subject, /3\+ dias/);
    assert.match(body, /samsung:/);
    assert.match(body, /2026-08-10 samsung-fixture/);
    assert.match(body, /defasada há 4 dia\(s\)/);
    assert.match(body, /build-entity-page\.ts --entity \{slug\}/);
    assert.match(body, /ENTITY_EXCLUDED_EDITIONS/);
  });
});
