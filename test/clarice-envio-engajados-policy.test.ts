/**
 * test/clarice-envio-engajados-policy.test.ts (#6945)
 *
 * Cobre `scripts/lib/clarice-envio-engajados-policy.ts` — motor PURO de
 * volume da automação `engajados`. Sem I/O, sem `new Date()` interno.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  proposeEngajadosVolume,
  ENGAJADOS_BOOTSTRAP_VOLUME,
  ENGAJADOS_MAX_DAILY_VOLUME,
  ENGAJADOS_DAILY_GROWTH_STEP,
} from "../scripts/lib/clarice-envio-engajados-policy.ts";

describe("proposeEngajadosVolume (#6945)", () => {
  it("sem histórico (null) -> bootstrap × (1 + step)", () => {
    const expected = Math.round(ENGAJADOS_BOOTSTRAP_VOLUME * (1 + ENGAJADOS_DAILY_GROWTH_STEP));
    assert.equal(proposeEngajadosVolume(null), expected);
  });

  it("undefined tratado igual a null (bootstrap)", () => {
    assert.equal(proposeEngajadosVolume(undefined), proposeEngajadosVolume(null));
  });

  it("base válida cresce exatamente ENGAJADOS_DAILY_GROWTH_STEP (10%)", () => {
    assert.equal(proposeEngajadosVolume(2000), Math.round(2000 * 1.1));
    assert.equal(proposeEngajadosVolume(1000), 1100);
  });

  it("nunca excede ENGAJADOS_MAX_DAILY_VOLUME (teto absoluto)", () => {
    assert.equal(proposeEngajadosVolume(ENGAJADOS_MAX_DAILY_VOLUME), ENGAJADOS_MAX_DAILY_VOLUME);
    assert.equal(proposeEngajadosVolume(ENGAJADOS_MAX_DAILY_VOLUME * 10), ENGAJADOS_MAX_DAILY_VOLUME);
  });

  it("base 0/negativa/não-finita -> trata como sem histórico (bootstrap), nunca escala sobre dado inválido", () => {
    const bootstrapResult = proposeEngajadosVolume(null);
    assert.equal(proposeEngajadosVolume(0), bootstrapResult);
    assert.equal(proposeEngajadosVolume(-500), bootstrapResult);
    assert.equal(proposeEngajadosVolume(NaN), bootstrapResult);
    assert.equal(proposeEngajadosVolume(Infinity), bootstrapResult);
  });

  it("base fracionária é truncada (Math.floor) antes de escalar", () => {
    assert.equal(proposeEngajadosVolume(1000.9), Math.round(1000 * 1.1));
  });

  it("nunca devolve não-finito nem negativo pra nenhuma entrada testada", () => {
    for (const v of [null, undefined, 0, -1, NaN, Infinity, 1, 100000]) {
      const r = proposeEngajadosVolume(v as number | null | undefined);
      assert.ok(Number.isFinite(r) && r >= 0, `entrada ${v} produziu ${r}`);
    }
  });

  it("escalada composta ao longo de N dias converge pro teto sem ultrapassá-lo", () => {
    let volume: number | null = null;
    for (let day = 0; day < 60; day++) {
      volume = proposeEngajadosVolume(volume);
      assert.ok(volume <= ENGAJADOS_MAX_DAILY_VOLUME, `dia ${day}: volume ${volume} excedeu o teto`);
    }
    assert.equal(volume, ENGAJADOS_MAX_DAILY_VOLUME);
  });
});
