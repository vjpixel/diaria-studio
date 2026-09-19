#!/usr/bin/env npx tsx
/**
 * record-overnight-wave.ts (#8486)
 *
 * Grava a onda recém-composta do `/diaria-overnight` em `plan.waves[]` —
 * ver `scripts/lib/overnight-waves.ts`. Chamado no passo 2 da Fase 1, no
 * mesmo ponto do `heartbeat --active-worktrees`.
 *
 * `--units "8290,8291;8300"` — unidades despachadas (`;` separa unidades,
 * `,` separa issues do lote). `--deferred N` — unidades prontas seguradas
 * pelo teto (default 0; valor não-numérico ou flag sem valor = exit 2, nunca
 * `cap_hit` falso-negativo silencioso).
 *
 * Exit: 0 = gravado; 1 = onda inválida (acima do teto, issue repetida,
 * unidade malformada); 2 = uso inválido / plan.json ausente ou ilegível.
 * Escrita atômica (`writeFileAtomic`) — `plan.json` é a única fonte confiável
 * do briefing após compaction, nunca pode ficar truncado.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { appendWave, buildWaveRecord, checkOvernightWaves } from "./lib/overnight-waves.ts";

const INT = /^\d+$/;

/** Pure: `"8290,8291;8300"` → `[[8290,8291],[8300]]`; lança em token que não é inteiro decimal. */
export function parseUnits(raw: string): number[][] {
  return raw.split(";").map((unit) =>
    unit.split(",").map((tok) => {
      const t = tok.trim();
      if (!INT.test(t)) throw new Error(`--units: token inválido "${t}" (esperado inteiro decimal)`);
      return Number(t);
    }),
  );
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const usage = '[record-overnight-wave] uso: --plan {path} --units "8290,8291;8300" [--deferred N]';
  if (!values.plan || !values.units) {
    console.error(usage);
    process.exit(2);
  }
  if (!existsSync(values.plan)) {
    console.error(`[record-overnight-wave] plan.json não encontrado: ${values.plan}`);
    process.exit(2);
  }
  // parseArgs descarta a flag sem valor em silêncio — checar o argv cru.
  if (process.argv.includes("--deferred") && !(typeof values.deferred === "string" && INT.test(values.deferred))) {
    console.error(`[record-overnight-wave] --deferred exige inteiro não-negativo (recebido: ${JSON.stringify(values.deferred)})`);
    process.exit(2);
  }

  let plan: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(values.plan, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("raiz não é um objeto");
    }
    plan = parsed as Record<string, unknown>;
  } catch (e) {
    console.error(`[record-overnight-wave] plan.json ilegível: ${(e as Error).message}`);
    process.exit(2);
  }

  let record;
  try {
    const units = parseUnits(values.units);
    const all = units.flat();
    if (new Set(all).size !== all.length) throw new Error("issue repetida entre/dentro das unidades da onda");
    record = buildWaveRecord({ units, deferred: values.deferred ? Number(values.deferred) : 0 });
  } catch (e) {
    console.error(`[record-overnight-wave] ${(e as Error).message}`);
    process.exit(1);
  }

  const next = appendWave(plan, record);
  const check = checkOvernightWaves(next);
  if (check.status === "invalid") {
    console.error(`[record-overnight-wave] plan.waves existente inválido, nada gravado: ${check.problems.join("; ")}`);
    process.exit(1);
  }
  writeFileAtomic(values.plan, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `[record-overnight-wave] onda registrada: ${record.unit_count} unidade(s), cap_hit=${record.cap_hit}`,
  );
}
