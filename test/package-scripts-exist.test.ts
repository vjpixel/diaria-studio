/**
 * package-scripts-exist.test.ts (#1357)
 *
 * Regressão de classe: catch órfãos onde um npm script em package.json
 * referencia um `scripts/X.ts` que não existe no tree.
 *
 * Bug-driver: `beehiiv-sync` adicionado no commit 20023ba, squash-merge de
 * PR #24 só trouxe `build-link-ctr.ts` mas deixou os npm scripts no
 * package.json originalmente — orfanou a referência. A regressão se manifestou
 * de outro jeito (orphan na direção oposta — script existe mas npm não chama),
 * mas a mesma classe de bug merece guard automatizado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("package.json scripts não-órfãos", () => {
  it("cada `tsx scripts/X.ts` referencia arquivo existente", () => {
    const orphans: string[] = [];
    const pattern = /\btsx\s+(scripts\/[\w\-/.]+\.ts)\b/g;
    for (const [name, cmd] of Object.entries(PKG.scripts)) {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(cmd)) !== null) {
        const rel = m[1];
        const abs = resolve(ROOT, rel);
        if (!existsSync(abs)) {
          orphans.push(`scripts.${name} → ${rel}`);
        }
      }
      pattern.lastIndex = 0;
    }
    assert.deepEqual(
      orphans,
      [],
      `Scripts em package.json apontam pra arquivos que não existem:\n  ${orphans.join("\n  ")}`,
    );
  });
});
