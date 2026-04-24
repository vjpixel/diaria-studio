import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLastEditionWithFb } from "../scripts/find-last-edition-with-fb.ts";

function setupEditions(
  editions: Array<{ name: string; hasFb?: boolean }>,
): string {
  const tmp = mkdtempSync(join(tmpdir(), "diaria-find-"));
  for (const e of editions) {
    const dir = join(tmp, e.name);
    mkdirSync(dir, { recursive: true });
    if (e.hasFb) {
      writeFileSync(join(dir, "06-social-published.json"), "{}");
    }
  }
  return tmp;
}

describe("findLastEditionWithFb", () => {
  it("retorna a edição mais recente anterior com 06-social-published.json", () => {
    const dir = setupEditions([
      { name: "260421", hasFb: true },
      { name: "260422", hasFb: true },
      { name: "260423", hasFb: true },
      { name: "260424" }, // current, sem fb yet
    ]);
    try {
      assert.equal(findLastEditionWithFb(dir, "260424"), "data/editions/260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pula edições sem 06-social-published.json", () => {
    const dir = setupEditions([
      { name: "260421", hasFb: true },
      { name: "260422" }, // sem fb
      { name: "260423" }, // sem fb
      { name: "260424" }, // current
    ]);
    try {
      assert.equal(findLastEditionWithFb(dir, "260424"), "data/editions/260421");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null se nenhuma edição anterior tem 06-social-published.json", () => {
    const dir = setupEditions([
      { name: "260422" },
      { name: "260423" },
      { name: "260424" },
    ]);
    try {
      assert.equal(findLastEditionWithFb(dir, "260424"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não inclui a edição atual ou futuras", () => {
    const dir = setupEditions([
      { name: "260423", hasFb: true },
      { name: "260424", hasFb: true }, // current
      { name: "260425", hasFb: true }, // futura
    ]);
    try {
      assert.equal(findLastEditionWithFb(dir, "260424"), "data/editions/260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignora diretórios com nome não-AAMMDD", () => {
    const dir = setupEditions([
      { name: "260423", hasFb: true },
      { name: "archive", hasFb: true },
      { name: ".DS_Store" },
      { name: "260424" }, // current
    ]);
    try {
      assert.equal(findLastEditionWithFb(dir, "260424"), "data/editions/260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null se diretório editions não existe", () => {
    assert.equal(findLastEditionWithFb("/nonexistent/path", "260424"), null);
  });

  it("retorna null se editions está vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-find-empty-"));
    try {
      assert.equal(findLastEditionWithFb(dir, "260424"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
