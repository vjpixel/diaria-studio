/**
 * test/sync-apoio-segments-kit.test.ts (#4437 Entrega 2, fonte Kit desde o #11225)
 *
 * Funções PURAS de `scripts/sync-apoio-segments-kit.ts`, sempre com fixture,
 * nunca com a API real do Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { segmentsForNivel, buildSegmentsCache, buildVinculoCache, buildPanelCaches } from "../scripts/sync-apoio-segments-kit.ts";
import type { ApoioSubscriberSnapshot } from "../scripts/lib/apoio-nivel-sync.ts";

function sub(overrides: Partial<ApoioSubscriberSnapshot> = {}): ApoioSubscriberSnapshot {
  return { subscriptionId: "sub-1", email: "fulano@x.com", apoioNivel: "", ...overrides };
}

describe("segmentsForNivel (#4437, espelha scripts/lib/apoio-segments-canonical-kit.ts)", () => {
  it("'amigo' -> ['Apoio — Todos', 'Apoio — Amigo']", () => {
    assert.deepEqual(segmentsForNivel("amigo"), ["Apoio — Todos", "Apoio — Amigo"]);
  });

  it("'apoiador' -> ['Apoio — Todos', 'Apoio — Apoiador']", () => {
    assert.deepEqual(segmentsForNivel("apoiador"), ["Apoio — Todos", "Apoio — Apoiador"]);
  });

  it("'mantenedor' -> ['Apoio — Todos', 'Apoio — Mantenedor']", () => {
    assert.deepEqual(segmentsForNivel("mantenedor"), ["Apoio — Todos", "Apoio — Mantenedor"]);
  });

  it("'patrono' -> ['Apoio — Todos', 'Apoio — Patrono']", () => {
    assert.deepEqual(segmentsForNivel("patrono"), ["Apoio — Todos", "Apoio — Patrono"]);
  });

  it("'' (vazio) -> ['Apoio — Nenhum'] só", () => {
    assert.deepEqual(segmentsForNivel(""), ["Apoio — Nenhum"]);
  });

  it("valor fora das 4 faixas: campo preenchido casa só com Todos, como a condição canônica", () => {
    assert.deepEqual(segmentsForNivel("valor-invalido"), ["Apoio — Todos"]);
  });

  it("regressão (self-review #4437): nome de propriedade do Object.prototype nunca devolve função", () => {
    for (const v of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      assert.deepEqual(segmentsForNivel(v), ["Apoio — Todos"]);
    }
  });
});

describe("buildSegmentsCache (#4437)", () => {
  const FIXED_NOW = new Date("2026-08-01T12:00:00Z");

  it("monta 1 entrada por assinante, chaveada por email (já normalizado por fetchCurrentKitState)", () => {
    const subscriptions: ApoioSubscriberSnapshot[] = [
      sub({ email: "amigo@x.com", apoioNivel: "amigo" }),
      sub({ email: "sem-nivel@x.com", apoioNivel: "" }),
    ];
    const cache = buildSegmentsCache(subscriptions, FIXED_NOW);
    assert.deepEqual(cache["amigo@x.com"].segments, ["Apoio — Todos", "Apoio — Amigo"]);
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

describe("buildPanelCaches (#11225)", () => {
  const now = new Date("2026-11-02T12:00:00.000Z");

  it("filtra pelos contatos; contato fora da base entra como consultado", () => {
    const { segments, vinculo } = buildPanelCaches(
      ["Ativa@x.com", "fora@x.com"],
      [sub({ email: "ativa@x.com", apoioNivel: "amigo" }), sub({ email: "outra@x.com", apoioNivel: "patrono" })],
      now,
    );
    assert.deepEqual(Object.keys(segments).sort(), ["ativa@x.com", "fora@x.com"]);
    assert.deepEqual(segments["fora@x.com"], { segments: [], apoioNivel: "", checkedAt: now.toISOString() });
    assert.equal(segments["ativa@x.com"].apoioNivel, "amigo");
    assert.equal(vinculo["fora@x.com"].hasVinculo, false);
    assert.equal(vinculo["ativa@x.com"].hasVinculo, true);
  });

  it("lista vazia de contatos ou de assinantes lança, sem produzir cache", () => {
    assert.throws(() => buildPanelCaches([], [sub()], now), /nenhum contato/);
    assert.throws(() => buildPanelCaches(["a@x.com"], [], now), /nenhum assinante/);
  });
});
