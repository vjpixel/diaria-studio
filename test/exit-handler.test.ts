import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runMain, exitWithError } from "../scripts/lib/exit-handler.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Temporarily replaces process.exit with a mock that throws a special
 * sentinel error so we can assert the exit code without actually exiting.
 * Returns the captured exit code (or -1 if exit was never called).
 */
function withMockedExit(fn: () => unknown): Promise<number> {
  return new Promise<number>((resolve) => {
    const original = process.exit.bind(process);
    let capturedCode = -1;

    // Override process.exit
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (
      code?: number,
    ): never => {
      capturedCode = code ?? 0;
      // Restore before resolving so subsequent calls work normally
      process.exit = original;
      resolve(capturedCode);
      // Throw to unwind any pending async stack (caught by runMain's try/catch
      // or the test harness).  We use a special symbol so we can ignore it.
      throw Object.assign(new Error("__mock_exit__"), { __mockExit: true });
    };

    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => {
          process.exit = original;
          resolve(capturedCode);
        })
        .catch((e: unknown) => {
          process.exit = original;
          if (
            e instanceof Error &&
            (e as Error & { __mockExit?: boolean }).__mockExit
          ) {
            // Already resolved with exit code above
            return;
          }
          resolve(capturedCode);
        });
    }
  });
}

// ---------------------------------------------------------------------------
// runMain
// ---------------------------------------------------------------------------

describe("runMain", () => {
  it("executa função que resolve sem chamar process.exit", async () => {
    let called = false;
    const exitCode = await withMockedExit(async () => {
      await runMain(async () => {
        called = true;
      });
    });

    assert.equal(called, true);
    // exit was never called — capturedCode stays -1
    assert.equal(exitCode, -1);
  });

  it("chama process.exit(1) quando a função rejeita", async () => {
    const exitCode = await withMockedExit(() =>
      runMain(async () => {
        throw new Error("algo deu errado");
      }),
    );

    assert.equal(exitCode, 1);
  });

  it("loga a mensagem de erro no stderr quando rejeita", async () => {
    const savedExit = process.exit;
    // Suppress actual exit during stderr capture
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (
      _code?: number,
    ): never => {
      throw Object.assign(new Error("__mock_exit__"), { __mockExit: true });
    };

    let stderrOutput = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    };

    try {
      await runMain(async () => {
        throw new Error("mensagem de teste");
      });
    } catch (e: unknown) {
      if (!(e instanceof Error) || !(e as Error & { __mockExit?: boolean }).__mockExit) {
        throw e;
      }
    } finally {
      process.exit = savedExit;
      process.stderr.write = origWrite;
    }

    assert.ok(stderrOutput.includes("[error]"), `stderr deve conter '[error]', got: ${stderrOutput}`);
    assert.ok(
      stderrOutput.includes("mensagem de teste"),
      `stderr deve conter a mensagem de erro, got: ${stderrOutput}`,
    );
  });

  it("loga o stack trace quando disponível", async () => {
    const savedExit = process.exit;
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (
      _code?: number,
    ): never => {
      throw Object.assign(new Error("__mock_exit__"), { __mockExit: true });
    };

    let stderrOutput = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    };

    try {
      await runMain(async () => {
        throw new Error("com stack");
      });
    } catch (e: unknown) {
      if (!(e instanceof Error) || !(e as Error & { __mockExit?: boolean }).__mockExit) {
        throw e;
      }
    } finally {
      process.exit = savedExit;
      process.stderr.write = origWrite;
    }

    assert.ok(stderrOutput.includes("Error:"), `stderr deve incluir stack trace, got: ${stderrOutput}`);
  });

  it("trata rejeição com valor não-Error (string)", async () => {
    const savedExit = process.exit;
    let exitCode = -1;
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (
      code?: number,
    ): never => {
      exitCode = code ?? 0;
      process.exit = savedExit;
      throw Object.assign(new Error("__mock_exit__"), { __mockExit: true });
    };

    let stderrOutput = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    };

    try {
      await runMain(async () => {
        // Throwing a non-Error value
        throw "erro em string";
      });
    } catch (e: unknown) {
      if (!(e instanceof Error) || !(e as Error & { __mockExit?: boolean }).__mockExit) {
        throw e;
      }
    } finally {
      process.exit = savedExit;
      process.stderr.write = origWrite;
    }

    assert.equal(exitCode, 1);
    assert.ok(stderrOutput.includes("erro em string"), `stderr deve conter o valor, got: ${stderrOutput}`);
  });
});

// ---------------------------------------------------------------------------
// exitWithError
// ---------------------------------------------------------------------------

describe("exitWithError", () => {
  it("chama process.exit(1) por padrão", async () => {
    const exitCode = await withMockedExit(() => {
      try {
        exitWithError("algo errado");
      } catch (e: unknown) {
        if (!(e instanceof Error) || !(e as Error & { __mockExit?: boolean }).__mockExit) {
          throw e;
        }
      }
    });

    assert.equal(exitCode, 1);
  });

  it("usa o código de saída customizado quando fornecido", async () => {
    const exitCode = await withMockedExit(() => {
      try {
        exitWithError("arg inválido", 2);
      } catch (e: unknown) {
        if (!(e instanceof Error) || !(e as Error & { __mockExit?: boolean }).__mockExit) {
          throw e;
        }
      }
    });

    assert.equal(exitCode, 2);
  });

  it("escreve a mensagem no stderr com prefixo [error]", async () => {
    const savedExit = process.exit;
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (
      _code?: number,
    ): never => {
      process.exit = savedExit;
      throw Object.assign(new Error("__mock_exit__"), { __mockExit: true });
    };

    let stderrOutput = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    };

    try {
      exitWithError("mensagem de erro clara");
    } catch (e: unknown) {
      if (!(e instanceof Error) || !(e as Error & { __mockExit?: boolean }).__mockExit) {
        throw e;
      }
    } finally {
      process.exit = savedExit;
      process.stderr.write = origWrite;
    }

    assert.ok(stderrOutput.includes("[error]"), `stderr deve conter '[error]', got: ${stderrOutput}`);
    assert.ok(
      stderrOutput.includes("mensagem de erro clara"),
      `stderr deve conter a mensagem, got: ${stderrOutput}`,
    );
  });
});
