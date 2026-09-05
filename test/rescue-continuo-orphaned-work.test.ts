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

/**
 * selectExistingOpenRescuePr (#7446 item 5)
 *
 * Reprodução do achado 04-05/09/2026: 3 PRs `continuo/rescue-*` abertas
 * simultaneamente (#7404, #7444, #7445) porque nada checava se já existia
 * uma antes de abrir a próxima.
 */
import { selectExistingOpenRescuePr } from "../scripts/rescue-continuo-orphaned-work.ts";

describe("selectExistingOpenRescuePr (#7446 item 5)", () => {
  it("nenhuma PR de rescue aberta → null", () => {
    assert.equal(
      selectExistingOpenRescuePr([{ number: 7403, headRefName: "chore/desliga-rampa-gmail-stage0" }]),
      null,
    );
  });

  it("lista vazia → null", () => {
    assert.equal(selectExistingOpenRescuePr([]), null);
  });

  it("1 PR de rescue aberta → ela mesma", () => {
    const pr = { number: 7404, headRefName: "continuo/rescue-20260904T040307Z-2689057-34a8" };
    assert.deepEqual(selectExistingOpenRescuePr([pr]), pr);
  });

  it("múltiplas PRs de rescue abertas (reprodução #7404/#7444/#7445) → a mais recente (maior number)", () => {
    const prs = [
      { number: 7404, headRefName: "continuo/rescue-20260904T040307Z-2689057-34a8" },
      { number: 7444, headRefName: "continuo/rescue-20260904T221027Z-3654350-3c8d" },
      { number: 7445, headRefName: "continuo/rescue-20260905T002026Z-3688824-3666" },
    ];
    assert.equal(selectExistingOpenRescuePr(prs)?.number, 7445);
  });

  it("mistura de rescue e não-rescue → ignora as não-rescue", () => {
    const prs = [
      { number: 7403, headRefName: "chore/desliga-rampa-gmail-stage0" },
      { number: 7416, headRefName: "develop/clarice-daily-cutover-7406" },
      { number: 7404, headRefName: "continuo/rescue-20260904T040307Z-2689057-34a8" },
    ];
    assert.equal(selectExistingOpenRescuePr(prs)?.number, 7404);
  });
});

/**
 * buildRescuePrArgs (#7484)
 *
 * Regressão: a PR de rescue do contínuo (`tryOpenPr`) dizia no corpo
 * "triagem manual necessária antes de mergear ou descartar" mas nada no
 * mecanismo impedia o auto-merge (#5251/#6299) de mergear sozinha assim que
 * review+CI saíssem limpos — foi o que aconteceu com a PR #7438 (branch
 * `continuo/rescue-20260904T161117Z-3514739-646d`), que levou
 * `.review-i1.md` pra `master` sem nenhuma triagem.
 *
 * Correção: `buildRescuePrArgs` (extraída de `tryOpenPr` para ser pura e
 * testável sem spawnar `gh`) sempre inclui `--draft` (draft não é
 * auto-mergeável por construção) e `--label bloqueio-execucao` (já lida por
 * `classifyExecTrack`, roteia a issue/PR pra Bloqueada).
 */
import { buildRescuePrArgs, RESCUE_PR_BLOCK_LABEL } from "../scripts/rescue-continuo-orphaned-work.ts";

describe("#7484 buildRescuePrArgs — PR de rescue não é auto-mergeável", () => {
  it("inclui --draft", () => {
    const args = buildRescuePrArgs("continuo/rescue-20260905T000000Z-abc1234-deadbeef");
    assert.ok(args.includes("--draft"), `esperava --draft em ${JSON.stringify(args)}`);
  });

  it("inclui --label com a label de bloqueio de execução", () => {
    const args = buildRescuePrArgs("continuo/rescue-20260905T000000Z-abc1234-deadbeef");
    const labelIdx = args.indexOf("--label");
    assert.ok(labelIdx !== -1, `esperava --label em ${JSON.stringify(args)}`);
    assert.equal(args[labelIdx + 1], RESCUE_PR_BLOCK_LABEL);
    assert.equal(RESCUE_PR_BLOCK_LABEL, "bloqueio-execucao");
  });

  it("mantém --head/--base apontando pra branch e master", () => {
    const branch = "continuo/rescue-20260905T000000Z-abc1234-deadbeef";
    const args = buildRescuePrArgs(branch);
    const headIdx = args.indexOf("--head");
    const baseIdx = args.indexOf("--base");
    assert.equal(args[headIdx + 1], branch);
    assert.equal(args[baseIdx + 1], "master");
  });

  it("o corpo da PR menciona a label de bloqueio e o motivo do draft", () => {
    const args = buildRescuePrArgs("continuo/rescue-20260905T000000Z-abc1234-deadbeef");
    const bodyIdx = args.indexOf("--body");
    assert.ok(bodyIdx !== -1);
    const body = args[bodyIdx + 1];
    assert.ok(body.includes(RESCUE_PR_BLOCK_LABEL), "body deveria citar a label de bloqueio");
    assert.ok(body.includes("draft"), "body deveria explicar por que a PR é draft");
  });
});
