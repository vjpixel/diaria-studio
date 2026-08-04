/**
 * test/hub-page-drift.test.ts (#4558 Parte A)
 *
 * Garante que os assets committed `workers/arquivo/src/hubs/*.generated.ts`
 * refletem o conteúdo em `scripts/lib/hubs/*.ts` — mesmo padrão de
 * `test/livros-asset-drift.test.ts`/`test/cursos-full-drift.test.ts`. CI
 * quebra se alguém editar o conteúdo do hub sem regenerar.
 *
 * Fix do drift: `npx tsx scripts/build-hub-page.ts --hub anthropic-claude`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderHubPage } from "../scripts/lib/shared/hub-page.ts";
import { renderGeneratedModule } from "../scripts/build-hub-page.ts";
import { getAnthropicClaudeHub } from "../scripts/lib/hubs/anthropic-claude.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET = resolve(ROOT, "workers/arquivo/src/hubs/anthropic-claude.generated.ts");

describe("hub asset drift — anthropic-claude (#4558 Parte A)", () => {
  it("workers/arquivo/src/hubs/anthropic-claude.generated.ts existe", () => {
    assert.ok(existsSync(ASSET), "asset ausente — rode: npx tsx scripts/build-hub-page.ts --hub anthropic-claude");
  });

  it("o módulo committed bate com um render fresco do conteúdo", () => {
    const fresh = renderGeneratedModule("anthropic-claude", renderHubPage(getAnthropicClaudeHub()));
    const committed = readFileSync(ASSET, "utf8");
    assert.equal(
      committed,
      fresh,
      "asset divergiu — rode: npx tsx scripts/build-hub-page.ts --hub anthropic-claude",
    );
  });
});
