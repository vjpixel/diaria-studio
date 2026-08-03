/**
 * test/diaria-develop-attack-order-onhold-4498.test.ts (#4498)
 *
 * Trava as 2 correções de fricção do `/diaria-develop` reportadas pelo
 * editor na sessão 260802b (SKILL.md é prompt; testa presença/ausência de
 * strings no texto-fonte, como diaria-develop-frontload.test.ts).
 *
 * Problema 1: `attack_order` era perguntada toda sessão com o mesmo default
 * escolhido sempre — a skill deve aplicar `so_destravaveis_agora`
 * automaticamente, sem `AskUserQuestion`, a menos que o editor peça mudar
 * (`--attack-order` ou pedido mid-sessão).
 *
 * Problema 2: issues `on-hold` reentravam no briefing toda sessão,
 * contradizendo a própria semântica do label ("fora dos briefings até
 * reativar"). A skill deve excluir `on-hold` do target_set/tiers por
 * padrão — mesmo tratamento de `fora-do-escopo`/`not-this-week`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEVELOP_SKILL_MD = resolve(ROOT, ".claude/skills/diaria-develop/SKILL.md");
const content = readFileSync(DEVELOP_SKILL_MD, "utf8");

describe("#4498 — attack_order não é mais perguntada por padrão", () => {
  it("Fase 0.5 item 1 documenta o default automático, sem pergunta", () => {
    assert.match(content, /attack_order.{0,40}não é mais perguntada por padrão/is);
    assert.match(content, /so_destravaveis_agora.{0,60}automaticamente/is);
    assert.doesNotMatch(
      content,
      /Default sugerido: C e A primeiro/,
      "não deve sobrar o texto antigo que descrevia um default só 'sugerido' (perguntado)",
    );
  });

  it("--attack-order documentado na seção Argumentos", () => {
    assert.match(content, /`--attack-order \{a\|b\|c\}`/);
  });

  it("override mid-sessão continua permitido, explicitamente documentado", () => {
    assert.match(content, /pedido mid-sess[ãa]o/i);
  });
});

describe("#4498 — issues on-hold excluídas do alvo por padrão", () => {
  it("passo 5 da Fase 0 (Excluir do alvo) inclui on-hold", () => {
    assert.match(
      content,
      /Excluir do alvo, em qualquer pol[íi]tica[^\n]*`on-hold`/,
      "on-hold deve estar na mesma lista de exclusão de fora-do-escopo/not-this-week/elegivel_especial",
    );
  });

  it("semântica do label (\"fora dos briefings até reativar\") citada explicitamente", () => {
    assert.match(content, /fora dos briefings at[ée] reativar/i);
  });

  it("on-hold NÃO infere categoria A-E (passo 4 da Fase 0 / categorização)", () => {
    assert.match(content, /`on-hold` n[ãa]o infere categoria/i);
    assert.doesNotMatch(
      content,
      /`on-hold`\/`kit-migration`→B/,
      "não deve sobrar a associação antiga on-hold→cat B na categorização",
    );
  });

  it("reativação é ação explícita do editor (remover a label no GitHub)", () => {
    assert.match(content, /remover a label no GitHub/i);
  });

  it("seção 'Goal de esgotamento' também documenta a exclusão (mesma lista que fora-do-escopo/elegivel_especial)", () => {
    const goalSectionMatch = content.match(
      /Não entra no alvo em NENHUMA pol[íi]tica[\s\S]{0,600}/,
    );
    assert.ok(goalSectionMatch, "seção 'Não entra no alvo em NENHUMA política' deve existir");
    assert.match(goalSectionMatch![0], /on-hold/);
  });
});
