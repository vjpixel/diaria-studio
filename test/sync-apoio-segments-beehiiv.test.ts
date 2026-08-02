/**
 * test/sync-apoio-segments-beehiiv.test.ts (#4437 Entrega 2)
 *
 * Testa as funções PURAS de `scripts/sync-apoio-segments-beehiiv.ts`:
 * `segmentsForNivel` (deriva os segmentos `Apoio — *` de um valor de
 * `apoio_nivel`, espelhando `scripts/lib/apoio-segments-canonical.ts` #4436
 * sem reimplementar a condição) e `buildSegmentsCache` (monta o cache
 * completo a partir de um snapshot de assinantes Beehiiv). Nenhum teste bate
 * na API real — `subscriptions` é sempre uma fixture
 * `BeehiivSubscriptionSnapshot[]` construída à mão, nunca vem de
 * `fetchCurrentBeehiivState` de verdade. Este script nunca foi executado
 * contra a Beehiiv real nesta rodada (guard de publicação do overnight).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { segmentsForNivel, buildSegmentsCache } from "../scripts/sync-apoio-segments-beehiiv.ts";
import type { BeehiivSubscriptionSnapshot } from "../scripts/sync-apoio-nivel-beehiiv.ts";

function sub(overrides: Partial<BeehiivSubscriptionSnapshot> = {}): BeehiivSubscriptionSnapshot {
  return { subscriptionId: "sub-1", email: "fulano@x.com", apoioNivel: "", ...overrides };
}

describe("segmentsForNivel (#4437, espelha scripts/lib/apoio-segments-canonical.ts #4436)", () => {
  it("'amigo' -> ['Apoio — Amigo', 'Apoio — Todos']", () => {
    assert.deepEqual(segmentsForNivel("amigo"), ["Apoio — Amigo", "Apoio — Todos"]);
  });

  it("'apoiador' -> ['Apoio — Apoiador', 'Apoio — Todos']", () => {
    assert.deepEqual(segmentsForNivel("apoiador"), ["Apoio — Apoiador", "Apoio — Todos"]);
  });

  it("'mantenedor' -> ['Apoio — Mantenedor', 'Apoio — Todos']", () => {
    assert.deepEqual(segmentsForNivel("mantenedor"), ["Apoio — Mantenedor", "Apoio — Todos"]);
  });

  it("'patrono' -> ['Apoio — Patrono', 'Apoio — Todos']", () => {
    assert.deepEqual(segmentsForNivel("patrono"), ["Apoio — Patrono", "Apoio — Todos"]);
  });

  it("'' (vazio) -> ['Apoio — Nenhum'] só", () => {
    assert.deepEqual(segmentsForNivel(""), ["Apoio — Nenhum"]);
  });

  it("valor desconhecido (nunca deveria ocorrer, mas defensivo) -> ['Apoio — Nenhum']", () => {
    assert.deepEqual(segmentsForNivel("valor-invalido"), ["Apoio — Nenhum"]);
  });

  it("regressão (self-review #4437): valor de nome de propriedade do Object.prototype ('toString'/'constructor') NUNCA casa como nível válido", () => {
    // apoio_nivel vem de um custom field EXTERNO (editável na UI da Beehiiv) —
    // um `in` ingênuo contra um objeto literal enxergaria a cadeia de
    // protótipo e devolveria uma função em vez de string. Deve cair no
    // fallback "Apoio — Nenhum", nunca produzir um segmento não-string.
    assert.deepEqual(segmentsForNivel("toString"), ["Apoio — Nenhum"]);
    assert.deepEqual(segmentsForNivel("constructor"), ["Apoio — Nenhum"]);
    assert.deepEqual(segmentsForNivel("hasOwnProperty"), ["Apoio — Nenhum"]);
    assert.deepEqual(segmentsForNivel("__proto__"), ["Apoio — Nenhum"]);
  });
});

describe("buildSegmentsCache (#4437)", () => {
  const FIXED_NOW = new Date("2026-08-01T12:00:00Z");

  it("monta 1 entrada por assinante, chaveada por email (já normalizado por fetchCurrentBeehiivState)", () => {
    const subscriptions: BeehiivSubscriptionSnapshot[] = [
      sub({ email: "amigo@x.com", apoioNivel: "amigo" }),
      sub({ email: "sem-nivel@x.com", apoioNivel: "" }),
    ];
    const cache = buildSegmentsCache(subscriptions, FIXED_NOW);
    assert.deepEqual(cache["amigo@x.com"].segments, ["Apoio — Amigo", "Apoio — Todos"]);
    assert.equal(cache["amigo@x.com"].apoioNivel, "amigo");
    assert.equal(cache["amigo@x.com"].checkedAt, FIXED_NOW.toISOString());
    assert.deepEqual(cache["sem-nivel@x.com"].segments, ["Apoio — Nenhum"]);
    assert.equal(cache["sem-nivel@x.com"].apoioNivel, "");
  });

  it("lista vazia -> cache vazio", () => {
    assert.deepEqual(buildSegmentsCache([], FIXED_NOW), {});
  });

  it("checkedAt é o MESMO timestamp pra todas as entradas de uma mesma execução", () => {
    const subscriptions: BeehiivSubscriptionSnapshot[] = [
      sub({ email: "a@x.com", apoioNivel: "amigo" }),
      sub({ email: "b@x.com", apoioNivel: "patrono" }),
    ];
    const cache = buildSegmentsCache(subscriptions, FIXED_NOW);
    assert.equal(cache["a@x.com"].checkedAt, cache["b@x.com"].checkedAt);
  });
});
