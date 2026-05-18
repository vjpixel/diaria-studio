/**
 * pipeline-state.ts (#780) — sentinel de conclusão por stage da pipeline.
 *
 * Sentinel path: {editionDir}/_internal/.step-{N}-done.json
 *
 * Nunca lança exceção — retorna resultados estruturados para que o CLI
 * decida o exit code. Logging é responsabilidade do caller.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface StepSentinel {
  step: number;
  completed_at: string;
  outputs: string[]; // relative paths from editionDir
}

export type AssertResult =
  | { ok: true }
  | { ok: false; reason: "sentinel_missing" }
  | { ok: false; reason: "outputs_missing"; missingOutputs: string[] };

function sentinelPath(editionDir: string, step: number): string {
  return resolve(editionDir, "_internal", `.step-${step}-done.json`);
}

export function writeSentinel(
  editionDir: string,
  step: number,
  outputs: string[],
): void {
  const internalDir = resolve(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const sentinel: StepSentinel = {
    step,
    completed_at: new Date().toISOString(),
    outputs,
  };
  writeFileSync(sentinelPath(editionDir, step), JSON.stringify(sentinel, null, 2) + "\n", "utf8");
}

export function sentinelExists(editionDir: string, step: number): boolean {
  return existsSync(sentinelPath(editionDir, step));
}

export function readSentinel(editionDir: string, step: number): StepSentinel | null {
  const p = sentinelPath(editionDir, step);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StepSentinel;
  } catch {
    return null;
  }
}

export function assertSentinel(editionDir: string, step: number): AssertResult {
  const sentinel = readSentinel(editionDir, step);
  if (sentinel === null) {
    return { ok: false, reason: "sentinel_missing" };
  }
  const missing = sentinel.outputs.filter(
    (rel) => !existsSync(resolve(editionDir, rel)),
  );
  if (missing.length > 0) {
    return { ok: false, reason: "outputs_missing", missingOutputs: missing };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sub-step markers (#1330)
//
// Markers são sentinels mais granulares que cobrem sub-steps dentro de um
// stage (ex: Stage 1 tem 1h `inject-inbox-urls`, 1i `verify-accessibility`).
// Sentinels de step inteiro (1, 2, 3, 4) continuam existindo pra gate
// approval — markers cobrem invariantes intra-stage.
//
// Path: `{editionDir}/_internal/.marker-{name}.json` — name kebab-case.
//
// Caso 260518 (#594 recorrente): orchestrator pulou step 1h. Marker permite
// asserção determinística no início de step 1j (dedup) — sem marker, halt.
// ---------------------------------------------------------------------------

export interface SubStepMarker {
  name: string;
  completed_at: string;
  details?: Record<string, unknown>;
}

function markerPath(editionDir: string, name: string): string {
  // Validar name pra evitar path traversal (`../`, `/`, etc).
  if (!/^[a-z0-9-]+$/i.test(name)) {
    throw new Error(`Invalid marker name: ${name}. Use only [a-z0-9-].`);
  }
  return resolve(editionDir, "_internal", `.marker-${name}.json`);
}

export function writeMarker(
  editionDir: string,
  name: string,
  details?: Record<string, unknown>,
): void {
  const internalDir = resolve(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const marker: SubStepMarker = {
    name,
    completed_at: new Date().toISOString(),
    ...(details && { details }),
  };
  writeFileSync(markerPath(editionDir, name), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

export function markerExists(editionDir: string, name: string): boolean {
  return existsSync(markerPath(editionDir, name));
}

export function readMarker(editionDir: string, name: string): SubStepMarker | null {
  const p = markerPath(editionDir, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SubStepMarker;
  } catch {
    return null;
  }
}

export function assertMarker(editionDir: string, name: string): { ok: boolean; reason?: string } {
  if (markerExists(editionDir, name)) return { ok: true };
  return { ok: false, reason: "marker_missing" };
}
