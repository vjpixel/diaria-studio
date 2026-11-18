/**
 * test/site-public-canonical-13532.test.ts (#13532)
 *
 * Search Console acusou "Cópia sem página canônica selecionada pelo usuário":
 * as 7 páginas de `evento/agente-ia/` (raiz + variantes a-f) eram a única
 * família de `workers/site/public/` sem `rel="canonical"`. Premissa registrada
 * (uso atual não confirmável sem acesso externo): variantes apontam para a
 * principal; a principal aponta para si mesma.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PUBLIC = join(import.meta.dirname, "..", "workers", "site", "public");

function indexFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...indexFiles(p));
    else if (name === "index.html") out.push(p);
  }
  return out;
}

const CANONICAL = /<link\s+rel="canonical"\s+href="([^"]+)"/i;
const NOINDEX = /<meta\s+name="robots"\s+content="[^"]*noindex/i;

describe("workers/site/public — canonical (#13532)", () => {
  it("toda index.html publicável tem rel=canonical ou noindex", () => {
    const missing = indexFiles(PUBLIC)
      .filter((f) => {
        const html = readFileSync(f, "utf8");
        return !CANONICAL.test(html) && !NOINDEX.test(html);
      })
      .map((f) => relative(PUBLIC, f));
    assert.deepEqual(missing, []);
  });

  it("evento/agente-ia: principal e variantes a-f declaram a canônica da principal", () => {
    const base = join(PUBLIC, "evento", "agente-ia");
    for (const v of ["", "a", "b", "c", "d", "e", "f"]) {
      const html = readFileSync(join(base, v, "index.html"), "utf8");
      assert.equal(
        CANONICAL.exec(html)?.[1],
        "https://diar.ia.br/evento/agente-ia",
        `versão "${v || "raiz"}"`,
      );
    }
  });
});
