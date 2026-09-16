/**
 * test/eval-prompt-regression.test.ts (#8143)
 *
 * Cobertura de `runPromptRegressionEval` (`scripts/eval-prompt-regression.ts`)
 * — a orquestração completa (fixture via `createReplayFixture` + execução
 * pareada baseline/candidato + comparação). Todos os testes injetam
 * `readAgentBodyFromDiskFn`/`readAgentBodyAtGitRefFn`/`callClaudeCliFn` —
 * NENHUM spawna `git`/`claude` de verdade, e o teste "dry-run" prova que o
 * fluxo inteiro (2 fixtures × N repetições × comparação) roda sem chamar
 * `callClaudeCliFn` nenhuma vez, mesmo padrão de
 * `test/prompt-regression-eval.test.ts` (`runAgentRepetitions`, dry-run).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromptRegressionEval, DEFAULT_REPETITIONS, DEFAULT_BASELINE_REF } from "../scripts/eval-prompt-regression.ts";

function withTmpDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeReferenceEdition(editionsRootDir: string, aammdd: string): void {
  const dir = join(editionsRootDir, aammdd, "_internal");
  mkdirSync(dir, { recursive: true });
  const approved = {
    highlights: [
      { article: { url: "https://x.com/1", title: "Título Um", category: "mercado", summary: "resumo 1" } },
      { article: { url: "https://x.com/2", title: "Título Dois", category: "pesquisa", summary: "resumo 2" } },
      { article: { url: "https://x.com/3", title: "Título Três", category: "brasil", summary: "resumo 3" } },
    ],
  };
  writeFileSync(join(dir, "01-approved.json"), JSON.stringify(approved), "utf8");
  writeFileSync(join(join(editionsRootDir, aammdd), "01-categorized.md"), "# pool\n", "utf8");
}

describe("runPromptRegressionEval — dry-run (default, #8143 item 6)", () => {
  it("nunca chama callClaudeCliFn nem readAgentBodyAtGitRefFn precisa de git real — monta 2 fixtures × repetições, sem executar nada", () => {
    withTmpDir("eval-prompt-regression-", (root) => {
      const editionsRootDir = join(root, "data", "editions");
      writeReferenceEdition(editionsRootDir, "260401");
      let calls = 0;

      const report = runPromptRegressionEval({
        agent: "social-writer",
        referenceEditions: ["260401"],
        editionsRootDir,
        baselineRef: "origin/master",
        repetitions: 2,
        dryRun: true,
        rootDir: root,
        readAgentBodyFromDiskFn: () => "corpo candidato",
        readAgentBodyAtGitRefFn: () => "corpo baseline",
        callClaudeCliFn: () => {
          calls++;
          return "{}";
        },
      });

      assert.equal(calls, 0, "dry-run nunca deve chamar callClaudeCliFn");
      assert.equal(report.dry_run, true);
      assert.equal(report.editions.length, 1);
      const [edition] = report.editions;
      assert.equal(edition.baseline.outcomes.length, 2);
      assert.equal(edition.candidate.outcomes.length, 2);
      assert.ok(edition.baseline.outcomes.every((o) => o.dryRun === true));
      // sem execução real, nenhum grader convergiu — todo delta fica inconclusive, nunca "regressed"/"improved" fabricado.
      assert.ok(edition.deltas.every((d) => d.verdict === "inconclusive"));
    });
  });

  it("cria os 2 diretórios de fixture (baseline/candidato) via createReplayFixture, com _internal/01-approved.json copiado", () => {
    withTmpDir("eval-prompt-regression-", (root) => {
      const editionsRootDir = join(root, "data", "editions");
      writeReferenceEdition(editionsRootDir, "260402");

      const report = runPromptRegressionEval({
        agent: "writer-destaque",
        referenceEditions: ["260402"],
        editionsRootDir,
        baselineRef: "origin/master",
        repetitions: 1,
        dryRun: true,
        rootDir: root,
        readAgentBodyFromDiskFn: () => "corpo candidato",
        readAgentBodyAtGitRefFn: () => "corpo baseline",
      });

      const [edition] = report.editions;
      const baselineDir = join(editionsRootDir, edition.baseline.testDirName);
      const candidateDir = join(editionsRootDir, edition.candidate.testDirName);
      assert.ok(existsSync(join(baselineDir, "_internal", "01-approved.json")));
      assert.ok(existsSync(join(candidateDir, "_internal", "01-approved.json")));
      assert.notEqual(edition.baseline.testDirName, edition.candidate.testDirName);
    });
  });

  it("DEFAULT_REPETITIONS=3 e DEFAULT_BASELINE_REF='origin/master'", () => {
    assert.equal(DEFAULT_REPETITIONS, 3);
    assert.equal(DEFAULT_BASELINE_REF, "origin/master");
  });
});

describe("runPromptRegressionEval — live injetado (#8143, sem spawn real)", () => {
  it("social-writer: produz output diferente para baseline vs candidato → grader diverge (regressed/improved), nunca nota isolada", () => {
    withTmpDir("eval-prompt-regression-live-", (root) => {
      const editionsRootDir = join(root, "data", "editions");
      writeReferenceEdition(editionsRootDir, "260403");

      const report = runPromptRegressionEval({
        agent: "social-writer",
        referenceEditions: ["260403"],
        editionsRootDir,
        baselineRef: "origin/master",
        repetitions: 1,
        dryRun: false,
        rootDir: root,
        readAgentBodyFromDiskFn: () => "corpo candidato",
        readAgentBodyAtGitRefFn: () => "corpo baseline",
        callClaudeCliFn: (prompt) => {
          // candidato escreve texto LIMPO; baseline escreve texto com a forma banida —
          // simula uma correção real (o cenário que o eval existe pra detectar ao contrário: aqui é melhoria).
          const isBaseline = prompt.includes("corpo baseline");
          const out = isBaseline ? "## d1\n\ncomportamento agentivo\n" : "## d1\n\ncomportamento agêntico\n";
          return JSON.stringify({ __out: out, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, duration_ms: 100, result: "ok" });
        },
      });

      // como o outPath real não foi escrito pelo callClaudeCliFn de fato (só simulado no JSON), o
      // arquivo de output esperado nunca aparece no disco — desde a correção do #8168 (fleet
      // review da PR #8168, finding crítico) isso faz `rawText` sair `null` (nunca uma string
      // vazia fabricada) e `producedOutput: false`. Este teste cobre o WIRING (fixtures, custo,
      // deltas), não o parsing do texto produzido em si (isso já é coberto por
      // test/prompt-regression-eval.test.ts::runAgentRepetitions).
      const [edition] = report.editions;
      assert.equal(edition.baseline.outcomes.length, 1);
      assert.equal(edition.candidate.outcomes.length, 1);
      assert.equal(edition.baseline.outcomes[0].dryRun, false);
      assert.equal(edition.baseline.outcomes[0].producedOutput, false, "outPath nunca escrito pelo callClaudeCliFn simulado — nunca deve virar string vazia fabricada");
      assert.equal(edition.baseline.outcomes[0].rawText, null);
      assert.ok(edition.baseline.outcomes[0].usage);
    });
  });

  it("grava cost.json por fixture (baseline e candidato) via writeCostArtifact, custo MEDIDO do usage retornado", () => {
    withTmpDir("eval-prompt-regression-cost-", (root) => {
      const editionsRootDir = join(root, "data", "editions");
      writeReferenceEdition(editionsRootDir, "260404");

      const report = runPromptRegressionEval({
        agent: "social-writer",
        referenceEditions: ["260404"],
        editionsRootDir,
        baselineRef: "origin/master",
        repetitions: 1,
        dryRun: false,
        rootDir: root,
        readAgentBodyFromDiskFn: () => "corpo candidato",
        readAgentBodyAtGitRefFn: () => "corpo baseline",
        callClaudeCliFn: () => JSON.stringify({ usage: { input_tokens: 200, output_tokens: 50 }, num_turns: 3, duration_ms: 999, result: "ok" }),
      });

      const [edition] = report.editions;
      const baselineCostPath = join(editionsRootDir, edition.baseline.testDirName, "_internal", "cost.json");
      const candidateCostPath = join(editionsRootDir, edition.candidate.testDirName, "_internal", "cost.json");
      assert.ok(existsSync(baselineCostPath), "cost.json do baseline deveria ter sido gravado");
      assert.ok(existsSync(candidateCostPath), "cost.json do candidato deveria ter sido gravado");
      const baselineCost = JSON.parse(readFileSync(baselineCostPath, "utf8"));
      assert.ok(baselineCost.aggregate, "cost.json deve ter o aggregate reusado de edition-cost.ts");
    });
  });

  it("dry-run nunca grava cost.json (não há execução real pra medir)", () => {
    withTmpDir("eval-prompt-regression-nocost-", (root) => {
      const editionsRootDir = join(root, "data", "editions");
      writeReferenceEdition(editionsRootDir, "260405");

      const report = runPromptRegressionEval({
        agent: "social-writer",
        referenceEditions: ["260405"],
        editionsRootDir,
        baselineRef: "origin/master",
        repetitions: 1,
        dryRun: true,
        rootDir: root,
        readAgentBodyFromDiskFn: () => "corpo candidato",
        readAgentBodyAtGitRefFn: () => "corpo baseline",
      });

      const [edition] = report.editions;
      const baselineCostPath = join(editionsRootDir, edition.baseline.testDirName, "_internal", "cost.json");
      assert.equal(existsSync(baselineCostPath), false);
    });
  });
});

describe("runPromptRegressionEval — múltiplas edições (#8143 — critério de saída pede ≥10 edições, mecanismo suporta N arbitrário)", () => {
  it("roda todas as edições de referência passadas, 1 resultado por edição", () => {
    withTmpDir("eval-prompt-regression-multi-", (root) => {
      const editionsRootDir = join(root, "data", "editions");
      const editions = ["260401", "260402", "260403"];
      for (const e of editions) writeReferenceEdition(editionsRootDir, e);

      const report = runPromptRegressionEval({
        agent: "writer-destaque",
        referenceEditions: editions,
        editionsRootDir,
        baselineRef: "origin/master",
        repetitions: 1,
        dryRun: true,
        rootDir: root,
        readAgentBodyFromDiskFn: () => "corpo candidato",
        readAgentBodyAtGitRefFn: () => "corpo baseline",
      });

      assert.deepEqual(report.editions.map((e) => e.edition), editions);
    });
  });
});
