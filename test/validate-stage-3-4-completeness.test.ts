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
      makeJpg(join(dir, "04-d2-1x1.jpg"));
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
      makeJpg(join(dir, "04-d2-1x1.jpg"));
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
      makeJpg(join(dir, "04-d2-1x1.jpg"));
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
      makeJpg(join(dir, "04-d2-1x1.jpg"));
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
      makeJpg(join(dir, "04-d2-1x1.jpg"));
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
      makeJpg(join(dir, "04-d2-1x1.jpg"));
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
