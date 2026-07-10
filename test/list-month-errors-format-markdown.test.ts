/**
 * list-month-errors-format-markdown.test.ts (#3270 follow-up, code-review
 * consolidado do PR #3293)
 *
 * Regressão: `formatMarkdown` interpolava `e.location` direto num template
 * literal sem o guard `?? ""` (já usado por `correct_value` na mesma linha).
 * Uma `MonthError` com `location: undefined` — o caso normal de entries
 * `source: "prose_block"` sem destaque estruturado, geradas pelo fallback de
 * `sync-intentional-error.ts` — gravava o literal string "undefined" na
 * coluna Localização da tabela do relatório mensal (`/diaria-mes-erros`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatMarkdown, type MonthError } from "../scripts/list-month-errors.ts";

describe("list-month-errors formatMarkdown — location undefined (#3270 follow-up)", () => {
  it("entry declarada com location undefined não grava a string 'undefined' na tabela", () => {
    const errors: MonthError[] = [
      {
        edition: "260710",
        declared: true,
        category: "editor_declared",
        location: undefined,
        description: "Erro extraído da prosa, sem destaque estruturado",
        correct_value: undefined,
      },
    ];
    const md = formatMarkdown("2607", errors);
    assert.ok(
      !md.includes("undefined"),
      `formatMarkdown não deve conter a string literal 'undefined':\n${md}`,
    );
    // A célula de Localização deve ficar vazia (mesma convenção do
    // correct_value ao lado, que já usava `?? ""`).
    assert.match(md, /\| 260710 \| editor_declared \|  \| Erro extraído da prosa, sem destaque estruturado \|  \|/);
  });

  it("entry declarada com location preenchida continua renderizando normalmente (sem regressão)", () => {
    const errors: MonthError[] = [
      {
        edition: "260709",
        declared: true,
        category: "factual",
        location: "DESTAQUE 1",
        description: "Erro teste",
        correct_value: "valor correto",
      },
    ];
    const md = formatMarkdown("2607", errors);
    assert.match(md, /\| 260709 \| factual \| DESTAQUE 1 \| Erro teste \| valor correto \|/);
  });
});
