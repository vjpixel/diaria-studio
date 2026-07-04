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
const MONTHLY_SKILL_MD = resolve(ROOT, ".claude/skills/diaria-mensal/SKILL.md");

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

describe("writer-monthly.md — passo 8 usa a fonte autoritativa do É IA? (#2904, follow-up de #2869)", () => {
  const content = readFileSync(WRITER_MONTHLY_MD, "utf8");

  // A menção legítima a eia-used.json/poll_id é SÓ no caveat negativo
  // ("nunca eia-used.json/poll_id") — documentar a armadilha é correto; o que não
  // pode é INSTRUIR a ler dela. O lock positivo (consome eia_selection_path /
  // select-eia-edition.ts) está no teste abaixo. Por isso aqui assertamos que o
  // anti-padrão é DOCUMENTADO como proibido, não que a string nunca aparece.
  it("documenta eia-used.json como fonte PROIBIDA de seleção (caveat 'nunca')", () => {
    assert.match(
      content,
      /nunca[^\n]*eia-used\.json/i,
      "writer-monthly.md deve documentar eia-used.json como fonte PROIBIDA (caveat 'nunca'), não instruir a lê-la (#2869/#2904)",
    );
  });

  it("documenta poll_id como campo PROIBIDO de seleção (caveat 'nunca')", () => {
    assert.match(
      content,
      /nunca[^\n]*poll_id/i,
      "writer-monthly.md deve documentar poll_id como campo PROIBIDO (caveat 'nunca') — campo inexistente em eia-used.json, causa raiz do bug 2606-07 (#2869)",
    );
  });

  it("passo 8 consome eia_selection_path (EiaSelectionResult de select-eia-edition.ts)", () => {
    assert.match(
      content,
      /eia_selection_path/,
      "writer-monthly.md deve documentar o input eia_selection_path — a seleção autoritativa resolvida pelo orchestrator antes da invocação (#2904)",
    );
    assert.match(
      content,
      /select-eia-edition\.ts/,
      "writer-monthly.md deve referenciar select-eia-edition.ts como a fonte da seleção (#2869/#2904)",
    );
  });

  it("distingue os 3 casos de selection (criterion / fallback_last / ausente) sem afirmar 'mais dividida' em fallback", () => {
    assert.match(content, /selection == "criterion"/);
    assert.match(content, /selection == "fallback_last"/);
    assert.match(
      content,
      /SEM afirmar que foi "a mais dividida\/ambígua"/,
      "writer-monthly.md deve instruir a NÃO alegar 'mais dividida' quando a edição veio de fallback (#2869 — nunca escolher/afirmar errado calado)",
    );
  });
});

describe("SKILL.md (mensal) — Etapa 2 resolve a seleção do É IA? cedo (#2904)", () => {
  const content = readFileSync(MONTHLY_SKILL_MD, "utf8");

  it("Etapa 2 roda select-eia-edition.ts ANTES de disparar o writer-monthly", () => {
    const etapa2Idx = content.indexOf("## Etapa 2 — Escrita");
    const etapa3Idx = content.indexOf("## Etapa 3 — Imagens");
    assert.ok(etapa2Idx >= 0 && etapa3Idx > etapa2Idx, "SKILL.md deve ter as seções Etapa 2 e Etapa 3 nessa ordem");
    const etapa2Body = content.slice(etapa2Idx, etapa3Idx);

    const selectIdx = etapa2Body.indexOf("select-eia-edition.ts");
    const dispatchIdx = etapa2Body.indexOf("Disparar `writer-monthly` via `Agent`");
    assert.ok(selectIdx >= 0, "Etapa 2 deve invocar select-eia-edition.ts (#2904)");
    assert.ok(dispatchIdx >= 0, "Etapa 2 deve disparar o writer-monthly");
    assert.ok(selectIdx < dispatchIdx, "select-eia-edition.ts deve rodar ANTES do writer-monthly ser disparado (#2904)");
  });

  it("writer-monthly recebe eia_selection_path apontando pro output da seleção", () => {
    assert.match(
      content,
      /eia_selection_path = data\/monthly\/\$CYCLE\/_internal\/02-eia-selection\.json/,
      "SKILL.md deve passar eia_selection_path como input do writer-monthly (#2904)",
    );
  });

  it("Etapa 3 reusa o mesmo arquivo de seleção da Etapa 2 (não recalcula)", () => {
    const etapa3Idx = content.indexOf("## Etapa 3 — Imagens");
    const etapa4Idx = content.indexOf("## Etapa 4");
    const etapa3Body = content.slice(etapa3Idx, etapa4Idx);
    assert.match(
      etapa3Body,
      /SEL_JSON="data\/monthly\/\$CYCLE\/_internal\/02-eia-selection\.json"/,
      "Etapa 3 deve apontar pro mesmo 02-eia-selection.json gerado na Etapa 2 (#2904)",
    );
    assert.match(
      etapa3Body,
      /if \[ ! -f "\$SEL_JSON" \]; then/,
      "Etapa 3 só deve recalcular a seleção se o arquivo da Etapa 2 estiver ausente (#2904)",
    );
  });

  it("não sobra referência ao path antigo 03-eia-selection.json", () => {
    assert.doesNotMatch(
      content,
      /03-eia-selection\.json/,
      "SKILL.md não deve mais referenciar 03-eia-selection.json — renomeado pra 02- (produzido na Etapa 2, #2904)",
    );
  });
});
