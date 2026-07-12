import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { embedImagesAsDataUri } from "../scripts/embed-images-base64.ts";

describe("embedImagesAsDataUri", () => {
  const dir = mkdtempSync(join(tmpdir(), "embed-images-"));
  const jpgPath = join(dir, "04-d1-2x1.jpg");
  // JPEG mínimo válido (marcador SOI+EOI) — conteúdo não importa, só os bytes.
  writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("substitui URL remota por data: URI quando arquivo local existe", () => {
    const html = `<img src="https://poll.diaria.workers.dev/img/x.jpg" alt="cover"/>`;
    const images = {
      cover: {
        url: "https://poll.diaria.workers.dev/img/x.jpg",
        filename: "04-d1-2x1.jpg",
        mime_type: "image/jpeg",
      },
    };
    const result = embedImagesAsDataUri(html, images, dir);
    assert.equal(result.embedded.length, 1);
    assert.equal(result.missing.length, 0);
    assert.ok(result.html.includes("data:image/jpeg;base64,"));
    assert.ok(!result.html.includes("poll.diaria.workers.dev"));
  });

  it("marca como missing quando arquivo local não existe, mantém URL remota", () => {
    const html = `<img src="https://poll.diaria.workers.dev/img/y.jpg" alt="d2"/>`;
    const images = {
      d2: {
        url: "https://poll.diaria.workers.dev/img/y.jpg",
        filename: "04-d2-1x1.jpg", // não existe em `dir`
        mime_type: "image/jpeg",
      },
    };
    const result = embedImagesAsDataUri(html, images, dir);
    assert.equal(result.embedded.length, 0);
    assert.deepEqual(result.missing, ["04-d2-1x1.jpg"]);
    assert.ok(result.html.includes("https://poll.diaria.workers.dev/img/y.jpg"));
  });

  it("ignora entries cuja URL não aparece no HTML", () => {
    const html = `<p>sem imagem aqui</p>`;
    const images = {
      cover: {
        url: "https://poll.diaria.workers.dev/img/x.jpg",
        filename: "04-d1-2x1.jpg",
        mime_type: "image/jpeg",
      },
    };
    const result = embedImagesAsDataUri(html, images, dir);
    assert.equal(result.embedded.length, 0);
    assert.equal(result.missing.length, 0);
    assert.equal(result.html, html);
  });

  it("substitui todas as ocorrências da mesma URL (ex: cover repetida)", () => {
    const html = `<img src="https://poll.diaria.workers.dev/img/x.jpg"/><img src="https://poll.diaria.workers.dev/img/x.jpg"/>`;
    const images = {
      cover: {
        url: "https://poll.diaria.workers.dev/img/x.jpg",
        filename: "04-d1-2x1.jpg",
        mime_type: "image/jpeg",
      },
    };
    const result = embedImagesAsDataUri(html, images, dir);
    assert.equal(result.embedded.length, 1);
    const matches = result.html.match(/data:image\/jpeg;base64,/g) ?? [];
    assert.equal(matches.length, 2);
  });

  it("infere mime type pela extensão quando mime_type não é declarado", () => {
    const pngPath = join(dir, "logo.png");
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const html = `<img src="https://poll.diaria.workers.dev/img/logo.png"/>`;
    const images = {
      logo: {
        url: "https://poll.diaria.workers.dev/img/logo.png",
        filename: "logo.png",
      },
    };
    const result = embedImagesAsDataUri(html, images, dir);
    assert.equal(result.embedded.length, 1);
    assert.ok(result.html.includes("data:image/png;base64,"));
  });
});
