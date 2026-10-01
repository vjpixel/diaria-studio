/**
 * test/calibration-labels-9373.test.ts (#9373)
 *
 * O rótulo de verdade da autocalibração (Track B) passa a vir do gate do
 * STAGE 4 (onde o editor de fato cura o pool), não do gate do Stage 1 (onde
 * ele aprova ~100%). Regressão do cenário real de 01/10/2026: edição com
 * `kept` = 100% do pool sob o rótulo stage1 → AUC indefinida; sob stage4 o
 * corte do editor no Stage 4 aparece como descarte.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStage4Outcome,
  stage4OutcomeToKept,
  stage4ReferenceFromMarkdown,
  loadKeptLabeler,
  parseLabelSource,
  DEFAULT_LABEL_SOURCE,
} from "../scripts/lib/calibration-labels.ts";
import { GATE1_SNAPSHOT_FILE } from "../scripts/lib/stage1-funnel.ts";
import { captureStage2Baseline } from "../scripts/lib/editor-request-snapshots.ts";
import { buildPowerReport, loadEditionRows } from "../scripts/calibration-power-report.ts";
import { buildShadowValidationReport } from "../scripts/shadow-validation-report.ts";
import { analyzeAllEditions } from "../scripts/analyze-destaque-overrides.ts";

const PUB = "https://pub.com/a"; // entregue e publicado
const CUT = "https://cut.com/b"; // entregue e cortado pelo editor no Stage 4
const INC = "https://inc.com/c"; // não entregue, incluído à mão
const NOT = "https://not.com/d"; // não entregue, não incluído
const HASH = "abc123";

function row(url: string, score: number) {
  return {
    url,
    bucket: "radar",
    title: url,
    score,
    score_base: score,
    primary_source: false,
    hands_on: false,
    academy: false,
    howto_br: false,
    howto_br_source: false,
    cluster_sources_count: 0,
    negative_impact: false,
    category: "noticias",
    origin: "cadastrada",
    recency_hours: 10,
    domain: new URL(url).hostname,
    title_char_count: 10,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
  };
}

/** Edição real em miniatura: gate 1 aprovou TUDO; o editor cortou no Stage 4. */
function writeEdition(root: string, edition: string, opts: { step4Done?: boolean } = {}): string {
  const dir = join(root, edition);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const rows = [row(PUB, 90), row(CUT, 40), row(INC, 70), row(NOT, 20)];
  writeFileSync(join(dir, "_internal", "scoring-features.json"), JSON.stringify({ edition, rows }));
  writeFileSync(
    join(dir, "_internal", "scoring-shadow.json"),
    JSON.stringify({ candidate_weights_hash: HASH, rows: rows.map((r) => ({ url: r.url, bucket: "radar", score: r.score, shadow_score_alt: r.score })) }),
  );
  const all = rows.map((r) => ({ url: r.url, title: r.url }));
  writeFileSync(join(dir, "_internal", "01-categorized.json"), JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: all, use_melhor: [], video: [] }));
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: all, use_melhor: [], video: [] }));
  writeFileSync(join(dir, "_internal", "02-humanized.md"), `**[Pub](${PUB})**\nresumo\n\n**[Cut](${CUT})**\nresumo\n`);
  writeFileSync(join(dir, "02-reviewed.md"), `**[Pub](${PUB})**\nresumo\n\n**[Inc](${INC})**\nincluído pelo editor\n`);
  if (opts.step4Done !== false) writeFileSync(join(dir, "_internal", ".step-4-done.json"), JSON.stringify({ step: 4, completed_at: "2026-10-01T00:00:00Z", outputs: [] }));
  return dir;
}

describe("classifyStage4Outcome / stage4OutcomeToKept (#9373)", () => {
  const ref = stage4ReferenceFromMarkdown(`[a](${PUB}) [b](${CUT})`, `[a](${PUB}/) [c](${INC})`, "pipeline-output");
  it("separa os 4 desfechos, por URL canônica", () => {
    assert.equal(classifyStage4Outcome(PUB, ref), "published");
    assert.equal(classifyStage4Outcome(CUT, ref), "cut_by_editor");
    assert.equal(classifyStage4Outcome(INC, ref), "editor_included");
    assert.equal(classifyStage4Outcome(NOT, ref), "not_delivered");
  });
  it("não entregue fica FORA da amostra (null) — não é descarte do editor", () => {
    assert.equal(stage4OutcomeToKept("published"), true);
    assert.equal(stage4OutcomeToKept("editor_included"), true);
    assert.equal(stage4OutcomeToKept("cut_by_editor"), false);
    assert.equal(stage4OutcomeToKept("not_delivered"), null);
  });
  it("padrão é stage4; --label inválido lança", () => {
    assert.equal(DEFAULT_LABEL_SOURCE, "stage4");
    assert.equal(parseLabelSource(undefined), "stage4");
    assert.equal(parseLabelSource("stage1"), "stage1");
    assert.throws(() => parseLabelSource("stage2"), /--label inválido/);
  });
});

describe("loadKeptLabeler (#9373)", () => {
  it("stage4 exige gate 4 aprovado (.step-4-done.json)", () => {
    const root = mkdtempSync(join(tmpdir(), "labels-"));
    try {
      const dir = writeEdition(root, "261001", { step4Done: false });
      const r = loadKeptLabeler(dir, "stage4");
      assert.equal(r.ok, false);
      assert.match((r as { reason: string }).reason, /gate 4 não aprovado/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stage4 usa o snapshot stage2-post-gate quando confiável, em vez do último _internal/02-*.md", () => {
    const root = mkdtempSync(join(tmpdir(), "labels-"));
    try {
      const dir = writeEdition(root, "261001");
      // Saída da pipeline no fim do Stage 2 (copiada pelo sentinel): entregou PUB e NOT.
      writeFileSync(join(dir, "02-reviewed.md"), `**[Pub](${PUB})**\n\n**[Not](${NOT})**\n`);
      writeFileSync(join(dir, "_internal", ".step-2-done.json"), JSON.stringify({ step: 2, completed_at: new Date().toISOString(), outputs: [] }));
      captureStage2Baseline(dir, "pipeline-sentinel-step-2");
      // Editor no Stage 4: corta NOT, inclui INC.
      writeFileSync(join(dir, "02-reviewed.md"), `**[Pub](${PUB})**\n\n**[Inc](${INC})**\n`);
      const r = loadKeptLabeler(dir, "stage4");
      assert.ok(r.ok);
      assert.equal(r.value.stage4Reference, "stage2-snapshot");
      assert.equal(r.value.stage4Outcome(NOT), "cut_by_editor");
      assert.equal(r.value.stage4Outcome(CUT), "not_delivered", "o 02-humanized.md não é a referência quando há snapshot confiável");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stage1 lê o snapshot congelado do gate 1, não o 01-approved reescrito no Stage 4 (#9372)", () => {
    const root = mkdtempSync(join(tmpdir(), "labels-"));
    try {
      const dir = writeEdition(root, "261001");
      writeFileSync(join(dir, GATE1_SNAPSHOT_FILE), JSON.stringify({ radar: [{ url: PUB }] }));
      const r = loadKeptLabeler(dir, "stage1");
      assert.ok(r.ok);
      assert.equal(r.value.gate1Frozen, true);
      assert.equal(r.value.label(PUB), true);
      assert.equal(r.value.label(CUT), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("consumidores do rótulo (#9373) — regressão do cenário de 01/10/2026", () => {
  it("power report: sob stage1 tudo é 'mantido'; sob stage4 o corte do Stage 4 é descarte e o não entregue sai da amostra", () => {
    const root = mkdtempSync(join(tmpdir(), "labels-power-"));
    try {
      writeEdition(root, "261001");
      const s1 = loadEditionRows(root, "stage1").editions[0];
      assert.deepEqual(s1.kept, [true, true, true, true]);
      const s4 = loadEditionRows(root, "stage4").editions[0];
      assert.deepEqual(s4.rows.map((r) => r.url), [PUB, CUT, INC]);
      assert.deepEqual(s4.kept, [true, false, true]);
      assert.equal(buildPowerReport(root).label_source, "stage4");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shadow validation: AUC indefinida sob stage1 (zero descartes), definida sob stage4", () => {
    const root = mkdtempSync(join(tmpdir(), "labels-shadow-"));
    try {
      writeEdition(root, "261001");
      const s1 = buildShadowValidationReport(root, HASH, 25, "stage1");
      assert.equal(s1.holdout_editions[0].auc_real, null);
      const s4 = buildShadowValidationReport(root, HASH, 25);
      assert.equal(s4.label_source, "stage4");
      assert.equal(s4.holdout_editions[0].n_rows, 3);
      assert.equal(s4.holdout_editions[0].auc_real, 1); // PUB(90), INC(70) > CUT(40)
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("analyze-destaque-overrides: evento do Track B carrega o desfecho do Stage 4", () => {
    const root = mkdtempSync(join(tmpdir(), "labels-overrides-"));
    try {
      writeEdition(root, "261001");
      const res = analyzeAllEditions(root);
      assert.equal(res.editions_with_stage4_outcome, 1);
      const by = new Map(res.events.map((e) => [e.url, e]));
      assert.equal(by.get(CUT)!.track_b, "bucket_kept", "no gate 1 o item sobreviveu...");
      assert.equal(by.get(CUT)!.stage4_outcome, "cut_by_editor", "...mas o editor o cortou no Stage 4");
      assert.equal(by.get(INC)!.stage4_outcome, "editor_included");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
