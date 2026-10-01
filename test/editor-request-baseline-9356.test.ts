/**
 * test/editor-request-baseline-9356.test.ts (#9356)
 *
 * Regressão: a captura de correções do editor comparava o `02-reviewed.md`
 * final com ele mesmo. O baseline `stage2-post-gate` (1) dependia de um
 * passo em prosa que a sessão pulava e (2) era REGRAVADO pelo `derive-stage4`
 * com o estado final — em 15 de 21 edições o snapshot era byte a byte o
 * arquivo final e `derive-stage4` registrava 0 pedidos do editor.
 *
 * Reproduz a ordem real: pipeline termina o Stage 2 (sentinel) → editor
 * edita no Stage 4 → derivação.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  LATE_CAPTURE_TOLERANCE_MS,
  assessStage2Baseline,
  readCaptureMeta,
} from "../scripts/lib/editor-request-snapshots.ts";
import { classifyNewsletterDiff } from "../scripts/derive-editor-requests.ts";
import { captureEditorBaselineOnStage2Sentinel } from "../scripts/pipeline-sentinel.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DERIVE = join(PROJECT_ROOT, "scripts", "derive-editor-requests.ts");
const SENTINEL = join(PROJECT_ROOT, "scripts", "pipeline-sentinel.ts");

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
}

function readEntries(editionDir: string): Array<Record<string, any>> {
  const p = join(editionDir, "_internal", "editor-requests.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const PIPELINE_MD = [
  "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
  "",
  "**[Título da pipeline](https://example.com/a)**",
  "",
  "Parágrafo original da pipeline.",
  "",
  "---",
  "",
  "**📡 RADAR**",
  "",
  "**[Item 1](https://example.com/r1)**",
  "Resumo 1.",
  "",
  "**[Item 2](https://example.com/r2)**",
  "Resumo 2.",
  "",
].join("\n");

function setupEdition(): { root: string; editionDir: string } {
  const root = mkdtempSync(join(tmpdir(), "baseline-9356-"));
  const editionDir = join(root, "260811");
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  writeFileSync(join(editionDir, "02-reviewed.md"), PIPELINE_MD, "utf8");
  writeFileSync(join(editionDir, "03-social.md"), "# Social\n\n## d1\n\nTexto social da pipeline.\n", "utf8");
  return { root, editionDir };
}

describe("#9356 — baseline stage2-post-gate é a saída da pipeline", () => {
  it("ordem real: sentinel do Stage 2 → editor edita → derive-stage4 captura a edição", () => {
    const { root, editionDir } = setupEdition();
    try {
      // Fim do Stage 2: o write do sentinel grava o baseline (mecânico).
      const s = run(SENTINEL, ["write", "--edition", "260811", "--step", "2", "--outputs", "02-reviewed.md,03-social.md", "--dir", editionDir]);
      assert.equal(s.status, 0, s.stderr);
      const snap = join(editionDir, "_internal", "editor-request-snapshots", "stage2-post-gate", "02-reviewed.md");
      assert.equal(readFileSync(snap, "utf8"), PIPELINE_MD);
      assert.equal(readCaptureMeta(editionDir, "stage2-post-gate")?.trigger, "pipeline-sentinel-step-2");

      // Stage 4: editor reescreve o destaque e corta um item do RADAR.
      const edited = PIPELINE_MD.replace("Parágrafo original da pipeline.", "Parágrafo reescrito pelo editor.")
        .replace("**[Item 2](https://example.com/r2)**\nResumo 2.\n", "");
      writeFileSync(join(editionDir, "02-reviewed.md"), edited, "utf8");

      // Uma chamada tardia de snapshot-stage2 (passo em prosa fora de ordem) não re-baseia.
      assert.equal(run(DERIVE, ["snapshot-stage2", "--edition", "260811", "--editions-dir", root]).status, 0);
      assert.equal(readFileSync(snap, "utf8"), PIPELINE_MD);

      const r = run(DERIVE, ["derive-stage4", "--edition", "260811", "--editions-dir", root]);
      assert.equal(r.status, 0, r.stderr);
      const entries = readEntries(editionDir);
      const targets = entries.map((e) => e.target).sort();
      assert.deepEqual(targets, ["d1", "radar"], JSON.stringify(entries));

      // O baseline NUNCA é regravado com o estado final; o checkpoint vai pro label novo.
      assert.equal(readFileSync(snap, "utf8"), PIPELINE_MD, "stage2-post-gate não pode virar o arquivo final");
      const checkpoint = join(editionDir, "_internal", "editor-request-snapshots", "stage4-post-gate", "02-reviewed.md");
      assert.equal(readFileSync(checkpoint, "utf8"), edited);

      // Retomada do Stage 4: 2ª chamada não duplica.
      assert.equal(run(DERIVE, ["derive-stage4", "--edition", "260811", "--editions-dir", root]).status, 0);
      assert.equal(readEntries(editionDir).length, entries.length);

      // Stage 6 só vê o que mudou depois do Stage 4.
      assert.equal(run(DERIVE, ["derive-stage6", "--edition", "260811", "--editions-dir", root]).status, 0);
      assert.equal(readEntries(editionDir).length, entries.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("baseline ausente: derive-stage4 loga erro (stderr + run-log) em vez de 0 pedidos em silêncio, e não fabrica o baseline", () => {
    const { root, editionDir } = setupEdition();
    try {
      const r = run(DERIVE, ["derive-stage4", "--edition", "260811", "--editions-dir", root]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /editor_request_baseline_missing/);
      const log = readFileSync(join(root, "data", "run-log.jsonl"), "utf8");
      const ev = JSON.parse(log.trim().split("\n").pop()!);
      assert.equal(ev.level, "error");
      assert.equal(ev.message, "editor_request_baseline_missing");
      assert.ok(
        !existsSync(join(editionDir, "_internal", "editor-request-snapshots", "stage2-post-gate")),
        "derive-stage4 não pode criar o stage2-post-gate a partir do estado final",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captureEditorBaselineOnStage2Sentinel: pula layout sem 02-reviewed.md (mensal) e é idempotente", () => {
    const root = mkdtempSync(join(tmpdir(), "baseline-9356-cap-"));
    try {
      assert.equal(captureEditorBaselineOnStage2Sentinel(root), "skipped");
      writeFileSync(join(root, "02-reviewed.md"), "x\n", "utf8");
      assert.equal(captureEditorBaselineOnStage2Sentinel(root), "created");
      writeFileSync(join(root, "02-reviewed.md"), "editado\n", "utf8");
      assert.equal(captureEditorBaselineOnStage2Sentinel(root), "exists");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assessStage2Baseline (#9356)", () => {
  const step2 = "2026-09-29T20:42:59.000Z";
  it("missing / legacy / ok / late", () => {
    assert.equal(assessStage2Baseline({ snapshotExists: false, meta: null, step2CompletedAt: step2 }).status, "missing");
    assert.equal(assessStage2Baseline({ snapshotExists: true, meta: null, step2CompletedAt: step2 }).status, "legacy");
    assert.equal(
      assessStage2Baseline({
        snapshotExists: true,
        meta: { captured_at: "2026-09-29T20:43:10.000Z", trigger: "pipeline-sentinel-step-2" },
        step2CompletedAt: step2,
      }).status,
      "ok",
    );
    // Caso real 260930: snapshot gravado às 22:45, sentinel do Stage 2 às 20:42.
    const late = assessStage2Baseline({
      snapshotExists: true,
      meta: { captured_at: "2026-09-29T22:45:27.000Z", trigger: "snapshot-stage2" },
      step2CompletedAt: step2,
    });
    assert.equal(late.status, "late");
    // Exatamente no limite ainda é ok.
    const edge = new Date(Date.parse(step2) + LATE_CAPTURE_TOLERANCE_MS).toISOString();
    assert.equal(
      assessStage2Baseline({ snapshotExists: true, meta: { captured_at: edge, trigger: "snapshot-stage2" }, step2CompletedAt: step2 }).status,
      "ok",
    );
  });
});

describe("classifyNewsletterDiff reconhece cabeçalhos com emoji (#9356)", () => {
  it("corte no **📡 RADAR** é radar, não lead-rewrite do destaque anterior", () => {
    const after = PIPELINE_MD.replace("**[Item 2](https://example.com/r2)**\nResumo 2.\n", "");
    const entries = classifyNewsletterDiff(PIPELINE_MD, after);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].target, "radar");
  });

  it("**🚀 LANÇAMENTO** (singular) e **ERRO INTENCIONAL** viram seções próprias", () => {
    const base = "**🚀 LANÇAMENTO**\n\nA\n\n---\n\n**ERRO INTENCIONAL**\n\nNessa edição, X.\n";
    const after = base.replace("Nessa edição, X.", "Nessa edição, Y.");
    const entries = classifyNewsletterDiff(base, after);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].context?.section, "erro-intencional");
  });
});

describe("backfill-stage4 (#9356)", () => {
  it("reconstrói a partir da saída da pipeline, dry-run não escreve, --write é idempotente", () => {
    const { root, editionDir } = setupEdition();
    try {
      // Saída da pipeline com 3 títulos; o title-picker escolheu o 2º.
      const pipelineOut = PIPELINE_MD.replace(
        "**[Título da pipeline](https://example.com/a)**",
        "**[Opção A](https://example.com/a)**  \n\n**[Título da pipeline](https://example.com/a)**  \n\n**[Opção C](https://example.com/a)**  ",
      );
      writeFileSync(join(editionDir, "_internal", "02-humanized.md"), pipelineOut, "utf8");
      writeFileSync(
        join(editionDir, "_internal", "02-title-picks.json"),
        JSON.stringify({ picks: [{ destaque: 1, chosen: "Título da pipeline" }] }),
        "utf8",
      );
      // Final: título escolhido pela pipeline (não conta) + edição real no RADAR.
      writeFileSync(
        join(editionDir, "02-reviewed.md"),
        "TÍTULO\n\nTítulo da pipeline\n\nSUBTÍTULO\n\nx\n\n---\n" +
          PIPELINE_MD.replace("Resumo 1.", "Resumo 1 reescrito pelo editor."),
        "utf8",
      );

      const dry = run(DERIVE, ["backfill-stage4", "--edition", "260811", "--editions-dir", root]);
      assert.equal(dry.status, 0, dry.stderr);
      const out = JSON.parse(dry.stdout);
      assert.deepEqual(out.entries.map((e: any) => e.target), ["radar"], dry.stdout);
      assert.equal(out.entries[0].context.baseline, "reconstructed");
      assert.equal(readEntries(editionDir).length, 0, "dry-run não pode escrever");

      assert.equal(run(DERIVE, ["backfill-stage4", "--edition", "260811", "--editions-dir", root, "--write"]).status, 0);
      assert.equal(readEntries(editionDir).length, 1);
      assert.equal(run(DERIVE, ["backfill-stage4", "--edition", "260811", "--editions-dir", root, "--write"]).status, 0);
      assert.equal(readEntries(editionDir).length, 1, "2ª chamada com --write é no-op");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
