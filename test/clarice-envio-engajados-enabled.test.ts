/**
 * test/clarice-envio-engajados-enabled.test.ts (#6945)
 *
 * Cobre `scripts/lib/clarice-envio-engajados-enabled.ts` — o kill switch da
 * task `Diaria-Clarice-Envio-Engajados`. Mesmo molde de
 * test/clarice-novos-enabled.test.ts, mesmo default (arquivo ausente ->
 * `enabled: false`, lado seguro) — automação NOVA, dispara e-mail real.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readClariceEngajadosEnabledState,
  isClariceEngajadosEnabled,
  setClariceEngajadosEnabled,
} from "../scripts/lib/clarice-envio-engajados-enabled.ts";

describe("readClariceEngajadosEnabledState / isClariceEngajadosEnabled / setClariceEngajadosEnabled (#6945)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "clarice-envio-engajados-enabled-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sem data/clarice-engajados-enabled.json -> default {enabled:false, updatedAt:null} (lado seguro)", () => {
    const state = readClariceEngajadosEnabledState(root);
    assert.deepEqual(state, { enabled: false, updatedAt: null });
    assert.equal(isClariceEngajadosEnabled(root), false);
  });

  it("setClariceEngajadosEnabled(true) persiste e readClariceEngajadosEnabledState reflete", () => {
    const written = setClariceEngajadosEnabled(root, true, { now: () => new Date("2026-09-02T20:00:00.000Z") });
    assert.equal(written.enabled, true);
    assert.equal(written.updatedAt, "2026-09-02T20:00:00.000Z");

    const read = readClariceEngajadosEnabledState(root);
    assert.deepEqual(read, { enabled: true, updatedAt: "2026-09-02T20:00:00.000Z" });
    assert.equal(isClariceEngajadosEnabled(root), true);
  });

  it("setClariceEngajadosEnabled(false) pausa de novo", () => {
    const written = setClariceEngajadosEnabled(root, false, { now: () => new Date("2026-09-03T09:00:00.000Z") });
    assert.equal(written.enabled, false);
    assert.equal(isClariceEngajadosEnabled(root), false);
  });

  it("nunca sobrescreve/reaproveita nenhum outro arquivo sob data/ — path é dedicado", () => {
    const other = resolve(root, "data", "outro-estado-qualquer.json");
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(other, JSON.stringify({ hello: "world" }), "utf8");
    setClariceEngajadosEnabled(root, true);
    assert.equal(JSON.parse(readFileSync(other, "utf8")).hello, "world");
    setClariceEngajadosEnabled(root, false);
  });

  it("JSON corrompido -> default fail-soft, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-envio-engajados-enabled-corrupt-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(resolve(dir, "data", "clarice-engajados-enabled.json"), "{ nao e json", "utf8");
    assert.deepEqual(readClariceEngajadosEnabledState(dir), { enabled: false, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("shape com 'enabled' de tipo errado -> default fail-soft", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-envio-engajados-enabled-badtype-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(resolve(dir, "data", "clarice-engajados-enabled.json"), JSON.stringify({ enabled: "sim" }), "utf8");
    assert.deepEqual(readClariceEngajadosEnabledState(dir), { enabled: false, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });
});
