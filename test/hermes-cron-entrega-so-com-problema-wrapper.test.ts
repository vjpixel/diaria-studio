/**
 * test/hermes-cron-entrega-so-com-problema-wrapper.test.ts
 *
 * Executa `test/hermes-cron-entrega-so-com-problema.test.sh` sob `node
 * --test`, pra rodar em CI de verdade — `run-tests.ts` só varre `*.test.ts`
 * (mesmo padrão dos wrappers irmãos, #7129).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "test/hermes-cron-entrega-so-com-problema.test.sh");

describe("crons do Hermes — entrega no Telegram só quando há problema", () => {
  it("bash test/hermes-cron-entrega-so-com-problema.test.sh sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      assert.fail(
        `hermes-cron-entrega-so-com-problema.test.sh falhou — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`,
      );
    }
    assert.match(out, /TODOS OS TESTES PASSARAM/);
  });
});
