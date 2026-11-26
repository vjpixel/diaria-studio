/**
 * #10058 (regressão #633): os dispatches social-writer/social-curto da Etapa 2
 * leem 01-approved-capped.json e recebem source_text_paths (#9794/#9808).
 *
 * #14113: a skill `/diaria-2-escrita` tinha a sua própria cópia dos prompts
 * (bloco paralelo e Fallback), que é a duplicação que deixou as cópias
 * divergirem. Agora os params saem do runner (`pre-dispatch`) e a receita
 * manual vive só no fallback do playbook. O guard cobre as duas fontes e
 * trava que a skill não volte a ter prompts próprios.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readStage2Playbook } from "../scripts/lib/stage2-playbook.ts";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const skill = readFileSync(join(ROOT, ".claude", "skills", "diaria-2-escrita", "SKILL.md"), "utf8");
const playbook = readStage2Playbook();
const runner = readFileSync(join(ROOT, "scripts", "stage-2-run.ts"), "utf8");

describe("#10058 — social da Etapa 2", () => {
  it("a skill não tem prompts próprios de social (#14113)", () => {
    assert.equal(skill.split("\n").filter((l) => /prompt: "Gera 1 texto/.test(l)).length, 0);
    assert.doesNotMatch(skill, /subagent_type: "social-(writer|curto)"/);
  });

  it("o fallback passa 01-approved-capped.json e source_text_paths ao social-writer e ao social-curto", () => {
    const writer = playbook.split("\n").find((l) => l.startsWith("2. `Agent` → `social-writer`"));
    assert.ok(writer, "passo 2 (social-writer) não encontrado");
    const block = playbook.slice(playbook.indexOf(writer!), playbook.indexOf("3. `Agent` → `social-curto`"));
    assert.match(block, /approved_json_path = \{EDITION_DIR\}\/_internal\/01-approved-capped\.json/);
    assert.match(block, /`source_text_paths` \(#9794\)/);
    assert.match(block, /\*\*Chave `um` \(#9871\):\*\*/);
    const curto = playbook.split("\n").find((l) => l.startsWith("3. `Agent` → `social-curto`"))!;
    assert.match(curto, /source_text_paths/);
  });

  it("o runner monta source_text_paths a partir do capped", () => {
    assert.match(runner, /source_text_paths/);
    assert.match(runner, /01-approved-capped\.json/);
  });

  it("cabeçalho do Fallback cobre fora de {2,3}, não !== 3", () => {
    assert.doesNotMatch(playbook, /highlights\.length !== 3/);
    assert.match(playbook, /highlights\.length < 2 \|\| highlights\.length > 3/);
  });
});
