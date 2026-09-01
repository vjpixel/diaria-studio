#!/usr/bin/env npx tsx
/**
 * check-glm-lane-gate.ts (#6930)
 *
 * CLI do gate de critérios de morte/teto do piloto GLM — ver
 * `scripts/lib/glm-lane-gate.ts` pra lógica pura. Lê `data/glm-lane/
 * units.jsonl` (uma unidade por linha, formato de
 * `scripts/record-glm-lane-unit.ts`), computa o estado agregado e decide
 * se o PRÓXIMO despacho pode acontecer.
 *
 * Uso:
 *   npx tsx scripts/check-glm-lane-gate.ts --units-log data/glm-lane/units.jsonl \
 *     --units-cap 10 [--sonnet-cost-per-issue 1.23]
 *
 * Exit codes: 0 = autorizado a despachar; 1 = recusado (teto ou critério
 * de morte); 2 = uso inválido/arquivo ilegível. Arquivo AUSENTE não é
 * erro — 0 unidades despachadas é o estado inicial legítimo do piloto.
 */

import { readFileSync, existsSync } from "node:fs";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { computeGlmLaneState, evaluateGlmLaneGate, type GlmLaneUnitRecord } from "./lib/glm-lane-gate.ts";

/** Lê e parseia o JSONL — linha malformada é IGNORADA (loga em stderr),
 *  nunca derruba a leitura das demais; arquivo ausente = lista vazia. */
export function readGlmLaneUnits(path: string): GlmLaneUnitRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const records: GlmLaneUnitRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as GlmLaneUnitRecord);
    } catch {
      console.error(`[check-glm-lane-gate] linha malformada ignorada: ${trimmed.slice(0, 200)}`);
    }
  }
  return records;
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const unitsLogPath = values["units-log"];
  const unitsCapRaw = values["units-cap"];
  const sonnetCostRaw = values["sonnet-cost-per-issue"];

  if (!unitsLogPath || !unitsCapRaw || !Number.isFinite(Number(unitsCapRaw))) {
    console.error("[check-glm-lane-gate] uso: --units-log PATH --units-cap N [--sonnet-cost-per-issue USD]");
    process.exit(2);
  }

  const records = readGlmLaneUnits(unitsLogPath);
  const state = computeGlmLaneState(records, {
    unitsCap: Number(unitsCapRaw),
    sonnetLaneCostPerIssueUsd: sonnetCostRaw ? Number(sonnetCostRaw) : null,
  });
  const verdict = evaluateGlmLaneGate(state);

  console.log(`[check-glm-lane-gate] unidades=${state.unitsDispatched}/${state.unitsCap} allow=${verdict.allow} — ${verdict.reason}`);
  process.exit(verdict.allow ? 0 : 1);
}
