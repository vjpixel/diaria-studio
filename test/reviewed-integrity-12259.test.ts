/**
 * #12259: 02-reviewed.md voltou a ter o placeholder do swap depois de o texto
 * do D3 ter sido integrado (edição 261105). Causa: resolução de conflito do
 * OneDrive — a versão integrada foi para `02-reviewed-300-safeBackup-0001.md`
 * e o principal recebeu a da nuvem (a do swap). Guards do Stage 4:
 *   - `reviewed-no-pending-placeholder` (error) barra o placeholder no gate;
 *   - `reviewed-onedrive-conflict-copy` (warning) avisa da cópia de conflito.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findPendingPlaceholders,
  checkReviewedNoPendingPlaceholder,
  checkReviewedOnedriveConflictCopy,
  isOnedriveConflictCopyOf,
} from "../scripts/lib/diaria/reviewed-integrity.ts";
import { renderDestaquePlaceholder } from "../scripts/swap-destaque.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";

const INTEGRATED = `**DESTAQUE 3 | 📦 PRODUTO**\n\n**[Google prepara limite para o Gemini](https://androidauthority.com/x)**\n\nO Google prepara um meio-termo.\n`;

describe("findPendingPlaceholders (#12259)", () => {
  it("acha os dois placeholders que o swap-destaque grava, com a linha", () => {
    const md = `# Edição\n\n${renderDestaquePlaceholder(3, "Google prepara limite", "https://androidauthority.com/x")}\n`;
    const found = findPendingPlaceholders(md);
    assert.deepEqual(
      found.map((f) => f.text),
      ["[RASCUNHO PENDENTE — swap-destaque]", "[TEXTO PENDENTE — re-rodar writer-destaque para DESTAQUE 3]"],
    );
    assert.equal(found[0].line, 3);
  });

  it("placeholder curto do swap-destaques/promote também conta", () => {
    assert.equal(findPendingPlaceholders("**DESTAQUE 2 | [RASCUNHO PENDENTE]**").length, 1);
  });

  it("texto integrado e o sentinel do USE MELHOR (outra regra) não contam", () => {
    assert.deepEqual(findPendingPlaceholders(INTEGRATED), []);
    assert.deepEqual(findPendingPlaceholders("[DESCRIÇÃO PENDENTE] (5 min)"), []);
  });
});

describe("guards do Stage 4 (#12259)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reviewed-12259-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rule = (id: string) => {
    const r = getRulesForStage(4).find((x) => x.id === id);
    assert.ok(r, `${id} deve estar registrado no Stage 4`);
    return r;
  };

  it("reviewed-no-pending-placeholder: placeholder sem marcador do swap (caso 261105) → error", () => {
    // Sem _internal/swap-destaque-titulo-pending.json: o invariante #9601 não olharia.
    writeFileSync(join(dir, "02-reviewed.md"), renderDestaquePlaceholder(3, "Google prepara limite", "https://androidauthority.com/x"));
    const v = rule("reviewed-no-pending-placeholder").run(dir);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /2 placeholder/);
    assert.match(v[0].message, /safeBackup/);
    assert.deepEqual(checkReviewedNoPendingPlaceholder(dir), v);
  });

  it("reviewed-no-pending-placeholder: texto integrado ou arquivo ausente → passa", () => {
    assert.deepEqual(checkReviewedNoPendingPlaceholder(dir), []);
    writeFileSync(join(dir, "02-reviewed.md"), INTEGRATED);
    assert.deepEqual(checkReviewedNoPendingPlaceholder(dir), []);
  });

  it("reviewed-onedrive-conflict-copy: cópia safeBackup de 02-reviewed/03-social → warning por arquivo", () => {
    writeFileSync(join(dir, "02-reviewed.md"), renderDestaquePlaceholder(3, "t", "https://x"));
    writeFileSync(join(dir, "02-reviewed-300-safeBackup-0001.md"), INTEGRATED);
    writeFileSync(join(dir, "03-social.md"), "x");
    writeFileSync(join(dir, "03-social-predator-safeBackup-0002.md"), "y");
    const v = rule("reviewed-onedrive-conflict-copy").run(dir);
    assert.equal(v.length, 2);
    assert.ok(v.every((x) => x.severity === "warning"));
    assert.match(v[0].message, /02-reviewed-300-safeBackup-0001\.md/);
    assert.match(v[0].message, /diff /);
    assert.match(v[1].message, /03-social-predator-safeBackup-0002\.md/);
    assert.deepEqual(checkReviewedOnedriveConflictCopy(dir), v);
  });

  it("reviewed-onedrive-conflict-copy: sem cópia → nada", () => {
    writeFileSync(join(dir, "02-reviewed.md"), INTEGRATED);
    assert.deepEqual(checkReviewedOnedriveConflictCopy(dir), []);
    assert.deepEqual(checkReviewedOnedriveConflictCopy(join(dir, "nao-existe")), []);
  });

  it("isOnedriveConflictCopyOf: nomes reais e falsos positivos", () => {
    assert.equal(isOnedriveConflictCopyOf("02-reviewed-300-safeBackup-0001.md", "02-reviewed"), true);
    assert.equal(isOnedriveConflictCopyOf("02-reviewed-predator-safeBackup-0001.md", "02-reviewed"), true);
    assert.equal(isOnedriveConflictCopyOf("02-reviewed.md", "02-reviewed"), false);
    assert.equal(isOnedriveConflictCopyOf("02-reviewed-clarice-corrected.md", "02-reviewed"), false);
    assert.equal(isOnedriveConflictCopyOf("03-social-300-safeBackup-0001.md", "02-reviewed"), false);
  });
});
