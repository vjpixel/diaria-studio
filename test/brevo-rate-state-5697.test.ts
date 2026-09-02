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
  warnIfCampaignQuotaLow,
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

describe("warnIfCampaignQuotaLow (#6458) — best-effort, NUNCA bloqueante, pro caminho de ESCRITA", () => {
  let originalConsoleError: typeof console.error;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("sem estado gravado ainda => nunca avisa (não há base pra avisar sobre cota nunca medida)", () => {
    assert.doesNotThrow(() => warnIfCampaignQuotaLow(30, statePath));
    assert.equal(logged.length, 0);
  });

  it("estado ACIMA da reserva => nunca avisa", () => {
    recordCampaignQuotaRemaining(50, 100, statePath);
    warnIfCampaignQuotaLow(30, statePath);
    assert.equal(logged.length, 0);
  });

  it("estado ABAIXO da reserva => avisa via console.error, NUNCA lança (diferente de assertCampaignQuotaHeadroom)", () => {
    recordCampaignQuotaRemaining(5, 100, statePath);
    assert.doesNotThrow(() => warnIfCampaignQuotaLow(30, statePath));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /remaining=5/);
    assert.match(logged[0], /reserva 30/);
    assert.match(logged[0], /#6458/);
  });

  it("estado EXATAMENTE na reserva => não avisa (mesma semântica de `<`, não `<=`, do assert)", () => {
    recordCampaignQuotaRemaining(30, 100, statePath);
    warnIfCampaignQuotaLow(30, statePath);
    assert.equal(logged.length, 0);
  });

  it("default minRemaining é 30 quando omitido (mesmo default de assertCampaignQuotaHeadroom)", () => {
    recordCampaignQuotaRemaining(10, 100, statePath);
    warnIfCampaignQuotaLow(undefined, statePath);
    assert.equal(logged.length, 1);
  });

  it("cota BEM abaixo da reserva não bloqueia o call site — a chamada real seguiria normalmente", () => {
    recordCampaignQuotaRemaining(0, 100, statePath);
    let reachedAfter = false;
    warnIfCampaignQuotaLow(30, statePath);
    reachedAfter = true;
    assert.equal(reachedAfter, true);
  });
});
