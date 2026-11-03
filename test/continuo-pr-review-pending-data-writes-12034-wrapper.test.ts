/**
 * test/continuo-pr-review-pending-data-writes-12034-wrapper.test.ts (#12034)
 *
 * Executa `test/continuo-pr-review-pending-data-writes-12034.test.sh` sob
 * `node --test`, pra rodar em CI (mesmo padrão dos wrappers do #7129): o
 * `run-tests.ts` só varre `*.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** #11243: pulado só no Windows (Neo); no CI Linux e no `300` roda normal. */
const SKIP_WIN32 = process.platform === "win32" && "#11243: executa script bash do continuo/hermes, que só roda no 300 (Linux)";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "test/continuo-pr-review-pending-data-writes-12034.test.sh");

describe("continuo-pr-review.sh — escrita pendente em data/ após o merge (#12034)", { skip: SKIP_WIN32 }, () => {
  it("bash test/continuo-pr-review-pending-data-writes-12034.test.sh sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      assert.fail(`falhou (regressão do #12034?) — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`);
    }
    assert.match(out, /TODOS OS TESTES PASSARAM/);
  });
});
