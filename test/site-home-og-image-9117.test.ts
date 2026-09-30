/**
 * #9117 — a home diar.ia.br emite og:image/twitter:image (antes: cartão sem
 * imagem em todo compartilhamento no LinkedIn/WhatsApp/X).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_OG_IMAGE_URL } from "../scripts/lib/site-home-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homeHtml = readFileSync(resolve(ROOT, "workers/site/public/index.html"), "utf8");

describe("home og:image (#9117)", () => {
  it("URL é absoluta https no apex (unfurlers não resolvem relativo)", () => {
    assert.match(HOME_OG_IMAGE_URL, /^https:\/\/diar\.ia\.br\/[^/]+\.png$/);
  });

  it("index.html emite og:image, dimensões, twitter:image e card grande", () => {
    assert.ok(homeHtml.includes(`<meta property="og:image" content="${HOME_OG_IMAGE_URL}">`));
    assert.ok(homeHtml.includes(`<meta name="twitter:image" content="${HOME_OG_IMAGE_URL}">`));
    assert.ok(homeHtml.includes('<meta property="og:image:width" content="1200">'));
    assert.ok(homeHtml.includes('<meta property="og:image:height" content="630">'));
    assert.ok(homeHtml.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(!homeHtml.includes('<meta name="twitter:card" content="summary">'));
  });

  it("o PNG referenciado existe no Worker e é o mesmo asset do DS (sem drift)", () => {
    const name = HOME_OG_IMAGE_URL.split("/").pop()!;
    const served = readFileSync(resolve(ROOT, "workers/site/public", name));
    const source = readFileSync(resolve(ROOT, "assets/default-thumbnail-1200x630.png"));
    assert.ok(served.equals(source), "workers/site/public/og-default.png difere de assets/default-thumbnail-1200x630.png — copie de novo");
  });
});
