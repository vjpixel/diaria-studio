/**
 * test/continuo-pr-review-base-refresh-13641-wrapper.test.ts (#13641)
 *
 * Executa `test/continuo-pr-review-base-refresh-13641.test.sh` sob
 * `node --test` (o `run-tests.ts` só varre `*.test.ts`, #7129). Cobre o
 * update-branch imediato de `try_merge_gate()` quando a PR aprovada e verde é
 * recusada porque a base andou (#13470): chamado preso ao HEAD revisado,
 * depois de soltar o lock, nunca nos casos fail-closed de leitura ilegível,
 * falha sem abortar o tick, e `--repo` nas PRs do diaria-design.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** #11243: pulado só no Windows (Neo); no CI Linux e no `300` roda normal. */
const SKIP_WIN32 = process.platform === "win32" && "#11243: executa script bash do continuo/hermes, que só roda no 300 (Linux); no Git Bash do Windows symlink, chmod e jq não se comportam igual";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "test/continuo-pr-review-base-refresh-13641.test.sh");

describe("continuo-pr-review.sh — traz a base pra branch na recusa por base velha (#13641)", { skip: SKIP_WIN32 }, () => {
  it("bash test/continuo-pr-review-base-refresh-13641.test.sh sai com exit 0", () => {
    let out = "";
    try {
      out = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      assert.fail(
        `continuo-pr-review-base-refresh-13641.test.sh falhou (regressão do #13641?) — stdout: ${err.stdout ?? ""} stderr: ${err.stderr ?? err.message ?? ""}`,
      );
    }
    assert.match(out, /TODOS OS TESTES PASSARAM/);
  });
});
