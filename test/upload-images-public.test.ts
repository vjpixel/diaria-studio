import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  publicImageUrl,
  publicFileViewUrl,
  mimeTypeFor,
  sourceImageFor,
} from "../scripts/upload-images-public.ts";

describe("publicImageUrl", () => {
  it("constrói URL com uc?id + export=view", () => {
    assert.equal(
      publicImageUrl("abc123"),
      "https://drive.google.com/uc?id=abc123&export=view",
    );
  });

  it("aceita IDs com caracteres válidos de Drive", () => {
    const id = "1a2b_-Xyz.ZZZ";
    assert.ok(publicImageUrl(id).includes(id));
  });
});

describe("publicFileViewUrl", () => {
  it("constrói URL formato /file/d/ID/view", () => {
    assert.equal(
      publicFileViewUrl("abc123"),
      "https://drive.google.com/file/d/abc123/view?usp=sharing",
    );
  });
});

describe("mimeTypeFor", () => {
  it("jpg/jpeg → image/jpeg", () => {
    assert.equal(mimeTypeFor("foo.jpg"), "image/jpeg");
    assert.equal(mimeTypeFor("foo.jpeg"), "image/jpeg");
    assert.equal(mimeTypeFor("FOO.JPG"), "image/jpeg");
  });

  it("png → image/png", () => {
    assert.equal(mimeTypeFor("foo.png"), "image/png");
  });

  it("webp → image/webp", () => {
    assert.equal(mimeTypeFor("foo.webp"), "image/webp");
  });

  it("gif → image/gif", () => {
    assert.equal(mimeTypeFor("foo.gif"), "image/gif");
  });

  it("desconhecido → octet-stream", () => {
    assert.equal(mimeTypeFor("foo.tif"), "application/octet-stream");
    assert.equal(mimeTypeFor("foo"), "application/octet-stream");
  });
});

describe("sourceImageFor", () => {
  it("d1 usa variante 1x1 (square) pra social", () => {
    assert.equal(sourceImageFor("d1"), "04-d1-1x1.jpg");
  });

  it("d2 usa padrão", () => {
    assert.equal(sourceImageFor("d2"), "04-d2.jpg");
  });

  it("d3 usa padrão", () => {
    assert.equal(sourceImageFor("d3"), "04-d3.jpg");
  });
});
