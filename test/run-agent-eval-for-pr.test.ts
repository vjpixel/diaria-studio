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
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findTriggeringAgents,
  pickDefaultReferenceEditions,
  agentDeclaresMcpTools,
  computeCostDelta,
  renderAgentEvalPrReport,
  fetchPrMeta,
  fetchPrBaseSha,
  fetchFileContentAtRef,
  addLabel,
  postComment,
  type CommandRunner,
  type CommandRunnerResult,
} from "../scripts/run-agent-eval-for-pr.ts";
import { PROMPT_EVAL_AGENTS } from "../scripts/lib/agent-eval-trigger-allowlist.ts";
import type { PromptRegressionEvalReport } from "../scripts/eval-prompt-regression.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

  it("canário (#8144 self-review, item P3) — writer-destaque e social-writer HOJE não declaram ferramenta MCP, protegendo a afirmação em prosa do módulo ('não aplicável hoje') contra apodrecimento silencioso caso um dos 2 ganhe uma tool mcp__* no futuro sem ninguém revisitar o grader anti-fabricação", () => {
    for (const agentName of ["writer-destaque", "social-writer"]) {
      const content = readFileSync(join(ROOT, ".claude", "agents", `${agentName}.md`), "utf8");
      assert.equal(agentDeclaresMcpTools(content), false, `${agentName}.md passou a declarar mcp__* — revisitar o TODO do grader anti-fabricação de MCP na docstring de run-agent-eval-for-pr.ts`);
    }
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

  it("aviso agregado 'NÃO significa sem regressão' aparece no TOPO do comentário, antes da lista detalhada por agent, com a contagem de vereditos (#8144 fix, achado silent-failure-hunter na PR #8173)", () => {
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
    assert.match(md, /NÃO significa "sem regressão"/);
    assert.match(md, /0 regressão\(ões\) \/ 0 melhoria\(s\) \/ 1 inconclusive\/unchanged encontrada\(s\)/);
    const warningIdx = md.indexOf('NÃO significa "sem regressão"');
    const agentSectionIdx = md.indexOf(`## ${agent}`);
    assert.ok(warningIdx >= 0 && agentSectionIdx >= 0 && warningIdx < agentSectionIdx, "o aviso agregado precisa vir ANTES da seção detalhada por agent");
  });

  it("aviso agregado aparece mesmo sem report registrado (dry-run/sem dados) — mas sem contagem fabricada", () => {
    const md = renderAgentEvalPrReport({
      prNumber: 1,
      prUrl: "u",
      prTitle: "t",
      triggering: [{ agent, verdict: { agent, bodyChanged: true, modelChanged: false, triggers: true, reason: "corpo mudou" } }],
      reports: {},
      costDeltas: [],
      mcpApplicable: false,
      live: false,
    });
    assert.match(md, /NÃO significa "sem regressão"/);
    assert.doesNotMatch(md, /regressão\(ões\)/);
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
          headRefOid: "bbb",
          files: [{ path: ".claude/agents/social-writer.md" }, { path: "README.md" }],
        }),
        stderr: "",
      },
      // #8403: o SHA base não vem mais do `pr view` (campo inexistente no gh
      // 2.46.0) e sim do REST — o mock precisa cobrir as duas chamadas.
      "api repos/{owner}/{repo}/pulls/8200": {
        status: 0,
        stdout: "0e75860935c1a56ca712f733ab25cd65e9c11de7\n",
        stderr: "",
      },
    });
    const meta = fetchPrMeta("8200", runner);
    assert.equal(meta.number, 8200);
    assert.deepEqual(meta.files, [".claude/agents/social-writer.md", "README.md"]);
    assert.equal(meta.baseRefOid, "0e75860935c1a56ca712f733ab25cd65e9c11de7");
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

  it("gh api falha (404 confirmado no stderr, arquivo ausente naquele ref): null", () => {
    const runner = mockRunner({ "contents/.claude/agents/x.md": { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" } });
    assert.equal(fetchFileContentAtRef(".claude/agents/x.md", "sha1", runner), null);
  });

  it("jq devolve 'null' textual (campo ausente): tratado como null, não a string 'null'", () => {
    const runner = mockRunner({ "contents/.claude/agents/x.md": { status: 0, stdout: "null\n", stderr: "" } });
    assert.equal(fetchFileContentAtRef(".claude/agents/x.md", "sha1", runner), null);
  });

  it("gh api falha por motivo que NÃO é 404 (ex: rate limit 403): LANÇA, nunca devolve null (#8144 fix — CRÍTICO, confirmado independentemente por pr-test-analyzer e silent-failure-hunter no fleet review da PR #8173). Antes desta correção, falha de infra virava o MESMO null que 'arquivo ausente', fazendo evaluateAgentEvalTrigger(agent, null, null) concluir triggers=false quando na verdade era uma falha de rede/auth escondendo uma mudança real de prompt.", () => {
    const runner = mockRunner({ "contents/.claude/agents/x.md": { status: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" } });
    assert.throws(() => fetchFileContentAtRef(".claude/agents/x.md", "sha1", runner), /não é 404/);
  });

  it("gh api falha sem stderr nenhum (timeout/sinal): também LANÇA — ausência de stderr não é evidência de 404", () => {
    const runner = mockRunner({ "contents/.claude/agents/x.md": { status: null, stdout: "", stderr: "" } });
    assert.throws(() => fetchFileContentAtRef(".claude/agents/x.md", "sha1", runner), /não é 404/);
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

// ---------------------------------------------------------------------------
// #8403 — regressão: gh 2.46.0 (o do servidor `300`) não conhece o campo
// `baseRefOid` em `gh pr view --json`. O runner abaixo emula a versão REAL:
// qualquer `pr view --json` que peça `baseRefOid` sai com o mesmo
// `Unknown JSON field` que o gh 2.46.0 imprime. Antes do fix, fetchPrMeta
// batia exatamente nisso e o script inteiro abortava antes de qualquer eval.
// ---------------------------------------------------------------------------

/** Saída literal do gh 2.46.0 ao receber um campo --json que ele não conhece. */
const GH_246_UNKNOWN_FIELD_STDERR =
  'Unknown JSON field: "baseRefOid"\nAvailable fields:\n  additions\n  assignees\n  author\n  baseRefName\n  body\n';

function gh246Runner(opts: { baseSha?: string; baseShaStatus?: number; baseShaStderr?: string } = {}): {
  runner: CommandRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: CommandRunner = (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    calls.push(key);
    if (args[0] === "pr" && args[1] === "view") {
      const fields = args[args.indexOf("--json") + 1] ?? "";
      if (fields.split(",").includes("baseRefOid")) {
        return { status: 1, stdout: "", stderr: GH_246_UNKNOWN_FIELD_STDERR };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 8401,
          url: "https://github.com/vjpixel/diaria-studio/pull/8401",
          title: "feat: X",
          headRefOid: "2c8a32bb830adee1c310d14aee8824820643b015",
          files: [{ path: ".claude/agents/writer-destaque.md" }],
        }),
        stderr: "",
      };
    }
    if (args[0] === "api" && /\/pulls\/\d+$/.test(args[1] ?? "")) {
      return {
        status: opts.baseShaStatus ?? 0,
        stdout: opts.baseSha ?? "0e75860935c1a56ca712f733ab25cd65e9c11de7\n",
        stderr: opts.baseShaStderr ?? "",
      };
    }
    throw new Error(`gh246Runner: comando não mockado: ${key}`);
  };
  return { runner, calls };
}

describe("fetchPrBaseSha / gh 2.46.0 (#8403)", () => {
  it("fetchPrMeta resolve o SHA base sem pedir baseRefOid ao gh pr view", () => {
    const { runner, calls } = gh246Runner();
    const meta = fetchPrMeta("8401", runner);
    assert.equal(meta.baseRefOid, "0e75860935c1a56ca712f733ab25cd65e9c11de7");
    assert.equal(meta.headRefOid, "2c8a32bb830adee1c310d14aee8824820643b015");
    assert.deepEqual(meta.files, [".claude/agents/writer-destaque.md"]);
    // O cenário que falhava: nenhuma chamada pode pedir baseRefOid ao pr view.
    assert.ok(!calls.some((c) => c.includes("pr view") && c.includes("baseRefOid")), calls.join(" | "));
    assert.ok(calls.some((c) => c.includes("api repos/{owner}/{repo}/pulls/8401")), calls.join(" | "));
  });

  it("gh api falhando: lança alto, nunca devolve SHA vazio", () => {
    const { runner } = gh246Runner({ baseShaStatus: 1, baseShaStderr: "gh: rate limit (HTTP 403)" });
    assert.throws(() => fetchPrBaseSha("8401", runner), /\.base\.sha\) falhou.*rate limit/s);
    assert.throws(() => fetchPrMeta("8401", runner), /\.base\.sha\) falhou/);
  });

  it("saída que não é SHA de 40 hex (vazio, 'null', ref simbólico): lança em vez de degradar", () => {
    for (const bad of ["", "\n", "null\n", "master\n", "0e75860\n"]) {
      const { runner } = gh246Runner({ baseSha: bad });
      assert.throws(() => fetchPrBaseSha("8401", runner), /não é um SHA de 40 hex/, `deveria rejeitar ${JSON.stringify(bad)}`);
    }
  });
});
