/**
 * livros-asset-drift.test.ts (#1744)
 *
 * Garante que o asset committed `workers/livros/public/index.html` reflete o
 * seed `seed/books/livros-ia.json`. Como o HTML é um artefato derivado mas
 * committed (pra deploy reprodutível), ele pode divergir se alguém editar o
 * seed sem regenerar. Este teste re-renderiza e compara — CI quebra no drift.
 *
 * Fix do drift: `npx tsx scripts/build-livros-page.ts --out workers/livros/public/index.html`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBooks, renderLivrosPage } from "../scripts/build-livros-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED = resolve(ROOT, "seed/books/livros-ia.json");
const ASSET = resolve(ROOT, "workers/livros/public/index.html");

describe("livros asset drift (#1744)", () => {
  it("workers/livros/public/index.html existe", () => {
    assert.ok(existsSync(ASSET), "asset ausente — rode o builder com --out");
  });

  it("o HTML committed bate com um render fresco do seed", () => {
    const fresh = renderLivrosPage(loadBooks(SEED));
    const committed = readFileSync(ASSET, "utf8");
    assert.equal(
      committed,
      fresh,
      "asset divergiu do seed — rode: npx tsx scripts/build-livros-page.ts --out workers/livros/public/index.html",
    );
  });
});
