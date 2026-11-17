// Contrato de prosa da /diaria-video-roteiro (#13433, #13434, #13435): as
// decisões do editor na 261118 ficam escritas onde o próximo roteiro as lê.
// Prompt de skill/agent não tem execução testável; o teste trava que os itens
// não sumam numa reescrita.
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const ler = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SKILL = ler(".claude/skills/diaria-video-roteiro/SKILL.md");
const REVISOR = ler(".claude/agents/revisor-roteiro-video.md");
const FACT = ler(".claude/agents/fact-checker.md");

it("#13433: Passo 2 registra o formato react, com os 7 pontos e a fixture da 261118", () => {
  const react = SKILL.slice(SKILL.indexOf("### Formato react (#13433)"), SKILL.indexOf("## Passo 3"));
  assert.ok(react.length > 0, "seção Formato react ausente ou fora do Passo 2");
  for (const ponto of ["Um item por vez", "entre aspas, com origem e tempo", "não repete a previsão em forma de pergunta", "sem tratar como surpresa", "O foco é o D1", "Placar na tela", "Os verticais não levam os trechos"]) {
    assert.ok(react.includes(ponto), ponto);
  }
  assert.match(react, /3:54,88/);
  assert.ok(existsSync(new URL("./fixtures/roteiro-video/roteiro-falas-261118-v9.json", import.meta.url)));
  assert.ok(react.includes("test/fixtures/roteiro-video/roteiro-falas-261118-v9.json"));
});

it("#13434: Passo 5b despacha o fact-checker em modo roteiro, e o agent tem o modo", () => {
  const p5b = SKILL.slice(SKILL.indexOf("## Passo 5b"), SKILL.indexOf("## Passo 6"));
  assert.ok(p5b.includes('subagent_type: "fact-checker"'));
  assert.ok(p5b.includes('mode: "roteiro"'));
  assert.ok(p5b.includes("_internal/fact-check-roteiro.md"));
  assert.ok(p5b.includes("d1.txt"));
  assert.match(p5b, /02-reviewed\.md` mudou depois do roteiro/);
  assert.match(p5b, /PARTIAL`, `NOT_SUPPORTED` ou `DIVERGENT/);
  assert.ok(FACT.includes("## Modo roteiro (#13434)"));
  assert.ok(FACT.includes('`"roteiro"` (#13434'));
  for (const tipo of ["anunciado × em vigor", "generalização além da fonte", "citação do próprio editor", "referência sem contexto"]) assert.ok(FACT.includes(tipo), tipo);
});

it("#13435: narrativa, encaixe e referência sem contexto no Passo 1, no prompt-base do 5a e no revisor", () => {
  const p1 = SKILL.slice(SKILL.indexOf("## Passo 1"), SKILL.indexOf("## Passo 2"));
  assert.ok(p1.includes("Referência sem contexto (#13435)"));
  assert.ok(p1.includes("seguir o link da própria fonte"));
  const promptBase = SKILL.slice(SKILL.indexOf("> Revise o roteiro de fala"), SKILL.indexOf("**Filtro do coordenador"));
  for (const item of ["**Narrativa:**", "**Encaixe:**", "nome próprio, lugar ou projeto sem contexto", "trechos inseridos"]) assert.ok(promptBase.includes(item), item);
  for (const item of ["**narrativa**", "**encaixe**", "Nome próprio, lugar ou projeto sem contexto"]) assert.ok(REVISOR.includes(item), item);
  assert.match(REVISOR, /^tools: Read, Grep, Glob$/m, "o revisor segue somente leitura");
});
