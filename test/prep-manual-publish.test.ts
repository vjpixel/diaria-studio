import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

/**
 * Tests pra prep-manual-publish.ts (#1047).
 *
 * Cobre validações puras (não interage com Beehiiv API ou Worker — esses
 * são integration testados pelo inject-poll-urls.test.ts e fetch-poll-stats).
 *
 * Foco: checkNewsletterHtml() detecta HTML faltando, sem botões, sem merge tags.
 */

// Re-implementa logic do checkNewsletterHtml em prep-manual-publish.ts.
// Mantido isolado pra teste (evita import do main que tem side effects).
function checkHtml(editionDir: string) {
  const path = resolve(editionDir, "_internal", "newsletter-final.html");
  if (!existsSync(path)) return { passed: false, reason: "missing" };
  const html = readFileSync(path, "utf8");
  const hasVotar = /Votar A/.test(html) && /Votar B/.test(html);
  const hasMergeTag = /\{\{poll_[ab]_url\}\}/.test(html);
  if (!hasVotar) return { passed: false, reason: "no_votar_buttons" };
  if (!hasMergeTag) return { passed: false, reason: "no_merge_tags" };
  return { passed: true, reason: "ok" };
}

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "prep-publish-"));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkNewsletterHtml validation", () => {
  it("detecta arquivo ausente", () => {
    const editionDir = join(tmpDir, "missing-edition");
    mkdirSync(editionDir, { recursive: true });
    const result = checkHtml(editionDir);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "missing");
  });

  it("detecta HTML sem botões Votar", () => {
    const editionDir = join(tmpDir, "no-votar");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body><p>{{poll_a_url}}</p></body></html>`,
    );
    const result = checkHtml(editionDir);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "no_votar_buttons");
  });

  it("detecta HTML sem merge tags poll_*_url", () => {
    const editionDir = join(tmpDir, "no-mergetag");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body><a>Votar A</a><a>Votar B</a></body></html>`,
    );
    const result = checkHtml(editionDir);
    assert.equal(result.passed, false);
    assert.equal(result.reason, "no_merge_tags");
  });

  it("aceita HTML com botões + merge tags", () => {
    const editionDir = join(tmpDir, "ok");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body>
        <a href="{{poll_a_url}}">Votar A</a>
        <a href="{{poll_b_url}}">Votar B</a>
      </body></html>`,
    );
    const result = checkHtml(editionDir);
    assert.equal(result.passed, true);
    assert.equal(result.reason, "ok");
  });
});
