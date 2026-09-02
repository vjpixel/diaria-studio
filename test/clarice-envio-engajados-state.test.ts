/**
 * test/clarice-envio-engajados-state.test.ts (#6945)
 *
 * Cobre `scripts/lib/clarice-envio-engajados-state.ts` — estado durável da
 * escalada de volume do grupo `engajados` (`lastVolume`, base de
 * `proposeEngajadosVolume` na próxima rodada). Fail-soft de leitura
 * (mesmo padrão de `clarice-novos-state.ts`/`clarice-envio-enabled.ts`).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  engajadosStatePath,
  readEngajadosState,
  writeEngajadosState,
} from "../scripts/lib/clarice-envio-engajados-state.ts";

describe("engajadosStatePath / readEngajadosState / writeEngajadosState (#6945)", () => {
  let baseDir: string;

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), "clarice-envio-engajados-state-"));
  });

  after(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("path esperado: {baseDir}/engajados-state.json", () => {
    assert.equal(engajadosStatePath(baseDir), resolve(baseDir, "engajados-state.json"));
  });

  it("arquivo ausente -> null (1ª rodada)", () => {
    assert.equal(readEngajadosState(baseDir), null);
  });

  it("write + read round-trip", () => {
    writeEngajadosState({ lastVolume: 1650, lastSentAtIso: "2026-09-02T22:00:00.000Z", lastCycle: "2608-09" }, baseDir);
    assert.deepEqual(readEngajadosState(baseDir), {
      lastVolume: 1650,
      lastSentAtIso: "2026-09-02T22:00:00.000Z",
      lastCycle: "2608-09",
    });
  });

  it("segunda escrita substitui a primeira (não acumula histórico)", () => {
    writeEngajadosState({ lastVolume: 1815, lastSentAtIso: "2026-09-03T22:00:00.000Z", lastCycle: "2608-09" }, baseDir);
    assert.deepEqual(readEngajadosState(baseDir), {
      lastVolume: 1815,
      lastSentAtIso: "2026-09-03T22:00:00.000Z",
      lastCycle: "2608-09",
    });
  });

  it("cria o diretório-pai se ainda não existir", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-envio-engajados-state-nested-"));
    const nested = resolve(dir, "clarice-subscribers");
    writeEngajadosState({ lastVolume: 100, lastSentAtIso: "2026-09-02T00:00:00.000Z", lastCycle: "2608-09" }, nested);
    assert.deepEqual(readEngajadosState(nested), { lastVolume: 100, lastSentAtIso: "2026-09-02T00:00:00.000Z", lastCycle: "2608-09" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("JSON corrompido -> null, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-envio-engajados-state-corrupt-"));
    writeFileSync(resolve(dir, "engajados-state.json"), "{ nao e json", "utf8");
    assert.equal(readEngajadosState(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shape inesperado (lastVolume ausente) -> null", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-envio-engajados-state-badshape-"));
    writeFileSync(resolve(dir, "engajados-state.json"), JSON.stringify({ lastSentAtIso: "x", lastCycle: "y" }), "utf8");
    assert.equal(readEngajadosState(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("lastVolume não-finito (NaN via JSON não é representável, mas string) -> null", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-envio-engajados-state-nan-"));
    writeFileSync(
      resolve(dir, "engajados-state.json"),
      JSON.stringify({ lastVolume: "1500", lastSentAtIso: "x", lastCycle: "y" }),
      "utf8",
    );
    assert.equal(readEngajadosState(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });
});
