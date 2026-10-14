import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { previewOutputPaths, writePreviewOutputs } from "../scripts/monthly-preview-cloudflare.ts";

/**
 * #10175: `monthly-preview-cloudflare.ts --dry-run` gravava em
 * `_internal/cloudflare-preview.html` — o HTML REAL que o clarice-novos envia
 * às 09:00/18:00 — trocando-o por uma versão sem imagens (dry-run não sobe
 * imagem). O mesmo valia pra `public-images.json`, lido pelos renderers dos
 * apoiadores. Só diretório temporário aqui: nada toca `data/`.
 */

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("monthly-preview-cloudflare --dry-run não sobrescreve o HTML de envio (#10175)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mpc-10175-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("previewOutputPaths: dry-run usa sufixo .dry-run; produção usa os nomes reais", () => {
    const prod = previewOutputPaths(dir, false);
    const dry = previewOutputPaths(dir, true);
    assert.equal(prod.htmlPath, resolve(dir, "cloudflare-preview.html"));
    assert.equal(prod.publicImagesPath, resolve(dir, "public-images.json"));
    assert.equal(dry.htmlPath, resolve(dir, "cloudflare-preview.dry-run.html"));
    assert.equal(dry.publicImagesPath, resolve(dir, "public-images.dry-run.json"));
  });

  it("dry-run mantém o sha256 de cloudflare-preview.html e public-images.json", () => {
    const internal = join(dir, "_internal");
    // Estado de produção: HTML com imagens + manifest com URLs.
    writePreviewOutputs(
      internal,
      '<html><img src="https://poll.diaria.workers.dev/img/x-d1.jpg"></html>',
      { d1: { url: "https://poll.diaria.workers.dev/img/x-d1.jpg", filename: "04-d1-2x1.jpg", mime_type: "image/jpeg" } },
      false,
    );
    const realHtml = join(internal, "cloudflare-preview.html");
    const realManifest = join(internal, "public-images.json");
    const before = { html: sha(realHtml), manifest: sha(realManifest) };

    const out = writePreviewOutputs(internal, "<html>sem imagens</html>", {}, true);

    assert.equal(sha(realHtml), before.html, "dry-run alterou o HTML real de envio");
    assert.equal(sha(realManifest), before.manifest, "dry-run alterou public-images.json");
    assert.equal(out.htmlPath, join(internal, "cloudflare-preview.dry-run.html"));
    assert.equal(readFileSync(out.htmlPath, "utf8"), "<html>sem imagens</html>");
    assert.deepEqual(JSON.parse(readFileSync(out.publicImagesPath, "utf8")), { images: {} });
  });

  it("dry-run sem HTML real prévio não cria o arquivo de produção", () => {
    const internal = join(dir, "fresh", "_internal");
    writePreviewOutputs(internal, "<html/>", {}, true);
    assert.equal(existsSync(join(internal, "cloudflare-preview.html")), false);
    assert.equal(existsSync(join(internal, "public-images.json")), false);
  });

  it("main() grava só via writePreviewOutputs (sem writeFileSync direto nos caminhos reais)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../scripts/monthly-preview-cloudflare.ts"), "utf8");
    const mainBody = src.slice(src.indexOf("async function main()"));
    assert.match(mainBody, /writePreviewOutputs\(internalDir, html, publicImages, dryRun\)/);
    assert.doesNotMatch(mainBody, /writeFileSync\(/);
  });
});
