/**
 * test/continuo-pr-review-gh-api-sha-6923-wrapper.test.ts (#7129)
 *
 * Executa `test/continuo-pr-review-gh-api-sha-6923.test.sh` sob `node --test`,
 * pra rodar em CI de verdade — mesmo padrão de
 * `test/glm-lane-headref-guard.test.ts` +
 * `scripts/lib/glm-lane-headref-guard.test.sh`.
 *
 * O `.sh` já existia (#6923) mas ficava fora de `run-tests.ts`, que só
 * varre `*.test.ts` — nunca rodou em CI (#7129, achado do crítico de
 * cobertura da #7112). Este wrapper fecha o gap sem tocar no `.sh` original
 * (mesmo mecanismo de extração de fragmento real via `sed`/sourcing que os
 * outros `.test.sh` de continuo/hermes usam).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "test/continuo-pr-review-gh-api-sha-6923.test.sh");

describe("continuo-pr-review.sh — SHA/title vêm de gh api, não gh pr view morto (#6923)", () => {
  it("bash test/continuo-pr-review-gh-api-sha-6923.test.sh sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      assert.fail(
        `continuo-pr-review-gh-api-sha-6923.test.sh falhou (regressão do #6923?) — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`,
      );
    }
    assert.match(out, /TODOS OS TESTES PASSARAM/);
  });
});
