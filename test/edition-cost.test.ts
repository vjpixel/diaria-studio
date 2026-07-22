import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseUsageBlock,
  recordAgentCost,
  aggregateCostByStage,
  buildCostArtifact,
  parseCostArtifact,
  serializeCostArtifact,
  mergeCostEntries,
  readCostArtifactFromDisk,
  writeCostArtifact,
  COST_ARTIFACT_SCOPE_NOTE,
  type AgentCostEntry,
} from "../scripts/lib/edition-cost.ts";

function mkEditionDir(): string {
  return mkdtempSync(join(tmpdir(), "diaria-cost-"));
}

describe("parseUsageBlock (#3748)", () => {
  it("parseia o bloco <usage> exato observado ao vivo num task-notification", () => {
    const raw =
      "<usage><subagent_tokens>115201</subagent_tokens><tool_uses>33</tool_uses><duration_ms>259892</duration_ms></usage>";
    const usage = parseUsageBlock(raw);
    assert.deepEqual(usage, {
      subagent_tokens: 115201,
      tool_uses: 33,
      duration_ms: 259892,
    });
  });

  it("parseia mesmo com texto ao redor (resultado de dispatch tem mais conteúdo antes/depois)", () => {
    const raw =
      "Resumo do subagente...\n\n<usage><subagent_tokens>500</subagent_tokens><tool_uses>2</tool_uses><duration_ms>1000</duration_ms></usage>\n";
    assert.deepEqual(parseUsageBlock(raw), {
      subagent_tokens: 500,
      tool_uses: 2,
      duration_ms: 1000,
    });
  });

  it("parseia com espaçamento/quebra de linha entre as tags", () => {
    const raw = `<usage>
      <subagent_tokens>42</subagent_tokens>
      <tool_uses>1</tool_uses>
      <duration_ms>99</duration_ms>
    </usage>`;
    assert.deepEqual(parseUsageBlock(raw), {
      subagent_tokens: 42,
      tool_uses: 1,
      duration_ms: 99,
    });
  });

  it("retorna null quando o bloco <usage> está ausente", () => {
    assert.equal(parseUsageBlock("nenhum bloco de usage aqui"), null);
  });

  it("retorna null quando falta uma das 3 tags (malformado)", () => {
    const raw = "<usage><subagent_tokens>100</subagent_tokens><tool_uses>1</tool_uses></usage>";
    assert.equal(parseUsageBlock(raw), null);
  });

  it("retorna null para string vazia — nunca lança", () => {
    assert.equal(parseUsageBlock(""), null);
  });
});

describe("recordAgentCost (#3748)", () => {
  it("anexa entrada sem mutar o array original (imutável)", () => {
    const original: AgentCostEntry[] = [];
    const usage = { subagent_tokens: 100, tool_uses: 5, duration_ms: 1000 };
    const next = recordAgentCost(original, 1, "source-researcher", usage, "2026-07-21T10:00:00.000Z");
    assert.equal(original.length, 0, "array original não deve ser mutado");
    assert.equal(next.length, 1);
    assert.deepEqual(next[0], {
      stage: 1,
      agent_type: "source-researcher",
      subagent_tokens: 100,
      tool_uses: 5,
      duration_ms: 1000,
      recorded_at: "2026-07-21T10:00:00.000Z",
    });
  });

  it("acumula múltiplas chamadas encadeadas", () => {
    let entries: AgentCostEntry[] = [];
    entries = recordAgentCost(entries, 1, "source-researcher", { subagent_tokens: 10, tool_uses: 1, duration_ms: 100 });
    entries = recordAgentCost(entries, 1, "discovery-searcher", { subagent_tokens: 20, tool_uses: 2, duration_ms: 200 });
    entries = recordAgentCost(entries, 2, "writer-destaque", { subagent_tokens: 30, tool_uses: 3, duration_ms: 300 });
    assert.equal(entries.length, 3);
  });

  it("lança em stage inválido (negativo/NaN) — sinal de bug no caller", () => {
    assert.throws(() => recordAgentCost([], -1, "x", { subagent_tokens: 1, tool_uses: 1, duration_ms: 1 }));
    assert.throws(() => recordAgentCost([], NaN, "x", { subagent_tokens: 1, tool_uses: 1, duration_ms: 1 }));
  });

  it("lança em agentType vazio/inválido", () => {
    assert.throws(() => recordAgentCost([], 1, "", { subagent_tokens: 1, tool_uses: 1, duration_ms: 1 }));
  });
});

describe("aggregateCostByStage (#3748)", () => {
  it("agrega por stage + agent_type e soma o overall", () => {
    const entries: AgentCostEntry[] = [
      { stage: 1, agent_type: "source-researcher", subagent_tokens: 100, tool_uses: 5, duration_ms: 1000, recorded_at: "t1" },
      { stage: 1, agent_type: "source-researcher", subagent_tokens: 200, tool_uses: 10, duration_ms: 2000, recorded_at: "t2" },
      { stage: 1, agent_type: "discovery-searcher", subagent_tokens: 50, tool_uses: 2, duration_ms: 500, recorded_at: "t3" },
      { stage: 2, agent_type: "writer-destaque", subagent_tokens: 300, tool_uses: 15, duration_ms: 3000, recorded_at: "t4" },
    ];
    const agg = aggregateCostByStage(entries);

    const stage1 = agg.by_stage["1"];
    assert.ok(stage1);
    const researcher = stage1.find((a) => a.agent_type === "source-researcher");
    assert.deepEqual(researcher, {
      agent_type: "source-researcher",
      dispatch_count: 2,
      subagent_tokens: 300,
      tool_uses: 15,
      duration_ms: 3000,
    });
    const discovery = stage1.find((a) => a.agent_type === "discovery-searcher");
    assert.deepEqual(discovery, {
      agent_type: "discovery-searcher",
      dispatch_count: 1,
      subagent_tokens: 50,
      tool_uses: 2,
      duration_ms: 500,
    });

    const stage2 = agg.by_stage["2"];
    assert.equal(stage2.length, 1);
    assert.equal(stage2[0].agent_type, "writer-destaque");

    assert.deepEqual(agg.overall, {
      dispatch_count: 4,
      subagent_tokens: 650,
      tool_uses: 32,
      duration_ms: 6500,
    });
  });

  it("array vazio → aggregate vazio, sem lançar", () => {
    const agg = aggregateCostByStage([]);
    assert.deepEqual(agg.by_stage, {});
    assert.deepEqual(agg.overall, { dispatch_count: 0, subagent_tokens: 0, tool_uses: 0, duration_ms: 0 });
  });

  it("ordena agent_types dentro do stage por subagent_tokens desc", () => {
    const entries: AgentCostEntry[] = [
      { stage: 1, agent_type: "cheap", subagent_tokens: 10, tool_uses: 1, duration_ms: 1, recorded_at: "t" },
      { stage: 1, agent_type: "expensive", subagent_tokens: 999, tool_uses: 1, duration_ms: 1, recorded_at: "t" },
    ];
    const agg = aggregateCostByStage(entries);
    assert.deepEqual(
      agg.by_stage["1"].map((a) => a.agent_type),
      ["expensive", "cheap"],
    );
  });
});

describe("buildCostArtifact (#3748)", () => {
  it("inclui scope_note explícito sobre não cobrir o coordenador", () => {
    const artifact = buildCostArtifact("260423", []);
    assert.equal(artifact.scope_note, COST_ARTIFACT_SCOPE_NOTE);
    assert.match(artifact.scope_note, /NÃO\s+inclui o custo do orchestrator\/coordenador/);
    assert.equal(artifact.edition, "260423");
    assert.equal(artifact.schema_version, 1);
  });

  it("aggregate reflete as entries passadas", () => {
    const entries: AgentCostEntry[] = [
      { stage: 1, agent_type: "source-researcher", subagent_tokens: 100, tool_uses: 5, duration_ms: 1000, recorded_at: "t" },
    ];
    const artifact = buildCostArtifact("260423", entries);
    assert.equal(artifact.aggregate.overall.subagent_tokens, 100);
  });
});

describe("serializeCostArtifact + parseCostArtifact — round-trip (#3748)", () => {
  it("serializa e reparseia sem perda", () => {
    const artifact = buildCostArtifact("260423", [
      { stage: 1, agent_type: "source-researcher", subagent_tokens: 100, tool_uses: 5, duration_ms: 1000, recorded_at: "t" },
    ]);
    const serialized = serializeCostArtifact(artifact);
    const reparsed = parseCostArtifact(serialized);
    assert.deepEqual(reparsed, artifact);
  });

  it("parseCostArtifact retorna null para JSON inválido — nunca lança", () => {
    assert.equal(parseCostArtifact("{ isso não é json"), null);
  });

  it("parseCostArtifact retorna null quando 'entries' não é array (shape errada)", () => {
    assert.equal(parseCostArtifact(JSON.stringify({ edition: "260423" })), null);
  });
});

describe("mergeCostEntries (#3748)", () => {
  it("sem artefato existente → retorna só as novas entries", () => {
    const newEntries: AgentCostEntry[] = [
      { stage: 1, agent_type: "x", subagent_tokens: 1, tool_uses: 1, duration_ms: 1, recorded_at: "t" },
    ];
    assert.deepEqual(mergeCostEntries(null, newEntries), newEntries);
  });

  it("com artefato existente → concatena (acumula entre stages, não sobrescreve)", () => {
    const existing = buildCostArtifact("260423", [
      { stage: 1, agent_type: "source-researcher", subagent_tokens: 100, tool_uses: 5, duration_ms: 1000, recorded_at: "t1" },
    ]);
    const newEntries: AgentCostEntry[] = [
      { stage: 2, agent_type: "writer-destaque", subagent_tokens: 200, tool_uses: 10, duration_ms: 2000, recorded_at: "t2" },
    ];
    const merged = mergeCostEntries(existing, newEntries);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].stage, 1);
    assert.equal(merged[1].stage, 2);
  });

  it("não deduplica — 2 dispatches do mesmo agent_type no mesmo stage ficam como 2 entries (retries custam tokens reais)", () => {
    const existing = buildCostArtifact("260423", [
      { stage: 1, agent_type: "source-researcher", subagent_tokens: 100, tool_uses: 5, duration_ms: 1000, recorded_at: "t1" },
    ]);
    const merged = mergeCostEntries(existing, [
      { stage: 1, agent_type: "source-researcher", subagent_tokens: 50, tool_uses: 2, duration_ms: 500, recorded_at: "t2" },
    ]);
    assert.equal(merged.length, 2);
  });
});

describe("writeCostArtifact + readCostArtifactFromDisk — I/O (#3748)", () => {
  it("readCostArtifactFromDisk → null quando cost.json ainda não existe", () => {
    const dir = mkEditionDir();
    try {
      assert.equal(readCostArtifactFromDisk(dir), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("writeCostArtifact cria _internal/ e persiste em cost.json", () => {
    const dir = mkEditionDir();
    try {
      const entries: AgentCostEntry[] = [
        { stage: 1, agent_type: "source-researcher", subagent_tokens: 100, tool_uses: 5, duration_ms: 1000, recorded_at: "t1" },
      ];
      const artifact = writeCostArtifact(dir, "260423", entries);
      assert.equal(artifact.aggregate.overall.dispatch_count, 1);

      const reread = readCostArtifactFromDisk(dir);
      assert.ok(reread);
      assert.equal(reread!.edition, "260423");
      assert.equal(reread!.entries.length, 1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("2 chamadas sucessivas (simulando 2 stages) ACUMULAM no mesmo cost.json, não sobrescrevem", () => {
    const dir = mkEditionDir();
    try {
      writeCostArtifact(dir, "260423", [
        { stage: 1, agent_type: "source-researcher", subagent_tokens: 100, tool_uses: 5, duration_ms: 1000, recorded_at: "t1" },
      ]);
      const second = writeCostArtifact(dir, "260423", [
        { stage: 2, agent_type: "writer-destaque", subagent_tokens: 200, tool_uses: 10, duration_ms: 2000, recorded_at: "t2" },
      ]);

      assert.equal(second.entries.length, 2);
      assert.equal(second.aggregate.overall.subagent_tokens, 300);
      assert.ok(second.aggregate.by_stage["1"]);
      assert.ok(second.aggregate.by_stage["2"]);

      // Confirma persistência real em disco, não só o retorno em memória.
      const onDisk = readCostArtifactFromDisk(dir);
      assert.equal(onDisk!.entries.length, 2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("readCostArtifactFromDisk retorna null (fail-soft) se cost.json estiver corrompido", () => {
    const dir = mkEditionDir();
    try {
      writeCostArtifact(dir, "260423", [
        { stage: 1, agent_type: "x", subagent_tokens: 1, tool_uses: 1, duration_ms: 1, recorded_at: "t" },
      ]);
      // Corromper o arquivo diretamente.
      writeFileSync(join(dir, "_internal", "cost.json"), "{ not valid json", "utf8");
      assert.equal(readCostArtifactFromDisk(dir), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
