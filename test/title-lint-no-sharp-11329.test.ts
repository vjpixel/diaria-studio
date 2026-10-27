/**
 * test/title-lint-no-sharp-11329.test.ts (#11329, item 4)
 *
 * O lint de título (`lint-checks/title-limits.ts`, #11254) importava
 * `dailyCardTitleFits` de `gen-social-card-4x5.ts` e, com ele, o `sharp`. O
 * critério foi para `lib/card-title-wrap.ts` (puro). Este teste anda o grafo
 * de imports RELATIVOS (estático, sem executar nada) a partir dos módulos que
 * só precisam do critério e falha se algum deles alcançar o `sharp` — ou o
 * próprio gerador do card.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dailyCardTitleFits as fromGenerator } from "../scripts/gen-social-card-4x5.ts";
import { dailyCardTitleFits as fromPure } from "../scripts/lib/card-title-wrap.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;

/** Todos os módulos alcançados por imports relativos + os specifiers não relativos. */
function walk(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const stack = [resolve(ROOT, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith(".")) {
        bare.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec);
      if (existsSync(target)) stack.push(target);
    }
  }
  return { files, bare };
}

const ENTRIES = [
  "scripts/lib/card-title-wrap.ts",
  "scripts/lib/lint-checks/title-limits.ts",
  "scripts/normalize-newsletter.ts",
];

describe("#11329 — o critério do título não carrega o sharp", () => {
  for (const entry of ENTRIES) {
    it(`${entry} não alcança 'sharp' nem gen-social-card-4x5.ts`, () => {
      const { files, bare } = walk(entry);
      assert.equal(bare.has("sharp"), false, `${entry} alcança o sharp`);
      const gerador = resolve(ROOT, "scripts/gen-social-card-4x5.ts");
      assert.equal(files.has(gerador), false, `${entry} importa o gerador do card`);
    });
  }

  it("o gerador re-exporta o MESMO critério (lint e gerador não divergem)", () => {
    assert.equal(fromGenerator, fromPure);
  });

  it("o walker enxerga o sharp quando ele está lá (o teste discrimina)", () => {
    assert.equal(walk("scripts/gen-social-card-4x5.ts").bare.has("sharp"), true);
  });
});
