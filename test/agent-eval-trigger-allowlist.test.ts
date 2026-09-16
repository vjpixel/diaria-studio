/**
 * test/agent-eval-trigger-allowlist.test.ts (#8144)
 *
 * Cobre scripts/lib/agent-eval-trigger-allowlist.ts:
 *   1. Classificação (mapped / excluded / unclassified).
 *   2. Decisão de gatilho (corpo vs frontmatter-não-model vs model:).
 *   3. Guard de drift: TODO `.claude/agents/*.md` real precisa estar
 *      classificado (nunca "unclassified") — é este teste, não uma
 *      promessa em prosa, que impede um agent novo de cair fora do
 *      gatilho por silêncio (mandato da issue #8144).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyAgentEvalEligibility,
  evaluateAgentEvalTrigger,
  extractAgentModelField,
  extractAgentBody,
  AGENT_EVAL_EXCLUDED_AGENTS,
  PROMPT_EVAL_AGENTS,
} from "../scripts/lib/agent-eval-trigger-allowlist.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SAMPLE_MD = ["---", "name: fake-agent", 'description: "faz coisa"', "model: claude-sonnet-5", "tools: Read, Write", "---", "", "Corpo do agent.", "Mais uma linha."].join("\n");

describe("classifyAgentEvalEligibility (#8144)", () => {
  it("agents em PROMPT_EVAL_AGENTS (#8143) classificam como mapped", () => {
    for (const agent of PROMPT_EVAL_AGENTS) {
      const v = classifyAgentEvalEligibility(agent);
      assert.equal(v.status, "mapped");
      if (v.status === "mapped") assert.equal(v.agent, agent);
    }
  });

  it("agent em AGENT_EVAL_EXCLUDED_AGENTS classifica como excluded com o motivo certo", () => {
    const sample = AGENT_EVAL_EXCLUDED_AGENTS[0];
    const v = classifyAgentEvalEligibility(sample.agent);
    assert.equal(v.status, "excluded");
    if (v.status === "excluded") assert.equal(v.reason, sample.reason);
  });

  it("agent totalmente desconhecido classifica como unclassified", () => {
    const v = classifyAgentEvalEligibility("agent-que-nunca-existiu-xyz");
    assert.equal(v.status, "unclassified");
  });

  it("mapped e excluded são conjuntos disjuntos — nenhum nome aparece nos dois", () => {
    const excludedNames = new Set(AGENT_EVAL_EXCLUDED_AGENTS.map((e) => e.agent));
    for (const mapped of PROMPT_EVAL_AGENTS) {
      assert.equal(excludedNames.has(mapped), false, `"${mapped}" está em PROMPT_EVAL_AGENTS E em AGENT_EVAL_EXCLUDED_AGENTS`);
    }
  });

  it("guard de drift (#8144, mandato 'nunca por silêncio'): todo .claude/agents/*.md real está classificado", () => {
    const agentsDir = join(ROOT, ".claude", "agents");
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    assert.ok(files.length > 0, "sanity: o diretório de agents não pode estar vazio, senão este teste não protege nada");

    const unclassified: string[] = [];
    for (const file of files) {
      const agentName = file.replace(/\.md$/, "");
      const v = classifyAgentEvalEligibility(agentName);
      if (v.status === "unclassified") unclassified.push(agentName);
    }
    assert.deepEqual(
      unclassified,
      [],
      `agent(s) novo(s) sem classificação em scripts/lib/agent-eval-trigger-allowlist.ts (nem PROMPT_EVAL_AGENTS, nem AGENT_EVAL_EXCLUDED_AGENTS): ${unclassified.join(", ")} — adicione a decisão (mapear ou excluir com motivo) antes de mergear.`,
    );
  });
});

describe("extractAgentModelField (#8144)", () => {
  it("extrai o valor de model: do frontmatter", () => {
    assert.equal(extractAgentModelField(SAMPLE_MD), "claude-sonnet-5");
  });

  it("content null devolve null", () => {
    assert.equal(extractAgentModelField(null), null);
  });

  it("sem frontmatter devolve null", () => {
    assert.equal(extractAgentModelField("só corpo, sem ---"), null);
  });

  it("sem campo model: no frontmatter devolve null", () => {
    const md = ["---", "name: x", "---", "corpo"].join("\n");
    assert.equal(extractAgentModelField(md), null);
  });

  it("valor entre aspas é destrinchado sem as aspas", () => {
    const md = ["---", 'model: "claude-haiku-4-5-20251001"', "---", "corpo"].join("\n");
    assert.equal(extractAgentModelField(md), "claude-haiku-4-5-20251001");
  });
});

describe("extractAgentBody (#8144)", () => {
  it("remove o frontmatter, mantém o corpo", () => {
    const body = extractAgentBody(SAMPLE_MD);
    assert.ok(body !== null);
    assert.ok(!body!.includes("model:"));
    assert.ok(body!.includes("Corpo do agent."));
  });

  it("content null devolve null", () => {
    assert.equal(extractAgentBody(null), null);
  });
});

describe("evaluateAgentEvalTrigger (#8144)", () => {
  const agent = PROMPT_EVAL_AGENTS[0];

  it("corpo idêntico, frontmatter idêntico: não dispara", () => {
    const v = evaluateAgentEvalTrigger(agent, SAMPLE_MD, SAMPLE_MD);
    assert.equal(v.triggers, false);
    assert.equal(v.bodyChanged, false);
    assert.equal(v.modelChanged, false);
  });

  it("só corpo mudou: dispara com bodyChanged=true", () => {
    const newMd = SAMPLE_MD.replace("Corpo do agent.", "Corpo do agent MUDOU.");
    const v = evaluateAgentEvalTrigger(agent, SAMPLE_MD, newMd);
    assert.equal(v.triggers, true);
    assert.equal(v.bodyChanged, true);
    assert.equal(v.modelChanged, false);
  });

  it("só description mudou (frontmatter não-model): não dispara", () => {
    const newMd = SAMPLE_MD.replace('description: "faz coisa"', 'description: "faz outra coisa"');
    const v = evaluateAgentEvalTrigger(agent, SAMPLE_MD, newMd);
    assert.equal(v.triggers, false);
    assert.equal(v.bodyChanged, false);
    assert.equal(v.modelChanged, false);
  });

  it("só tools: mudou (frontmatter não-model): não dispara", () => {
    const newMd = SAMPLE_MD.replace("tools: Read, Write", "tools: Read, Write, Bash");
    const v = evaluateAgentEvalTrigger(agent, SAMPLE_MD, newMd);
    assert.equal(v.triggers, false);
  });

  it("model: mudou (mesmo corpo): dispara com modelChanged=true", () => {
    const newMd = SAMPLE_MD.replace("model: claude-sonnet-5", "model: claude-opus-5");
    const v = evaluateAgentEvalTrigger(agent, SAMPLE_MD, newMd);
    assert.equal(v.triggers, true);
    assert.equal(v.bodyChanged, false);
    assert.equal(v.modelChanged, true);
    assert.match(v.reason, /model:/);
  });

  it("model: reordenado pra outra linha do frontmatter ainda é detectado (comparação por VALOR, não por número de linha)", () => {
    const reordered = ["---", "name: fake-agent", "model: claude-opus-5", 'description: "faz coisa"', "tools: Read, Write", "---", "", "Corpo do agent.", "Mais uma linha."].join("\n");
    const v = evaluateAgentEvalTrigger(agent, SAMPLE_MD, reordered);
    assert.equal(v.modelChanged, true);
    assert.equal(v.bodyChanged, false);
    assert.equal(v.triggers, true);
  });

  it("arquivo novo (oldContent null): sempre dispara", () => {
    const v = evaluateAgentEvalTrigger(agent, null, SAMPLE_MD);
    assert.equal(v.triggers, true);
    assert.equal(v.bodyChanged, true);
  });

  it("arquivo deletado (newContent null): sempre dispara", () => {
    const v = evaluateAgentEvalTrigger(agent, SAMPLE_MD, null);
    assert.equal(v.triggers, true);
    assert.equal(v.bodyChanged, true);
    assert.match(v.reason, /removido/);
  });

  it("corpo E model: mudaram juntos: os 2 flags ficam true", () => {
    const newMd = SAMPLE_MD.replace("model: claude-sonnet-5", "model: claude-opus-5").replace("Corpo do agent.", "Corpo NOVO.");
    const v = evaluateAgentEvalTrigger(agent, SAMPLE_MD, newMd);
    assert.equal(v.bodyChanged, true);
    assert.equal(v.modelChanged, true);
    assert.equal(v.triggers, true);
  });
});
