/**
 * test/render-linkedin-weekly.test.ts (#5536)
 *
 * Cobre a cópia mecânica da imagem de capa (`04-d1-2x1.jpg`, da edição de
 * origem da manchete #1) que `render-linkedin-weekly.ts` passou a fazer no
 * Passo 7 da skill — antes do #5536 nenhum passo produzia essa imagem
 * (copiada manualmente 2x, ciclos 26w32/26w33, fora de qualquer script).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as renderMain, resolveCoverImageSourcePath, COVER_IMAGE_FILENAME } from "../scripts/render-linkedin-weekly.ts";

const originalArgv = process.argv;
after(() => {
  process.argv = originalArgv;
});

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "render-linkedin-weekly-test-"));
}

function writeSelection(root: string, cycle: string, headlineOneEditionDate: string): void {
  const dir = join(root, "data/weekly", cycle, "_internal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ln-selection.json"),
    JSON.stringify(
      {
        cycle,
        headlines: [
          { title: "Manchete 1", body: "Corpo 1", why: "", editionDate: headlineOneEditionDate },
          { title: "Manchete 2", body: "Corpo 2", why: "", editionDate: "260811" },
        ],
        useMelhor: null,
        weeklyEditions: [],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function runRender(root: string, cycle: string): void {
  process.argv = [
    "node",
    "render-linkedin-weekly.ts",
    "--cycle",
    cycle,
    "--opening",
    "Abertura de teste.",
    "--closing",
    "Fecho de teste.",
  ];
  renderMain(root);
}

describe("render-linkedin-weekly.ts — imagem de capa (#5536)", () => {
  it("copia 04-d1-2x1.jpg da edição de origem da manchete #1 quando o arquivo existe", () => {
    const root = mkTmpRoot();
    try {
      writeSelection(root, "26w34", "260810");
      const editionDir = join(root, "data/editions/260810");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(join(editionDir, COVER_IMAGE_FILENAME), Buffer.from("fake-jpg-bytes"));

      runRender(root, "26w34");

      const expectedCoverPath = join(root, "data/weekly/26w34", COVER_IMAGE_FILENAME);
      assert.ok(existsSync(expectedCoverPath), "esperava a imagem de capa copiada pra data/weekly/{cycle}/");
      assert.equal(readFileSync(expectedCoverPath, "utf8"), "fake-jpg-bytes");

      const meta = JSON.parse(readFileSync(join(root, "data/weekly/26w34/ln-26w34.json"), "utf8"));
      assert.equal(meta.coverImagePath, expectedCoverPath);
      assert.ok(!meta.warnings.some((w: string) => w.includes("#5536")), "não deveria haver warning de capa ausente");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fail-soft: edição de origem sem 04-d1-2x1.jpg — não trava o render, warning explícito (#5536)", () => {
    const root = mkTmpRoot();
    try {
      writeSelection(root, "26w35", "260810");
      // Edição existe mas sem a imagem (arquivada / nunca gerada).
      mkdirSync(join(root, "data/editions/260810"), { recursive: true });

      runRender(root, "26w35");

      const expectedCoverPath = join(root, "data/weekly/26w35", COVER_IMAGE_FILENAME);
      assert.ok(!existsSync(expectedCoverPath), "não deveria ter copiado nada — fonte ausente");
      assert.ok(existsSync(join(root, "data/weekly/26w35/ln-26w35.html")), "o render do artigo não deve travar por causa da capa");

      const meta = JSON.parse(readFileSync(join(root, "data/weekly/26w35/ln-26w35.json"), "utf8"));
      assert.equal(meta.coverImagePath, null);
      assert.ok(
        meta.warnings.some((w: string) => w.includes("#5536") && w.includes("não encontrada")),
        "esperava warning explícito de capa ausente",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem manchetes na seleção — não tenta copiar capa, não lança", () => {
    const root = mkTmpRoot();
    try {
      const dir = join(root, "data/weekly/26w36/_internal");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "ln-selection.json"),
        JSON.stringify({ cycle: "26w36", headlines: [], useMelhor: null, weeklyEditions: [] }, null, 2),
        "utf8",
      );

      runRender(root, "26w36");

      const meta = JSON.parse(readFileSync(join(root, "data/weekly/26w36/ln-26w36.json"), "utf8"));
      assert.equal(meta.coverImagePath, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveCoverImageSourcePath", () => {
  it("retorna o path quando a imagem existe (layout flat de edição)", () => {
    const root = mkTmpRoot();
    try {
      const editionsRootDir = join(root, "data/editions");
      mkdirSync(join(editionsRootDir, "260810"), { recursive: true });
      writeFileSync(join(editionsRootDir, "260810", COVER_IMAGE_FILENAME), "x");
      const resolved = resolveCoverImageSourcePath(editionsRootDir, "260810");
      assert.equal(resolved, join(editionsRootDir, "260810", COVER_IMAGE_FILENAME));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna null quando a edição/imagem não existe", () => {
    const root = mkTmpRoot();
    try {
      const editionsRootDir = join(root, "data/editions");
      const resolved = resolveCoverImageSourcePath(editionsRootDir, "260810");
      assert.equal(resolved, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
