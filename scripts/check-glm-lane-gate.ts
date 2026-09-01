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
 * de morte); 2 = uso de CLI inválido (flag ausente/não-numérica). Arquivo
 * `units.jsonl` AUSENTE não é erro — 0 unidades despachadas é o estado
 * inicial legítimo do piloto. Uma linha do arquivo malformada/com shape
 * inválido também não é erro de CLI — é IGNORADA e contada em
 * `malformedCount` (ver `readGlmLaneUnits`), nunca vira `exit 2`.
 */

import { readFileSync, existsSync } from "node:fs";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { computeGlmLaneState, evaluateGlmLaneGate, type GlmLaneUnitRecord } from "./lib/glm-lane-gate.ts";

/**
 * Type guard de shape — não só "é JSON válido" (achado de review, PR
 * #6941, confirmado por 2 agentes independentes): um objeto
 * sintaticamente válido mas com campo AUSENTE (`{}`, um registro de
 * schema antigo/futuro, uma linha truncada por conflito de sync do
 * OneDrive que ainda parseia) tinha `campo === undefined`, e
 * `undefined !== null` é `true` — um `prNumber` ausente contava como "tem
 * PR" em `computeGlmLaneState`, invertendo exatamente o critério de morte
 * 2 que existe pra pegar "zero PRs". Este guard fecha isso na LEITURA,
 * antes do dado alcançar a lógica pura.
 */
function isValidUnitRecord(value: unknown): value is GlmLaneUnitRecord {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.issue === "number" &&
    typeof o.startedAt === "string" &&
    (o.endedAt === null || typeof o.endedAt === "string") &&
    (o.durationSec === null || typeof o.durationSec === "number") &&
    (o.costUsd === null || typeof o.costUsd === "number") &&
    (o.prNumber === null || typeof o.prNumber === "number") &&
    (o.reviewRounds === null || typeof o.reviewRounds === "number") &&
    (o.status === "completed" || o.status === "infra-error")
  );
}

export interface ReadGlmLaneUnitsResult {
  records: GlmLaneUnitRecord[];
  /** Linhas descartadas por JSON inválido OU shape inválido — surfaçado
   *  separado (não só um log perdido em stderr, achado de review P2):
   *  um `units.jsonl` corrompido silenciosamente subcontava
   *  `unitsDispatched`, deixando o teto de 10 unidades andar pra sempre
   *  contra um denominador errado. */
  malformedCount: number;
}

/** Lê e valida o JSONL — linha malformada (JSON inválido OU shape
 *  inválido) é IGNORADA e contada em `malformedCount`, nunca derruba a
 *  leitura das demais; arquivo ausente = lista vazia, `malformedCount=0`. */
export function readGlmLaneUnits(path: string): ReadGlmLaneUnitsResult {
  if (!existsSync(path)) return { records: [], malformedCount: 0 };
  const raw = readFileSync(path, "utf8");
  const records: GlmLaneUnitRecord[] = [];
  let malformedCount = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.error(`[check-glm-lane-gate] linha malformada (JSON inválido) ignorada: ${trimmed.slice(0, 200)}`);
      malformedCount++;
      continue;
    }
    if (!isValidUnitRecord(parsed)) {
      console.error(`[check-glm-lane-gate] linha com shape inválido ignorada: ${trimmed.slice(0, 200)}`);
      malformedCount++;
      continue;
    }
    records.push(parsed);
  }
  return { records, malformedCount };
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
  // #6941 (P3): --sonnet-cost-per-issue não validado virava NaN — nunca
  // `null`, então "não configurada" (correto: critério inerte) e "valor
  // inválido" (deveria ser erro de uso) colapsavam no mesmo resultado
  // silencioso (NaN > x é sempre false, o critério nunca dispara, sem
  // aviso de que o valor passado era lixo).
  if (sonnetCostRaw !== undefined && !Number.isFinite(Number(sonnetCostRaw))) {
    console.error(`[check-glm-lane-gate] --sonnet-cost-per-issue precisa ser numérico, recebido: ${sonnetCostRaw}`);
    process.exit(2);
  }

  const { records, malformedCount } = readGlmLaneUnits(unitsLogPath);
  const state = computeGlmLaneState(records, {
    unitsCap: Number(unitsCapRaw),
    sonnetLaneCostPerIssueUsd: sonnetCostRaw ? Number(sonnetCostRaw) : null,
  });
  const verdict = evaluateGlmLaneGate(state);

  const malformedNote = malformedCount > 0 ? ` malformadas=${malformedCount}` : "";
  console.log(
    `[check-glm-lane-gate] unidades=${state.unitsDispatched}/${state.unitsCap}${malformedNote} allow=${verdict.allow} — ${verdict.reason}`,
  );
  process.exit(verdict.allow ? 0 : 1);
}
