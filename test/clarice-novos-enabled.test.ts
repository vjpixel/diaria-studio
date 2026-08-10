/**
 * test/clarice-novos-enabled.test.ts (#4941)
 *
 * Cobre `scripts/lib/clarice-novos-enabled.ts` — o kill switch da task
 * diária `Diaria-Clarice-Novos`. Mesmo molde de
 * test/studio-chat-enabled.test.ts, com o default INVERTIDO (ver docstring
 * do módulo): arquivo ausente/corrompido → `enabled: false` (lado seguro —
 * ao contrário do chat toggle, o pior caso aqui é envio de e-mail real).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readClariceNovosEnabledState,
  isClariceNovosEnabled,
  setClariceNovosEnabled,
} from "../scripts/lib/clarice-novos-enabled.ts";

describe("readClariceNovosEnabledState / isClariceNovosEnabled / setClariceNovosEnabled (#4941)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "clarice-novos-enabled-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sem data/clarice-novos-enabled.json -> default {enabled:false, updatedAt:null} (lado seguro)", () => {
    const state = readClariceNovosEnabledState(root);
    assert.deepEqual(state, { enabled: false, updatedAt: null });
    assert.equal(isClariceNovosEnabled(root), false);
  });

  it("setClariceNovosEnabled(true) persiste e readClariceNovosEnabledState reflete", () => {
    const written = setClariceNovosEnabled(root, true, { now: () => new Date("2026-08-10T20:00:00.000Z") });
    assert.equal(written.enabled, true);
    assert.equal(written.updatedAt, "2026-08-10T20:00:00.000Z");

    const read = readClariceNovosEnabledState(root);
    assert.deepEqual(read, { enabled: true, updatedAt: "2026-08-10T20:00:00.000Z" });
    assert.equal(isClariceNovosEnabled(root), true);
  });

  it("setClariceNovosEnabled(false) pausa de novo e atualiza updatedAt", () => {
    const written = setClariceNovosEnabled(root, false, { now: () => new Date("2026-08-11T09:00:00.000Z") });
    assert.equal(written.enabled, false);
    assert.equal(written.updatedAt, "2026-08-11T09:00:00.000Z");
    assert.equal(isClariceNovosEnabled(root), false);
  });

  it("nunca sobrescreve/reaproveita nenhum outro arquivo sob data/ — path é dedicado", () => {
    const other = resolve(root, "data", "outro-estado-qualquer.json");
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(other, JSON.stringify({ hello: "world" }), "utf8");
    setClariceNovosEnabled(root, true);
    assert.equal(JSON.parse(readFileSync(other, "utf8")).hello, "world");
    assert.equal(readClariceNovosEnabledState(root).enabled, true);
    // devolve o estado ao default seguro pros testes seguintes desta suite
    setClariceNovosEnabled(root, false);
  });

  it("JSON corrompido -> default fail-soft {enabled:false, updatedAt:null}, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-novos-enabled-corrupt-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(resolve(dir, "data", "clarice-novos-enabled.json"), "{ isso não é json", "utf8");
    assert.deepEqual(readClariceNovosEnabledState(dir), { enabled: false, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("shape com 'enabled' de tipo errado -> default fail-soft, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-novos-enabled-badtype-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(resolve(dir, "data", "clarice-novos-enabled.json"), JSON.stringify({ enabled: "sim" }), "utf8");
    assert.deepEqual(readClariceNovosEnabledState(dir), { enabled: false, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("'updatedAt' de tipo errado no arquivo -> normaliza pra null, 'enabled' ainda respeitado", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-novos-enabled-badupdated-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(
      resolve(dir, "data", "clarice-novos-enabled.json"),
      JSON.stringify({ enabled: true, updatedAt: 12345 }),
      "utf8",
    );
    assert.deepEqual(readClariceNovosEnabledState(dir), { enabled: true, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });
});
