/**
 * test/transient-step-retry.test.ts (#5220)
 *
 * Unit direto de `scripts/lib/transient-step-retry.ts` — o motor de retry
 * genérico extraído de `clarice-envio-run.ts` (#5058) pra reuso pelo guard
 * das 05:00 (#5220), independente dos dois chamadores (`clarice-envio-run.ts`
 * já cobre o comportamento via `test/clarice-envio-run.test.ts`, e
 * `clarice-envio-guard.ts` via `test/clarice-envio-guard.test.ts` — este
 * arquivo testa a função em isolamento, com um `makeAbort`/orçamento
 * arbitrários, pra travar o contrato genérico em si).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stepWithTransientRetry, type StepResultLike } from "../scripts/lib/transient-step-retry.ts";

class FakeAbort extends Error {}

function transientResult(retryAfterSecs: number | null): StepResultLike {
  return { code: 3, stdout: JSON.stringify({ transient: true, retryAfterSecs }), stderr: "rate limited" };
}

function okResult(payload: unknown): StepResultLike {
  return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
}

function parseJson<U>(stdout: string): U | undefined {
  try {
    return JSON.parse(stdout) as U;
  } catch {
    return undefined;
  }
}

describe("stepWithTransientRetry", () => {
  it("sucesso na 1ª tentativa => nem retenta nem dorme", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const r = await stepWithTransientRetry<{ ok: boolean }>({
      exec: () => { calls++; return okResult({ ok: true }); },
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      note: () => {},
      parseJson,
      label: "x",
      scriptRelPath: "x.ts",
      args: [],
      budget: { maxAttempts: 3, fallbackMs: 1000, capMs: 5000 },
      makeAbort: (m) => new FakeAbort(m),
    });
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
    assert.deepEqual(r.json, { ok: true });
  });

  it("1 falha transitória seguida de sucesso => retenta 1×, dorme exatamente retryAfterSecs*1000", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const r = await stepWithTransientRetry<{ ok: boolean }>({
      exec: () => { calls++; return calls === 1 ? transientResult(7) : okResult({ ok: true }); },
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      note: () => {},
      parseJson,
      label: "x",
      scriptRelPath: "x.ts",
      args: [],
      budget: { maxAttempts: 3, fallbackMs: 1000, capMs: 20_000 },
      makeAbort: (m) => new FakeAbort(m),
    });
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [7000]);
    assert.deepEqual(r.json, { ok: true });
  });

  it("retryAfterSecs ausente => usa fallbackMs do orçamento (não o de outro chamador)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await stepWithTransientRetry({
      exec: () => { calls++; return calls === 1 ? transientResult(null) : okResult({}); },
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      note: () => {},
      parseJson,
      label: "x",
      scriptRelPath: "x.ts",
      args: [],
      budget: { maxAttempts: 3, fallbackMs: 1234, capMs: 5000 },
      makeAbort: (m) => new FakeAbort(m),
    });
    assert.deepEqual(sleeps, [1234]);
  });

  it("retryAfterSecs excede o capMs do orçamento INJETADO => capped nesse valor, não em outro", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await stepWithTransientRetry({
      exec: () => { calls++; return calls === 1 ? transientResult(99999) : okResult({}); },
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      note: () => {},
      parseJson,
      label: "x",
      scriptRelPath: "x.ts",
      args: [],
      budget: { maxAttempts: 3, fallbackMs: 1000, capMs: 4242 },
      makeAbort: (m) => new FakeAbort(m),
    });
    assert.deepEqual(sleeps, [4242]);
  });

  it("falha transitória persiste até esgotar maxAttempts => lança makeAbort, nunca chama exec além do orçamento", async () => {
    let calls = 0;
    let sleepCalls = 0;
    await assert.rejects(
      () =>
        stepWithTransientRetry({
          exec: () => { calls++; return transientResult(0); },
          sleep: () => { sleepCalls++; return Promise.resolve(); },
          note: () => {},
          parseJson,
          label: "x",
          scriptRelPath: "x.ts",
          args: [],
          budget: { maxAttempts: 4, fallbackMs: 100, capMs: 200 },
          makeAbort: (m) => new FakeAbort(m),
        }),
      FakeAbort,
    );
    assert.equal(calls, 4, "exatamente maxAttempts tentativas, não mais");
    assert.equal(sleepCalls, 3, "espera ENTRE tentativas — 3 esperas pra 4 tentativas, nunca depois da última");
  });

  it("falha NÃO-transitória (exit code fora de okCodes e != transientExitCode) => lança na 1ª tentativa, sem retry nem sleep", async () => {
    let calls = 0;
    let sleepCalls = 0;
    await assert.rejects(
      () =>
        stepWithTransientRetry({
          exec: () => { calls++; return { code: 1, stdout: "", stderr: "erro de config" }; },
          sleep: () => { sleepCalls++; return Promise.resolve(); },
          note: () => {},
          parseJson,
          label: "x",
          scriptRelPath: "x.ts",
          args: [],
          budget: { maxAttempts: 3, fallbackMs: 100, capMs: 200 },
          makeAbort: (m) => new FakeAbort(m),
        }),
      FakeAbort,
    );
    assert.equal(calls, 1);
    assert.equal(sleepCalls, 0);
  });

  it("transientExitCode customizado no orçamento (não 3) => reconhece SÓ esse código como transitório", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const r = await stepWithTransientRetry<{ ok: boolean }>({
      exec: () => { calls++; return calls === 1 ? { code: 42, stdout: JSON.stringify({ transient: true, retryAfterSecs: 2 }), stderr: "x" } : okResult({ ok: true }); },
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      note: () => {},
      parseJson,
      label: "x",
      scriptRelPath: "x.ts",
      args: [],
      budget: { maxAttempts: 3, fallbackMs: 100, capMs: 5000, transientExitCode: 42 },
      makeAbort: (m) => new FakeAbort(m),
    });
    assert.equal(calls, 2, "código 42 reconhecido como transitório e retentado");
    assert.deepEqual(sleeps, [2000]);
    assert.deepEqual(r.json, { ok: true });
  });

  it("okCodes customizado (ex: [0,2]) aceita o código extra sem retry", async () => {
    let calls = 0;
    const r = await stepWithTransientRetry({
      exec: () => { calls++; return { code: 2, stdout: JSON.stringify({ blockers: true }), stderr: "" }; },
      sleep: () => Promise.resolve(),
      note: () => {},
      parseJson,
      label: "x",
      scriptRelPath: "x.ts",
      args: [],
      okCodes: [0, 2],
      budget: { maxAttempts: 3, fallbackMs: 100, capMs: 200 },
      makeAbort: (m) => new FakeAbort(m),
    });
    assert.equal(calls, 1);
    assert.deepEqual(r.json, { blockers: true });
  });
});
