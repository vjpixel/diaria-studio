/**
 * test/run-agent-eval-for-pr.test.ts (#8144)
 *
 * Cobre a parte pura + as chamadas `gh` (mockadas via CommandRunner
 * injetável, nunca rede real) de scripts/run-agent-eval-for-pr.ts:
 * descoberta de agents tocados por uma PR, derivação de edições de
 * referência default, detecção de tools MCP, cálculo de delta de custo, e
 * as funções de fetch/gh (fetchPrMeta, fetchFileContentAtRef, addLabel,
 * postComment) com um runner falso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findTriggeringAgents,
  pickDefaultReferenceEditions,
  agentDeclaresMcpTools,
  computeCostDelta,
  renderAgentEvalPrReport,
  fetchPrMeta,
  fetchFileContentAtRef,
  addLabel,
  postComment,
  type CommandRunner,
  type CommandRunnerResult,
} from "../scripts/run-agent-eval-for-pr.ts";
import { PROMPT_EVAL_AGENTS } from "../scripts/lib/agent-eval-trigger-allowlist.ts";
import type { PromptRegressionEvalReport } from "../scripts/eval-prompt-regression.ts";

const SAMPLE_MD = (model: string, body: string) => ["---", "name: fake", `model: ${model}`, "---", "", body].join("\n");

describe("findTriggeringAgents (#8144)", () => {
  it("só entram agents MAPEADOS cujo corpo/model mudou", () => {
    const agent = PROMPT_EVAL_AGENTS[0];
    const path = `.claude/agents/${agent}.md`;
    const out = findTriggeringAgents(
      [path, ".claude/agents/scorer.md", "README.md"],
      (p) => (p === path ? SAMPLE_MD("claude-sonnet-5", "antigo") : SAMPLE_MD("claude-sonnet-5", "antigo")),
      (p) => (p === path ? SAMPLE_MD("claude-sonnet-5", "NOVO") : SAMPLE_MD("claude-sonnet-5", "antigo")),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].agent, agent);
    assert.equal(out[0].verdict.bodyChanged, true);
  });

  it("nenhum arquivo de agent no diff: array vazio", () => {
    const out = findTriggeringAgents(["scripts/x.ts"], () => null, () => null);
    assert.deepEqual(out, []);
  });
});

describe("pickDefaultReferenceEditions (#8144)", () => {
  it("filtra por padrão AAMMDD, filtra por hasApprovedJson, ordena ASCENDENTE, corta pro limite", () => {
    const dirNames = ["260101", "260103", "260102", "not-a-date", "260099"];
    const withFixture = new Set(["260101", "260102", "260103"]);
    const out = pickDefaultReferenceEditions(dirNames, (d) => withFixture.has(d), 2);
    assert.deepEqual(out, ["260102", "260103"]);
  });

  it("menos candidatos que o limite: devolve todos os disponíveis", () => {
    const out = pickDefaultReferenceEditions(["260101"], () => true, 3);
    assert.deepEqual(out, ["260101"]);
  });

  it("nenhum candidato: array vazio", () => {
    const out = pickDefaultReferenceEditions(["260101"], () => false, 3);
    assert.deepEqual(out, []);
  });
});

describe("agentDeclaresMcpTools (#8144)", () => {
  it("tools: sem mcp__: false", () => {
    const md = ["---", "tools: Read, Write", "---", "corpo"].join("\n");
    assert.equal(agentDeclaresMcpTools(md), false);
  });

  it("tools: com mcp__: true", () => {
    const md = ["---", "tools: Read, mcp__clarice__correct_text", "---", "corpo"].join("\n");
    assert.equal(agentDeclaresMcpTools(md), true);
  });

  it("content null: false", () => {
    assert.equal(agentDeclaresMcpTools(null), false);
  });

  it("sem frontmatter: false", () => {
    assert.equal(agentDeclaresMcpTools("corpo qualquer"), false);
  });
});

describe("computeCostDelta (#8144)", () => {
  const agent = PROMPT_EVAL_AGENTS[0];

  it("ambos os lados presentes: delta é candidato - baseline", () => {
    const d = computeCostDelta(agent, "260101", 1000, 1500);
    assert.equal(d.deltaTokens, 500);
  });

  it("baseline ausente: delta null, nunca fabricado", () => {
    const d = computeCostDelta(agent, "260101", null, 1500);
    assert.equal(d.deltaTokens, null);
  });

  it("candidato ausente: delta null", () => {
    const d = computeCostDelta(agent, "260101", 1000, null);
    assert.equal(d.deltaTokens, null);
  });

  it("delta negativo (custo caiu): representado como número negativo, não string mascarada", () => {
    const d = computeCostDelta(agent, "260101", 2000, 1200);
    assert.equal(d.deltaTokens, -800);
  });
});

describe("renderAgentEvalPrReport (#8144)", () => {
  const agent = PROMPT_EVAL_AGENTS[0];
  const baseReport: PromptRegressionEvalReport = {
    agent,
    baseline_ref: "origin/master",
    repetitions: 3,
    dry_run: false,
    editions: [
      {
        edition: "260101",
        baseline: { side: "baseline", edition: "260101", testDirName: "test-baseline", outcomes: [] },
        candidate: { side: "candidate", edition: "260101", testDirName: "test-candidate", outcomes: [] },
        deltas: [{ name: "banned-lexicon", baseline: null, candidate: null, verdict: "unchanged" }],
      },
    ],
  };

  it("modo dry-run aparece no cabeçalho", () => {
    const md = renderAgentEvalPrReport({
      prNumber: 8200,
      prUrl: "https://github.com/vjpixel/diaria-studio/pull/8200",
      prTitle: "fix: algo",
      triggering: [{ agent, verdict: { agent, bodyChanged: true, modelChanged: false, triggers: true, reason: "corpo mudou" } }],
      reports: {},
      costDeltas: [],
      mcpApplicable: false,
      live: false,
    });
    assert.match(md, /DRY-RUN/);
    assert.match(md, /PR #8200/);
  });

  it("agent sem report registrado (ex: erro de execução) aparece com aviso explícito, não silêncio", () => {
    const md = renderAgentEvalPrReport({
      prNumber: 1,
      prUrl: "u",
      prTitle: "t",
      triggering: [{ agent, verdict: { agent, bodyChanged: true, modelChanged: false, triggers: true, reason: "corpo mudou" } }],
      reports: {},
      costDeltas: [],
      mcpApplicable: false,
      live: true,
    });
    assert.match(md, /eval não rodou/);
  });

  it("com report: lista o veredito por grader/edição", () => {
    const md = renderAgentEvalPrReport({
      prNumber: 1,
      prUrl: "u",
      prTitle: "t",
      triggering: [{ agent, verdict: { agent, bodyChanged: true, modelChanged: false, triggers: true, reason: "corpo mudou" } }],
      reports: { [agent]: baseReport },
      costDeltas: [],
      mcpApplicable: false,
      live: true,
    });
    assert.match(md, /banned-lexicon: \*\*unchanged\*\*/);
    assert.match(md, /edição 260101/);
  });

  it("MCP não aplicável: nota explícita de 'não aplicável', nunca omitida", () => {
    const md = renderAgentEvalPrReport({ prNumber: 1, prUrl: "u", prTitle: "t", triggering: [], reports: {}, costDeltas: [], mcpApplicable: false, live: true });
    assert.match(md, /não aplicável hoje/);
  });

  it("MCP aplicável: nota de TODO/follow-up, nunca um grader inventado", () => {
    const md = renderAgentEvalPrReport({ prNumber: 1, prUrl: "u", prTitle: "t", triggering: [], reports: {}, costDeltas: [], mcpApplicable: true, live: true });
    assert.match(md, /TODO de follow-up/);
  });

  it("delta de custo com model: mudado é destacado explicitamente", () => {
    const md = renderAgentEvalPrReport({
      prNumber: 1,
      prUrl: "u",
      prTitle: "t",
      triggering: [{ agent, verdict: { agent, bodyChanged: false, modelChanged: true, triggers: true, reason: "model: mudou" } }],
      reports: { [agent]: baseReport },
      costDeltas: [{ agent, edition: "260101", baselineTokens: 1000, candidateTokens: 1500, deltaTokens: 500 }],
      mcpApplicable: false,
      live: true,
    });
    assert.match(md, /delta=\+500 tokens \(model: mudou/);
  });
});

// ---------------------------------------------------------------------------
// Funções que chamam `gh` — CommandRunner falso, nunca rede real.
// ---------------------------------------------------------------------------

function mockRunner(handlers: Record<string, CommandRunnerResult>): CommandRunner {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, result] of Object.entries(handlers)) {
      if (key.includes(pattern)) return result;
    }
    throw new Error(`mockRunner: comando não mockado: ${key}`);
  };
}

describe("fetchPrMeta (#8144)", () => {
  it("parseia o JSON de gh pr view", () => {
    const runner = mockRunner({
      "pr view 8200": {
        status: 0,
        stdout: JSON.stringify({
          number: 8200,
          url: "https://github.com/vjpixel/diaria-studio/pull/8200",
          title: "fix: X",
          baseRefOid: "aaa",
          headRefOid: "bbb",
          files: [{ path: ".claude/agents/social-writer.md" }, { path: "README.md" }],
        }),
        stderr: "",
      },
    });
    const meta = fetchPrMeta("8200", runner);
    assert.equal(meta.number, 8200);
    assert.deepEqual(meta.files, [".claude/agents/social-writer.md", "README.md"]);
  });

  it("gh falha: lança erro claro em vez de devolver meta parcial", () => {
    const runner = mockRunner({ "pr view 8200": { status: 1, stdout: "", stderr: "not found" } });
    assert.throws(() => fetchPrMeta("8200", runner), /gh pr view 8200 falhou/);
  });
});

describe("fetchFileContentAtRef (#8144)", () => {
  it("decodifica base64 de .content", () => {
    const b64 = Buffer.from("conteúdo do agent", "utf8").toString("base64");
    const runner = mockRunner({ "contents/.claude/agents/x.md": { status: 0, stdout: `${b64}\n`, stderr: "" } });
    const content = fetchFileContentAtRef(".claude/agents/x.md", "sha1", runner);
    assert.equal(content, "conteúdo do agent");
  });

  it("gh api falha (404, arquivo ausente naquele ref): null", () => {
    const runner = mockRunner({ "contents/.claude/agents/x.md": { status: 1, stdout: "", stderr: "404" } });
    assert.equal(fetchFileContentAtRef(".claude/agents/x.md", "sha1", runner), null);
  });

  it("jq devolve 'null' textual (campo ausente): tratado como null, não a string 'null'", () => {
    const runner = mockRunner({ "contents/.claude/agents/x.md": { status: 0, stdout: "null\n", stderr: "" } });
    assert.equal(fetchFileContentAtRef(".claude/agents/x.md", "sha1", runner), null);
  });
});

describe("addLabel / postComment (#8144)", () => {
  it("addLabel: status 0 não lança", () => {
    const runner = mockRunner({ "pr edit 42": { status: 0, stdout: "", stderr: "" } });
    assert.doesNotThrow(() => addLabel("42", "agent-eval:passed", runner));
  });

  it("addLabel: status != 0 lança com a label no erro", () => {
    const runner = mockRunner({ "pr edit 42": { status: 1, stdout: "", stderr: "label not found" } });
    assert.throws(() => addLabel("42", "agent-eval:passed", runner), /agent-eval:passed/);
  });

  it("postComment: status 0 não lança", () => {
    const runner = mockRunner({ "pr comment 42": { status: 0, stdout: "", stderr: "" } });
    assert.doesNotThrow(() => postComment("42", "/tmp/x.md", runner));
  });

  it("postComment: status != 0 lança", () => {
    const runner = mockRunner({ "pr comment 42": { status: 1, stdout: "", stderr: "rate limited" } });
    assert.throws(() => postComment("42", "/tmp/x.md", runner), /rate limited/);
  });
});
