/**
 * test/continuo-pr-review-pr-numbers-scope-wrapper.test.ts (#7446 item 4)
 *
 * Executa `test/continuo-pr-review-pr-numbers-scope.test.sh` sob
 * `node --test`, pra rodar em CI de verdade — mesmo padrão de
 * `test/continuo-pr-review-gh-api-sha-6923-wrapper.test.ts` e vizinhos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "test/continuo-pr-review-pr-numbers-scope.test.sh");

describe("continuo-pr-review.sh — PR_NUMBERS cobre qualquer branch exceto bot/* (#7446 item 4)", () => {
  it("bash test/continuo-pr-review-pr-numbers-scope.test.sh sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      assert.fail(
        `continuo-pr-review-pr-numbers-scope.test.sh falhou — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`,
      );
    }
    assert.match(out, /TODOS OS TESTES PASSARAM/);
  });
});
