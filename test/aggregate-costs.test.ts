import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCostMd,
  aggregateCosts,
  formatSummary,
} from "../scripts/aggregate-costs.ts";

const SAMPLE_COST = `# Cost — Edição 260424

Orchestrator: claude-opus-4-7
Início: 2026-04-24T10:00:00Z
Fim: 2026-04-24T14:00:00Z
Total de chamadas: 28

| Stage | Início | Fim | Chamadas | Haiku | Sonnet |
|-------|--------|-----|----------|-------|--------|
| 0 | 10:00 | 10:05 | refresh_dedup:1 | 0 | 0 |
| 1 | 10:05 | 10:45 | source_researcher:10, discovery:5, categorizer:1 | 16 | 0 |
| 2 | 10:45 | 11:15 | writer:1, clarice:3 | 0 | 1 |
| 3 | 11:15 | 11:30 | social_linkedin:1, social_facebook:1 | 2 | 0 |
| 4 | 11:30 | 12:00 | eai_composer:1 | 1 | 0 |
| 5 | 12:00 | 13:00 | publish_newsletter:1 | 0 | 1 |
| 6 | 13:00 | 14:00 | publish_social:1 | 0 | 1 |
`;

describe("parseCostMd", () => {
  it("parseia tabela com colunas Stage/Chamadas/Haiku/Sonnet", () => {
    const stages = parseCostMd(SAMPLE_COST);
    assert.equal(stages.length, 7);
    const s1 = stages.find((s) => s.stage === "1");
    assert.ok(s1);
    assert.equal(s1!.haiku, 16);
    assert.equal(s1!.sonnet, 0);
    // calls = 10 + 5 + 1 = 16
    assert.equal(s1!.calls, 16);
  });

  it("soma números em 'agent:N, agent:N' na coluna Chamadas", () => {
    const stages = parseCostMd(SAMPLE_COST);
    const s2 = stages.find((s) => s.stage === "2");
    assert.equal(s2!.calls, 4); // writer:1 + clarice:3
  });

  it("lida com número puro em Chamadas (sem :)", () => {
    const md = `| Stage | Chamadas | Haiku | Sonnet |
|---|---|---|---|
| X | 7 | 0 | 0 |
`;
    const stages = parseCostMd(md);
    assert.equal(stages[0].calls, 7);
  });

  it("parseia coluna Opus quando presente", () => {
    const md = `| Stage | Chamadas | Haiku | Sonnet | Opus |
|---|---|---|---|---|
| 1 | 5 | 2 | 1 | 1 |
`;
    const stages = parseCostMd(md);
    assert.equal(stages[0].opus, 1);
  });

  it("retorna vazio se não achar header", () => {
    assert.equal(parseCostMd("# Only heading, no table").length, 0);
  });

  it("ignora linhas não-data entre separador e next section", () => {
    const md = `| Stage | Chamadas | Haiku | Sonnet |
|---|---|---|---|
| 1 | 5 | 2 | 0 |

## Outras seções que não são tabela
`;
    const stages = parseCostMd(md);
    assert.equal(stages.length, 1);
  });
});

describe("aggregateCosts — integração", () => {
  function setup(): { root: string; editionsDir: string } {
    const root = mkdtempSync(join(tmpdir(), "diaria-cost-"));
    const editionsDir = join(root, "data/editions");
    mkdirSync(editionsDir, { recursive: true });
    return { root, editionsDir };
  }

  function addEdition(editionsDir: string, name: string, md: string): void {
    const dir = join(editionsDir, name, "_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cost.md"), md);
  }

  it("agrega 3 edições e soma totais", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260421", SAMPLE_COST);
      addEdition(editionsDir, "260422", SAMPLE_COST);
      addEdition(editionsDir, "260423", SAMPLE_COST);

      const result = aggregateCosts({ editionsDir });
      assert.equal(result.length, 3);
      // Cada edição tem 19 haiku (16+0+2+1+0+0+0 = wait let me recount)
      // Stage 0: 0, 1: 16, 2: 0, 3: 2, 4: 1, 5: 0, 6: 0 = 19
      assert.equal(result[0].totals.haiku, 19);
      // Sonnet: 0+0+1+0+0+1+1 = 3
      assert.equal(result[0].totals.sonnet, 3);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("filtra por since/until", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260410", SAMPLE_COST);
      addEdition(editionsDir, "260415", SAMPLE_COST);
      addEdition(editionsDir, "260420", SAMPLE_COST);

      const result = aggregateCosts({
        editionsDir,
        since: "260415",
        until: "260419",
      });
      assert.equal(result.length, 1);
      assert.equal(result[0].edition, "260415");
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("ignora edições sem cost.md", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260421", SAMPLE_COST);
      // 260422 sem cost.md (só _internal/)
      mkdirSync(join(editionsDir, "260422/_internal"), { recursive: true });

      const result = aggregateCosts({ editionsDir });
      assert.equal(result.length, 1);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("ignora diretórios non-AAMMDD", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260421", SAMPLE_COST);
      mkdirSync(join(editionsDir, "archive"), { recursive: true });

      const result = aggregateCosts({ editionsDir });
      assert.equal(result.length, 1);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("edições retornadas em ordem crescente", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260423", SAMPLE_COST);
      addEdition(editionsDir, "260421", SAMPLE_COST);
      addEdition(editionsDir, "260422", SAMPLE_COST);

      const result = aggregateCosts({ editionsDir });
      assert.deepEqual(
        result.map((e) => e.edition),
        ["260421", "260422", "260423"],
      );
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });
});

describe("formatSummary", () => {
  it("renderiza resumo completo com 2 edições", () => {
    const editions = [
      {
        edition: "260421",
        month: "2604",
        stages: [{ stage: "1", calls: 10, haiku: 5, sonnet: 0, opus: 0 }],
        totals: { calls: 10, haiku: 5, sonnet: 0, opus: 0 },
      },
      {
        edition: "260422",
        month: "2604",
        stages: [{ stage: "1", calls: 8, haiku: 4, sonnet: 0, opus: 0 }],
        totals: { calls: 8, haiku: 4, sonnet: 0, opus: 0 },
      },
    ];
    const out = formatSummary(editions, new Date("2026-04-24T12:00:00Z"));
    assert.ok(out.includes("Edições agregadas: 2"));
    assert.ok(out.includes("| 2604 | 2 | 18 | 9 | 0 | 0 |"));
    assert.ok(out.includes("Top 5 edições"));
    assert.ok(out.includes("1. 260421 — 10 chamadas"));
  });

  it("handle vazio sem crash", () => {
    const out = formatSummary([], new Date("2026-04-24T12:00:00Z"));
    assert.ok(out.includes("Edições agregadas: 0"));
    assert.ok(out.includes("Nenhuma edição"));
  });
});
