/**
 * cursos-asset-drift.test.ts (#1745)
 *
 * Garante que o asset committed `workers/cursos/public/index.html` reflete o
 * seed `seed/courses/cursos-ia.json`. O HTML é derivado mas committed (deploy
 * reprodutível) — pode divergir se alguém editar o seed sem regenerar. Este
 * teste re-renderiza e compara — CI quebra no drift.
 *
 * Fix do drift: `npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCourses, renderCursosPage } from "../scripts/build-cursos-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED = resolve(ROOT, "seed/courses/cursos-ia.json");
const ASSET = resolve(ROOT, "workers/cursos/public/index.html");

describe("cursos asset drift (#1745)", () => {
  it("workers/cursos/public/index.html existe", () => {
    assert.ok(existsSync(ASSET), "asset ausente — rode o builder com --out");
  });

  it("o HTML committed bate com um render fresco do seed", () => {
    const fresh = renderCursosPage(loadCourses(SEED));
    const committed = readFileSync(ASSET, "utf8");
    assert.equal(
      committed,
      fresh,
      "asset divergiu do seed — rode: npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html",
    );
  });
});
