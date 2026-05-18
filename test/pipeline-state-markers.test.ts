import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMarker,
  markerExists,
  readMarker,
  assertMarker,
} from "../scripts/lib/pipeline-state.ts";

function withTempEdition(test: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "diaria-marker-"));
  try {
    test(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("writeMarker / markerExists (#1330)", () => {
  it("escreve marker no path canonical", () => {
    withTempEdition((dir) => {
      writeMarker(dir, "inject-inbox-urls");
      assert.ok(markerExists(dir, "inject-inbox-urls"));
      assert.ok(existsSync(join(dir, "_internal", ".marker-inject-inbox-urls.json")));
    });
  });

  it("inclui details quando fornecidos", () => {
    withTempEdition((dir) => {
      writeMarker(dir, "test-marker", { count: 42, src: "test" });
      const m = readMarker(dir, "test-marker");
      assert.ok(m);
      assert.equal(m.name, "test-marker");
      assert.deepEqual(m.details, { count: 42, src: "test" });
      assert.ok(m.completed_at);
    });
  });

  it("markerExists retorna false antes de write", () => {
    withTempEdition((dir) => {
      assert.equal(markerExists(dir, "nonexistent"), false);
    });
  });

  it("readMarker retorna null se ausente", () => {
    withTempEdition((dir) => {
      assert.equal(readMarker(dir, "nonexistent"), null);
    });
  });

  it("rejeita nomes com path traversal", () => {
    withTempEdition((dir) => {
      assert.throws(() => writeMarker(dir, "../traversal"));
      assert.throws(() => writeMarker(dir, "name/with/slash"));
      assert.throws(() => writeMarker(dir, "name with space"));
    });
  });

  it("aceita kebab-case e numéricos", () => {
    withTempEdition((dir) => {
      writeMarker(dir, "abc-123");
      writeMarker(dir, "ABC-XYZ");
      assert.ok(markerExists(dir, "abc-123"));
      assert.ok(markerExists(dir, "ABC-XYZ"));
    });
  });
});

describe("assertMarker (#1330)", () => {
  it("ok=true quando marker presente", () => {
    withTempEdition((dir) => {
      writeMarker(dir, "ok-marker");
      const result = assertMarker(dir, "ok-marker");
      assert.equal(result.ok, true);
    });
  });

  it("ok=false com reason marker_missing quando ausente", () => {
    withTempEdition((dir) => {
      const result = assertMarker(dir, "missing");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "marker_missing");
    });
  });

  it("escrita não interfere com outros markers", () => {
    withTempEdition((dir) => {
      writeMarker(dir, "first");
      writeMarker(dir, "second");
      assert.ok(markerExists(dir, "first"));
      assert.ok(markerExists(dir, "second"));
    });
  });

  it("idempotente — sobrescreve marker existente com novo timestamp", () => {
    withTempEdition((dir) => {
      writeMarker(dir, "test", { v: 1 });
      const m1 = readMarker(dir, "test");
      writeMarker(dir, "test", { v: 2 });
      const m2 = readMarker(dir, "test");
      assert.deepEqual(m2!.details, { v: 2 });
      // Different timestamps (potentially same in ms-resolution races, but normally different)
      assert.ok(m1!.completed_at <= m2!.completed_at);
    });
  });
});
