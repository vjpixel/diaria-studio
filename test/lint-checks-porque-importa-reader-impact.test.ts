import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPorqueImportaReaderImpact } from "../scripts/lib/lint-checks/porque-importa-reader-impact.ts";

const wrap = (para: string) => `## D1\n\nCorpo.\n\nPor que isso importa:\n\n${para}\n\n---\n`;

test("#11073: exemplos aprovados pelo editor (D1/D2/D3) passam", () => {
  const ok = [
    "Poucos operadores, com modelos de IA comerciais, miraram mais de 400 instituições em poucos meses. O ataque em escala deixou de exigir uma equipe grande, e quem usa banco ou fintech na região tende a ver mais tentativas de invasão e de golpe. Senha repetida e sem segunda etapa de verificação é a porta mais fácil.",
    "A reação dos bancos tende a ser endurecer o acesso às contas, o que pode barrar também o uso legítimo de assistentes que pagam contas e consultam extratos. Enquanto isso, ainda não está claro quem responde quando um agente erra ou age contra o cliente.",
    "À medida que empresas deixarem agentes mexer em código e dados reais, vão depender de monitores como esse para saber o que eles fazem. O relatório mostra que o da OpenAI tinha brechas, que a empresa diz ter corrigido e que o METR não verificou.",
  ];
  for (const c of ok) assert.equal(checkPorqueImportaReaderImpact(wrap(c)).ok, true, c);
});

test("#11073: estilo antigo (só descreve o risco) é sinalizado", () => {
  const r = checkPorqueImportaReaderImpact(
    wrap("O monitor é o que deveria flagrar sabotagem de agentes, e o relatório mostra brechas no da OpenAI."),
  );
  assert.equal(r.ok, false);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].line, 7);
});

test("#11073: rótulo com texto na mesma linha e corpo ignorado", () => {
  assert.equal(
    checkPorqueImportaReaderImpact("Por que isso importa: O modelo tem 70 bilhões de parâmetros.\n").warnings.length,
    1,
  );
  assert.equal(
    checkPorqueImportaReaderImpact("Quem usa isso vai ver.\n\nPor que isso importa:\n\nQuem usa banco tende a ver golpes.\n").ok,
    true,
  );
});
