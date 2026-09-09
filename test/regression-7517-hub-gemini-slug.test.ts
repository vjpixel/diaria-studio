/**
 * test/regression-7517-hub-gemini-slug.test.ts (#7798, #633)
 *
 * Regressão do #7517: o dataset do hub `google-gemini` foi reconstruído
 * perdendo 2 slugs. Este teste não exercita lógica — verifica que os
 * artefatos gerados (páginas, dataset e sitemap) seguem contendo os slugs
 * restaurados, que é exatamente o que a reconstrução defasada apagava.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "..");

const SLUGS = [
  "banco-da-inglaterra-teme-colapso-economico-global",
  "google-lanca-dois-modelos-gemini-de-uma-vez",
] as const;

describe("regressão #7517 — hub google-gemini reconstruído", () => {
  test("página do slug restaurado existe e o índice cita os 2 slugs", () => {
    const html = resolve(repoRoot, `workers/site/public/p/${SLUGS[0]}/index.html`);
    assert.equal(existsSync(html), true, `página ausente: ${html}`);

    const index = readFileSync(resolve(repoRoot, "workers/site/public/index.html"), "utf-8");
    for (const slug of SLUGS) {
      assert.ok(index.includes(slug), `index.html não cita o slug restaurado ${slug}`);
    }
  });

  test("dataset do hub tem UPDATED_DATE 2026-09-03 (não a 08-27 defasada)", () => {
    const ts = readFileSync(resolve(repoRoot, "scripts/lib/hubs/google-gemini.ts"), "utf-8");
    // A data antiga pode sobreviver em comentário histórico; o gate é a nova estar presente.
    assert.ok(ts.includes("2026-09-03"), "dataset do hub não tem a UPDATED_DATE 2026-09-03");
  });

  test("sitemap contém os 2 slugs restaurados", () => {
    const sitemap = readFileSync(resolve(repoRoot, "workers/site/public/sitemap.xml"), "utf-8");
    for (const slug of SLUGS) {
      assert.ok(sitemap.includes(slug), `sitemap.xml não cita o slug restaurado ${slug}`);
    }
  });
});
