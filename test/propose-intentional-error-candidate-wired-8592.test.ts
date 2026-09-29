/**
 * test/propose-intentional-error-candidate-wired-8592.test.ts (#8592)
 *
 * Guard estático (mesmo padrão de `test/gate-at-wired-8866.test.ts`):
 * `scripts/propose-intentional-error-candidate.ts` tem lib pura bem testada
 * (`propose-intentional-error-candidate-8592.test.ts`,
 * `propose-intentional-error-candidate-cli-8592.test.ts`), mas review da PR
 * #8885 (achado 1, alta confiança/P1) apontou que nada no pipeline real
 * chamava o CLI — o playbook `.claude/agents/orchestrator-stage-4.md`, que o
 * próprio docstring do módulo cita como consumidor, nunca tinha sido
 * tocado. Este teste garante que a invocação existe no playbook ANTES do
 * texto que documenta o fallback manual (candidate: null) — não em
 * qualquer lugar do arquivo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("#8592: orchestrator-stage-4.md chama o gerador determinístico antes do fallback manual", () => {
  const playbook = ".claude/agents/orchestrator-stage-4.md";
  const text = readFileSync(playbook, "utf-8");

  it("contém a invocação do CLI propose-intentional-error-candidate.ts", () => {
    const callIdx = text.indexOf(
      "npx tsx scripts/propose-intentional-error-candidate.ts --edition-dir {EDITION_DIR}/",
    );
    assert.ok(callIdx > -1, `${playbook} não chama propose-intentional-error-candidate.ts`);
  });

  it("a invocação do CLI vem ANTES da instrução de fallback manual (candidate: null)", () => {
    const callIdx = text.indexOf(
      "npx tsx scripts/propose-intentional-error-candidate.ts --edition-dir {EDITION_DIR}/",
    );
    const fallbackMarker = "`candidate: null`";
    const fallbackIdx = text.indexOf(fallbackMarker);
    assert.ok(callIdx > -1 && fallbackIdx > -1, "marcadores ausentes no playbook");
    assert.ok(
      callIdx < fallbackIdx,
      `${playbook}: chamada do CLI (offset ${callIdx}) deve vir antes do fallback manual (offset ${fallbackIdx})`,
    );
  });

  it("instrui apresentar o candidato não-null direto ao editor, sem reaplicar o filtro manualmente", () => {
    assert.ok(
      /apresentar direto ao editor/.test(text),
      `${playbook}: não instrui apresentar o candidato do gerador diretamente ao editor`,
    );
  });
});
