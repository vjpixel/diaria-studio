import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPorqueImportaGenericAdvice } from "../scripts/lib/lint-checks/porque-importa-generic-advice.ts";

const wrap = (para: string) => `## D1\n\nCorpo.\n\nPor que isso importa:\n\n${para}\n\n---\n`;

test("#9382: flagra conselho genérico corporativo (casos reais da issue)", () => {
  const cases = [
    "O caso pesa. Equipes que já usam Flash em produção devem revisar prompts e limites de token antes de migrar.",
    "Risco real. Empresas que testam sistemas autônomos precisam tratar o acesso à rede como parte central do risco.",
    "Frágil. Plataformas que pensam usar esse sinal para moderação devem tratá-lo como camada frágil.",
    "Times de marketing terão de adaptar SEO para modelos de linguagem.",
  ];
  for (const c of cases) {
    const r = checkPorqueImportaGenericAdvice(wrap(c));
    assert.equal(r.ok, false, c);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].line, 7);
  }
});

test("#9382: não flagra ação concreta ao leitor, previsão no meio da frase nem contrafactual", () => {
  const cases = [
    "Quem montou planilhas usando a fórmula COPILOT precisa migrar esse fluxo antes de setembro.",
    "E quando a API abrir, empresas que já usam voz da OpenAI devem herdar a melhoria sem reescrever a integração.",
    "Nessas plataformas com IA nativa, os filtros que deveriam coibir o abuso ainda falham.",
    "O acesso passou a depender de governo, um fator que empresas e usuários não controlam e precisam levar em conta.",
  ];
  for (const c of cases) assert.equal(checkPorqueImportaGenericAdvice(wrap(c)).ok, true, c);
});

test("#9382: só olha o parágrafo do 'Por que isso importa', não o corpo", () => {
  const md = "Empresas que usam X devem revisar Y.\n\nPor que isso importa:\n\nConsequência concreta.\n";
  assert.equal(checkPorqueImportaGenericAdvice(md).ok, true);
});

test("#9382: rótulo com texto na mesma linha", () => {
  const md = "Por que isso importa: Equipes de segurança precisam monitorar o uso.\n";
  assert.equal(checkPorqueImportaGenericAdvice(md).warnings.length, 1);
});
