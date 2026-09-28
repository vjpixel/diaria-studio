/**
 * test/update-stage-status-second-done-8899.test.ts (#8899)
 *
 * Regressão: uma 2ª chamada `--status done` (sem `--end` explícito) posterior
 * ao 1º carimbo atualiza `end` — sem isso, duração/custo do stage ficam presos
 * no 1º carimbo mesmo quando o trabalho real (ex: gate humano de revisão)
 * continuou por horas depois (achado ao vivo, edição 260928: Stage 4 marcado
 * `done` às 22:04 por erro de execução do orchestrator, gate real terminou
 * ~00:30, `stage-status.md` registrou 11min39s em vez de ~2h20 reais).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeInitialDoc, applyUpdate } from "../scripts/update-stage-status.ts";

describe("applyUpdate — 2º done sem --end atualiza end quando posterior (#8899)", () => {
  it("2ª chamada done posterior ao end existente avança end e recomputa duration_ms", () => {
    let doc = makeInitialDoc("260928");
    doc = applyUpdate(
      doc,
      { stage: 4, status: "running", start: "2026-09-28T22:00:00.000Z" },
      "2026-09-28T22:00:00.000Z",
    );
    // 1º "done" — carimbo cedo demais (erro de execução do orchestrator).
    doc = applyUpdate(doc, { stage: 4, status: "done" }, "2026-09-28T22:04:00.000Z");
    const row1 = doc.rows.find((r) => r.stage === 4)!;
    assert.equal(row1.end, "2026-09-28T22:04:00.000Z");
    assert.equal(row1.duration_ms, 4 * 60 * 1000);

    // 2ª chamada "done" — editor aprovou o gate de verdade, bem depois.
    doc = applyUpdate(doc, { stage: 4, status: "done" }, "2026-09-29T00:30:00.000Z");
    const row2 = doc.rows.find((r) => r.stage === 4)!;
    assert.equal(row2.end, "2026-09-29T00:30:00.000Z", "end deve avançar pro 2º carimbo, posterior ao 1º");
    assert.equal(
      row2.duration_ms,
      new Date("2026-09-29T00:30:00.000Z").getTime() - new Date("2026-09-28T22:00:00.000Z").getTime(),
      "duration_ms deve recomputar a partir do novo end",
    );
  });

  it("2ª chamada done com timestamp ANTERIOR ao end existente não regride end", () => {
    let doc = makeInitialDoc("260928");
    doc = applyUpdate(doc, { stage: 4, status: "running", start: "2026-09-28T22:00:00.000Z" }, "2026-09-28T22:00:00.000Z");
    doc = applyUpdate(doc, { stage: 4, status: "done", end: "2026-09-29T00:30:00.000Z" });
    // Uma chamada subsequente com `now` mais cedo (ex: retry de script com relógio
    // dessincronizado) nunca deve regredir um end já gravado.
    doc = applyUpdate(doc, { stage: 4, status: "done" }, "2026-09-28T22:10:00.000Z");
    const row = doc.rows.find((r) => r.stage === 4)!;
    assert.equal(row.end, "2026-09-29T00:30:00.000Z", "end não deve regredir");
  });

  it("--end explícito continua tendo precedência absoluta sobre o auto-bump", () => {
    let doc = makeInitialDoc("260928");
    doc = applyUpdate(doc, { stage: 4, status: "running", start: "2026-09-28T22:00:00.000Z" }, "2026-09-28T22:00:00.000Z");
    doc = applyUpdate(doc, { stage: 4, status: "done" }, "2026-09-28T22:04:00.000Z");
    // 2ª chamada passa --end explícito diferente de `now` — deve usar o explícito, não `now`.
    doc = applyUpdate(
      doc,
      { stage: 4, status: "done", end: "2026-09-29T01:00:00.000Z" },
      "2026-09-29T00:30:00.000Z",
    );
    const row = doc.rows.find((r) => r.stage === 4)!;
    assert.equal(row.end, "2026-09-29T01:00:00.000Z", "end explícito vence sobre now");
  });

  it("1ª chamada done (sem end prévio) continua comportamento pré-existente (auto-carimbo simples)", () => {
    let doc = makeInitialDoc("260928");
    doc = applyUpdate(doc, { stage: 1, status: "running", start: "2026-09-28T08:00:00.000Z" }, "2026-09-28T08:00:00.000Z");
    doc = applyUpdate(doc, { stage: 1, status: "done" }, "2026-09-28T08:30:00.000Z");
    const row = doc.rows.find((r) => r.stage === 1)!;
    assert.equal(row.end, "2026-09-28T08:30:00.000Z");
  });
});
