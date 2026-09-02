import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLastEditionWithKit } from "../scripts/find-last-edition-with-kit.ts";

function setupEditions(
  editions: Array<{ name: string; hasKit?: boolean; nested?: boolean }>,
): string {
  const tmp = mkdtempSync(join(tmpdir(), "diaria-find-kit-"));
  for (const e of editions) {
    const dir = e.nested ? join(tmp, e.name.slice(0, 4), e.name) : join(tmp, e.name);
    mkdirSync(dir, { recursive: true });
    if (e.hasKit) {
      const internalDir = join(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(internalDir, "kit-diaria-published.json"), '{"broadcast_id":1}');
    }
  }
  return tmp;
}

describe("findLastEditionWithKit", () => {
  it("retorna a edição mais recente anterior com kit-diaria-published.json em _internal/", () => {
    const dir = setupEditions([
      { name: "260421", hasKit: true },
      { name: "260422", hasKit: true },
      { name: "260423", hasKit: true },
      { name: "260424" }, // current, ainda sem canal Kit
    ]);
    try {
      assert.equal(findLastEditionWithKit(dir, "260424"), "data/editions/260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pula edições sem kit-diaria-published.json", () => {
    const dir = setupEditions([
      { name: "260421", hasKit: true },
      { name: "260422" },
      { name: "260423" },
      { name: "260424" },
    ]);
    try {
      assert.equal(findLastEditionWithKit(dir, "260424"), "data/editions/260421");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null se nenhuma edição anterior tem canal Kit — nunca 'ok' sem dado (#7021)", () => {
    const dir = setupEditions([
      { name: "260422" },
      { name: "260423" },
      { name: "260424" },
    ]);
    try {
      assert.equal(findLastEditionWithKit(dir, "260424"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não inclui a edição atual ou futuras", () => {
    const dir = setupEditions([
      { name: "260423", hasKit: true },
      { name: "260424", hasKit: true }, // current
      { name: "260425", hasKit: true }, // futura
    ]);
    try {
      assert.equal(findLastEditionWithKit(dir, "260424"), "data/editions/260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encontra edição no layout NESTED (data/editions/{AAMM}/{AAMMDD})", () => {
    const dir = setupEditions([{ name: "260423", hasKit: true, nested: true }]);
    try {
      assert.equal(findLastEditionWithKit(dir, "260424"), "data/editions/2604/260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null se diretório editions não existe", () => {
    assert.equal(findLastEditionWithKit("/nonexistent/path", "260424"), null);
  });

  it("retorna null se editions está vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-find-kit-empty-"));
    try {
      assert.equal(findLastEditionWithKit(dir, "260424"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
