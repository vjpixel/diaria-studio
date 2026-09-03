/**
 * test/continuo-pr-review-merge-lock-6934-wrapper.test.ts (#7129)
 *
 * Executa `test/continuo-pr-review-merge-lock-6934.test.sh` sob
 * `node --test`, pra rodar em CI de verdade — mesmo padrão de
 * `test/glm-lane-headref-guard.test.ts` +
 * `scripts/lib/glm-lane-headref-guard.test.sh`.
 *
 * O `.sh` já existia (#6934) mas ficava fora de `run-tests.ts`, que só
 * varre `*.test.ts` — nunca rodou em CI (#7129, achado do crítico de
 * cobertura da #7112). Cobre as 5 propriedades do merge-lock cross-sessão
 * de `try_merge_gate()` (aquisição antes do merge, liberação após pull,
 * liberação em falha de merge, retry limitado em negação, e erro genuíno
 * vs. negação tratados igual).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "test/continuo-pr-review-merge-lock-6934.test.sh");

describe("continuo-pr-review.sh — merge-lock cross-sessão em try_merge_gate() (#6934)", () => {
  it("bash test/continuo-pr-review-merge-lock-6934.test.sh sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      assert.fail(
        `continuo-pr-review-merge-lock-6934.test.sh falhou (regressão do #6934?) — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`,
      );
    }
    assert.match(out, /TODOS OS TESTES PASSARAM/);
  });
});
