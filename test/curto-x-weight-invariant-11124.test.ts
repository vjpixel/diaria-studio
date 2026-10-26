/**
 * test/curto-x-weight-invariant-11124.test.ts (#11124)
 *
 * Regressão da edição 261026: o D1 foi reescrito DENTRO do gate do Stage 4 e
 * o `# Curto` do X ficou com 287 de peso (limite 280, URL = 23). O lint
 * `curto-x-weight` (#10180) só roda antes do gate; só o `prep-twitter-posts.ts`
 * do Stage 5 acusou, com o gate já aprovado. A invariante `curto-x-weight` do
 * Stage 4 faz o `check-invariants --stage 4` e o `pipeline-sentinel.ts write
 * --step 4` reprovarem, qualquer que tenha sido o caminho da edição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import { checkCurtoXWeightInvariant } from "../scripts/lib/invariant-checks/stage-4.ts";
import { checkStageInvariantsForWrite } from "../scripts/pipeline-sentinel.ts";
import { SWEEP_SKIPPED_RULE_IDS } from "../scripts/lib/stage4-post-edit-checks-core.ts";

/** Post com peso X exato `n`: texto + espaço + `{edition_url}` (conta 23). */
function postOfWeight(n: number): string {
  return "a".repeat(n - 24) + " {edition_url}";
}

function editionWithCurto(curto: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-curto-inv-11124-"));
  const lines = ["# Social", "", "## d1", "", "Texto longo do LinkedIn.", "", "# Curto", ""];
  for (const [d, text] of Object.entries(curto)) lines.push(`## ${d}`, "", text, "");
  writeFileSync(join(dir, "03-social.md"), lines.join("\n"));
  return dir;
}

describe("invariante curto-x-weight do Stage 4 (#11124)", () => {
  it("registrada no Stage 4", () => {
    const rule = getRulesForStage(4).find((r) => r.id === "curto-x-weight");
    assert.ok(rule, "curto-x-weight ausente de getRulesForStage(4)");
    assert.equal(rule.source_issue, "#11124");
  });

  it("D1 com 287 (caso 261026) reprova como error, nomeando o destaque e o corte", () => {
    const dir = editionWithCurto({ d1: postOfWeight(287), d2: postOfWeight(200), d3: postOfWeight(200) });
    try {
      const v = checkCurtoXWeightInvariant(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "curto-x-weight");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /## d1: 287/);
      assert.match(v[0].message, /Corte 7/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("280 exatos passa", () => {
    const dir = editionWithCurto({ d1: postOfWeight(280), um: postOfWeight(280) });
    try {
      assert.deepEqual(checkCurtoXWeightInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem 03-social.md: nada a checar", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-curto-inv-11124-"));
    try {
      assert.deepEqual(checkCurtoXWeightInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pipeline-sentinel write --step 4 recusa com o post estourado", () => {
    const dir = editionWithCurto({ d1: postOfWeight(287) });
    try {
      const r = checkStageInvariantsForWrite(dir, 4);
      assert.equal(r.passed, false);
      assert.ok(r.errors.some((e) => e.rule === "curto-x-weight"), "sentinel não citou curto-x-weight");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweep pós-edição pula a invariante (o lint-social:stage-4 já reporta o mesmo cálculo)", () => {
    assert.ok(SWEEP_SKIPPED_RULE_IDS.has("curto-x-weight"));
  });
});
