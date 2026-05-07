/**
 * test/sorteio-skipped-invalid-log.test.ts (#951)
 *
 * Regression guard contra observabilidade perdida do guard
 * `isValidRawThread` (#950): se Stage 0p ou skill `/diaria-sorteio` não
 * mencionarem `skipped_invalid` em contexto de log, threads-bot voltariam
 * a ser filtradas silenciosamente em produção sem sinal pro auto-reporter.
 *
 * Garante que ambos prompts:
 *   1. Mencionam `skipped_invalid` no shape do output JSON do classifier
 *   2. Contêm instrução pra logar warn via `log-event.ts` quando > 0
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILES = [
  ".claude/agents/orchestrator-stage-0-preflight.md",
  ".claude/skills/diaria-sorteio/SKILL.md",
];

describe("sorteio skipped_invalid logging regression (#951)", () => {
  it("ambos prompts mencionam `skipped_invalid` (output schema)", () => {
    for (const relPath of FILES) {
      const content = readFileSync(resolve(process.cwd(), relPath), "utf8");
      assert.match(
        content,
        /skipped_invalid/,
        `${relPath} deve referenciar campo \`skipped_invalid\` do classifier output`,
      );
    }
  });

  it("ambos prompts instruem chamar log-event.ts em contexto de skipped_invalid", () => {
    for (const relPath of FILES) {
      const content = readFileSync(resolve(process.cwd(), relPath), "utf8");
      // Procura bloco que tem AMBOS: skipped_invalid + log-event.ts em proximidade.
      // Heurística simples: extrair o primeiro parágrafo que menciona skipped_invalid
      // e verificar se ele OU o próximo bloco bash/code tem log-event.
      const idx = content.indexOf("skipped_invalid");
      assert.ok(idx >= 0, `${relPath}: skipped_invalid não encontrado`);
      // Janela de 800 chars depois pra capturar bloco bash inline.
      const window = content.slice(idx, idx + 800);
      assert.match(
        window,
        /log-event\.ts/,
        `${relPath} deve chamar log-event.ts em proximidade de skipped_invalid`,
      );
      assert.match(
        window,
        /level\s+warn/,
        `${relPath} deve usar --level warn pro skipped_invalid`,
      );
    }
  });

  it("ambos prompts mencionam guard isValidRawThread / threads inválidas", () => {
    for (const relPath of FILES) {
      const content = readFileSync(resolve(process.cwd(), relPath), "utf8");
      // Garante que skipped_invalid não é só um campo solto — está conectado
      // ao guard introduzido em #950.
      const hasGuardContext =
        /isValidRawThread/.test(content) ||
        /thread.*inválid/i.test(content) ||
        /guard.*classifier/i.test(content);
      assert.ok(
        hasGuardContext,
        `${relPath} deve contextualizar skipped_invalid em relação ao guard #950`,
      );
    }
  });
});
