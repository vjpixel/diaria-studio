/**
 * #14095: `check-humanizer-social.ts --reseal-surgical` (#13929) foi entregue
 * sem nenhum playbook que o chamasse. Este teste trava o ponto de invocação no
 * gate da Etapa 4 (§4d.1 passo 6.0), a ponte de §4c.2b e o cartão de receitas,
 * e o aviso de que o reseal não serve para texto escrito por LLM.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("#14095: --reseal-surgical tem ponto de invocação no Stage 4", () => {
  it("o gate descreve o passo 6.0 com o comando, o desvio no exit 1 e quando não usar", () => {
    const gate = read(".claude/agents/orchestrator-stage-4-gate.md");
    const start = gate.indexOf("**6.0 — Atalho da edição pequena: `--reseal-surgical`");
    const end = gate.indexOf("**6.1 — Detectar seções alteradas**");
    assert.ok(start !== -1 && end > start, "passo 6.0 ausente ou fora de ordem antes do 6.1");
    const step = gate.slice(start, end);
    assert.match(step, /check-humanizer-social\.ts --reseal-surgical --edition-dir \{EDITION_DIR\}\/ --reason/);
    assert.match(step, /Exit 1 \(`RECUSADO: \.\.\.`\) não grava nada: seguir 6\.1/);
    assert.match(step, /sem ele ter rodado/);
    assert.match(step, /\*\*não usar\*\* para texto escrito por LLM/);
  });

  it("§4c.2b (exit 2 do --check) aponta para o passo 6.0", () => {
    const stage4 = read(".claude/agents/orchestrator-stage-4.md");
    assert.match(stage4, /`--reseal-surgical` \(passo 6\.0, #13929\)/);
  });

  it("a receita K do cartão tenta o reseal antes da re-humanização", () => {
    const card = read("context/stage-4-gate-receitas.md");
    const k = card.slice(card.indexOf("## K."), card.indexOf("## L."));
    assert.ok(k.indexOf("--reseal-surgical") !== -1 && k.indexOf("--reseal-surgical") < k.indexOf("```bash"));
  });
});
