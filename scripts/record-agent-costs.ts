#!/usr/bin/env npx tsx
/**
 * record-agent-costs.ts (#3748, PLURAL — mesmo padrão de `record-source-runs.ts`)
 *
 * Registra N dispatches de subagente (`Agent`) em batch e persiste em
 * `{EDITION_DIR}/_internal/cost.json`. O orchestrator acumula um JSON array
 * com o resultado de cada dispatch de um mesmo stage (à medida que os
 * dispatches retornam) e chama este script UMA vez ao final do stage — não
 * uma invocação por dispatch (custo de tokens do próprio orchestrator).
 *
 * Uso:
 *   npx tsx scripts/record-agent-costs.ts \
 *     --edition-dir data/editions/260423 \
 *     --edition 260423 \
 *     --stage 1 \
 *     --costs data/editions/260423/_internal/tmp-agent-costs-stage1.json
 *
 * Schema de `--costs` (array; cada entry aceita 2 formas de reportar usage):
 *   [
 *     { "agent_type": "source-researcher", "subagent_tokens": 115201, "tool_uses": 33, "duration_ms": 259892 },
 *     { "agent_type": "discovery-searcher", "usage_raw": "<usage><subagent_tokens>88012</subagent_tokens><tool_uses>20</tool_uses><duration_ms>154002</duration_ms></usage>" }
 *   ]
 * `stage` por entry é opcional — se ausente, usa o `--stage` da CLI (mesmo
 * fallback de `--edition` em `record-source-runs.ts`). `usage_raw`, se
 * presente, é parseado via `parseUsageBlock` — mais robusto para o
 * orchestrator (LLM) do que extrair os 3 números manualmente antes de montar
 * o JSON. Se `usage_raw` estiver ausente, os 3 campos numéricos são
 * obrigatórios.
 *
 * Output: JSON do artefato final (`cost.json`) — inclui `aggregate` para o
 * orchestrator citar no relatório do gate sem precisar reabrir o arquivo.
 */

import { readFileSync } from "node:fs";
import {
  parseUsageBlock,
  writeCostArtifact,
  type AgentCostEntry,
} from "./lib/edition-cost.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

interface CostBatchInputEntry {
  stage?: number;
  agent_type: string;
  usage_raw?: string;
  subagent_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const editionDir = values["edition-dir"];
  const edition = values.edition;
  const defaultStageRaw = values.stage;
  const costsPath = values.costs;

  if (!editionDir || !edition || !costsPath) {
    console.error(
      "Uso: record-agent-costs.ts --edition-dir <dir> --edition AAMMDD --costs <file.json> [--stage N]",
    );
    process.exit(1);
  }

  let input: CostBatchInputEntry[];
  try {
    input = JSON.parse(readFileSync(costsPath, "utf8"));
  } catch (e) {
    console.error(`Erro lendo ${costsPath}: ${(e as Error).message}`);
    process.exit(1);
  }
  if (!Array.isArray(input)) {
    console.error("Input de --costs deve ser um array JSON.");
    process.exit(1);
  }

  const defaultStage = defaultStageRaw !== undefined ? Number(defaultStageRaw) : undefined;
  const recordedAt = new Date().toISOString();
  const entries: AgentCostEntry[] = [];

  for (const [i, raw] of input.entries()) {
    if (!raw.agent_type || typeof raw.agent_type !== "string") {
      console.error(`[error] entry ${i}: agent_type ausente/inválido`);
      process.exit(1);
    }
    const stage = raw.stage ?? defaultStage;
    if (stage === undefined || Number.isNaN(stage)) {
      console.error(`[error] entry ${i} (${raw.agent_type}): stage ausente e --stage não passado`);
      process.exit(1);
    }

    let usage: { subagent_tokens: number; tool_uses: number; duration_ms: number } | null;
    if (raw.usage_raw) {
      usage = parseUsageBlock(raw.usage_raw);
      if (!usage) {
        console.error(`[error] entry ${i} (${raw.agent_type}): usage_raw não casou com o formato <usage>...</usage>`);
        process.exit(1);
      }
    } else if (
      typeof raw.subagent_tokens === "number" &&
      typeof raw.tool_uses === "number" &&
      typeof raw.duration_ms === "number"
    ) {
      usage = {
        subagent_tokens: raw.subagent_tokens,
        tool_uses: raw.tool_uses,
        duration_ms: raw.duration_ms,
      };
    } else {
      console.error(
        `[error] entry ${i} (${raw.agent_type}): precisa de usage_raw OU {subagent_tokens,tool_uses,duration_ms} numéricos`,
      );
      process.exit(1);
    }

    entries.push({
      stage,
      agent_type: raw.agent_type,
      subagent_tokens: usage.subagent_tokens,
      tool_uses: usage.tool_uses,
      duration_ms: usage.duration_ms,
      recorded_at: recordedAt,
    });
  }

  const artifact = writeCostArtifact(editionDir, edition, entries);
  console.log(JSON.stringify(artifact, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
