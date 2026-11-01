/**
 * #11652: o filtro do #11517 em `checkThemeCrossSourceRepeat` comparava o
 * jaccard de conteúdo sempre com o piso fixo de 0.20 e descartava os pares que
 * o Stage 1 aceita pelo piso rebaixado de 0.15 (título com entidade nomeada em
 * comum, `thresholdForPair`). O piso agora vem do `effective_threshold` que o
 * Stage 1 grava em cada warning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentJaccard,
  detectEventOverlap,
  REPEAT_THEME_WARN_THRESHOLD,
  REPEAT_THEME_WARN_THRESHOLD_LOWERED,
} from "../scripts/lib/repeat-theme-check.ts";
import { checkThemeCrossSourceRepeat } from "../scripts/lib/invariant-checks/stage-4.ts";

const PAIR = {
  // 1 token em comum (anthropic) sobre 6 = 0.17; "Anthropic" é entidade nos dois
  cand: "Equipe da Anthropic cresce",
  past: "Escritório da Anthropic funciona em Tóquio",
  url: "https://example.com/anthropic-contrata",
};

function runCheck(warning: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "theme-cross-11652-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), `**${PAIR.cand}**\n\n${PAIR.url}\n`);
    writeFileSync(
      join(dir, "_internal", "01-highlight-theme-check.json"),
      JSON.stringify({ warnings: [warning], same_fact_warnings: [] }),
    );
    return checkThemeCrossSourceRepeat(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#11652: pré-condição — o Stage 1 aceita o par só pelo piso rebaixado", () => {
  const [m] = detectEventOverlap([{ title: PAIR.cand, url: PAIR.url }], [{ title: PAIR.past, aammdd: "261028" }]);
  assert.ok(m, "Stage 1 deveria sinalizar o par");
  assert.equal(m.threshold, REPEAT_THEME_WARN_THRESHOLD_LOWERED);
  assert.ok(m.sharedEntities.length > 0);
  const sim = contentJaccard(PAIR.cand, PAIR.past);
  assert.ok(sim >= REPEAT_THEME_WARN_THRESHOLD_LOWERED && sim < REPEAT_THEME_WARN_THRESHOLD, `sim=${sim}`);
});

test("#11652: par com entidade em comum e jaccard 0.17 sobe no gate 4 como conferência", () => {
  const [m] = detectEventOverlap([{ title: PAIR.cand, url: PAIR.url }], [{ title: PAIR.past, aammdd: "261028" }]);
  const v = runCheck({
    candidate_rank: 1,
    candidate_title: PAIR.cand,
    candidate_url: PAIR.url,
    matched_edition: "261028",
    matched_title: PAIR.past,
    jaccard: Math.round(m.jaccard * 100) / 100,
    shared_entities: m.sharedEntities,
    effective_threshold: m.threshold,
    cross_source_match: true,
  });
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "theme-cross-source-repeat");
  assert.ok(v[0].message.includes(PAIR.url));
  assert.ok(v[0].message.includes("Conferir no gate"));
  assert.ok(!v[0].message.includes("🚨"));
});

test("#11652: sem effective_threshold (arquivo antigo) o piso segue 0.20", () => {
  const v = runCheck({
    candidate_title: PAIR.cand,
    candidate_url: PAIR.url,
    matched_edition: "261028",
    matched_title: PAIR.past,
    jaccard: 0.17,
    shared_entities: [],
    cross_source_match: true,
  });
  assert.deepEqual(v, []);
});
