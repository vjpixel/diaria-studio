/**
 * test/caixas-guards.test.ts (#3928) — cobertura da lógica PURA dos guards da
 * seção "Caixas" (`scripts/studio-ui/public/caixas-guards.js`). Mesmo padrão de
 * `test/revisao-guards.test.ts`: o módulo não toca `document`/`fetch`, então é
 * testável com fixtures puras, sem DOM real.
 *
 * Foco: `validateNewBoxSlug` (feedback client do formulário "Nova caixa") — o
 * server revalida via `isValidBoxSlug` (autoridade final), mas esta cópia
 * precisa espelhar a mesma regra pra não frustrar o editor com um "válido aqui,
 * rejeitado lá" (ou vice-versa).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateNewBoxSlug,
  boxArchiveConfirmMessage,
  BOX_SLUG_RE,
} from "../scripts/studio-ui/public/caixas-guards.js";

describe("validateNewBoxSlug (#3928)", () => {
  it("aceita slug bem-formado e o retorna", () => {
    const r = validateNewBoxSlug("minha-caixa.md");
    assert.equal(r.ok, true);
    assert.equal(r.slug, "minha-caixa.md");
    assert.equal(r.error, null);
  });

  it("anexa .md quando o editor digita só o nome", () => {
    const r = validateNewBoxSlug("minha-caixa");
    assert.equal(r.ok, true);
    assert.equal(r.slug, "minha-caixa.md");
  });

  it("faz trim de espaços nas pontas antes de validar", () => {
    const r = validateNewBoxSlug("  outra-caixa  ");
    assert.equal(r.ok, true);
    assert.equal(r.slug, "outra-caixa.md");
  });

  it("rejeita vazio", () => {
    assert.equal(validateNewBoxSlug("").ok, false);
    assert.equal(validateNewBoxSlug("   ").ok, false);
  });

  it("rejeita README.md explicitamente", () => {
    const r = validateNewBoxSlug("README.md");
    assert.equal(r.ok, false);
    assert.match(r.error, /reservado/i);
  });

  it("rejeita maiúsculas, espaços, acentos", () => {
    assert.equal(validateNewBoxSlug("Foo.md").ok, false);
    assert.equal(validateNewBoxSlug("com espaco").ok, false);
    assert.equal(validateNewBoxSlug("acentuação").ok, false);
  });

  it("rejeita traversal (barra, ..)", () => {
    assert.equal(validateNewBoxSlug("../fora").ok, false);
    assert.equal(validateNewBoxSlug("sub/dir.md").ok, false);
  });

  it("a regex client espelha a do server (^[a-z0-9-]+\\.md$)", () => {
    assert.equal(BOX_SLUG_RE.source, "^[a-z0-9-]+\\.md$");
  });
});

describe("boxArchiveConfirmMessage (#3928)", () => {
  it("nomeia a caixa e deixa explícito que NÃO deleta", () => {
    const msg = boxArchiveConfirmMessage("apoio-divulgacao.md");
    assert.match(msg, /apoio-divulgacao\.md/);
    assert.match(msg, /não é deletado/i);
    assert.match(msg, /restaurada/i);
  });
});
