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
 * pelo teto (default 0). `exit 1` se a onda estoura o teto (enforcement
 * mecânico); `exit 2` em uso inválido.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { appendWave, buildWaveRecord } from "./lib/overnight-waves.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  if (!values.plan || !values.units) {
    console.error('[record-overnight-wave] uso: --plan {path} --units "8290,8291;8300" [--deferred N]');
    process.exit(2);
  }
  if (!existsSync(values.plan)) {
    console.error(`[record-overnight-wave] plan.json não encontrado: ${values.plan}`);
    process.exit(2);
  }
  const units = values.units.split(";").map((u) => u.split(",").map((n) => Number(n.trim())));
  let record;
  try {
    record = buildWaveRecord({ units, deferred: values.deferred ? Number(values.deferred) : 0 });
  } catch (e) {
    console.error(`[record-overnight-wave] ${(e as Error).message}`);
    process.exit(1);
  }
  const plan = JSON.parse(readFileSync(values.plan, "utf8"));
  writeFileSync(values.plan, JSON.stringify(appendWave(plan, record), null, 2) + "\n");
  console.log(
    `[record-overnight-wave] onda registrada: ${record.unit_count} unidade(s), cap_hit=${record.cap_hit}`,
  );
}
