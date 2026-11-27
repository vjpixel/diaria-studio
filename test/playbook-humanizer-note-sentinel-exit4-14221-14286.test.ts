/**
 * #14286: o playbook do gate da Etapa 4 não pode mandar `--note` para provar o
 * humanizador (o reseal recusa com exit 6 e o `--record-run --step humanizador`
 * sai 1 desde o #14285/#13933).
 * #14221: toda chamada de `pipeline-sentinel.ts assert` nos playbooks trata o
 * exit 4 (sentinel malformado, #14133), sem confundir com o exit 4 do
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

  it("nenhuma instrução de after-humanizer ou --record-run --step humanizador leva --note", () => {
    // Por trecho entre crases: o comando instruído. A proibição em prosa
    // ("Nunca passar `--note`") fica fora porque o trecho dela é só `--note`.
    const commands = [...gate.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const bad = commands.filter(
      (c) =>
        /--note\b/.test(c) &&
        (/after-humanizer/.test(c) || /--record-run --step humanizador/.test(c)),
    );
    assert.deepEqual(bad, []);
    assert.doesNotMatch(gate, /humanizador sem mudanças/);
  });

  it("descreve o caminho manual depois do exit 2 (Clarice, --write com --unproven-ok-section, 6.7/6.8)", () => {
    assert.match(gate, /Nunca passar `--note`\*\* \(#14286\)/);
    assert.match(gate, /--unproven-ok "humanizador rodou e manteve o texto" --unproven-ok-section \{seção\}/);
    assert.match(gate, /os 7 lints de 6\.7 e o `--check` de 6\.8 à mão/);
    assert.match(gate, /rodou duas vezes e devolveu idêntica a seção do escopo \(#14286/);
  });
});

describe("#14221 — exit 4 do pipeline-sentinel assert em todo call site", () => {
  for (const [file, step] of [
    [".claude/agents/orchestrator-stage-2-fallback.md", "1"],
    [".claude/agents/orchestrator-stage-3.md", "2"],
    [".claude/agents/orchestrator-stage-4.md", "3"],
    [".claude/agents/orchestrator-stage-5.md", "4"],
    [".claude/agents/orchestrator-stage-6.md", "5"],
    [".claude/skills/diaria-publica/SKILL.md", "4"],
  ] as const) {
    it(`${file} tem ramo para o exit 4 do assert --step ${step}`, () => {
      const md = read(file);
      assert.match(md, /pipeline-sentinel\.ts assert/);
      const re = new RegExp(
        "- (?:`4`|exit 4) → sentinel do Stage " + step + " presente mas malformado \\(#14133/#14221",
      );
      assert.match(md, re);
      assert.match(md, /Não é o exit 4 do `stale-edition-guard\.ts`/);
      assert.match(md, new RegExp(`\\.step-${step}-done\\.json`));
    });
  }
});
