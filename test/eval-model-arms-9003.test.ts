/**
 * test/eval-model-arms-9003.test.ts (#9003 item 2)
 *
 * O eval de prompt (#8144) descartava o frontmatter do agent: numa PR que só
 * trocava `model:`, baseline e candidato rodavam o mesmo corpo no mesmo modelo
 * e o gate passava sem medir nada. Estes testes travam: (a) model/effort do
 * frontmatter de cada lado chegam ao `claude -p`; (b) `--arms` roda braços
 * extras; (c) parsing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromptRegressionEval } from "../scripts/eval-prompt-regression.ts";
import { parseAgentModelSpec, parseArms } from "../scripts/lib/prompt-regression-eval.ts";

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
  writeFileSync(join(editionsRootDir, aammdd, "01-categorized.md"), "# pool\n", "utf8");
}

const OK = JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 }, result: "ok" });

describe("runPromptRegressionEval — model/effort do frontmatter e --arms (#9003)", () => {
  it("mudança só de `model:` gera chamadas com modelos diferentes em baseline e candidato", () => {
    withTmpDir("eval-model-9003-", (root) => {
      const editionsRootDir = join(root, "data", "editions");
      writeReferenceEdition(editionsRootDir, "260406");
      const calls: Array<{ model?: string; effort?: string }> = [];

      runPromptRegressionEval({
        agent: "social-writer",
        referenceEditions: ["260406"],
        editionsRootDir,
        baselineRef: "origin/master",
        repetitions: 1,
        dryRun: false,
        rootDir: root,
        // corpo IDÊNTICO nos dois lados: só o frontmatter difere
        readAgentBodyFromDiskFn: () => "mesmo corpo",
        readAgentBodyAtGitRefFn: () => "mesmo corpo",
        readAgentModelSpecFromDiskFn: () => ({ model: "claude-sonnet-5-5", effort: "low" }),
        readAgentModelSpecAtGitRefFn: () => ({ model: "claude-sonnet-5", effort: "medium" }),
        callClaudeCliFn: (_prompt, opts) => {
          calls.push({ model: opts.model, effort: opts.effort });
          return OK;
        },
      });

      assert.equal(calls.length, 2);
      assert.deepEqual(
        calls.map((c) => `${c.model}:${c.effort}`).sort(),
        ["claude-sonnet-5-5:low", "claude-sonnet-5:medium"],
      );
    });
  });

  it("--arms roda o corpo do candidato em cada braço com model/effort próprio", () => {
    withTmpDir("eval-model-9003-arms-", (root) => {
      const editionsRootDir = join(root, "data", "editions");
      writeReferenceEdition(editionsRootDir, "260407");
      const calls: string[] = [];

      const report = runPromptRegressionEval({
        agent: "social-writer",
        referenceEditions: ["260407"],
        editionsRootDir,
        baselineRef: "origin/master",
        repetitions: 1,
        dryRun: false,
        rootDir: root,
        readAgentBodyFromDiskFn: () => "corpo candidato",
        readAgentBodyAtGitRefFn: () => "corpo baseline",
        arms: parseArms("claude-sonnet-5:medium,claude-opus-5-5:low,claude-sonnet-5-5"),
        callClaudeCliFn: (_p, opts) => {
          calls.push(`${opts.model}:${opts.effort ?? "-"}`);
          return OK;
        },
      });

      // baseline + candidato + 3 braços
      assert.equal(calls.length, 5);
      assert.ok(calls.includes("claude-sonnet-5:medium"));
      assert.ok(calls.includes("claude-opus-5-5:low"));
      assert.ok(calls.includes("claude-sonnet-5-5:-"));
      assert.equal(report.editions[0].arms.length, 3);
      assert.equal(report.editions[0].arms[1].outcome.side, "arm:claude-opus-5-5:low");
    });
  });

  it("dry-run com --arms nunca chama o CLI", () => {
    withTmpDir("eval-model-9003-dry-", (root) => {
      const editionsRootDir = join(root, "data", "editions");
      writeReferenceEdition(editionsRootDir, "260408");
      const report = runPromptRegressionEval({
        agent: "social-writer",
        referenceEditions: ["260408"],
        editionsRootDir,
        baselineRef: "origin/master",
        repetitions: 2,
        dryRun: true,
        rootDir: root,
        readAgentBodyFromDiskFn: () => "c",
        readAgentBodyAtGitRefFn: () => "b",
        arms: [{ model: "claude-opus-5-5", effort: "low" }],
        callClaudeCliFn: () => {
          throw new Error("não deveria chamar");
        },
      });
      assert.equal(report.editions[0].arms[0].outcome.outcomes.length, 2);
    });
  });
});

describe("parseAgentModelSpec / parseArms (#9003)", () => {
  it("lê model e effort do frontmatter; ausentes ficam undefined", () => {
    assert.deepEqual(parseAgentModelSpec("---\nname: x\nmodel: claude-opus-5-5\neffort: low\n---\ncorpo"), {
      model: "claude-opus-5-5",
      effort: "low",
    });
    assert.deepEqual(parseAgentModelSpec("---\nname: x\n---\nmodel: no-corpo"), {});
    assert.deepEqual(parseAgentModelSpec("sem frontmatter"), {});
  });

  it("parseArms aceita effort opcional e rejeita malformado", () => {
    assert.deepEqual(parseArms("a:low,b"), [{ model: "a", effort: "low" }, { model: "b" }]);
    assert.throws(() => parseArms("a:"), /malformado/);
    assert.throws(() => parseArms("a:b:c"), /malformado/);
    assert.throws(() => parseArms(" , "), /vazio/);
  });
});
