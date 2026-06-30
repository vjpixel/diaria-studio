/**
 * test/writer-prompt.test.ts (#1208, #2377)
 *
 * Grep tests pra garantir que instruções críticas estão presentes em
 * `.claude/agents/writer.md` e `.claude/agents/writer-destaque.md`.
 * Não testa comportamento (LLM); testa presença de strings que o
 * prompt-tuning depende.
 *
 * Equivalente a snapshot test do orchestrator-prompt.test.ts mas com
 * focus em invariantes editoriais que merecem teste de regressão.
 *
 * #2377 (root cause fix): checks atualizados para validar que ambos os agents
 * documentam CORRETAMENTE o fluxo do ERRO INTENCIONAL:
 *   - writer emite apenas placeholder genérico (nunca o reveal)
 *   - EDITOR preenche a declaração de primeira pessoa no frontmatter/prosa
 *   - lint do Stage 4 valida que a declaração do editor é específica
 * O fix anterior (PR inicial de #2377) documentava o reveal como se fosse
 * responsabilidade do writer — estava INCORRETO. O writer nunca escreve
 * "Na última edição, escrevi que…" porque esse texto é de uma edição futura,
 * composto pelo script a partir do que o EDITOR escreveu nesta edição.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRITER_MD = resolve(ROOT, ".claude/agents/writer.md");
const WRITER_DESTAQUE_MD = resolve(ROOT, ".claude/agents/writer-destaque.md");

describe("writer.md invariants (#1208)", () => {
  const content = readFileSync(WRITER_MD, "utf8");

  it("contém instrução explícita de char count por destaque", () => {
    assert.match(content, /D1.*1000.*1200/);
    assert.match(content, /D2\/D3.*900.*1000/);
  });

  it("contém anti-pattern reference pra D2/D3 anêmicos (#1208)", () => {
    // D2/D3 saiam sistematicamente abaixo de 900 chars em 260517
    assert.match(content, /D2 e D3.*erro comum|sistematicamente.*900/i,
      "writer prompt deve documentar o anti-pattern observado em 260517");
  });

  it("contém estrutura sugerida pra atingir min-chars", () => {
    // Prompt sugere "3 parágrafos + why expandido" pra atingir o min
    assert.match(content, /3 parágrafos|estrutur[ea] deliberadamente/i,
      "writer prompt deve sugerir estrutura pra atingir min-chars");
  });

  it("'Por que isso importa' tem instrução de mínimo 2 frases (#1208)", () => {
    assert.match(content, /M[íi]nimo 2 frases|2 frases/i,
      "writer prompt deve exigir mínimo 2 frases em 'Por que isso importa'");
  });
});

// #2377 (root cause fix) — ERRO INTENCIONAL: writer emite placeholder, EDITOR escreve a declaração
describe("ERRO INTENCIONAL — writer emite placeholder, EDITOR escreve declaração (#2377)", () => {
  const writerContent = readFileSync(WRITER_MD, "utf8");
  const writerDestaqueContent = readFileSync(WRITER_DESTAQUE_MD, "utf8");

  // writer.md deve deixar claro que o writer emite APENAS placeholder
  it("writer.md documenta que writer emite só placeholder (não o reveal)", () => {
    assert.match(
      writerContent,
      /placeholder|só precisa garantir que a seção existe/i,
      "writer.md deve documentar que writer emite apenas placeholder no bloco ERRO INTENCIONAL",
    );
  });

  // writer.md deve deixar claro que o EDITOR (não writer) escreve a declaração de primeira pessoa
  it("writer.md documenta responsabilidade do EDITOR para a declaração de primeira pessoa", () => {
    assert.match(
      writerContent,
      /EDITOR|editor preenche|declaração de primeira pessoa/i,
      "writer.md deve atribuir ao EDITOR a responsabilidade de preencher a declaração de primeira pessoa",
    );
  });

  // writer.md deve mencionar o lint que valida isso
  it("writer.md menciona lint Stage 4 que valida a declaração do editor", () => {
    assert.match(
      writerContent,
      /lint.*Stage 4|narrative-not-generic-placeholder/i,
      "writer.md deve mencionar o lint do Stage 4 que valida a declaração real do editor",
    );
  });

  // writer-destaque.md: writer emite placeholder, EDITOR escreve a declaração
  it("writer-destaque.md documenta que writer emite só placeholder (não o reveal)", () => {
    assert.match(
      writerDestaqueContent,
      /placeholder|só.*placeholder|emite apenas o placeholder/i,
      "writer-destaque.md deve documentar que writer emite apenas placeholder",
    );
  });

  it("writer-destaque.md documenta responsabilidade do EDITOR para a declaração", () => {
    assert.match(
      writerDestaqueContent,
      /EDITOR|editor preenche|declaração de primeira pessoa/i,
      "writer-destaque.md deve atribuir ao EDITOR a responsabilidade de preencher a declaração",
    );
  });

  // writer.md não deve instruir o writer a escrever o reveal como se fosse tarefa dele
  it("writer.md não contém instrução incorreta de writer escrever o reveal diretamente", () => {
    // O texto "Você (writer) escreve o reveal" nunca deve aparecer
    // Presença de "escrevi que" é OK se for no contexto do EDITOR, não como instrução direta ao writer
    // Verificar que não tem instrução no imperativo para o writer escrever o reveal
    assert.doesNotMatch(
      writerContent,
      /Você deve escrever.*Na última edição|você.*escreve.*reveal/i,
      "writer.md não deve instruir o writer a escrever o reveal da edição anterior",
    );
  });
});

// #2657 — safe-area do crop 1:1 documentada no agent
describe("writer-destaque.md safe-area invariant (#2657)", () => {
  const writerDestaqueContent = readFileSync(WRITER_DESTAQUE_MD, "utf8");

  it("menciona instrução de safe-area / terço central para crop 1:1", () => {
    assert.match(
      writerDestaqueContent,
      /safe.?area|terço central|agrup.*no terço|central.*crop/i,
      "writer-destaque.md deve mencionar safe-area para múltiplos sujeitos no crop 1:1",
    );
  });
});
