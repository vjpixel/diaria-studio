/**
 * gc-data-dir-9751.test.ts (#9751)
 *
 * Regressão: o GC semanal (`gc-data-dir.ts --apply`, bucket default
 * `tmp-intermediate` = qualquer `tmp-*`) apagava de toda edição fechada dois
 * arquivos que ainda são INPUT de outras ferramentas:
 *   - `_internal/tmp-dates-reviewed.json` — preset de replay `"1-scorer"`/`"1"`
 *     (`replay-stage-input.ts`, evals #3442/#3444);
 *   - `_internal/tmp-allscored.json` — `measure-gate4-highlight-changes.ts` (#9693).
 * O replay trata arquivo ausente como normal, então a perda era silenciosa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { collectCandidates, main } from "../scripts/gc-data-dir.ts";
import { writeSentinel } from "../scripts/lib/pipeline-state.ts";
import {
  isTmpIntermediateFilename,
  TMP_PRESERVED_INPUT_FILENAMES,
} from "../scripts/lib/data-dir-gc-policy.ts";
import { STAGE_INPUT_FILES } from "../scripts/lib/replay-stage-input.ts";

const DAY_MS = 86_400_000;
const MTIME = (st: Stats): number => st.mtimeMs;

function writeAged(path: string, content: string, ageDays: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const t = (Date.now() - ageDays * DAY_MS) / 1000;
  utimesSync(path, t, t);
}

describe("#9751 — política: tmp-* que ainda é input não é tmp-intermediate", () => {
  it("tmp-dates-reviewed.json e tmp-allscored.json ficam fora do bucket (case-insensitive)", () => {
    for (const name of ["tmp-dates-reviewed.json", "tmp-allscored.json", "TMP-AllScored.JSON"]) {
      assert.equal(isTmpIntermediateFilename(name), false, name);
    }
  });

  it("os demais tmp-* continuam no bucket", () => {
    for (const name of ["tmp-articles-raw.json", "tmp-categorized.json", "tmp-scored.json", "tmp-dates-reviewed.json.bak"]) {
      assert.equal(isTmpIntermediateFilename(name), true, name);
    }
  });

  it("todo _internal/tmp-* de qualquer preset de STAGE_INPUT_FILES é protegido (derivado, não copiado)", () => {
    const presetTmp = Object.values(STAGE_INPUT_FILES)
      .flat()
      .filter((p) => p.startsWith("_internal/tmp-"))
      .map((p) => p.slice("_internal/".length));
    assert.ok(presetTmp.length > 0, "fixture: presets hoje incluem ao menos um tmp-*");
    for (const name of presetTmp) {
      assert.equal(TMP_PRESERVED_INPUT_FILENAMES.has(name.toLowerCase()), true, name);
      assert.equal(isTmpIntermediateFilename(name), false, name);
    }
  });
});

describe("#9751 — ponta a ponta: --apply preserva os inputs de replay/medição", () => {
  it("edição fechada: remove tmp-articles-raw.json, preserva tmp-dates-reviewed.json e tmp-allscored.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9751-"));
    const edition = resolve(tmp, "editions/2609/260901");
    const datesReviewed = resolve(edition, "_internal/tmp-dates-reviewed.json");
    const allScored = resolve(edition, "_internal/tmp-allscored.json");
    const raw = resolve(edition, "_internal/tmp-articles-raw.json");
    writeAged(datesReviewed, "[]", 30);
    writeAged(allScored, "{\"all_scored\":[]}", 30);
    writeAged(raw, "[]", 30);
    writeSentinel(edition, 6, []);

    const { candidates } = collectCandidates(tmp, Date.now(), { siblingTimestamp: MTIME });
    const paths = candidates.map((c) => c.relPath);
    assert.ok(paths.includes("editions/2609/260901/_internal/tmp-articles-raw.json"));
    assert.equal(paths.some((p) => p.endsWith("tmp-dates-reviewed.json")), false);
    assert.equal(paths.some((p) => p.endsWith("tmp-allscored.json")), false);

    const originalLog = console.log;
    console.log = () => {};
    try {
      main(["--data-root", tmp, "--apply"], undefined, MTIME);
    } finally {
      console.log = originalLog;
    }
    assert.equal(existsSync(raw), false, "intermediário comum segue removido");
    assert.equal(existsSync(datesReviewed), true, "input do replay 1-scorer preservado (regressão #9751)");
    assert.equal(existsSync(allScored), true, "input da medição #9693 preservado (regressão #9751)");
  });
});
