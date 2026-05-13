/**
 * test/writer-prompt.test.ts (#1208)
 *
 * Grep tests pra garantir que instruções críticas estão presentes em
 * `.claude/agents/writer.md`. Não testa comportamento (LLM); testa
 * presença de strings que o prompt-tuning depende.
 *
 * Equivalente a snapshot test do orchestrator-prompt.test.ts mas com
 * focus em invariantes editoriais que merecem teste de regressão.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRITER_MD = resolve(ROOT, ".claude/agents/writer.md");

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
