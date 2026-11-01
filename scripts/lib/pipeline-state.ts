/**
 * pipeline-state.ts (#780) — sentinel de conclusão por stage da pipeline.
 *
 * Sentinel path: {editionDir}/_internal/.step-{N}-done.json
 *
 * Nunca lança exceção — retorna resultados estruturados para que o CLI
 * decida o exit code. Logging é responsabilidade do caller.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface StepSentinel {
  step: number;
  completed_at: string;
  outputs: string[]; // relative paths from editionDir
  /**
   * sha256 (hex) do conteúdo de cada output no instante do write (#11698).
   * Liga o sentinel ao conteúdo aprovado: com `data/` sincronizado por
   * OneDrive, o sentinel pode chegar a outro host antes da versão nova dos
   * outputs, e só o hash distingue "versão aprovada" de "cópia pré-gate".
   * Output inexistente ou que não é arquivo fica fora do mapa. Consequência
   * da ausência (`scripts/lib/stage5-freshness.ts`): no sentinel do Stage 4
   * gravado antes de `OUTPUT_HASHES_REQUIRED_SINCE` a Etapa 5 segue com aviso
   * (conteúdo não conferido); depois do corte, sentinel sem hash ou arquivo
   * fora do mapa trava a Etapa 5 (`no_hash`) até o Stage 4 regravar o sentinel.
   */
  output_hashes?: Record<string, string>;
}

/** sha256 hex de um conteúdo. Fonte única do hash de `output_hashes` (#11698). */
export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Hashes dos outputs que existem como arquivo (os demais ficam fora). */
export function computeOutputHashes(editionDir: string, outputs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of outputs) {
    const p = resolve(editionDir, rel);
    try {
      if (existsSync(p) && statSync(p).isFile()) out[rel] = sha256Hex(readFileSync(p));
    } catch (e) {
      // Arquivo sumindo no meio do sync: fica sem hash (o consumidor trata a
      // ausência como `no_hash`); o sentinel continua sendo gravado.
      console.warn(`[pipeline-state] hash de ${p} não calculado: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
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
    output_hashes: computeOutputHashes(editionDir, outputs),
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

/**
 * #2416 (+ sibling): resolve `sentinel.completed_at` para um epoch ms seguro
 * para usar como `nowMs`/`end` ao reparar stage-status.
 *
 * `new Date(malformed).getTime()` retorna NaN, que propaga para
 * `new Date(NaN).toISOString()` (em autoUpdateStageStatusOnSentinel) e lança
 * RangeError engolido por try/catch → no-op silencioso (stage nunca flipado
 * para done, sem warning). Este helper detecta o NaN e cai para `Date.now()`
 * emitindo um warn — o reparo ainda roda e o problema fica visível nos logs.
 *
 * Centraliza o guard que antes era duplicado em pipeline-sentinel.ts (#2416)
 * e backfill-stage-status.ts (sibling) — ambos operam sobre o mesmo
 * StepSentinel. `label` identifica o caller no warn (ex.: "pipeline-sentinel"
 * ou "backfill stage 3 (260619)").
 */
export function resolveSentinelEndMs(
  sentinel: StepSentinel,
  label: string,
): number {
  const t = new Date(sentinel.completed_at).getTime();
  if (Number.isNaN(t)) {
    console.warn(
      `[${label}] sentinel tem completed_at malformado="${sentinel.completed_at}" — caindo para Date.now() no reparo de stage-status`,
    );
    return Date.now();
  }
  return t;
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
