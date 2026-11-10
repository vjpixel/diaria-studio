/**
 * test/lancamento-maker-12595.test.ts (#12595)
 *
 * Edição 261109: o item de LANÇAMENTOS "Voice Chat with Agents"
 * (cursor.com/changelog/voice-chat) saiu com a descrição "Converse com seus
 * agentes por chamada de voz em tempo real no desktop, na web e no iOS.", sem
 * dizer que o produto é do Cursor. O invariante warning-only
 * `lancamento-sem-fabricante` do Stage 4 acusa o item.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findLancamentosSemFabricante,
  makerNamesForUrl,
  mentionsMaker,
} from "../scripts/lib/lancamento-maker.ts";
import { checkLancamentoSemFabricante, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

function editionMd(lancamentos: string): string {
  return [
    "Nesta edição, a IA analisou 40 conteúdos (2 enviados por mim e 38 encontrados automaticamente) e selecionei os 2 mais relevantes.",
    "",
    "---",
    "",
    "**🚀 LANÇAMENTOS**",
    "",
    lancamentos,
    "",
    "---",
    "",
    "**É IA?**",
    "",
    "Crédito.",
  ].join("\n");
}

const CURSOR_261109 =
  "**[Voice Chat with Agents](https://cursor.com/changelog/voice-chat)**  \n" +
  "Converse com seus agentes por chamada de voz em tempo real no desktop, na web e no iOS.";

describe("lancamento-sem-fabricante (#12595)", () => {
  it("acusa o caso real da 261109 (Cursor ausente do título e da descrição)", () => {
    const hits = findLancamentosSemFabricante(editionMd(CURSOR_261109));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, "https://cursor.com/changelog/voice-chat");
    assert.ok(hits[0].expected.includes("Cursor"));
  });

  it("passa quando a descrição cita o fabricante (texto que saiu na 261110)", () => {
    const md = editionMd(
      "**[Voice Chat with Agents](https://cursor.com/changelog/voice-chat)**  \n" +
        "O Cursor passou a permitir conversar com seus agentes por chamada de voz em tempo real, no desktop, na web e no iOS.",
    );
    assert.deepEqual(findLancamentosSemFabricante(md), []);
  });

  it("aceita o fabricante no título e produto que identifica a empresa", () => {
    const md = editionMd(
      [
        "**[OpenAI launches Decisions API](https://openai.com/index/decisions-api)**  ",
        "Decisões rápidas para qualquer aplicativo.",
        "",
        "**[Get hands-free help on the road](https://blog.google/products-and-platforms/platforms/android/x/)**  ",
        "O Gemini chega aos carros no mundo todo.",
        "",
        "**[EmbeddingGemma 2](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/)**  ",
        "Modelo aberto de embeddings multimodais.",
        "",
        "**[Release v2](https://github.com/deepseek-ai/dsh-superagent-prototype)**  ",
        "Protótipo da DeepSeek de um sistema de agentes.",
      ].join("\n"),
    );
    assert.deepEqual(findLancamentosSemFabricante(md), []);
  });

  it("só olha a seção LANÇAMENTOS (RADAR sem fabricante não é acusado)", () => {
    const md = editionMd(CURSOR_261109).replace("🚀 LANÇAMENTOS", "📡 RADAR");
    assert.deepEqual(findLancamentosSemFabricante(md), []);
  });

  it("deriva nomes da URL: registro oficial, host, dono do repo; blog de plataforma é ignorado", () => {
    assert.deepEqual(makerNamesForUrl("https://cursor.com/changelog/voice-chat"), ["Cursor", "Anysphere"]);
    assert.ok(makerNamesForUrl("https://code.claude.com/docs/en/changelog").includes("Claude"));
    assert.ok(makerNamesForUrl("https://huggingface.co/moonshotai/Kimi-K2").includes("moonshot"));
    assert.ok(!makerNamesForUrl("https://huggingface.co/moonshotai/Kimi-K2").includes("Hugging Face"));
    assert.deepEqual(makerNamesForUrl("https://huggingface.co/blog/meta-muse-spark-open"), []);
    assert.ok(makerNamesForUrl("https://about.fb.com/news/2026/10/introducing-muse").includes("Meta"));
  });

  it("casamento por palavra, sem acento/caixa, com e sem espaço", () => {
    assert.ok(mentionsMaker("Novo modelo da HuggingFace", ["Hugging Face"]));
    assert.ok(mentionsMaker("A openai lança", ["OpenAI"]));
    assert.ok(!mentionsMaker("O precursor do agente", ["Cursor"]));
  });

  it("invariante registrado no Stage 4 como warning, lendo 02-reviewed.md", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "lancamento-sem-fabricante");
    assert.ok(rule, "regra registrada");
    const dir = mkdtempSync(join(tmpdir(), "lanc-fab-12595-"));
    try {
      assert.deepEqual(checkLancamentoSemFabricante(dir), []);
      writeFileSync(join(dir, "02-reviewed.md"), editionMd(CURSOR_261109));
      const v = checkLancamentoSemFabricante(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "lancamento-sem-fabricante");
      assert.match(v[0].message, /Voice Chat with Agents/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
