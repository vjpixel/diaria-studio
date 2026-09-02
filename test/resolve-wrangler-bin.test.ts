/**
 * test/resolve-wrangler-bin.test.ts (#7117)
 *
 * Regressão pro caminho hardcoded que `scripts/purge-leaderboard.ts` usava
 * pra achar o binário do `wrangler` (`workers/poll/node_modules/wrangler/
 * bin/wrangler.js`) — quebrava em silêncio (ENOENT só na hora de rodar)
 * assim que `workers/` virou npm workspace (#7117) e `wrangler` passou a
 * ser hoistado pro `node_modules` da raiz.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { resolveWranglerBin } from "../scripts/lib/resolve-wrangler-bin.ts";

describe("resolveWranglerBin (#7117)", () => {
  it("resolve um caminho absoluto que existe de fato no disco", () => {
    const bin = resolveWranglerBin(import.meta.url);
    assert.ok(bin.startsWith("/"), `esperava caminho absoluto, recebeu: ${bin}`);
    assert.ok(bin.endsWith("wrangler.js"), `esperava terminar em wrangler.js, recebeu: ${bin}`);
    assert.ok(existsSync(bin), `binário resolvido não existe no disco: ${bin}`);
  });

  it("não depende de workers/poll/node_modules existir (regressão do caminho hardcoded pré-workspace)", () => {
    const bin = resolveWranglerBin(import.meta.url);
    assert.ok(
      !bin.includes("workers/poll/node_modules"),
      `resolução não devia mais depender de workers/poll/node_modules — resolveu: ${bin}`,
    );
  });
});
