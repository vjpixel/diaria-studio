import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSdPrompt,
  parseImageOutput,
} from "../../scripts/lib/schemas/image-generate.ts";

describe("image-generate schemas (#649 Tier B)", () => {
  describe("parseSdPrompt", () => {
    const valid = {
      positive: "A robot holding a flower in a meadow at sunset",
      negative: "blurry, lowres, watermark",
      final_width: 1600,
      final_height: 800,
    };

    it("parse válido (D1 wide 2:1)", () => {
      const result = parseSdPrompt(valid);
      assert.equal(result.final_width, 1600);
      assert.equal(result.final_height, 800);
    });

    it("parse válido (D2/D3 1024×1024)", () => {
      const result = parseSdPrompt({
        ...valid,
        final_width: 1024,
        final_height: 1024,
      });
      assert.equal(result.final_width, 1024);
    });

    it("rejeita positive prompt curto demais", () => {
      assert.throws(
        () => parseSdPrompt({ ...valid, positive: "robot" }),
        /positive|chars/i,
      );
    });

    it("rejeita negative prompt curto demais", () => {
      assert.throws(
        () => parseSdPrompt({ ...valid, negative: "x" }),
        /negative|chars/i,
      );
    });

    it("rejeita dimensão zero ou negativa", () => {
      assert.throws(
        () => parseSdPrompt({ ...valid, final_width: 0 }),
        /too_small|too small|positive|invalid|256/i,
      );
      assert.throws(
        () => parseSdPrompt({ ...valid, final_height: -100 }),
        /too_small|too small|positive|invalid|256/i,
      );
    });

    it("#706: rejeita dimensão < 256 (positive() não é suficiente — 1px passava antes)", () => {
      assert.throws(
        () => parseSdPrompt({ ...valid, final_width: 1 }),
        /256|too_small/i,
      );
      assert.throws(
        () => parseSdPrompt({ ...valid, final_height: 100 }),
        /256|too_small/i,
      );
    });

    it("rejeita dimensão acima do limite (4096px)", () => {
      assert.throws(
        () => parseSdPrompt({ ...valid, final_width: 5000 }),
        /4096|invalid/i,
      );
    });

    it("rejeita dimensão não-inteira", () => {
      assert.throws(
        () => parseSdPrompt({ ...valid, final_width: 1600.5 }),
        /int|invalid/i,
      );
    });
  });

  describe("parseImageOutput", () => {
    it("aceita path .jpg", () => {
      const result = parseImageOutput({ path: "data/editions/260505/04-d1-2x1.jpg" });
      assert.match(result.path, /\.jpg$/);
    });

    it("aceita path .png", () => {
      const result = parseImageOutput({ path: "out/img.png" });
      assert.equal(result.path, "out/img.png");
    });

    it("rejeita path sem extensão de imagem suportada", () => {
      assert.throws(
        () => parseImageOutput({ path: "out/img.gif" }),
        /jpg|png/i,
      );
    });

    it("aceita format opcional", () => {
      const result = parseImageOutput({ path: "out/img.jpg", format: "jpg", width: 1600, height: 800 });
      assert.equal(result.format, "jpg");
    });
  });
});
