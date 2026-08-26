/**
 * develop-plan-collision.ts (#6265, generalizado no #6328)
 *
 * **Wrapper fino, específico do `/diaria-develop`, sobre o miolo genérico em
 * `scripts/lib/plan-path-resolution.ts`** — o #6328 portou este mecanismo
 * pro `/diaria-overnight` (`scripts/resolve-overnight-plan-path.ts`) e
 * extraiu a lógica pura pro módulo compartilhado. Este arquivo preserva os
 * nomes ORIGINAIS que têm consumidor real (`DevelopPlanProbeResult`,
 * `DevelopPlanProbe`, `ResolvedDevelopPlanPath`, `resolveDevelopPlanPath`)
 * — mesmo contrato de saída, nenhuma mudança de comportamento observável —
 * porque `scripts/resolve-develop-plan-path.ts` e os testes já existentes
 * (`test/develop-plan-collision.test.ts`) importam daqui, e o
 * `/diaria-develop` está em produção agora, dependendo deste caminho.
 * **Exceção: `DevelopPlanResolveMode` NÃO foi preservado** — era usado só
 * internamente por este arquivo antes da extração, sem consumidor externo;
 * o knip (CI) confirmou isso como export morto pós-refactor, ver o
 * comentário junto ao import abaixo.
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
  type ResolvedPlanPath,
} from "./plan-path-resolution.ts";

/** Alias — mesmo tipo de `PlanPathProbeResult`, nome preservado do #6265. */
export type DevelopPlanProbeResult = PlanPathProbeResult;
/** Alias — mesmo tipo de `PlanPathProbe`, nome preservado do #6265. */
export type DevelopPlanProbe = PlanPathProbe;
/** Alias — mesmo tipo de `ResolvedPlanPath`, nome preservado do #6265. */
export type ResolvedDevelopPlanPath = ResolvedPlanPath;

// `DevelopPlanResolveMode` (alias de `PlanPathResolveMode`) foi removido no
// #6328 self-review — knip (CI) acusou como export não usado: em master,
// esse tipo era definido DENTRO deste arquivo e consumido pelas outras
// declarações locais (`ResolvedDevelopPlanPath.mode`, etc); pós-extração
// pro módulo genérico, o alias sobrou como puro re-export sem nenhum
// import em `scripts/`/`test/`/`.claude/` (confirmado via grep antes de
// remover). Se algum consumidor precisar do tipo do modo, importe
// `PlanPathResolveMode` direto de `./plan-path-resolution.ts` — não
// reintroduza este alias sem um consumidor real primeiro.

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
