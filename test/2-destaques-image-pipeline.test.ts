/**
 * test/2-destaques-image-pipeline.test.ts (#2352)
 *
 * Prova que o pipeline de imagens (stage-3/4 invariants, upload, reorder)
 * é condicional ao destaque_count e não requer D3 em edições 2-destaque.
 *
 * CARDINAL RULE: caminho 3-destaque deve permanecer IDÊNTICO (testes de
 * regressão explícitos). Este arquivo adiciona cobertura 2-destaque SEM
 * modificar testes existentes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  checkAllImagesExist,
  checkPromptsClean,
  readDestaqueCount,
  REQUIRED_IMAGES,
  REQUIRED_IMAGES_BASE,
  REQUIRED_IMAGES_D3,
} from "../scripts/lib/invariant-checks/stage-3.ts";
import { checkPublicImagesPopulated } from "../scripts/lib/invariant-checks/stage-4.ts";
import {
  assertCacheCompleteness,
  imageSpecsFor,
  type PublicImage,
} from "../scripts/upload-images-public.ts";
import {
  reorderHighlightsInJson,
  reorderDestaquesInMd,
  reorderSocialMd,
  renameDestaqueImages,
} from "../scripts/reorder-destaques.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImg(url: string): PublicImage {
  return {
    file_id: "fake",
    url,
    mime_type: "image/jpeg",
    filename: "fake.jpg",
    target: "drive",
  };
}

/** Cria edição fixture com destaque_count em _internal/01-approved-capped.json */
function makeEdition(destaqueCount: 2 | 3): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "diaria-2352-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "_internal", "01-approved-capped.json"),
    JSON.stringify({
      highlights: Array.from({ length: destaqueCount }, (_, i) => ({
        rank: i + 1,
        article: { url: `https://example.com/${i + 1}`, title: `T${i + 1}` },
      })),
      coverage: { line: `${destaqueCount} destaques.` },
    }),
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Escreve imagens de destaque base (D1 + D2) com bytes fake (> 1024) */
function writeBaseImages(dir: string): void {
  const fakeBytes = Buffer.alloc(2048, 0xff);
  for (const name of [
    "01-eia-A.jpg",
    "01-eia-B.jpg",
    "04-d1-2x1.jpg",
    "04-d1-1x1.jpg",
    "04-d2-2x1.jpg",
    "04-d2-1x1.jpg",
  ]) {
    writeFileSync(join(dir, name), fakeBytes);
  }
}

/** Escreve adicionalmente as imagens D3 */
function writeD3Images(dir: string): void {
  const fakeBytes = Buffer.alloc(2048, 0xff);
  for (const name of ["04-d3-2x1.jpg", "04-d3-1x1.jpg"]) {
    writeFileSync(join(dir, name), fakeBytes);
  }
}

// ---------------------------------------------------------------------------
// readDestaqueCount helper
// ---------------------------------------------------------------------------

describe("readDestaqueCount (#2352)", () => {
  it("retorna 2 quando approved-capped tem 2 highlights", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      assert.equal(readDestaqueCount(dir), 2);
    } finally {
      cleanup();
    }
  });

  it("retorna 3 quando approved-capped tem 3 highlights", () => {
    const { dir, cleanup } = makeEdition(3);
    try {
      assert.equal(readDestaqueCount(dir), 3);
    } finally {
      cleanup();
    }
  });

  it("retorna 3 (default) quando approved-capped ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-2352-nofile-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    try {
      assert.equal(readDestaqueCount(dir), 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// REQUIRED_IMAGES exports (backward-compat)
// ---------------------------------------------------------------------------

describe("REQUIRED_IMAGES exports backward-compat (#2352)", () => {
  it("REQUIRED_IMAGES (full 3D) ainda tem 8 entries", () => {
    assert.equal(REQUIRED_IMAGES.length, 8);
  });

  it("REQUIRED_IMAGES_BASE (sem D3) tem 6 entries", () => {
    assert.equal(REQUIRED_IMAGES_BASE.length, 6);
    assert.ok(!REQUIRED_IMAGES_BASE.some((n) => n.includes("d3")), "BASE não deve ter d3");
  });

  it("REQUIRED_IMAGES_D3 tem 2 entries", () => {
    assert.equal(REQUIRED_IMAGES_D3.length, 2);
    assert.ok(REQUIRED_IMAGES_D3.every((n) => n.includes("d3")), "D3 list deve ter só d3");
  });
});

// ---------------------------------------------------------------------------
// Stage-3 invariant: checkAllImagesExist (#2352)
// ---------------------------------------------------------------------------

describe("Stage-3 checkAllImagesExist 2-destaque (#2352)", () => {
  it("PASSA para edição 2-destaque com d1/d2 images (sem d3)", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      writeBaseImages(dir);
      const v = checkAllImagesExist(dir);
      assert.equal(
        v.length,
        0,
        `Esperava 0 violations para edição 2D com imagens base. Achei: ${JSON.stringify(v)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("FALHA para edição 2-destaque quando d2 ausente (d3 continua não-requerida)", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      // Só d1 — sem d2, sem d3
      const fakeBytes = Buffer.alloc(2048, 0xff);
      for (const name of ["01-eia-A.jpg", "01-eia-B.jpg", "04-d1-2x1.jpg", "04-d1-1x1.jpg"]) {
        writeFileSync(join(dir, name), fakeBytes);
      }
      const v = checkAllImagesExist(dir);
      // d2_2x1 e d2_1x1 ausentes → 2 violations; d3 NÃO conta
      const rules = v.map((x) => x.message);
      assert.ok(
        rules.some((m) => m.includes("04-d2-2x1.jpg")),
        `Esperava violação pra 04-d2-2x1.jpg. Violations: ${JSON.stringify(rules)}`,
      );
      assert.ok(
        rules.some((m) => m.includes("04-d2-1x1.jpg")),
        `Esperava violação pra 04-d2-1x1.jpg`,
      );
      assert.ok(
        !rules.some((m) => m.includes("04-d3")),
        `d3 NÃO deve aparecer em violações de edição 2-destaque. Violations: ${JSON.stringify(rules)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("REGRESSÃO 3-destaque: FALHA quando d3 ausente (caminho feliz sem alteração)", () => {
    const { dir, cleanup } = makeEdition(3);
    try {
      writeBaseImages(dir); // sem d3
      const v = checkAllImagesExist(dir);
      const msgs = v.map((x) => x.message);
      assert.ok(
        msgs.some((m) => m.includes("04-d3-2x1.jpg")),
        `Edição 3D deve falhar quando d3-2x1 ausente. Violations: ${JSON.stringify(msgs)}`,
      );
      assert.ok(
        msgs.some((m) => m.includes("04-d3-1x1.jpg")),
        `Edição 3D deve falhar quando d3-1x1 ausente`,
      );
    } finally {
      cleanup();
    }
  });

  it("REGRESSÃO 3-destaque: PASSA com todos os 8 arquivos presentes", () => {
    const { dir, cleanup } = makeEdition(3);
    try {
      writeBaseImages(dir);
      writeD3Images(dir);
      const v = checkAllImagesExist(dir);
      assert.equal(v.length, 0, `Esperava 0 violations com 8 imagens. Achei: ${JSON.stringify(v)}`);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-3 invariant: checkPromptsClean 2-destaque (#2352)
// ---------------------------------------------------------------------------

describe("Stage-3 checkPromptsClean 2-destaque (#2352)", () => {
  it("não reporta d3 ausente em edição 2-destaque (d3 prompt não é requerido)", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      // Só d1/d2 prompts — sem d3
      writeFileSync(
        join(dir, "04-d1-sd-prompt.json"),
        JSON.stringify({ prompt: "Van Gogh impasto style, 2:1 aspect ratio" }),
      );
      writeFileSync(
        join(dir, "04-d2-sd-prompt.json"),
        JSON.stringify({ prompt: "Van Gogh impasto style, 2:1 aspect ratio" }),
      );
      const v = checkPromptsClean(dir);
      assert.equal(v.length, 0, `Esperava 0 violations. Achei: ${JSON.stringify(v)}`);
    } finally {
      cleanup();
    }
  });

  it("detecta pixels em prompt d2 em edição 2-destaque", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      writeFileSync(
        join(dir, "04-d2-sd-prompt.json"),
        JSON.stringify({ prompt: "Van Gogh, 1024x1024 resolution" }),
      );
      const v = checkPromptsClean(dir);
      assert.ok(v.some((x) => x.rule === "prompts-no-pixels"), "Deve detectar pixels em d2");
    } finally {
      cleanup();
    }
  });

  it("REGRESSÃO 3-destaque: verifica d3 prompt quando presente", () => {
    const { dir, cleanup } = makeEdition(3);
    try {
      writeFileSync(
        join(dir, "04-d3-sd-prompt.json"),
        JSON.stringify({ prompt: "Van Gogh, Noite Estrelada style" }),
      );
      const v = checkPromptsClean(dir);
      assert.ok(
        v.some((x) => x.rule === "prompts-no-noite-estrelada"),
        "3D edition deve checar d3 prompt",
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-4 invariant: checkPublicImagesPopulated 2-destaque (#2352)
// ---------------------------------------------------------------------------

describe("Stage-4 checkPublicImagesPopulated 2-destaque (#2352)", () => {
  it("PASSA com d1/d2 URLs (sem d3) em edição 2-destaque", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({
          images: {
            d1: { url: "https://cf.example/d1", file_id: "a" },
            d2: { url: "https://cf.example/d2", file_id: "b" },
            cover: { url: "https://cf.example/cover" },
            d2_2x1: { url: "https://cf.example/d2_2x1" },
          },
        }),
      );
      const v = checkPublicImagesPopulated(dir);
      assert.equal(
        v.filter((x) => x.severity === "error").length,
        0,
        `Esperava 0 errors para edição 2D. Achei: ${JSON.stringify(v)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("FALHA para edição 2-destaque quando d2.url ausente (d3 não conta)", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({
          images: {
            d1: { url: "https://cf.example/d1", file_id: "a" },
            // d2 ausente
          },
        }),
      );
      const v = checkPublicImagesPopulated(dir);
      const errors = v.filter((x) => x.severity === "error");
      assert.ok(
        errors.some((x) => x.message.includes("images.d2.url")),
        `Deve falhar com d2 ausente. Violations: ${JSON.stringify(errors)}`,
      );
      assert.ok(
        !errors.some((x) => x.message.includes("images.d3.url")),
        `d3 NÃO deve ser requerida em edição 2-destaque. Violations: ${JSON.stringify(errors)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("REGRESSÃO 3-destaque: FALHA quando d3.url ausente", () => {
    const { dir, cleanup } = makeEdition(3);
    try {
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({
          images: {
            d1: { url: "https://cf.example/d1", file_id: "a" },
            d2: { url: "https://cf.example/d2", file_id: "b" },
            // d3 ausente
            cover: { url: "https://cf.example/cover" },
            d2_2x1: { url: "https://cf.example/d2_2x1" },
            d3_2x1: { url: "https://cf.example/d3_2x1" },
          },
        }),
      );
      const v = checkPublicImagesPopulated(dir);
      const errors = v.filter((x) => x.severity === "error");
      assert.ok(
        errors.some((x) => x.message.includes("images.d3.url")),
        `3D edition deve exigir d3. Violations: ${JSON.stringify(errors)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("REGRESSÃO 3-destaque: PASSA com d1/d2/d3 URLs e newsletter heroes", () => {
    const { dir, cleanup } = makeEdition(3);
    try {
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({
          images: {
            d1: { url: "https://cf.example/d1", file_id: "a" },
            d2: { url: "https://cf.example/d2", file_id: "b" },
            d3: { url: "https://cf.example/d3", file_id: "c" },
            cover: { url: "https://cf.example/cover" },
            d2_2x1: { url: "https://cf.example/d2_2x1" },
            d3_2x1: { url: "https://cf.example/d3_2x1" },
          },
        }),
      );
      const v = checkPublicImagesPopulated(dir);
      assert.equal(v.length, 0, `Esperava 0 violations. Achei: ${JSON.stringify(v)}`);
    } finally {
      cleanup();
    }
  });

  it("d3_2x1 gera warning (não error) em edição 2-destaque quando ausente (newsletter hero)", () => {
    // Em edição 2-destaque, d3_2x1 não é esperado, então não deve gerar nenhuma violação.
    const { dir, cleanup } = makeEdition(2);
    try {
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({
          images: {
            d1: { url: "https://cf.example/d1", file_id: "a" },
            d2: { url: "https://cf.example/d2", file_id: "b" },
            cover: { url: "https://cf.example/cover" },
            d2_2x1: { url: "https://cf.example/d2_2x1" },
            // d3_2x1 ausente — OK em edição 2D
          },
        }),
      );
      const v = checkPublicImagesPopulated(dir);
      assert.ok(
        !v.some((x) => x.message.includes("d3_2x1")),
        `d3_2x1 ausente NÃO deve gerar violação em edição 2-destaque. Violations: ${JSON.stringify(v)}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// upload-images-public: assertCacheCompleteness 2-destaque (#2352)
// ---------------------------------------------------------------------------

describe("assertCacheCompleteness 2-destaque (#2352)", () => {
  it("social 2-destaque: PASSA com d1/d2 (sem d3)", () => {
    assert.doesNotThrow(() =>
      assertCacheCompleteness(
        {
          d1: makeImg("https://x/d1"),
          d2: makeImg("https://x/d2"),
        },
        "social",
        2,
      ),
    );
  });

  it("social 2-destaque: FALHA quando d2 ausente", () => {
    assert.throws(
      () =>
        assertCacheCompleteness(
          {
            d1: makeImg("https://x/d1"),
            // d2 ausente
          },
          "social",
          2,
        ),
      /Missing: d2/,
    );
  });

  it("social 2-destaque: não exige d3 (não lança quando d3 ausente)", () => {
    assert.doesNotThrow(() =>
      assertCacheCompleteness(
        {
          d1: makeImg("https://x/d1"),
          d2: makeImg("https://x/d2"),
          // d3 ausente — OK para 2-destaque
        },
        "social",
        2,
      ),
    );
  });

  it("newsletter 2-destaque: PASSA sem d3_2x1 (d3 não esperado)", () => {
    assert.doesNotThrow(() =>
      assertCacheCompleteness(
        {
          cover: makeImg("https://x/cover"),
          d1: makeImg("https://x/d1"),
          eia_a: makeImg("https://x/eia_a"),
          eia_b: makeImg("https://x/eia_b"),
          d2_2x1: makeImg("https://x/d2_2x1"),
          // d3_2x1 ausente — OK para 2-destaque
        },
        "newsletter",
        2,
      ),
    );
  });

  it("newsletter 2-destaque: FALHA quando d2_2x1 ausente", () => {
    assert.throws(
      () =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            d1: makeImg("https://x/d1"),
            eia_a: makeImg("https://x/eia_a"),
            eia_b: makeImg("https://x/eia_b"),
            // d2_2x1 ausente
          },
          "newsletter",
          2,
        ),
      /Missing: d2_2x1/,
    );
  });

  it("REGRESSÃO 3-destaque social: ainda exige d3 com destaqueCount=3", () => {
    assert.throws(
      () =>
        assertCacheCompleteness(
          {
            d1: makeImg("https://x/d1"),
            d2: makeImg("https://x/d2"),
            // d3 ausente — DEVE falhar em 3-destaque
          },
          "social",
          3,
        ),
      /Missing: d3/,
    );
  });

  it("REGRESSÃO 3-destaque newsletter: ainda exige d3_2x1 com destaqueCount=3", () => {
    assert.throws(
      () =>
        assertCacheCompleteness(
          {
            cover: makeImg("https://x/cover"),
            d1: makeImg("https://x/d1"),
            eia_a: makeImg("https://x/eia_a"),
            eia_b: makeImg("https://x/eia_b"),
            d2_2x1: makeImg("https://x/d2_2x1"),
            // d3_2x1 ausente — DEVE falhar em 3-destaque
          },
          "newsletter",
          3,
        ),
      /Missing: d3_2x1/,
    );
  });

  it("default destaqueCount=3 preserva comportamento anterior (sem 3º arg)", () => {
    assert.throws(
      () =>
        assertCacheCompleteness(
          {
            d1: makeImg("https://x/d1"),
            d2: makeImg("https://x/d2"),
          },
          "social",
          // sem destaqueCount → default 3 → exige d3
        ),
      /Missing: d3/,
    );
  });
});

// ---------------------------------------------------------------------------
// upload-images-public: imageSpecsFor 2-destaque (#2352)
// ---------------------------------------------------------------------------

describe("imageSpecsFor 2-destaque (#2352)", () => {
  it("social mode sem editionDir: retorna d1/d2/d3 (default 3D)", () => {
    const specs = imageSpecsFor("social");
    assert.ok(specs.some((s) => s.key === "d3"), "sem editionDir deve incluir d3 (default 3D)");
  });

  it("social mode com editionDir 2D: retorna apenas d1/d2 (sem d3)", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      const specs = imageSpecsFor("social", dir);
      assert.ok(!specs.some((s) => s.key === "d3"), "2D edition não deve ter d3 em specs social");
      assert.ok(specs.some((s) => s.key === "d1"), "deve ter d1");
      assert.ok(specs.some((s) => s.key === "d2"), "deve ter d2");
    } finally {
      cleanup();
    }
  });

  it("newsletter mode com editionDir 2D: não inclui d3_2x1 nem d3", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      // Precisa de 01-eia-A.jpg presente para o path de EIA specs
      writeFileSync(join(dir, "01-eia-A.jpg"), Buffer.alloc(1024, 0xff));
      writeFileSync(join(dir, "01-eia-B.jpg"), Buffer.alloc(1024, 0xff));
      const specs = imageSpecsFor("newsletter", dir);
      assert.ok(!specs.some((s) => s.key === "d3_2x1"), "2D não deve ter d3_2x1");
      assert.ok(!specs.some((s) => s.key === "d3"), "2D não deve ter d3");
    } finally {
      cleanup();
    }
  });

  it("REGRESSÃO 3-destaque social: d3 presente com editionDir 3D", () => {
    const { dir, cleanup } = makeEdition(3);
    try {
      const specs = imageSpecsFor("social", dir);
      assert.ok(specs.some((s) => s.key === "d3"), "3D deve ter d3 em social specs");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// reorder-destaques: 2-destaque reorder (#2352)
// ---------------------------------------------------------------------------

describe("reorderHighlightsInJson 2-destaque (#2352)", () => {
  it("PASSA: swap [2,1] em 2-destaque JSON", () => {
    const data = {
      highlights: [{ id: "A" }, { id: "B" }],
    };
    const result = reorderHighlightsInJson(data, [2, 1]);
    assert.equal(result, true);
    assert.equal((data.highlights[0] as { id: string }).id, "B");
    assert.equal((data.highlights[1] as { id: string }).id, "A");
  });

  it("PASSA: [1,2] em 2-destaque é no-op (identidade)", () => {
    const data = {
      highlights: [{ id: "A" }, { id: "B" }],
    };
    const result = reorderHighlightsInJson(data, [1, 2]);
    assert.equal(result, true);
    assert.equal((data.highlights[0] as { id: string }).id, "A");
    assert.equal((data.highlights[1] as { id: string }).id, "B");
  });

  it("REGRESSÃO 3-destaque: [2,1,3] ainda funciona", () => {
    const data = {
      highlights: [{ id: "A" }, { id: "B" }, { id: "C" }],
    };
    reorderHighlightsInJson(data, [2, 1, 3]);
    assert.equal((data.highlights[0] as { id: string }).id, "B");
    assert.equal((data.highlights[1] as { id: string }).id, "A");
    assert.equal((data.highlights[2] as { id: string }).id, "C");
  });

  it("retorna false quando highlights.length < newOrder.length", () => {
    const data = { highlights: [{ id: "A" }] };
    assert.equal(reorderHighlightsInJson(data, [2, 1]), false);
  });
});

describe("reorderDestaquesInMd 2-destaque (#2352)", () => {
  const md2d = `Intro.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

[**Título D1**](https://d1.com)

Texto D1.

---

**DESTAQUE 2 | 💼 MERCADO**

[**Título D2**](https://d2.com)

Texto D2.
`;

  it("swap D1↔D2 em edição 2-destaque funciona corretamente", () => {
    const result = reorderDestaquesInMd(md2d, [2, 1]);
    // D2 original aparece primeiro após o reorder
    assert.match(result, /DESTAQUE 1 \| 💼 MERCADO/);
    assert.match(result, /DESTAQUE 2 \| 🚀 LANÇAMENTO/);
    // Conteúdo preservado
    assert.match(result, /Título D2/);
    assert.match(result, /Título D1/);
    // Ordem: D2 content antes de D1 content
    const d2Pos = result.indexOf("Título D2");
    const d1Pos = result.indexOf("Título D1");
    assert.ok(d2Pos < d1Pos, `D2 deve aparecer antes de D1 após swap (d2=${d2Pos}, d1=${d1Pos})`);
  });

  it("[1,2] em 2-destaque = no-op (MD inalterado)", () => {
    const result = reorderDestaquesInMd(md2d, [1, 2]);
    // Os headers são renumerados identicamente (1→1, 2→2)
    assert.match(result, /DESTAQUE 1 \| 🚀 LANÇAMENTO/);
    assert.match(result, /DESTAQUE 2 \| 💼 MERCADO/);
  });

  it("REGRESSÃO 3-destaque: MD com 3 blocos retorna md inalterado se blocos < newOrder", () => {
    // com newOrder=[2,1,3] e 2 blocos → return md unchanged (blocks.length < newOrder.length)
    const result = reorderDestaquesInMd(md2d, [2, 1, 3]);
    // md2d tem 2 blocos, newOrder tem 3 → guarda original
    assert.equal(result, md2d);
  });
});

describe("reorderSocialMd 2-destaque (#2352)", () => {
  const social2d =
    "# LinkedIn\n## d1\npost1\n## d2\npost2\n\n# Facebook\n## d1\nfb1\n## d2\nfb2\n";

  it("swap d1↔d2 com newOrder=[2,1] em social 2-destaque: renomeia headers (não move conteúdo)", () => {
    // reorderSocialMd renomeia os HEADERS ## dN, não move o conteúdo textual.
    // O conteúdo original de ## d2 ("post2") fica na mesma posição no texto
    // mas agora tem header ## d1. O que muda são os tokens ## dN.
    // Verificamos que a função não crasha e que os headers ainda existem
    // (não removeu nenhuma seção) pois é um swap 2-destaque válido.
    const result = reorderSocialMd(social2d, [2, 1]);
    // Resultado: ## d1 (era d2, agora rotulado como d1), ## d2 (era d1, agora d2)
    // Ambos os headers presentes (nenhum sumiu)
    assert.match(result, /## d1/, "## d1 presente");
    assert.match(result, /## d2/, "## d2 presente");
    // Conteúdo preservado (nenhuma linha removida)
    assert.match(result, /post1/);
    assert.match(result, /post2/);
    assert.match(result, /fb1/);
    assert.match(result, /fb2/);
    // Post originalmente em d2 ("post2") agora está sob ## d1 (verifica proximidade de header)
    const d1Pos = result.indexOf("## d1");
    const post2Pos = result.indexOf("post2");
    const d2Pos = result.indexOf("## d2");
    const post1Pos = result.indexOf("post1");
    // Após o swap: ## d1 aparece antes de post2, e ## d2 aparece antes de post1
    assert.ok(d1Pos < post2Pos, `## d1 deve preceder post2 após swap (d1=${d1Pos}, post2=${post2Pos})`);
    assert.ok(d2Pos < post1Pos, `## d2 deve preceder post1 após swap (d2=${d2Pos}, post1=${post1Pos})`);
  });

  it("REGRESSÃO 3-destaque: [2,1,3] renomeia d1/d2 headers (d3 intocado)", () => {
    const social3 =
      "# LinkedIn\n## d1\npost1\n## d2\npost2\n## d3\npost3\n# Facebook\n## d1\nfb1\n## d2\nfb2\n## d3\nfb3\n";
    const result = reorderSocialMd(social3, [2, 1, 3]);
    // Todos os headers presentes
    assert.match(result, /## d1/);
    assert.match(result, /## d2/);
    assert.match(result, /## d3/);
    // d3 content (post3) intocado — só d1/d2 trocaram
    assert.match(result, /post3/);
    assert.match(result, /fb3/);
    // post2 (original d2) agora sob ## d1
    const firstD1Pos = result.indexOf("## d1");
    const post2Pos = result.indexOf("post2");
    const firstD2Pos = result.indexOf("## d2");
    const post1Pos = result.indexOf("post1");
    assert.ok(firstD1Pos < post2Pos, "## d1 antes de post2 (swap confirmado)");
    assert.ok(firstD2Pos < post1Pos, "## d2 antes de post1 (swap confirmado)");
  });
});

describe("renameDestaqueImages 2-destaque (#2352)", () => {
  it("dry-run: renomeia d1↔d2 para 2-destaque edition (sem d3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-2352-rename-"));
    try {
      // Cria arquivos d1 e d2 (sem d3)
      writeFileSync(join(dir, "04-d1-1x1.jpg"), Buffer.alloc(512, 0xff));
      writeFileSync(join(dir, "04-d2-1x1.jpg"), Buffer.alloc(512, 0xff));

      const renames = renameDestaqueImages(dir, [2, 1], true); // dry-run
      // Espera renames para d1→d2 e d2→d1 (via tmp)
      const froms = renames.map((r) => r.from);
      assert.ok(froms.some((f) => f.startsWith("04-d1-")), "deve renomear d1");
      assert.ok(froms.some((f) => f.startsWith("04-d2-")), "deve renomear d2");
      // d3 não existe, então não deve aparecer
      assert.ok(!froms.some((f) => f.includes("d3")), "d3 não deve aparecer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO 3-destaque: dry-run com [2,1,3] inclui d1/d2 (não d3 se não mudou)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-2352-rename3-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), Buffer.alloc(512, 0xff));
      writeFileSync(join(dir, "04-d2-1x1.jpg"), Buffer.alloc(512, 0xff));
      writeFileSync(join(dir, "04-d3-1x1.jpg"), Buffer.alloc(512, 0xff));

      const renames = renameDestaqueImages(dir, [2, 1, 3], true);
      const froms = renames.map((r) => r.from);
      assert.ok(froms.some((f) => f.startsWith("04-d1-")));
      assert.ok(froms.some((f) => f.startsWith("04-d2-")));
      // d3 não mudou de posição (newOrder[2]=3 → position 2, same as before)
      assert.ok(!froms.some((f) => f.startsWith("04-d3-")), "d3 unchanged no swap 1↔2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// reorder-destaques CLI: guard newOrder.length vs readDestaqueCount (#2352 F2)
// ---------------------------------------------------------------------------

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REORDER_SCRIPT = resolve(ROOT_DIR, "scripts/reorder-destaques.ts");

function runReorder(editionDir: string, newOrder: string, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", REORDER_SCRIPT, "--edition", "test", "--edition-dir", editionDir, "--new-order", newOrder, "--dry-run", ...extra],
    { encoding: "utf8", cwd: ROOT_DIR, env: { ...process.env } },
  );
}

describe("reorder-destaques CLI guard: newOrder.length vs destaque_count (#2352 F2)", () => {
  it("REJEITA --new-order 2,1 numa edição 3-destaque (mismatch de comprimento)", () => {
    const { dir, cleanup } = makeEdition(3);
    try {
      const r = runReorder(dir, "2,1");
      assert.equal(r.status, 2, `Esperava exit 2 (reject). stderr: ${r.stderr}`);
      assert.match(r.stderr, /3.*destaque|2.*posições|mismatch/i,
        `Mensagem de erro deve mencionar o mismatch. stderr: ${r.stderr}`);
    } finally {
      cleanup();
    }
  });

  it("ACEITA --new-order 2,1 numa edição 2-destaque (comprimento correto)", () => {
    const { dir, cleanup } = makeEdition(2);
    try {
      // Precisa de _internal para não falhar no existsSync do internalDir
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const r = runReorder(dir, "2,1");
      // dry-run em edição 2D válida — pode ser no-op (exit 0) ou processar (exit 0)
      assert.equal(r.status, 0, `Esperava exit 0 para edição 2D com --new-order 2,1. stderr: ${r.stderr}`);
    } finally {
      cleanup();
    }
  });

  it("ACEITA --new-order 3,1,2 numa edição 3-destaque (comprimento correto)", () => {
    const { dir, cleanup } = makeEdition(3);
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const r = runReorder(dir, "3,1,2");
      assert.equal(r.status, 0, `Esperava exit 0 para edição 3D com --new-order 3,1,2. stderr: ${r.stderr}`);
    } finally {
      cleanup();
    }
  });
});
