/**
 * test/clarice-envio-last-brake.test.ts (#5220)
 *
 * `scripts/lib/clarice-envio-last-brake.ts` — sidecar do último freio
 * conhecido, escrito por `clarice-envio-run.ts` (19:00) e lido pelo
 * fallback do guard das 05:00 (`clarice-envio-guard.ts`) quando os
 * pré-requisitos falham mesmo após retry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeLastBrakeSnapshot, readLastBrakeSnapshot } from "../scripts/lib/clarice-envio-last-brake.ts";
import type { BrakeDecision } from "../scripts/lib/clarice-envio-policy.ts";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "envio-last-brake-"));
}

describe("writeLastBrakeSnapshot / readLastBrakeSnapshot", () => {
  it("ausente => null, sem lançar, sem callback de aviso", () => {
    const root = freshRoot();
    let warned = false;
    const r = readLastBrakeSnapshot(root, "260811", () => { warned = true; });
    assert.equal(r, null);
    assert.equal(warned, false, "ausência é o caso normal (1ª rodada) — nunca avisa");
    rmSync(root, { recursive: true, force: true });
  });

  it("roundtrip: write então read devolve o mesmo freio, com reasons preservado", () => {
    const root = freshRoot();
    const brake: BrakeDecision = { level: "stop", reasons: ["hard bounce estourou"], maxUtil: 1.3 };
    writeLastBrakeSnapshot(root, "260811", brake, "2026-08-11T22:00:00.000Z");
    const r = readLastBrakeSnapshot(root, "260811");
    assert.deepEqual(r, { brake: "stop", reasons: ["hard bounce estourou"], recordedAt: "2026-08-11T22:00:00.000Z" });
    rmSync(root, { recursive: true, force: true });
  });

  it("nível 'ok' preservado corretamente (é o caminho que o fallback trata como fail-OPEN)", () => {
    const root = freshRoot();
    writeLastBrakeSnapshot(root, "260811", { level: "ok", reasons: ["saudável"], maxUtil: 0.1 }, "2026-08-11T22:00:00.000Z");
    const r = readLastBrakeSnapshot(root, "260811");
    assert.equal(r?.brake, "ok");
    rmSync(root, { recursive: true, force: true });
  });

  it("dias diferentes são independentes — ler o aammdd errado nunca vaza o freio de outro dia", () => {
    const root = freshRoot();
    writeLastBrakeSnapshot(root, "260811", { level: "stop", reasons: ["x"], maxUtil: 1.1 }, "2026-08-11T22:00:00.000Z");
    assert.equal(readLastBrakeSnapshot(root, "260812"), null);
    rmSync(root, { recursive: true, force: true });
  });

  it("JSON corrompido => null + callback de aviso (tratado como CORRUPÇÃO, não ausência)", () => {
    const root = freshRoot();
    const dir = resolve(root, "data", "clarice-subscribers", "envio-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "envio-260811-brake.json"), "{ nao e json valido", "utf8");
    let warned = false;
    const r = readLastBrakeSnapshot(root, "260811", () => { warned = true; });
    assert.equal(r, null);
    assert.equal(warned, true, "corrupção precisa avisar — diferente de ausência normal");
    rmSync(root, { recursive: true, force: true });
  });

  it("shape inesperado (JSON válido mas sem os campos certos) => null + aviso, fail-closed", () => {
    const root = freshRoot();
    const dir = resolve(root, "data", "clarice-subscribers", "envio-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "envio-260811-brake.json"), JSON.stringify({ something: "else" }), "utf8");
    let warned = false;
    const r = readLastBrakeSnapshot(root, "260811", () => { warned = true; });
    assert.equal(r, null);
    assert.equal(warned, true);
    rmSync(root, { recursive: true, force: true });
  });

  it("path gravado espelha o relatório markdown do mesmo dia (envio-{aammdd}-brake.json)", () => {
    const root = freshRoot();
    writeLastBrakeSnapshot(root, "260811", { level: "hold", reasons: ["x"], maxUtil: 0.9 }, "2026-08-11T22:00:00.000Z");
    const p = resolve(root, "data", "clarice-subscribers", "envio-reports", "envio-260811-brake.json");
    const raw = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(raw.brake, "hold");
    rmSync(root, { recursive: true, force: true });
  });
});
