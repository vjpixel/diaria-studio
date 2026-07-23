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
  findDuplicateSlotAssignment,
  SLOTS_SAVE_CONFLICT_CONFIRM_MESSAGE,
  SLOT_POSITION_LABEL,
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

describe("findDuplicateSlotAssignment (#3937)", () => {
  it("null quando todos os slots são distintos", () => {
    assert.equal(
      findDuplicateSlotAssignment({ slot1: "a.md", slot2: "b.md", slot3: "c.md" }),
      null,
    );
  });

  it("null quando slots estão vazios (não conta como duplicata)", () => {
    assert.equal(findDuplicateSlotAssignment({ slot1: "", slot2: "", slot3: "" }), null);
    assert.equal(findDuplicateSlotAssignment({ slot1: "a.md", slot2: "", slot3: "" }), null);
  });

  it("detecta a mesma caixa em 2 slots", () => {
    assert.equal(
      findDuplicateSlotAssignment({ slot1: "a.md", slot2: "a.md", slot3: "" }),
      "a.md",
    );
  });

  it("detecta a mesma caixa em 3 slots", () => {
    assert.equal(
      findDuplicateSlotAssignment({ slot1: "a.md", slot2: "a.md", slot3: "a.md" }),
      "a.md",
    );
  });

  it("ignora espaço nas pontas antes de comparar", () => {
    assert.equal(
      findDuplicateSlotAssignment({ slot1: "  a.md  ", slot2: "a.md", slot3: "" }),
      "a.md",
    );
  });

  it("tolera undefined/null nos valores dos slots", () => {
    assert.equal(findDuplicateSlotAssignment({ slot1: undefined, slot2: null, slot3: "" }), null);
  });
});

describe("SLOTS_SAVE_CONFLICT_CONFIRM_MESSAGE (#3937)", () => {
  it("nomeia platform.config.json e descreve as duas saídas (sobrescrever/recarregar)", () => {
    assert.match(SLOTS_SAVE_CONFLICT_CONFIRM_MESSAGE, /platform\.config\.json/);
    assert.match(SLOTS_SAVE_CONFLICT_CONFIRM_MESSAGE, /sobrescrever/i);
    assert.match(SLOTS_SAVE_CONFLICT_CONFIRM_MESSAGE, /recarregar/i);
  });
});

describe("SLOT_POSITION_LABEL (#3937)", () => {
  it("tem uma entrada por slot com a posição descrita na issue", () => {
    assert.match(SLOT_POSITION_LABEL.slot1, /D1/);
    assert.match(SLOT_POSITION_LABEL.slot1, /D2/);
    assert.match(SLOT_POSITION_LABEL.slot2, /D2/);
    assert.match(SLOT_POSITION_LABEL.slot2, /D3/);
    assert.match(SLOT_POSITION_LABEL.slot3, /último destaque/i);
  });
});
