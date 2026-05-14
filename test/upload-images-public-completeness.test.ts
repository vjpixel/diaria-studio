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
    it("passa com cover/eia_a/eia_b", () => {
      assert.doesNotThrow(() =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            eia_a: makeImg("https://x/eia_a"),
            eia_b: makeImg("https://x/eia_b"),
          },
          "newsletter",
        ),
      );
    });

    it("falha quando eia_a missing", () => {
      assert.throws(
        () =>
          assertCacheCompleteness(
            {
              cover: makeImg("https://x/cover"),
              eia_b: makeImg("https://x/eia_b"),
            },
            "newsletter",
          ),
        /Missing: eia_a/,
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
