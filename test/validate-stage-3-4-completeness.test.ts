/**
 * validate-stage-3-4-completeness.test.ts (#1132 P1.2)
 *
 * Tests dos validadores anti-skip pra Stage 3 (imagens) e Stage 4 (publicação).
 * Cobertura via fixtures de dir temporário com seleção de outputs presentes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findMissingStage3Outputs } from "../scripts/validate-stage-3-completeness.ts";
import { findMissingStage4Outputs } from "../scripts/validate-stage-4-completeness.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "diaria-validate-test-"));
}

function touch(path: string, content = "x"): void {
  writeFileSync(path, content);
}

function makeJpg(path: string): void {
  // Conteúdo qualquer não-vazio simula JPEG real (validadores só checam tamanho > 0)
  writeFileSync(path, "JPEG-FAKE-CONTENT");
}

describe("findMissingStage3Outputs (#1132 P1.2)", () => {
  it("retorna vazio quando todos os outputs presentes (naming A/B novo)", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      makeJpg(join(dir, "01-eia-A.jpg"));
      makeJpg(join(dir, "01-eia-B.jpg"));
      makeJpg(join(dir, "04-d1-2x1.jpg"));
      makeJpg(join(dir, "04-d1-1x1.jpg"));
      makeJpg(join(dir, "04-d2-2x1.jpg")); // #2133/#2141/#2366: hero D2
      makeJpg(join(dir, "04-d2-1x1.jpg"));
      makeJpg(join(dir, "04-d3-2x1.jpg")); // #2133/#2141: hero D3
      makeJpg(join(dir, "04-d3-1x1.jpg"));
      touch(join(dir, "_internal/01-eia-meta.json"), "{}");
      touch(join(dir, "01-eia.md"), "# eia");

      const missing = findMissingStage3Outputs(dir);
      assert.deepEqual(missing, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aceita naming legacy real/ia (pre-#192)", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      makeJpg(join(dir, "01-eia-real.jpg"));
      makeJpg(join(dir, "01-eia-ia.jpg"));
      makeJpg(join(dir, "04-d1-2x1.jpg"));
      makeJpg(join(dir, "04-d1-1x1.jpg"));
      makeJpg(join(dir, "04-d2-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d2-1x1.jpg"));
      makeJpg(join(dir, "04-d3-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d3-1x1.jpg"));
      touch(join(dir, "_internal/01-eia-meta.json"), "{}");
      touch(join(dir, "01-eia.md"));

      const missing = findMissingStage3Outputs(dir);
      assert.deepEqual(missing, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta falta de par È IA?", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      // Sem nenhuma imagem È IA?
      makeJpg(join(dir, "04-d1-2x1.jpg"));
      makeJpg(join(dir, "04-d1-1x1.jpg"));
      makeJpg(join(dir, "04-d2-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d2-1x1.jpg"));
      makeJpg(join(dir, "04-d3-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d3-1x1.jpg"));
      touch(join(dir, "_internal/01-eia-meta.json"));
      touch(join(dir, "01-eia.md"));

      const missing = findMissingStage3Outputs(dir);
      assert.ok(missing.length > 0);
      const eaiMiss = missing.find((m) => m.category === "eia-image");
      assert.ok(eaiMiss);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta falta de imagem de destaque individual", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      makeJpg(join(dir, "01-eia-A.jpg"));
      makeJpg(join(dir, "01-eia-B.jpg"));
      makeJpg(join(dir, "04-d1-2x1.jpg"));
      // Falta 04-d1-1x1.jpg
      makeJpg(join(dir, "04-d2-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d2-1x1.jpg"));
      makeJpg(join(dir, "04-d3-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d3-1x1.jpg"));
      touch(join(dir, "_internal/01-eia-meta.json"));
      touch(join(dir, "01-eia.md"));

      const missing = findMissingStage3Outputs(dir);
      const d1miss = missing.find((m) => m.file === "04-d1-1x1.jpg");
      assert.ok(d1miss);
      assert.equal(d1miss.category, "destaque-image");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta imagem vazia (0 bytes) como ausente", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      makeJpg(join(dir, "01-eia-A.jpg"));
      makeJpg(join(dir, "01-eia-B.jpg"));
      writeFileSync(join(dir, "04-d1-2x1.jpg"), ""); // vazia!
      makeJpg(join(dir, "04-d1-1x1.jpg"));
      makeJpg(join(dir, "04-d2-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d2-1x1.jpg"));
      makeJpg(join(dir, "04-d3-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d3-1x1.jpg"));
      touch(join(dir, "_internal/01-eia-meta.json"));
      touch(join(dir, "01-eia.md"));

      const missing = findMissingStage3Outputs(dir);
      const d1miss = missing.find((m) => m.file === "04-d1-2x1.jpg");
      assert.ok(d1miss);
      assert.match(d1miss.reason, /vazia|0 bytes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta falta de eia metadata + md", () => {
    const dir = makeDir();
    try {
      makeJpg(join(dir, "01-eia-A.jpg"));
      makeJpg(join(dir, "01-eia-B.jpg"));
      makeJpg(join(dir, "04-d1-2x1.jpg"));
      makeJpg(join(dir, "04-d1-1x1.jpg"));
      makeJpg(join(dir, "04-d2-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d2-1x1.jpg"));
      makeJpg(join(dir, "04-d3-2x1.jpg")); // #2366
      makeJpg(join(dir, "04-d3-1x1.jpg"));
      // Sem _internal/01-eia-meta.json, sem 01-eia.md

      const missing = findMissingStage3Outputs(dir);
      const metaMiss = missing.find((m) => m.category === "eia-metadata");
      const mdMiss = missing.find((m) => m.category === "eia-md");
      assert.ok(metaMiss);
      assert.ok(mdMiss);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #2366 — 04-d2-2x1.jpg regressão (hero D2 estava ausente da lista)
// ---------------------------------------------------------------------------

describe("findMissingStage3Outputs — 04-d2-2x1.jpg regressão (#2366)", () => {
  it("FALHA quando 04-d2-2x1.jpg ausente em edição 3-destaque", () => {
    // Antes do fix #2366, validate-stage-3 não requeria 04-d2-2x1.jpg
    // apesar de stage-3.ts REQUIRED_IMAGES_BASE incluí-la (#2133/#2141).
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      makeJpg(join(dir, "01-eia-A.jpg"));
      makeJpg(join(dir, "01-eia-B.jpg"));
      makeJpg(join(dir, "04-d1-2x1.jpg"));
      makeJpg(join(dir, "04-d1-1x1.jpg"));
      // 04-d2-2x1.jpg AUSENTE — deve ser detectada como missing
      makeJpg(join(dir, "04-d2-1x1.jpg"));
      makeJpg(join(dir, "04-d3-2x1.jpg"));
      makeJpg(join(dir, "04-d3-1x1.jpg"));
      touch(join(dir, "_internal/01-eia-meta.json"), "{}");
      touch(join(dir, "01-eia.md"), "# eia");

      const missing = findMissingStage3Outputs(dir);
      assert.ok(
        missing.some((m) => m.file === "04-d2-2x1.jpg"),
        `Deve reportar 04-d2-2x1.jpg ausente. Achei: ${JSON.stringify(missing)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FALHA quando 04-d2-2x1.jpg ausente em edição 2-destaque", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "01-approved-capped.json"),
        JSON.stringify({ highlights: [{ rank: 1 }, { rank: 2 }] }),
      );
      makeJpg(join(dir, "01-eia-A.jpg"));
      makeJpg(join(dir, "01-eia-B.jpg"));
      makeJpg(join(dir, "04-d1-2x1.jpg"));
      makeJpg(join(dir, "04-d1-1x1.jpg"));
      // 04-d2-2x1.jpg AUSENTE — deve ser detectada como missing em 2-destaque
      makeJpg(join(dir, "04-d2-1x1.jpg"));
      touch(join(dir, "_internal/01-eia-meta.json"), "{}");
      touch(join(dir, "01-eia.md"), "# eia");

      const missing = findMissingStage3Outputs(dir);
      assert.ok(
        missing.some((m) => m.file === "04-d2-2x1.jpg"),
        `Deve reportar 04-d2-2x1.jpg ausente em edição 2-destaque. Achei: ${JSON.stringify(missing)}`,
      );
      assert.ok(
        !missing.some((m) => m.file.includes("d3")),
        `d3 NÃO deve aparecer em violações de edição 2-destaque. Achei: ${JSON.stringify(missing)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #2352 — findMissingStage3Outputs: 2-destaque edition (d3 not required)
// ---------------------------------------------------------------------------

describe("findMissingStage3Outputs 2-destaque (#2352)", () => {
  it("PASSA para edição 2-destaque com d1/d2 images (sem d3)", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      // approved-capped com 2 highlights → readDestaqueCount returns 2
      writeFileSync(
        join(dir, "_internal", "01-approved-capped.json"),
        JSON.stringify({ highlights: [{ rank: 1 }, { rank: 2 }] }),
      );
      writeFileSync(join(dir, "01-eia-A.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "01-eia-B.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "04-d2-2x1.jpg"), "JPEG-FAKE"); // #2133/#2141/#2366: hero D2 requerido
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "_internal/01-eia-meta.json"), "{}");
      writeFileSync(join(dir, "01-eia.md"), "# eia");

      const missing = findMissingStage3Outputs(dir);
      assert.deepEqual(
        missing,
        [],
        `Esperava 0 missing para 2D edition sem d3. Achei: ${JSON.stringify(missing)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FALHA para edição 2-destaque quando d2 ausente (d3 NÃO conta)", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "01-approved-capped.json"),
        JSON.stringify({ highlights: [{ rank: 1 }, { rank: 2 }] }),
      );
      writeFileSync(join(dir, "01-eia-A.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "01-eia-B.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "JPEG-FAKE");
      // 04-d2-1x1.jpg ausente
      writeFileSync(join(dir, "_internal/01-eia-meta.json"), "{}");
      writeFileSync(join(dir, "01-eia.md"), "# eia");

      const missing = findMissingStage3Outputs(dir);
      assert.ok(
        missing.some((m) => m.file === "04-d2-1x1.jpg"),
        `Deve reportar 04-d2-1x1.jpg ausente. Achei: ${JSON.stringify(missing)}`,
      );
      assert.ok(
        !missing.some((m) => m.file.includes("d3")),
        `d3 NÃO deve aparecer em violações de edição 2-destaque. Achei: ${JSON.stringify(missing)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO 3-destaque: ainda falha quando d3 ausente (sem approved-capped → default 3)", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      // sem approved-capped → readDestaqueCount defaults to 3
      writeFileSync(join(dir, "01-eia-A.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "01-eia-B.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "JPEG-FAKE");
      writeFileSync(join(dir, "04-d2-2x1.jpg"), "JPEG-FAKE"); // #2366
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "JPEG-FAKE");
      // 04-d3-2x1.jpg e 04-d3-1x1.jpg ausentes
      writeFileSync(join(dir, "_internal/01-eia-meta.json"), "{}");
      writeFileSync(join(dir, "01-eia.md"), "# eia");

      const missing = findMissingStage3Outputs(dir);
      assert.ok(
        missing.some((m) => m.file === "04-d3-1x1.jpg"),
        `3D edition (default) deve reportar 04-d3-1x1.jpg ausente. Achei: ${JSON.stringify(missing)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findMissingStage4Outputs (#1132 P1.2)", () => {
  it("retorna vazio quando outputs newsletter + social presentes", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/05-published.json"),
        JSON.stringify({
          draft_url: "https://app.beehiiv.com/posts/abc/edit",
          title: "Test",
          test_email_sent_at: null,
        }),
      );
      writeFileSync(
        join(dir, "_internal/06-social-published.json"),
        JSON.stringify({
          posts: [{ platform: "facebook", destaque: "d1", url: "https://fb.com/123" }],
        }),
      );

      const missing = findMissingStage4Outputs(dir);
      assert.deepEqual(missing, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta falta de 05-published.json", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/06-social-published.json"),
        JSON.stringify({ posts: [{ platform: "fb" }] }),
      );

      const missing = findMissingStage4Outputs(dir);
      const nMiss = missing.find((m) => m.category === "newsletter");
      assert.ok(nMiss);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta 05-published.json sem draft_url", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/05-published.json"),
        JSON.stringify({ title: "Test" }), // sem draft_url
      );
      writeFileSync(
        join(dir, "_internal/06-social-published.json"),
        JSON.stringify({ posts: [{ platform: "fb" }] }),
      );

      const missing = findMissingStage4Outputs(dir);
      const nMiss = missing.find((m) => m.category === "newsletter");
      assert.ok(nMiss);
      assert.match(nMiss.reason, /draft_url/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta social com posts vazio", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/05-published.json"),
        JSON.stringify({ draft_url: "https://x.com" }),
      );
      writeFileSync(
        join(dir, "_internal/06-social-published.json"),
        JSON.stringify({ posts: [] }), // vazio!
      );

      const missing = findMissingStage4Outputs(dir);
      const sMiss = missing.find((m) => m.category === "social");
      assert.ok(sMiss);
      assert.match(sMiss.reason, /vazio/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strict=true detecta test_email_sent_at ausente", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/05-published.json"),
        JSON.stringify({ draft_url: "https://x.com" }), // sem test_email_sent_at
      );
      writeFileSync(
        join(dir, "_internal/06-social-published.json"),
        JSON.stringify({ posts: [{ platform: "fb" }] }),
      );

      const lenient = findMissingStage4Outputs(dir, false);
      assert.deepEqual(lenient, [], "lenient mode: test_email_sent_at não checado");

      const strict = findMissingStage4Outputs(dir, true);
      const teMiss = strict.find((m) => m.category === "test-email");
      assert.ok(teMiss);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON corrupto reportado como falha de parse", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal/05-published.json"), "{ broken");
      writeFileSync(
        join(dir, "_internal/06-social-published.json"),
        JSON.stringify({ posts: [{ platform: "fb" }] }),
      );

      const missing = findMissingStage4Outputs(dir);
      const nMiss = missing.find((m) => m.category === "newsletter");
      assert.ok(nMiss);
      assert.match(nMiss.reason, /parsear/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
