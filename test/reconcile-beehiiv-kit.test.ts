/**
 * test/reconcile-beehiiv-kit.test.ts (#6311)
 *
 * Regressão pura pro CLI `scripts/reconcile-beehiiv-kit.ts` — sem rede, sem
 * dormir de verdade. Cobre os 2 achados do review consolidado:
 *
 * (a) `computeRetryWaitMs` — o backoff de 429 respeita `Retry-After` nas
 *     duas formas da RFC 7231 (segundos e data HTTP), nunca produz `NaN`
 *     (que fazia `setTimeout` disparar imediatamente antes do fix).
 * (b) `emitError` — `--json` emite JSON também no caminho de erro de
 *     config/rede (exit 2), nunca deixa stdout vazio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeRetryWaitMs, emitError } from "../scripts/reconcile-beehiiv-kit.ts";

describe("computeRetryWaitMs (#6311a)", () => {
  it("Retry-After em segundos, acima do piso de 30s — respeitado", () => {
    const headers = new Headers({ "Retry-After": "120" });
    assert.equal(computeRetryWaitMs(headers), 120_000);
  });

  it("Retry-After em segundos, abaixo do piso de 30s — piso aplicado", () => {
    const headers = new Headers({ "Retry-After": "5" });
    assert.equal(computeRetryWaitMs(headers), 30_000);
  });

  it("Retry-After em forma de DATA HTTP (RFC 7231) — nunca NaN, cai no default seguro de 60s", () => {
    // Antes do #6311: parseInt("Wed, 21 Oct 2026 07:28:00 GMT", 10) -> NaN,
    // Math.max(NaN * 1000, 30_000) -> NaN, setTimeout(fn, NaN) dispara
    // IMEDIATAMENTE — o backoff pretendido não acontecia. Este teste
    // reproduz exatamente essa forma de header.
    const headers = new Headers({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" });
    const waitMs = computeRetryWaitMs(headers);
    assert.equal(Number.isNaN(waitMs), false);
    assert.equal(waitMs, 60_000);
  });

  it("Retry-After ausente — default de 60s", () => {
    const headers = new Headers();
    assert.equal(computeRetryWaitMs(headers), 60_000);
  });

  it("Retry-After negativo (lixo) — nunca NaN, cai no default seguro de 60s", () => {
    const headers = new Headers({ "Retry-After": "-5" });
    const waitMs = computeRetryWaitMs(headers);
    assert.equal(Number.isNaN(waitMs), false);
    assert.equal(waitMs, 60_000);
  });
});

/** Captura tudo que `emitError` escreve em stdout/stderr sem tocar o
 *  descritor real — evita depender de redirecionamento de processo pra
 *  testar uma função que escreve direto em `process.stdout`/`process.stderr`. */
function captureEmitError(run: () => void): { stdout: string; stderr: string; exitCode: number | undefined } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  // @ts-expect-error -- monkey-patch só para captura em teste, assinatura completa não é necessária
  process.stdout.write = (chunk: string) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  // @ts-expect-error -- idem
  process.stderr.write = (chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  };
  try {
    run();
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: process.exitCode };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exitCode = origExitCode;
  }
}

describe("emitError (#6311b)", () => {
  it("--json presente: stdout NUNCA vazio, mesmo em erro de config", () => {
    const { stdout, exitCode } = captureEmitError(() =>
      emitError(true, "[reconcile-beehiiv-kit] config Beehiiv inválida — não foi possível medir: X", "config"),
    );
    assert.notEqual(stdout.trim(), "");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.error.code, "config");
    assert.equal(parsed.decision.exitCode, 2);
    assert.equal(exitCode, 2);
  });

  it("--json presente: erro de rede também emite JSON parseável", () => {
    const { stdout } = captureEmitError(() =>
      emitError(true, "[reconcile-beehiiv-kit] falha de rede/API — não foi possível medir: timeout", "network"),
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.error.code, "network");
  });

  it("--json ausente: stdout continua vazio (texto humano só em stderr, comportamento inalterado)", () => {
    const { stdout, stderr, exitCode } = captureEmitError(() =>
      emitError(false, "[reconcile-beehiiv-kit] config Kit inválida — não foi possível medir: Y", "config"),
    );
    assert.equal(stdout, "");
    assert.match(stderr, /config Kit inválida/);
    assert.equal(exitCode, 2);
  });
});
