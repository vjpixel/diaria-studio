/**
 * #12107 — aviso `box-divulgacao-expiry` dizia "sem candidato, sai vazio" pro
 * slot pinado com caixa vencida, sem olhar o que o stitch fez. Na edição
 * 261104 o slot 1 tinha recebido `youtube-comentario-destaque.md` pela seleção
 * automática, e o aviso levou à leitura de que o espaço estava perdido desde
 * 27/10. Agora o efeito sai de `_internal/box-selection.json`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBoxDivulgacaoExpiry, readExpiredSlotOutcome } from "../scripts/lib/invariant-checks/stage-4.ts";

const VOTO = `<!--
nome: Votação do tema do Artigo Especial
expires: 2026-10-27
-->

**📣 Vote no tema do próximo Artigo Especial**

[Quero votar](https://apoia.se/diaria)`;

const LIVROS = `<!--
nome: Livros
-->

**📚 Livros sobre IA**

[Ver livros](https://diar.ia.br/livros)`;

function setup(selection: unknown | undefined): { root: string; editionDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "box-expiry-12107-"));
  mkdirSync(join(root, "data", "snippets"), { recursive: true });
  writeFileSync(join(root, "data", "snippets", "voto-tema-divulgacao.md"), VOTO);
  writeFileSync(join(root, "data", "snippets", "livros-divulgacao.md"), LIVROS);
  writeFileSync(
    join(root, "platform.config.json"),
    JSON.stringify({
      boxes_divulgacao: { slot0: "", slot1: "voto-tema-divulgacao.md", slot2: "livros-divulgacao.md", slot3: null },
      boxes_divulgacao_auto: { enabled: true, pinned_slots: [1] },
    }),
  );
  const editionDir = join(root, "editions", "261104");
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  if (selection !== undefined) {
    writeFileSync(
      join(editionDir, "_internal", "box-selection.json"),
      typeof selection === "string" ? selection : JSON.stringify(selection),
    );
  }
  return { root, editionDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const SLOT2_AUTO = { slot: 2, mode: "auto", file: "livros-divulgacao.md" };

describe("box-divulgacao-expiry descreve o que o stitch fez com o slot (#12107)", () => {
  it("cenário real 261104: pin vencido coberto pela seleção automática → nomeia a caixa que entrou, sem dizer 'sai vazio'", () => {
    const { root, editionDir, cleanup } = setup([
      {
        slot: 1,
        mode: "auto",
        file: "youtube-comentario-destaque.md",
        rejectedFile: "voto-tema-divulgacao.md",
        rejectReason: "expirado",
      },
      SLOT2_AUTO,
    ]);
    try {
      const v = checkBoxDivulgacaoExpiry(editionDir, root);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /voto-tema-divulgacao\.md/);
      assert.match(v[0].message, /slot 1 recebeu `youtube-comentario-destaque\.md` pela seleção automática/);
      assert.doesNotMatch(v[0].message, /vazio/);
    } finally {
      cleanup();
    }
  });

  it("slot sem arquivo na seleção (fallback vencido recusado) → diz que saiu vazio", () => {
    const { root, editionDir, cleanup } = setup([
      { slot: 1, mode: "fallback-ineligible", file: null, rejectedFile: "voto-tema-divulgacao.md", rejectReason: "expirado" },
      SLOT2_AUTO,
    ]);
    try {
      const v = checkBoxDivulgacaoExpiry(editionDir, root);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /slot 1 saiu vazio/);
    } finally {
      cleanup();
    }
  });

  it("sem box-selection.json → frase genérica de antes (não afirma o que não sabe)", () => {
    const { root, editionDir, cleanup } = setup(undefined);
    try {
      const v = checkBoxDivulgacaoExpiry(editionDir, root);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /vai pra seleção automática/);
    } finally {
      cleanup();
    }
  });

  it("readExpiredSlotOutcome: JSON corrompido, slot ausente ou registro apontando a própria caixa vencida → null", () => {
    const corrupt = setup("{nao é json");
    try {
      assert.equal(readExpiredSlotOutcome(corrupt.editionDir, 1, "voto-tema-divulgacao.md"), null);
    } finally {
      corrupt.cleanup();
    }
    const missing = setup([SLOT2_AUTO]);
    try {
      assert.equal(readExpiredSlotOutcome(missing.editionDir, 1, "voto-tema-divulgacao.md"), null);
    } finally {
      missing.cleanup();
    }
    const stale = setup([{ slot: 1, mode: "pinned", file: "voto-tema-divulgacao.md" }]);
    try {
      assert.equal(readExpiredSlotOutcome(stale.editionDir, 1, "voto-tema-divulgacao.md"), null);
    } finally {
      stale.cleanup();
    }
  });
});
