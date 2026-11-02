/**
 * test/sync-apoio-segments-kit.test.ts (#4437 Entrega 2, fonte Kit desde o #11225)
 *
 * Funções PURAS de `scripts/sync-apoio-segments-kit.ts`, sempre com fixture,
 * nunca com a API real do Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { segmentsForNivel, buildSegmentsCache, buildVinculoCache } from "../scripts/sync-apoio-segments-kit.ts";
import type { ApoioSubscriberSnapshot } from "../scripts/lib/apoio-nivel-sync.ts";

function sub(overrides: Partial<ApoioSubscriberSnapshot> = {}): ApoioSubscriberSnapshot {
  return { subscriptionId: "sub-1", email: "fulano@x.com", apoioNivel: "", ...overrides };
}

describe("segmentsForNivel (#4437, espelha scripts/lib/apoio-segments-canonical-kit.ts)", () => {
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
    // apoio_nivel vem de um custom field EXTERNO (editável na UI do Kit) —
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
    const subscriptions: ApoioSubscriberSnapshot[] = [
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
    const subscriptions: ApoioSubscriberSnapshot[] = [
      sub({ email: "a@x.com", apoioNivel: "amigo" }),
      sub({ email: "b@x.com", apoioNivel: "patrono" }),
    ];
    const cache = buildSegmentsCache(subscriptions, FIXED_NOW);
    assert.equal(cache["a@x.com"].checkedAt, cache["b@x.com"].checkedAt);
  });
});

describe("buildVinculoCache (#11225)", () => {
  const now = new Date("2026-11-02T12:00:00.000Z");

  it("e-mail de contato ativo no Kit tem vínculo; ausente vira hasVinculo false, nunca some", () => {
    const cache = buildVinculoCache(["Ativa@x.com", "fora@x.com"], [sub({ email: "ativa@x.com", subscriptionId: "7" })], now);
    assert.deepEqual(cache["ativa@x.com"], { hasVinculo: true, subscriptionId: "7", status: "active", fetchedAt: now.toISOString() });
    assert.deepEqual(cache["fora@x.com"], { hasVinculo: false, subscriptionId: null, status: null, fetchedAt: now.toISOString() });
  });

  it("assinante do Kit que não é contato de apoio não entra no cache", () => {
    const cache = buildVinculoCache(["ativa@x.com"], [sub({ email: "ativa@x.com" }), sub({ email: "outra@x.com" })], now);
    assert.deepEqual(Object.keys(cache), ["ativa@x.com"]);
  });
});
