/**
 * test/glm-lane-headref-guard.test.ts (#6954)
 *
 * Executa `scripts/lib/glm-lane-headref-guard.test.sh` sob `node --test`,
 * pra rodar em CI de verdade — mesmo padrão de
 * `test/claude-openrouter-symlink-preflight.test.ts` +
 * `hermes/scripts/claude-openrouter-symlink-preflight.test.sh`.
 *
 * O achado (P0 do review da PR #6955) é sobre o que a SUBSTITUIÇÃO produz
 * quando `headRefName` carrega sintaxe de `--allowedTools` (vírgula e
 * parênteses são caracteres VÁLIDOS num nome de branch git). O `.sh`
 * executa a substituição de verdade com um valor hostil e confirma tanto
 * que o cenário de ataque reproduz sem guard quanto que o guard o recusa
 * — regex estática sobre o código-fonte (o que os testes antigos faziam)
 * passaria com o bug presente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "scripts/lib/glm-lane-headref-guard.test.sh");

describe("dispatch-glm-lane-unit.sh — headRefName nunca é interpolado em --tools sem validação (#6954)", () => {
  it("bash scripts/lib/glm-lane-headref-guard.test.sh sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      assert.fail(
        `glm-lane-headref-guard.test.sh falhou (regressão do P0 de injeção em --tools?) — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`,
      );
    }
    assert.match(out, /todas as asserções passaram/);
  });
});
