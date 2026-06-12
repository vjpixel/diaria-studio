import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { checkNewsletterHtml } from "../scripts/prep-manual-publish.ts";

/**
 * Tests pra prep-manual-publish.ts (#1047, refatorado #1185, simplificado #1186).
 *
 * Desde #1186, o design suportado é modo merge-tag: URL de voto com `{{email}}`
 * SEM `&sig={{poll_sig}}`. O check de custom field poll_sig foi removido.
 */

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "prep-publish-"));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkNewsletterHtml validation (#1186 merge-tag mode)", () => {
  it("detecta arquivo ausente", () => {
    const editionDir = join(tmpDir, "missing-edition");
    mkdirSync(editionDir, { recursive: true });
    const result = checkNewsletterHtml(editionDir);
    assert.equal(result.passed, false);
    assert.match(result.detail, /não encontrado/);
  });

  it("rejeita HTML sem {{email}} (sem nenhuma merge tag)", () => {
    const editionDir = join(tmpDir, "no-tags");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body><a href="https://poll.diaria.workers.dev/vote?email=test@test.com">Votar A</a></body></html>`,
    );
    const result = checkNewsletterHtml(editionDir);
    assert.equal(result.passed, false);
    assert.match(result.detail, /\{\{email\}\}/);
  });

  it("aceita HTML com inline URL modo merge-tag ({{email}} sem sig) — #1186", () => {
    const editionDir = join(tmpDir, "merge-tag-ok");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body>
        <a href="https://poll.diaria.workers.dev/vote?email={{email}}&edition=260519&choice=A">A</a>
        <a href="https://poll.diaria.workers.dev/vote?email={{email}}&edition=260519&choice=B">B</a>
      </body></html>`,
    );
    const result = checkNewsletterHtml(editionDir);
    assert.equal(result.passed, true);
    assert.match(result.detail, /merge-tag/);
  });

  it("aceita HTML com {{email}} mesmo sem {{poll_sig}} — modo merge-tag (#1186)", () => {
    // Regressão: antes de #1186, precisava de poll_sig. Agora só {{email}} basta.
    const editionDir = join(tmpDir, "email-only-ok");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(editionDir, "_internal", "newsletter-final.html"),
      `<html><body>
        <a href="https://poll.diaria.workers.dev/vote?email={{email}}&edition=260612&choice=A">A</a>
      </body></html>`,
    );
    const result = checkNewsletterHtml(editionDir);
    assert.equal(result.passed, true, "{{email}} sem poll_sig deve passar (#1186)");
  });

  it("rejeita HTML legacy com poll_a_url/poll_b_url (sem {{email}})", () => {
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
    assert.match(result.detail, /\{\{email\}\}/);
  });
});
