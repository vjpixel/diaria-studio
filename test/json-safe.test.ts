import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonSafe, readJsonFile } from "../scripts/lib/json-safe.ts";

describe("parseJsonSafe", () => {
  it("parseia JSON válido e retorna o valor tipado", () => {
    const result = parseJsonSafe<{ x: number }>('{"x": 42}');
    assert.equal(result.x, 42);
  });

  it("parseia array JSON", () => {
    const result = parseJsonSafe<string[]>('["a","b"]');
    assert.deepEqual(result, ["a", "b"]);
  });

  it("lança erro com mensagem de contexto em JSON inválido", () => {
    assert.throws(
      () => parseJsonSafe("not json", "test-context"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("JSON parse error"));
        assert.ok(err.message.includes("test-context"));
        return true;
      },
    );
  });

  it("lança erro sem contexto quando context não é passado", () => {
    assert.throws(
      () => parseJsonSafe("{invalid}"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith("JSON parse error:"));
        return true;
      },
    );
  });
});

describe("readJsonFile", () => {
  it("lê arquivo e parseia JSON corretamente", () => {
    const dir = mkdtempSync(join(tmpdir(), "json-safe-test-"));
    try {
      const file = join(dir, "test.json");
      writeFileSync(file, JSON.stringify({ hello: "world" }), "utf8");
      const result = readJsonFile<{ hello: string }>(file);
      assert.equal(result.hello, "world");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("lança erro com path em falha de parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "json-safe-test-"));
    try {
      const file = join(dir, "broken.json");
      writeFileSync(file, "not valid json", "utf8");
      assert.throws(
        () => readJsonFile(file),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("JSON parse error"));
          assert.ok(err.message.includes(file));
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("lança erro quando arquivo não existe", () => {
    assert.throws(
      () => readJsonFile("/nonexistent/path/file.json"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});
