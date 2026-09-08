/**
 * test/continuo-pr-review-reject-label-npx-stderr-leak-wrapper.test.ts (#7567)
 *
 * Executa `test/continuo-pr-review-reject-label-npx-stderr-leak.test.sh` sob
 * `node --test`, pra rodar em CI de verdade — `run-tests.ts` só varre
 * `*.test.ts`, então o `.sh` sozinho nunca rodaria (mesma classe de gap que
 * o #7129 fechou para `continuo-pr-review-gh-api-sha-6923.test.sh`, e que o
 * irmão `continuo-pr-review-escalate-label-npx-stderr-leak.test.sh` ainda
 * tem — fora do escopo desta PR, ver review de #7607). Mesmo padrão de
 * extração de fragmento real via `sed`/sourcing que os outros wrappers de
 * continuo/hermes usam.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "test/continuo-pr-review-reject-label-npx-stderr-leak.test.sh");

describe("continuo-pr-review.sh — label de reject não quebra com stderr do npx (#7567)", () => {
  it("bash test/continuo-pr-review-reject-label-npx-stderr-leak.test.sh sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      out = String(err.stdout ?? "") + String(err.stderr ?? "") + String(err.message ?? "");
      assert.fail(`script saiu com erro:\n${out}`);
    }
    assert.match(out, /TODOS OS TESTES PASSARAM/);
  });
});
