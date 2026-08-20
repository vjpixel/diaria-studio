/**
 * test/shutdown-with-timeout.test.ts (#5737)
 *
 * Cobre a causa raiz do processo zumbi do Studio server: se a função de
 * fechamento (`server.close()`) nunca resolve, o processo precisa sair
 * forçado mesmo assim — senão `Restart=always` do systemd nunca dispara
 * (só reage a saída real do PID) e o serviço fica "vivo" sem escutar a
 * porta.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  shutdownWithTimeout,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from "../scripts/lib/shutdown-with-timeout.ts";

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolveWait();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        rejectWait(new Error("waitFor timed out"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe("shutdownWithTimeout", () => {
  it("chama exit(0) quando closeFn resolve normalmente", async () => {
    const exit = mock.fn();
    let resolveClose: () => void = () => {};
    const closeFn = () => new Promise<void>((r) => (resolveClose = r));

    shutdownWithTimeout(closeFn, { timeoutMs: 1000, exit });
    assert.equal(exit.mock.calls.length, 0);

    resolveClose();
    await waitFor(() => exit.mock.calls.length === 1);
    assert.equal(exit.mock.calls[0].arguments[0], 0);
  });

  it("força exit(1) via timeout quando closeFn NUNCA resolve (o bug real do #5737)", async () => {
    const exit = mock.fn();
    const onTimeout = mock.fn();
    // closeFn que nunca resolve — simula server.close() pendurado numa
    // conexão SSE/keep-alive aberta.
    const closeFn = () => new Promise<void>(() => {});

    shutdownWithTimeout(closeFn, { timeoutMs: 20, exit, onTimeout });

    await waitFor(() => exit.mock.calls.length === 1);
    assert.equal(exit.mock.calls[0].arguments[0], 1);
    assert.equal(onTimeout.mock.calls.length, 1);
  });

  it("chama exit(0) mesmo se closeFn rejeitar (dentro do timeout)", async () => {
    const exit = mock.fn();
    const closeFn = () => Promise.reject(new Error("close falhou"));

    shutdownWithTimeout(closeFn, { timeoutMs: 1000, exit });
    await waitFor(() => exit.mock.calls.length === 1);
    assert.equal(exit.mock.calls[0].arguments[0], 0);
  });

  it("nunca chama exit duas vezes (closeFn resolve exatamente no limiar do timeout)", async () => {
    const exit = mock.fn();
    let resolveClose: () => void = () => {};
    const closeFn = () => new Promise<void>((r) => (resolveClose = r));

    shutdownWithTimeout(closeFn, { timeoutMs: 15, exit });
    // resolve logo depois do timeout já ter dado — settled já deve ter
    // travado no caminho do timeout, então esta resolução deve ser um no-op.
    await waitFor(() => exit.mock.calls.length === 1);
    resolveClose();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(exit.mock.calls.length, 1);
  });

  it("default de timeout é 10s", () => {
    assert.equal(DEFAULT_SHUTDOWN_TIMEOUT_MS, 10_000);
  });
});
