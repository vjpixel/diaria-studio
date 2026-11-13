/**
 * scripts/lib/failover/task-gate.ts (#12982)
 *
 * Gate de failover no ponto de entrada comum das tasks agendadas
 * (`scripts/run-task.ts`, que tanto os units systemd do `300` quanto as tasks
 * `Diaria-Failover-*` do Task Scheduler do Neo invocam). Fica aqui, e não em
 * cada script, para que nenhuma task `critical` dependa de lembrar de chamar o
 * lease.
 *
 *   - Task que não é `critical`: passa direto no `300`, sem tocar o KV. No
 *     Neo (`--failover-standby`) é recusada: o Neo só roda o tier `critical`.
 *   - Task `critical`: adquire o lease (`acquireSchedulerLease`). Cede (exit
 *     0, nada roda) quando a posse é da outra máquina.
 *
 * Papel da máquina: explícito pela flag `--failover-standby`, que só as
 * tasks `Diaria-Failover-*` geradas por `scripts/failover/neo-takeover.ts`
 * passam. Sem a flag, o papel é `300` (dono padrão). Hostname não decide nada:
 * renomear a máquina não pode inverter o fail-open/fail-closed.
 *
 * Kill switch, só no `300`: `DIARIA_FAILOVER_LEASE=off` pula o lease (age
 * como antes do #12982). No Neo a variável é ignorada: sem lease ele não age.
 */

import { hasFlag } from "../cli-args.ts";
import type { KvOps } from "../cloudflare-kv-rest.ts";
import { resolveOpsStateKvConfig, type OpsStateKvConfig } from "../diaria/short-related-kv.ts";
import { resolveFailoverTier, type ScheduledTaskDefinition } from "../scheduled-tasks.ts";
import { acquireSchedulerLease, PRIMARY_HOST, STANDBY_HOST, type FailoverHost, type LeaseKv } from "./scheduler-lease.ts";

export const FAILOVER_STANDBY_FLAG = "failover-standby";

export interface FailoverGateDeps {
  env: Record<string, string | undefined>;
  /** Conteúdo de `platform.config.json` (já parseado) ou `null` se ilegível. */
  platformConfig: unknown;
  /** Fábrica do cliente KV (injetável em teste). */
  makeKv: (cfg: OpsStateKvConfig) => Pick<KvOps, "get" | "put">;
  now?: () => Date;
}

export type FailoverGateResult =
  | { proceed: true; message: string | null }
  | { proceed: false; code: number; message: string };

export function failoverRole(argv: readonly string[]): FailoverHost {
  return hasFlag([...argv], FAILOVER_STANDBY_FLAG) ? STANDBY_HOST : PRIMARY_HOST;
}

export async function runFailoverGate(
  def: Pick<ScheduledTaskDefinition, "name" | "failover">,
  argv: readonly string[],
  deps: FailoverGateDeps,
): Promise<FailoverGateResult> {
  const self = failoverRole(argv);
  const tier = resolveFailoverTier(def);
  const tag = `[failover ${self}] ${def.name}`;

  if (tier !== "critical") {
    if (self === STANDBY_HOST) {
      return {
        proceed: false,
        code: 1,
        message: `${tag}: tier "${tier}" não roda no Neo (só "critical", #12982). Task registrada por engano no Task Scheduler?`,
      };
    }
    return { proceed: true, message: null };
  }

  if (self === PRIMARY_HOST && (deps.env.DIARIA_FAILOVER_LEASE ?? "").trim().toLowerCase() === "off") {
    return { proceed: true, message: `${tag}: DIARIA_FAILOVER_LEASE=off, lease ignorado` };
  }

  const cfg = resolveOpsStateKvConfig(deps.platformConfig, deps.env);
  if (!cfg.ok) {
    const what = `configuração do KV ausente (${cfg.missing.join(", ")})`;
    return self === PRIMARY_HOST
      ? { proceed: true, message: `${tag}: ${what}; fail-open no 300 (dono padrão)` }
      : { proceed: false, code: 1, message: `${tag}: ${what}; fail-closed no Neo, nada roda` };
  }

  let kv: LeaseKv;
  try {
    kv = deps.makeKv(cfg.config);
  } catch (e) {
    const what = `cliente KV não montou (${(e as Error).message})`;
    return self === PRIMARY_HOST
      ? { proceed: true, message: `${tag}: ${what}; fail-open no 300` }
      : { proceed: false, code: 1, message: `${tag}: ${what}; fail-closed no Neo` };
  }

  const res = await acquireSchedulerLease(kv, { self, by: def.name, now: deps.now });
  if (res.act) return { proceed: true, message: `${tag}: ${res.reason}` };
  return { proceed: false, code: res.outcome === "fail-closed" ? 1 : 0, message: `${tag}: ${res.reason}` };
}
