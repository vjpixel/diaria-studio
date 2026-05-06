import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readDriveCache, getPushCount } from "../scripts/check-drive-push.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAMPLE_CACHE = {
  editions: {
    "260506": {
      day_folder_id: "abc123",
      files: {
        "01-categorized.md": { push_count: 2, drive_file_id: "file1" },
        "01-eia.md": { push_count: 1, drive_file_id: "file2" },
      },
    },
    "260505": {
      day_folder_id: "def456",
      files: {
        "01-categorized.md": { push_count: 1, drive_file_id: "file3" },
      },
    },
  },
};

describe("readDriveCache (#694)", () => {
  it("lê cache válido e retorna objeto", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-cache-"));
    const cachePath = join(dir, "drive-cache.json");
    try {
      writeFileSync(cachePath, JSON.stringify(SAMPLE_CACHE));
      const cache = readDriveCache(cachePath);
      assert.ok(cache, "deve retornar objeto");
      assert.ok(cache!.editions, "deve ter campo editions");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("arquivo não existe → null", () => {
    assert.equal(readDriveCache("/nonexistent/path/cache.json"), null);
  });

  it("JSON inválido → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-cache-"));
    const cachePath = join(dir, "drive-cache.json");
    try {
      writeFileSync(cachePath, "{ invalid json }");
      assert.equal(readDriveCache(cachePath), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("array (schema errado) → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-cache-"));
    const cachePath = join(dir, "drive-cache.json");
    try {
      writeFileSync(cachePath, JSON.stringify([]));
      assert.equal(readDriveCache(cachePath), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("schema com campo editions renomeado → retorna objeto (sem crash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-cache-"));
    const cachePath = join(dir, "drive-cache.json");
    try {
      // Simula schema v-nova: editions → edition_data
      writeFileSync(cachePath, JSON.stringify({ edition_data: {}, version: 2 }));
      const cache = readDriveCache(cachePath);
      assert.ok(cache, "deve retornar objeto mesmo sem editions");
      assert.equal(cache!.editions, undefined, "editions não existe no novo schema");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("getPushCount (#694)", () => {
  it("retorna push_count quando arquivo foi pushed", () => {
    const count = getPushCount(SAMPLE_CACHE, "260506", "01-categorized.md");
    assert.equal(count, 2);
  });

  it("retorna push_count de edição diferente", () => {
    const count = getPushCount(SAMPLE_CACHE, "260505", "01-categorized.md");
    assert.equal(count, 1);
  });

  it("edição não encontrada → null", () => {
    assert.equal(getPushCount(SAMPLE_CACHE, "999999", "01-categorized.md"), null);
  });

  it("arquivo não encontrado na edição → null", () => {
    assert.equal(getPushCount(SAMPLE_CACHE, "260506", "02-reviewed.md"), null);
  });

  it("push_count = 0 → null (não foi pushed)", () => {
    const cache = {
      editions: { "260506": { files: { "01-categorized.md": { push_count: 0 } } } },
    };
    assert.equal(getPushCount(cache, "260506", "01-categorized.md"), null);
  });

  it("campo editions ausente → null sem crash", () => {
    assert.equal(getPushCount({}, "260506", "01-categorized.md"), null);
  });

  it("schema inesperado (editions = string) → null sem crash", () => {
    const broken = { editions: "unexpected" } as unknown as typeof SAMPLE_CACHE;
    assert.equal(getPushCount(broken, "260506", "01-categorized.md"), null);
  });
});
