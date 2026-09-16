/**
 * test/stage4-post-edit-checks-core.test.ts (#8123 Fatia 3)
 *
 * Cobre `scripts/lib/stage4-post-edit-checks-core.ts` — o agregador único
 * que substitui a cadeia ad-hoc de checagens síncronas de
 * `.claude/agents/orchestrator-stage-4.md` (lint-newsletter --stage 4,
 * lint-social --stage 4, validate-lancamentos, validate-domain-diversity,
 * check-invariants --stage 4, check-humanizer-social --check).
 *
 * Estratégia (mesma de `test/lint-newsletter-md-stage-json.test.ts`): não
 * tenta montar um fixture "100% limpo" que passe em TODOS os checks —
 * frágil demais. Em vez disso valida as PROPRIEDADES do agregador:
 *   - "findings só com achados" — nunca emite entrada pra check que passou;
 *   - severity/gate_blocking refletem fielmente o que cada sub-check
 *     reporta (comparado contra chamar as funções puras diretamente);
 *   - checks condicionais (social/humanizer) são pulados quando
 *     `03-social.md` não existe, sem lançar exceção;
 *   - `computeInputsHash` muda quando o conteúdo muda e é estável quando não.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runStage4PostEditChecks,
  computeInputsHash,
} from "../scripts/lib/stage4-post-edit-checks-core.ts";
import { runStage4LintReport } from "../scripts/lint-newsletter-md.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

const INTRO_LINE =
  "Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 7 artigos. Selecionamos os 2 mais relevantes para as pessoas que assinam a newsletter.";

function buildMd(): string {
  return [
    INTRO_LINE,
    "",
    "---",
    "",
    "**DESTAQUE 1 | PRODUTO**",
    "",
    "**[Título de teste](https://example.com/d1)**",
    "",
    "Corpo curto de teste, deliberadamente abaixo do piso editorial de 1000 chars.",
    "",
    "Por que isso importa:",
    "",
    "Impacto direto pequeno, também deliberadamente curto pra este fixture de teste.",
    "",
    "---",
    "",
    "**LANÇAMENTOS**",
    "",
    "**[Ferramenta não-oficial](https://blog.example.com/cobertura-de-imprensa)**",
    "Cobertura de imprensa de terceiro, não é o link oficial do produto (#160).",
    "",
    "---",
    "",
  ].join("\n");
}

function makeEditionDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "stage4-post-edit-checks-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), buildMd(), "utf8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("computeInputsHash", () => {
  it("é estável para o mesmo conteúdo e muda quando 02-reviewed.md muda", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const h1 = computeInputsHash(dir);
      const h2 = computeInputsHash(dir);
      assert.equal(h1, h2);

      writeFileSync(join(dir, "02-reviewed.md"), buildMd() + "\nlinha extra\n", "utf8");
      const h3 = computeInputsHash(dir);
      assert.notEqual(h1, h3);
    } finally {
      cleanup();
    }
  });

  it("muda quando 03-social.md aparece (mesmo com 02-reviewed.md intocado)", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const before = computeInputsHash(dir);
      writeFileSync(join(dir, "03-social.md"), "# LinkedIn\n## d1\nPost.\n", "utf8");
      const after = computeInputsHash(dir);
      assert.notEqual(before, after);
    } finally {
      cleanup();
    }
  });
});

describe("runStage4PostEditChecks", () => {
  it("nunca lança — roda sobre uma edition-dir mínima e devolve um relatório estruturado", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const report = runStage4PostEditChecks(dir, PROJECT_ROOT);
      assert.equal(report.edition_dir, dir);
      assert.equal(typeof report.inputs_hash, "string");
      assert.equal(report.findings_count, report.findings.length);
      assert.equal(report.ok, report.findings.length === 0);
      assert.equal(report.gate_blocking, report.findings.some((f) => f.gate_blocking));
    } finally {
      cleanup();
    }
  });

  it("achado 'só com achados': nenhuma entrada de check que passou aparece em findings[]", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const report = runStage4PostEditChecks(dir, PROJECT_ROOT);
      // Cruza contra a chamada direta do agregador de lint-newsletter: o nº
      // de findings com source "lint-newsletter" tem que bater exatamente
      // com o nº de checks que falharam ali — nunca mais, nunca menos.
      const directReport = runStage4LintReport(dir, PROJECT_ROOT);
      const directFailing = directReport.checks.filter((c) => !c.ok).length;
      const ourFindingsFromNewsletter = report.findings.filter((f) => f.source === "lint-newsletter").length;
      assert.equal(ourFindingsFromNewsletter, directFailing);
    } finally {
      cleanup();
    }
  });

  it("pula lint-social/humanizer-social quando 03-social.md não existe, sem lançar", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const report = runStage4PostEditChecks(dir, PROJECT_ROOT);
      assert.ok(!report.checks_run.includes("lint-social:stage-4"));
      assert.ok(!report.checks_run.includes("humanizer-social:check"));
      assert.ok(!report.findings.some((f) => f.source === "lint-social" || f.source === "humanizer-social"));
    } finally {
      cleanup();
    }
  });

  it("roda lint-social/humanizer-social quando 03-social.md existe", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      writeFileSync(join(dir, "03-social.md"), "# LinkedIn\n## d1\nPost sem selo do humanizador.\n", "utf8");
      const report = runStage4PostEditChecks(dir, PROJECT_ROOT);
      assert.ok(report.checks_run.includes("lint-social:stage-4"));
      assert.ok(report.checks_run.includes("humanizer-social:check"));
      // Sem sentinel gravado, o selo do humanizador tem que acusar
      // "sentinel_missing" como achado gate-blocking.
      const humanizerFinding = report.findings.find((f) => f.source === "humanizer-social");
      assert.ok(humanizerFinding, "esperava achado de humanizer-social sem sentinel gravado");
      assert.equal(humanizerFinding!.gate_blocking, true);
      assert.equal(humanizerFinding!.id, "humanizer-social-sentinel_missing");
    } finally {
      cleanup();
    }
  });

  it("validate-lancamentos: URL não-oficial em LANÇAMENTOS vira achado gate-blocking (#160)", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const report = runStage4PostEditChecks(dir, PROJECT_ROOT);
      const finding = report.findings.find(
        (f) => f.source === "validate-lancamentos" && f.id === "invalid-official-url",
      );
      assert.ok(finding, "esperava achado de LANÇAMENTOS com URL não-oficial");
      assert.equal(finding!.gate_blocking, true);
      assert.equal(finding!.source_issue, "#160");
    } finally {
      cleanup();
    }
  });

  it("checks_run sempre inclui lint-newsletter e invariants (rodam incondicionalmente)", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const report = runStage4PostEditChecks(dir, PROJECT_ROOT);
      assert.ok(report.checks_run.includes("lint-newsletter:stage-4"));
      assert.ok(report.checks_run.includes("invariants:stage-4"));
    } finally {
      cleanup();
    }
  });
});
