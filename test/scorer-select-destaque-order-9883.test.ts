/**
 * test/scorer-select-destaque-order-9883.test.ts (#9883)
 *
 * Guard de prompt: o pedido recorrente `destaque-swap` (editor trocou a ordem
 * ou a URL dos destaques em 261005-261008) virou regra no `scorer-select`
 * derivada das correções REAIS do editor no Stage 4 (02-draft.md x
 * 02-reviewed.md, 27 edições de 260901 a 261009). Este teste falha se um
 * cleanup remover essas regras, ou se a frase antiga do #5809 que liberava
 * relatório/projeção como D1 "se for o de maior mérito" voltar a contradizê-las.
 *
 * Não valida o comportamento do modelo (scorer-select não tem eval de replay,
 * #8144 cobre só writer-destaque/social-writer) — valida que a instrução existe.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) => readFileSync(resolve(ROOT, ".claude/agents", name), "utf8");

describe("scorer-select — regras de ordem/seleção do #9883", () => {
  const txt = read("scorer-select.md");

  it("tem a regra 'Score não é a ordem' com os 3 padrões medidos", () => {
    assert.match(txt, /Score não é a ordem \(#9883/);
    assert.match(txt, /Levantamento corporativo de percentual não abre a edição/);
    assert.match(txt, /Lançamento de big-tech com o maior score não é D1 automático/);
    assert.match(txt, /Incidente com dano já ocorrido sobe para D1/);
  });

  it("generaliza a preferência pelo post oficial além de frontier_launch", () => {
    assert.match(txt, /Mesmo anúncio: o post oficial vence a cobertura \(#9883\)/);
    // o caso real em que o oficial estava entre os finalistas e perdeu
    assert.ok(txt.includes("openai.com/index/eu-text-provenance"));
  });

  it("a regra de ordem não revoga o invariante de impacto negativo (#3916)", () => {
    const idx = txt.indexOf("Score não é a ordem (#9883");
    const block = txt.slice(idx, idx + 3000);
    assert.match(block, /não muda quais 6 entram nem o passo 3/);
  });

  it("o desempate do #5809 não libera mais levantamento de percentual como D1", () => {
    assert.ok(
      !txt.includes("inclusive como D1, se for claramente o de maior mérito"),
      "a frase antiga do #5809 contradiz o padrão medido no #9883",
    );
  });
});

describe("scorer (fallback) — espelha a regra do #9883", () => {
  const txt = read("scorer.md");

  it("tem o resumo da regra de ordem e não a frase antiga do #5809", () => {
    assert.match(txt, /Score não é a ordem \(#9883\)/);
    assert.ok(!txt.includes("inclusive como D1, se for claramente o de maior mérito"));
  });

  it("a mudança no scorer.md fica fora dos blocos CALIBRATED (não exige sign-off #7978)", () => {
    const idx = txt.indexOf("Score não é a ordem (#9883)");
    const before = txt.slice(0, idx);
    const opens = (before.match(/CALIBRATED:[a-z_]+:start/g) ?? []).length;
    const closes = (before.match(/CALIBRATED:[a-z_]+:end/g) ?? []).length;
    assert.equal(opens, closes, "a regra #9883 caiu dentro de um bloco CALIBRATED");
  });
});
