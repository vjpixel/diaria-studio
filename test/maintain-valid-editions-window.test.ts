/**
 * test/maintain-valid-editions-window.test.ts (#1233)
 *
 * Cobre `editionsInWindow` + `diffSets` (pure functions). `run()` faz
 * I/O com KV remoto e não é testado aqui — smoke test live é o teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editionsInWindow,
  diffSets,
} from "../scripts/maintain-valid-editions-window.ts";

describe("editionsInWindow (#1233)", () => {
  const NOW = new Date("2026-05-13T00:00:00Z");

  function writeRaw(editions: { published_at: string }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "maintain-window-"));
    const path = join(dir, "past-editions-raw.json");
    writeFileSync(path, JSON.stringify(editions), "utf8");
    return path;
  }

  it("retorna [] quando arquivo não existe", () => {
    const r = editionsInWindow({
      pastEditionsRawPath: "/tmp/nonexistent-path-12345.json",
      windowDays: 7,
      now: NOW,
    });
    assert.deepEqual(r, []);
  });

  it("retorna [] quando JSON inválido", () => {
    const dir = mkdtempSync(join(tmpdir(), "maintain-bad-"));
    const path = join(dir, "past-editions-raw.json");
    writeFileSync(path, "{not valid json", "utf8");
    try {
      const r = editionsInWindow({ pastEditionsRawPath: path, windowDays: 7, now: NOW });
      assert.deepEqual(r, []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("inclui edições dentro da janela de 7 dias", () => {
    const path = writeRaw([
      { published_at: "2026-05-12T08:00:00Z" }, // -1 day → include
      { published_at: "2026-05-09T08:00:00Z" }, // -4 days → include
      { published_at: "2026-05-06T08:00:00Z" }, // -7 days → include (boundary)
      { published_at: "2026-05-05T08:00:00Z" }, // -8 days → exclude
      { published_at: "2026-04-01T08:00:00Z" }, // way older → exclude
    ]);
    const r = editionsInWindow({ pastEditionsRawPath: path, windowDays: 7, now: NOW });
    assert.deepEqual(r.sort(), ["260506", "260509", "260512"]);
  });

  it("respeita window-days = 14", () => {
    const path = writeRaw([
      { published_at: "2026-05-12T08:00:00Z" }, // -1 day
      { published_at: "2026-04-30T08:00:00Z" }, // -13 days → include
      { published_at: "2026-04-28T08:00:00Z" }, // -15 days → exclude
    ]);
    const r = editionsInWindow({ pastEditionsRawPath: path, windowDays: 14, now: NOW });
    assert.deepEqual(r.sort(), ["260430", "260512"]);
  });

  it("ignora entries sem published_at ou com data inválida", () => {
    const path = writeRaw([
      { published_at: "2026-05-12T08:00:00Z" },
      { published_at: "" },
      { published_at: "not-a-date" },
      // @ts-expect-error testing malformed
      { other: "field" },
    ]);
    const r = editionsInWindow({ pastEditionsRawPath: path, windowDays: 7, now: NOW });
    assert.deepEqual(r, ["260512"]);
  });
});

describe("diffSets (#1233)", () => {
  it("identifica adds + removes", () => {
    const r = diffSets(["a", "b", "c"], ["b", "c", "d"]);
    assert.deepEqual(r.added, ["d"]);
    assert.deepEqual(r.removed, ["a"]);
    assert.equal(r.unchanged, false);
  });

  it("unchanged quando arrays iguais", () => {
    const r = diffSets(["a", "b"], ["b", "a"]); // ordem não importa
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
    assert.equal(r.unchanged, true);
  });

  it("empty previous + non-empty target → tudo added", () => {
    const r = diffSets([], ["a", "b"]);
    assert.deepEqual(r.added, ["a", "b"]);
    assert.deepEqual(r.removed, []);
    assert.equal(r.unchanged, false);
  });

  it("non-empty previous + empty target → tudo removed", () => {
    const r = diffSets(["a", "b"], []);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, ["a", "b"]);
    assert.equal(r.unchanged, false);
  });
});
