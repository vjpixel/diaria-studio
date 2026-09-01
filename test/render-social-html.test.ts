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
  groupByDestaque,
  channelsForSection,
  renderDestaqueGroup,
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

  it("expectedImageCount conta DESTAQUES distintos, não posts (preview agrupado)", () => {
    // 260727: o preview passou a agrupar por destaque — cada imagem aparece 1×,
    // com os textos de cada rede embaixo. 3 destaques × 2 seções = 6 posts, mas
    // só 3 imagens. Contar por post inflava o esperado e disparava falso
    // "imagem faltando" num preview completo.
    assert.equal(expectedImageCount(platforms), 3);
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

describe("render-social-html — largura limitada do preview (#3371)", () => {
  const platforms = parsePlatforms(MD);

  it("body tem um .container com max-width — não estica full-bleed", () => {
    const html = buildSocialHtml(platforms, IMAGES.images);
    assert.match(html, /\.container\s*\{[^}]*max-width:\s*\d+px/, "CSS define max-width no container");
    assert.match(html, /<div class="container">/, "marcação usa a classe container");
  });

  it("todo o conteúdo (h1 + plataformas) fica DENTRO do .container", () => {
    const html = buildSocialHtml(platforms, IMAGES.images);
    const openIdx = html.indexOf('<div class="container">');
    const h1Idx = html.indexOf("<h1>");
    const lastPlatformCloseIdx = html.lastIndexOf('<div class="platform">');
    assert.ok(openIdx >= 0 && openIdx < h1Idx, "container abre antes do <h1>");
    assert.ok(lastPlatformCloseIdx > openIdx, "plataformas ficam depois da abertura do container");
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
    assert.match(html, /POST PESSOAL — vjpixel \(imagem do D1\)/, "label do post pessoal");
    // post_pixel reusa a imagem do d1 → o src do d1 aparece 2× (d1 + post_pixel)
    assert.ok((html.match(/img\.example\/d1\.jpg/g) ?? []).length >= 2, "post_pixel reusa imagem do d1");
  });

  it("expectedImageCount conta o post_pixel (espera imagem)", () => {
    const platforms = parsePlatforms(MD_PIXEL);
    // d1 + post_pixel = 2 posts esperando imagem
    assert.equal(expectedImageCount(platforms), 2);
  });

  it("#2549: override postPixelImageNum=2 → post_pixel usa imagem do D2 + label (D2)", () => {
    const images = {
      d1: { url: "https://img.example/d1.jpg" },
      d2: { url: "https://img.example/d2.jpg" },
    };
    const platforms = parsePlatforms(MD_PIXEL);
    const html = buildSocialHtml(platforms, images, "2");
    assert.match(html, /POST PESSOAL — vjpixel \(imagem do D2\)/, "label reflete o destaque do override");
    // post_pixel agora aponta pra imagem do d2 (não a do d1).
    assert.match(html, /img\.example\/d2\.jpg/, "post_pixel usa a imagem do d2");
  });

  it("#2549: default (sem override) preserva #1690 — post_pixel usa imagem do D1", () => {
    const images = {
      d1: { url: "https://img.example/d1.jpg" },
      d2: { url: "https://img.example/d2.jpg" },
    };
    const platforms = parsePlatforms(MD_PIXEL);
    const html = buildSocialHtml(platforms, images); // sem 3º arg → "1"
    assert.match(html, /POST PESSOAL — vjpixel \(imagem do D1\)/, "default continua D1");
    assert.ok((html.match(/img\.example\/d1\.jpg/g) ?? []).length >= 2, "post_pixel reusa imagem do d1 por default");
  });
});

describe("channelsForSection — fonte única de verdade compartilhada (#4091)", () => {
  it("'# Social' (texto único, #3991) → LinkedIn · Facebook · Instagram", () => {
    assert.equal(channelsForSection("Social"), "💼 LinkedIn · 📘 Facebook · 📷 Instagram");
  });

  it("'# Curto' (#3992) → X (Twitter) · Threads", () => {
    assert.equal(channelsForSection("Curto"), "𝕏 X (Twitter) · Threads");
  });

  it("nomes legados de canal único (pré-#3991) continuam resolvendo 1 canal", () => {
    assert.equal(channelsForSection("LinkedIn"), "💼 LinkedIn");
    assert.equal(channelsForSection("Facebook"), "📘 Facebook");
    assert.equal(channelsForSection("Instagram"), "📷 Instagram");
  });

  it("seção não reconhecida FALHA ALTO em vez de cair num fallback silencioso", () => {
    assert.throws(
      () => channelsForSection("Bluesky"),
      /seção social não reconhecida.*Bluesky/,
      "canal novo sem entry em KNOWN_SOCIAL_CHANNELS deve lançar, não devolver o nome cru da seção",
    );
  });
});

describe("groupByDestaque — reagrupamento por destaque (#4091)", () => {
  const IMAGES = {
    d1: { url: "https://img.example/d1.jpg" },
    d2: { url: "https://img.example/d2.jpg" },
    d3: { url: "https://img.example/d3.jpg" },
    eia_a: { url: "https://img.example/eia-a.jpg" },
    eia_b: { url: "https://img.example/eia-b.jpg" },
  };

  it("2 seções (texto único + curto, #3991/#3992) agrupam no MESMO destaque, cada uma com seu bloco", () => {
    const MD_2SEC = `# Social

## d1

Texto único do d1.

## d2

Texto único do d2.

# Curto

## d1

Texto curto do d1.

## d2

Texto curto do d2.
`;
    const platforms = parsePlatforms(MD_2SEC);
    const groups = groupByDestaque(platforms, IMAGES);
    assert.equal(groups.length, 2, "2 destaques, não 4 — cada imagem aparece 1×");
    const d1 = groups.find((g) => g.key === "d1")!;
    assert.equal(d1.blocks.length, 2, "d1 recebe os 2 blocos (texto único + curto)");
    assert.equal(d1.blocks[0].channels, "💼 LinkedIn · 📘 Facebook · 📷 Instagram");
    assert.equal(d1.blocks[1].channels, "𝕏 X (Twitter) · Threads");
  });

  it("ordem: destaques numerados (d1→d3) → É IA? → post_pixel, mesmo com MD fora de ordem", () => {
    // Seção deliberadamente escrita fora de ordem (post_pixel antes, eia no
    // meio, d3 antes de d1) — a ordem de EXIBIÇÃO não pode depender da ordem
    // de escrita no markdown.
    const MD_SCRAMBLED = `# Social

## post_pixel

Post pessoal.

## eia

Texto do É IA?

## d3

Texto do d3.

## d1

Texto do d1.

## d2

Texto do d2.
`;
    const platforms = parsePlatforms(MD_SCRAMBLED);
    const groups = groupByDestaque(platforms, IMAGES);
    assert.deepEqual(
      groups.map((g) => g.key),
      ["d1", "d2", "d3", "eia", "post_pixel"],
      "ordem final deve ser d1→d3, depois É IA?, depois post_pixel — independente da ordem no MD",
    );
  });

  it("É IA? monta o par de imagens A/B (opção A e opção B), não uma imagem só", () => {
    const MD_EIA = `# Social

## eia

Texto do É IA? de hoje.
`;
    const platforms = parsePlatforms(MD_EIA);
    const groups = groupByDestaque(platforms, IMAGES);
    const eia = groups.find((g) => g.key === "eia")!;
    assert.equal(eia.label, "É IA?");
    assert.equal(eia.imageUrl, "", "É IA? não usa a imagem `imageUrl` de destaque numerado");
    assert.equal(eia.extraImages?.length, 2, "deve ter exatamente o par A/B");
    assert.equal(eia.extraImages?.[0].label, "Opção A");
    assert.equal(eia.extraImages?.[0].url, "https://img.example/eia-a.jpg");
    assert.equal(eia.extraImages?.[1].label, "Opção B");
    assert.equal(eia.extraImages?.[1].url, "https://img.example/eia-b.jpg");
  });

  it("formato legado pré-#3991 (3 seções, uma por rede) agrupa por destaque igual ao formato novo", () => {
    const MD_LEGACY = `# LinkedIn

## d1

Post LinkedIn do d1.

## d2

Post LinkedIn do d2.

# Facebook

## d1

Post Facebook do d1.

## d2

Post Facebook do d2.

# Instagram

## d1

Post Instagram do d1.

## d2

Post Instagram do d2.
`;
    const platforms = parsePlatforms(MD_LEGACY);
    assert.equal(platforms.length, 3, "3 seções de rede no formato legado");
    const groups = groupByDestaque(platforms, IMAGES);
    assert.equal(groups.length, 2, "agrupado por destaque (d1, d2), não por rede");
    const d1 = groups.find((g) => g.key === "d1")!;
    assert.equal(d1.blocks.length, 3, "d1 recebe 1 bloco por rede legada (LinkedIn/Facebook/Instagram)");
    assert.deepEqual(
      d1.blocks.map((b) => b.channels),
      ["💼 LinkedIn", "📘 Facebook", "📷 Instagram"],
      "cada bloco legado rotulado com o canal único correspondente",
    );
  });
});

describe("carrossel diário do Instagram — galeria de rolagem (#6005 Parte B / #6064)", () => {
  const MD_D1 = `# Social

## d1

Texto único do d1.
`;

  const IMAGES_FULL = {
    d1_4x5: { url: "https://img.example/d1-4x5.jpg" },
    d1_carousel_p1: { url: "https://img.example/d1-p1.jpg" },
    d1_carousel_p2: { url: "https://img.example/d1-p2.jpg" },
    d1_carousel_p3: { url: "https://img.example/d1-p3.jpg" },
    d1_carousel_cta: { url: "https://img.example/d1-cta.jpg" },
  };

  it("todos os 5 slides presentes → carouselImages populado com capa + p1 + p2 + p3 + cta, nesta ordem", () => {
    const groups = groupByDestaque(parsePlatforms(MD_D1), IMAGES_FULL);
    const d1 = groups.find((g) => g.key === "d1")!;
    assert.ok(d1.carouselImages, "carouselImages deve existir quando os 5 slides estão presentes");
    assert.deepEqual(
      d1.carouselImages!.map((s) => s.url),
      [
        "https://img.example/d1-4x5.jpg",
        "https://img.example/d1-p1.jpg",
        "https://img.example/d1-p2.jpg",
        "https://img.example/d1-p3.jpg",
        "https://img.example/d1-cta.jpg",
      ],
      "ordem fixa: capa (d1_4x5) → p1 → p2 → p3 → cta",
    );
  });

  it("qualquer slide ausente → carouselImages undefined (tudo-ou-nada, mesma regra de resolveCarouselImageUrls)", () => {
    const { d1_carousel_cta, ...IMAGES_MISSING_CTA } = IMAGES_FULL;
    const groups = groupByDestaque(parsePlatforms(MD_D1), IMAGES_MISSING_CTA);
    const d1 = groups.find((g) => g.key === "d1")!;
    assert.equal(d1.carouselImages, undefined, "sem os 5 slides, cai pro fallback de imagem única");
    assert.ok(d1.imageUrl, "imageUrl (capa) continua disponível pro fallback");
  });

  it("É IA?/post_pixel nunca recebem carouselImages, mesmo com as chaves d1_carousel_* presentes", () => {
    const MD_EIA_PIXEL = `# Social

## eia

Texto do É IA?

## post_pixel

Post pessoal.
`;
    const groups = groupByDestaque(parsePlatforms(MD_EIA_PIXEL), {
      ...IMAGES_FULL,
      eia_a: { url: "https://img.example/eia-a.jpg" },
      eia_b: { url: "https://img.example/eia-b.jpg" },
    });
    for (const g of groups) {
      assert.equal(g.carouselImages, undefined, `${g.key} não é destaque numerado — sem carrossel`);
    }
  });

  it("renderDestaqueGroup: com carrossel completo, renderiza a galeria de rolagem no lugar da imagem única", () => {
    const groups = groupByDestaque(parsePlatforms(MD_D1), IMAGES_FULL);
    const html = renderDestaqueGroup(groups[0], "#000");
    assert.ok(html.includes("carousel-gallery-scroll"), "galeria de rolagem presente");
    assert.equal(countImgTags(html), 5, "5 slides renderizados, 1 <img> cada");
    assert.ok(!html.includes(`<div class="post-image"><img`), "não cai no slot de imagem única quando o carrossel existe");
  });

  it("renderDestaqueGroup: sem carrossel completo, mantém o comportamento de imagem única (fallback)", () => {
    const { d1_carousel_cta, ...IMAGES_MISSING_CTA } = IMAGES_FULL;
    const groups = groupByDestaque(parsePlatforms(MD_D1), IMAGES_MISSING_CTA);
    const html = renderDestaqueGroup(groups[0], "#000");
    assert.ok(!html.includes("carousel-gallery-scroll"), "sem galeria quando o carrossel está incompleto");
    assert.equal(countImgTags(html), 1, "1 <img> só — a capa, como single-image de sempre");
  });
});

describe("renderDestaqueGroup — negrito ** vira <strong> no preview (#6871, achado 260901)", () => {
  const IMAGES = { d1: { url: "https://img.example/d1.jpg" } };

  it("** no corpo do post vira <strong>, nunca sobrevive como asterisco literal", () => {
    const MD = `# Social

## d1

Frase normal. **Trecho em negrito no slide do carrossel.** Mais texto.

#IA
`;
    const groups = groupByDestaque(parsePlatforms(MD), IMAGES);
    const html = renderDestaqueGroup(groups[0], "#000");
    assert.ok(html.includes("<strong>Trecho em negrito no slide do carrossel.</strong>"));
    assert.ok(!html.includes("**"), "preview não deve mostrar asterisco literal — o texto REAL publicado também não tem (stripMarkdownBold)");
  });
});
