#!/usr/bin/env npx tsx
/**
 * record-glm-lane-unit.ts (#6930)
 *
 * Anexa 1 registro em `data/glm-lane/units.jsonl` (formato lido por
 * `scripts/check-glm-lane-gate.ts`) ao final de uma unidade do piloto
 * GLM. Chamado por `scripts/dispatch-glm-lane-unit.sh`, nunca por uma
 * sessão interativa direto.
 *
 * `costUsd` é derivado dos DOIS snapshots de `scripts/glm-lane-credits.ts`
 * (JSON bruto, um por `--credits-before`/`--credits-after`) — `total_usage
 * depois - total_usage antes`. Se QUALQUER um dos dois snapshots veio com
 * `ok:false` (chave ausente, API fora do ar), `costUsd` é `null` — nunca
 * um `0` fabricado, que o gate (`glm-lane-gate.ts`) leria como "unidade
 * grátis" em vez de "não sei".
 *
 * Uso:
 *   npx tsx scripts/record-glm-lane-unit.ts \
 *     --units-log data/glm-lane/units.jsonl \
 *     --issue 6940 \
 *     --started-at 2026-09-01T15:00:00Z \
 *     --ended-at 2026-09-01T15:12:00Z \
 *     --duration-sec 720 \
 *     --credits-before '{"ok":true,"totalUsageUsd":10.5,...}' \
 *     --credits-after '{"ok":true,"totalUsageUsd":10.52,...}' \
 *     --pr-number 6941   # ou "" se nenhuma PR foi aberta
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import type { GlmLaneUnitRecord } from "./lib/glm-lane-gate.ts";
import type { OpenRouterCreditsSnapshot } from "./glm-lane-credits.ts";

/**
 * Deriva `costUsd` a partir de 2 snapshots já parseados — pura, sem I/O.
 * `null` se qualquer um dos dois não for `ok`, ou se o delta sair
 * negativo (créditos recarregados no meio da unidade invalidam a
 * comparação — melhor "não sei" que um número negativo sem sentido).
 */
export function computeUnitCostUsd(
  before: OpenRouterCreditsSnapshot,
  after: OpenRouterCreditsSnapshot,
): number | null {
  if (!before.ok || !after.ok) return null;
  if (typeof before.totalUsageUsd !== "number" || typeof after.totalUsageUsd !== "number") return null;
  const delta = after.totalUsageUsd - before.totalUsageUsd;
  if (delta < 0) return null;
  return delta;
}

/** Parseia um JSON de snapshot de crédito — string malformada vira
 *  `{ok:false}` (fail-soft), nunca lança. */
export function parseCreditsSnapshot(raw: string): OpenRouterCreditsSnapshot {
  try {
    const parsed = JSON.parse(raw) as Partial<OpenRouterCreditsSnapshot>;
    if (typeof parsed.ok !== "boolean") return { ok: false, warning: "campo ok ausente/não-booleano no snapshot" };
    return parsed as OpenRouterCreditsSnapshot;
  } catch {
    return { ok: false, warning: `JSON malformado: ${raw.slice(0, 200)}` };
  }
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const unitsLogPath = values["units-log"];
  const issueRaw = values.issue;
  const startedAt = values["started-at"];
  const endedAt = values["ended-at"];
  const durationSecRaw = values["duration-sec"];
  const creditsBeforeRaw = values["credits-before"];
  const creditsAfterRaw = values["credits-after"];
  const prNumberRaw = values["pr-number"];

  if (!unitsLogPath || !issueRaw || !startedAt || !endedAt) {
    console.error(
      "[record-glm-lane-unit] uso: --units-log PATH --issue N --started-at ISO --ended-at ISO [--duration-sec N] [--credits-before JSON] [--credits-after JSON] [--pr-number N]",
    );
    process.exit(2);
  }

  const before = creditsBeforeRaw ? parseCreditsSnapshot(creditsBeforeRaw) : { ok: false as const };
  const after = creditsAfterRaw ? parseCreditsSnapshot(creditsAfterRaw) : { ok: false as const };
  const costUsd = computeUnitCostUsd(before, after);

  const record: GlmLaneUnitRecord = {
    issue: Number(issueRaw),
    startedAt,
    endedAt,
    durationSec: durationSecRaw ? Number(durationSecRaw) : null,
    costUsd,
    prNumber: prNumberRaw && prNumberRaw.trim() !== "" ? Number(prNumberRaw) : null,
    reviewRounds: null, // preenchido depois, por um reconciliador separado (fora de escopo desta unidade)
  };

  mkdirSync(dirname(unitsLogPath), { recursive: true });
  appendFileSync(unitsLogPath, JSON.stringify(record) + "\n", "utf8");
  console.log(`[record-glm-lane-unit] registrado: ${JSON.stringify(record)}`);
}
