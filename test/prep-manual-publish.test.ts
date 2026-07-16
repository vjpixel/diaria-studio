import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkNewsletterHtml, resolvePrepPublishEditionDir } from "../scripts/prep-manual-publish.ts";

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

describe("resolvePrepPublishEditionDir — auditoria #3491 (mesma classe de #3483/#3484)", () => {
  // Antes do #3491, `editionDir` era montado à mão como
  // `resolve(ROOT, "data", "editions", edition)` (layout FLAT), sem passar
  // por resolveEditionDir — ENOENT garantido em qualquer edição já migrada
  // pro layout nested (`{AAMM}/{AAMMDD}`, #2463/#3024). Este script faz
  // parte do fluxo de publicação MANUAL documentado no CLAUDE.md.
  it("resolve edição no layout NESTED (regressão #3491)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prep-publish-nested-"));
    try {
      const nestedEditionDir = join(dir, "2605", "260517");
      mkdirSync(nestedEditionDir, { recursive: true });
      const resolved = resolvePrepPublishEditionDir("260517", dir);
      assert.equal(resolved, nestedEditionDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolve edição no layout FLAT legado (compat)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prep-publish-flat-"));
    try {
      const flatEditionDir = join(dir, "260421");
      mkdirSync(flatEditionDir, { recursive: true });
      const resolved = resolvePrepPublishEditionDir("260421", dir);
      assert.equal(resolved, flatEditionDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição ausente em ambos os layouts cai no default NESTED (não flat)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prep-publish-missing-"));
    try {
      const resolved = resolvePrepPublishEditionDir("260901", dir);
      assert.equal(resolved, join(dir, "2609", "260901"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prep-manual-publish CLI — editionDir via --editions-dir (#3491)", () => {
  function runCli(args: string[]) {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const scriptPath = join(projectRoot, "scripts", "prep-manual-publish.ts");
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, BEEHIIV_API_KEY: "test-key-not-real" },
    });
  }

  // Só cobre o caminho "edição ausente" — retorna ANTES de checkWorker (rede
  // real), então é determinístico/rápido. O caminho "edição presente no
  // layout nested" é coberto pelos testes de `resolvePrepPublishEditionDir`
  // acima (sem spawnar o CLI, que tocaria rede via checkWorker/isWorkerReachable).
  it("edição ausente em ambos os layouts retorna 'edição não existe' (comportamento esperado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prep-publish-cli-missing-"));
    try {
      const r = runCli(["--edition", "260999", "--editions-dir", dir]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /edição 260999 não existe/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
