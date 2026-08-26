/**
 * develop-plan-collision.ts (#6265, generalizado no #6328)
 *
 * **Wrapper fino, específico do `/diaria-develop`, sobre o miolo genérico em
 * `scripts/lib/plan-path-resolution.ts`** — o #6328 portou este mecanismo
 * pro `/diaria-overnight` (`scripts/resolve-overnight-plan-path.ts`) e
 * extraiu a lógica pura pro módulo compartilhado. Este arquivo preserva os
 * nomes ORIGINAIS (`DevelopPlanProbeResult`, `resolveDevelopPlanPath`, etc)
 * — mesmo contrato de saída, nenhuma mudança de comportamento observável —
 * porque `scripts/resolve-develop-plan-path.ts` e os testes já existentes
 * (`test/develop-plan-collision.test.ts`) importam daqui, e o
 * `/diaria-develop` está em produção agora, dependendo deste caminho.
 *
 * Documentação completa do mecanismo (racional de desenho, edge cases,
 * decisão de não usar lock, escopo cross-máquina): ver o docblock de
 * `scripts/lib/plan-path-resolution.ts`.
 *
 * @see scripts/lib/plan-path-resolution.ts (miolo puro, compartilhado)
 * @see scripts/resolve-develop-plan-path.ts (CLI/entrypoint)
 * @see scripts/resolve-overnight-plan-path.ts (CLI irmão, #6328)
 * @see scripts/overnight-statusline.ts (`isForeignDevelopPlan`, já lê `session_id`)
 * @see scripts/lib/session-registry.ts (`data/sessions/*.json`, fonte de `session_id` real)
 * @see .claude/skills/diaria-develop/SKILL.md
 */

import {
  resolvePlanPath,
  type PlanPathProbe,
  type PlanPathProbeResult,
  type PlanPathResolveMode,
  type ResolvedPlanPath,
} from "./plan-path-resolution.ts";

/** Alias — mesmo tipo de `PlanPathProbeResult`, nome preservado do #6265. */
export type DevelopPlanProbeResult = PlanPathProbeResult;
/** Alias — mesmo tipo de `PlanPathProbe`, nome preservado do #6265. */
export type DevelopPlanProbe = PlanPathProbe;
/** Alias — mesmo tipo de `PlanPathResolveMode`, nome preservado do #6265. */
export type DevelopPlanResolveMode = PlanPathResolveMode;
/** Alias — mesmo tipo de `ResolvedPlanPath`, nome preservado do #6265. */
export type ResolvedDevelopPlanPath = ResolvedPlanPath;

/**
 * Wrapper fino sobre `resolvePlanPath` — mesma assinatura/contrato de saída
 * de antes do #6328 (a lógica em si não mudou, só foi extraída pro módulo
 * compartilhado). Ver `resolvePlanPath` para a documentação do algoritmo.
 */
export function resolveDevelopPlanPath(
  baseDir: string,
  aammdd: string,
  sessionId: string,
  probe: DevelopPlanProbe,
): ResolvedDevelopPlanPath {
  return resolvePlanPath(baseDir, aammdd, sessionId, probe);
}
