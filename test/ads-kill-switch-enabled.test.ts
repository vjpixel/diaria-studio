/**
 * test/ads-kill-switch-enabled.test.ts (#5239)
 *
 * Cobre `scripts/lib/ads-kill-switch-enabled.ts` — o toggle "pausa
 * automática ligada/desligada" do kill switch por custo. Mesmo molde de
 * test/clarice-novos-enabled.test.ts (#4941): default seguro `enabled:
 * false` de arquivo ausente/corrompido, fail-soft na leitura, fail-hard na
 * escrita.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readAdsKillSwitchEnabledState,
  isAdsKillSwitchEnabled,
  setAdsKillSwitchEnabled,
} from "../scripts/lib/ads-kill-switch-enabled.ts";

describe("readAdsKillSwitchEnabledState / isAdsKillSwitchEnabled / setAdsKillSwitchEnabled (#5239)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "ads-kill-switch-enabled-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sem data/ads-kill-switch-enabled.json -> default {enabled:false, updatedAt:null} (lado seguro)", () => {
    const state = readAdsKillSwitchEnabledState(root);
    assert.deepEqual(state, { enabled: false, updatedAt: null });
    assert.equal(isAdsKillSwitchEnabled(root), false);
  });

  it("setAdsKillSwitchEnabled(true) persiste e readAdsKillSwitchEnabledState reflete", () => {
    const written = setAdsKillSwitchEnabled(root, true, { now: () => new Date("2026-09-01T20:00:00.000Z") });
    assert.equal(written.enabled, true);
    assert.equal(written.updatedAt, "2026-09-01T20:00:00.000Z");

    const read = readAdsKillSwitchEnabledState(root);
    assert.deepEqual(read, { enabled: true, updatedAt: "2026-09-01T20:00:00.000Z" });
    assert.equal(isAdsKillSwitchEnabled(root), true);
  });

  it("setAdsKillSwitchEnabled(false) desliga de novo e atualiza updatedAt", () => {
    const written = setAdsKillSwitchEnabled(root, false, { now: () => new Date("2026-09-02T09:00:00.000Z") });
    assert.equal(written.enabled, false);
    assert.equal(written.updatedAt, "2026-09-02T09:00:00.000Z");
    assert.equal(isAdsKillSwitchEnabled(root), false);
  });

  it("nunca sobrescreve/reaproveita nenhum outro arquivo sob data/ — path é dedicado", () => {
    const other = resolve(root, "data", "outro-estado-qualquer.json");
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(other, JSON.stringify({ hello: "world" }), "utf8");
    setAdsKillSwitchEnabled(root, true);
    assert.equal(JSON.parse(readFileSync(other, "utf8")).hello, "world");
    assert.equal(readAdsKillSwitchEnabledState(root).enabled, true);
    // devolve o estado ao default seguro pros testes seguintes desta suite
    setAdsKillSwitchEnabled(root, false);
  });

  it("JSON corrompido -> default fail-soft {enabled:false, updatedAt:null}, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "ads-kill-switch-enabled-corrupt-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(resolve(dir, "data", "ads-kill-switch-enabled.json"), "{ isso não é json", "utf8");
    assert.deepEqual(readAdsKillSwitchEnabledState(dir), { enabled: false, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("shape com 'enabled' de tipo errado -> default fail-soft, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "ads-kill-switch-enabled-badtype-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(resolve(dir, "data", "ads-kill-switch-enabled.json"), JSON.stringify({ enabled: "sim" }), "utf8");
    assert.deepEqual(readAdsKillSwitchEnabledState(dir), { enabled: false, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("'updatedAt' de tipo errado no arquivo -> normaliza pra null, 'enabled' ainda respeitado", () => {
    const dir = mkdtempSync(join(tmpdir(), "ads-kill-switch-enabled-badupdated-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(
      resolve(dir, "data", "ads-kill-switch-enabled.json"),
      JSON.stringify({ enabled: true, updatedAt: 12345 }),
      "utf8",
    );
    assert.deepEqual(readAdsKillSwitchEnabledState(dir), { enabled: true, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });
});
