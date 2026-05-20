/**
 * test/social-source-hash.test.ts (#1413)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashHighlights,
  hashFromApprovedFile,
} from "../scripts/lib/social-source-hash.ts";

describe("hashHighlights (#1413)", () => {
  it("hash determinístico: mesmos highlights → mesmo hash", () => {
    const h1 = hashHighlights([
      { url: "https://a", title_options: ["A"] },
      { url: "https://b", title_options: ["B"] },
    ]);
    const h2 = hashHighlights([
      { url: "https://a", title_options: ["A"] },
      { url: "https://b", title_options: ["B"] },
    ]);
    assert.equal(h1, h2);
  });

  it("#1413: ordem importa — reorder de D1/D2 muda o hash (caso 260520 reestrutura)", () => {
    const h1 = hashHighlights([
      { url: "https://karpathy", title_options: ["Karpathy"] },
      { url: "https://kpmg", title_options: ["KPMG"] },
    ]);
    const h2 = hashHighlights([
      { url: "https://google-io", title_options: ["Google I/O"] },
      { url: "https://karpathy", title_options: ["Karpathy"] },
    ]);
    assert.notEqual(h1, h2);
  });

  it("trocar 1 URL detecta — hash diferente", () => {
    const h1 = hashHighlights([{ url: "https://a", title_options: ["A"] }]);
    const h2 = hashHighlights([{ url: "https://b", title_options: ["A"] }]);
    assert.notEqual(h1, h2);
  });

  it("trocar 1 title detecta — hash diferente", () => {
    const h1 = hashHighlights([{ url: "https://a", title_options: ["A"] }]);
    const h2 = hashHighlights([{ url: "https://a", title_options: ["B"] }]);
    assert.notEqual(h1, h2);
  });

  it("highlight sem URL: usa marker (no-url) e ainda computa", () => {
    const h = hashHighlights([{ title_options: ["sem url"] }]);
    assert.ok(h.length > 0);
  });

  it("array vazio: hash determinístico (string vazia)", () => {
    const h1 = hashHighlights([]);
    const h2 = hashHighlights([]);
    assert.equal(h1, h2);
    assert.ok(h1.length > 0);
  });

  it("hash é hex 16-char (sha256 truncado)", () => {
    const h = hashHighlights([{ url: "https://a", title_options: ["A"] }]);
    assert.match(h, /^[0-9a-f]{16}$/);
  });
});

describe("hashFromApprovedFile (#1413)", () => {
  function fixture(content: unknown): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-hash-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const path = join(dir, "_internal", "01-approved.json");
    writeFileSync(path, JSON.stringify(content), "utf8");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("lê file + computa hash igual ao hashHighlights direto", () => {
    const highlights = [
      { url: "https://a", title_options: ["A"] },
      { url: "https://b", title_options: ["B"] },
    ];
    const expected = hashHighlights(highlights);
    const { path, cleanup } = fixture({ highlights });
    assert.equal(hashFromApprovedFile(path), expected);
    cleanup();
  });

  it("highlights ausentes → hash da array vazia", () => {
    const { path, cleanup } = fixture({ other_field: "x" });
    assert.equal(hashFromApprovedFile(path), hashHighlights([]));
    cleanup();
  });

  it("file não-existe → throw (caller decide skip)", () => {
    assert.throws(() => hashFromApprovedFile("/nonexistent/path.json"));
  });

  it("JSON corrupted → throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-hash-corrupt-"));
    const path = join(dir, "broken.json");
    writeFileSync(path, "not-json-{{{");
    assert.throws(() => hashFromApprovedFile(path));
    rmSync(dir, { recursive: true, force: true });
  });
});
