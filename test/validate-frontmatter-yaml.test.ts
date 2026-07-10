/**
 * test/validate-frontmatter-yaml.test.ts (#2553; migrado pra JSON #3222)
 *
 * Testa o guard `validateIntentionalErrorJson` — valida o schema de
 * `_internal/intentional-error.json`.
 *
 * Histórico (#3205/#3222): até 260710 este script detectava colapso de YAML
 * multi-linha no frontmatter de `02-reviewed.md` (bug real da edição 260625:
 * title-picker colapsou `intentional_error` de YAML multi-linha para uma
 * única linha corrompida `## intentional_error: description: "..." ...`).
 * A causa raiz era o round-trip via Google Docs — `02-reviewed.md` sincroniza
 * com o Drive e o exportador do Docs não preserva indentação/quebras de linha
 * em blocos `---...---`. A correção (#3222) move os campos estruturados pra
 * `_internal/intentional-error.json`, que nunca sincroniza com o Drive — não
 * existe mais bloco YAML pra colapsar, então a classe de bug "colapso de YAML
 * multi-linha via round-trip" é estruturalmente impossível agora. Os testes
 * de fixture de colapso foram removidos; o script foi repurposed para validar
 * o schema JSON (campos presentes/preenchidos), não mais parsing YAML.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  validateIntentionalErrorJson,
  REQUIRED_IE_FIELDS,
} from "../scripts/validate-frontmatter-yaml.ts";
import { intentionalErrorJsonPath } from "../scripts/lib/intentional-errors.ts";
import type { IntentionalErrorJson } from "../scripts/lib/intentional-errors.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Record válido (5 chaves preenchidas) */
const VALID_RECORD: IntentionalErrorJson = {
  description: "Nubank está avaliado em US$ 12 bilhões",
  location: "DESTAQUE 2, parágrafo 1",
  category: "numeric",
  correct_value: "US$ 10 bilhões",
  reveal: "Na última edição, escrevi US$ 12 bi onde o correto é US$ 10 bi.",
};

/** Record com placeholders {PREENCHER} (inserido automaticamente pelo render-erro-intencional) */
const PLACEHOLDER_RECORD: IntentionalErrorJson = {
  description: "{PREENCHER — o que o assinante deve identificar}",
  location: "{PREENCHER — ex: DESTAQUE 2, parágrafo 1}",
  category: "{PREENCHER — factual|ortografico|numeric|attribution|data|version_inconsistency|factual_synthetic}",
  correct_value: "{PREENCHER — valor correto}",
  reveal: "{PREENCHER — prosa 1ª pessoa para o reveal da próxima edição}",
};

/** Record com 4 de 5 campos (reveal faltando) */
const MISSING_REVEAL_RECORD: IntentionalErrorJson = {
  description: "Descrição do erro",
  location: "DESTAQUE 1, parágrafo 2",
  category: "ortografico",
  correct_value: "Nubank",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateIntentionalErrorJson — record válido (#2553/#3222)", () => {
  it("OK com record completo (5 chaves preenchidas)", () => {
    const r = validateIntentionalErrorJson(VALID_RECORD);
    assert.equal(r.ok, true, `esperado ok=true, message: ${r.message}`);
    assert.equal(r.checked, true);
    assert.deepEqual(r.missing_fields, []);
  });

  it("FAIL com placeholders {PREENCHER} — tratados como não-preenchidos (widening vs script antigo)", () => {
    // Diferença deliberada do script antigo: frontmatter YAML aceitava placeholders
    // como "estrutura OK, valores incompletos é problema do Stage 5". O novo script
    // JSON trata placeholder como campo ausente — mais estrito, já que o schema JSON
    // não tem ambiguidade estrutural pra validar separadamente do conteúdo.
    const r = validateIntentionalErrorJson(PLACEHOLDER_RECORD);
    assert.equal(r.ok, false, `esperado ok=false pra record só com placeholders, message: ${r.message}`);
    assert.equal(r.missing_fields.length, REQUIRED_IE_FIELDS.length);
  });

  it("OK com { no_error: true } (#2016)", () => {
    const r = validateIntentionalErrorJson({ no_error: true });
    assert.equal(r.ok, true, `esperado ok=true, message: ${r.message}`);
    assert.equal(r.checked, true);
    assert.match(r.message, /no_error/);
  });

  it("OK (checked=false) quando record é null — outro check (check-stage2-invariants) captura ausência", () => {
    const r = validateIntentionalErrorJson(null);
    assert.equal(r.ok, true);
    assert.equal(r.checked, false);
    assert.match(r.message, /ausente/);
  });

  it("REQUIRED_IE_FIELDS tem as 5 chaves esperadas", () => {
    assert.deepEqual(
      [...REQUIRED_IE_FIELDS].sort(),
      ["category", "correct_value", "description", "location", "reveal"].sort(),
    );
  });
});

describe("validateIntentionalErrorJson — campos faltando/incompletos (#2553/#3222)", () => {
  it("FAIL quando chave `reveal` faltando (4 de 5 campos presentes)", () => {
    const r = validateIntentionalErrorJson(MISSING_REVEAL_RECORD);
    assert.equal(r.ok, false, `esperado ok=false para reveal faltando, message: ${r.message}`);
    assert.ok(r.missing_fields.includes("reveal"), `missing_fields deve incluir 'reveal', got: ${JSON.stringify(r.missing_fields)}`);
    assert.equal(r.missing_fields.length, 1);
  });

  it("FAIL quando record é objeto vazio (todas as 5 chaves ausentes)", () => {
    const r = validateIntentionalErrorJson({});
    assert.equal(r.ok, false, `esperado ok=false, message: ${r.message}`);
    assert.equal(r.missing_fields.length, REQUIRED_IE_FIELDS.length, `todas as 5 chaves devem estar faltando, got: ${JSON.stringify(r.missing_fields)}`);
  });

  it("FAIL quando 3 chaves presentes e 2 ausentes", () => {
    const record: IntentionalErrorJson = {
      description: "teste",
      location: "DESTAQUE 1",
      category: "factual",
    };
    const r = validateIntentionalErrorJson(record);
    assert.equal(r.ok, false, `esperado ok=false, message: ${r.message}`);
    const missing = r.missing_fields;
    assert.ok(missing.includes("correct_value"), "correct_value deve estar faltando");
    assert.ok(missing.includes("reveal"), "reveal deve estar faltando");
    assert.equal(missing.length, 2);
  });

  it("FAIL quando campo é string vazia (não conta como preenchido)", () => {
    const record: IntentionalErrorJson = {
      description: "",
      location: "DESTAQUE 1",
      category: "factual",
      correct_value: "X",
      reveal: "Na última edição, X.",
    };
    const r = validateIntentionalErrorJson(record);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing_fields, ["description"]);
  });
});

describe("validate-frontmatter-yaml.ts CLI — deriva _internal/intentional-error.json do --md (#3222)", () => {
  function runCli(mdPath: string) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "validate-frontmatter-yaml.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--md", mdPath],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("exit 0 quando _internal/intentional-error.json (sibling de --md) é válido", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-ie-json-cli-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(mdPath, "Corpo.\n", "utf8");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(intentionalErrorJsonPath(dir), JSON.stringify(VALID_RECORD, null, 2), "utf8");
      const r = runCli(mdPath);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 1 quando _internal/intentional-error.json tem campos faltando", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-ie-json-cli-fail-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(mdPath, "Corpo.\n", "utf8");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(intentionalErrorJsonPath(dir), JSON.stringify(MISSING_REVEAL_RECORD, null, 2), "utf8");
      const r = runCli(mdPath);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /reveal/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 0 (checked=false) quando _internal/intentional-error.json não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-ie-json-cli-missing-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(mdPath, "Corpo.\n", "utf8");
      const r = runCli(mdPath);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.checked, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 2 quando --md aponta pra arquivo inexistente", () => {
    const r = runCli("/tmp/__nonexistent-edition__/02-reviewed.md");
    assert.equal(r.status, 2);
  });
});
