/**
 * test/calibration-rubric-markers-sync.test.ts (#7978)
 *
 * Guard de regressão pro achado de review do #7978 (fleet, code-reviewer,
 * alta confiança, P1): `context/scoring/rubric.json` listava
 * `impact_routine` como bônus calibrável, mas o bloco correspondente em
 * `.claude/agents/scorer.md`/`scorer-chunk.md` não tinha marcadores
 * `CALIBRATED:*` — uma mudança futura nesse bônus passaria pelo gate de
 * sign-off (#7978 ponto 4) SEM exigir aprovação, justamente o buraco que
 * o mecanismo existe pra fechar.
 *
 * Este teste confere o inverso: TODO bônus listado em `rubric.json` tem
 * um bloco `CALIBRATED:{feature}` presente em CADA `agent_files` listado
 * pra ele. Roda contra os arquivos REAIS do repo (não fixture sintética)
 * — é exatamente o tipo de drift que só aparece comparando os dois
 * arquivos de verdade.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractCalibratedBlocks } from "../scripts/lib/calibration-file-allowlist.ts";

const ROOT = resolve(import.meta.dirname, "..");

interface RubricBonus {
  points: number;
  issue: string;
  agent_files: string[];
}

interface Rubric {
  bonuses: Record<string, RubricBonus>;
}

function readRubric(): Rubric {
  return JSON.parse(readFileSync(resolve(ROOT, "context", "scoring", "rubric.json"), "utf8"));
}

describe("rubric.json ↔ marcadores CALIBRATED em sync (#7978)", () => {
  const rubric = readRubric();

  for (const [feature, bonus] of Object.entries(rubric.bonuses)) {
    for (const agentFile of bonus.agent_files) {
      it(`${feature} (${bonus.issue}): ${agentFile} tem bloco CALIBRATED:${feature}`, () => {
        const content = readFileSync(resolve(ROOT, agentFile), "utf8");
        const blocks = extractCalibratedBlocks(content);
        assert.ok(
          blocks.some((b) => b.feature === feature),
          `rubric.json lista "${feature}" (${bonus.points} pts, ${bonus.issue}) pra ${agentFile}, mas nenhum bloco <!-- CALIBRATED:${feature}:start/end --> foi encontrado — esse bônus mudaria de valor SEM passar pelo gate de sign-off (#7978).`,
        );
      });
    }
  }

  it("nenhum bloco CALIBRATED no arquivo real referencia uma feature ausente do rubric.json (drift no sentido inverso)", () => {
    const referencedFiles = new Set(Object.values(rubric.bonuses).flatMap((b) => b.agent_files));
    for (const file of referencedFiles) {
      const content = readFileSync(resolve(ROOT, file), "utf8");
      const blocks = extractCalibratedBlocks(content);
      for (const block of blocks) {
        assert.ok(
          rubric.bonuses[block.feature] !== undefined,
          `${file} tem bloco CALIBRATED:${block.feature}, mas rubric.json não documenta essa feature — atualizar rubric.json (proveniência/rastreabilidade, não é o que bloqueia o gate).`,
        );
      }
    }
  });
});
