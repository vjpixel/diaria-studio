/**
 * test/gate-at-wired-8866.test.ts (#8866)
 *
 * pipeline_ms nunca era gravado porque nenhum playbook chamava
 * `update-stage-status.ts --gate-at` antes de apresentar um gate humano.
 * Este teste é o guard estático: garante que os 3 playbooks com gate
 * (Stage 1, 4, 6) contêm a invocação, e que ela aparece ANTES do texto que
 * apresenta o gate ao editor — não em qualquer lugar do arquivo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CASES: Array<{ stage: number; playbook: string; presentMarker: string }> = [
  {
    stage: 1,
    playbook: ".claude/agents/orchestrator-stage-1-research.md",
    presentMarker: "**Instrução de revisão**",
  },
  {
    stage: 4,
    playbook: ".claude/agents/orchestrator-stage-4.md",
    presentMarker: "Apresentar ao editor numa visualização limpa:",
  },
  {
    stage: 6,
    playbook: ".claude/agents/orchestrator-stage-6.md",
    presentMarker: "**Se modo interativo:** apresentar o gate único.",
  },
];

describe("#8866: playbooks com gate chamam update-stage-status --gate-at", () => {
  for (const { stage, playbook, presentMarker } of CASES) {
    it(`Stage ${stage}: --gate-at aparece antes da apresentação do gate`, () => {
      const text = readFileSync(playbook, "utf-8");
      const gateAtCall = `update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage ${stage} --status running --gate-at`;
      const gateAtIdx = text.indexOf(gateAtCall);
      assert.ok(gateAtIdx > -1, `${playbook} não chama "${gateAtCall}"`);

      const presentIdx = text.indexOf(presentMarker);
      assert.ok(presentIdx > -1, `${playbook} não contém o marcador de apresentação "${presentMarker}"`);

      assert.ok(
        gateAtIdx < presentIdx,
        `${playbook}: --gate-at (offset ${gateAtIdx}) deve vir antes da apresentação do gate (offset ${presentIdx})`,
      );
    });
  }

  it("Stage 1: marca --status running (sem --gate-at) ANTES da chamada --gate-at, senão start≈gate_at e pipeline_ms sai ~0", () => {
    // Achado do review da PR #8871: Stage 4/6 já tinham uma marcação de
    // `running` própria no início do stage (#1783), então o --start
    // auto-carimbado por ela precede o --gate-at por todo o tempo do stage.
    // Stage 1 não tinha equivalente — sem isso, o auto-carimbo de `start`
    // dispara na MESMA chamada que grava `gate_at`, e pipeline_ms fica
    // perto de zero em vez de medir o pipeline real até o gate.
    const path = ".claude/agents/orchestrator-stage-1-research.md";
    const text = readFileSync(path, "utf-8");
    const runningOnlyCall = "update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 1 --status running\n";
    const runningIdx = text.indexOf(runningOnlyCall);
    assert.ok(runningIdx > -1, `${path} não marca --stage 1 --status running (sem --gate-at) no início do stage`);

    const gateAtIdx = text.indexOf(
      "update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 1 --status running --gate-at",
    );
    assert.ok(gateAtIdx > -1, `${path} não chama --gate-at`);

    assert.ok(
      runningIdx < gateAtIdx,
      `${path}: marcação de running (offset ${runningIdx}) deve vir antes do --gate-at (offset ${gateAtIdx})`,
    );
  });
});
