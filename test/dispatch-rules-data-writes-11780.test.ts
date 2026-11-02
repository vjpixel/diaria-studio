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

const ROOT = resolve(import.meta.dirname, "..");
const rules = readFileSync(resolve(ROOT, "context/overnight-dispatch-rules.md"), "utf8");

function section(n: number): string {
  const start = rules.indexOf(`\n## ${n}. `);
  assert.ok(start >= 0, `item ${n} existe`);
  const next = rules.indexOf("\n## ", start + 1);
  return rules.slice(start, next < 0 ? undefined : next);
}

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
