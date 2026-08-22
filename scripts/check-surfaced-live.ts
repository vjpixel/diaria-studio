#!/usr/bin/env npx tsx
/**
 * check-surfaced-live.ts (#5919)
 *
 * CLI para o gate mecânico de "surfacing ao vivo de bloqueio tipo-editor" no
 * `/diaria-develop` — ver `scripts/lib/surfaced-live-gate.ts` para a lógica
 * pura e o contrato completo. Este arquivo só lê o `plan.json`, imprime o
 * veredito por issue e sai com o código correspondente.
 *
 * Roda na Fase 2 do `/diaria-develop`, entre os gates de drift (#5892) e a
 * composição do relatório — `exit 1` impede `report.md` de ser escrito
 * enquanto houver entrada bloqueada sem registro explícito de `surfaced_live`
 * (o modo de falha real da #5919: em 260821c o #5878 ficou bloqueado tipo-2
 * sem surfacing ao vivo, só virou linha no relatório final, e a janela de
 * evidência fechou). Falha de leitura/parse do plan.json é erro DURO
 * (`exit 2`) — diferente dos gates irmãos que degradam sem rede (#738),
 * este gate não depende de rede nenhuma; plan.json ausente numa Fase 2 é
 * sessão malformada, não falha transitória.
 *
 * Uso:
 *   npx tsx scripts/check-surfaced-live.ts --plan data/develop/260822a/plan.json
 *   npx tsx scripts/check-surfaced-live.ts --edition 260822a
 *   npx tsx scripts/check-surfaced-live.ts            # run mais recente de data/develop/
 *   npx tsx scripts/check-surfaced-live.ts --strict   # false explícito também bloqueia
 *
 * @see scripts/lib/surfaced-live-gate.ts
 * @see scripts/check-trade-off-label-cleared.ts (padrão de estilo/gate irmão)
 * @see .claude/skills/diaria-develop/SKILL.md (Fase 2)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  SURFACED_LIVE_AT_FIELD,
  SURFACED_LIVE_FIELD,
  checkSurfacedLive,
  type SurfacedLiveIssueEntry,
} from "./lib/surfaced-live-gate.ts";

const DEVELOP_ROOT = "data/develop";

interface PlanFile {
  issues?: SurfacedLiveIssueEntry[] | null;
}

/** Resolve o caminho do plan.json a partir dos args (mesma precedência do docstring). */
function resolvePlanPath(values: Record<string, unknown>): string | null {
  const planRaw = values.plan;
  if (typeof planRaw === "string" && planRaw.length > 0) return planRaw;

  const edition = values.edition;
  if (typeof edition === "string" && edition.length > 0) {
    return join(DEVELOP_ROOT, edition, "plan.json");
  }

  if (!existsSync(DEVELOP_ROOT)) return null;
  const runs = readdirSync(DEVELOP_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(); // AAMMDD[+sufixo] ordena cronologicamente por prefixo
  for (let i = runs.length - 1; i >= 0; i--) {
    const candidate = join(DEVELOP_ROOT, runs[i]!, "plan.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function printFindings(
  findings: ReturnType<typeof checkSurfacedLive>["failures"],
  label: string,
): void {
  for (const f of findings) {
    const id = f.issue != null ? `#${f.issue}` : "(sem número)";
    console.error(`  [${label}] ${id}${f.status ? ` (${f.status})` : ""}: ${f.detail}`);
    console.error(`      bloqueio: ${f.what_unblocks}`);
  }
}

if (isMainModule(import.meta.url)) {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const strict = flags.has("strict");
  const planPath = resolvePlanPath(values);

  if (!planPath) {
    console.error("[check-surfaced-live] uso: --plan <path|data/develop/*/plan.json> | --edition AAMMDD [--strict]");
    process.exit(2);
  }
  if (!existsSync(planPath)) {
    console.error(`[check-surfaced-live] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  let entries: SurfacedLiveIssueEntry[] | null | undefined;
  try {
    const parsed = JSON.parse(readFileSync(planPath, "utf8")) as PlanFile;
    entries = parsed.issues ?? [];
  } catch (e) {
    console.error(`[check-surfaced-live] plan.json ilegível (${planPath}): ${(e as Error).message}`);
    process.exit(2);
  }

  const result = checkSurfacedLive(entries);

  console.log(
    `[check-surfaced-live] ${planPath}: ${result.blockedCount} bloqueio(s), ${result.okCount} surfaceado(s) ao vivo, ${result.falseCount} false explícito`,
  );

  printFindings(result.warnings, "warning");
  printFindings(result.failures, "FALHA");

  if (result.failures.length > 0) {
    console.error(
      `[check-surfaced-live] exit 1 — ${result.failures.length} bloqueio(s) sem registro explícito de '${SURFACED_LIVE_FIELD}'. ` +
        `Preencha true/false (+ '${SURFACED_LIVE_AT_FIELD}' quando true) no plan.json ANTES do relatório (#5919). ` +
        `Bloqueio descoberto agora? Surfaceie ao vivo primeiro (formato de 4 partes, #5727), depois registre.`,
    );
    process.exit(1);
  }

  if (strict && result.falseCount > 0) {
    console.error(
      `[check-surfaced-live] exit 1 (--strict) — ${result.falseCount} bloqueio(s) com '${SURFACED_LIVE_FIELD}=false'.`,
    );
    process.exit(1);
  }

  if (result.blockedCount === 0) {
    console.log("[check-surfaced-live] ok — nenhum bloqueio tipo-editor nesta rodada.");
  } else if (result.falseCount > 0) {
    console.warn(
      `[check-surfaced-live] ok com ressalva — os ${result.falseCount} 'false' acima DEVEM entrar na Seção de HANDOFF do relatório.`,
    );
  } else {
    console.log("[check-surfaced-live] ok.");
  }
  process.exit(0);
}
