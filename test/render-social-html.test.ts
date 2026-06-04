/**
 * render-social-html.test.ts (#1800)
 *
 * Regressão: sem --images (ou path inválido), o preview saía SEM imagens
 * silenciosamente e o editor revisava o gate achando que o social estava sem
 * imagem (260604). Agora loadImageMap nunca falha em silêncio e há check de
 * contagem de <img> vs posts de destaque.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadImageMap,
  parsePlatforms,
  buildSocialHtml,
  expectedImageCount,
  countImgTags,
  isPostPixel,
} from "../scripts/render-social-html.ts";

const MD = `# LinkedIn

## DESTAQUE 1

Post do destaque 1.

#IA #Tecnologia

## DESTAQUE 2

Post do destaque 2.

## DESTAQUE 3

Post do destaque 3.

# Facebook

## DESTAQUE 1

Post fb 1.

## DESTAQUE 2

Post fb 2.

## DESTAQUE 3

Post fb 3.
`;

const IMAGES = {
  images: {
    d1: { url: "https://img.example/d1.jpg" },
    d2: { url: "https://img.example/d2.jpg" },
    d3: { url: "https://img.example/d3.jpg" },
  },
};

describe("loadImageMap — nunca falha em silêncio (#1800)", () => {
  it("--images ausente (null) → warning explícito + mapa vazio", () => {
    const { map, warnings } = loadImageMap(null);
    assert.deepEqual(map, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /--images ausente/);
  });

  it("path inexistente → warning, não catch silencioso", () => {
    const { map, warnings } = loadImageMap("/nao/existe/06-public-images.json");
    assert.deepEqual(map, {});
    assert.match(warnings[0], /não existe/);
  });

  it("JSON inválido → warning loud", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-"));
    try {
      const p = join(dir, "bad.json");
      writeFileSync(p, "{ não é json");
      const { map, warnings } = loadImageMap(p);
      assert.deepEqual(map, {});
      assert.match(warnings[0], /inválido|não-JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mapa vazio {} → warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-"));
    try {
      const p = join(dir, "empty.json");
      writeFileSync(p, JSON.stringify({ images: {} }));
      const { warnings } = loadImageMap(p);
      assert.match(warnings[0], /vazio/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mapa válido → sem warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-"));
    try {
      const p = join(dir, "ok.json");
      writeFileSync(p, JSON.stringify(IMAGES));
      const { map, warnings } = loadImageMap(p);
      assert.deepEqual(warnings, []);
      assert.ok(map.d1?.url);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("render-social-html — check de contagem de imagens (#1800)", () => {
  const platforms = parsePlatforms(MD);

  it("expectedImageCount conta posts de destaque nas 2 plataformas", () => {
    // 3 destaques × 2 plataformas = 6 posts esperando imagem
    assert.equal(expectedImageCount(platforms), 6);
  });

  it("COM imagens: <img> == esperado (preview completo)", () => {
    const html = buildSocialHtml(platforms, IMAGES.images);
    assert.equal(countImgTags(html), expectedImageCount(platforms));
  });

  it("SEM imagens: 0 <img> < esperado → detectável (era o bug silencioso)", () => {
    const { map, warnings } = loadImageMap(null); // --images ausente
    const html = buildSocialHtml(platforms, map);
    const actual = countImgTags(html);
    assert.equal(actual, 0);
    assert.ok(actual < expectedImageCount(platforms), "menos imgs que posts → mismatch");
    assert.ok(warnings.length > 0, "e o warning de --images ausente está presente");
  });
});

describe("post_pixel — post standalone de D1 no perfil pessoal (#1690)", () => {
  const IMAGES = { images: { d1: { url: "https://img.example/d1.jpg" } } };
  const MD_PIXEL = `# LinkedIn

## d1

Post da página D1.

## post_pixel

Opinião pessoal do Pixel sobre o D1, em primeira pessoa.

#IA
`;

  it("isPostPixel reconhece a seção", () => {
    assert.ok(isPostPixel("post_pixel"));
    assert.ok(isPostPixel("POST_PIXEL"));
    assert.ok(isPostPixel("post-pixel"));
    assert.ok(!isPostPixel("d1"));
    assert.ok(!isPostPixel("comment_pixel"));
  });

  it("render mostra o label 'POST PESSOAL — vjpixel' e reusa a imagem do D1", () => {
    const platforms = parsePlatforms(MD_PIXEL);
    const html = buildSocialHtml(platforms, IMAGES.images);
    assert.match(html, /POST PESSOAL — vjpixel \(D1\)/, "label do post pessoal");
    // post_pixel reusa a imagem do d1 → o src do d1 aparece 2× (d1 + post_pixel)
    assert.ok((html.match(/img\.example\/d1\.jpg/g) ?? []).length >= 2, "post_pixel reusa imagem do d1");
  });

  it("expectedImageCount conta o post_pixel (espera imagem)", () => {
    const platforms = parsePlatforms(MD_PIXEL);
    // d1 + post_pixel = 2 posts esperando imagem
    assert.equal(expectedImageCount(platforms), 2);
  });
});
