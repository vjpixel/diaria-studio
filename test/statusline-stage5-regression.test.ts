/**
 * test/statusline-regression-2525.test.ts (#2525)
 *
 * Regression tests for the Stage 5 → Stage 6 statusline transition bug.
 *
 * SCENARIOS COVERED:
 *   1. 5:running 6:pending → bar shows "5/7 Publicação" (stage 5 is the active stage)
 *   2. 5:done 6:running   → bar shows "6/7 Agendamento" (highest-index running wins)
 *   3. 5:done 6:pending   → bar shows "6/7 Agendamento" (next-pending fallback, not last-done)
 *   4. 2:running 5:running (orphaned) → shows Stage 5 label (highest-index running)
 *   5. reconcileRunningStages: marks orphaned running→failed, preserves other stages
 *   6. blockReasonForMarkingStageDone: status:skipped in 05-published.json allows done
 *
 * Root cause: renderEditionBar used rows.find() (first running) instead of highest-index
 * running; no next-pending fallback; no reconcile for orphaned running stages; gate
 * blocked stage 5 done when newsletter was skipped (#2495 degradation).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderEditionBar,
} from "../scripts/overnight-statusline.ts";
import {
  makeInitialDoc,
  applyUpdate,
  reconcileRunningStages,
  blockReasonForMarkingStageDone,
  type StageStatusDoc,
} from "../scripts/update-stage-status.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeDoc(
  edition: string,
  stageStatuses: Array<"pending" | "running" | "done" | "failed">,
): StageStatusDoc {
  return {
    edition,
    rows: stageStatuses.map((status, idx) => ({ stage: idx, status })),
    generated_at: "2026-06-22T08:00:00.000Z",
  };
}

// ─── Cenário 1: 5:running 6:pending → "5/7 Publicação" ──────────────────────
// When Stage 5 is running and Stage 6 is pending (waiting for human gate),
// the bar should show Stage 5's label because it's the current active stage.

describe("#2525 cenário 1: 5:running 6:pending → barra mostra '5/7 Publicação'", () => {
  it("5:running 6:pending: done=5, label=Publicação", () => {
    // Real-world scenario from issue: 260622/260623 had 5:running 6:pending
    const doc = makeDoc("260622", [
      "done",    // 0 Setup
      "done",    // 1 Pesquisa
      "done",    // 2 Escrita
      "done",    // 3 Imagens
      "done",    // 4 Revisão
      "running", // 5 Publicação ← active stage
      "pending", // 6 Agendamento
    ]);
    const result = renderEditionBar(doc);

    assert.ok(result.length > 0, `bar must not be empty: ${result}`);
    assert.ok(result.includes("edição 260622"), `must include edition ID: ${result}`);
    assert.ok(result.includes("5/7"), `must show 5/7 (5 done stages): ${result}`);
    assert.ok(result.includes("Publicação"), `label must be Publicação (stage 5 running): ${result}`);
    // Must NOT show Agendamento (stage 6 is only pending)
    assert.ok(!result.includes("Agendamento"), `must NOT show Agendamento (6 is pending, not running): ${result}`);
  });

  it("5:running 6:pending: barra NÃO trava (não é encerrada)", () => {
    const doc = makeDoc("260623", [
      "done", "done", "done", "done", "done",
      "running", // 5
      "pending", // 6
    ]);
    const result = renderEditionBar(doc);

    assert.notEqual(result, "", "in-progress edition must not return empty string");
    assert.ok(!result.includes("7/7"), `must NOT show 7/7 (not encerrada): ${result}`);
    assert.ok(!result.includes("████████████"), `bar must not be full: ${result}`);
  });
});

// ─── Cenário 2: 5:done 6:running → "6/7 Agendamento" ───────────────────────
// When Stage 5 completes (done) and Stage 6 starts (running), the bar must
// advance to show Stage 6's label — not Stage 5's (highest-index running wins).

describe("#2525 cenário 2: 5:done 6:running → barra avança para '6/7 Agendamento'", () => {
  it("5:done 6:running: done=6, label=Agendamento (highest-index running)", () => {
    const doc = makeDoc("260622", [
      "done",    // 0
      "done",    // 1
      "done",    // 2
      "done",    // 3
      "done",    // 4
      "done",    // 5 Publicação — concluído
      "running", // 6 Agendamento ← active stage
    ]);
    const result = renderEditionBar(doc);

    assert.ok(result.includes("6/7"), `must show 6/7: ${result}`);
    assert.ok(result.includes("Agendamento"), `label must be Agendamento (stage 6 running): ${result}`);
    assert.ok(!result.includes("Publicação"), `must NOT show Publicação (stage 5 is done): ${result}`);
  });
});

// ─── Cenário 3: 5:done 6:pending → "6/7 Agendamento" ───────────────────────
// After Stage 5 completes, Stage 6 is pending (waiting for the human gate).
// The bar should show Agendamento as the NEXT stage to run, NOT Publicação
// (the last-done stage). This is the "next-pending fallback" fix.

describe("#2525 cenário 3: 5:done 6:pending → barra mostra '6/7 Agendamento' (next-pending)", () => {
  it("5:done 6:pending: done=6, label=Agendamento (next-pending fallback, not last-done)", () => {
    const doc = makeDoc("260622", [
      "done",    // 0
      "done",    // 1
      "done",    // 2
      "done",    // 3
      "done",    // 4
      "done",    // 5 Publicação — concluído
      "pending", // 6 Agendamento ← next stage (não iniciado ainda)
    ]);
    const result = renderEditionBar(doc);

    assert.ok(result.includes("6/7"), `must show 6/7: ${result}`);
    // CRÍTICO (#2525): deve mostrar Agendamento (próximo stage), não Publicação (último done)
    assert.ok(result.includes("Agendamento"), `label must be Agendamento (next-pending): ${result}`);
    assert.ok(!result.includes("Publicação"), `must NOT show Publicação (it's done, not next): ${result}`);
  });

  it("4:done 5:pending: done=5, label=Publicação (next-pending after Stage 4)", () => {
    // Generalizes the fix: next-pending logic applies to all stages, not just 5→6
    const doc = makeDoc("260622", [
      "done",    // 0
      "done",    // 1
      "done",    // 2
      "done",    // 3
      "done",    // 4 Revisão — concluído
      "pending", // 5 Publicação ← next stage
      "pending", // 6
    ]);
    const result = renderEditionBar(doc);

    assert.ok(result.includes("5/7"), `must show 5/7: ${result}`);
    assert.ok(result.includes("Publicação"), `label must be Publicação (next-pending): ${result}`);
  });
});

// ─── Cenário 4: 2:running 5:running (orphaned) → label=Stage 5 ──────────────
// After an interruption, two stages can be left in `running`. The bar should
// show the HIGHEST-index running stage (stage 5 = Publicação), not the first
// (stage 2 = Escrita). This is the "highest-index running" fix.

describe("#2525 cenário 4: stages órfãos 2:running 5:running → label=maior índice (Publicação)", () => {
  it("2:running 5:running: done=2, label=Publicação (highest-index running)", () => {
    const doc = makeDoc("260619", [
      "done",    // 0
      "done",    // 1
      "running", // 2 Escrita ← órfão (interrompido)
      "done",    // 3
      "done",    // 4
      "running", // 5 Publicação ← órfão, índice maior (deve ser o label)
      "pending", // 6
    ]);
    const result = renderEditionBar(doc);

    // done = 4 (stages 0,1,3,4 are done — stages 2,5 are running, not done)
    assert.ok(result.includes("4/7"), `must show 4/7: ${result}`);
    // Label deve ser Publicação (stage 5, maior índice running)
    assert.ok(result.includes("Publicação"), `label must be Publicação (highest-index running): ${result}`);
    // Must NOT show Escrita (stage 2 running but lower index)
    assert.ok(!result.includes("Escrita"), `must NOT show Escrita (stage 2 is lower-index): ${result}`);
  });

  it("apenas 1 running: label é esse stage (sem ambiguidade)", () => {
    const doc = makeDoc("260619", [
      "done",    // 0
      "done",    // 1
      "running", // 2 Escrita ← único running
      "pending", // 3
      "pending", // 4
      "pending", // 5
      "pending", // 6
    ]);
    const result = renderEditionBar(doc);

    assert.ok(result.includes("Escrita"), `único running deve ser Escrita: ${result}`);
  });
});

// ─── Cenário 5: reconcileRunningStages ────────────────────────────────────────
// Reconcile orphaned running stages → mark them as failed so the orchestrator
// can decide whether to re-run them.

describe("#2525 reconcileRunningStages: orphaned running→failed", () => {
  it("stages running são marcados como failed", () => {
    let doc = makeInitialDoc("260619");
    doc = applyUpdate(doc, { stage: 0, status: "done" });
    doc = applyUpdate(doc, { stage: 1, status: "done" });
    doc = applyUpdate(doc, { stage: 2, status: "running" }); // órfão
    doc = applyUpdate(doc, { stage: 3, status: "done" });
    doc = applyUpdate(doc, { stage: 4, status: "done" });
    doc = applyUpdate(doc, { stage: 5, status: "running" }); // órfão

    const now = "2026-06-19T15:00:00.000Z";
    const { doc: reconciledDoc, reconciledStages } = reconcileRunningStages(doc, now);

    // Estágios reconciliados devem ser [2, 5]
    assert.deepEqual(reconciledStages.sort(), [2, 5], `deve reconciliar stages 2 e 5: ${reconciledStages}`);

    // Stage 2 e 5 devem ser failed
    const stage2 = reconciledDoc.rows.find((r) => r.stage === 2);
    const stage5 = reconciledDoc.rows.find((r) => r.stage === 5);
    assert.equal(stage2?.status, "failed", "stage 2 deve ser failed após reconcile");
    assert.equal(stage5?.status, "failed", "stage 5 deve ser failed após reconcile");

    // Outros stages devem preservar status
    const stage0 = reconciledDoc.rows.find((r) => r.stage === 0);
    const stage1 = reconciledDoc.rows.find((r) => r.stage === 1);
    const stage3 = reconciledDoc.rows.find((r) => r.stage === 3);
    const stage4 = reconciledDoc.rows.find((r) => r.stage === 4);
    assert.equal(stage0?.status, "done", "stage 0 deve permanecer done");
    assert.equal(stage1?.status, "done", "stage 1 deve permanecer done");
    assert.equal(stage3?.status, "done", "stage 3 deve permanecer done");
    assert.equal(stage4?.status, "done", "stage 4 deve permanecer done");
  });

  it("sem stages running: reconciledStages vazio, doc inalterado (funcionalmente)", () => {
    let doc = makeInitialDoc("260619");
    doc = applyUpdate(doc, { stage: 0, status: "done" });
    doc = applyUpdate(doc, { stage: 1, status: "done" });

    const { reconciledStages } = reconcileRunningStages(doc);

    assert.deepEqual(reconciledStages, [], "sem running: nada a reconciliar");
  });

  it("reconcile auto-carimba end quando estava ausente", () => {
    let doc = makeInitialDoc("260619");
    // Stage 5 running sem end timestamp (interrupcao antes do carimbo)
    doc = applyUpdate(doc, { stage: 5, status: "running", start: "2026-06-19T10:00:00.000Z" });

    const now = "2026-06-19T15:00:00.000Z";
    const { doc: reconciledDoc } = reconcileRunningStages(doc, now);

    const stage5 = reconciledDoc.rows.find((r) => r.stage === 5);
    assert.equal(stage5?.end, now, "deve carimbar end com o timestamp de reconcile");
    assert.equal(stage5?.duration_ms, 18000000, "duração deve ser 5h = 18000000ms");
  });

  it("após reconcile, renderEditionBar não trava — barra avança além do stage reconciliado", () => {
    // Simula edição 260619 com stages 2:running 5:running órfãos (do issue)
    let doc = makeInitialDoc("260619");
    doc = applyUpdate(doc, { stage: 0, status: "done" });
    doc = applyUpdate(doc, { stage: 1, status: "done" });
    doc = applyUpdate(doc, { stage: 2, status: "running" });
    doc = applyUpdate(doc, { stage: 3, status: "done" });
    doc = applyUpdate(doc, { stage: 4, status: "done" });
    doc = applyUpdate(doc, { stage: 5, status: "running" });

    // Antes do reconcile: barra trava
    const barBefore = renderEditionBar(doc);
    assert.ok(barBefore.includes("4/7"), `antes: deve mostrar 4/7: ${barBefore}`);

    // Após reconcile: stages running→failed; done (status literal) = 0,1,3,4 = 4 estágios
    // (stages 2 e 5 viraram failed; failed é terminal e conta pro progresso — contagem sobe para 6)
    const { doc: reconciledDoc } = reconcileRunningStages(doc, "2026-06-19T15:00:00.000Z");
    const barAfter = renderEditionBar(reconciledDoc);

    // Após reconcile, stages 2+5 são failed (terminais) → done=6
    assert.ok(barAfter.includes("6/7"), `após reconcile: deve mostrar 6/7: ${barAfter}`);
    // Stage 6 é pending → next-pending fallback: label=Agendamento
    assert.ok(barAfter.includes("Agendamento"), `após reconcile: label deve ser Agendamento: ${barAfter}`);
  });
});

// ─── Cenário 6: blockReasonForMarkingStageDone com status:skipped ─────────────
// When the newsletter was skipped (e.g., Chrome MCP unavailable, #2495 degradation),
// 05-published.json has status:"skipped". Stage 5 must be markable as done.

describe("#2525 blockReasonForMarkingStageDone: status:skipped permite done", () => {
  let tmpDir: string;

  it("05-published.json com status:skipped → bloqueia NÃO (stage pode virar done)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "block-reason-skipped-"));
    const internalDir = join(tmpDir, "_internal");
    mkdirSync(internalDir, { recursive: true });

    // Simula newsletter skipped (#2495: Chrome MCP unavailable)
    writeFileSync(
      join(internalDir, "05-published.json"),
      JSON.stringify({
        status: "skipped",
        review_completed: false,
        review_status: "pending",
      }),
      "utf8",
    );

    try {
      const reason = blockReasonForMarkingStageDone(tmpDir, 5);
      assert.equal(reason, null, `status:skipped deve permitir done (reason deve ser null): ${reason}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("05-published.json com review_completed:true → bloqueia NÃO (caminho normal)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "block-reason-review-done-"));
    const internalDir = join(tmpDir, "_internal");
    mkdirSync(internalDir, { recursive: true });

    writeFileSync(
      join(internalDir, "05-published.json"),
      JSON.stringify({
        status: "draft",
        review_completed: true,
        review_status: "ok",
      }),
      "utf8",
    );

    try {
      const reason = blockReasonForMarkingStageDone(tmpDir, 5);
      assert.equal(reason, null, `review_completed:true deve permitir done: ${reason}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("05-published.json com review_completed:false e review_status:'pending' → bloqueia", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "block-reason-blocked-"));
    const internalDir = join(tmpDir, "_internal");
    mkdirSync(internalDir, { recursive: true });

    // Estado inválido: review não completou e não foi declarado terminal
    writeFileSync(
      join(internalDir, "05-published.json"),
      JSON.stringify({
        status: "draft",
        review_completed: false,
        review_status: "pending",
      }),
      "utf8",
    );

    try {
      const reason = blockReasonForMarkingStageDone(tmpDir, 5);
      assert.ok(reason !== null, "review_completed:false + status:pending deve bloquear");
      assert.ok(
        typeof reason === "string" && reason.includes("review-test-email"),
        `mensagem deve mencionar review-test-email: ${reason}`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("05-published.json com review_status:'inconclusive' → bloqueia NÃO", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "block-reason-inconclusive-"));
    const internalDir = join(tmpDir, "_internal");
    mkdirSync(internalDir, { recursive: true });

    writeFileSync(
      join(internalDir, "05-published.json"),
      JSON.stringify({
        status: "draft",
        review_completed: false,
        review_status: "inconclusive",
      }),
      "utf8",
    );

    try {
      const reason = blockReasonForMarkingStageDone(tmpDir, 5);
      assert.equal(reason, null, `inconclusive deve permitir done (já existia): ${reason}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("05-published.json ausente → bloqueia NÃO (newsletter não chegou a ser criada)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "block-reason-no-file-"));
    const internalDir = join(tmpDir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    // Não escreve 05-published.json

    try {
      const reason = blockReasonForMarkingStageDone(tmpDir, 5);
      assert.equal(reason, null, `sem 05-published.json deve permitir done: ${reason}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Regressão do estado real das edições 260622/260623 ──────────────────────
// Reproduz exatamente o estado descrito na issue: stage-status com 5:running 6:pending.
// Verifica que a barra reflete "5/7 Publicação" (não trava em "5/7 Publicação" pra sempre,
// mas mostra o estado correto), E que após Stage 5 concluir, avança para "6/7 Agendamento".

describe("#2525 regressão real 260622/260623: 5:running 6:pending → 5:done 6:pending → 6/7", () => {
  it("fluxo completo: 5:running → 5:done → barra avança para 6/7 Agendamento", () => {
    // Estado 1: Stage 5 running (publicação em andamento)
    const docRunning = makeDoc("260622", [
      "done", "done", "done", "done", "done",
      "running", // 5 publicação
      "pending", // 6 agendamento
    ]);
    const barRunning = renderEditionBar(docRunning);
    assert.ok(barRunning.includes("5/7"), `estado 1: deve mostrar 5/7: ${barRunning}`);
    assert.ok(barRunning.includes("Publicação"), `estado 1: deve mostrar Publicação: ${barRunning}`);

    // Estado 2: Stage 5 done, Stage 6 pending (aguardando gate humano)
    const docAfterStage5 = makeDoc("260622", [
      "done", "done", "done", "done", "done",
      "done",    // 5 publicação — concluído
      "pending", // 6 agendamento — aguardando gate
    ]);
    const barAfterStage5 = renderEditionBar(docAfterStage5);
    assert.ok(barAfterStage5.includes("6/7"), `estado 2: deve mostrar 6/7: ${barAfterStage5}`);
    // CORREÇÃO DO BUG: deve mostrar Agendamento (not Publicação — last-done)
    assert.ok(barAfterStage5.includes("Agendamento"), `estado 2: deve mostrar Agendamento: ${barAfterStage5}`);
    assert.ok(!barAfterStage5.includes("Publicação"), `estado 2: NÃO deve mostrar Publicação: ${barAfterStage5}`);

    // Estado 3: Stage 6 running (gate aceito, agendamento em andamento)
    const docStage6Running = makeDoc("260622", [
      "done", "done", "done", "done", "done",
      "done",    // 5 publicação — concluído
      "running", // 6 agendamento — rodando
    ]);
    const barStage6 = renderEditionBar(docStage6Running);
    assert.ok(barStage6.includes("6/7"), `estado 3: deve mostrar 6/7: ${barStage6}`);
    assert.ok(barStage6.includes("Agendamento"), `estado 3: deve mostrar Agendamento: ${barStage6}`);

    // Estado 4: Encerrada (todos done)
    const docEncerrada = makeDoc("260622", [
      "done", "done", "done", "done", "done", "done", "done",
    ]);
    const barEncerrada = renderEditionBar(docEncerrada);
    assert.ok(barEncerrada.includes("7/7"), `estado 4: deve mostrar 7/7: ${barEncerrada}`);
    assert.ok(barEncerrada.includes("████████████"), `estado 4: barra deve estar cheia: ${barEncerrada}`);
  });
});

// ─── Regression #2540: status normalizado case-insensitive ────────────────────
// Typos like "Skipped" (capital S) ou "skip" (sem "ped") NÃO devem bloquear
// o fechamento do Stage 5 silenciosamente.

describe("#2540 blockReasonForMarkingStageDone: status normalizado (case-insensitive)", () => {
  function makeSkippedFile(dir: string, status: string): void {
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(
      join(internalDir, "05-published.json"),
      JSON.stringify({ status, review_completed: false, review_status: "pending" }),
      "utf8",
    );
  }

  it("status:'Skipped' (capital S) → normalizado para 'skipped' → NÃO bloqueia", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "block-skipped-capital-"));
    try {
      makeSkippedFile(tmpDir, "Skipped");
      const reason = blockReasonForMarkingStageDone(tmpDir, 5);
      assert.equal(reason, null, `status:'Skipped' deve ser normalizado e permitir done; got: ${reason}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("status:'SKIPPED' (all caps) → normalizado para 'skipped' → NÃO bloqueia", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "block-skipped-allcaps-"));
    try {
      makeSkippedFile(tmpDir, "SKIPPED");
      const reason = blockReasonForMarkingStageDone(tmpDir, 5);
      assert.equal(reason, null, `status:'SKIPPED' deve ser normalizado e permitir done; got: ${reason}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("status:'skip' (sem sufixo) → NÃO é 'skipped' → bloqueia (não deve silenciar)", () => {
    // "skip" !== "skipped" mesmo normalizado — não deve ser aceito como skipped
    const tmpDir = mkdtempSync(join(tmpdir(), "block-skip-short-"));
    try {
      makeSkippedFile(tmpDir, "skip");
      const reason = blockReasonForMarkingStageDone(tmpDir, 5);
      assert.ok(reason !== null, `status:'skip' (diferente de 'skipped') deve BLOQUEAR — sem aceitação silenciosa de typos não-intencionais`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("status:' skipped ' (espaços extras) → normalizado (trim) → NÃO bloqueia", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "block-skipped-spaces-"));
    try {
      makeSkippedFile(tmpDir, " skipped ");
      const reason = blockReasonForMarkingStageDone(tmpDir, 5);
      assert.equal(reason, null, `status:' skipped ' com espaços deve ser normalizado; got: ${reason}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
