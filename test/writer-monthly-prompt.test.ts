/**
 * test/writer-monthly-prompt.test.ts (#2866)
 *
 * Grep tests pra travar 2 ajustes de redação validados pela Clarice.ai na
 * edição mensal 2606-07 e tornados permanentes na fonte canônica:
 *
 *   1. `context/snippets/clarice-divulgacao.md` — remoção do "E" inicial
 *      ("E quem assina o plano anual..." → "Quem assina o plano anual...").
 *   2. `.claude/agents/writer-monthly.md` — regência verbal do encerramento
 *      padrão ("Responda este e-mail" → "Responda a este e-mail";
 *      "responder" é transitivo indireto).
 *
 * Não testa comportamento do LLM (writer-monthly é um prompt); testa
 * presença/ausência de strings no texto-fonte, como em writer-prompt.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRITER_MONTHLY_MD = resolve(ROOT, ".claude/agents/writer-monthly.md");
const CLARICE_DIVULGACAO_MD = resolve(ROOT, "context/snippets/clarice-divulgacao.md");

describe("clarice-divulgacao.md — fluência da frase de cupom (#2866)", () => {
  const content = readFileSync(CLARICE_DIVULGACAO_MD, "utf8");

  it("frase começa com 'Quem assina o plano anual' (sem 'E' inicial)", () => {
    assert.match(
      content,
      /acumulando até 67% de desconto\. Quem assina o plano anual/,
      "clarice-divulgacao.md deve remover o 'E' inicial antes de 'quem assina' (#2866)",
    );
  });

  it("não regride pra 'E quem assina' (#2866)", () => {
    assert.doesNotMatch(
      content,
      /E quem assina/,
      "clarice-divulgacao.md não deve reintroduzir o 'E' inicial removido em #2866",
    );
  });
});

describe("writer-monthly.md — regência 'responder a este e-mail' (#2866)", () => {
  const content = readFileSync(WRITER_MONTHLY_MD, "utf8");

  it("encerramento padrão usa 'Responda a este e-mail' (regência correta)", () => {
    assert.match(
      content,
      /Responda a este e-mail/,
      "writer-monthly.md deve usar a regência correta 'responder A este e-mail' (#2866)",
    );
  });

  it("não regride pra 'Responda este e-mail' sem a preposição (#2866)", () => {
    assert.doesNotMatch(
      content,
      /Responda este e-mail/,
      "writer-monthly.md não deve reintroduzir 'Responda este e-mail' sem a preposição 'a' (#2866)",
    );
  });

  it("não usa 'esse e-mail' (deve ser sempre 'este e-mail')", () => {
    assert.doesNotMatch(
      content,
      /respond(a|er).{0,10}esse e-mail/i,
      "writer-monthly.md não deve usar 'esse e-mail' no encerramento (#2866)",
    );
  });
});
