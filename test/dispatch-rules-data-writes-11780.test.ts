/**
 * #11780 — subagente de rodada autônoma não grava em `data/` a partir do
 * worktree (o harness nega escrita fora do diretório de trabalho no modo
 * agendado). A regra é documental: a escrita volta ao coordenador, declarada
 * numa seção de título fixo no corpo da PR. Este teste trava o contrato que o
 * coordenador lê (título literal da seção, aplicação pós-merge) e o ponteiro
 * no corpo do alarme de prosa dos hubs, que foi o caso que originou a issue.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dispatchRulesSection, readCoordinatorRules, readSubagentRules } from "./_helpers/dispatch-rules-text.ts";

const ROOT = resolve(import.meta.dirname, "..");

// #14043: item 35 é dividido — implementador em overnight-dispatch-rules.md,
// coordenador em overnight-coordinator-rules.md. A seção volta inteira.
function section(n: number): string {
  const s = dispatchRulesSection(n);
  assert.ok(s.length > 0, `item ${n} existe`);
  return s;
}

describe("#14043 item 35: cada lado no arquivo de quem o lê", () => {
  it("implementador lê a seção literal; o coordenador, a aplicação pós-merge", () => {
    const sub = readSubagentRules();
    const coord = readCoordinatorRules();
    assert.match(sub, /Regra para o implementador/);
    assert.match(sub, /## Escrita pendente em `data\/` \(#11780\)/);
    assert.match(coord, /Regra para o coordenador/);
    assert.match(coord, /depois do merge e nunca antes/);
  });
});

describe("#11780 escrita em data/ volta ao coordenador", () => {
  it("item 35 define a seção literal do corpo da PR e o papel de cada lado", () => {
    const s = section(35);
    assert.match(s, /## Escrita pendente em `data\/` \(#11780\)/, "título literal da seção");
    assert.match(s, /Regra para o implementador/);
    assert.match(s, /Regra para o coordenador/);
    assert.match(s, /depois do merge e nunca antes/, "aplicação pós-merge");
    assert.match(s, /não contornar a\s+negação por `Bash`/, "proíbe contorno por shell");
    assert.match(s, /Closes #N/, "issue fecha quando o resto está no diff");
  });

  it("item 3 (bootstrap) aponta para o item 35", () => {
    assert.match(section(3), /declarada no corpo da PR \(item 35\)/);
  });

  it("alarme de prosa dos hubs aponta a regra para rodada autônoma", () => {
    const src = readFileSync(resolve(ROOT, "scripts/hubs-weekly-regen.ts"), "utf8");
    assert.match(src, /item 35 de",\s*\n\s*"`context\/overnight-dispatch-rules\.md`, #11780\)/);
  });
});
