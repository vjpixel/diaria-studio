/**
 * test/apoio-segments-canonical-kit.test.ts (#6049)
 *
 * Trava o mapa dos 6 segmentos Apoio do Kit e o predicado puro
 * `expectedKitSegmentsFor`, que reconstrói pertencimento a partir do valor
 * bruto do custom field — a única forma de auditar segmento no Kit, já que a
 * API não permite ler a condição/membership de volta (ver docstring do
 * módulo).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  APOIO_SEGMENTS_CANONICAL_KIT,
  KIT_APOIO_NIVEL_FIELD_ID,
  KIT_APOIO_NIVEL_FIELD_KEY,
  expectedKitSegmentsFor,
  type ApoioNivel,
} from "../scripts/lib/apoio-segments-canonical-kit.ts";

describe("APOIO_SEGMENTS_CANONICAL_KIT", () => {
  test("tem exatamente 6 entradas, nomes e IDs únicos", () => {
    assert.equal(APOIO_SEGMENTS_CANONICAL_KIT.length, 6);
    const names = APOIO_SEGMENTS_CANONICAL_KIT.map((s) => s.name);
    const ids = APOIO_SEGMENTS_CANONICAL_KIT.map((s) => s.id);
    assert.equal(new Set(names).size, 6, "nomes devem ser únicos");
    assert.equal(new Set(ids).size, 6, "IDs devem ser únicos");
  });

  test("as 4 faixas têm nivel definido, Todos/Nenhum têm nivel null", () => {
    const tiers = APOIO_SEGMENTS_CANONICAL_KIT.filter((s) => s.nivel !== null);
    const unions = APOIO_SEGMENTS_CANONICAL_KIT.filter((s) => s.nivel === null);
    assert.equal(tiers.length, 4);
    assert.equal(unions.length, 2);
    assert.deepEqual(
      unions.map((s) => s.name).sort(),
      ["Apoio — Nenhum", "Apoio — Todos"],
    );
  });

  test("os 4 níveis cobrem exatamente amigo/apoiador/mantenedor/patrono, sem repetir", () => {
    const niveis = APOIO_SEGMENTS_CANONICAL_KIT.map((s) => s.nivel).filter((n): n is ApoioNivel => n !== null);
    assert.deepEqual(niveis.sort(), ["amigo", "apoiador", "mantenedor", "patrono"]);
  });

  test("field id/key batem com o custom field real desta conta (260824)", () => {
    assert.equal(KIT_APOIO_NIVEL_FIELD_ID, 1347084);
    assert.equal(KIT_APOIO_NIVEL_FIELD_KEY, "apoio_nivel");
  });
});

describe("expectedKitSegmentsFor", () => {
  test("valor null/undefined → só Apoio — Nenhum", () => {
    assert.deepEqual(expectedKitSegmentsFor(null), ["Apoio — Nenhum"]);
    assert.deepEqual(expectedKitSegmentsFor(undefined), ["Apoio — Nenhum"]);
  });

  test("string vazia ou só espaço → tratada como ausente, Apoio — Nenhum", () => {
    assert.deepEqual(expectedKitSegmentsFor(""), ["Apoio — Nenhum"]);
    assert.deepEqual(expectedKitSegmentsFor("   "), ["Apoio — Nenhum"]);
  });

  test("cada nível de apoio pertence a Todos + à própria faixa, nunca a Nenhum", () => {
    for (const nivel of ["amigo", "apoiador", "mantenedor", "patrono"] as const) {
      const result = expectedKitSegmentsFor(nivel);
      assert.equal(result.length, 2);
      assert.ok(result.includes("Apoio — Todos"));
      assert.ok(result.some((n) => n.toLowerCase().includes(nivel)));
      assert.ok(!result.includes("Apoio — Nenhum"));
    }
  });

  test("valor desconhecido (nem um dos 4 níveis) entra em Todos mas em nenhuma faixa específica", () => {
    // Não deveria acontecer no dado real (apoio_nivel só assume um dos 4
    // valores ou fica ausente), mas a função não deve lançar nem inventar
    // pertencimento a uma faixa que não existe.
    const result = expectedKitSegmentsFor("valor-invalido");
    assert.deepEqual(result, ["Apoio — Todos"]);
  });

  test("valor com espaços nas bordas é trimado antes de comparar", () => {
    assert.deepEqual(expectedKitSegmentsFor("  patrono  "), ["Apoio — Todos", "Apoio — Patrono"]);
  });
});
