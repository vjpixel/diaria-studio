/**
 * test/lint-no-untranslated-summary.test.ts (#3196)
 *
 * Regressão (#633) do lint `checkNoUntranslatedSummary` +
 * `lint-newsletter-md.ts --check no-untranslated-summary` (GATE-BLOCKING,
 * mirrors secondary-items-have-summary #2545).
 *
 * Casos reais reportados na edição 260709 (issue #3196).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkNoUntranslatedSummary } from "../scripts/lib/lint-checks/no-untranslated-summary.ts";

function useMelhorInline(title: string, description: string): string {
  return `**🛠️ USE MELHOR**\n\n**[${title}](https://example.com/tool)** ${description}\n`;
}

function radarInline(title: string, description: string): string {
  return `**📡 RADAR**\n\n**[${title}](https://example.com/radar)** ${description}\n`;
}

describe("checkNoUntranslatedSummary (#3196)", () => {
  // CASO REAL 1 — USE MELHOR, marcador literal [TRADUZIR]
  it("CASO REAL 260709: flagra [TRADUZIR] literal em item USE MELHOR (OpenAI Academy)", () => {
    const md = useMelhorInline(
      "OpenAI Academy",
      "[TRADUZIR] OpenAI Academy and the Walton Family Foundation announced a new partnership to expand AI training (5 min)",
    );
    const result = checkNoUntranslatedSummary(md);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.reason === "traduzir_prefix"));
    assert.equal(result.errors[0].section, "🛠️ USE MELHOR");
    // Self-review finding: titleExcerpt must come from the real inline title
    // (not fall back to blank) for the canonical inline shape.
    assert.equal(result.errors[0].titleExcerpt, "OpenAI Academy");
    assert.match(result.errors[0].descriptionExcerpt, /^\[TRADUZIR\] OpenAI Academy and the Walton/);
  });

  // CASO REAL 2 — USE MELHOR, marcador literal [TRADUZIR]
  it("CASO REAL 260709: flagra [TRADUZIR] literal em item USE MELHOR (LangChain/NVIDIA)", () => {
    const md = useMelhorInline(
      "NemoClaw",
      "[TRADUZIR] LangChain and NVIDIA launch the NemoClaw agent framework for enterprise deployments (8 min)",
    );
    const result = checkNoUntranslatedSummary(md);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.reason === "traduzir_prefix"));
  });

  // CASO REAL 3 — RADAR, marcador literal [TRADUZIR]
  it("CASO REAL 260709: flagra [TRADUZIR] literal em item RADAR (GPT-5.6 Sol)", () => {
    const md = radarInline(
      "GPT-5.6 Sol",
      "[TRADUZIR] OpenAI previews GPT-5.6 Sol, a new model focused on scientific reasoning tasks",
    );
    const result = checkNoUntranslatedSummary(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].section, "📡 RADAR");
    assert.equal(result.errors[0].reason, "traduzir_prefix");
  });

  // Requisito #4 do task: heurística EN SEM o marcador literal — cobre o caso
  // em que o humanizador removeu o prefixo [TRADUZIR] mas não traduziu o texto.
  it("flagra descrição claramente em inglês SEM o marcador [TRADUZIR] (heurística EN)", () => {
    const md = radarInline(
      "LangChain NVIDIA framework",
      "LangChain and NVIDIA launch the new open source framework for enterprise AI teams across the industry",
    );
    const result = checkNoUntranslatedSummary(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].reason, "en_heuristic");
    assert.equal(result.errors[0].section, "📡 RADAR");
  });

  it("não flagra descrição em PT-BR normal", () => {
    const md = radarInline(
      "Startup brasileira capta rodada Series A",
      "A empresa vai usar o aporte para expandir operações na América Latina.",
    );
    const result = checkNoUntranslatedSummary(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("formato de 2 linhas (título + descrição na linha seguinte) também é coberto", () => {
    const md = [
      "**🚀 LANÇAMENTOS**",
      "",
      "[Nova ferramenta de IA](https://example.com/l1)",
      "[TRADUZIR] The company announced a new release with multimodal support",
      "",
    ].join("\n");
    const result = checkNoUntranslatedSummary(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].section, "🚀 LANÇAMENTOS");
  });

  it("marcador [TRADUZIR] fora de um shape reconhecido ainda é pego (catch-all por linha)", () => {
    const md = [
      "**📡 RADAR**",
      "",
      "Um parágrafo qualquer com [TRADUZIR] embutido no meio, formato atípico.",
      "",
    ].join("\n");
    const result = checkNoUntranslatedSummary(md);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.reason === "traduzir_prefix"));
  });

  it("ignora seção DESTAQUE (fora de escopo)", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[Modelo de IA da Meta supera GPT-4 em benchmarks](https://example.com/d1)",
      "",
      "Por que isso importa: the model shows significant improvements across benchmarks",
      "",
      "---",
    ].join("\n");
    const result = checkNoUntranslatedSummary(md);
    assert.equal(result.ok, true, "checagem é escopo só de seções secundárias, não de DESTAQUE");
  });
});

describe("lint-newsletter-md.ts CLI --check no-untranslated-summary (GATE-BLOCKING)", () => {
  function runLint(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
    });
  }

  it("exit 1 quando há [TRADUZIR] literal", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-no-untranslated-summary-block-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        useMelhorInline("Título", "[TRADUZIR] English text that never got translated (5 min)"),
        "utf8",
      );
      const r = runLint(["--check", "no-untranslated-summary", "--md", mdPath]);
      assert.equal(r.status, 1, `esperava exit 1 (GATE-BLOCKING), obteve ${r.status}. stderr: ${r.stderr}`);
      assert.match(r.stderr, /❌/, "stderr deve usar ❌ (gate-blocking)");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("exit 0 pra descrição PT-BR limpa", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-no-untranslated-summary-clean-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(mdPath, radarInline("Título", "Descrição completa em português."), "utf8");
      const r = runLint(["--check", "no-untranslated-summary", "--md", mdPath]);
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
