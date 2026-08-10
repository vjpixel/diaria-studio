/**
 * test/hub-page-drift.test.ts (#4558 Parte A, generalizado #4790 achado 3)
 *
 * Garante que os assets committed `workers/arquivo/src/hubs/*.generated.ts`
 * refletem o conteúdo em `scripts/lib/hubs/*.ts` — mesmo padrão de
 * `test/livros-asset-drift.test.ts`/`test/cursos-full-drift.test.ts`. CI
 * quebra se alguém editar o conteúdo do hub sem regenerar.
 *
 * Itera sobre `HUB_LOADERS` (scripts/build-hub-page.ts) em vez de hardcodar
 * um hub — antes só `anthropic-claude` era coberto; `openai-chatgpt` e
 * `google-gemini` (PR #4790) não tinham NENHUMA proteção de drift. Um hub
 * futuro que entrar em `HUB_LOADERS` ganha esta cobertura automaticamente,
 * sem precisar editar este arquivo.
 *
 * Fix do drift: `npx tsx scripts/build-hub-page.ts --hub {slug}`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderHubPage } from "../scripts/lib/shared/hub-page.ts";
import { renderGeneratedModule, HUB_LOADERS } from "../scripts/build-hub-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const slug of Object.keys(HUB_LOADERS)) {
  describe(`hub asset drift — ${slug} (#4558/#4790)`, () => {
    const asset = resolve(ROOT, `workers/arquivo/src/hubs/${slug}.generated.ts`);

    it(`workers/arquivo/src/hubs/${slug}.generated.ts existe`, () => {
      assert.ok(existsSync(asset), `asset ausente — rode: npx tsx scripts/build-hub-page.ts --hub ${slug}`);
    });

    it("o módulo committed bate com um render fresco do conteúdo", () => {
      const hub = HUB_LOADERS[slug]();
      const fresh = renderGeneratedModule(slug, renderHubPage(hub), hub.contentDate);
      const committed = readFileSync(asset, "utf8");
      assert.equal(
        committed,
        fresh,
        `asset divergiu — rode: npx tsx scripts/build-hub-page.ts --hub ${slug}`,
      );
    });
  });
}
