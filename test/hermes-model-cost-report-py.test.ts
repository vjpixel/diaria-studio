/**
 * test/hermes-model-cost-report-py.test.ts (#6963)
 *
 * Executa `hermes/scripts/hermes-model-cost-report.test.py` sob `node --test`,
 * pra que ele rode em CI de verdade — mesmo padrão de
 * `test/claude-openrouter-symlink-preflight.test.ts` +
 * `hermes/scripts/claude-openrouter-symlink-preflight.test.sh` (#6943) e de
 * `test/glm-lane-headref-guard.test.ts` (#6954).
 *
 * **Por que este wrapper precisou existir (achado ao vivo, #6963):** o
 * runner (`scripts/run-tests.ts`, via `npm test`) varre `test/**` com
 * `node --test` — ele NÃO executa `.test.py`. Nenhum workflow em
 * `.github/workflows/` menciona `hermes/` ou `python3`. Ou seja: TODOS os
 * `.test.py` de `hermes/scripts/` (`monitor-cron-model-rotation.test.py`,
 * `pause-cron-on-ratelimit.test.py`, este) rodavam apenas se alguém os
 * invocasse à mão.
 *
 * E isso interage mal com um gate: `hasNewOrModifiedTest`
 * (`scripts/check-pr-bugfix.ts`, travado por `test/check-pr-bugfix.test.ts`)
 * ACEITA um `.test.py` co-locado como prova de "PR de bugfix tem teste de
 * regressão" (#633/#6863). Sem um wrapper como este, a regra é satisfeita
 * por um arquivo que o CI nunca executa — o teste existe no diff e não
 * existe na verificação. Para a PR #6966 isso seria especialmente irônico:
 * o bug corrigido lá é um detector que nunca podia disparar, e sua
 * regressão nunca rodaria.
 *
 * Escopo deste arquivo: só o `hermes-model-cost-report.test.py`. Os outros
 * dois `.test.py` continuam sem wrapper — registrado em issue própria em
 * vez de ampliado aqui, pra esta PR não crescer além do #6963.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "hermes/scripts/hermes-model-cost-report.test.py");

describe("hermes-model-cost-report.test.py roda em CI (#6963)", () => {
  it("python3 hermes/scripts/hermes-model-cost-report.test.py sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("python3", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      assert.fail(
        `hermes-model-cost-report.test.py falhou — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`,
      );
    }
    assert.match(out, /TODOS OS TESTES PASSARAM/);
  });
});
