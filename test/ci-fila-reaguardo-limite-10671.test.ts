/**
 * #10671 — o exit 7 (FILA) de `scripts/lib/wait-pr-checks.sh` (#10578) mandava
 * "reaguardar com nova chamada do helper" sem contador nem limite. Num incidente
 * do GitHub Actions com jobs presos em QUEUED por horas, o coordenador
 * `--agendado` (sem teto de relógio) reaguardaria indefinidamente.
 *
 * Trava, nos dois SKILL.md que instruem o coordenador, que o reaguardo por FILA
 * tem teto explícito e um destino terminal (draft + `ci_timeout`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS = [
  ".claude/skills/diaria-overnight/SKILL.md",
  ".claude/skills/diaria-develop/SKILL.md",
];

/** Parágrafo/bullet que menciona o exit 7 do helper. */
function filaPassage(text: string): string {
  const lines = text.split("\n").filter((l) => /exit 7/i.test(l) && /FILA/.test(l));
  assert.ok(lines.length > 0, "trecho do exit 7 (FILA) não encontrado");
  return lines.join("\n");
}

for (const rel of SKILLS) {
  test(`#10671 ${rel}: reaguardo por FILA tem teto numérico por PR`, () => {
    const passage = filaPassage(readFileSync(resolve(ROOT, rel), "utf8"));
    assert.match(passage, /#10671/);
    assert.match(passage, /no máximo 3 reaguardos consecutivos por PR/);
    assert.match(passage, /zera quando/);
  });

  test(`#10671 ${rel}: estourar o teto vira draft + ci_timeout, nunca reaguardo infinito`, () => {
    const passage = filaPassage(readFileSync(resolve(ROOT, rel), "utf8"));
    assert.match(passage, /`ci_timeout`/);
    assert.match(passage, /"last_status": "queued"/);
    assert.match(passage, /draft/);
    assert.match(passage, /`draft-ci-vermelho`/);
    assert.match(passage, /fila-github-actions/);
  });
}
