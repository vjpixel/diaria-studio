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

  // #2463/#3024: edição pode estar no layout NESTED novo `{AAMM}/{AAMMDD}`
  // em vez do flat legado — regressão pro bug corrigido em #3024.
  it("encontra edição no layout NESTED (data/editions/{AAMM}/{AAMMDD})", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-find-nested-"));
    try {
      const nestedDir = join(dir, "2604", "260423");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, "06-social-published.json"), "{}");
      assert.equal(findLastEditionWithFb(dir, "260424"), "data/editions/2604/260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encontra a mais recente entre layouts flat e nested misturados", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-find-mixed-"));
    try {
      // Flat legado
      mkdirSync(join(dir, "260421"), { recursive: true });
      writeFileSync(join(dir, "260421", "06-social-published.json"), "{}");
      // Nested novo, mais recente
      const nestedDir = join(dir, "2604", "260423");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, "06-social-published.json"), "{}");
      assert.equal(findLastEditionWithFb(dir, "260424"), "data/editions/2604/260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #3483: 06-social-published.json mora em `_internal/` desde a migração
  // pra edition-paths.ts (INTERNAL_JSON_FILES) — checar SÓ a raiz faz o
  // script pular a edição correta e retornar uma edição stale mais antiga
  // que ainda tinha o arquivo na raiz (cenário real reportado na issue:
  // retornou 260509 em vez de 260714).
  it("encontra 06-social-published.json em _internal/ e não regride pra edição stale com arquivo na raiz (#3483)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-find-internal-"));
    try {
      // Edição antiga (legado), arquivo na raiz.
      mkdirSync(join(dir, "260509"), { recursive: true });
      writeFileSync(join(dir, "260509", "06-social-published.json"), "{}");
      // Edição recente (pós-migração #3024), arquivo em _internal/.
      const recentInternal = join(dir, "260714", "_internal");
      mkdirSync(recentInternal, { recursive: true });
      writeFileSync(join(recentInternal, "06-social-published.json"), "{}");
      // Current — sem fb ainda.
      mkdirSync(join(dir, "260715"), { recursive: true });
      assert.equal(findLastEditionWithFb(dir, "260715"), "data/editions/260714");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encontra 06-social-published.json em _internal/ no layout NESTED (#3483)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-find-internal-nested-"));
    try {
      const nestedInternal = join(dir, "2607", "260714", "_internal");
      mkdirSync(nestedInternal, { recursive: true });
      writeFileSync(join(nestedInternal, "06-social-published.json"), "{}");
      assert.equal(findLastEditionWithFb(dir, "260715"), "data/editions/2607/260714");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
