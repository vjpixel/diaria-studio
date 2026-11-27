/**
 * #14286: o playbook do gate da Etapa 4 não pode mandar `--note` para provar o
 * humanizador (o reseal recusa com exit 6 e o `--record-run --step humanizador`
 * sai 1 desde o #14285/#13933).
 * #14221: os playbooks das Etapas 4 e 5 tratam o exit 4 (sentinel malformado,
 * #14133) do `pipeline-sentinel.ts assert`, sem confundir com o exit 4 do
 * `stale-edition-guard.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("#14286 — gate da Etapa 4 sem --note para o humanizador", () => {
  const gate = read(".claude/agents/orchestrator-stage-4-gate.md");

  it("não instrui --note \"humanizador sem mudanças\"", () => {
    assert.doesNotMatch(gate, /--note "humanizador sem mudanças"/);
  });

  it("aponta o --unproven-ok com seção nomeada para escopo devolvido idêntico", () => {
    assert.match(gate, /Nunca passar `--note`\*\* \(#14286\)/);
    assert.match(gate, /devolveu idêntica a\(s\) seção\(ões\) do escopo \(#14286/);
  });
});

describe("#14221 — exit 4 do pipeline-sentinel assert nos playbooks", () => {
  for (const [file, step] of [
    [".claude/agents/orchestrator-stage-4.md", "3"],
    [".claude/agents/orchestrator-stage-5.md", "4"],
  ] as const) {
    it(`${file} tem ramo para o exit 4 do assert --step ${step}`, () => {
      const md = read(file);
      const re = new RegExp(
        "- `4` → sentinel do Stage " + step + " presente mas malformado \\(#14133/#14221",
      );
      assert.match(md, re);
      assert.match(md, /Não é o exit 4 do `stale-edition-guard\.ts`/);
    });
  }
});
