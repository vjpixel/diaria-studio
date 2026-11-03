/**
 * #11835 — os SKILL.md das rodadas autônomas lembram o coordenador de aplicar,
 * depois do merge, a seção "Escrita pendente em `data/`" do corpo da PR
 * (#11780, item 35 de `context/overnight-dispatch-rules.md`).
 *
 * A regra mora só nas regras de dispatch; o coordenador segue o SKILL.md e,
 * sem o lembrete no ponto pós-merge, a escrita declarada pelo implementador
 * ficava esquecida. O lembrete aponta para o item 35 em vez de duplicar a
 * regra, então o teste confere as duas coisas: a menção e o ponteiro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SKILLS = [
  ".claude/skills/diaria-overnight/SKILL.md",
  ".claude/skills/diaria-develop/SKILL.md",
  ".claude/skills/diaria-continuo/SKILL.md",
];

describe("#11835 — lembrete de Escrita pendente em data/ nos SKILL.md", () => {
  it("o item 35 das regras de dispatch continua definindo a seção", () => {
    const rules = readFileSync(join(ROOT, "context/overnight-dispatch-rules.md"), "utf8");
    assert.match(rules, /^## 35\. Escrita em `data\/`/m);
    assert.match(rules, /Escrita pendente em `data\/` \(#11780\)/);
  });

  for (const rel of SKILLS) {
    it(`${rel}: cita a seção, o item 35 e o #11780 no mesmo trecho`, () => {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const idx = text.search(/Escrita pendente em `?data\/`?/);
      assert.ok(idx >= 0, `${rel} não menciona "Escrita pendente em data/"`);
      // O ponteiro tem de estar junto da menção, não solto noutro ponto do arquivo.
      const window = text.slice(Math.max(0, idx - 200), idx + 1400);
      assert.match(window, /item 35/, `${rel}: lembrete sem ponteiro para o item 35`);
      assert.match(window, /#11780/, `${rel}: lembrete sem citar #11780`);
      // Âncora pós-merge específica: o lembrete manda aplicar depois do `git pull` pós-merge.
      assert.match(window, /[Dd]epois do\s+`git pull`/, `${rel}: lembrete não está amarrado ao \`git pull\` pós-merge`);
      // Trem de merge (#6300): o PR-trem não carrega os corpos; ler cada PR original.
      assert.match(window, /PR-trem/, `${rel}: lembrete não trata o trem de merge (PR-trem)`);
      assert.match(window, /PR ORIGINAL do lote/, `${rel}: lembrete não manda ler cada PR original do lote`);
      assert.match(window, /--prs/, `${rel}: lembrete não aponta os números de --prs`);
      // Item 35: a unidade só conclui com o resultado da escrita registrado.
      assert.match(window, /escrita data\/: pendente/, `${rel}: lembrete não exige registrar o resultado da escrita`);
    });
  }
});
