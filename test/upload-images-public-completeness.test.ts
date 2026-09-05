/**
 * upload-images-public-completeness.test.ts (#1275)
 *
 * Tests pra `assertCacheCompleteness` — defesa contra cache parcial entre
 * modes (newsletter rodou mas social não, etc).
 *
 * #7399: a chave BASE 1:1 (`d1`/`d2`/`d3`) deixou de ser uploadada — o
 * requisito de "imagem presente pro destaque" agora é satisfeito por
 * QUALQUER um dos dois: o card 4:5 (`d{N}_4x5`) OU o hero 2:1
 * (`hero2x1KeyFor`: `cover` pra d1, `d{N}_2x1` pra d2/d3).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertCacheCompleteness, hero2x1KeyFor } from "../scripts/upload-images-public.ts";

function makeImg(url: string) {
  return {
    file_id: "fake",
    url,
    mime_type: "image/jpeg" as const,
    filename: "fake.jpg",
    target: "drive" as const,
  };
}

describe("hero2x1KeyFor (#7399)", () => {
  it("d1 → cover (nomenclatura especial, é a capa do email)", () => {
    assert.equal(hero2x1KeyFor("d1"), "cover");
  });

  it("d2/d3 → {destaque}_2x1", () => {
    assert.equal(hero2x1KeyFor("d2"), "d2_2x1");
    assert.equal(hero2x1KeyFor("d3"), "d3_2x1");
  });
});

describe("assertCacheCompleteness (#1275, precedência 4:5→2x1 desde #7399)", () => {
  describe("mode=social", () => {
    it("passa quando os 3 cards 4:5 estão presentes", () => {
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            d1_4x5: makeImg("https://x/d1_4x5"),
            d2_4x5: makeImg("https://x/d2_4x5"),
            d3_4x5: makeImg("https://x/d3_4x5"),
          },
          "social",
        ),
      );
    });

    it("#7399: passa via fallback hero 2:1 quando NENHUM 4:5 existe (edição legada, ou geração pulada)", () => {
      // Este é o cenário que o #7399 precisava garantir antes de remover o
      // upload da chave base 1:1: sem 4:5 E sem a chave base, o destaque
      // ainda é considerado "com imagem" via hero 2:1 (sempre presente —
      // é o mesmo hero que o email usa).
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            d2_2x1: makeImg("https://x/d2_2x1"),
            d3_2x1: makeImg("https://x/d3_2x1"),
          },
          "social",
        ),
      );
    });

    it("mistura de 4:5 (d1) e hero 2:1 (d2/d3) — cada destaque resolve independente", () => {
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            d1_4x5: makeImg("https://x/d1_4x5"),
            d2_2x1: makeImg("https://x/d2_2x1"),
            d3_2x1: makeImg("https://x/d3_2x1"),
          },
          "social",
        ),
      );
    });

    it("falha quando d2 não tem nem 4:5 nem hero 2:1", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              d1_4x5: makeImg("https://x/d1_4x5"),
              d3_4x5: makeImg("https://x/d3_4x5"),
            },
            "social",
          ),
        /Missing: d2/,
      );
    });

    it("falha quando todos os destaques ausentes (caso 260513/260514, adaptado #7399)", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              eia_a: makeImg("https://x/eia_a"),
              eia_b: makeImg("https://x/eia_b"),
            },
            "social",
          ),
        /Missing: d1, d2, d3/,
      );
    });

    it("chave base 1x1 legada presente NÃO basta mais (#7399 — sem 4:5/hero, é ignorada)", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              d1: makeImg("https://x/d1"),
              d2: makeImg("https://x/d2"),
              d3: makeImg("https://x/d3"),
            },
            "social",
          ),
        /Missing: d1, d2, d3/,
      );
    });
  });

  describe("mode=newsletter", () => {
    it("passa com cover/eia_a/eia_b/d2_2x1/d3_2x1 (#1583, #2158 finding 3, #7399 remove 'd1')", () => {
      // #2158 finding 3: d2_2x1/d3_2x1 são required no newsletter mode —
      // email body usa {{IMG:04-d2-2x1.jpg}} / {{IMG:04-d3-2x1.jpg}};
      // se ausentes substitute-image-urls.ts escreve placeholders crus e sai 2.
      // #7399: "d1" (chave base 1x1) não é mais required — cover já cobre o
      // fallback de social preview do d1.
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            eia_a: makeImg("https://x/eia_a"),
            eia_b: makeImg("https://x/eia_b"),
            d2_2x1: makeImg("https://x/d2_2x1"),
            d3_2x1: makeImg("https://x/d3_2x1"),
          },
          "newsletter",
        ),
      );
    });

    it("#2158 finding 3: falha quando d2_2x1 ausente (hero email vai ter placeholder cru)", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              cover: makeImg("https://x/cover"),
              eia_a: makeImg("https://x/eia_a"),
              eia_b: makeImg("https://x/eia_b"),
              d3_2x1: makeImg("https://x/d3_2x1"),
              // d2_2x1 ausente
            },
            "newsletter",
          ),
        /Missing: d2_2x1/,
      );
    });

    it("#2158 finding 3: falha quando d3_2x1 ausente", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              cover: makeImg("https://x/cover"),
              eia_a: makeImg("https://x/eia_a"),
              eia_b: makeImg("https://x/eia_b"),
              d2_2x1: makeImg("https://x/d2_2x1"),
              // d3_2x1 ausente
            },
            "newsletter",
          ),
        /Missing: d3_2x1/,
      );
    });

    it("falha quando eia_a missing", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              cover: makeImg("https://x/cover"),
              eia_b: makeImg("https://x/eia_b"),
              d2_2x1: makeImg("https://x/d2_2x1"),
              d3_2x1: makeImg("https://x/d3_2x1"),
            },
            "newsletter",
          ),
        /Missing: eia_a/,
      );
    });

    it("falha quando cover missing (social preview do d1 dependeria só do 4:5, ausente em newsletter mode)", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              eia_a: makeImg("https://x/eia_a"),
              eia_b: makeImg("https://x/eia_b"),
              d2_2x1: makeImg("https://x/d2_2x1"),
              d3_2x1: makeImg("https://x/d3_2x1"),
            },
            "newsletter",
          ),
        /Missing: cover/,
      );
    });

    it("#7399: 'd1' (chave base 1x1) ausente NÃO falha mais newsletter mode", () => {
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            eia_a: makeImg("https://x/eia_a"),
            eia_b: makeImg("https://x/eia_b"),
            d2_2x1: makeImg("https://x/d2_2x1"),
            d3_2x1: makeImg("https://x/d3_2x1"),
            // "d1" nunca presente — não é mais requisito.
          },
          "newsletter",
        ),
      );
    });
  });

  describe("mode=all", () => {
    it("d3 com hero 2:1 mas sem 4:5 ainda passa (hero cobre o requisito por-destaque)", () => {
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            eia_a: makeImg("https://x/eia_a"),
            eia_b: makeImg("https://x/eia_b"),
            d2_2x1: makeImg("https://x/d2_2x1"),
            d3_2x1: makeImg("https://x/d3_2x1"),
            d1_4x5: makeImg("https://x/d1_4x5"),
            d2_4x5: makeImg("https://x/d2_4x5"),
            // d3_4x5 ausente — mas d3_2x1 acima já cobre d3 (hero).
          },
          "all",
        ),
      );
    });

    it("falha quando d3 não tem nem 4:5 nem hero 2:1", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              cover: makeImg("https://x/cover"),
              eia_a: makeImg("https://x/eia_a"),
              eia_b: makeImg("https://x/eia_b"),
              d2_2x1: makeImg("https://x/d2_2x1"),
              // d3_2x1 ausente também
              d1_4x5: makeImg("https://x/d1_4x5"),
              d2_4x5: makeImg("https://x/d2_4x5"),
            },
            "all",
          ),
        (err: Error) => {
          assert.match(err.message, /Missing:/);
          // "d3" isolado (não "d3_2x1") — o destaque em si, não uma key composta.
          assert.match(err.message, /\bd3\b/);
          return true;
        },
      );
    });

    it("passa com newsletter keys completas + 4:5 nos 3 destaques", () => {
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            eia_a: makeImg("https://x/eia_a"),
            eia_b: makeImg("https://x/eia_b"),
            d2_2x1: makeImg("https://x/d2_2x1"),
            d3_2x1: makeImg("https://x/d3_2x1"),
            d1_4x5: makeImg("https://x/d1_4x5"),
            d2_4x5: makeImg("https://x/d2_4x5"),
            d3_4x5: makeImg("https://x/d3_4x5"),
          },
          "all",
        ),
      );
    });
  });

  it("falha com mensagem que lista keys presentes (audit pra debug)", () => {
    try {
      assertCacheCompleteness(
        {
          cover: makeImg("https://x/cover"),
        },
        "social",
      );
      assert.fail("deveria ter throw");
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /Presentes:.*cover/, "mensagem deve listar keys presentes");
      assert.match(msg, /mode=social/, "mensagem deve mencionar mode");
    }
  });
});
