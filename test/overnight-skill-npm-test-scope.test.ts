/**
 * test/overnight-skill-npm-test-scope.test.ts (#2959, regressão #633)
 *
 * Trava a mudança de causa raiz do stall recorrente: subagentes implementadores
 * do /diaria-overnight e do /diaria-develop NÃO devem rodar a suíte completa
 * `npm test` localmente (o comando que dispara o auto-background do harness e
 * trava o subagente num Monitor-loop) — só `npx tsc --noEmit` + testes afetados.
 * A suíte completa continua sendo o gate autoritativo do CI (#636/#633).
 *
 * Não testa comportamento do LLM (SKILL.md é prompt); testa presença/ausência
 * de strings no texto-fonte, como writer-monthly-prompt.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchRulesSection, readSubagentRules } from "./_helpers/dispatch-rules-text.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OVERNIGHT_SKILL_MD = resolve(ROOT, ".claude/skills/diaria-overnight/SKILL.md");
const DEVELOP_SKILL_MD = resolve(ROOT, ".claude/skills/diaria-develop/SKILL.md");
const overnightContent = readFileSync(OVERNIGHT_SKILL_MD, "utf8");
const developContent = readFileSync(DEVELOP_SKILL_MD, "utf8");
// #14044: a regra mora no item 4 de context/overnight-dispatch-rules.md, que o
// prompt de dispatch cita; o SKILL.md do overnight só aponta para ele.
const subagentRules = readSubagentRules();
const item4 = dispatchRulesSection(4);
const historico = readFileSync(resolve(ROOT, "docs/rodadas-autonomas-historico.md"), "utf8");

describe("diaria-overnight — subagente NUNCA roda a suíte completa local (#2959)", () => {
  it("bootstrap do worktree instrui typecheck + testes afetados, não a suíte completa", () => {
    assert.match(
      item4,
      /Testes locais = \*\*`npx tsc --noEmit`\*\*[\s\S]*s[óo] os arquivos de teste\s+afetados\/novos/,
      "item 4 deve instruir tsc --noEmit + testes afetados como o padrão de teste local",
    );
    assert.match(
      item4,
      /NUNCA `npm test` completo local/,
      "item 4 deve proibir explicitamente a suíte completa local",
    );
    assert.match(subagentRules, /^## 3\. Bootstrap do worktree[\s\S]*?Primeiro passo é \*\*`npm ci`\*\*/m);
    // O prompt de dispatch do overnight cita o item 4 com o #2959.
    const dispatchList = overnightContent.slice(
      overnightContent.indexOf("O prompt do subagente inclui, obrigatoriamente:"),
      overnightContent.indexOf("O subagente implementa,"),
    );
    assert.match(dispatchList, /`context\/overnight-dispatch-rules\.md` no início da própria sessão/);
    assert.match(
      dispatchList,
      /nunca a su[íi]te completa `npm test` local \(item 4, #2959/,
      "o prompt de dispatch deve citar o item 4 e o #2959",
    );
  });

  it("não mantém a instrução antiga de rodar `npm test` como o comando de teste do subagente", () => {
    assert.doesNotMatch(
      overnightContent,
      /testes = \*\*`npm test`\*\*/,
      "a instrução antiga (testes = npm test) não deve mais existir",
    );
    assert.doesNotMatch(
      overnightContent,
      /O subagente implementa, roda `npm test`,/,
      "a frase de retorno do subagente não deve mais mandar rodar npm test",
    );
  });

  it("prompt do fixer (Fase 1 passo 3) manda só os testes afetados, nunca `npm test` (#9539)", () => {
    assert.doesNotMatch(
      overnightContent,
      /aplique cada finding acion[áa]vel no c[óo]digo, rode `npm test`/,
      "o prompt do dev-fixer não pode mandar rodar a suíte completa",
    );
    assert.match(
      overnightContent,
      /aplique cada finding acion[áa]vel no c[óo]digo, rode `npx tsc --noEmit` \+ s[óo] os testes afetados/,
      "o prompt do dev-fixer deve seguir a disciplina do #2959",
    );
  });

  it("documenta o racional da causa raiz (auto-background dispara em 100% dos subagentes 260703+260704)", () => {
    assert.match(
      historico,
      /TODOS os ~11 subagentes das rodadas 260703\+260704/,
      "o histórico deve guardar a evidência empírica que motivou o fix",
    );
    assert.match(
      item4,
      /Se um\s+full-run local for genuinamente necess[áa]rio.*pipe\s+por `\| tail -40`/s,
      "deve manter o belt secundário de full-run via tail -40 para o caso raro",
    );
  });

  it("hotfix da Fase 1.5 referencia a nova disciplina de testes (#2959), não npm test cru", () => {
    assert.match(
      overnightContent,
      /testes conforme #2959 — typecheck \+ afetados, nunca su[íi]te completa local/,
      "o fluxo de hotfix crítico deve reusar a disciplina de teste do #2959",
    );
  });
});

describe("diaria-develop — mesmo padrão de subagente (#2959)", () => {
  it("a linha de reuso do overnight não roda mais `npm test` cru", () => {
    assert.doesNotMatch(
      developContent,
      /`npx tsc --noEmit` → `npm test`\*\*/,
      "não deve mais encadear tsc --noEmit direto em npm test completo",
    );
    assert.match(
      developContent,
      /`npx tsc --noEmit` → testes afetados\/novos/,
      "deve encadear tsc --noEmit → testes afetados/novos",
    );
    assert.match(
      developContent,
      /NUNCA a su[íi]te completa `npm test` local, #2959/,
      "deve proibir a suíte completa local, citando #2959",
    );
  });
});
