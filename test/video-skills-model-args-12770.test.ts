/**
 * test/video-skills-model-args-12770.test.ts (#12770, #12783)
 *
 * Decisão do editor (10/11/2026, #12770): as três skills de vídeo fixam
 * `claude-opus-5-5` + `effort: medium` no frontmatter e declaram a seção
 * `## Argumentos`, que é de onde o painel de skills do Studio tira os
 * argumentos (`extractArgumentsSection`). #12783: o fluxo do dia citado em
 * `diaria-publica` e `diaria-5-publicacao` inclui o `/diaria-video-roteiro`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractArgumentsSection } from "../scripts/studio-ui/studio-skills.ts";

const SKILLS_DIR = resolve(import.meta.dirname, "..", ".claude", "skills");
const VIDEO_SKILLS = ["diaria-video-roteiro", "diaria-video-montagem", "diaria-publica"];

function read(skill: string): string {
  return readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
}

function frontmatter(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(m, "frontmatter ausente");
  return m[1];
}

describe("#12770 skills de vídeo: model/effort e ## Argumentos", () => {
  for (const skill of VIDEO_SKILLS) {
    it(`${skill}: claude-opus-5-5 + effort medium`, () => {
      const fm = frontmatter(read(skill));
      assert.match(fm, /^model:\s*claude-opus-5-5\s*$/m);
      assert.match(fm, /^effort:\s*medium\s*$/m);
    });

    it(`${skill}: seção ## Argumentos começa pelo AAMMDD e não engole a prosa seguinte`, () => {
      const args = extractArgumentsSection(read(skill));
      assert.ok(args, "seção ## Argumentos ausente");
      assert.match(args, /^- `AAMMDD`/);
      assert.doesNotMatch(args, /\*\*(Fluxo do dia|Retomada|Onde fica)/);
    });
  }
});

describe("#12783 fluxo do dia inclui o roteiro", () => {
  for (const skill of ["diaria-publica", "diaria-5-publicacao"]) {
    it(`${skill}: /diaria-edicao → /diaria-video-roteiro → … → /diaria-video-montagem`, () => {
      assert.match(
        read(skill),
        /`\/diaria-edicao` → `\/diaria-video-roteiro`[^\n]*→ `\/diaria-video-montagem`/,
      );
    });
  }
});
