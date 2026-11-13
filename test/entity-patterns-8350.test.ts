/**
 * test/entity-patterns-8350.test.ts (#8350, fixer da PR #12957)
 *
 * Padrões do lote brasileiro de entidades em `ENTITY_KEYWORD_PATTERNS`, a
 * paridade de chaves com `ENTITY_LOADERS`, a exclusão editorial do PL 2338 e
 * a cobertura do alarme por slug (limitação #12958).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENTITY_KEYWORD_PATTERNS, ENTITY_EXCLUDED_EDITIONS } from "../scripts/lib/entities/patterns.ts";
import { ENTITY_LOADERS } from "../scripts/build-entity-page.ts";
import { stripAccents } from "../scripts/generate-hub-sources.ts";
import {
  computeEntityAlarmCoverage,
  formatEntityAlarmCoverage,
  BODY_ONLY_COVERAGE_SLUGS,
} from "../scripts/lib/entity-staleness-check.ts";
import type { RawCachedPost } from "../scripts/generate-arquivo-titles.ts";
import type { PublishDateOverridesResult } from "../scripts/lib/beehiiv-publish-date.ts";

const NO_OVERRIDES: PublishDateOverridesResult = { overrides: {}, discarded: [] };

/** Mesma normalização que `collectHubSources` aplica antes do match. */
function matches(slug: string, text: string): boolean {
  return ENTITY_KEYWORD_PATTERNS[slug].test(stripAccents(text));
}

describe("ENTITY_KEYWORD_PATTERNS — lote brasileiro (#8350), após stripAccents", () => {
  const cases: Array<[string, string, boolean]> = [
    ["maritaca-ai", "Sabiá-3 chega ao mercado", true],
    ["maritaca-ai", "Sabiá 4 Thinking: Brasil tem modelo de raciocínio", true],
    ["maritaca-ai", "Sabiazinho-4 acerta 85% na OAB", true],
    ["maritaca-ai", "Maritaca AI lança modelo", true],
    ["maritaca-ai", "Eu não sabia que a IA fazia isso", false],
    ["maritaca-ai", "Quem sabia? Ninguém", false],
    ["pl-2338", "PL 2.338 volta à pauta", true],
    ["pl-2338", "PL 2338/2023 na Câmara", true],
    ["pl-2338", "PL nº 2338 em votação", true],
    ["pl-2338", "PL n. 2.338 avança", true],
    ["pl-2338", "Projeto de Lei 2338 é adiado", true],
    ["pl-2338", "Projeto de Lei nº 2.338/2023", true],
    ["pl-2338", "Marco Legal da Inteligência Artificial", true],
    ["pl-2338", "Câmara vota marco legal da IA", true],
    ["pl-2338", "Marco legal das criptomoedas", false],
    ["pl-2338", "PL 23380 sobre outro tema", false],
    ["tse", "TSE exige aviso em propaganda", true],
    ["tse", "Tribunal Superior Eleitoral julga deepfake", true],
    ["tse", "Tsetse mosquito", false],
    ["nubank", "Nubank lança assistente", true],
  ];
  for (const [slug, text, expected] of cases) {
    it(`${slug} ${expected ? "casa" : "não casa"}: "${text}"`, () => {
      assert.equal(matches(slug, text), expected);
    });
  }
});

describe("ENTITY_KEYWORD_PATTERNS x ENTITY_LOADERS", () => {
  it("as chaves são as mesmas (página sem padrão nunca alarma; padrão sem página alarma à toa)", () => {
    assert.deepEqual(Object.keys(ENTITY_KEYWORD_PATTERNS).sort(), Object.keys(ENTITY_LOADERS).sort());
  });

  it("toda chave de ENTITY_EXCLUDED_EDITIONS é uma entidade real", () => {
    for (const slug of Object.keys(ENTITY_EXCLUDED_EDITIONS)) assert.ok(slug in ENTITY_LOADERS, slug);
  });

  it("PL 2338 exclui a edição de 22/05/2026 (aprovação no Senado datada errado)", () => {
    assert.ok(ENTITY_EXCLUDED_EDITIONS["pl-2338"].includes("soberania-ia-pu-blica-nacional"));
  });

  it("BODY_ONLY_COVERAGE_SLUGS só lista entidades reais", () => {
    for (const slug of BODY_ONLY_COVERAGE_SLUGS) assert.ok(slug in ENTITY_LOADERS, slug);
  });
});

describe("computeEntityAlarmCoverage (#8350 item 8, limitação #12958)", () => {
  it("conta só as menções cuja edição casa o padrão por título/subtítulo", () => {
    const posts: RawCachedPost[] = [
      { slug: "sabiazinho-chega", title: "Sabiazinho-4 chega", status: "confirmed", publish_date: Date.UTC(2026, 8, 11, 12) / 1000 },
      { slug: "outra-noticia", title: "OpenAI lança algo", status: "confirmed", publish_date: Date.UTC(2026, 9, 26, 12) / 1000 },
    ];
    const known = { "maritaca-ai": new Set(["sabiazinho-chega", "outra-noticia", "nao-esta-no-cache"]) };
    const [c] = computeEntityAlarmCoverage(posts, known, ["maritaca-ai"], NO_OVERRIDES);
    assert.deepEqual(c, { entitySlug: "maritaca-ai", visible: 1, total: 3 });
    assert.equal(
      formatEntityAlarmCoverage(c),
      "maritaca-ai: título/subtítulo vê 1/3 menções; scanner de texto completo não rodou (sem HTML do site) — menção nova só no corpo não alarma (#12958)",
    );
    assert.equal(
      formatEntityAlarmCoverage({ ...c, fullTextVisible: 3 }),
      "maritaca-ai: título/subtítulo vê 1/3 menções; texto completo vê 3/3 (#12958)",
    );
  });

  it("slug sem menções conhecidas é pulado, sem lançar", () => {
    assert.deepEqual(computeEntityAlarmCoverage([], {}, ["tse"], NO_OVERRIDES), []);
  });
});
