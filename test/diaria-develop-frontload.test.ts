/**
 * test/diaria-develop-frontload.test.ts (#2966, regressão #633)
 *
 * Trava o front-load do briefing do /diaria-develop: a Fase 0.5 deve colher o
 * MÁXIMO de decisões no início (ordem + cat-C + cat-A + cat-B + política de onda
 * + pré-autorização cat-D) pra minimizar interrupções durante a sessão — sem
 * remover a segurança do blast-radius em silêncio (default = ver cada Gate B).
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
const DEVELOP_SKILL_MD = resolve(ROOT, ".claude/skills/diaria-develop/SKILL.md");
const content = readFileSync(DEVELOP_SKILL_MD, "utf8");

describe("diaria-develop Fase 0.5 — briefing front-loaded (#2966)", () => {
  it("a Fase 0.5 é FRONT-LOADED, não mais 'só define a ordem'", () => {
    assert.match(content, /Fase 0\.5 — Briefing FRONT-LOADED/, "seção deve ser o briefing front-loaded");
    assert.doesNotMatch(
      content,
      /Fase 0\.5 — Briefing de ordem de ataque/,
      "não deve manter o briefing antigo 'só de ordem'",
    );
    assert.match(content, /minimizar interrupç[õo]es durante a sess[ãa]o/i, "objetivo: minimizar interrupções");
  });

  it("colhe as 6 classes de decisão no início (ordem + cat C/A/B + wave_policy + catD_preauth)", () => {
    assert.match(content, /Ordem de ataque/i, "1. ordem de ataque");
    assert.match(content, /Todas as decis[õo]es cat\. C/i, "2. todas as decisões cat. C batchadas");
    assert.match(content, /Todas as credenciais cat\. A/i, "3. todos os tokens cat. A de uma vez");
    assert.match(content, /Todas as confirmaç[õo]es cat\. B/i, "4. todas as confirmações cat. B");
    assert.match(content, /wave_policy/, "5. política de onda coletada no briefing");
    assert.match(content, /catD_preauth/, "6. política de pré-autorização cat. D coletada no briefing");
  });

  it("caps do AskUserQuestion → múltiplas chamadas sequenciais documentadas", () => {
    assert.match(
      content,
      /m[úu]ltiplas chamadas `AskUserQuestion` sequenciais/i,
      "deve documentar que front-loadar N decisões exige várias chamadas (cap 4×4)",
    );
  });

  it("SEGURANÇA: catD_preauth default = show_each (blast-radius não se pré-aprova em silêncio)", () => {
    assert.match(
      content,
      /Default = `show_each`/,
      "o default da pré-autorização cat. D deve ser ver cada Gate B, nunca pré-aprovado",
    );
    // O Gate B deixou de ser 'não-opt-out', mas o default continua obrigatório.
    assert.doesNotMatch(
      content,
      /obrigat[óo]rio e n[ãa]o-opt-out/,
      "Gate B não é mais 'não-opt-out' incondicional — virou opt-out explícito por sessão",
    );
    assert.match(
      content,
      /O default NUNCA é pr[ée]-aprovado/,
      "o texto deve deixar explícito que o default nunca é pré-aprovado",
    );
  });

  it("wave_policy default = auto (onda livre-de-colisão por construção)", () => {
    assert.match(content, /Default sugerido: `auto`/, "wave_policy default auto");
  });

  it("Gate de Onda é pulável via wave_policy=auto; Gate B via catD_preauth=preapproved", () => {
    assert.match(content, /Pul[áa]vel com `--serial` OU `wave_policy = auto`/, "Gate de Onda pulável por auto");
    assert.match(content, /opt-out por sess[ãa]o via `catD_preauth = preapproved`/, "Gate B opt-out via preapproved");
  });

  it("plan.json registra as políticas de sessão (attack_order, wave_policy, catD_preauth)", () => {
    assert.match(content, /`attack_order`/, "attack_order no plan.json");
    assert.match(content, /`wave_policy` \(`auto`\|`per_wave`, default `auto`\)/, "wave_policy no plan.json");
    assert.match(
      content,
      /`catD_preauth` \(`show_each`\|`preapproved`, default `show_each`\)/,
      "catD_preauth no plan.json",
    );
  });
});
