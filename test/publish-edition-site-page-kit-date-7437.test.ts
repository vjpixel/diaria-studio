/**
 * test/publish-edition-site-page-kit-date-7437.test.ts (#7437)
 *
 * REGRESSÃO: com backend Kit (`publishing.newsletter.backend === "kit"`),
 * `05-published.json` nunca é escrito — o caminho `--slug` de
 * `readEditionInputs` (`scripts/publish-edition-site-page.ts`) retornava
 * `publishedAtIso: null` incondicionalmente. Esse `null` É consumido:
 * `buildEditionArchivePost` (`scripts/lib/edition-site-page.ts`) usa pra
 * `publish_date` → `sitemapEntryFromPost` grava a `<url>` do sitemap SEM
 * `<lastmod>` → a home (#7436) trata a entrada como a mais antiga possível.
 *
 * Cobre as duas fontes de `deriveFallbackPublishedAtIso`:
 * 1. `_internal/newsletter-kit-published.json` → `scheduled_at`, quando
 *    presente (precedência sobre o fallback de diretório).
 * 2. Fallback: `AAMMDD` do nome do diretório da edição.
 *
 * E o cenário REAL ponta-a-ponta pedido pela issue: `readEditionInputs` com
 * `slugOverride` numa edição Kit → `sitemapEntryFromPost` precisa devolver
 * `lastmod` definido (não mais `undefined`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEditionInputs } from "../scripts/publish-edition-site-page.ts";
import { buildEditionArchivePost } from "../scripts/lib/edition-site-page.ts";
import { sitemapEntryFromPost } from "../scripts/lib/site-archive-pages.ts";

/** Diretório de edição Kit-like: `newsletter-final.html` existe, `05-published.json` nunca existe. */
function makeKitEditionDir(aammdd: string): string {
  const parent = mkdtempSync(join(tmpdir(), "diaria-site-page-7437-"));
  const dir = join(parent, aammdd);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<p>corpo Kit</p>", "utf8");
  return dir;
}

function makeRootWithBackend(backend: string): string {
  const rootDir = mkdtempSync(join(tmpdir(), "diaria-site-page-7437-root-"));
  writeFileSync(
    join(rootDir, "platform.config.json"),
    JSON.stringify({ publishing: { newsletter: { backend } } }),
    "utf8",
  );
  return rootDir;
}

describe("#7437 readEditionInputs — publishedAtIso não fica null pra edição Kit com --slug", () => {
  it("sem newsletter-kit-published.json ⇒ fallback pro AAMMDD do diretório da edição", () => {
    const dir = makeKitEditionDir("260905");
    const rootDir = makeRootWithBackend("kit");
    try {
      const result = readEditionInputs(dir, "um-slug-qualquer", rootDir);
      assert.ok(result);
      assert.equal(result!.publishedAtIso, "2026-09-05T00:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("com newsletter-kit-published.json (scheduled_at) ⇒ usa o timestamp real, não o fallback de diretório", () => {
    const dir = makeKitEditionDir("260905");
    const rootDir = makeRootWithBackend("kit");
    try {
      writeFileSync(
        join(dir, "_internal", "newsletter-kit-published.json"),
        JSON.stringify({
          broadcast_id: 123,
          subject: "assunto",
          preview_text: "preview",
          status: "scheduled",
          scheduled_at: "2026-09-05T09:00:00.000Z",
        }),
        "utf8",
      );
      const result = readEditionInputs(dir, "um-slug-qualquer", rootDir);
      assert.ok(result);
      assert.equal(result!.publishedAtIso, "2026-09-05T09:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("newsletter-kit-published.json malformado ⇒ fail-soft, cai pro fallback de diretório", () => {
    const dir = makeKitEditionDir("260905");
    const rootDir = makeRootWithBackend("kit");
    try {
      writeFileSync(join(dir, "_internal", "newsletter-kit-published.json"), "{ não é json", "utf8");
      const result = readEditionInputs(dir, "um-slug-qualquer", rootDir);
      assert.ok(result);
      assert.equal(result!.publishedAtIso, "2026-09-05T00:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("basename do diretório não é AAMMDD e não há newsletter-kit-published.json ⇒ null (nunca inventa data)", () => {
    // mkdtempSync gera sufixo aleatório — basename não bate AAMMDD.
    const dir = mkdtempSync(join(tmpdir(), "diaria-site-page-7437-naoaammdd-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "newsletter-final.html"), "<p>corpo Kit</p>", "utf8");
    const rootDir = makeRootWithBackend("kit");
    try {
      const result = readEditionInputs(dir, "um-slug-qualquer", rootDir);
      assert.ok(result);
      assert.equal(result!.publishedAtIso, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("CENÁRIO REAL da issue: readEditionInputs com slugOverride numa edição Kit → sitemapEntryFromPost devolve lastmod definido", () => {
    const dir = makeKitEditionDir("260905");
    const rootDir = makeRootWithBackend("kit");
    writeFileSync(join(dir, "02-reviewed.md"), ["TÍTULO", "Título da edição Kit"].join("\n"), "utf8");
    try {
      const inputs = readEditionInputs(dir, "edicao-kit-do-dia", rootDir);
      assert.ok(inputs);
      const result = buildEditionArchivePost(inputs!);
      assert.ok(result.ok, result.ok ? undefined : result.reason);
      if (!result.ok) return;
      assert.notEqual(result.post.publish_date, null, "publish_date não pode ficar null — quebra o lastmod do sitemap");
      const entry = sitemapEntryFromPost(result.post);
      assert.ok(entry.lastmod, "sitemapEntryFromPost precisa devolver lastmod definido pra edição Kit");
      assert.equal(entry.lastmod, "2026-09-05");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
