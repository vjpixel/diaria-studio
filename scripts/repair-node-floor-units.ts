#!/usr/bin/env node
/**
 * scripts/repair-node-floor-units.ts (#7842, correção A)
 *
 * Aplica a correção A do #7842: reaponta as units `.service` já armadas em
 * `~/.config/systemd/user/` cujo `ExecStart=` roda um node abaixo do piso do
 * projeto (`node:sqlite`, ≥22.5 — `check-node-version.ts`) pro node já mais
 * usado entre as demais units OK na mesma máquina — consolidando pro menor
 * número de paths possível, sem inventar um path novo.
 *
 * Complementa `scripts/systemd-node-floor-guard.ts` (#7522, só DETECTA e
 * nunca escreve): este script é o passo que efetivamente ESCREVE o
 * `ExecStart=` corrigido — mas só sob `--apply` (default é dry-run, mesmo
 * padrão de `scripts/apex-cutover.ts`). **Nunca chama `systemctl`** — nem
 * em `--apply`: recarregar o daemon e reiniciar as units que estavam
 * falhando continua ação manual do editor, comando impresso no fim do
 * `--apply`.
 *
 * Fora de escopo (correção B do #7842): subir a versão do `/usr/bin/node`
 * do sistema em si — exige `sudo apt`/`nvm` de root, sem caminho sem
 * privilégio a partir de um `systemd --user`. Este script nunca toca
 * `/usr/bin/node`, só o `ExecStart=` das units que apontavam pra ele.
 *
 * Uso:
 *   npx tsx scripts/repair-node-floor-units.ts             # dry-run: imprime o plano
 *   npx tsx scripts/repair-node-floor-units.ts --apply      # escreve os .service corrigidos
 *
 * Exit codes: 0 = nada pra reparar (relatório já "ok") ou reparo aplicado
 * com sucesso; 1 = há units below-floor mas nenhum `targetNodePath`
 * resolvível (nenhuma unit "ok" no relatório pra servir de alvo — reparo
 * manual); 2 = relatório "cannot-verify" (diretório ausente/ilegível —
 * normal fora do `helios`, ex: worktree isolado, sessão cloud).
 */
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNodeVersionForPath, scanArmedUnitsNodeFloor } from "./lib/systemd-node-floor-guard.ts";
import { systemdUserUnitDir } from "./lib/systemd-unit-exit-guard.ts";
import { applyNodeFloorRepairs, planNodeFloorRepairs, type NodeFloorRepairPlan } from "./lib/repair-node-floor-units.ts";

const POST_APPLY_COMMAND = [
  "systemctl --user daemon-reload",
  "systemctl --user reset-failed",
  "# repita --now por unit que precisa voltar a rodar imediatamente, ex:",
  "# systemctl --user restart diaria-corrupted-names-weekly-check.service",
].join("\n");

export function formatPlan(plan: NodeFloorRepairPlan): string {
  const lines: string[] = [];
  if (plan.targetNodePath === null) {
    lines.push("Nenhum node-alvo resolvível (nenhuma unit \"ok\" no relatório) — reparo manual necessário.");
    if (plan.skipped.length > 0) {
      lines.push(`${plan.skipped.length} unit(s) below-floor sem alvo: ${plan.skipped.map((u) => u.unitFileName).join(", ")}`);
    }
    return lines.join("\n");
  }
  if (plan.repairs.length === 0) {
    lines.push("Nenhuma unit below-floor — nada a reparar.");
    return lines.join("\n");
  }
  lines.push(`Alvo (mais usado entre units "ok"): ${plan.targetNodePath}`);
  lines.push("");
  for (const r of plan.repairs) {
    lines.push(`  ${r.unitFileName}: ${r.oldNodePath} -> ${r.newNodePath}`);
  }
  if (plan.skipped.length > 0) {
    lines.push("");
    lines.push(`${plan.skipped.length} unit(s) below-floor NÃO incluída(s) no plano (conteúdo ilegível): ${plan.skipped.map((u) => u.unitFileName).join(", ")}`);
  }
  return lines.join("\n");
}

export function main(argv: string[]): number {
  const apply = hasFlag(argv, "apply");
  const dirAbs = systemdUserUnitDir();

  const report = scanArmedUnitsNodeFloor();
  if (report.verdict === "cannot-verify" && report.units.length === 0) {
    console.error(`veredito: cannot-verify — ${report.detail}`);
    return 2;
  }
  if (report.verdict === "ok") {
    console.log("veredito: ok — nenhuma unit node-based abaixo do piso. Nada a reparar.");
    return 0;
  }

  const plan = planNodeFloorRepairs(report, (unitFileName) => {
    try {
      return readFileSync(join(dirAbs, unitFileName), "utf8");
    } catch {
      return null;
    }
  });

  console.log(formatPlan(plan));

  if (plan.targetNodePath === null) {
    return 1;
  }
  if (plan.repairs.length === 0) {
    return 0;
  }

  if (!apply) {
    console.log("\nDRY-RUN — nada foi escrito. Passe --apply para aplicar.");
    return 0;
  }

  // Confirma que o alvo resolve de fato pra um node válido AGORA (não só no
  // momento em que o relatório foi lido) antes de escrever qualquer coisa —
  // evita reapontar 8 units pra um path que, por algum motivo, parou de
  // responder entre o scan e o apply.
  const targetVersion = resolveNodeVersionForPath(plan.targetNodePath);
  if (!targetVersion) {
    console.error(`\nAbortado: "${plan.targetNodePath}" não resolveu a versão (--version falhou) — nada foi escrito.`);
    return 1;
  }

  const written = applyNodeFloorRepairs(plan, dirAbs);
  console.log(`\n${written.length} unit(s) reapontada(s) para ${plan.targetNodePath} (${targetVersion}).`);
  console.log("\nPróximo passo (manual — este script nunca chama systemctl):");
  console.log(POST_APPLY_COMMAND);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
