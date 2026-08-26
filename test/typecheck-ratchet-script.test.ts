/**
 * test/typecheck-ratchet-script.test.ts (#6217)
 *
 * Cobre a parte de I/O de `scripts/typecheck-ratchet.ts` — load/save da
 * baseline em diretório temporário. NUNCA invoca `runTscTest` (o `tsc`
 * real) — zero rede, zero processo filho neste teste.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadBaseline, saveBaseline } from "../scripts/typecheck-ratchet.ts";

describe("loadBaseline / saveBaseline (#6217, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "typecheck-ratchet-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> baseline vazia (fail-soft, nunca lança)", () => {
    assert.deepEqual(loadBaseline(resolve(tmpDir, "nao-existe.json")), {});
  });

  it("roundtrip: save + load preserva o mapa", () => {
    const path = resolve(tmpDir, "tsc-baseline.json");
    const baseline = { "a.ts::TS1": 2, "b.ts::TS2": 1 };
    saveBaseline(baseline, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadBaseline(path), baseline);
  });

  it("save produz JSON com chaves ordenadas e newline final (diff legível)", () => {
    const path = resolve(tmpDir, "tsc-baseline.json");
    saveBaseline({ "z.ts::TS1": 1, "a.ts::TS2": 1 }, path);
    const raw = readFileSync(path, "utf8");
    assert.equal(raw, '{\n  "a.ts::TS2": 1,\n  "z.ts::TS1": 1\n}\n');
  });

  it("JSON corrompido -> baseline vazia, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadBaseline(path), {});
  });

  it("JSON é um array (formato inesperado) -> baseline vazia, nunca propaga tipo inválido", () => {
    const path = resolve(tmpDir, "array.json");
    writeFileSync(path, "[]");
    assert.deepEqual(loadBaseline(path), {});
  });
});
