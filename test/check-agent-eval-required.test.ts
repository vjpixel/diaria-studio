/**
 * test/check-agent-eval-required.test.ts (#8144)
 *
 * Cobre scripts/check-agent-eval-required.ts::evaluateAgentEvalTouch (a
 * parte pura — provedores de conteúdo injetados, sem git real) e
 * getPrLabelsWithRetry (mesmo padrão de test/check-editorial-signoff.test.ts,
 * que já cobre a família irmã de retry+backoff).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateAgentEvalTouch, getPrLabelsWithRetry, AGENT_EVAL_LABEL, type SpawnFn } from "../scripts/check-agent-eval-required.ts";
import { PROMPT_EVAL_AGENTS } from "../scripts/lib/agent-eval-trigger-allowlist.ts";

const SAMPLE_MD = (model: string, body: string) => ["---", "name: fake", `model: ${model}`, "---", "", body].join("\n");

describe("evaluateAgentEvalTouch (#8144)", () => {
  it("nenhum arquivo .claude/agents/*.md no diff: triggeringAgents vazio", () => {
    const check = evaluateAgentEvalTouch(["scripts/random.ts", "README.md"], () => null, () => null);
    assert.deepEqual(check.triggeringAgents, []);
  });

  it("agent MAPEADO com corpo mudado: entra em triggeringAgents", () => {
    const agent = PROMPT_EVAL_AGENTS[0];
    const path = `.claude/agents/${agent}.md`;
    const check = evaluateAgentEvalTouch(
      [path],
      () => SAMPLE_MD("claude-sonnet-5", "corpo antigo"),
      () => SAMPLE_MD("claude-sonnet-5", "corpo NOVO"),
    );
    assert.deepEqual(check.triggeringAgents, [agent]);
    assert.ok(check.infoLines.some((l) => l.includes("DISPARA")));
  });

  it("agent MAPEADO só com frontmatter não-model mudado: não entra em triggeringAgents", () => {
    const agent = PROMPT_EVAL_AGENTS[0];
    const path = `.claude/agents/${agent}.md`;
    const md1 = ["---", "name: fake", "model: claude-sonnet-5", "description: a", "---", "", "corpo"].join("\n");
    const md2 = ["---", "name: fake", "model: claude-sonnet-5", "description: b", "---", "", "corpo"].join("\n");
    const check = evaluateAgentEvalTouch([path], () => md1, () => md2);
    assert.deepEqual(check.triggeringAgents, []);
    assert.ok(check.infoLines.some((l) => l.includes("não dispara")));
  });

  it("agent EXCLUÍDO tocado (ex: scorer): nunca entra em triggeringAgents mesmo com corpo mudado", () => {
    const path = ".claude/agents/scorer.md";
    const check = evaluateAgentEvalTouch(
      [path],
      () => SAMPLE_MD("claude-sonnet-5", "antigo"),
      () => SAMPLE_MD("claude-sonnet-5", "novo"),
    );
    assert.deepEqual(check.triggeringAgents, []);
    assert.ok(check.infoLines.some((l) => l.includes("excluído")));
  });

  it("agent totalmente desconhecido (unclassified) tocado: não dispara, mas gera linha de AVISO explícita (nunca silêncio)", () => {
    const path = ".claude/agents/algum-agent-novo-que-nao-existe.md";
    const check = evaluateAgentEvalTouch(
      [path],
      () => SAMPLE_MD("claude-sonnet-5", "antigo"),
      () => SAMPLE_MD("claude-sonnet-5", "novo"),
    );
    assert.deepEqual(check.triggeringAgents, []);
    assert.ok(check.infoLines.some((l) => l.includes("AVISO")));
  });

  it("múltiplos agents mapeados tocados: todos entram em triggeringAgents", () => {
    if (PROMPT_EVAL_AGENTS.length < 2) return; // guard: só roda se a #8143 mapear 2+
    const [a, b] = PROMPT_EVAL_AGENTS;
    const check = evaluateAgentEvalTouch(
      [`.claude/agents/${a}.md`, `.claude/agents/${b}.md`],
      () => SAMPLE_MD("claude-sonnet-5", "antigo"),
      () => SAMPLE_MD("claude-sonnet-5", "novo"),
    );
    assert.deepEqual(new Set(check.triggeringAgents), new Set([a, b]));
  });

  it("arquivo fora de .claude/agents/ com nome parecido não casa a regex", () => {
    const check = evaluateAgentEvalTouch([".claude/skills/diaria-edicao/SKILL.md"], () => null, () => null);
    assert.deepEqual(check.triggeringAgents, []);
  });
});

describe("AGENT_EVAL_LABEL (#8144)", () => {
  it("é o literal usado como convenção de label no GitHub (documentação viva)", () => {
    assert.equal(AGENT_EVAL_LABEL, "agent-eval:passed");
  });
});

// ---------------------------------------------------------------------------
// getPrLabelsWithRetry: mesmo padrão de check-editorial-signoff.test.ts
// (#7978) — cada check-*.ts mantém sua PRÓPRIA cópia da função de retry
// (mesma convenção deste repo, ver docstring do script), então a cobertura
// é duplicada de propósito, não um gap.
// ---------------------------------------------------------------------------

describe("getPrLabelsWithRetry (#8144)", () => {
  const noopSleep = async (_ms: number): Promise<void> => {};

  it("retry 2×fail→pass: retorna labels na 3ª tentativa sem lançar", async () => {
    let callCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      if (callCount < 3) return { status: 1, stdout: "", stderr: "HTTP 401: Requires authentication" };
      return { status: 0, stdout: "agent-eval:passed\nP2\n", stderr: "" };
    };
    const labels = await getPrLabelsWithRetry("42", mockSpawn, noopSleep, 3);
    assert.equal(callCount, 3);
    assert.deepEqual(labels, ["agent-eval:passed", "P2"]);
  });

  it("esgota todas as tentativas: lança mensagem INFRA distinta", async () => {
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => ({ status: 1, stdout: "", stderr: "HTTP 500" });
    await assert.rejects(() => getPrLabelsWithRetry("42", mockSpawn, noopSleep, 3), /INFRA.*3 tentativas.*HTTP 500/s);
  });

  it("labels vazias: array vazio, não array com strings vazias", async () => {
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => ({ status: 0, stdout: "\n\n", stderr: "" });
    const labels = await getPrLabelsWithRetry("42", mockSpawn, noopSleep, 1);
    assert.deepEqual(labels, []);
  });
});
