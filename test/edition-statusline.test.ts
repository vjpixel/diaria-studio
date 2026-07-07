/**
 * test/edition-statusline.test.ts (#2250, #2618, #2760)
 *
 * Testes da função pura `renderEditionBar` e do detector `readCurrentEditionDoc`
 * que alimentam a statusLine do Claude Code durante uma edição em curso.
 * #2618: + `renderStatusline` (composição pura) e `readMostRecentEditionDoc`
 * (lê edição mais recente incluindo encerrada) — barra some após edição concluída.
 * #2760: + guard de staleness (`isStaleEditionDoc`, `EDITION_STALE_THRESHOLD_MS`) —
 * edição com row `running` travada há mais que o threshold é tratada como
 * abandonada, não "em curso". #3000: threshold revisado 24h → 6h — o guard já
 * existia e disparava corretamente, mas 24h era grande demais pra cumprir o
 * propósito (observabilidade em tempo real durante rodadas overnight longas).
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
 *   - #2760: row `running` travada >24h → readCurrentEditionDoc trata como abandonada (pula)
 *   - #2760: row `running` recente (<24h) → continua detectada normalmente (não regride)
 *   - #2760: caso legítimo (scheduled run parado em Stage 4, Stage 5 `pending` há >24h,
 *     SEM nenhuma row `running`) → NUNCA é stale, continua "em curso" (evita falso-positivo)
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
  renderIdleBar,
  findMostRecentEditionId,
  renderStatusline,
  readMostRecentEditionDoc,
  isStaleEditionDoc,
  EDITION_STALE_THRESHOLD_MS,
  type Plan,
} from "../scripts/overnight-statusline.ts";
import type { StageStatusDoc } from "../scripts/update-stage-status.ts";
import { STAGE_LABELS } from "../scripts/update-stage-status.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

// #2760: readCurrentEditionDoc now takes an injectable `now` (default `new Date()`)
// for the staleness guard. All fixtures below use `generated_at` pinned to this
// instant, so every call to readCurrentEditionDoc in this file passes FIXTURE_NOW
// explicitly — keeps tests deterministic and immune to real-clock drift (a "running"
// row with a fixture `generated_at` from the past would otherwise look abandoned
// once EDITION_STALE_THRESHOLD_MS elapses in wall-clock time since this file was written).
const FIXTURE_NOW = new Date("2026-06-15T09:00:00.000Z");

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
      const result = readCurrentEditionDoc(root, FIXTURE_NOW);
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
      const result = readCurrentEditionDoc(tmpRoot, FIXTURE_NOW);
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
      const result = readCurrentEditionDoc(tmpRoot, FIXTURE_NOW);
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
      const result = readCurrentEditionDoc(tmpRoot, FIXTURE_NOW);
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
    const editionDoc = readCurrentEditionDoc(tmpRoot, FIXTURE_NOW);
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

  it("sem edição nem overnight: fallback para idle bar (#2255, nunca string vazia)", () => {
    const idleRoot = join(tmpdir(), `edition-overnight-idle-${Date.now()}`);
    mkdirSync(join(idleRoot, "data", "editions"), { recursive: true });
    mkdirSync(join(idleRoot, "data", "overnight"), { recursive: true });

    try {
      const editionDoc = readCurrentEditionDoc(idleRoot);
      const editionBar = renderEditionBar(editionDoc);
      const plan = readTodayPlan(idleRoot);
      const overnightBar = renderOvernightBar(plan);
      // Source 3: idle bar — mirrors the CLI logic (bar = editionBar || overnightBar || renderIdleBar(...))
      const bar = editionBar || overnightBar || renderIdleBar(findMostRecentEditionId(idleRoot));

      assert.equal(editionDoc, null, "sem edição: deve retornar null");
      assert.equal(plan, null, "sem overnight: deve retornar null");
      // #2255: idle bar is ALWAYS present — never empty string
      assert.notEqual(bar, "", "idle: barra NUNCA deve ser string vazia (#2255)");
      assert.ok(bar.includes("████████████"), `idle: barra deve estar cheia: ${bar}`);
      assert.ok(bar.includes("Diar.ia"), `idle: barra deve ter label Diar.ia: ${bar}`);
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

// ─── #2255: idle bar — SEMPRE presente ────────────────────────────────────────
// Testa a source 3 (idle) do statusline: barra visível mesmo sem edição nem overnight.
// A pure function renderIdleBar() é testável independentemente do I/O.

describe("renderIdleBar — pure function (#2255)", () => {
  it("retorna barra cheia com label quando edição passada existe", () => {
    const result = renderIdleBar("260617");
    assert.ok(result.length > 0, `idle bar deve ser não-vazia: ${result}`);
    assert.ok(result.includes("████████████"), `idle bar deve ter barra cheia: ${result}`);
    assert.ok(result.includes("Diar.ia"), `idle bar deve ter label 'Diar.ia': ${result}`);
    assert.ok(result.includes("260617"), `idle bar deve incluir edição ID: ${result}`);
    assert.ok(result.includes("pronto"), `idle bar deve incluir 'pronto': ${result}`);
  });

  it("retorna barra cheia com label sem edição quando mostRecentEditionId é null", () => {
    const result = renderIdleBar(null);
    assert.ok(result.length > 0, `idle bar deve ser não-vazia para null: ${result}`);
    assert.ok(result.includes("████████████"), `idle bar deve ter barra cheia: ${result}`);
    assert.ok(result.includes("Diar.ia"), `idle bar deve ter label 'Diar.ia': ${result}`);
    assert.ok(result.includes("sem rodada ativa"), `idle bar deve incluir 'sem rodada ativa': ${result}`);
  });

  it("formato canônico com edição: '[████████████] Diar.ia · AAMMDD · pronto'", () => {
    const result = renderIdleBar("260617");
    assert.match(result, /^\[█{12}\] Diar\.ia · \d{6} · pronto$/);
  });

  it("formato canônico sem edição: '[████████████] Diar.ia · sem rodada ativa'", () => {
    const result = renderIdleBar(null);
    assert.match(result, /^\[█{12}\] Diar\.ia · sem rodada ativa$/);
  });

  it("nunca retorna string vazia — nem para null, nem para ID vazio", () => {
    assert.notEqual(renderIdleBar(null), "");
    assert.notEqual(renderIdleBar("260617"), "");
    assert.notEqual(renderIdleBar(""), ""); // empty string ID → falls back gracefully
  });
});

describe("findMostRecentEditionId — I/O helper (#2255)", () => {
  it("retorna null quando data/editions não existe", () => {
    const emptyRoot = join(tmpdir(), `idle-test-nodir-${Date.now()}`);
    mkdirSync(emptyRoot, { recursive: true });
    try {
      const id = findMostRecentEditionId(emptyRoot);
      assert.equal(id, null, "sem data/editions deve retornar null");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("retorna null quando data/editions existe mas está vazia", () => {
    const root = join(tmpdir(), `idle-test-empty-${Date.now()}`);
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    try {
      const id = findMostRecentEditionId(root);
      assert.equal(id, null, "data/editions vazia deve retornar null");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna AAMMDD mais recente quando existem múltiplas edições", () => {
    const root = join(tmpdir(), `idle-test-multi-${Date.now()}`);
    mkdirSync(join(root, "data", "editions", "260613"), { recursive: true });
    mkdirSync(join(root, "data", "editions", "260615"), { recursive: true });
    mkdirSync(join(root, "data", "editions", "260614"), { recursive: true });
    try {
      const id = findMostRecentEditionId(root);
      assert.equal(id, "260615", `deve retornar 260615 (mais recente), got ${id}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignora dirs não-AAMMDD (arquivos, dirs com nomes fora do padrão)", () => {
    const root = join(tmpdir(), `idle-test-ignore-${Date.now()}`);
    mkdirSync(join(root, "data", "editions", "260613"), { recursive: true });
    mkdirSync(join(root, "data", "editions", "archive"), { recursive: true });
    mkdirSync(join(root, "data", "editions", "_internal"), { recursive: true });
    try {
      const id = findMostRecentEditionId(root);
      assert.equal(id, "260613", `deve ignorar dirs não-AAMMDD e retornar 260613, got ${id}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna null sem throw quando data/ não existe", () => {
    const root = join(tmpdir(), `idle-test-no-data-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      assert.doesNotThrow(() => findMostRecentEditionId(root));
      const id = findMostRecentEditionId(root);
      assert.equal(id, null, "sem data/ deve retornar null");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #3054: enumerateEditionDirs só filtra estruturalmente (/^\d{6}$/) — um
  // sentinel calendário-inválido como "260999" (dia 99, leftover de teste)
  // bate no regex mas ordena lexicograficamente ACIMA de qualquer edição real
  // de 2026 ("260999" > "260707"). Sem filtrar por isValidEditionDir antes de
  // ordenar, findMostRecentEditionId retornaria "260999" em vez da edição
  // real mais recente.
  it("#3054: NUNCA escolhe sentinel calendário-inválido (260999) mesmo em layout nested", () => {
    const root = join(tmpdir(), `idle-test-sentinel-3054-${Date.now()}`);
    // Edição real, layout nested (#2463/#3025): data/editions/2607/260707/
    mkdirSync(join(root, "data", "editions", "2607", "260707"), { recursive: true });
    // Sentinel calendário-inválido remanescente de teste, também nested,
    // reproduzindo o formato exato reportado na issue: data/editions/2609/260999/
    mkdirSync(join(root, "data", "editions", "2609", "260999"), { recursive: true });
    try {
      const id = findMostRecentEditionId(root);
      assert.equal(id, "260707", `sentinel 260999 nunca deve ser escolhido como mais recente, got ${id}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#3054: sentinel calendário-inválido em layout flat (260999) também é ignorado", () => {
    const root = join(tmpdir(), `idle-test-sentinel-flat-3054-${Date.now()}`);
    mkdirSync(join(root, "data", "editions", "260707"), { recursive: true });
    mkdirSync(join(root, "data", "editions", "260999"), { recursive: true }); // dia 99
    try {
      const id = findMostRecentEditionId(root);
      assert.equal(id, "260707", `sentinel 260999 nunca deve ser escolhido como mais recente, got ${id}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("precedência completa: edição > overnight > idle (#2255)", () => {
  it("idle bar é usada como fallback final quando edição e overnight são vazios", () => {
    // Mirrors exact CLI logic: bar = editionBar || overnightBar || renderIdleBar(...)
    const editionBar = renderEditionBar(null);        // null → ""
    const overnightBar = renderOvernightBar(null);    // null → ""
    const idleBar = renderIdleBar(null);              // always non-empty

    const bar = editionBar || overnightBar || idleBar;

    assert.equal(editionBar, "", "editionBar null → vazio");
    assert.equal(overnightBar, "", "overnightBar null → vazio");
    assert.notEqual(idleBar, "", "idleBar nunca vazio");
    assert.equal(bar, idleBar, "idle bar deve ser o fallback final");
  });

  it("idle bar nunca aparece quando overnight está ativo (barra não-vazia)", () => {
    const editionBar = renderEditionBar(null);
    const overnightPlan: Plan = { issues: [{ status: "elegivel" }] };
    const overnightBar = renderOvernightBar(overnightPlan);
    const idleBar = renderIdleBar(null);

    const bar = editionBar || overnightBar || idleBar;

    assert.notEqual(overnightBar, "", "overnight bar deve estar presente");
    assert.equal(bar, overnightBar, "overnight bar deve ter prioridade sobre idle");
    assert.ok(!bar.includes("Diar.ia"), `idle label não deve aparecer quando overnight ativo: ${bar}`);
  });

  it("idle bar nunca aparece quando edição está ativa", () => {
    const editionDoc = makeDoc("260617", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);
    const editionBar = renderEditionBar(editionDoc);
    const overnightBar = renderOvernightBar(null);
    const idleBar = renderIdleBar("260617");

    const bar = editionBar || overnightBar || idleBar;

    assert.notEqual(editionBar, "", "edition bar deve estar presente");
    assert.equal(bar, editionBar, "edition bar deve ter prioridade sobre idle");
    assert.ok(!bar.includes("sem rodada ativa"), `idle label não deve aparecer: ${bar}`);
  });

  it("degradação: qualquer falha de leitura resulta em idle bar (nunca vazia, nunca throw)", () => {
    // Simulate corruption — renderIdleBar(null) is the ultimate fallback
    // Tests that the pure function chain never throws even with all-null inputs
    assert.doesNotThrow(() => {
      const bar = renderEditionBar(null) || renderOvernightBar(null) || renderIdleBar(null);
      assert.notEqual(bar, "", "barra nunca deve ser vazia mesmo com todos os inputs null");
    });
  });
});

// ─── #2618: renderStatusline — barra some após edição concluída ───────────────

/**
 * Testes de regressão para #2618: renderStatusline não produz barra de progresso
 * quando a edição mais recente está concluída (todos stages terminais) e não há
 * overnight ativa.
 *
 * Coberturas obrigatórias (#633):
 *   - Edição CONCLUÍDA + sem overnight → sem barra (output vazio ou só branch)
 *   - Edição EM CURSO + sem overnight → barra de progresso presente
 *   - Edição CONCLUÍDA + overnight ativo → barra de overnight presente (não some)
 *   - Sem edição + sem overnight → idle bar presente (não some)
 *   - renderStatusline é função pura (sem I/O) — testável diretamente
 */

// Reusa o helper makeDoc (topo do arquivo) — não duplicar a factory de StageStatusDoc.

function makeActivePlanForStatusline(): Plan {
  return {
    started_at: "2026-06-26T22:00:00.000Z",
    issues: [
      { number: 1, status: "elegivel" },
      { number: 2, status: "mergeada" },
    ],
  };
}

/** Doc de edição 100% concluída — equivalente ao que mostRecentDoc seria quando encerrada. */
function makeEncerradaDoc(edition: string): StageStatusDoc {
  return makeDoc(edition, Array(7).fill("done") as Array<"done">);
}

describe("renderStatusline — #2618: barra some após edição concluída", () => {
  it("edição CONCLUÍDA (todos done) + sem overnight → output sem barra (só branch ou vazio)", () => {
    // editionDoc=null porque readCurrentEditionDoc filtra edições encerradas;
    // mostRecentDoc com todos done → encerrada detectada por construção (#2624 Finding 1).
    const result = renderStatusline(
      null,                       // editionDoc null (encerrada não aparece aqui — readCurrentEditionDoc skip)
      null,                       // sem overnight
      "260626",                   // mostRecentEditionId
      makeEncerradaDoc("260626"), // mostRecentDoc com todos done (#2618 + #2624)
      "master",
    );
    // #2618: barra some — output deve ser apenas "master" (sem barra de progresso)
    assert.equal(result, "master", `edição concluída deve suprimir a barra: "${result}"`);
    // Não deve conter caracteres de barra de progresso
    assert.ok(!result.includes("["), `output não deve conter barra [: "${result}"`);
    assert.ok(!result.includes("█"), `output não deve conter blocos cheios: "${result}"`);
    assert.ok(!result.includes("░"), `output não deve conter blocos vazios: "${result}"`);
  });

  it("edição CONCLUÍDA sem branch + sem overnight → output vazio", () => {
    const result = renderStatusline(null, null, "260626", makeEncerradaDoc("260626"), "");
    // branch vazio + barra some = string vazia
    assert.equal(result, "", `edição concluída sem branch deve retornar "": "${result}"`);
  });

  it("edição EM CURSO (tem stage running) + sem overnight → barra de progresso presente", () => {
    // Stage 0 done, stage 1 running, demais pending = em curso
    const inProgressDoc = makeDoc("260626", [
      "done", "running", "pending", "pending", "pending", "pending", "pending",
    ]);
    const result = renderStatusline(
      inProgressDoc,  // editionDoc não-null = em curso
      null,
      "260626",
      inProgressDoc,  // mostRecentDoc = mesmo doc (encerrada=false por construção: editionDoc≠null)
      "master",
    );
    // Deve conter barra de progresso da edição
    assert.ok(result.includes("edição 260626"), `deve exibir a edição: "${result}"`);
    assert.ok(result.includes("["), `deve conter barra [: "${result}"`);
  });

  it("edição CONCLUÍDA + overnight ATIVO → barra de overnight presente (não some)", () => {
    // Edição encerrada, mas overnight tem issues em andamento → overnight bar deve aparecer
    const activePlan = makeActivePlanForStatusline();
    const result = renderStatusline(
      null,                       // sem edição em curso
      activePlan,                 // overnight ativo
      "260626",
      makeEncerradaDoc("260626"), // edição encerrada
      "master",
    );
    // A barra de overnight deve aparecer (overnight tem prioridade sobre "barra some")
    assert.ok(result.includes("["), `barra de overnight deve aparecer: "${result}"`);
    // 1 mergeada de 2 issues → 50% exato (assert do valor, não só presença de '%')
    assert.ok(result.includes("50%"), `deve mostrar progresso overnight 50%: "${result}"`);
    assert.ok(result.includes("(1/2)"), `deve mostrar (1/2): "${result}"`);
    assert.ok(!result.includes("edição 260626"), `não deve mostrar edição (encerrada): "${result}"`);
  });

  it("sem edição alguma + sem overnight → idle bar presente (não some)", () => {
    // Sem nenhuma edição em disco: mostRecentDoc=null → encerrada=false por construção
    const result = renderStatusline(
      null,    // sem edição
      null,    // sem overnight
      null,    // sem edição recente
      null,    // mostRecentDoc null (não há edição no disco)
      "master",
    );
    // Deve mostrar idle bar (não suprimir)
    assert.ok(result.includes("["), `idle bar deve aparecer: "${result}"`);
    assert.ok(result.includes("Diar.ia"), `idle bar deve conter 'Diar.ia': "${result}"`);
  });

  it("edição CONCLUÍDA: renderStatusline é pura — chamadas repetidas produzem mesmo resultado", () => {
    const encerradaDoc = makeEncerradaDoc("260625");
    const args: Parameters<typeof renderStatusline> = [null, null, "260625", encerradaDoc, "feature/test"];
    const r1 = renderStatusline(...args);
    const r2 = renderStatusline(...args);
    assert.equal(r1, r2, "função pura deve ser idempotente");
    assert.equal(r1, "feature/test", `deve retornar só o branch: "${r1}"`);
  });
});

// ─── #2618: readMostRecentEditionDoc — lê edição encerrada (não filtra) ──────

describe("readMostRecentEditionDoc — lê última edição incluindo encerrada (#2618)", () => {
  const tmpRoot = join(tmpdir(), `most-recent-edition-test-${Date.now()}`);

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("retorna doc de edição encerrada (readCurrentEditionDoc filtraria, esta não)", () => {
    // Criar edição encerrada (todos done)
    const editionDir = join(tmpRoot, "data", "editions", "260626");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    const doc: import("../scripts/update-stage-status.ts").StageStatusDoc = {
      edition: "260626",
      rows: Array.from({ length: 7 }, (_, i) => ({ stage: i, status: "done" as const })),
      generated_at: "2026-06-26T08:00:00.000Z",
    };
    writeFileSync(join(editionDir, "_internal", "stage-status.json"), JSON.stringify(doc), "utf8");

    // readCurrentEditionDoc retorna null (filtra encerrada)
    const currentDoc = readCurrentEditionDoc(tmpRoot);
    assert.equal(currentDoc, null, "readCurrentEditionDoc deve filtrar edição encerrada");

    // readMostRecentEditionDoc retorna o doc mesmo encerrado
    const mostRecentDoc = readMostRecentEditionDoc(tmpRoot);
    assert.ok(mostRecentDoc !== null, "readMostRecentEditionDoc deve retornar doc encerrado");
    assert.equal(mostRecentDoc!.edition, "260626");
    assert.ok(mostRecentDoc!.rows.every((r) => r.status === "done"), "todos os rows devem ser done");
  });

  it("retorna null quando não há edições", () => {
    const emptyRoot = join(tmpdir(), `most-recent-empty-${Date.now()}`);
    mkdirSync(join(emptyRoot, "data", "editions"), { recursive: true });
    try {
      const doc = readMostRecentEditionDoc(emptyRoot);
      assert.equal(doc, null, "sem edições deve retornar null");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

// ─── #2618: integração de disco — wiring completo do CLI (readers → renderStatusline) ─
// O bug original (#2618) está no CLI: edição encerrada em disco deve fazer a barra sumir.
// Este teste exercita a CADEIA real via I/O (não só as funções puras isoladas), espelhando
// o entrypoint: readCurrentEditionDoc → null, readMostRecentEditionDoc → doc encerrado,
// mostRecentEditionId derivado de mostRecentDoc.edition, mostRecentEditionEncerrada → true.

describe("integração de disco #2618 — edição encerrada faz a barra sumir (wiring CLI)", () => {
  const tmpRoot = join(tmpdir(), `statusline-cli-wiring-${Date.now()}`);

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Replica o wiring do entrypoint do CLI (sem git/process), de forma determinística.
  function composeFromDisk(cwd: string, branch: string): string {
    const editionDoc = readCurrentEditionDoc(cwd);
    const plan = readTodayPlan(cwd);
    const mostRecentDoc = editionDoc ?? readMostRecentEditionDoc(cwd);
    const mostRecentEditionId = mostRecentDoc?.edition ?? findMostRecentEditionId(cwd);
    // #2624 Finding 1: passa mostRecentDoc diretamente — renderStatusline deriva encerrada internamente.
    return renderStatusline(editionDoc, plan, mostRecentEditionId, mostRecentDoc, branch);
  }

  it("edição encerrada em disco (todos done) + sem overnight → barra some (só branch)", () => {
    const editionDir = join(tmpRoot, "data", "editions", "260626");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    const doc: import("../scripts/update-stage-status.ts").StageStatusDoc = {
      edition: "260626",
      rows: Array.from({ length: 7 }, (_, i) => ({ stage: i, status: "done" as const })),
      generated_at: "2026-06-26T08:00:00.000Z",
    };
    writeFileSync(join(editionDir, "_internal", "stage-status.json"), JSON.stringify(doc), "utf8");

    const output = composeFromDisk(tmpRoot, "master");
    // #2618: a barra deve sumir — output é só o branch, sem barra de progresso
    assert.equal(output, "master", `edição encerrada em disco deve suprimir a barra: "${output}"`);
    assert.ok(!output.includes("["), `não deve conter barra: "${output}"`);
  });
});

// ─── #2760: guard de staleness — edição travada em "running" é tratada como abandonada ─
//
// Bug relatado: `data/editions/260623/_internal/stage-status.json` tinha
// `{ stage: 5, status: "running", start: "2026-06-23T02:23:06.933Z" }` que nunca
// transicionou pra done/failed (crash durante o workaround manual do CSP do
// Beehiiv, #2495). A statusline reportava essa edição de mais de uma semana
// atrás como "em curso" — indistinguível de uma run ativa agora.
//
// isStaleEditionDoc(doc, now) → true quando há row `status:"running"` cujo
// `start` (ou `generated_at` de fallback) é mais antigo que
// EDITION_STALE_THRESHOLD_MS (24h) em relação a `now`. readCurrentEditionDoc
// pula (trata como encerrada) qualquer doc stale nesse sentido.

describe("isStaleEditionDoc — função pura (#2760)", () => {
  it("EDITION_STALE_THRESHOLD_MS é exatamente 6h em ms (#3000 — revisado de 24h)", () => {
    assert.equal(EDITION_STALE_THRESHOLD_MS, 6 * 60 * 60 * 1000);
  });

  it("row running com start >24h atrás → stale (true)", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const doc: StageStatusDoc = {
      edition: "260623",
      generated_at: "2026-06-23T02:23:06.933Z",
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "done" },
        { stage: 2, status: "done" },
        { stage: 3, status: "done" },
        { stage: 4, status: "done" },
        // Reproduz o caso exato relatado na issue: stage 5 preso em running.
        { stage: 5, status: "running", start: "2026-06-23T02:23:06.933Z" },
        { stage: 6, status: "pending" },
      ],
    };
    assert.equal(isStaleEditionDoc(doc, now), true, "row running de 7 dias atrás deve ser stale");
  });

  it("row running com start <24h atrás → não-stale (false)", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const doc: StageStatusDoc = {
      edition: "260630",
      generated_at: "2026-06-30T10:00:00.000Z",
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "running", start: "2026-06-30T10:00:00.000Z" }, // 2h atrás
        { stage: 2, status: "pending" },
      ],
    };
    assert.equal(isStaleEditionDoc(doc, now), false, "row running de 2h atrás não deve ser stale");
  });

  it("row running exatamente no limiar (24h - 1ms) → não-stale; (24h + 1ms) → stale", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const justUnder: StageStatusDoc = {
      edition: "260629",
      generated_at: now.toISOString(),
      rows: [{ stage: 1, status: "running", start: new Date(now.getTime() - EDITION_STALE_THRESHOLD_MS + 1).toISOString() }],
    };
    const justOver: StageStatusDoc = {
      edition: "260629",
      generated_at: now.toISOString(),
      rows: [{ stage: 1, status: "running", start: new Date(now.getTime() - EDITION_STALE_THRESHOLD_MS - 1).toISOString() }],
    };
    assert.equal(isStaleEditionDoc(justUnder, now), false, "1ms sob o limiar não deve ser stale");
    assert.equal(isStaleEditionDoc(justOver, now), true, "1ms sobre o limiar deve ser stale");
  });

  // #3000: reprodução exata do incidente ao vivo 260705/260706. O guard
  // isStaleEditionDoc SEMPRE existiu e disparava — o bug era que o threshold
  // de 24h era grande demais: às 15:41Z (13h após o stall) a edição ainda não
  // batia 24h, então a barra do Overnight (genuinamente ativa em paralelo)
  // continuava mascarada. Com o threshold revisado pra 6h, esse caso real
  // passa a ser detectado como stale bem antes.
  it("#3000: Stage 5 travado em running há 13h (fixture real 260706) → stale com threshold 6h", () => {
    const now = new Date("2026-07-06T15:41:00.000Z"); // momento do dispatch, ~13h após o stall
    const doc: StageStatusDoc = {
      edition: "260706",
      generated_at: "2026-07-06T01:42:21.287Z", // nunca atualizado após o stall — igual ao arquivo real
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "done" },
        { stage: 2, status: "done" },
        { stage: 3, status: "done" },
        { stage: 4, status: "done" },
        // Reproduz exatamente data/editions/260706/_internal/stage-status.json
        // no momento do incidente: Stage 5 preso em "running" desde 01:42:21Z,
        // nunca transicionou (integração LinkedIn/Make.com quebrada, #3009).
        { stage: 5, status: "running", start: "2026-07-06T01:42:21.287Z" },
        { stage: 6, status: "pending" },
      ],
    };
    assert.equal(
      isStaleEditionDoc(doc, now),
      true,
      "13h de stall deve ser stale com o threshold revisado de 6h (era falso-negativo com o antigo 24h)",
    );
  });

  it("#3000: mesma fixture, mas Stage 5 iniciado há poucos minutos → NÃO stale (edição genuinamente em curso)", () => {
    const now = new Date("2026-07-06T02:00:00.000Z"); // ~18min após o start
    const doc: StageStatusDoc = {
      edition: "260706",
      generated_at: "2026-07-06T01:42:21.287Z",
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "done" },
        { stage: 2, status: "done" },
        { stage: 3, status: "done" },
        { stage: 4, status: "done" },
        { stage: 5, status: "running", start: "2026-07-06T01:42:21.287Z" },
        { stage: 6, status: "pending" },
      ],
    };
    assert.equal(
      isStaleEditionDoc(doc, now),
      false,
      "Stage 5 iniciado há minutos não deve ser tratado como abandonado — não pode regredir o caso normal",
    );
  });

  // #3000: threshold não pode ser tão agressivo a ponto de penalizar o gate humano
  // do Stage 4, que pode legitimamente rodar várias horas (espera do editor). Caso
  // real observado: start 21:17, end 01:41 (~4.4h). Esse caso não deve nunca ser
  // avaliado por isStaleEditionDoc pois Stage 4 termina em "done", não fica preso em
  // "running" (ver docblock de EDITION_STALE_THRESHOLD_MS) — mas outra edição com um
  // Stage 4 ainda `running` há ~4.4h (gate ainda sendo apresentado na mesma sessão)
  // não deve ser marcada como stale pelo threshold revisado de 6h.
  it("#3000: Stage 4 (gate humano) running há ~4.4h → NÃO stale (tolerância ao caso legítimo de espera de gate)", () => {
    const now = new Date("2026-07-06T01:41:00.000Z");
    const doc: StageStatusDoc = {
      edition: "260706b",
      generated_at: "2026-07-05T21:17:00.000Z",
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "done" },
        { stage: 2, status: "done" },
        { stage: 3, status: "done" },
        // Gate humano do Stage 4 apresentado há ~4.4h (21:17 → 01:41) — dentro
        // do threshold revisado de 6h, não deve disparar falso-positivo.
        { stage: 4, status: "running", start: "2026-07-05T21:17:00.000Z" },
        { stage: 5, status: "pending" },
        { stage: 6, status: "pending" },
      ],
    };
    assert.equal(
      isStaleEditionDoc(doc, now),
      false,
      "gate humano de ~4.4h não deve ser marcado como stale com o threshold revisado de 6h",
    );
  });

  it("sem nenhuma row running (ex: pending esperando disparo manual) → NUNCA stale, mesmo muito velha", () => {
    // Caso legítimo descoberto na investigação: o run agendado
    // (docs/scheduled-edicao-setup.md) roda Stages 0-4 às 14h e encerra o
    // processo normalmente com Stage 4 done, Stage 5 pending — sem nenhuma
    // row running. O editor pode disparar o Stage 5 manualmente dias depois
    // (o schedule não roda sexta/sábado). Isso NUNCA deve ser tratado como
    // abandonado, não importa o quão velho o generated_at seja.
    const now = new Date("2026-06-30T12:00:00.000Z"); // vários dias após o generated_at
    const doc: StageStatusDoc = {
      edition: "260620",
      generated_at: "2026-06-20T14:30:00.000Z", // 10 dias atrás
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "done" },
        { stage: 2, status: "done" },
        { stage: 3, status: "done" },
        { stage: 4, status: "done" },
        { stage: 5, status: "pending" }, // aguardando /diaria-5-publicacao manual
        { stage: 6, status: "pending" },
      ],
    };
    assert.equal(isStaleEditionDoc(doc, now), false, "sem row running, nunca deve ser stale (evita falso-positivo #2760)");
  });

  it("doc all-done (encerrada) → false (isEncerrada já cobre esse caso separadamente, mas a função em si não deve throw nem marcar stale)", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const doc: StageStatusDoc = {
      edition: "260620",
      generated_at: "2026-06-20T14:30:00.000Z",
      rows: Array.from({ length: 7 }, (_, i) => ({ stage: i, status: "done" as const })),
    };
    assert.equal(isStaleEditionDoc(doc, now), false);
  });

  it("row running sem `start` cai pro `generated_at` do doc como fallback", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const docOld: StageStatusDoc = {
      edition: "260620",
      generated_at: "2026-06-20T14:30:00.000Z", // 10 dias atrás
      rows: [{ stage: 1, status: "running" }], // sem start
    };
    const docRecent: StageStatusDoc = {
      edition: "260630",
      generated_at: "2026-06-30T10:00:00.000Z", // 2h atrás
      rows: [{ stage: 1, status: "running" }], // sem start
    };
    assert.equal(isStaleEditionDoc(docOld, now), true, "sem start, generated_at velho deve ser stale");
    assert.equal(isStaleEditionDoc(docRecent, now), false, "sem start, generated_at recente não deve ser stale");
  });

  it("timestamp não-parseável (nem start nem generated_at válidos) → fail-open (false), sem throw", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const doc: StageStatusDoc = {
      edition: "260620",
      generated_at: "not-a-date",
      rows: [{ stage: 1, status: "running", start: "also-not-a-date" }],
    };
    assert.doesNotThrow(() => isStaleEditionDoc(doc, now));
    assert.equal(isStaleEditionDoc(doc, now), false, "timestamps malformados devem fail-open (não esconder a edição)");
  });
});

describe("readCurrentEditionDoc — guard de staleness end-to-end via disco (#2760)", () => {
  it("edição com stage running travado >24h → tratada como abandonada, retorna null", () => {
    // Reproduz o caso relatado: 260623 travada no Stage 5 (running, nunca transicionou).
    const root = join(tmpdir(), `edition-test-stale-${Date.now()}`);
    const editionDir = join(root, "data", "editions", "260623");
    const doc: StageStatusDoc = {
      edition: "260623",
      generated_at: "2026-06-23T02:23:06.933Z",
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "done" },
        { stage: 2, status: "done" },
        { stage: 3, status: "done" },
        { stage: 4, status: "done" },
        { stage: 5, status: "running", start: "2026-06-23T02:23:06.933Z" },
        { stage: 6, status: "pending" },
      ],
    };
    writeStageStatus(editionDir, doc);
    try {
      // "now" = 260701 (dias depois), espelhando o observado ao vivo na issue.
      const result = readCurrentEditionDoc(root, new Date("2026-07-01T12:00:00.000Z"));
      assert.equal(result, null, "edição travada >24h em running deve ser tratada como abandonada (null)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição com stage running recente (2h atrás) → CONTINUA detectada normalmente (não regride)", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const root = join(tmpdir(), `edition-test-fresh-running-${Date.now()}`);
    const editionDir = join(root, "data", "editions", "260630");
    const doc: StageStatusDoc = {
      edition: "260630",
      generated_at: "2026-06-30T10:00:00.000Z",
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "running", start: "2026-06-30T10:00:00.000Z" },
        { stage: 2, status: "pending" },
        { stage: 3, status: "pending" },
        { stage: 4, status: "pending" },
        { stage: 5, status: "pending" },
        { stage: 6, status: "pending" },
      ],
    };
    writeStageStatus(editionDir, doc);
    try {
      const result = readCurrentEditionDoc(root, now);
      assert.ok(result !== null, "edição com running recente deve continuar sendo detectada como em curso");
      assert.equal(result!.edition, "260630");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição legítima parada em Stage 5 pending (sem running) há >24h → continua 'em curso', NÃO stale", () => {
    // Caso do scheduled run (docs/scheduled-edicao-setup.md): Stages 0-4 done,
    // Stage 5 pending aguardando disparo manual — pode levar dias (fim de
    // semana). Não deve ser escondida da statusline mesmo que generated_at
    // seja bem antigo.
    const now = new Date("2026-06-30T12:00:00.000Z");
    const root = join(tmpdir(), `edition-test-legit-pending-${Date.now()}`);
    const editionDir = join(root, "data", "editions", "260620");
    const doc: StageStatusDoc = {
      edition: "260620",
      generated_at: "2026-06-20T14:30:00.000Z", // 10 dias atrás
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "done" },
        { stage: 2, status: "done" },
        { stage: 3, status: "done" },
        { stage: 4, status: "done" },
        { stage: 5, status: "pending" },
        { stage: 6, status: "pending" },
      ],
    };
    writeStageStatus(editionDir, doc);
    try {
      const result = readCurrentEditionDoc(root, now);
      assert.ok(result !== null, "Stage 5 pending sem running não deve ser tratado como abandonado (falso-positivo #2760)");
      assert.equal(result!.edition, "260620");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição stale mais recente é pulada, cai para uma edição anterior ainda em curso e válida", () => {
    const now = new Date("2026-07-01T12:00:00.000Z");
    const root = join(tmpdir(), `edition-test-stale-fallback-${Date.now()}`);
    const dir260623 = join(root, "data", "editions", "260623");
    const dir260620 = join(root, "data", "editions", "260620");

    const staleDoc: StageStatusDoc = {
      edition: "260623",
      generated_at: "2026-06-23T02:23:06.933Z",
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "running", start: "2026-06-23T02:23:06.933Z" },
        { stage: 2, status: "pending" },
      ],
    };
    const olderInProgressDoc: StageStatusDoc = {
      edition: "260620",
      generated_at: "2026-06-20T14:30:00.000Z",
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "done" },
        { stage: 2, status: "pending" }, // sem running — não é stale por definição
      ],
    };

    writeStageStatus(dir260623, staleDoc);
    writeStageStatus(dir260620, olderInProgressDoc);

    try {
      const result = readCurrentEditionDoc(root, now);
      assert.ok(result !== null, "deve pular a stale e cair para a anterior em curso");
      assert.equal(result!.edition, "260620", `deve pular 260623 (stale) e retornar 260620, got ${result!.edition}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
