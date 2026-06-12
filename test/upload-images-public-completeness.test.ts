/**
 * upload-images-public-completeness.test.ts (#1275)
 *
 * Tests pra `assertCacheCompleteness` — defesa contra cache parcial entre
 * modes (newsletter rodou mas social não, etc).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertCacheCompleteness } from "../scripts/upload-images-public.ts";

function makeImg(url: string) {
  return {
    file_id: "fake",
    url,
    mime_type: "image/jpeg" as const,
    filename: "fake.jpg",
    target: "drive" as const,
  };
}

describe("assertCacheCompleteness (#1275)", () => {
  describe("mode=social", () => {
    it("passa quando d1/d2/d3 presentes", () => {
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            d1: makeImg("https://x/d1"),
            d2: makeImg("https://x/d2"),
            d3: makeImg("https://x/d3"),
          },
          "social",
        ),
      );
    });

    it("falha quando d2 ausente", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              d1: makeImg("https://x/d1"),
              d3: makeImg("https://x/d3"),
            },
            "social",
          ),
        /Missing: d2/,
      );
    });

    it("falha quando todas as keys ausentes (caso 260513/260514)", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              cover: makeImg("https://x/cover"),
              eia_a: makeImg("https://x/eia_a"),
              eia_b: makeImg("https://x/eia_b"),
            },
            "social",
          ),
        /Missing: d1, d2, d3/,
      );
    });
  });

  describe("mode=newsletter", () => {
    it("passa com cover/d1/eia_a/eia_b/d2_2x1/d3_2x1 (#1583, #2158 finding 3)", () => {
      // #2158 finding 3: d2_2x1/d3_2x1 são required no newsletter mode —
      // email body usa {{IMG:04-d2-2x1.jpg}} / {{IMG:04-d3-2x1.jpg}};
      // se ausentes substitute-image-urls.ts escreve placeholders crus e sai 2.
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            d1: makeImg("https://x/d1"),
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
              d1: makeImg("https://x/d1"),
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
              d1: makeImg("https://x/d1"),
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
              d1: makeImg("https://x/d1"),
              eia_b: makeImg("https://x/eia_b"),
              d2_2x1: makeImg("https://x/d2_2x1"),
              d3_2x1: makeImg("https://x/d3_2x1"),
            },
            "newsletter",
          ),
        /Missing: eia_a/,
      );
    });

    it("#1583: falha quando d1 missing (social preview vai quebrar)", () => {
      assert.throws(
        () =>
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
        /Missing: d1/,
      );
    });
  });

  describe("mode=all", () => {
    it("exige todas as 6 keys", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              cover: makeImg("https://x/cover"),
              eia_a: makeImg("https://x/eia_a"),
              eia_b: makeImg("https://x/eia_b"),
              d1: makeImg("https://x/d1"),
              d2: makeImg("https://x/d2"),
              // d3 missing
            },
            "all",
          ),
        /Missing: d3/,
      );
    });

    it("passa com todas as 6", () => {
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            eia_a: makeImg("https://x/eia_a"),
            eia_b: makeImg("https://x/eia_b"),
            d1: makeImg("https://x/d1"),
            d2: makeImg("https://x/d2"),
            d3: makeImg("https://x/d3"),
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
