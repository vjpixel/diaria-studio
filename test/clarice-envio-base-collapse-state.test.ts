/**
 * test/clarice-envio-base-collapse-state.test.ts (#10209)
 *
 * Estado durável do colapso de base (`data/clarice-envio-base-collapse.json`),
 * registro de cortes por crédito (`data/clarice-envio-credit-caps.json`) e a
 * orientação de `--volume N` mínimo. Só fs local em diretório temporário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  clariceEnvioBaseCollapsePath,
  clariceEnvioCreditCapsPath,
  clearClariceEnvioBaseCollapse,
  describeBaseCollapseActions,
  minVolumeToClearCollapse,
  readClariceEnvioBaseCollapse,
  readClariceEnvioCreditCaps,
  recordClariceEnvioCreditCap,
  writeClariceEnvioBaseAck,
  writeClariceEnvioBaseCollapse,
  CLARICE_ENVIO_CREDIT_CAPS_KEEP,
  type ClariceEnvioBaseCollapseState,
} from "../scripts/lib/clarice-envio-halt.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "envio-collapse-"));
const STATE: ClariceEnvioBaseCollapseState = {
  detectedAt: "2026-10-13T22:00:00.000Z",
  reportId: "envio-261013-base-colapsada",
  baseVolume: 101,
  baseDay: "2026-10-13",
  peakVolume: 40_180,
  peakDay: "2026-10-10",
  fraction: 101 / 40_180,
};

describe("estado durável do colapso (#10209)", () => {
  it("ausente → não colapsado; gravado → lido; limpo → ausente", () => {
    const root = fresh();
    assert.deepEqual(readClariceEnvioBaseCollapse(root), { collapsed: false });
    writeClariceEnvioBaseCollapse(root, STATE);
    const r = readClariceEnvioBaseCollapse(root);
    assert.ok(r.collapsed && !r.invalid);
    assert.equal(r.state.peakVolume, 40_180);
    assert.equal(clearClariceEnvioBaseCollapse(root), true);
    assert.equal(clearClariceEnvioBaseCollapse(root), false);
    assert.deepEqual(readClariceEnvioBaseCollapse(root), { collapsed: false });
    rmSync(root, { recursive: true, force: true });
  });

  it("regravar preserva detectedAt (identidade estável do achado)", () => {
    const root = fresh();
    writeClariceEnvioBaseCollapse(root, STATE);
    writeClariceEnvioBaseCollapse(root, { ...STATE, detectedAt: "2026-10-14T22:00:00.000Z", reportId: "envio-261014-base-colapsada" });
    const r = readClariceEnvioBaseCollapse(root);
    assert.ok(r.collapsed && !r.invalid);
    assert.equal(r.state.detectedAt, STATE.detectedAt);
    assert.equal(r.state.reportId, "envio-261014-base-colapsada");
    rmSync(root, { recursive: true, force: true });
  });

  it("ilegível conta como colapso ATIVO (fail-safe)", () => {
    const root = fresh();
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(clariceEnvioBaseCollapsePath(root), "{lixo");
    const r = readClariceEnvioBaseCollapse(root);
    assert.equal(r.collapsed, true);
    assert.ok(r.collapsed && r.invalid);
    rmSync(root, { recursive: true, force: true });
  });

  it("--accept-base (aceite do editor) apaga o estado de colapso", () => {
    const root = fresh();
    writeClariceEnvioBaseCollapse(root, STATE);
    writeClariceEnvioBaseAck(root, "aceito a base", new Date("2026-10-14T12:00:00Z"));
    assert.equal(existsSync(clariceEnvioBaseCollapsePath(root)), false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("orientação de --volume N (#10209 item 2)", () => {
  it("N mínimo = teto de fração × pico", () => {
    assert.equal(minVolumeToClearCollapse(40_180, 0.25), 10_045);
    assert.equal(minVolumeToClearCollapse(3, 0.25), 1);
  });

  it("texto põe --accept-base primeiro e diz que --volume abaixo do limiar recolapsa", () => {
    const lines = describeBaseCollapseActions(40_180, 0.25);
    assert.match(lines[0], /--accept-base/);
    assert.match(lines[1], /N ≥ 10045/);
    assert.match(lines[1], /recolapsa/);
    assert.match(describeBaseCollapseActions(null, 0.25)[1], /abaixo de 25% do pico/);
  });
});

describe("registro de cortes por crédito (#10209 item 1)", () => {
  it("grava, substitui o mesmo dia e lê ordenado", () => {
    const root = fresh();
    assert.deepEqual(readClariceEnvioCreditCaps(root), []);
    recordClariceEnvioCreditCap(root, { day: "2026-10-07", volume: 6_000 });
    recordClariceEnvioCreditCap(root, { day: "2026-10-06", volume: 5_000 });
    recordClariceEnvioCreditCap(root, { day: "2026-10-07", volume: 6_500 });
    assert.deepEqual(
      readClariceEnvioCreditCaps(root).map((c) => [c.day, c.volume]),
      [["2026-10-06", 5_000], ["2026-10-07", 6_500]],
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("mantém só os últimos N registros", () => {
    const root = fresh();
    for (let i = 1; i <= CLARICE_ENVIO_CREDIT_CAPS_KEEP + 5; i++) {
      const d = new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10);
      recordClariceEnvioCreditCap(root, { day: d, volume: i });
    }
    const caps = readClariceEnvioCreditCaps(root);
    assert.equal(caps.length, CLARICE_ENVIO_CREDIT_CAPS_KEEP);
    assert.equal(caps[caps.length - 1].volume, CLARICE_ENVIO_CREDIT_CAPS_KEEP + 5);
    rmSync(root, { recursive: true, force: true });
  });

  it("ilegível → [] (guard de colapso fica mais estrito, lado seguro)", () => {
    const root = fresh();
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(clariceEnvioCreditCapsPath(root), "nao-e-json");
    assert.deepEqual(readClariceEnvioCreditCaps(root), []);
    rmSync(root, { recursive: true, force: true });
  });
});
