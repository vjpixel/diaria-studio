import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("prep-manual-publish #2286 — publicationId via platform.config.json fallback", () => {
  // Regressão: antes de #2286, prep-manual-publish.ts abortava com
  // "envs ausentes: BEEHIIV_PUBLICATION_ID" mesmo quando platform.config.json
  // continha beehiiv.publicationId. Verificar que o módulo agora importa
  // loadBeehiivConfig (fallback config) em vez de checar o env diretamente.
  it("prep-manual-publish.ts importa loadBeehiivConfig de scripts/lib/beehiiv-config.ts", () => {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const src = readFileSync(resolve(ROOT, "scripts/prep-manual-publish.ts"), "utf8");
    // O script deve importar loadBeehiivConfig
    assert.ok(
      src.includes("loadBeehiivConfig"),
      "prep-manual-publish.ts deve importar loadBeehiivConfig (#2286 — fallback via config)",
    );
    // A verificação manual de publicationId (que abortava sem env) não deve mais existir
    assert.ok(
      !src.includes('missing.push("BEEHIIV_PUBLICATION_ID")'),
      "prep-manual-publish.ts não deve mais checar BEEHIIV_PUBLICATION_ID manualmente (removido em #2286)",
    );
  });

  it("beehiiv-config.ts: loadBeehiivConfig lê publicationId de platform.config.json quando env ausente", () => {
    // Verifica o helper centralizado usado agora por prep-manual-publish + verify-scheduled-post.
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const helperSrc = readFileSync(resolve(ROOT, "scripts/lib/beehiiv-config.ts"), "utf8");
    // Helper deve ter lógica de fallback config
    assert.ok(
      helperSrc.includes("platform.config.json"),
      "beehiiv-config.ts deve ler platform.config.json como fallback",
    );
    assert.ok(
      helperSrc.includes("BEEHIIV_PUBLICATION_ID"),
      "beehiiv-config.ts deve tentar BEEHIIV_PUBLICATION_ID primeiro",
    );
    // Verificar que platform.config.json tem o publicationId esperado
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
      beehiiv?: { publicationId?: string };
    };
    assert.ok(
      cfg.beehiiv?.publicationId?.startsWith("pub_"),
      `platform.config.json.beehiiv.publicationId deve começar com 'pub_', got: ${cfg.beehiiv?.publicationId}`,
    );
  });
});
