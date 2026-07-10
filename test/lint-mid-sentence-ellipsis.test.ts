/**
 * test/lint-mid-sentence-ellipsis.test.ts (#3196)
 *
 * Regressão (#633) do lint `checkMidSentenceEllipsis` +
 * `lint-newsletter-md.ts --check mid-sentence-ellipsis` (WARN-ONLY, #2715
 * pattern — mesma convenção de title-publisher-suffix/no-trailing-ellipsis).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkMidSentenceEllipsis } from "../scripts/lib/lint-checks/mid-sentence-ellipsis.ts";

function radarInline(title: string, description: string): string {
  return `**📡 RADAR**\n\n**[${title}](https://example.com/radar)** ${description}\n`;
}

function useMelhorInline(title: string, description: string): string {
  return `**🛠️ USE MELHOR**\n\n**[${title}](https://example.com/tool)** ${description}\n`;
}

describe("checkMidSentenceEllipsis (#3196)", () => {
  // CASO REAL 260709 — RADAR G1: reticência NO MEIO da frase.
  it("CASO REAL 260709: flagra reticência no meio da descrição (RADAR G1)", () => {
    const md = radarInline(
      "Advogado condenado por decisão baseada em IA",
      "Um advogado de Salvador foi condenado ... de inteligência artificial (IA) usadas pelo tribunal",
    );
    const result = checkMidSentenceEllipsis(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].section, "📡 RADAR");
  });

  it("flagra reticência unicode (…) no meio da descrição", () => {
    const md = radarInline(
      "Título qualquer",
      "Texto inicial… continuação da frase depois da reticência no meio.",
    );
    const result = checkMidSentenceEllipsis(md);
    assert.equal(result.ok, false);
  });

  // CASO REAL 260709 — USE MELHOR TikTok: reticência no meio E no fim (auto-injected
  // "(N min)" suffix comes after the trailing ellipsis).
  it("CASO REAL 260709: flagra item USE MELHOR com reticência no meio (TikTok), mesmo com sufixo (N min) no fim", () => {
    const md = useMelhorInline(
      "Truque de vídeo no TikTok",
      "Descobri um truque... Sabe quando o rosto sai todo diferente? Então... (5 min)",
    );
    const result = checkMidSentenceEllipsis(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].section, "🛠️ USE MELHOR");
  });

  it("NÃO flagra descrição SEM nenhuma reticência", () => {
    const md = radarInline(
      "Startup brasileira capta rodada Series A",
      "A empresa vai usar o aporte para expandir operações na América Latina.",
    );
    const result = checkMidSentenceEllipsis(md);
    assert.equal(result.ok, true);
  });

  it("NÃO flagra descrição com APENAS reticência trailing (sem outra no meio)", () => {
    const md = radarInline(
      "Título qualquer",
      "Frase que termina em reticência de truncamento…",
    );
    const result = checkMidSentenceEllipsis(md);
    assert.equal(result.ok, true, "reticência SÓ no fim é escopo de no-trailing-ellipsis, não deste check");
  });

  it("formato de 2 linhas (título + descrição na linha seguinte) também é coberto", () => {
    const md = [
      "**📡 RADAR**",
      "",
      "[Notícia qualquer](https://example.com/radar)",
      "Início da frase ... continuação depois da reticência no meio.",
      "",
    ].join("\n");
    const result = checkMidSentenceEllipsis(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].section, "📡 RADAR");
  });

  it("ignora seção DESTAQUE (fora de escopo)", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[Modelo de IA da Meta supera GPT-4 em benchmarks](https://example.com/d1)",
      "",
      "Por que isso importa: o texto pode ter reticência ... no meio legitimamente aqui.",
      "",
      "---",
    ].join("\n");
    const result = checkMidSentenceEllipsis(md);
    assert.equal(result.ok, true, "checagem é escopo só de seções secundárias, não de DESTAQUE");
  });
});

describe("lint-newsletter-md.ts CLI --check mid-sentence-ellipsis (WARN-ONLY, #2715 pattern)", () => {
  function runLint(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
    });
  }

  it("exit 0 (não 1) mesmo com reticência no meio da descrição", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-mid-sentence-ellipsis-warnonly-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        radarInline("Título", "Um advogado foi condenado ... por decisão baseada em IA."),
        "utf8",
      );
      const r = runLint(["--check", "mid-sentence-ellipsis", "--md", mdPath]);
      assert.equal(r.status, 0, `esperava exit 0 (WARN-ONLY), obteve ${r.status}. stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false, "result.ok deve continuar false — o match ainda é reportado no JSON");
      assert.match(r.stderr, /⚠️/, "stderr deve usar ⚠️ (warning), não ❌");
      assert.doesNotMatch(r.stderr, /❌/, "stderr NÃO deve conter ❌ (não é gate-blocking)");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
