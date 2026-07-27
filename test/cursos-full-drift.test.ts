/**
 * cursos-full-drift.test.ts (#4052)
 *
 * Garante que `workers/cursos/src/courses-full.generated.ts` (HTML completo,
 * servido pelo Worker só depois do gate passar) reflete o seed atual — mesmo
 * espírito de `cursos-asset-drift.test.ts` (#1745), mas pro artefato gerado
 * que o Worker importa em runtime.
 *
 * Fix do drift:
 *   npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html --gen-full workers/cursos/src/courses-full.generated.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCourses, renderCursosPage } from "../scripts/build-cursos-page.ts";
import { CURSOS_FULL_HTML } from "../workers/cursos/src/courses-full.generated.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED = resolve(ROOT, "seed/courses/cursos-ia.json");
const GENERATED = resolve(ROOT, "workers/cursos/src/courses-full.generated.ts");

describe("cursos full HTML gerado (#4052)", () => {
  it("workers/cursos/src/courses-full.generated.ts existe", () => {
    assert.ok(existsSync(GENERATED), "gerado ausente — rode o builder com --gen-full");
  });

  it("CURSOS_FULL_HTML bate com um render fresco do seed em modo full", () => {
    const fresh = renderCursosPage(loadCourses(SEED), "full");
    assert.equal(
      CURSOS_FULL_HTML,
      fresh,
      "gerado divergiu do seed — rode: npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html --gen-full workers/cursos/src/courses-full.generated.ts",
    );
  });

  it("o HTML full contém TODOS os cursos completos (inclusive não-teaser)", () => {
    const courses = loadCourses(SEED);
    const gated = courses.filter((c) => !c.teaser);
    assert.ok(gated.length > 0, "sanity: precisa haver pelo menos 1 curso gated pro teste fazer sentido");
    for (const c of gated) {
      assert.ok(CURSOS_FULL_HTML.includes(c.summary), `full HTML deveria conter o summary de ${c.id}`);
      assert.ok(CURSOS_FULL_HTML.includes(c.url), `full HTML deveria conter a url de ${c.id}`);
    }
  });
});
