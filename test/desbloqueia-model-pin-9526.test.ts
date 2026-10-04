/**
 * test/desbloqueia-model-pin-9526.test.ts (#9526)
 *
 * Guard: o frontmatter de `.claude/skills/diaria-desbloqueia/SKILL.md` fixa
 * exatamente `model: claude-opus-5-5` + `effort: medium` (mesmo perfil do
 * coordenador do /diaria-develop, #8941) — ID pinado, nunca alias (#9003).
 * Também trava que a limitação de escopo-de-turno do pin (#9124) segue
 * documentada no corpo da skill.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = resolve(ROOT, ".claude/skills/diaria-desbloqueia/SKILL.md");

function frontmatter(content: string): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, "SKILL.md sem frontmatter");
  return m[1];
}

function field(fm: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "gm");
  return [...fm.matchAll(re)].map((m) => m[1].replace(/^["']|["']$/g, ""));
}

describe("#9526 — /diaria-desbloqueia pina model/effort no frontmatter", () => {
  const content = readFileSync(SKILL, "utf8");
  const fm = frontmatter(content);

  it("declara exatamente model: claude-opus-5-5 (ID pinado, uma vez)", () => {
    assert.deepEqual(field(fm, "model"), ["claude-opus-5-5"]);
  });

  it("declara exatamente effort: medium (uma vez)", () => {
    assert.deepEqual(field(fm, "effort"), ["medium"]);
  });

  it("documenta a limitação de escopo-de-turno do pin (#9124)", () => {
    const body = content.slice(content.indexOf("---", 3) + 3);
    assert.match(body, /#9124/);
    assert.match(body, /fim do turno/);
    assert.match(body, /AskUserQuestion/);
  });
});

describe("#9526 — /diaria-desbloqueia roda num único turno (pin não cai em task-notification)", () => {
  const content = readFileSync(SKILL, "utf8");

  it("exige run_in_background: false para Agent despachado pela skill", () => {
    assert.match(content, /run_in_background: false/);
  });

  it("nunca instrui run_in_background: true", () => {
    assert.doesNotMatch(content, /run_in_background:\s*true/);
  });

  it("explica que o task-notification abre turno novo (#9527), não só mensagem livre", () => {
    assert.match(content, /task-notification/);
    assert.match(content, /#9527/);
    assert.match(content, /ÚNICO turno/);
  });

  it("cita a sonda do par efetivo com os dois --expect-* do par da skill", () => {
    assert.match(
      content,
      /npx tsx scripts\/lib\/effective-model-probe\.ts --expect-model claude-opus-5-5 --expect-effort medium/,
    );
  });

  it("a sonda não vem em bloco cercado (o hook não injeta --session-id em comando multi-linha)", () => {
    const fences = [...content.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const f of fences) assert.doesNotMatch(f, /effective-model-probe/);
  });
});
