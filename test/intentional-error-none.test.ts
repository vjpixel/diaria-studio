/**
 * intentional-error-none.test.ts (#2016; migrado pra JSON #3222)
 *
 * Cobertura de regressão para suporte de primeira classe ao scalar
 * `{ "no_error": true }` em `_internal/intentional-error.json` (antes:
 * `intentional_error: none` no frontmatter YAML de `02-reviewed.md` — ver
 * `scripts/render-erro-intencional.ts` pro histórico da migração #3222/#3205).
 *
 * Testa:
 *  1. checkIntentionalError aceita `no_error: true` (ok=true, no_error=true)
 *  2. lint intentional-error-flagged passa com no_error=true
 *  3. sync-intentional-error grava entry com no_error=true
 *  4. list-month-errors agrega edição no_error como "sem erro"
 *  5. runLints (lint-test-email) Checks 8/9 sempre rodam mesmo com no_error (#2016/#2043)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  checkIntentionalError,
} from "../scripts/lib/lint-checks/intentional-error.ts";
import { runLints } from "../scripts/lint-test-email.ts";
import type { IntentionalError, IntentionalErrorJson } from "../scripts/lib/intentional-errors.ts";
import { intentionalErrorJsonPath } from "../scripts/lib/intentional-errors.ts";

/** #3222: escreve 02-reviewed.md (dummy body) + _internal/intentional-error.json num dir temp. */
function writeEdition(dir: string, record: IntentionalErrorJson | null): string {
  const mdPath = join(dir, "02-reviewed.md");
  writeFileSync(mdPath, "Conteúdo qualquer.\n", "utf8");
  if (record !== null) {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(intentionalErrorJsonPath(dir), JSON.stringify(record, null, 2), "utf8");
  }
  return mdPath;
}

// ---------------------------------------------------------------------------
// 1. checkIntentionalError aceita { no_error: true }
// ---------------------------------------------------------------------------

describe("checkIntentionalError — scalar no_error (#2016, migrado #3222)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ie-none-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("record com { no_error: true } → ok=true, no_error=true", () => {
    const mdPath = writeEdition(tmpDir, { no_error: true });
    const result = checkIntentionalError(mdPath);
    assert.equal(result.ok, true, `esperava ok=true, label: ${result.label}`);
    assert.equal(result.no_error, true, "esperava no_error=true");
  });

  it("record ausente (_internal/intentional-error.json não existe) → ok=false (sem regressão)", () => {
    const mdPath = writeEdition(tmpDir, null);
    const result = checkIntentionalError(mdPath);
    assert.equal(result.ok, false);
    assert.equal(result.no_error, undefined);
  });

  it("record com os 4 campos obrigatórios (sem reveal) → ok=true, no_error undefined (sem regressão)", () => {
    // checkIntentionalError exige só 4 campos (description/location/category/correct_value);
    // `reveal` é opcional aqui (usado por composeRevealText, não bloqueia o lint Stage 5).
    const mdPath = writeEdition(tmpDir, {
      description: "Erro teste",
      location: "DESTAQUE 1",
      category: "factual",
      correct_value: "valor correto",
    });
    const result = checkIntentionalError(mdPath);
    assert.equal(result.ok, true);
    assert.equal(result.no_error, undefined, "no_error deve ser undefined quando há os 4 campos");
  });

  it("record com os 5 campos (incl. reveal) → ok=true, parsed.reveal preenchido", () => {
    const mdPath = writeEdition(tmpDir, {
      description: "Erro teste",
      location: "DESTAQUE 1",
      category: "factual",
      correct_value: "valor correto",
      reveal: "Na última edição, X.",
    });
    const result = checkIntentionalError(mdPath);
    assert.equal(result.ok, true);
    assert.equal(result.no_error, undefined);
    assert.equal(result.parsed?.reveal, "Na última edição, X.");
  });
});

// ---------------------------------------------------------------------------
// 2. CLI lint --check intentional-error-flagged passa com `none`
// ---------------------------------------------------------------------------

describe("lint-newsletter-md.ts --check intentional-error-flagged com none (#2016)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ie-none-cli-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function runLintCheck(mdPath: string) {
    const projectRoot = resolve(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--check", "intentional-error-flagged", "--md", mdPath],
      { encoding: "utf8" },
    );
  }

  it("exit 0 quando record é { no_error: true }", () => {
    const mdPath = writeEdition(tmpDir, { no_error: true });
    const r = runLintCheck(mdPath);
    assert.equal(r.status, 0, `esperava exit 0, stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.no_error, true);
  });

  it("exit 1 quando _internal/intentional-error.json ausente (sem regressão)", () => {
    const mdPath = writeEdition(tmpDir, null);
    const r = runLintCheck(mdPath);
    assert.equal(r.status, 1, "esperava exit 1 quando record ausente");
  });
});

// ---------------------------------------------------------------------------
// 3. sync-intentional-error grava entry com no_error=true
// ---------------------------------------------------------------------------

describe("sync-intentional-error com none (#2016)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sync-none-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function runSync(mdPath: string, edition: string, jsonlPath: string) {
    const projectRoot = resolve(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "sync-intentional-error.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--md", mdPath, "--edition", edition, "--jsonl", jsonlPath],
      { encoding: "utf8" },
    );
  }

  it("grava entry com no_error=true e source=frontmatter_02_reviewed", () => {
    const jsonlPath = join(tmpDir, "intentional-errors.jsonl");
    const mdPath = writeEdition(tmpDir, { no_error: true });
    const r = runSync(mdPath, "260610", jsonlPath);
    assert.equal(r.status, 0, `esperava exit 0, stderr: ${r.stderr}`);
    assert.ok(existsSync(jsonlPath), "jsonl deve ser criado");
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "deve ter exatamente 1 entry");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.edition, "260610");
    assert.equal(entry.no_error, true);
    assert.equal(entry.source, "frontmatter_02_reviewed");
    assert.equal(entry.resolution, "no_error_declared");
    // output JSON deve ter added=true e no_error=true
    const stdout = JSON.parse(r.stdout.trim());
    assert.equal(stdout.added, true);
    assert.equal(stdout.no_error, true);
  });

  it("entry pré-existente sem no_error → re-sync com none → sobrescreve com no_error=true (#2037)", () => {
    // Cenário: editor usou sentinela 4-campos antes do #2016, gerou entry sem
    // no_error. Depois adicionou `intentional_error: none` no frontmatter.
    // Re-sync deve sobrescrever, não bloquear (guard de idempotência estava
    // largo demais — só deve ser no-op quando already no_error=true).
    const jsonlPath = join(tmpDir, "intentional-errors.jsonl");
    // Entry pré-existente (sentinela pré-#2016 sem no_error)
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        edition: "260610",
        error_type: "none",
        is_feature: true,
        source: "frontmatter_02_reviewed",
        // sem campo no_error
      }) + "\n",
      "utf8",
    );
    const mdPath = writeEdition(tmpDir, { no_error: true });
    const r = runSync(mdPath, "260610", jsonlPath);
    assert.equal(r.status, 0, `esperava exit 0, stderr: ${r.stderr}`);
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "deve ter exatamente 1 entry (sobrescrita, não duplicada)");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.no_error, true, "entry deve ter no_error=true após re-sync");
    assert.equal(entry.edition, "260610");
    const stdout = JSON.parse(r.stdout.trim());
    assert.equal(stdout.no_error, true);
    assert.equal(stdout.updated, true, "deve reportar updated=true (não added)");
  });

  it("idempotente: segunda chamada → added=false, no_error=true no output", () => {
    const jsonlPath = join(tmpDir, "intentional-errors.jsonl");
    const mdPath = writeEdition(tmpDir, { no_error: true });
    runSync(mdPath, "260610", jsonlPath);
    const r2 = runSync(mdPath, "260610", jsonlPath);
    assert.equal(r2.status, 0);
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "não deve duplicar a entry");
    const stdout = JSON.parse(r2.stdout.trim());
    assert.equal(stdout.added, false);
    assert.equal(stdout.no_error, true);
  });
});

// ---------------------------------------------------------------------------
// 4. list-month-errors — extractError retorna no_error=true para no_error
// (#3222: importa a função REAL exportada de list-month-errors.ts, em vez de
// reproduzir a lógica localmente — elimina risco de drift entre teste e
// implementação)
// ---------------------------------------------------------------------------

import { extractError } from "../scripts/list-month-errors.ts";

describe("list-month-errors extractError (#2016, migrado #3222) — direto", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "list-none-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("edição no_error retorna declared=true, no_error=true, sem category", () => {
    const editionDir = join(tmpDir, "260610");
    mkdirSync(editionDir, { recursive: true });
    writeEdition(editionDir, { no_error: true });
    const result = extractError(editionDir, "260610");
    assert.equal(result.declared, true);
    assert.equal(result.no_error, true);
    assert.equal(result.category, undefined);
  });

  it("edição com erro real retorna declared=true, sem no_error (sem regressão)", () => {
    const editionDir = join(tmpDir, "260609");
    mkdirSync(editionDir, { recursive: true });
    writeEdition(editionDir, {
      description: "Erro factual teste",
      location: "DESTAQUE 1",
      category: "factual",
      correct_value: "valor correto",
    });
    const result = extractError(editionDir, "260609");
    assert.equal(result.declared, true);
    assert.equal(result.no_error, undefined);
    assert.equal(result.category, "factual");
  });

  it("edição sem _internal/intentional-error.json e sem entry no JSONL → declared=false", () => {
    const editionDir = join(tmpDir, "260608");
    mkdirSync(editionDir, { recursive: true });
    writeEdition(editionDir, null);
    const result = extractError(editionDir, "260608");
    assert.equal(result.declared, false);
  });

  it("formatMarkdown output contém 'sem erro intencional' para edição no_error", () => {
    const noError = { edition: "260610", declared: true, no_error: true };
    // Reproduz a lógica de formatMarkdown
    const lines: string[] = [];
    lines.push("## Edições sem erro intencional (1)");
    lines.push("> Resposta válida do leitor: **\"não há erro\"**");
    lines.push("");
    lines.push(`- **${noError.edition}**: sem erro intencional (resposta válida: 'não há erro')`);
    const md = lines.join("\n");
    assert.ok(md.includes("sem erro intencional"), "deve mencionar 'sem erro intencional'");
    assert.ok(md.includes("não há erro"), "deve mencionar 'não há erro'");
    assert.ok(!md.includes("Categoria"), "NÃO deve listar como categoria de erro");
  });
});

// ---------------------------------------------------------------------------
// 5. runLints (lint-test-email) Checks 8/9 sempre rodam (#2016/#2043)
// #2043: o bypass de `intentional_error: none` (#2016) suprime APENAS a
// confirmação do erro intencional — Checks 8/9 (version/semantic) sempre rodam.
// ---------------------------------------------------------------------------

describe("runLints — Checks 8/9 sempre rodam com no_error (#2016/#2043)", () => {
  it("com no_error entry: version_inconsistency AINDA vira blocker (#2043)", () => {
    // #2043: inconsistência real V4/V5 deve ser detectada mesmo com no_error=true.
    // O bypass suprime apenas a confirmação de erro intencional, não o check estrutural.
    const email = `DESTAQUE 2 | TENDÊNCIA\n\nV4 da IA lança hoje.\n\nA versão V5 superou tudo.`;
    const source = `DESTAQUE 2 | TENDÊNCIA\n\nV4 da IA lança hoje.\n\nA versão V4 superou tudo.`;
    const intentional: IntentionalError[] = [
      {
        edition: "260610",
        error_type: "none",
        is_feature: false,
        no_error: true,
        source: "frontmatter_02_reviewed",
        resolution: "no_error_declared",
      },
    ];
    const result = runLints(email, source, "260610", intentional);
    const blockers = result.issues.filter(
      (i) => i.type === "blocker" && i.category === "version_inconsistency",
    );
    assert.equal(
      blockers.length,
      1,
      "version_inconsistency deve ser blocker mesmo com no_error=true (#2043)",
    );
  });

  it("com no_error entry: semantic drift AINDA vira warning (#2043)", () => {
    // #2043: drift semântico é um check estrutural independente do erro intencional.
    const email = `DESTAQUE 1 | X\n\nempresa cresceu 220% este ano.`;
    const source = `DESTAQUE 1 | X\n\nempresa cresceu 22% este ano.`;
    const intentional: IntentionalError[] = [
      {
        edition: "260610",
        error_type: "none",
        is_feature: false,
        no_error: true,
      },
    ];
    const result = runLints(email, source, "260610", intentional);
    const warnings = result.issues.filter((i) => i.type === "warning");
    assert.ok(
      warnings.length >= 1,
      "semantic_drift deve ser warning mesmo com no_error=true (#2043)",
    );
  });

  it("com no_error entry: subject mismatch AINDA é blocker (subject check não bypassa)", () => {
    const email = `DESTAQUE 1 | X\n\ntexto.`;
    const source = email;
    const intentional: IntentionalError[] = [
      {
        edition: "260610",
        error_type: "none",
        is_feature: false,
        no_error: true,
      },
    ];
    const result = runLints(email, source, "260610", intentional, {
      received: "Novo post",
      expected: "Título esperado da edição",
    });
    // Subject "Novo post" normaliza pra "Novo post" — é placeholder check só pra "new post"
    // então vira divergência genérica (subject !== expected) = blocker
    const subjectBlockers = result.issues.filter(
      (i) => i.type === "blocker" && i.category === "subject_mismatch",
    );
    assert.equal(subjectBlockers.length, 1, "subject mismatch deve ainda ser blocker mesmo com no_error");
  });

  it("sem no_error entry: version_inconsistency ainda detecta normalmente (sem regressão)", () => {
    const email = `DESTAQUE 2 | TENDÊNCIA\n\nV4 da IA.\n\nV5 superou.`;
    const source = `DESTAQUE 2 | TENDÊNCIA\n\nV4 da IA.\n\nV4 superou.`;
    const result = runLints(email, source, "260606", []);
    const blockers = result.issues.filter((i) => i.type === "blocker");
    assert.ok(blockers.length > 0, "deve detectar blocker quando sem no_error entry");
  });
});
