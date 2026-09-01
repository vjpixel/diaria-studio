/**
 * test/claude-openrouter-symlink-preflight.test.ts (#6943)
 *
 * Executa `hermes/scripts/claude-openrouter-symlink-preflight.test.sh`
 * (miolo real do teste — cria o symlink, o binário `claude` fake, invoca
 * através do symlink) sob `node --test`, pra rodar em CI de verdade — mesmo
 * padrão de `test/claude-openrouter-free-quota-marker.test.ts` +
 * `hermes/scripts/lib/free-quota-exhaustion.test.sh`.
 *
 * O bug do #6943 SÓ aparece invocando através de um symlink sem `lib/` ao
 * lado (o deploy real do `helios`) — testar o arquivo real direto nunca
 * reproduz, por isso a lógica de reprodução vive inteira no `.sh`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "hermes/scripts/claude-openrouter-symlink-preflight.test.sh");

describe("claude-openrouter.sh — source resolve através de symlink de deploy (#6943)", () => {
  it("bash hermes/scripts/claude-openrouter-symlink-preflight.test.sh sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      assert.fail(
        `claude-openrouter-symlink-preflight.test.sh falhou (regressão do #6943?) — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`,
      );
    }
    assert.match(out, /source através do symlink resolveu/);
  });
});
