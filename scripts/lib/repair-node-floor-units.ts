/**
 * scripts/lib/repair-node-floor-units.ts (#7842, correção A)
 *
 * `scripts/lib/systemd-node-floor-guard.ts` (#7522) já DETECTA units já
 * armados em `~/.config/systemd/user/` cujo `ExecStart=` roda um node
 * abaixo do piso (`check-node-version.ts`), e imprime um comando de reparo
 * MANUAL (regenerar via `setup-systemd-timers.ts` + `cp` + `daemon-reload`)
 * — mas nunca escreve nada, por desenho (docstring de `scanArmedUnitsNodeFloor`).
 *
 * Este módulo é o passo seguinte: dado o relatório de `scanArmedUnitsNodeFloor`,
 * calcula um PLANO de reparo — pra cada unit `below-floor`, qual o novo
 * `ExecStart=` (reapontando só o path do binário `node`, preservando todo o
 * resto da linha) — e o CLI (`scripts/repair-node-floor-units.ts`) o aplica
 * quando chamado com `--apply`.
 *
 * O path de substituição nunca é hardcoded: é derivado do PRÓPRIO relatório,
 * escolhendo o `nodePath` mais usado entre as units já `"ok"` (maioria em
 * uso na máquina — #7842 preferiu explicitamente "consolidar pro menor
 * número de paths possível" a inventar um path novo). Se não houver nenhuma
 * unit `"ok"` no relatório (ex: relatório fabricado só com below-floor, ou
 * máquina sem nenhum node válido armado ainda), o plano fica sem alvo e o
 * chamador decide (CLI aborta com mensagem clara — nunca adivinha um path).
 *
 * **Este módulo só ESCREVE o conteúdo do `.service` em disco quando o CLI
 * roda com `--apply` — nunca chama `systemctl` (nem `daemon-reload`,
 * `reset-failed`, `restart`).** Recarregar o daemon e reiniciar as units que
 * estavam falhando continua ação manual (mesmo padrão de todo
 * `docs/*-setup.md` deste repo e do próprio `systemd-node-floor-guard.ts`)
 * — o CLI imprime o comando pronto no fim do `--apply`.
 *
 * Fora de escopo (correção B do #7842): subir `/usr/bin/node` em si (exige
 * `sudo apt`, sem caminho sem privilégio) — este módulo nunca toca
 * `/usr/bin/node`, só o `ExecStart=` das units que apontavam pra ele.
 *
 * @see scripts/lib/systemd-node-floor-guard.ts (detecção — fonte do relatório)
 * @see scripts/repair-node-floor-units.ts (CLI que consome isto)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SystemdUnitsNodeFloorReport, UnitNodeFloorResult } from "./systemd-node-floor-guard.ts";

export interface UnitRepair {
  unitFileName: string;
  oldNodePath: string;
  newNodePath: string;
}

export interface NodeFloorRepairPlan {
  /** `null` quando não há nenhum `nodePath` "ok" no relatório pra servir de alvo — nada é reparável. */
  targetNodePath: string | null;
  repairs: UnitRepair[];
  /** Units `below-floor` que não puderam entrar no plano (ex: sem `targetNodePath`). */
  skipped: UnitNodeFloorResult[];
}

/**
 * Escolhe o path de node pra usar como alvo do reparo: o `nodePath` mais
 * frequente entre as units `"ok"` do relatório. Empate resolvido por ordem
 * alfabética do path (determinístico, sem depender de ordem de iteração).
 * Pura — não toca filesystem nem executa nada.
 */
export function pickTargetNodePath(report: SystemdUnitsNodeFloorReport): string | null {
  const counts = new Map<string, number>();
  for (const unit of report.units) {
    if (unit.verdict === "ok" && unit.nodePath) {
      counts.set(unit.nodePath, (counts.get(unit.nodePath) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  let best: string | null = null;
  let bestCount = -1;
  for (const [path, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > bestCount) {
      best = path;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Reaponta o `ExecStart=` de `serviceContent` pra `newNodePath`, trocando
 * SÓ o primeiro token (o binário) e preservando o resto da linha (flags,
 * `--import tsx`, path do script, args) inalterado. Pura.
 *
 * Lança se não encontrar uma linha `ExecStart=` reconhecível — chamador
 * (`planNodeFloorRepairs`) já filtra pra units com `nodePath` conhecido
 * (extraído do mesmo jeito por `systemd-node-floor-guard.ts`), então isso
 * só dispara em uso indevido direto da função.
 */
export function repointExecStartNodePath(serviceContent: string, newNodePath: string): string {
  const usesCrlf = serviceContent.includes("\r\n");
  const lines = serviceContent.split(/\r?\n/);
  let found = false;
  const nextLines = lines.map((line) => {
    const match = /^(\s*ExecStart\s*=\s*)(\S+)(.*)$/.exec(line);
    if (!match) return line;
    found = true;
    return `${match[1]}${newNodePath}${match[3]}`;
  });
  if (!found) {
    throw new Error("ExecStart= não encontrado — serviceContent não é um unit .service válido");
  }
  return nextLines.join(usesCrlf ? "\r\n" : "\n");
}

/**
 * Monta o plano de reparo a partir do relatório de `scanArmedUnitsNodeFloor`
 * + o conteúdo real de cada unit `below-floor` (lido pelo chamador — este
 * módulo fica puro, sem `readFileSync` embutido na função de planejamento).
 * Units cujo conteúdo não foi fornecido, ou sem `targetNodePath` resolvível,
 * caem em `skipped`.
 */
export function planNodeFloorRepairs(
  report: SystemdUnitsNodeFloorReport,
  readServiceContent: (unitFileName: string) => string | null,
): NodeFloorRepairPlan {
  const targetNodePath = pickTargetNodePath(report);
  const belowFloor = report.units.filter((u) => u.verdict === "below-floor");

  if (!targetNodePath) {
    return { targetNodePath: null, repairs: [], skipped: belowFloor };
  }

  const repairs: UnitRepair[] = [];
  const skipped: UnitNodeFloorResult[] = [];
  for (const unit of belowFloor) {
    if (!unit.nodePath) {
      skipped.push(unit);
      continue;
    }
    const content = readServiceContent(unit.unitFileName);
    if (content === null) {
      skipped.push(unit);
      continue;
    }
    repairs.push({ unitFileName: unit.unitFileName, oldNodePath: unit.nodePath, newNodePath: targetNodePath });
  }

  return { targetNodePath, repairs, skipped };
}

/**
 * Aplica o plano em disco: para cada `UnitRepair`, lê o `.service` de
 * `dirAbs`, reaponta o `ExecStart=` via `repointExecStartNodePath`, e
 * regrava o arquivo. **Muta o filesystem** — só o CLI chama isto, e só sob
 * `--apply` (ver docstring do módulo). Nunca chama `systemctl`.
 *
 * Retorna a lista de units efetivamente escritas (mesma ordem do plano).
 */
export function applyNodeFloorRepairs(plan: NodeFloorRepairPlan, dirAbs: string): string[] {
  const written: string[] = [];
  for (const repair of plan.repairs) {
    const path = join(dirAbs, repair.unitFileName);
    const content = readFileSync(path, "utf8");
    const nextContent = repointExecStartNodePath(content, repair.newNodePath);
    writeFileSync(path, nextContent, "utf8");
    written.push(repair.unitFileName);
  }
  return written;
}
