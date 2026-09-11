/**
 * test/agent-prompt-invariants.test.ts (#7978, Camada 5 da #7972)
 *
 * Guard de regressão pra valores editoriais PROTEGIDOS que vivem em texto
 * livre de agent prompt (`.claude/agents/*.md`) — nada em TS os força
 * hoje, então uma edição de prosa (reescrever um parágrafo, corrigir
 * typo) pode silenciosamente apagar/alterar um valor que #7978 lista
 * explicitamente como invariante protegido: "52 caracteres", "3 opções",
 * regras de imagem (Van Gogh impasto, sem pixels, sem Noite Estrelada).
 *
 * Este teste NÃO impede a mudança (não é um lock de conteúdo idêntico) —
 * checa só PRESENÇA LITERAL das frases-âncora, então captura o caso mais
 * comum de regressão (apagar/reescrever a regra por engano) sem travar
 * reescritas legítimas que preservam o valor com outras palavras ao redor.
 * Roda em `npm test` normal — não é o portão de sign-off (#7978 ponto 4,
 * `check-editorial-signoff.ts`), que cobre os blocos CALIBRATED de
 * scorer.md/scorer-chunk.md; este teste cobre writer/writer-destaque,
 * que ficam FORA da allowlist de calibração (título/imagem são regra
 * editorial fixa, não peso de scoring calibrável).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function readAgent(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("Invariantes protegidos em agent prompts (#7978)", () => {
  it("writer-destaque.md: limite de 52 caracteres pro título está presente", () => {
    const content = readAgent(".claude/agents/writer-destaque.md");
    assert.match(content, /52\s*chars/i, "writer-destaque.md deveria mencionar o limite de 52 chars pro título");
  });

  it("writer.md: limite de 52 caracteres pro título está presente", () => {
    const content = readAgent(".claude/agents/writer.md");
    assert.match(content, /52\s*chars/i, "writer.md deveria mencionar o limite de 52 chars pro título");
  });

  it("writer-destaque.md e writer.md: '3 opções' de título por destaque está presente", () => {
    for (const path of [".claude/agents/writer-destaque.md", ".claude/agents/writer.md"]) {
      const content = readAgent(path);
      assert.match(content, /3\s*opções/i, `${path} deveria mencionar "3 opções" de título`);
    }
  });

  it("writer-destaque.md: prompt de imagem exige Van Gogh impasto", () => {
    const content = readAgent(".claude/agents/writer-destaque.md");
    assert.match(content, /Van Gogh impasto/i);
  });

  it("writer-destaque.md: proibição de resolução em pixels no prompt de imagem está presente", () => {
    const content = readAgent(".claude/agents/writer-destaque.md");
    assert.match(content, /sem\s*(resolução em\s*)?pixels|pixels?.*proibid/i);
  });

  it("writer-destaque.md: proibição de 'Noite Estrelada' (mesmo negada) está presente", () => {
    const content = readAgent(".claude/agents/writer-destaque.md");
    assert.match(content, /Noite Estrelada/i);
  });

  it("writer.md: prompt de imagem sem pixels e sem Noite Estrelada está presente", () => {
    const content = readAgent(".claude/agents/writer.md");
    assert.match(content, /pixels/i);
    assert.match(content, /Noite Estrelada/i);
  });
});
