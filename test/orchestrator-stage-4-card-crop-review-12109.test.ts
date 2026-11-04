import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const md = readFileSync(new URL("../.claude/agents/orchestrator-stage-4.md", import.meta.url), "utf8");
const section = md.split("**Card 4x5 regenerado após troca de título (#12109):**")[1]?.split("Disparar o subagente `fact-checker`")[0] ?? "";

describe("Stage 4: revisão do card após troca de título (#12109)", () => {
  it("revisa o overlay novo após gerar e antes de aceitar o gate, inclusive no fast path", () => {
    assert.match(section, /concluir com exit 0[^]*fast path[^]*antes de aceitar `sim`/);
    assert.match(section, /título sobreposto pode cobrir elementos importantes/);
    assert.match(section, /Agent\("image-crop-reviewer"/);
    assert.match(md, /Se regenerou somente o card[^]*re-revisão parcial de §4c\.6 \(#12109\)/);
  });
  it("descobre e persiste apenas o 4x5 afetado sem sobrescrever o veredito anterior", () => {
    assert.match(section, /--only d\{N\}:4x5`/);
    assert.match(section, /--only d\{N\}:4x5 --input-json \{RESULTADO_TEMPORARIO\}/);
    assert.match(section, /arquivo temporário \(fora de `_internal\/04-crop-review\.json`/);
    assert.match(section, /preserva os outros destaques e o 1:1/);
    assert.match(section, /Nunca apenas recarimbar o md5/);
    assert.match(section, /plano de estilo[^]*check-invariants --stage 4/);
    assert.match(section, /outras imagens[^]*revisão completa/);
  });
});
