/**
 * test/build-entity-page.test.ts (#5125 item 3)
 *
 * Garante que `workers/artigos/public/entidades/{slug}/index.html`
 * (COMMITADO, servido byte a byte pelo Worker de assets `artigos`) reflete
 * o conteúdo de `scripts/lib/entities/{slug}.ts` — mesmo padrão de
 * `test/hub-page-drift.test.ts`. CI quebra se alguém editar o conteúdo da
 * entidade sem regenerar.
 *
 * Itera sobre `ENTITY_LOADERS` (scripts/build-entity-page.ts) — uma
 * entidade nova ganha esta cobertura automaticamente, sem editar este
 * arquivo.
 *
 * Fix do drift: `npx tsx scripts/build-entity-page.ts --entity {slug}`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderEntityPage } from "../scripts/lib/shared/entity-page.ts";
import { ENTITY_LOADERS } from "../scripts/build-entity-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const slug of Object.keys(ENTITY_LOADERS)) {
  describe(`entity page asset drift — ${slug} (#5125)`, () => {
    const asset = resolve(ROOT, `workers/artigos/public/entidades/${slug}/index.html`);

    it(`workers/artigos/public/entidades/${slug}/index.html existe`, () => {
      assert.ok(existsSync(asset), `asset ausente — rode: npx tsx scripts/build-entity-page.ts --entity ${slug}`);
    });

    it("o HTML committed bate com um render fresco do conteúdo", () => {
      const entity = ENTITY_LOADERS[slug]();
      const fresh = renderEntityPage(entity);
      const committed = readFileSync(asset, "utf8");
      assert.equal(
        committed,
        fresh,
        `asset divergiu — rode: npx tsx scripts/build-entity-page.ts --entity ${slug}`,
      );
    });
  });
}
