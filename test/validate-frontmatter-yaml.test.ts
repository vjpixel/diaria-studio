/**
 * test/validate-frontmatter-yaml.test.ts (#2553)
 *
 * Testa o guard pós-title-picker que valida o frontmatter YAML de
 * `02-reviewed.md`. Cobre o bug real da edição 260625: title-picker colapsou
 * `intentional_error` de YAML multi-linha para uma única linha corrompida.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateFrontmatterYaml,
  REQUIRED_IE_FIELDS,
} from "../scripts/validate-frontmatter-yaml.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Frontmatter válido (5 chaves, multi-linha) */
const VALID_MD = `---
intentional_error:
  description: "Nubank está avaliado em US$ 12 bilhões"
  location: "DESTAQUE 2, parágrafo 1"
  category: "numeric"
  correct_value: "US$ 10 bilhões"
  reveal: "Na última edição, escrevi US$ 12 bi onde o correto é US$ 10 bi."
---

TÍTULO

GPT-5 chega com Codex Superapp

SUBTÍTULO

Nubank vira unicórnio

---

DESTAQUE 1 | 🚀 LANÇAMENTO

Título do destaque 1

Corpo do destaque.
`;

/** Frontmatter corrompido — exatamente como relatado na edição 260625 */
const COLLAPSED_MD = `## intentional_error: description: "Nubank está avaliado em US$ 12 bilhões" location: "DESTAQUE 2, parágrafo 1" category: "numeric" correct_value: "US$ 10 bilhões" reveal: "Na última edição, escrevi X onde o correto é Y."

TÍTULO

GPT-5 chega com Codex Superapp
`;

/** Frontmatter colapsado sem prefixo ## (variante possível) */
const COLLAPSED_NO_PREFIX_MD = `---
intentional_error: description: "Nubank" location: "DESTAQUE 2" category: "numeric" correct_value: "US$ 10 bi" reveal: "Na última edição, escrevi X."
---
corpo
`;

/** Frontmatter com intentional_error mas sem chave `reveal` (4 de 5 campos) */
const MISSING_REVEAL_MD = `---
intentional_error:
  description: "Descrição do erro"
  location: "DESTAQUE 1, parágrafo 2"
  category: "ortografico"
  correct_value: "Nubank"
---
corpo
`;

/** Frontmatter com placeholders {PREENCHER} (inserido automaticamente pelo render-erro-intencional) */
const PLACEHOLDER_MD = `---
intentional_error:
  description: "{PREENCHER — o que o assinante deve identificar}"
  location: "{PREENCHER — ex: DESTAQUE 2, parágrafo 1}"
  category: "{PREENCHER — factual|ortografico|numeric|attribution|data|version_inconsistency|factual_synthetic}"
  correct_value: "{PREENCHER — valor correto}"
  reveal: "{PREENCHER — prosa 1ª pessoa para o reveal da próxima edição}"
---
corpo
`;

/** Sem frontmatter algum */
const NO_FRONTMATTER_MD = `TÍTULO

GPT-5 chega

DESTAQUE 1 | 🚀 LANÇAMENTO

Corpo.
`;

/** Frontmatter sem chave intentional_error */
const NO_IE_KEY_MD = `---
outro_campo: valor
---
corpo
`;

/** intentional_error: none (#2016) */
const IE_NONE_MD = `---
intentional_error: none
---
corpo
`;

/** CRLF — frequente no Windows/OneDrive */
const VALID_CRLF_MD = VALID_MD.replace(/\n/g, "\r\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateFrontmatterYaml — frontmatter válido (#2553)", () => {
  it("OK com frontmatter completo (5 chaves, multi-linha)", () => {
    const r = validateFrontmatterYaml(VALID_MD);
    assert.equal(r.ok, true, `esperado ok=true, message: ${r.message}`);
    assert.equal(r.checked, true);
    assert.equal(r.collapsed, false);
    assert.deepEqual(r.missing_fields, []);
  });

  it("OK com placeholders {PREENCHER} — estrutura correta mesmo sem valores reais", () => {
    const r = validateFrontmatterYaml(PLACEHOLDER_MD);
    assert.equal(r.ok, true, `esperado ok=true, message: ${r.message}`);
    assert.equal(r.collapsed, false);
  });

  it("OK com intentional_error: none (#2016)", () => {
    const r = validateFrontmatterYaml(IE_NONE_MD);
    assert.equal(r.ok, true, `esperado ok=true, message: ${r.message}`);
    assert.equal(r.checked, true);
    assert.equal(r.collapsed, false);
    assert.match(r.message, /none/);
  });

  it("OK com CRLF (Windows/OneDrive) — parser canônico é CRLF-safe", () => {
    const r = validateFrontmatterYaml(VALID_CRLF_MD);
    assert.equal(r.ok, true, `esperado ok=true com CRLF, message: ${r.message}`);
  });

  it("OK (checked=false) quando sem frontmatter — outro check captura", () => {
    const r = validateFrontmatterYaml(NO_FRONTMATTER_MD);
    assert.equal(r.ok, true);
    assert.equal(r.checked, false);
    assert.match(r.message, /frontmatter ausente/);
  });

  it("OK (checked=false) quando frontmatter sem chave intentional_error — check-stage2-invariants captura", () => {
    const r = validateFrontmatterYaml(NO_IE_KEY_MD);
    assert.equal(r.ok, true);
    assert.equal(r.checked, false);
    assert.match(r.message, /intentional_error ausente/);
  });
});

describe("validateFrontmatterYaml — corrupção real (bug 260625, #2553)", () => {
  it("FAIL com frontmatter colapsado (caso exato da edição 260625 — prefixo ##)", () => {
    // Este é o caso real: title-picker produziu linha única com `## intentional_error: ...`
    const r = validateFrontmatterYaml(COLLAPSED_MD);
    assert.equal(r.ok, false, `esperado ok=false para frontmatter colapsado, message: ${r.message}`);
    assert.equal(r.collapsed, true, "deve sinalizar que o bloco foi colapsado");
    assert.match(r.message, /colapsado|corrompido/i);
  });

  it("FAIL com frontmatter colapsado sem prefixo ## (variante)", () => {
    const r = validateFrontmatterYaml(COLLAPSED_NO_PREFIX_MD);
    assert.equal(r.ok, false, `esperado ok=false para colapsado sem ##, message: ${r.message}`);
    assert.equal(r.collapsed, true);
  });

  it("FAIL quando chave `reveal` faltando (4 de 5 campos presentes)", () => {
    const r = validateFrontmatterYaml(MISSING_REVEAL_MD);
    assert.equal(r.ok, false, `esperado ok=false para reveal faltando, message: ${r.message}`);
    assert.equal(r.collapsed, false, "não deve ser marcado como colapsado — é campo faltando");
    assert.ok(r.missing_fields.includes("reveal"), `missing_fields deve incluir 'reveal', got: ${JSON.stringify(r.missing_fields)}`);
  });

  it("REQUIRED_IE_FIELDS tem as 5 chaves esperadas", () => {
    assert.deepEqual(
      [...REQUIRED_IE_FIELDS].sort(),
      ["category", "correct_value", "description", "location", "reveal"].sort(),
    );
  });
});

describe("validateFrontmatterYaml — chaves parcialmente ausentes", () => {
  it("FAIL quando todas as chaves ausentes (só chave raiz present, bloco vazio)", () => {
    // Frontmatter com `intentional_error:` mas sem sub-chaves indentadas
    const md = `---
intentional_error:
---
corpo
`;
    const r = validateFrontmatterYaml(md);
    assert.equal(r.ok, false, `esperado ok=false, message: ${r.message}`);
    // Quando o bloco está vazio (sem sub-chaves), missing_fields lista todas as 5
    assert.equal(r.missing_fields.length, REQUIRED_IE_FIELDS.length, `todas as 5 chaves devem estar faltando, got: ${JSON.stringify(r.missing_fields)}`);
  });

  it("FAIL quando 3 chaves presentes e 2 ausentes", () => {
    const md = `---
intentional_error:
  description: "teste"
  location: "DESTAQUE 1"
  category: "factual"
---
corpo
`;
    const r = validateFrontmatterYaml(md);
    assert.equal(r.ok, false, `esperado ok=false, message: ${r.message}`);
    const missing = r.missing_fields;
    assert.ok(missing.includes("correct_value"), "correct_value deve estar faltando");
    assert.ok(missing.includes("reveal"), "reveal deve estar faltando");
    assert.equal(missing.length, 2);
  });
});
