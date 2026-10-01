/**
 * test/artigo-especial-registry-sync-9226.test.ts (#9226)
 *
 * Um Artigo Especial gateado vive em 3 registros mantidos à mão:
 *   - `ARTICLES` (scripts/build-artigo-especial-teaser.ts)
 *   - `GATED_ARTICLES` (workers/artigos/src/gated-articles.ts)
 *   - `run_worker_first` (workers/artigos/wrangler.toml)
 * Se o toml esquecer um artigo, o Cloudflare serve o asset estático antes do
 * script e o gate nunca roda — conteúdo pago vaza sem alarme. Este teste
 * amarra os três nos dois sentidos e confere `public/{ano}/{slug}/capa.jpg`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ARTICLES } from "../scripts/build-artigo-especial-teaser.ts";
import { GATED_ARTICLES, gatedArticlePaths } from "../workers/artigos/src/gated-articles.ts";

const WORKER_DIR = resolve(import.meta.dirname, "..", "workers", "artigos");

function runWorkerFirstPaths(): string[] {
  const toml = readFileSync(resolve(WORKER_DIR, "wrangler.toml"), "utf8");
  const m = toml.match(/^run_worker_first\s*=\s*\[([\s\S]*?)\]/m);
  assert.ok(m, "run_worker_first ausente em workers/artigos/wrangler.toml");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const key = (a: { slug: string; year: string }) => `${a.year}/${a.slug}`;

describe("#9226 — registros de Artigo Especial gateado em sincronia", () => {
  it("ARTICLES e GATED_ARTICLES têm os mesmos (ano, slug)", () => {
    assert.deepEqual(
      ARTICLES.map(key).sort(),
      GATED_ARTICLES.map(key).sort(),
    );
  });

  it("run_worker_first == paths dos artigos gateados (nos dois sentidos)", () => {
    assert.deepEqual(runWorkerFirstPaths().sort(), gatedArticlePaths().sort());
  });

  it("cada artigo gateado tem public/{ano}/{slug}/capa.jpg", () => {
    for (const a of GATED_ARTICLES) {
      const capa = resolve(WORKER_DIR, "public", a.year, a.slug, "capa.jpg");
      assert.ok(existsSync(capa), `${capa} ausente`);
    }
  });
});
