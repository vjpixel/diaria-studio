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
