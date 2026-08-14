/**
 * test/hub-index-page-drift.test.ts (#5256)
 *
 * Garante que o asset committed `workers/arquivo/src/hubs/index-page.generated.ts`
 * reflete `HUB_META`/`HUB_LOADERS` atuais — mesmo padrão de
 * `test/hub-page-drift.test.ts`. CI quebra se alguém editar um hub (mudando
 * `metaDescription`/janela de cobertura) ou `HUB_META` (rótulo, hub novo) sem
 * regenerar o índice.
 *
 * Fix do drift: `npx tsx scripts/build-hub-page.ts --index` (ou `--all`, que
 * já inclui o índice).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderHubIndexPage, renderHubNotFoundPage } from "../scripts/lib/shared/hub-index-page.ts";
import { hubCoverageDate } from "../scripts/lib/shared/hub-page.ts";
import { buildHubIndexEntries, renderIndexGeneratedModule, loadHubContent } from "../scripts/build-hub-page.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asset = resolve(ROOT, "workers/arquivo/src/hubs/index-page.generated.ts");

describe("hub index page drift (#5256)", () => {
  it("workers/arquivo/src/hubs/index-page.generated.ts existe", () => {
    assert.ok(existsSync(asset), "asset ausente — rode: npx tsx scripts/build-hub-page.ts --index");
  });

  it("o módulo committed bate com um render fresco do conteúdo", () => {
    const entries = buildHubIndexEntries();
    const html = renderHubIndexPage(entries);
    const notFoundHtml = renderHubNotFoundPage();
    const lastmodDate = HUB_META.map((m) => hubCoverageDate(loadHubContent(m.slug).sourceEditions))
      .sort()
      .at(-1)!;
    const fresh = renderIndexGeneratedModule(html, lastmodDate, notFoundHtml);
    const committed = readFileSync(asset, "utf8");
    assert.equal(committed, fresh, "asset divergiu — rode: npx tsx scripts/build-hub-page.ts --index");
  });
});
