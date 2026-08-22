/**
 * test/claude-md-size.test.ts (#5904)
 *
 * Guard de tamanho do CLAUDE.md — o arquivo é carregado incondicionalmente em
 * toda sessão E todo dispatch de subagente (§Otimização de tokens, #4814), o
 * que faz dele o multiplicador de custo nº 1 do projeto. O histórico mostra
 * que ele recresce a cada issue fechada (cada decisão vira parágrafo novo,
 * narrativa velha raramente sai); o trim manual do PR #5893 ganhou ~3,7% e
 * sem enforcement esse ganho evapora.
 *
 * Mesmo racional do lib-boundary.test.ts (#2747): o erro barato em CI força a
 * pergunta certa no momento certo — "esse parágrafo novo precisa estar no
 * arquivo incondicional, ou cabe em context//docs/issue com um ponteiro?".
 *
 * Teto inicial 75KB (bytes) — premissa declarada na issue, não decisão
 * fechada: congela o tamanho pós-#5893 (73.230 B) com folga mínima (~1.8KB).
 * Apertar depois é mudar 1 constante AQUI; subir o teto exige decisão do
 * editor registrada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_MD = join(ROOT, "CLAUDE.md");

/** Teto em bytes. 75 * 1024 = 76_800. Ver docblock antes de alterar. */
export const CLAUDE_MD_MAX_BYTES = 75 * 1024;

describe("claude-md-size (#5904)", () => {
  it("CLAUDE.md existe", () => {
    assert.equal(statSync(CLAUDE_MD).isFile(), true);
  });

  it(`CLAUDE.md ≤ ${CLAUDE_MD_MAX_BYTES} bytes (teto #5904)`, () => {
    const size = readFileSync(CLAUDE_MD).length;
    if (size > CLAUDE_MD_MAX_BYTES) {
      assert.fail(
        `CLAUDE.md tem ${size} bytes — excede o teto de ${CLAUDE_MD_MAX_BYTES}` +
          ` (${(size - CLAUDE_MD_MAX_BYTES).toLocaleString("pt-BR")} bytes acima).\n\n` +
          `Caminho correto: mova histórico/narrativa pra docs/ ou pra uma issue` +
          ` e deixe um ponteiro no lugar — NÃO delete conteúdo operativo.\n` +
          `NÃO suba este teto sem decisão do editor registrada na issue #5904.`,
      );
    }
    assert.ok(size <= CLAUDE_MD_MAX_BYTES);
  });
});
