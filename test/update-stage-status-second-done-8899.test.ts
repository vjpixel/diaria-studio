/**
 * test/update-stage-status-second-done-8899.test.ts (#8899)
 *
 * Regressão: uma 2ª chamada `--status done` (sem `--end` explícito) posterior
 * ao 1º carimbo atualiza `end` — sem isso, duração/custo do stage ficam presos
 * no 1º carimbo mesmo quando o trabalho real (ex: gate humano de revisão)
 * continuou por horas depois (achado ao vivo, edição 260928: Stage 4 marcado
 * `done` às 22:04 por erro de execução do orchestrator, gate real terminou
 * ~00:30, `stage-status.md` registrou 11min39s em vez de ~2h20 reais).
 *
 * `allowEndAdvance` é opt-in EXPLÍCITO — só a CLI (`--status done`/`failed`
 * digitado de novo) passa `true`. Sem isso, `capture-stage-usage.ts` (que roda
 * "logo após cada --status done", mesmo turno, poucos segundos depois, só pra
 * backfillar cost_usd/tokens preservando `status: row.status`) bateria na
 * MESMA forma de opts (status já terminal, sem `--end`, `now` > `end` já
 * gravado por estar alguns segundos à frente) e inflaria `duration_ms` em
 * TODA edição sem nenhuma reaprovação real — autoteste explícito abaixo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInitialDoc, applyUpdate } from "../scripts/update-stage-status.ts";

describe("applyUpdate — 2º done com allowEndAdvance atualiza end quando posterior (#8899)", () => {
  it("2ª chamada done (allowEndAdvance:true) posterior ao end existente avança end e recomputa duration_ms", () => {
    let doc = makeInitialDoc("260928");
    doc = applyUpdate(
      doc,
      { stage: 4, status: "running", start: "2026-09-28T22:00:00.000Z" },
      "2026-09-28T22:00:00.000Z",
    );
    // 1º "done" — carimbo cedo demais (erro de execução do orchestrator).
    doc = applyUpdate(doc, { stage: 4, status: "done", allowEndAdvance: true }, "2026-09-28T22:04:00.000Z");
    const row1 = doc.rows.find((r) => r.stage === 4)!;
    assert.equal(row1.end, "2026-09-28T22:04:00.000Z");
    assert.equal(row1.duration_ms, 4 * 60 * 1000);

    // 2ª chamada "done" (CLI real, allowEndAdvance:true) — editor aprovou o gate de verdade, bem depois.
    doc = applyUpdate(doc, { stage: 4, status: "done", allowEndAdvance: true }, "2026-09-29T00:30:00.000Z");
    const row2 = doc.rows.find((r) => r.stage === 4)!;
    assert.equal(row2.end, "2026-09-29T00:30:00.000Z", "end deve avançar pro 2º carimbo, posterior ao 1º");
    assert.equal(
      row2.duration_ms,
      new Date("2026-09-29T00:30:00.000Z").getTime() - new Date("2026-09-28T22:00:00.000Z").getTime(),
      "duration_ms deve recomputar a partir do novo end",
    );
  });

  it("sem allowEndAdvance (default), 2ª chamada done NÃO avança end — imuniza capture-stage-usage.ts", () => {
    let doc = makeInitialDoc("260928");
    doc = applyUpdate(doc, { stage: 4, status: "running", start: "2026-09-28T22:00:00.000Z" }, "2026-09-28T22:00:00.000Z");
    doc = applyUpdate(doc, { stage: 4, status: "done", allowEndAdvance: true }, "2026-09-28T22:04:00.000Z");
    // Simula capture-stage-usage.ts: preserva status="done", passa só cost/tokens,
    // SEM allowEndAdvance, `now` alguns segundos depois (mesmo turno).
    doc = applyUpdate(
      doc,
      { stage: 4, status: "done", cost_usd: 0.5, tokens_in: 1000 },
      "2026-09-28T22:04:07.000Z",
    );
    const row = doc.rows.find((r) => r.stage === 4)!;
    assert.equal(row.end, "2026-09-28T22:04:00.000Z", "end não deve avançar sem allowEndAdvance — capture-stage-usage não deve inflar duration_ms");
    assert.equal(row.cost_usd, 0.5, "campos de custo/tokens ainda devem ser atualizados normalmente");
  });

  it("2ª chamada done (allowEndAdvance:true) com timestamp ANTERIOR ao end existente não regride end", () => {
    let doc = makeInitialDoc("260928");
    doc = applyUpdate(doc, { stage: 4, status: "running", start: "2026-09-28T22:00:00.000Z" }, "2026-09-28T22:00:00.000Z");
    doc = applyUpdate(doc, { stage: 4, status: "done", end: "2026-09-29T00:30:00.000Z" });
    // Uma chamada subsequente com `now` mais cedo (ex: retry de script com relógio
    // dessincronizado) nunca deve regredir um end já gravado.
    doc = applyUpdate(doc, { stage: 4, status: "done", allowEndAdvance: true }, "2026-09-28T22:10:00.000Z");
    const row = doc.rows.find((r) => r.stage === 4)!;
    assert.equal(row.end, "2026-09-29T00:30:00.000Z", "end não deve regredir");
  });

  it("--end explícito continua tendo precedência absoluta sobre o auto-bump", () => {
    let doc = makeInitialDoc("260928");
    doc = applyUpdate(doc, { stage: 4, status: "running", start: "2026-09-28T22:00:00.000Z" }, "2026-09-28T22:00:00.000Z");
    doc = applyUpdate(doc, { stage: 4, status: "done", allowEndAdvance: true }, "2026-09-28T22:04:00.000Z");
    // 2ª chamada passa --end explícito diferente de `now` — deve usar o explícito, não `now`.
    doc = applyUpdate(
      doc,
      { stage: 4, status: "done", end: "2026-09-29T01:00:00.000Z", allowEndAdvance: true },
      "2026-09-29T00:30:00.000Z",
    );
    const row = doc.rows.find((r) => r.stage === 4)!;
    assert.equal(row.end, "2026-09-29T01:00:00.000Z", "end explícito vence sobre now");
  });

  it("1ª chamada done (sem end prévio) continua comportamento pré-existente (auto-carimbo simples)", () => {
    let doc = makeInitialDoc("260928");
    doc = applyUpdate(doc, { stage: 1, status: "running", start: "2026-09-28T08:00:00.000Z" }, "2026-09-28T08:00:00.000Z");
    doc = applyUpdate(doc, { stage: 1, status: "done", allowEndAdvance: true }, "2026-09-28T08:30:00.000Z");
    const row = doc.rows.find((r) => r.stage === 1)!;
    assert.equal(row.end, "2026-09-28T08:30:00.000Z");
  });
});

describe("update-stage-status CLI — 2ª chamada --status done avança end de verdade (#8899)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "update-stage-status.ts");
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
    });
  }

  it("CLI: 2ª --status done sem --end avança end quando o relógio já passou do 1º carimbo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-status-8899-"));
    try {
      const editionDir = join(dir, "260928");
      mkdirSync(editionDir, { recursive: true });
      let r = runCli(["--edition-dir", editionDir, "--init"]);
      assert.equal(r.status, 0, r.stderr);
      r = runCli(["--edition-dir", editionDir, "--stage", "4", "--status", "running"]);
      assert.equal(r.status, 0, r.stderr);
      r = runCli(["--edition-dir", editionDir, "--stage", "4", "--status", "done"]);
      assert.equal(r.status, 0, r.stderr);
      const jsonPath = join(editionDir, "_internal", "stage-status.json");
      const first = JSON.parse(readFileSync(jsonPath, "utf8"));
      const firstEnd = first.rows.find((row: { stage: number }) => row.stage === 4).end;
      assert.ok(firstEnd, "1º done deve ter carimbado end");

      // Espera real (o relógio precisa avançar de verdade pro auto-bump disparar).
      await new Promise((resolve) => setTimeout(resolve, 1100));

      r = runCli(["--edition-dir", editionDir, "--stage", "4", "--status", "done"]);
      assert.equal(r.status, 0, r.stderr);
      const second = JSON.parse(readFileSync(jsonPath, "utf8"));
      const secondEnd = second.rows.find((row: { stage: number }) => row.stage === 4).end;
      assert.notEqual(secondEnd, firstEnd, "2ª chamada --status done via CLI deve avançar end");
      assert.ok(
        new Date(secondEnd).getTime() > new Date(firstEnd).getTime(),
        "novo end deve ser posterior ao 1º",
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
