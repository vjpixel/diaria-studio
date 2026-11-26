/**
 * #14050: os alarmes e as mensagens ao editor dos timers de shorts e do
 * `publish-shorts.ts` citam a skill pelo nome canônico `/diaria-publica`
 * (#12620), nunca pelo alias `/diaria-publica-video`. O alias segue
 * funcionando; o caminho `.claude/skills/diaria-publica-video/` (onde mora o
 * `short-related-task.md`, lido pela task do Neo) não é citação da skill e
 * fica fora da varredura.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { publishShortsModuleFiles } from "./_helpers/publish-shorts-source.ts"; // #14054

const ROOT = resolve(import.meta.dirname, "..");

const FILES = [
  "scripts/shorts-instagram-timer.ts",
  "scripts/publish-shorts.ts",
  // #14054: o código da entrada mora nos módulos de scripts/publish-shorts/.
  ...publishShortsModuleFiles().map((f) => relative(ROOT, f).replaceAll("\\", "/")),
  "scripts/shorts-linkedin-profile-timer.ts",
  "scripts/shorts-threads-profile-timer.ts",
  "scripts/lib/diaria/short-cover.ts",
  "scripts/lib/diaria/video-env-check.ts",
];

/** Citações da skill pelo nome antigo, fora do caminho do diretório do alias. */
function aliasCitations(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, i) => {
    const stripped = line.replaceAll("skills/diaria-publica-video/", "");
    if (stripped.includes("/diaria-publica-video")) lines.push(i + 1);
  });
  return lines;
}

describe("#14050 nome canônico /diaria-publica nas mensagens dos timers", () => {
  it("o detector acha o alias e ignora o caminho do diretório", () => {
    assert.deepEqual(aliasCitations("a\n(Passo B1 do /diaria-publica-video)\n"), [2]);
    assert.deepEqual(aliasCitations('".claude/skills/diaria-publica-video/short-related-task.md"'), []);
    assert.deepEqual(aliasCitations("(Passo B1 do /diaria-publica)"), []);
  });

  for (const file of FILES) {
    it(`${file} não cita /diaria-publica-video`, () => {
      const hits = aliasCitations(readFileSync(resolve(ROOT, file), "utf8"));
      assert.deepEqual(hits, [], `${file}: linhas ${hits.join(", ")} ainda citam o alias`);
    });
  }
});
