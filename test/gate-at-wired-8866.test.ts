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
});
