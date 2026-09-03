/**
 * test/rescue-continuo-orphaned-work.test.ts (#7340)
 *
 * Regressão: `rescueOrphanedWork` devolve `{ outcome: "rescued",
 * checkoutBackFailed: true }` quando o `git checkout master` pós-rescue
 * falha, mas o CLI (`main()`) só ramificava por `outcome` — todo "rescued"
 * saía exit 0, ignorando `checkoutBackFailed`. Isso deixava o checkout
 * compartilhado preso na branch de rescue sem que o Passo 0 do loop do
 * contínuo bloqueasse (achado #7340).
 *
 * `resolveRescuedExitCode` foi extraída de `main()` justamente para ser
 * testável sem spawnar `git`/`gh` de verdade.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRescuedExitCode } from "../scripts/rescue-continuo-orphaned-work.ts";

describe("resolveRescuedExitCode (#7340)", () => {
  it("sai 1 quando checkoutBackFailed é true — mesmo sem --push", () => {
    const result = resolveRescuedExitCode({
      outcome: "rescued",
      branch: "continuo/rescue-260903-abcd",
      message: "checkout de volta pra master falhou",
      checkoutBackFailed: true,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /CHECKOUT DE VOLTA PRA MASTER FALHOU/);
    assert.match(result.stderr ?? "", /continuo\/rescue-260903-abcd/);
  });

  it("sai 0 quando checkoutBackFailed é false (comportamento pré-existente preservado)", () => {
    const result = resolveRescuedExitCode({
      outcome: "rescued",
      branch: "continuo/rescue-260903-abcd",
      message: "rescue OK, checkout de volta pra master OK",
      checkoutBackFailed: false,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, undefined);
  });
});
