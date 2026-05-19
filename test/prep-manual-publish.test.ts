import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { checkNewsletterHtml } from "../scripts/prep-manual-publish.ts";

/**
 * Tests pra prep-manual-publish.ts (#1047, refatorado #1185).
 *
 * Após #1185, o design suportado é apenas inline URL com `{{email}}` +
 * `{{poll_sig}}` (desde #1083). Legacy `{{poll_a_url}}`/`{{poll_b_url}}`
 * não é mais aceito — paths antigos deletados junto com inject-poll-urls.ts.
 */

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "prep-publish-"));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkNewsletterHtml validation (#1185)", () => {
  it("detecta arquivo ausente", () => {
    const editionDir = join(tmpDir, "missing-edition");
    mkdirSync(editionDir, { recursive: true });
    const result = checkNewsletterHtml(editionDir);
    assert.equal(result.passed, false);
    assert.match(result.detail, /não encontrado/);
  });

  it("rejeita HTML legacy com poll_a_url/poll_b_url (sem poll_sig)", () => {
    const editionDir = join(tmpDir, "legacy");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body>
        <a href="{{poll_a_url}}">Votar A</a>
        <a href="{{poll_b_url}}">Votar B</a>
      </body></html>`,
    );
    const result = checkNewsletterHtml(editionDir);
    assert.equal(result.passed, false);
    assert.match(result.detail, /poll_sig/);
  });

  it("rejeita HTML sem nenhuma merge tag", () => {
    const editionDir = join(tmpDir, "no-tags");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body><a>Votar A</a><a>Votar B</a></body></html>`,
    );
    const result = checkNewsletterHtml(editionDir);
    assert.equal(result.passed, false);
  });

  it("aceita HTML com inline URL ({{email}} + {{poll_sig}})", () => {
    const editionDir = join(tmpDir, "ok");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body>
        <a href="https://poll.diaria.workers.dev/vote?email={{email}}&edition=260519&choice=A&sig={{poll_sig}}">A</a>
        <a href="https://poll.diaria.workers.dev/vote?email={{email}}&edition=260519&choice=B&sig={{poll_sig}}">B</a>
      </body></html>`,
    );
    const result = checkNewsletterHtml(editionDir);
    assert.equal(result.passed, true);
    assert.match(result.detail, /poll_sig/);
  });

  it("rejeita HTML com só {{email}} (sem poll_sig)", () => {
    const editionDir = join(tmpDir, "email-only");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body>Olá {{email}}</body></html>`,
    );
    const result = checkNewsletterHtml(editionDir);
    assert.equal(result.passed, false);
  });
});
