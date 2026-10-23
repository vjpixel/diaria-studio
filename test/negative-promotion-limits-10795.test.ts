/**
 * test/negative-promotion-limits-10795.test.ts (#10795)
 *
 * Guard de prompt: o pedido recorrente `destaque-swap` (261015, 261016,
 * 261022) foi analisado contra as edições 261005-261022 e virou dois limites
 * na promoção de destaque negativo para o trio/D1 — checagem de deepfake não
 * é "dano já ocorrido" e negativo promovido >15 pts abaixo do trio entra como
 * D3. Este teste falha se um cleanup remover esses limites do `scorer-select`,
 * do fallback `scorer` ou de `editorial-rules.md`, ou se o texto passar a
 * dizer que a cota de ≥1 negativo (#3916) deixou de valer.
 *
 * Não valida o comportamento do modelo (scorer-select não tem eval de replay,
 * #8144) — valida que a instrução existe e é consistente nos 3 arquivos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("limites da promoção de negativo (#10795)", () => {
  const select = read(".claude/agents/scorer-select.md");
  const scorer = read(".claude/agents/scorer.md");
  const rules = read("context/editorial-rules.md");

  it("scorer-select tem os dois limites, ligados à troca de cota e ao padrão de D1", () => {
    const idx = select.indexOf("Limites da promoção de negativo para o trio e para D1 (#10795");
    assert.ok(idx > 0, "bullet #10795 ausente");
    const block = select.slice(idx, idx + 2500);
    assert.match(block, /Checagem de deepfake não é dano já ocorrido/);
    assert.match(block, /mais de 15 pontos abaixo do 3º do trio/);
    assert.match(block, /entra na posição 3/);
    // os casos reais que sustentam a regra
    assert.ok(block.includes("261013"));
    for (const text of [select, scorer, rules]) assert.doesNotMatch(text, /panorama (genérico )?de deepfakes/);
  });

  it("o bullet de incidente do #9883 aponta para os limites", () => {
    const idx = select.indexOf("Incidente com dano já ocorrido sobe para D1");
    assert.ok(idx > 0);
    const line = select.slice(idx, select.indexOf("\n", idx));
    assert.match(line, /Checagem de deepfake não conta/);
    assert.match(line, /#10795/);
  });

  it("a cota de ≥1 negativo (#3916) continua valendo", () => {
    const idx = select.indexOf("(#10795, decisão do editor");
    const block = select.slice(idx, idx + 2500);
    assert.match(block, /cota de ≥1 negativo \(passo 3, #3916\) continua valendo/);
    assert.match(block, /pool sem candidato digno/);
  });

  it("fallback scorer e editorial-rules espelham os limites", () => {
    for (const [name, txt] of [["scorer.md", scorer], ["editorial-rules.md", rules]] as const) {
      assert.match(txt, /#10795/, `${name} sem #10795`);
      assert.match(txt, /checagem de deepfake/i, `${name} sem a exclusão de checagem`);
      assert.match(txt, /mais de 15 pontos abaixo do 3º do (trio|top-3)/, `${name} sem o limiar de 15 pts`);
      assert.match(txt, /entra como D3/, `${name} sem o destino D3`);
    }
  });
});
