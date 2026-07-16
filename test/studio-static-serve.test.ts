/**
 * test/studio-static-serve.test.ts (#3555) — guard de path traversal +
 * resolução de MIME de scripts/studio-ui/static-serve.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mimeFor, resolveStaticPath } from "../scripts/studio-ui/static-serve.ts";

function setupPublicDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "studio-static-"));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  writeFileSync(join(dir, "app.js"), "console.log(1)");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "nested.css"), "body{}");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("mimeFor (#3555)", () => {
  it("mapeia extensões conhecidas", () => {
    assert.equal(mimeFor("x.html"), "text/html; charset=utf-8");
    assert.equal(mimeFor("x.css"), "text/css; charset=utf-8");
    assert.equal(mimeFor("x.js"), "text/javascript; charset=utf-8");
  });
  it("extensão desconhecida cai em octet-stream", () => {
    assert.equal(mimeFor("x.weird"), "application/octet-stream");
  });
});

describe("resolveStaticPath (#3555)", () => {
  it("'/' resolve pra index.html dentro do publicDir", () => {
    const { dir, cleanup } = setupPublicDir();
    try {
      assert.equal(resolveStaticPath(dir, "/"), join(dir, "index.html"));
    } finally {
      cleanup();
    }
  });

  it("path relativo simples resolve normalmente", () => {
    const { dir, cleanup } = setupPublicDir();
    try {
      assert.equal(resolveStaticPath(dir, "/app.js"), join(dir, "app.js"));
      assert.equal(resolveStaticPath(dir, "/sub/nested.css"), join(dir, "sub", "nested.css"));
    } finally {
      cleanup();
    }
  });

  it("ignora query string", () => {
    const { dir, cleanup } = setupPublicDir();
    try {
      assert.equal(resolveStaticPath(dir, "/app.js?v=2"), join(dir, "app.js"));
    } finally {
      cleanup();
    }
  });

  it("path traversal (../../) retorna null em vez de escapar do publicDir", () => {
    const { dir, cleanup } = setupPublicDir();
    try {
      assert.equal(resolveStaticPath(dir, "/../../../../etc/passwd"), null);
      assert.equal(resolveStaticPath(dir, "/..%2f..%2fsecret"), null);
    } finally {
      cleanup();
    }
  });
});
