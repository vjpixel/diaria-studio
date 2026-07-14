import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateTokens,
  findInvalidators,
  auditDir,
  formatReport,
} from "../scripts/audit-context-tokens.ts";

describe("estimateTokens", () => {
  it("estima ~chars/4", () => {
    assert.equal(estimateTokens("a".repeat(400)), 100);
  });

  it("arredonda pra cima em resto não-zero", () => {
    assert.equal(estimateTokens("abc"), 1);
  });
});

describe("findInvalidators", () => {
  it("detecta new Date() literal", () => {
    const found = findInvalidators("rode `new Date()` aqui");
    assert.ok(found.some((f) => f.includes("new Date()")));
  });

  it("detecta Date.now() literal", () => {
    const found = findInvalidators("timestamp = Date.now()");
    assert.ok(found.some((f) => f.includes("Date.now()")));
  });

  it("detecta UUID literal", () => {
    const found = findInvalidators("id: 550e8400-e29b-41d4-a716-446655440000");
    assert.ok(found.some((f) => f.includes("UUID")));
  });

  it("detecta timestamp ISO 8601 completo", () => {
    const found = findInvalidators("Última atualização: 2026-05-08T04:01:49.886Z");
    assert.ok(found.some((f) => f.includes("timestamp ISO")));
  });

  it("não detecta nada em prosa comum", () => {
    assert.deepEqual(findInvalidators("Sem links de agregadores."), []);
  });

  it("não detecta datas curtas (AAMMDD) sem componente de hora", () => {
    assert.deepEqual(findInvalidators("edição 260424 rodou ok"), []);
  });
});

describe("auditDir", () => {
  function setup(): string {
    return mkdtempSync(join(tmpdir(), "diaria-context-audit-"));
  }

  it("retorna vazio se o diretório não existe", () => {
    const result = auditDir(join(tmpdir(), "does-not-exist-xyz"));
    assert.deepEqual(result, []);
  });

  it("audita arquivos e ordena por tamanho decrescente", () => {
    const dir = setup();
    try {
      writeFileSync(join(dir, "small.md"), "abc");
      writeFileSync(join(dir, "big.md"), "x".repeat(1000));
      const result = auditDir(dir);
      assert.equal(result.length, 2);
      assert.ok(result[0].path.endsWith("big.md"));
      assert.equal(result[0].bytes, 1000);
      assert.ok(result[1].path.endsWith("small.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("percorre subdiretórios", () => {
    const dir = setup();
    try {
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "nested.md"), "content");
      const result = auditDir(dir);
      assert.equal(result.length, 1);
      assert.ok(result[0].path.includes("sub"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flagga invalidadores por arquivo", () => {
    const dir = setup();
    try {
      writeFileSync(join(dir, "volatile.md"), "gerado em new Date()");
      const result = auditDir(dir);
      assert.ok(result[0].invalidators.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatReport", () => {
  it("resume totais e não crasha sem arquivos", () => {
    const out = formatReport([]);
    assert.ok(out.includes("Total: 0 arquivos"));
    assert.ok(out.includes("Nenhum invalidador"));
  });

  it("lista arquivos com invalidador no rodapé", () => {
    const out = formatReport([
      { path: "a.md", bytes: 10, estimatedTokens: 3, invalidators: ["new Date() / Date.now() literal em prosa"] },
    ]);
    assert.ok(out.includes("1 arquivo(s) com possível invalidador"));
  });
});
