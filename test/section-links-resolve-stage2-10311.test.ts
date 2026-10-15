/**
 * test/section-links-resolve-stage2-10311.test.ts (#10311)
 *
 * Regressão (#633): na edição 261016 o item de VÍDEO saiu do Stage 2 com uma
 * linha em branco entre `**[Título](URL)**` e a descrição. O parser real
 * (`parseSections`) parte isso em 2 blocos e a descrição vira item sem URL.
 * O check `section-links-resolve` (#3821) só rodava no agregador do Stage 4,
 * então `check-invariants --stage 2` passava e o gate do editor travou depois.
 * Agora o check integra `reviewed-passes-all-lints` (Stage 2), e a violation
 * `severity: error` faz `pipeline-sentinel.ts write --step 2` recusar o sentinel.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReviewedPassesAllLints } from "../scripts/lib/invariant-checks/stage-2.ts";

const RULE = "reviewed-section-links-resolve";

const TITLE_LINE =
  "**[LGTM (Looks Good to Me), videoclipe do Claude Opus 5.5](https://youtu.be/3TNpOD6bov8?si=Y55Tov3uvCpm55fi)**";
const DESC =
  "Videoclipe musical sobre o Claude Opus 5.5, publicado pelo canal Degenerative Pixels.";

function videoSection(blankBetween: boolean): string {
  return [
    "---",
    "",
    "**📺 VÍDEO**",
    "",
    TITLE_LINE,
    ...(blankBetween ? [""] : []),
    DESC,
    "",
    "---",
    "",
  ].join("\n");
}

describe("Stage 2 barra item de seção sem URL resolvível (#10311)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("CASO REAL 261016: VÍDEO com linha em branco antes da descrição gera violation error", () => {
    dir = mkdtempSync(join(tmpdir(), "stage2-section-links-"));
    writeFileSync(join(dir, "02-reviewed.md"), videoSection(true));
    const v = checkReviewedPassesAllLints(dir).filter((x) => x.rule === RULE);
    assert.equal(v.length, 1, "esperava 1 violation reviewed-section-links-resolve");
    assert.equal(v[0].severity, "error");
    assert.equal(v[0].source_issue, "#3821");
    // Conteúdo do stderr do lint, não só o nome do check: prova que falhou
    // pelo item órfão (a descrição virou item sem URL).
    assert.match(v[0].message, /sem URL/);
    assert.match(v[0].message, /Videoclipe musical/);
  });

  it("mesmo item sem a linha em branco (formato canônico) não gera essa violation", () => {
    dir = mkdtempSync(join(tmpdir(), "stage2-section-links-ok-"));
    writeFileSync(join(dir, "02-reviewed.md"), videoSection(false));
    const v = checkReviewedPassesAllLints(dir).filter((x) => x.rule === RULE);
    assert.equal(v.length, 0, JSON.stringify(v));
  });
});
