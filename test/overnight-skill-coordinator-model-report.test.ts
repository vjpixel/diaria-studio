/**
 * test/overnight-skill-coordinator-model-report.test.ts (#2993, regressão #633)
 *
 * Trava a instrução de tornar verificável o modelo/effort do coordenador
 * (fixado pelo frontmatter em #2941): um log de startup no run-log.jsonl na
 * Fase 0, e uma linha "Coordenador: {model} / {effort}" no relatório final
 * (terminal + rascunho Gmail), ambos a partir do valor CONFIGURADO — nunca
 * do auto-relato do assistente, que não é 100% confiável.
 *
 * Não testa comportamento do LLM (SKILL.md é prompt); testa presença/ausência
 * de strings no texto-fonte, como writer-monthly-prompt.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OVERNIGHT_SKILL_MD = resolve(ROOT, ".claude/skills/diaria-overnight/SKILL.md");
const content = readFileSync(OVERNIGHT_SKILL_MD, "utf8");

describe("diaria-overnight — modelo/effort do coordenador verificável (#2993)", () => {
  it("Fase 0 loga um evento coordinator_model com o valor CONFIGURADO no frontmatter", () => {
    assert.match(
      content,
      /Log de startup do modelo\/effort do coordenador \(#2993\)/,
      "deve haver instrução de log de startup",
    );
    assert.match(content, /--message "coordinator_model"/, "deve emitir o evento coordinator_model");
    assert.match(
      content,
      /o modelo\/effort \*\*CONFIGURADO\*\* pelo frontmatter desta skill — n[ãa]o o auto-relatado/,
      "deve deixar explícito que a fonte é o configurado, não o auto-relato",
    );
  });

  it("Fase 2 inclui a linha 'Coordenador: {model} / {effort}' no digest compartilhado (terminal + Gmail)", () => {
    assert.match(
      content,
      /linha `Coordenador: \{model\} \/ \{effort\}` com os valores \*\*CONFIGURADOS\*\* no frontmatter/,
      "deve instruir a linha de coordenador com valores configurados",
    );
    assert.match(
      content,
      /Esta linha entra tanto no resumo do terminal \(passo 5\) quanto no rascunho do Gmail \(passo 3\)/,
      "deve deixar explícito que a linha vale para os dois canais do relatório",
    );
  });
});
