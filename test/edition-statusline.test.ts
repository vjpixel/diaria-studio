/**
 * test/edition-statusline.test.ts (#2250)
 *
 * Testes da função pura `renderEditionBar` e do detector `readCurrentEditionDoc`
 * que alimentam a statusLine do Claude Code durante uma edição em curso.
 *
 * Coberturas obrigatórias (#633):
 *   - Edição em curso (stage running) → barra com label correto
 *   - Sem edição (nenhum stage-status.json) → string vazia, fallback overnight
 *   - JSON malformado → string vazia, sem throw
 *   - Precedência: edição em curso tem prioridade sobre overnight bar
 *   - Edição encerrada (todos done/failed) → N/N visível (espelha #2246)
 *   - Edição iniciada mas não concluída (partial done) → % correto + label correto
 *   - Edição all-pending (--init mas não rodando) → oculta (não é "em curso")
 *   - Múltiplas edições → detecta a mais recente com atividade (deterministico)
 *   - doc com rows vazio → string vazia
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderEditionBar,
  readCurrentEditionDoc,
  renderOvernightBar,
  readTodayPlan,
  type Plan,
} from "../scripts/overnight-statusline.ts";
import type { StageStatusDoc } from "../scripts/update-stage-status.ts";
import { STAGE_LABELS } from "../scripts/update-stage-status.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeDoc(
  edition: string,
  stageStatuses: Array<"pending" | "running" | "done" | "failed">,
): StageStatusDoc {
  return {
    edition,
    rows: stageStatuses.map((status, idx) => ({ stage: idx, status })),
    generated_at: "2026-06-15T08:00:00.000Z",
  };
}

/** Create a minimal stage-status.json fixture on disk. */
function writeStageStatus(editionDir: string, doc: StageStatusDoc): void {
  const internalDir = join(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(join(internalDir, "stage-status.json"), JSON.stringify(doc, null, 2), "utf8");
}

// ─── renderEditionBar — input null/undefined ───────────────────────────────────

describe("renderEditionBar — null / undefined", () => {
  it("retorna string vazia para null", () => {
    assert.equal(renderEditionBar(null), "");
  });

  it("retorna string vazia para undefined", () => {
    assert.equal(renderEditionBar(undefined), "");
  });
});

// ─── renderEditionBar — doc malformado ────────────────────────────────────────

describe("renderEditionBar — doc malformado", () => {
  it("doc sem rows → string vazia, sem throw", () => {
    const malformed = { edition: "260615", generated_at: "" } as unknown as StageStatusDoc;
    assert.doesNotThrow(() => renderEditionBar(malformed));
    assert.equal(renderEditionBar(malformed), "");
  });

  it("doc com rows não-array → string vazia, sem throw", () => {
    const malformed = {
      edition: "260615",
      rows: "not-an-array",
      generated_at: "",
    } as unknown as StageStatusDoc;
    assert.doesNotThrow(() => renderEditionBar(malformed));
    assert.equal(renderEditionBar(malformed), "");
  });

  it("doc com rows vazio → string vazia", () => {
    const doc = makeDoc("260615", []);
    assert.equal(renderEditionBar(doc), "");
  });
});

// ─── renderEditionBar — edição em curso ───────────────────────────────────────

describe("renderEditionBar — edição em curso", () => {
  it("stage 1 running (Pesquisa) → barra com label 'Pesquisa' e 0/7", () => {
    // Stage 0 done, stage 1 running, stages 2-6 pending
    const doc = makeDoc("260615", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);
    const result = renderEditionBar(doc);

    assert.ok(result.length > 0, `deve retornar barra não-vazia: ${result}`);
    assert.ok(result.includes("edição 260615"), `deve incluir ID da edição: ${result}`);
    // done=1 (stage 0), running=1 → exibe 1/7
    assert.ok(result.includes("1/7"), `deve mostrar 1/7: ${result}`);
    assert.ok(result.includes("Pesquisa"), `deve mostrar label 'Pesquisa': ${result}`);
  });

  it("stage 3 running (Imagens) com 3 stages done → barra com '3/7  Imagens'", () => {
    // Stages 0-2 done, stage 3 running, 4-6 pending
    const doc = makeDoc("260615", ["done", "done", "done", "running", "pending", "pending", "pending"]);
    const result = renderEditionBar(doc);

    assert.ok(result.includes("3/7"), `deve mostrar 3/7: ${result}`);
    assert.ok(result.includes("Imagens"), `deve mostrar label 'Imagens': ${result}`);
  });

  it("formato canônico: 'edição AAMMDD  [bar] N/7  Label'", () => {
    const doc = makeDoc("260615", ["done", "done", "running", "pending", "pending", "pending", "pending"]);
    const result = renderEditionBar(doc);
    // Deve começar com "edição 260615  ["
    assert.ok(result.startsWith("edição 260615  ["), `formato incorreto: ${result}`);
    // Deve terminar com o label sem trailing space
    assert.ok(result.includes("Escrita"), `deve ter label: ${result}`);
    // Barra de 12 chars
    const barMatch = result.match(/\[([█░]+)\]/);
    assert.ok(barMatch, `deve ter [bar]: ${result}`);
    assert.equal(barMatch![1].length, 12, `barra deve ter 12 chars: ${barMatch![1]}`);
  });

  it("N/7 usa Math.floor (3/7 = 42%, não 43%)", () => {
    // 3 done de 7 = 3/7 ≈ 0.4285... → Math.floor(0.4285 * 100) = 42%
    // Aqui testamos a contagem N/7, não o %, mas garantimos que barra tem blocos corretos
    const doc = makeDoc("260615", ["done", "done", "done", "running", "pending", "pending", "pending"]);
    const result = renderEditionBar(doc);
    // 3/7 → Math.floor(3/7 * 12) = Math.floor(5.14...) = 5 blocos cheios, 7 vazios
    const barMatch = result.match(/\[([█░]+)\]/);
    assert.ok(barMatch, `deve ter [bar]: ${result}`);
    const filledCount = (barMatch![1].match(/█/g) ?? []).length;
    assert.equal(filledCount, 5, `3/7 deve ter 5 blocos cheios, got ${filledCount}: ${barMatch![1]}`);
  });

  it("exibe 0/7 quando só stage 0 está running (sem done)", () => {
    const doc = makeDoc("260615", ["running", "pending", "pending", "pending", "pending", "pending", "pending"]);
    const result = renderEditionBar(doc);
    assert.ok(result.includes("0/7"), `deve mostrar 0/7: ${result}`);
    assert.ok(result.includes("Setup"), `deve mostrar label 'Setup': ${result}`);
  });
});

// ─── renderEditionBar — edição encerrada (espelha #2246) ────────────────────

describe("renderEditionBar — edição encerrada → N/N visível", () => {
  it("todos stages done → 7/7 visível (NÃO string vazia)", () => {
    const doc = makeDoc("260615", ["done", "done", "done", "done", "done", "done", "done"]);
    const result = renderEditionBar(doc);
    assert.notEqual(result, "", "edição encerrada não deve retornar string vazia");
    assert.ok(result.includes("7/7"), `deve mostrar 7/7: ${result}`);
    assert.ok(result.includes("edição 260615"), `deve incluir ID: ${result}`);
    // Barra cheia (12 blocos █)
    assert.ok(result.includes("████████████"), `deve ter barra cheia: ${result}`);
  });

  it("stages done+failed (mix terminal) → encerrada, N/7 visível", () => {
    const doc = makeDoc("260615", ["done", "done", "done", "done", "done", "failed", "done"]);
    const result = renderEditionBar(doc);
    assert.notEqual(result, "", "mix done/failed não deve retornar string vazia");
    assert.ok(result.includes("7/7"), `deve mostrar 7/7: ${result}`);
  });

  it("último stage do label é o último row quando encerrada", () => {
    const doc = makeDoc("260615", ["done", "done", "done", "done", "done", "done", "done"]);
    const result = renderEditionBar(doc);
    // Stage 6 = "Agendamento"
    assert.ok(result.includes("Agendamento"), `encerrada deve mostrar 'Agendamento': ${result}`);
  });
});

// ─── readCurrentEditionDoc — sem edições ─────────────────────────────────────

describe("readCurrentEditionDoc — sem edições / dir ausente", () => {
  it("retorna null quando data/editions não existe", () => {
    const emptyRoot = join(tmpdir(), `edition-test-empty-${Date.now()}`);
    mkdirSync(emptyRoot, { recursive: true });
    try {
      const doc = readCurrentEditionDoc(emptyRoot);
      assert.equal(doc, null, "sem editions dir deve retornar null");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("retorna null quando não há stage-status.json em nenhuma edição", () => {
    const root = join(tmpdir(), `edition-test-nostatusfile-${Date.now()}`);
    mkdirSync(join(root, "data", "editions", "260615"), { recursive: true });
    try {
      const doc = readCurrentEditionDoc(root);
      assert.equal(doc, null, "sem stage-status.json deve retornar null");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna null quando stage-status.json está malformado (JSON inválido)", () => {
    const root = join(tmpdir(), `edition-test-malformed-${Date.now()}`);
    const editionDir = join(root, "data", "editions", "260615");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(join(editionDir, "_internal", "stage-status.json"), "not-json", "utf8");
    try {
      const doc = readCurrentEditionDoc(root);
      assert.equal(doc, null, "JSON malformado deve retornar null");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna null quando edição tem stage-status.json mas todos stages são pending (não iniciada)", () => {
    const root = join(tmpdir(), `edition-test-allpending-${Date.now()}`);
    const editionDir = join(root, "data", "editions", "260615");
    const doc = makeDoc("260615", ["pending", "pending", "pending", "pending", "pending", "pending", "pending"]);
    writeStageStatus(editionDir, doc);
    try {
      const result = readCurrentEditionDoc(root);
      assert.equal(result, null, "edição all-pending não deve ser detectada como em curso");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── readCurrentEditionDoc — edição em curso ──────────────────────────────────

describe("readCurrentEditionDoc — detecção de edição em curso", () => {
  it("detecta edição com stage running como em curso", () => {
    const root = join(tmpdir(), `edition-test-running-${Date.now()}`);
    const editionDir = join(root, "data", "editions", "260615");
    const doc = makeDoc("260615", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);
    writeStageStatus(editionDir, doc);
    try {
      const result = readCurrentEditionDoc(root);
      assert.ok(result !== null, "deve detectar edição com running");
      assert.equal(result!.edition, "260615");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição encerrada (todos done) → retorna null — overnight bar pode retomar (Finding #1)", () => {
    // Fix #1: readCurrentEditionDoc SKIPS encerrada editions so the overnight bar resumes.
    // renderEditionBar still renders 7/7 when given the doc directly (see renderEditionBar tests),
    // but readCurrentEditionDoc no longer surfaces it — the CLI falls back to overnight.
    const root = join(tmpdir(), `edition-test-done-${Date.now()}`);
    const editionDir = join(root, "data", "editions", "260615");
    const doc = makeDoc("260615", ["done", "done", "done", "done", "done", "done", "done"]);
    writeStageStatus(editionDir, doc);
    try {
      const result = readCurrentEditionDoc(root);
      assert.equal(result, null, "edição encerrada deve retornar null (overnight retoma)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── readCurrentEditionDoc — múltiplas edições ───────────────────────────────

describe("readCurrentEditionDoc — múltiplas edições (determinístico, sem clock)", () => {
  it("escolhe a edição MAIS RECENTE (lexicográfico desc) que tem atividade", () => {
    // Setup (self-contained):
    //   260613 — stage 1 done, stage 2 running
    //   260614 — stage 0 done, stage 1 running  ← mais recente em curso
    const tmpRoot = join(tmpdir(), `edition-test-multi-recent-${Date.now()}`);
    const dir260613 = join(tmpRoot, "data", "editions", "260613");
    const dir260614 = join(tmpRoot, "data", "editions", "260614");

    const doc260613 = makeDoc("260613", ["done", "done", "running", "pending", "pending", "pending", "pending"]);
    const doc260614 = makeDoc("260614", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);

    writeStageStatus(dir260613, doc260613);
    writeStageStatus(dir260614, doc260614);

    try {
      const result = readCurrentEditionDoc(tmpRoot);
      assert.ok(result !== null, "deve retornar edição");
      assert.equal(result!.edition, "260614", `deve escolher 260614 (mais recente), got ${result!.edition}`);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("se a mais recente está all-pending (não iniciada), usa a próxima mais recente em curso", () => {
    // Setup (self-contained — escrito inteiro aqui, não depende de outro it):
    //   260614 — stage 0 done, stage 1 running  ← em curso (deve ser detectada)
    //   260615 — all-pending (não iniciada)      ← mais recente mas deve ser ignorada
    const tmpRoot = join(tmpdir(), `edition-test-multi-pending-${Date.now()}`);
    const dir260614 = join(tmpRoot, "data", "editions", "260614");
    const dir260615 = join(tmpRoot, "data", "editions", "260615");

    const doc260614 = makeDoc("260614", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);
    const docAllPending = makeDoc("260615", ["pending", "pending", "pending", "pending", "pending", "pending", "pending"]);

    writeStageStatus(dir260614, doc260614);
    writeStageStatus(dir260615, docAllPending);

    try {
      const result = readCurrentEditionDoc(tmpRoot);
      assert.ok(result !== null, "deve retornar edição com atividade");
      // 260615 é all-pending → deve cair para 260614 (em curso)
      assert.equal(result!.edition, "260614", `deve pular 260615 all-pending e usar 260614, got ${result!.edition}`);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("se a mais recente está encerrada (todos done), pula para encontrar in-progress (Finding #1)", () => {
    // Encerrada editions are skipped by readCurrentEditionDoc — overnight bar resumes.
    // If there's a still-running older edition, it's returned; if not, null.
    const tmpRoot = join(tmpdir(), `edition-test-multi-encerrada-${Date.now()}`);
    const dir260614 = join(tmpRoot, "data", "editions", "260614");
    const dir260615 = join(tmpRoot, "data", "editions", "260615");

    const docInProgress = makeDoc("260614", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);
    const docEncerrada = makeDoc("260615", ["done", "done", "done", "done", "done", "done", "done"]);

    writeStageStatus(dir260614, docInProgress);
    writeStageStatus(dir260615, docEncerrada);

    try {
      const result = readCurrentEditionDoc(tmpRoot);
      // 260615 is encerrada → skipped; 260614 is in-progress → returned
      assert.ok(result !== null, "deve retornar edição em curso anterior");
      assert.equal(result!.edition, "260614", `deve pular 260615 encerrada e usar 260614 em curso, got ${result!.edition}`);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("se TODAS encerradas, retorna null (overnight retoma)", () => {
    const tmpRoot = join(tmpdir(), `edition-test-multi-all-encerrada-${Date.now()}`);
    const dir260614 = join(tmpRoot, "data", "editions", "260614");
    const doc = makeDoc("260614", ["done", "done", "done", "done", "done", "done", "done"]);
    writeStageStatus(dir260614, doc);

    try {
      const result = readCurrentEditionDoc(tmpRoot);
      assert.equal(result, null, "todas encerradas → null (overnight retoma)");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── precedência: edição > overnight ─────────────────────────────────────────

describe("precedência: edição em curso > overnight bar", () => {
  it("quando há edição, renderEditionBar retorna string não-vazia (deve ser usada)", () => {
    // Simula: edição ativa + overnight plan ativo
    const editionDoc = makeDoc("260615", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);
    const overnightPlan: Plan = {
      issues: [
        { status: "mergeada" },
        { status: "elegivel" },
        { status: "elegivel" },
      ],
    };

    const editionBar = renderEditionBar(editionDoc);
    const overnightBar = renderOvernightBar(overnightPlan);

    // Ambos produzem barras
    assert.ok(editionBar.length > 0, `editionBar deve ser não-vazia: ${editionBar}`);
    assert.ok(overnightBar.length > 0, `overnightBar deve ser não-vazia: ${overnightBar}`);

    // Lógica do CLI: bar = editionBar || overnightBar
    // → quando editionBar existe, overnightBar é ignorado
    const bar = editionBar || overnightBar;
    assert.equal(bar, editionBar, "editionBar deve ter prioridade sobre overnightBar");
    assert.ok(bar.includes("edição 260615"), `barra deve mostrar a edição: ${bar}`);
    assert.ok(!bar.includes("(1/3)"), `barra não deve mostrar overnight stats: ${bar}`);
  });

  it("sem edição, overnightBar é usada como fallback", () => {
    const overnightPlan: Plan = {
      issues: [
        { status: "mergeada" },
        { status: "elegivel" },
      ],
    };

    // Sem edição → editionBar vazia
    const editionBar = renderEditionBar(null);
    const overnightBar = renderOvernightBar(overnightPlan);

    const bar = editionBar || overnightBar;
    assert.equal(bar, overnightBar, "sem edição, overnightBar deve ser usada");
    assert.ok(bar.includes("(1/2)"), `barra deve mostrar overnight stats: ${bar}`);
  });

  it("edição encerrada: readCurrentEditionDoc retorna null → overnight bar é mostrada (Finding #1)", () => {
    // Fix #1: readCurrentEditionDoc skips encerrada editions → CLI uses overnightBar.
    // renderEditionBar(doc) still renders 7/7 when called directly (see renderEditionBar tests),
    // but at the CLI level, editionDoc is null → editionBar is "" → overnight takes over.
    const overnightPlan: Plan = {
      issues: [{ status: "mergeada" }, { status: "mergeada" }, { status: "elegivel" }],
    };

    // Simulate what the CLI does when readCurrentEditionDoc returns null (encerrada):
    const editionBar = renderEditionBar(null); // null because readCurrentEditionDoc skips encerrada
    const overnightBar = renderOvernightBar(overnightPlan);

    assert.equal(editionBar, "", "sem edição em curso, editionBar deve ser vazia");
    assert.ok(overnightBar.length > 0, `overnightBar deve ser não-vazia: ${overnightBar}`);
    const bar = editionBar || overnightBar;
    assert.equal(bar, overnightBar, "overnight bar deve ser usada quando edição encerrada");
    assert.ok(bar.includes("(2/3)"), `bar deve mostrar overnight stats (2 terminais / 3 total): ${bar}`);
  });
});

// ─── integração com disco: precedência real edition+overnight (#2301) ─────────
// Estes testes exercitam o caminho completo do CLI:
//   readCurrentEditionDoc(cwd) → readTodayPlan(cwd) → editionBar || overnightBar
// usando fixtures reais em tmpdir, confirmando que a precedência funciona
// não apenas via chamadas diretas às funções puras, mas via detecção no disco.

describe("integração disco: edição em curso + rodada overnight simultâneos (#2301)", () => {
  const tmpRoot = join(tmpdir(), `edition-overnight-integration-${Date.now()}`);

  // Helper: escreve stage-status.json em data/editions/{AAMMDD}/_internal/
  // Uses the shared writeStageStatus helper defined at the top of this file.
  function writeEditionStatus(id: string, doc: StageStatusDoc): void {
    writeStageStatus(join(tmpRoot, "data", "editions", id), doc);
  }

  // Helper: escreve plan.json em data/overnight/{AAMMDD}/
  function writeOvernightPlan(id: string, plan: Plan): void {
    const planDir = join(tmpRoot, "data", "overnight", id);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "plan.json"), JSON.stringify(plan), "utf8");
  }

  // Register cleanup FIRST — before any throwable setup — so tmpRoot is always cleaned up.
  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Setup: 1 edição em progresso + 1 rodada overnight ativa
  const editionDocInProgress = makeDoc("260615", ["done", "done", "running", "pending", "pending", "pending", "pending"]);
  const overnightPlanActive: Plan = {
    started_at: "2026-06-14T22:00:00.000Z",
    issues: [
      { number: 1001, status: "mergeada" },
      { number: 1002, status: "mergeada" },
      { number: 1003, status: "elegivel" },
    ],
  };

  writeEditionStatus("260615", editionDocInProgress);
  writeOvernightPlan("260614", overnightPlanActive);

  it("edição em progresso + overnight ativo: edição ganha (precedência via disco)", () => {
    // Lê do disco — reproduz exatamente o que o CLI faz.
    // CLI (ln 490): bar = editionBar || renderOvernightBar(readTodayPlan(cwd))
    // O overnight só é lido quando editionBar é vazio (short-circuit real do CLI).
    // O teste verifica a BARRA FINAL usando o mesmo operador, sem re-implementação.
    const editionDoc = readCurrentEditionDoc(tmpRoot);
    const editionBar = renderEditionBar(editionDoc);

    // Mirror CLI short-circuit: compute overnightBar independently to assert both exist,
    // but use the same || short-circuit to derive `bar` as the CLI would.
    const overnightPlan = readTodayPlan(tmpRoot);
    const overnightBar = renderOvernightBar(overnightPlan);

    // CLI logic: bar = editionBar || overnightBar
    const bar = editionBar || overnightBar;

    // Ambos os planos são lidos corretamente
    assert.ok(editionBar.length > 0, `editionBar deve estar presente no disco: ${editionBar}`);
    assert.ok(overnightBar.length > 0, `overnightBar deve estar presente no disco: ${overnightBar}`);

    // Edição tem prioridade
    assert.equal(bar, editionBar, "editionBar deve ter prioridade sobre overnightBar (precedência via disco)");
    assert.ok(bar.includes("edição 260615"), `barra deve mostrar a edição ativa: ${bar}`);
    assert.ok(bar.includes("Escrita"), `barra deve mostrar stage 'Escrita' (running): ${bar}`);
    assert.ok(bar.includes("2/7"), `barra deve mostrar 2/7 (2 done): ${bar}`);
    // Overnight NÃO deve aparecer
    assert.ok(!bar.includes("(2/3)"), `overnight stats não devem aparecer enquanto edição ativa: ${bar}`);
  });

  it("edição encerrada + overnight ativo: overnight retoma (precedência via disco)", () => {
    // Cria um tmpRoot isolado para este case (garante isolamento)
    const isolatedRoot = join(tmpdir(), `edition-overnight-resumed-${Date.now()}`);

    const docEncerrada = makeDoc("260615", ["done", "done", "done", "done", "done", "done", "done"]);
    const planAtivo: Plan = {
      started_at: "2026-06-14T22:00:00.000Z",
      issues: [
        { number: 2001, status: "mergeada" },
        { number: 2002, status: "elegivel" },
        { number: 2003, status: "elegivel" },
      ],
    };

    try {
      // Escreve diretamente no isolated root (inside try so finally always runs)
      const editionDir = join(isolatedRoot, "data", "editions", "260615");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(join(editionDir, "_internal", "stage-status.json"), JSON.stringify(docEncerrada, null, 2), "utf8");

      const overnightDir = join(isolatedRoot, "data", "overnight", "260614");
      mkdirSync(overnightDir, { recursive: true });
      writeFileSync(join(overnightDir, "plan.json"), JSON.stringify(planAtivo), "utf8");
      const editionDoc = readCurrentEditionDoc(isolatedRoot);
      const editionBar = renderEditionBar(editionDoc);
      const overnightBar = renderOvernightBar(readTodayPlan(isolatedRoot));

      const bar = editionBar || overnightBar;

      // readCurrentEditionDoc deve retornar null para edição encerrada
      assert.equal(editionDoc, null, "edição encerrada deve retornar null de readCurrentEditionDoc");
      assert.equal(editionBar, "", "editionBar deve ser vazia quando edição encerrada");

      // Overnight deve assumir o display
      assert.ok(overnightBar.length > 0, `overnightBar deve estar presente: ${overnightBar}`);
      assert.equal(bar, overnightBar, "overnight deve assumir o display quando edição encerra");
      assert.ok(bar.includes("(1/3)"), `barra overnight deve mostrar 1 terminal de 3: ${bar}`);
      assert.ok(bar.includes("33%"), `barra overnight deve mostrar 33%: ${bar}`);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("sem edição nem overnight: barra é string vazia (idle)", () => {
    const idleRoot = join(tmpdir(), `edition-overnight-idle-${Date.now()}`);
    mkdirSync(join(idleRoot, "data", "editions"), { recursive: true });
    mkdirSync(join(idleRoot, "data", "overnight"), { recursive: true });

    try {
      const editionDoc = readCurrentEditionDoc(idleRoot);
      const editionBar = renderEditionBar(editionDoc);
      const plan = readTodayPlan(idleRoot);
      const overnightBar = renderOvernightBar(plan);

      const bar = editionBar || overnightBar;

      assert.equal(editionDoc, null, "sem edição: deve retornar null");
      assert.equal(plan, null, "sem overnight: deve retornar null");
      assert.equal(bar, "", "idle: barra deve ser string vazia");
    } finally {
      rmSync(idleRoot, { recursive: true, force: true });
    }
  });
});

// ─── renderEditionBar — label correto por stage (#2301) ──────────────────────
// Verifica que cada stage produz o label correto no output renderizado.
// Garante que STAGE_LABELS[N] está corretamente mapeado e visível na barra.

describe("renderEditionBar — label por stage (#2301)", () => {
  // Use canonical STAGE_LABELS from production source — label renames will fail here, not drift silently.
  const stageLabels: Array<[number, string]> = Object.entries(STAGE_LABELS).map(
    ([k, v]) => [Number(k), v],
  );

  for (const [stageIdx, expectedLabel] of stageLabels) {
    it(`stage ${stageIdx} running → label '${expectedLabel}'`, () => {
      // Todos stages anteriores done, stage stageIdx running, restantes pending
      const statuses: Array<"pending" | "running" | "done" | "failed"> = Array.from(
        { length: 7 },
        (_, i) => (i < stageIdx ? "done" : i === stageIdx ? "running" : "pending"),
      );
      const doc = makeDoc("260615", statuses);
      const result = renderEditionBar(doc);
      assert.ok(result.includes(expectedLabel), `stage ${stageIdx} deve mostrar '${expectedLabel}': ${result}`);
    });
  }
});
