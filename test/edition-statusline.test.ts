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
  type Plan,
} from "../scripts/overnight-statusline.ts";
import type { StageStatusDoc } from "../scripts/update-stage-status.ts";

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

  it("detecta edição encerrada (todos done) como mais recente — barra fica visível", () => {
    const root = join(tmpdir(), `edition-test-done-${Date.now()}`);
    const editionDir = join(root, "data", "editions", "260615");
    const doc = makeDoc("260615", ["done", "done", "done", "done", "done", "done", "done"]);
    writeStageStatus(editionDir, doc);
    try {
      const result = readCurrentEditionDoc(root);
      assert.ok(result !== null, "edição encerrada deve ser retornada (barra 7/7 visível)");
      assert.equal(result!.edition, "260615");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── readCurrentEditionDoc — múltiplas edições ───────────────────────────────

describe("readCurrentEditionDoc — múltiplas edições (determinístico, sem clock)", () => {
  const tmpRoot = join(tmpdir(), `edition-test-multi-${Date.now()}`);

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("escolhe a edição MAIS RECENTE (lexicográfico desc) que tem atividade", () => {
    // Setup:
    //   260613 — stage 1 done, stage 2 running
    //   260614 — stage 0 done, stage 1 running  ← mais recente
    const dir260613 = join(tmpRoot, "data", "editions", "260613");
    const dir260614 = join(tmpRoot, "data", "editions", "260614");

    const doc260613 = makeDoc("260613", ["done", "done", "running", "pending", "pending", "pending", "pending"]);
    const doc260614 = makeDoc("260614", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);

    writeStageStatus(dir260613, doc260613);
    writeStageStatus(dir260614, doc260614);

    const result = readCurrentEditionDoc(tmpRoot);
    assert.ok(result !== null, "deve retornar edição");
    assert.equal(result!.edition, "260614", `deve escolher 260614 (mais recente), got ${result!.edition}`);
  });

  it("se a mais recente está all-pending (não iniciada), usa a próxima mais recente com atividade", () => {
    // Setup:
    //   260614 — com atividade (detectada acima, já criada)
    //   260615 — all-pending (não iniciada) ← mais recente mas deve ser ignorada
    const dir260615 = join(tmpRoot, "data", "editions", "260615");
    const docAllPending = makeDoc("260615", ["pending", "pending", "pending", "pending", "pending", "pending", "pending"]);
    writeStageStatus(dir260615, docAllPending);

    const result = readCurrentEditionDoc(tmpRoot);
    assert.ok(result !== null, "deve retornar edição com atividade");
    // 260615 é all-pending → deve cair para 260614 (com atividade)
    assert.equal(result!.edition, "260614", `deve pular 260615 all-pending e usar 260614, got ${result!.edition}`);
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

  it("edição encerrada: editionBar ainda não-vazia (7/7) → overnight permanece supresso", () => {
    // Edição encerrada ainda ocupa a statusLine (barra em 7/7 — mirrors #2246)
    // overnight só volta quando edição encerrada não é mais a mais-recente
    const editionDoc = makeDoc("260615", ["done", "done", "done", "done", "done", "done", "done"]);
    const overnightPlan: Plan = {
      issues: [{ status: "mergeada" }, { status: "mergeada" }, { status: "elegivel" }],
    };

    const editionBar = renderEditionBar(editionDoc);
    const overnightBar = renderOvernightBar(overnightPlan);

    assert.ok(editionBar.length > 0, `editionBar encerrada deve ser não-vazia: ${editionBar}`);
    const bar = editionBar || overnightBar;
    assert.equal(bar, editionBar, "edição encerrada ainda suprime overnight");
    assert.ok(bar.includes("7/7"), `bar deve mostrar 7/7: ${bar}`);
  });
});
