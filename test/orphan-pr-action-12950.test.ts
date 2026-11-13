/**
 * test/orphan-pr-action-12950.test.ts (#12950 item 3)
 *
 * `pr-em-voo` não pode deixar PR órfã. Na rodada 261112b o overnight pulou
 * #12892/#12894 como `pr-em-voo` (PRs #12896/#12897, aprovadas e verdes) e
 * #12873/#12874 (PR #12880, CI vermelho), e ninguém assumiu as PRs. O
 * preflight de PR aberta agora devolve `orphanAction` e as skills mandam
 * executá-la.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assessOpenPrCoverage, orphanPrAction, type OpenPrInfo } from "../scripts/lib/issue-open-pr-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pr(overrides: Partial<OpenPrInfo>): OpenPrInfo {
  return {
    number: 12897,
    title: "fix(guard): aspas duplas",
    body: "Closes #12894",
    headRefName: "overnight/fix-12894-guard",
    author: { login: "vjpixel" },
    updatedAt: "2026-11-12T08:04:00Z",
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    isDraft: false,
    labels: [],
    ...overrides,
  };
}

describe("orphanAction no preflight de PR aberta (#12950 item 3)", () => {
  it("caso real #12897: PR de lane, verde, sem draft -> merge-via-gate2", () => {
    const result = assessOpenPrCoverage(12894, [pr({})]);
    assert.equal(result.verdict, "open-pr-covers-scope");
    assert.equal(result.orphanAction, "merge-via-gate2");
    assert.match(result.recommendation, /merge-via-gate2/);
  });

  it("caso real #12880: CI vermelho -> despachar-fixer", () => {
    const result = assessOpenPrCoverage(12873, [
      pr({
        number: 12880,
        body: "Closes #12873",
        headRefName: "overnight/batch-12873-12874",
        statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    ]);
    assert.equal(result.orphanAction, "despachar-fixer");
  });

  it("CI pendente -> aguardar-ci", () => {
    assert.equal(
      orphanPrAction({ ciState: "pending", isDraft: false, labels: [], headRefName: "continuo/fix-1-x" }),
      "aguardar-ci",
    );
  });

  it("draft, bloqueio-execucao, retido-para-editor ou branch manual -> editor", () => {
    const base = { ciState: "green" as const, isDraft: false, labels: [] as string[], headRefName: "continuo/fix-1-x" };
    assert.equal(orphanPrAction({ ...base, isDraft: true }), "editor");
    assert.equal(orphanPrAction({ ...base, labels: ["bloqueio-execucao"] }), "editor");
    assert.equal(orphanPrAction({ ...base, labels: ["retido-para-editor"] }), "editor");
    assert.equal(orphanPrAction({ ...base, headRefName: "pixel/wip-ideia" }), "editor");
  });

  it("payload antigo sem isDraft/labels segue funcionando", () => {
    const { isDraft: _d, labels: _l, ...legacy } = pr({});
    const result = assessOpenPrCoverage(12894, [legacy as OpenPrInfo]);
    assert.equal(result.matches[0].isDraft, false);
    assert.deepEqual(result.matches[0].labels, []);
    assert.equal(result.orphanAction, "merge-via-gate2");
  });

  it("sem PR cobrindo -> sem orphanAction", () => {
    assert.equal(assessOpenPrCoverage(1, [pr({})]).orphanAction, undefined);
  });
});

describe("as skills mandam executar o orphanAction (#12950 item 3)", () => {
  for (const skill of ["diaria-overnight", "diaria-develop"]) {
    it(`${skill}/SKILL.md cita orphanAction e #12950 no preflight de PR aberta`, () => {
      const text = readFileSync(resolve(ROOT, ".claude/skills", skill, "SKILL.md"), "utf8");
      assert.match(text, /`orphanAction`[^\n]*#12950|#12950[^\n]*`orphanAction`/);
    });
  }
});
