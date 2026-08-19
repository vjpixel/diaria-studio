/**
 * test/brevo-rate-state-5697.test.ts (#5697)
 *
 * Cobertura da reserva de cota:
 *  - writeCampaignQuotaState/readCampaignQuotaState: round-trip via arquivo
 *    (path injetável — nunca toca `data/brevo-rate-state.json` real).
 *  - recordCampaignQuotaRemaining: grava remaining/limit/updatedAt.
 *  - assertQuotaHeadroom (puro, sem I/O): decide recusar/permitir a partir
 *    de um state já lido.
 *  - assertCampaignQuotaHeadroom (com I/O): mesmo comportamento fim-a-fim
 *    via arquivo real (tmp dir).
 *  - readCampaignQuotaState: fail-soft em arquivo ausente/corrompido/shape
 *    inesperado.
 *
 * Regressão de não-regressão (#633) pro item 1 do critério de aceitação:
 * "um sweep de diagnóstico não consegue levar remaining abaixo da reserva" —
 * replicada como "assertCampaignQuotaHeadroom lança ANTES do sweep quando o
 * estado observado já está abaixo da reserva", que é o mecanismo que produz
 * essa garantia (o consumidor read-only nunca chega a fazer a 1ª chamada do
 * sweep se a reserva já foi violada).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCampaignQuotaState,
  readCampaignQuotaState,
  recordCampaignQuotaRemaining,
  assertQuotaHeadroom,
  assertCampaignQuotaHeadroom,
  BrevoCampaignQuotaLowError,
  type BrevoCampaignQuotaState,
} from "../scripts/lib/brevo-rate-state.ts";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brevo-rate-state-"));
  statePath = join(dir, "brevo-rate-state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeCampaignQuotaState / readCampaignQuotaState (#5697)", () => {
  it("round-trip: grava e lê o mesmo estado", () => {
    const state: BrevoCampaignQuotaState = { remaining: 42, limit: 100, updatedAt: "2026-08-19T12:00:00.000Z" };
    writeCampaignQuotaState(state, statePath);
    assert.deepEqual(readCampaignQuotaState(statePath), state);
  });

  it("readCampaignQuotaState: arquivo ausente => null (fail-soft)", () => {
    assert.equal(readCampaignQuotaState(join(dir, "nao-existe.json")), null);
  });

  it("readCampaignQuotaState: JSON corrompido => null (fail-soft, não lança)", () => {
    writeFileSync(statePath, "{ isto não é json válido");
    assert.equal(readCampaignQuotaState(statePath), null);
  });

  it("readCampaignQuotaState: shape inesperado (sem `remaining` numérico) => null", () => {
    writeFileSync(statePath, JSON.stringify({ remaining: "quarenta e dois", updatedAt: "x" }));
    assert.equal(readCampaignQuotaState(statePath), null);
  });

  it("writeCampaignQuotaState: diretório ausente é criado (mkdirSync recursive)", () => {
    const nested = join(dir, "sub1", "sub2", "state.json");
    writeCampaignQuotaState({ remaining: 5, updatedAt: "2026-08-19T00:00:00.000Z" }, nested);
    assert.equal(readCampaignQuotaState(nested)?.remaining, 5);
  });
});

describe("recordCampaignQuotaRemaining (#5697)", () => {
  it("grava remaining + limit + updatedAt (ISO, gerado no momento da chamada)", () => {
    const before = Date.now();
    recordCampaignQuotaRemaining(17, 100, statePath);
    const state = readCampaignQuotaState(statePath);
    assert.ok(state);
    assert.equal(state!.remaining, 17);
    assert.equal(state!.limit, 100);
    assert.ok(Date.parse(state!.updatedAt) >= before);
  });

  it("limit omitido não é gravado como campo presente-mas-undefined quebrando JSON.stringify", () => {
    recordCampaignQuotaRemaining(17, undefined, statePath);
    const state = readCampaignQuotaState(statePath);
    assert.equal(state!.remaining, 17);
    assert.equal(state!.limit, undefined);
  });
});

describe("assertQuotaHeadroom (puro, sem I/O) (#5697)", () => {
  it("state null (nunca observado) => nunca recusa", () => {
    assert.doesNotThrow(() => assertQuotaHeadroom(null, 30));
  });

  it("remaining >= reserva => não recusa", () => {
    assert.doesNotThrow(() =>
      assertQuotaHeadroom({ remaining: 30, updatedAt: "x" }, 30),
    );
    assert.doesNotThrow(() =>
      assertQuotaHeadroom({ remaining: 99, updatedAt: "x" }, 30),
    );
  });

  it("remaining < reserva => lança BrevoCampaignQuotaLowError com os valores certos", () => {
    assert.throws(
      () => assertQuotaHeadroom({ remaining: 12, updatedAt: "x" }, 30),
      (err: unknown) => {
        assert.ok(err instanceof BrevoCampaignQuotaLowError);
        assert.equal(err.remaining, 12);
        assert.equal(err.minRemaining, 30);
        assert.match(err.message, /remaining=12/);
        assert.match(err.message, /reserva/);
        return true;
      },
    );
  });
});

describe("assertCampaignQuotaHeadroom (I/O via arquivo) (#5697)", () => {
  it("sem estado gravado ainda => não recusa (1ª chamada do processo/dia)", () => {
    assert.doesNotThrow(() => assertCampaignQuotaHeadroom(30, statePath));
  });

  it("estado gravado ACIMA da reserva => sweep prossegue", () => {
    recordCampaignQuotaRemaining(50, 100, statePath);
    assert.doesNotThrow(() => assertCampaignQuotaHeadroom(30, statePath));
  });

  it("estado gravado ABAIXO da reserva => recusa ANTES do sweep começar (critério de aceitação #1)", () => {
    recordCampaignQuotaRemaining(5, 100, statePath);
    assert.throws(() => assertCampaignQuotaHeadroom(30, statePath), BrevoCampaignQuotaLowError);
  });

  it("default minRemaining é 30 (sugestão da issue #5697) quando omitido", () => {
    recordCampaignQuotaRemaining(29, 100, statePath);
    assert.throws(() => assertCampaignQuotaHeadroom(undefined, statePath), BrevoCampaignQuotaLowError);
    recordCampaignQuotaRemaining(30, 100, statePath);
    assert.doesNotThrow(() => assertCampaignQuotaHeadroom(undefined, statePath));
  });
});
