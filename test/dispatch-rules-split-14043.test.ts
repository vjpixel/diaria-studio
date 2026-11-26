/**
 * #14043 — regras de subagente e de coordenador em arquivos separados.
 *
 * Os agents `dev-implementador`/`dev-fixer` leem só
 * `context/overnight-dispatch-rules.md`; os critérios do coordenador moram em
 * `context/overnight-coordinator-rules.md`, com a mesma numeração. Este teste
 * trava quais itens cada arquivo contém, que o cabeçalho do arquivo do
 * subagente lista exatamente os itens do coordenador (é ele que resolve uma
 * citação antiga "item N de overnight-dispatch-rules.md"), que as skills
 * coordenadoras apontam o arquivo novo e que toda âncora de histórico citada
 * existe em `docs/rodadas-autonomas-historico.md` (#14044).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readCoordinatorRules, readSubagentRules } from "./_helpers/dispatch-rules-text.ts";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const itemNumbers = (text: string) =>
  [...text.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1])).sort((a, b) => a - b);

/** Itens só do coordenador (inteiros). */
const COORD_WHOLE = [15, 16, 17, 18, 21, 22, 24, 25, 26, 28];
/** Itens divididos: parte do implementador no subagente, do coordenador no outro. */
const SPLIT = [9, 11, 32, 33, 35, 36];
const SUBAGENT_ONLY = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 14, 19, 20, 23, 27, 29, 30, 31, 34, 37];

describe("#14043 divisão das regras de dispatch", () => {
  const sub = readSubagentRules();
  const coord = readCoordinatorRules();

  it("o arquivo do subagente tem os itens dele e a parte do implementador dos divididos", () => {
    assert.deepEqual(itemNumbers(sub), [...SUBAGENT_ONLY, ...SPLIT].sort((a, b) => a - b));
  });

  it("o arquivo do coordenador tem os itens dele e a parte do coordenador dos divididos", () => {
    assert.deepEqual(itemNumbers(coord), [...COORD_WHOLE, ...SPLIT].sort((a, b) => a - b));
  });

  it("nenhum item do coordenador sobra no arquivo do subagente, e vice-versa", () => {
    for (const n of COORD_WHOLE) assert.ok(!itemNumbers(sub).includes(n), `item ${n} fora do subagente`);
    for (const n of SUBAGENT_ONLY) assert.ok(!itemNumbers(coord).includes(n), `item ${n} fora do coordenador`);
  });

  it("o cabeçalho do subagente lista exatamente os itens que moram no coordenador", () => {
    const header = sub.slice(0, sub.indexOf("\n## 1. "));
    assert.match(header, /context\/overnight-coordinator-rules\.md/);
    assert.match(header, /itens 15, 16, 17, 18, 21, 22, 24, 25, 26 e 28 inteiros/);
    assert.match(header, /procedimento do item 33/);
    assert.match(header, /parte do coordenador dos itens 9, 11, 32, 35 e 36/);
  });

  it("cada item dividido aponta o outro lado", () => {
    for (const n of SPLIT) {
      const s = sub.slice(sub.indexOf(`\n## ${n}. `), sub.indexOf("\n## ", sub.indexOf(`\n## ${n}. `) + 1));
      assert.match(s, new RegExp(`item ${n} de \`context/overnight-coordinator-rules\\.md\``), `subagente → coordenador, item ${n}`);
      const c = coord.slice(coord.indexOf(`\n## ${n}. `), coord.indexOf("\n## ", coord.indexOf(`\n## ${n}. `) + 1));
      assert.match(c, new RegExp(`item ${n} de \`context/overnight-dispatch-rules\\.md\``), `coordenador → subagente, item ${n}`);
    }
  });

  it("os agents dev-* leem só o arquivo do subagente", () => {
    for (const agent of [".claude/agents/dev-implementador.md", ".claude/agents/dev-fixer.md"]) {
      const text = read(agent);
      assert.match(text, /context\/overnight-dispatch-rules\.md/, agent);
      assert.doesNotMatch(text, /overnight-coordinator-rules\.md/, `${agent} não carrega as regras do coordenador`);
    }
  });

  it("as skills coordenadoras apontam o arquivo do coordenador", () => {
    for (const skill of ["diaria-overnight", "diaria-develop", "diaria-continuo"]) {
      assert.match(read(`.claude/skills/${skill}/SKILL.md`), /context\/overnight-coordinator-rules\.md/, skill);
    }
  });
});

describe("#14044 âncoras de histórico", () => {
  const hist = read("docs/rodadas-autonomas-historico.md");
  const ids = new Set([...hist.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]));

  it("toda âncora citada nas skills e nas regras existe no histórico", () => {
    const sources = [
      ".claude/skills/diaria-overnight/SKILL.md",
      ".claude/skills/diaria-develop/SKILL.md",
      "context/overnight-dispatch-rules.md",
      "context/overnight-coordinator-rules.md",
    ];
    const missing: string[] = [];
    for (const src of sources) {
      for (const m of read(src).matchAll(/rodadas-autonomas-historico\.md#([a-z0-9-]+)/g)) {
        if (!ids.has(m[1])) missing.push(`${src}: ${m[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("âncoras não se repetem", () => {
    const all = [...hist.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]);
    assert.equal(all.length, ids.size);
  });
});
