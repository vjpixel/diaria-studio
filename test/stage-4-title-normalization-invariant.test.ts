/**
 * test/stage-4-title-normalization-invariant.test.ts (#2693 item 3)
 *
 * Cobre o registro dos 2 lints de título (#2664 sufixo de veículo, #2672
 * ponto final) em `invariant-checks/stage-4.ts` — antes rodavam só via CLI
 * separada (`lint-newsletter-md.ts --check title-publisher-suffix`), fora
 * do registry e portanto invisíveis em `docs/editorial-invariants.md`.
 *
 * end-to-end (lê 02-reviewed.md de um edition-dir temporário), espelhando o
 * padrão de test/stage-4-truncated-secondary-summary.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkTitlePublisherSuffixInvariant,
  checkTitleTrailingPeriodInvariant,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionWithReviewed(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-title-norm-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), md);
  return dir;
}

describe("checkTitlePublisherSuffixInvariant (#2693 item 3)", () => {
  it("flagra título DESTAQUE com sufixo de veículo residual (warning)", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[ChatGPT consegue fazer check-up do seu PC; veja como - Canaltech](https://example.com/d1)",
      "",
      "Por que isso importa: contexto relevante aqui.",
      "",
      "---",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      const v = checkTitlePublisherSuffixInvariant(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "title-publisher-suffix");
      assert.equal(v[0].source_issue, "#2664");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando 02-reviewed.md não existe (stage não chegou lá)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-title-norm-missing-"));
    try {
      assert.deepEqual(checkTitlePublisherSuffixInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] pra título limpo sem sufixo", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[Modelo de IA da Meta supera GPT-4 em benchmarks](https://example.com/d1)",
      "",
      "Por que isso importa: contexto relevante aqui.",
      "",
      "---",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      assert.deepEqual(checkTitlePublisherSuffixInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("checkTitleTrailingPeriodInvariant (#2693 item 3)", () => {
  it("flagra título de item RADAR com ponto final (warning)", () => {
    const md = [
      "RADAR",
      "",
      "[AINews: relatório da OpenAI sobre Codex em 2025.](https://example.com/radar)",
      "Descrição do item.",
      "",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      const v = checkTitleTrailingPeriodInvariant(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "title-trailing-period");
      assert.equal(v[0].source_issue, "#2672");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando 02-reviewed.md não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-title-norm-missing-"));
    try {
      assert.deepEqual(checkTitleTrailingPeriodInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("STAGE_4_RULES registry (#2693 item 3)", () => {
  it("inclui title-publisher-suffix e title-trailing-period", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("title-publisher-suffix"));
    assert.ok(ids.includes("title-trailing-period"));
  });
});

/**
 * #2715 item 3: a invocação CLI direta (usada em orchestrator-stage-4.md §4c.2)
 * saía com `process.exit(1)` + `❌` em caso de match, contradizendo a doc
 * "WARN-ONLY" logo abaixo no orchestrator e a severity "warning" do registry
 * acima. O orchestrator LLM, ao ver exit não-zero num bash tool call, podia
 * tratar o resultado como erro fatal e bloquear o gate indevidamente — mesmo
 * a doc dizendo explicitamente pra não bloquear. Fix: CLI sempre sai 0 (⚠️ em
 * vez de ❌), alinhado ao registry e à doc.
 */
describe("lint-newsletter-md.ts CLI --check title-publisher-suffix/title-trailing-period (#2715 item 3)", () => {
  function runLint(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("title-publisher-suffix: exit 0 (não 1) mesmo com sufixo de veículo detectado", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-title-suffix-warnonly-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
          "",
          "[ChatGPT consegue fazer check-up do seu PC; veja como - Canaltech](https://example.com/d1)",
          "",
          "Por que isso importa: contexto relevante aqui.",
          "",
          "---",
        ].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "title-publisher-suffix", "--md", mdPath]);
      assert.equal(r.status, 0, `esperava exit 0 (WARN-ONLY), obteve ${r.status}. stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false, "result.ok deve continuar false — o match ainda é reportado no JSON");
      assert.equal(out.errors.length, 1);
      assert.match(r.stderr, /⚠️/, "stderr deve usar ⚠️ (warning), não ❌");
      assert.doesNotMatch(r.stderr, /❌/, "stderr NÃO deve conter ❌ (não é mais gate-blocking)");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("title-publisher-suffix: exit 0 pra título limpo (comportamento pré-existente preservado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-title-suffix-clean-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
          "",
          "[Modelo de IA da Meta supera GPT-4 em benchmarks](https://example.com/d1)",
          "",
          "Por que isso importa: contexto relevante aqui.",
          "",
          "---",
        ].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "title-publisher-suffix", "--md", mdPath]);
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("title-trailing-period: exit 0 (não 1) mesmo com título terminando em ponto final", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-title-period-warnonly-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "RADAR",
          "",
          "[AINews: relatório da OpenAI sobre Codex em 2025.](https://example.com/radar)",
          "Descrição do item.",
          "",
        ].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "title-trailing-period", "--md", mdPath]);
      assert.equal(r.status, 0, `esperava exit 0 (WARN-ONLY), obteve ${r.status}. stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false, "result.ok deve continuar false — o match ainda é reportado no JSON");
      assert.equal(out.errors.length, 1);
      assert.match(r.stderr, /⚠️/, "stderr deve usar ⚠️ (warning), não ❌");
      assert.doesNotMatch(r.stderr, /❌/, "stderr NÃO deve conter ❌ (não é mais gate-blocking)");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("title-trailing-period: exit 0 pra título limpo (comportamento pré-existente preservado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-title-period-clean-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "RADAR",
          "",
          "[AINews: relatório da OpenAI sobre Codex em 2025](https://example.com/radar)",
          "Descrição do item.",
          "",
        ].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "title-trailing-period", "--md", mdPath]);
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
