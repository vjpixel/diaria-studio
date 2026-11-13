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
 *   - Task `critical`: adquire o lease (`acquireSchedulerLease`).
 *
 * Papel da máquina: explícito pela flag `--failover-standby`, que só as
 * tasks `Diaria-Failover-*` geradas por `scripts/failover/neo-takeover.ts`
 * passam. Sem a flag, o papel é `300` (dono padrão). Hostname não decide nada:
 * renomear a máquina não pode inverter o fail-open/fail-closed. Defesa extra:
 * task `critical` no Windows SEM a flag é recusada (seria o Neo agindo como
 * dono padrão, fail-open).
 *
 * Exit codes da run que não roda:
 *   - 0: cedeu ao lease ativo da outra máquina (comportamento correto). No
 *     `300` a mensagem vai para stderr como WARN.
 *   - 1: fail-closed (KV/config ilegível no Neo, ou no `300` com o último
 *     lease conhecido do Neo), task fora do tier no Neo, Neo armado cedendo
 *     sem lease ativo do `300` (sem sinal de queda), `300` de pé cedendo a um
 *     lease do Neo que segue sendo renovado (o alarme de units `failed` pega),
 *     ou task `critical` no Windows sem `--failover-standby`.
 *
 * Kill switch, só no `300`: `DIARIA_FAILOVER_LEASE=off` pula o lease (age
 * como antes do #12982). No Neo a variável é ignorada: sem lease ele não age.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasFlag } from "../cli-args.ts";
import type { KvOps } from "../cloudflare-kv-rest.ts";
import { resolveOpsStateKvConfig, type OpsStateKvConfig } from "../diaria/short-related-kv.ts";
import { resolveFailoverTier, type ScheduledTaskDefinition } from "../scheduled-tasks.ts";
import {
  acquireSchedulerLease,
  PRIMARY_HOST,
  STANDBY_HOST,
  type FailoverHost,
  type LeaseKv,
  type LeaseMemory,
} from "./scheduler-lease.ts";

export const FAILOVER_STANDBY_FLAG = "failover-standby";

/** `platform.config.json` lido, com ausente e ilegível separados. */
export type PlatformConfigRead = { kind: "ok"; value: unknown } | { kind: "absent" } | { kind: "unreadable"; error: string };

export function readPlatformConfigFile(repoRootAbs: string): PlatformConfigRead {
  let raw: string;
  try {
    raw = readFileSync(join(repoRootAbs, "platform.config.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", error: (e as Error).message };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw) };
  } catch (e) {
    return { kind: "unreadable", error: `JSON inválido: ${(e as Error).message}` };
  }
}

/**
 * `.env` por baixo, ambiente por cima (como `loadProjectEnv`), mas valor
 * VAZIO do ambiente não apaga o do arquivo: unit systemd ou Task Scheduler
 * que exporta `CLOUDFLARE_ACCOUNT_ID=` não pode zerar a credencial do `.env`.
 */
export function mergeDotenvUnderEnv(
  dotenv: Record<string, string>,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...dotenv };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v.trim() === "") {
      if (!(k in out)) out[k] = v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export interface FailoverGateDeps {
  env: Record<string, string | undefined>;
  platformConfig: PlatformConfigRead;
  /** Fábrica do cliente KV (injetável em teste). */
  makeKv: (cfg: OpsStateKvConfig) => Pick<KvOps, "get" | "put">;
  now?: () => Date;
  /** Memória local do último lease lido (default em `run-task.ts`: arquivo da máquina). */
  memory?: LeaseMemory;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Espera da retomada do lease expirado do Neo (#12993); injetável em teste. */
  sleep?: (ms: number) => Promise<void>;
  /** Aviso que não muda a decisão (memória local ilegível, #12993). Default `console.error`. */
  warn?: (msg: string) => void;
}

export type GateLevel = "info" | "warn" | "error";

export type FailoverGateResult =
  | { proceed: true; message: string | null; level: GateLevel }
  | { proceed: false; code: number; message: string; level: GateLevel };

export function failoverRole(argv: readonly string[]): FailoverHost {
  return hasFlag([...argv], FAILOVER_STANDBY_FLAG) ? STANDBY_HOST : PRIMARY_HOST;
}

export async function runFailoverGate(
  def: Pick<ScheduledTaskDefinition, "name" | "failover">,
  self: FailoverHost,
  deps: FailoverGateDeps,
): Promise<FailoverGateResult> {
  const tier = resolveFailoverTier(def);
  const tag = `[failover ${self}] ${def.name}`;

  if (tier !== "critical") {
    if (self === STANDBY_HOST) {
      return {
        proceed: false,
        code: 1,
        level: "error",
        message: `${tag}: tier "${tier}" não roda no Neo (só "critical", #12982). Task registrada por engano no Task Scheduler?`,
      };
    }
    return { proceed: true, message: null, level: "info" };
  }

  if (self === PRIMARY_HOST && (deps.platform ?? process.platform) === "win32") {
    return {
      proceed: false,
      code: 1,
      level: "error",
      message:
        `${tag}: task critical no Windows sem --failover-standby. No Neo, só as tarefas Diaria-Failover-* ` +
        `(neo-takeover.ts --arm) rodam tasks critical; rodar como dono padrão (fail-open) duplicaria o 300.`,
    };
  }

  if (self === PRIMARY_HOST && (deps.env.DIARIA_FAILOVER_LEASE ?? "").trim().toLowerCase() === "off") {
    return { proceed: true, message: `${tag}: DIARIA_FAILOVER_LEASE=off, lease ignorado`, level: "warn" };
  }

  // Sem como ler o KV: o 300 é fail-open, salvo se o último lease conhecido era do Neo.
  const cannotRead = (what: string): FailoverGateResult => {
    if (self === STANDBY_HOST) return { proceed: false, code: 1, level: "error", message: `${tag}: ${what}; fail-closed no Neo, nada roda` };
    let last = null;
    try {
      last = deps.memory?.load() ?? null;
    } catch (e) {
      (deps.warn ?? ((m: string) => console.error(m)))(`${tag}: WARN memória local do lease ilegível (${(e as Error).message}); decide sem ela`);
      last = null;
    }
    if (last?.kind === "ok" && last.lease.host === STANDBY_HOST) {
      return {
        proceed: false,
        code: 1,
        level: "error",
        message: `${tag}: ${what}; o último lease lido nesta máquina (${last.seenAt}) era do Neo até ${last.lease.until}: fail-closed no 300 até ler o KV`,
      };
    }
    return { proceed: true, level: "warn", message: `${tag}: WARN ${what}; fail-open no 300 (dono padrão)` };
  };

  const pc = deps.platformConfig;
  if (pc.kind !== "ok") {
    return cannotRead(pc.kind === "absent" ? "platform.config.json ausente" : `platform.config.json ilegível (${pc.error})`);
  }
  const cfg = resolveOpsStateKvConfig(pc.value, deps.env);
  if (!cfg.ok) return cannotRead(`configuração do KV ausente (${cfg.missing.join(", ")})`);

  let kv: LeaseKv;
  try {
    kv = deps.makeKv(cfg.config);
  } catch (e) {
    return cannotRead(`cliente KV não montou (${(e as Error).message})`);
  }

  const res = await acquireSchedulerLease(kv, { self, by: def.name, now: deps.now, memory: deps.memory, sleep: deps.sleep, warn: deps.warn });
  const msg = `${tag}: ${res.reason}`;
  switch (res.outcome) {
    case "act":
      return { proceed: true, message: msg, level: res.warning ? "warn" : "info" };
    case "fail-closed":
      return { proceed: false, code: 1, level: "error", message: msg };
    case "yield":
      if (res.cause === "other-host-renewing") return { proceed: false, code: 1, level: "error", message: msg };
      if (res.cause === "no-down-signal") {
        return { proceed: false, code: 1, level: "error", message: `${msg}. Neo armado sem lease: rode neo-takeover.ts --arm de novo (ou --disarm)` };
      }
      // Lease ativo da outra máquina: ceder é o correto. No 300 é WARN (ele está
      // de pé e parado); no Neo também vai para stderr (o 300 voltou).
      return { proceed: false, code: 0, level: "warn", message: `${msg}` };
  }
}
