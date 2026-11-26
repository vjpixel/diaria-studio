/**
 * test/stage4-cascade-card-after-native-14081.test.ts (#14081)
 *
 * Cascata do gate 4 (§4d.1a passo d e receita E do cartão): o card 4:5
 * (`gen-social-card-4x5.ts --destaque dN`) depende do nativo 4:5
 * (`image-generate.ts ... --ratio 4x5 --force`), porque `generateCard()` lê
 * `04-dN-4x5-nativo.jpg` primeiro. Disparados como dois comandos de background
 * independentes, o card podia sair com a arte velha ou com o fallback 2:1
 * (a #14078 apaga o nativo antes de regenerar) e a peça era marcada `done`.
 *
 * O teste prende a ordem: em toda linha de comando que regenera o nativo 4:5
 * na cascata, o card vem encadeado DEPOIS dele com `&&` (só compõe com exit 0
 * do nativo), e não sobra nenhuma linha de card solta no mesmo bloco.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGE4_PLAYBOOK_FILES, STAGE4_GATE_RECIPES_FILE } from "../scripts/lib/stage4-playbook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const NATIVE = "--ratio 4x5 --force";
const CARD = "gen-social-card-4x5.ts --edition-dir {EDITION_DIR}/ --destaque d{N}";

/** Linhas da cascata que regeneram o nativo 4:5 de um destaque. */
function nativeLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^\s*npx tsx scripts\/image-generate\.ts /.test(l) && l.includes(NATIVE) && l.includes("d{N}"));
}

function assertChained(file: string) {
  const text = read(file);
  const lines = nativeLines(text);
  assert.ok(lines.length >= 1, `${file}: linha do nativo 4:5 da cascata não encontrada`);
  for (const line of lines) {
    const iNative = line.indexOf(NATIVE);
    const iAnd = line.indexOf("&&", iNative);
    const iCard = line.indexOf(CARD, iNative);
    assert.ok(iAnd > iNative && iCard > iAnd, `${file}: o card 4:5 precisa vir encadeado com && depois do nativo: ${line}`);
  }
  // Nenhuma linha de comando com o card solto (sem o nativo antes) na cascata.
  const loose = text
    .split("\n")
    .filter((l) => /^\s*npx tsx scripts\/gen-social-card-4x5\.ts --edition-dir \{EDITION_DIR\}\/ --destaque d\{N\}/.test(l));
  assert.deepEqual(loose, [], `${file}: card 4:5 disparado sozinho, em paralelo ao nativo`);
}

describe("#14081: cascata do gate 4 compõe o card 4:5 só depois do nativo", () => {
  it("§4d.1a passo d (arquivo do gate)", () => {
    // Só linhas de comando (início `npx tsx`); prosa que cita o nativo não conta.
    const gate = STAGE4_PLAYBOOK_FILES.find((p) => p.endsWith("orchestrator-stage-4-gate.md"));
    assert.ok(gate, "arquivo do gate ausente de STAGE4_PLAYBOOK_FILES");
    assertChained(gate);
  });

  it("receita E do cartão de receitas do gate", () => {
    assertChained(STAGE4_GATE_RECIPES_FILE);
  });

  it("o 2x1 e o carrossel seguem como comandos próprios (não dependem do nativo)", () => {
    const gate = read(".claude/agents/orchestrator-stage-4-gate.md");
    assert.match(gate, /^\s*npx tsx scripts\/image-generate\.ts .*--destaque d\{N\} --keep-4x5-nativo/m);
    assert.match(gate, /^\s*npx tsx scripts\/gen-carousel-cards\.ts --edition-dir \{EDITION_DIR\}\//m);
  });
});
