#!/usr/bin/env node
/**
 * scripts/failover/neo-takeover.ts (#12982)
 *
 * Contingência do `300` no Neo: exceção TEMPORÁRIA e explícita à política do
 * #5074 (nenhuma task `Diaria-*` roda no Windows). Enquanto o `300` está fora,
 * o Neo roda só as tasks `failover: "critical"` do registro, como tarefas
 * `Diaria-Failover-*` do Task Scheduler, sob o lease anti-duplicação. Runbook:
 * `docs/failover-neo.md`.
 *
 * Uso (no Neo, PowerShell ou Git Bash, na raiz do repo):
 *   npx tsx scripts/failover/neo-takeover.ts --status
 *   npx tsx scripts/failover/neo-takeover.ts --arm [--force] [--dry-run]
 *   npx tsx scripts/failover/neo-takeover.ts --disarm [--force] [--dry-run]
 *
 * `--arm`: exige o sinal `infra:300:down-since` (#12981) no KV ou `--force`.
 *   1. registra as `Diaria-Failover-*` (parando e removendo as antigas antes);
 *   2. grava o lease `infra:scheduler-owner` para o Neo e relê.
 *   Ordem de propósito: tarefa sem lease do Neo cede (o Neo é fail-closed),
 *   mas lease sem tarefa pararia o `300` à toa. Se o lease não confirmar, as
 *   tarefas recém-registradas são removidas e o lease é apagado quando a
 *   releitura mostra o Neo ou é inconclusiva (rollback).
 * `--disarm`: desabilita as `Diaria-Failover-*`, espera a execução em curso
 *   terminar (até 10 min; `Stop-ScheduledTask` só como último recurso, com
 *   AVISO, #12993), remove as tarefas e depois libera o lease, só se ele for
 *   do Neo. O `300` retoma na próxima execução das tasks dele. Remoção que
 *   falha não libera o lease; lease ilegível sai 1. Fora do Windows não há
 *   tarefa a remover: liberar o lease ali deixaria as do Neo armadas agindo
 *   ao lado do `300`, então exige `--force` (#12993).
 * `--status`: tarefas armadas, dono do lease e sinal de queda.
 * `--dry-run`: imprime o plano (inclusive o script PowerShell) e só LÊ o KV;
 *   não registra nada nem grava. No `--arm` mostra o plano mesmo sem o sinal
 *   de queda, avisando que o arm real exigiria `--force`.
 *
 * Exit: 0 ok; 1 falha (KV, PowerShell, pré-condição); 2 uso inválido.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnknownFlags, hasFlag, isMainModule } from "../lib/cli-args.ts";
import { createKvRestOps, type KvOps } from "../lib/cloudflare-kv-rest.ts";
import { resolveOpsStateKvConfig } from "../lib/diaria/short-related-kv.ts";
import { loadProjectEnv } from "../lib/env-loader.ts";
import { defaultLeaseMemoryPath, fileLeaseMemory } from "../lib/failover/lease-memory.ts";
import {
  buildArmPlan,
  buildDisarmScript,
  buildStatusScript,
  decideArmPrecondition,
  isAgentWorktreePath,
  parseStatusOutput,
  planLeaseRelease,
  POWERSHELL_TIMEOUT_MS,
} from "../lib/failover/neo-takeover-plan.ts";
import {
  ARM_LEASE_BY,
  LEASE_TTL_MS,
  makeLease,
  readDownSignal,
  readLease,
  SCHEDULER_LEASE_KEY,
  serializeLease,
  STANDBY_HOST,
  type DownSignalRead,
  type LastKnownLease,
} from "../lib/failover/scheduler-lease.ts";
import { readPlatformConfigFile } from "../lib/failover/task-gate.ts";
import { SCHEDULED_TASKS } from "../lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const P = "[neo-takeover]";

type Mode = "arm" | "disarm" | "status";

export function parseMode(argv: string[]): { ok: true; mode: Mode; force: boolean; dryRun: boolean } | { ok: false; error: string } {
  const unknown = findUnknownFlags(argv, ["arm", "disarm", "status", "force", "dry-run"]);
  if (unknown.length) return { ok: false, error: `flag desconhecida: ${unknown.join(", ")}` };
  const modes = (["arm", "disarm", "status"] as const).filter((m) => hasFlag(argv, m));
  if (modes.length !== 1) return { ok: false, error: "passe exatamente um de --arm, --disarm, --status" };
  const force = hasFlag(argv, "force");
  if (force && modes[0] === "status") return { ok: false, error: "--force só vale com --arm ou --disarm" };
  return { ok: true, mode: modes[0], force, dryRun: hasFlag(argv, "dry-run") };
}

export type PsResult = { ok: boolean; stdout: string; stderr: string };
export type TakeoverKv = Pick<KvOps, "get" | "put" | "delete">;
export type OpenKvResult = { ok: true; kv: TakeoverKv } | { ok: false; reason: string };

/** Efeitos colaterais do CLI (injetáveis em teste). */
export interface TakeoverDeps {
  runPowerShell: (script: string) => PsResult;
  openKv: () => OpenKvResult;
  platform: NodeJS.Platform;
  root: string;
  now: () => Date;
  /** Último lease lido nesta máquina (as próprias tarefas do Neo gravam). */
  lastKnownLease: () => LastKnownLease | null;
  log: (msg: string) => void;
  err: (msg: string) => void;
}

function runPowerShell(script: string): PsResult {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
    input: script,
    encoding: "utf8",
    // Cobre a espera do disarm (#12993): até DRAIN_WAIT_SECONDS + STOP_WAIT_SECONDS.
    timeout: POWERSHELL_TIMEOUT_MS,
  });
  if (r.error) return { ok: false, stdout: "", stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function openKv(): OpenKvResult {
  loadProjectEnv(ROOT);
  const pc = readPlatformConfigFile(ROOT);
  if (pc.kind !== "ok") {
    return { ok: false, reason: pc.kind === "absent" ? "platform.config.json ausente" : `platform.config.json ilegível (${pc.error})` };
  }
  const cfg = resolveOpsStateKvConfig(pc.value, process.env);
  if (!cfg.ok) return { ok: false, reason: `configuração do KV ausente: ${cfg.missing.join(", ")}` };
  return { ok: true, kv: createKvRestOps(cfg.config) };
}

function defaultDeps(): TakeoverDeps {
  return {
    runPowerShell,
    openKv,
    platform: process.platform,
    root: ROOT,
    now: () => new Date(),
    lastKnownLease: () => fileLeaseMemory(defaultLeaseMemoryPath()).load(),
    log: (m) => console.log(m),
    err: (m) => console.error(m),
  };
}

function localOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

async function status(d: TakeoverDeps): Promise<number> {
  const kv = d.openKv();
  if (d.platform === "win32") {
    const r = d.runPowerShell(buildStatusScript());
    if (!r.ok) d.err(`${P} não consegui listar as tarefas: ${r.stderr.trim()}`);
    else {
      const armed = parseStatusOutput(r.stdout);
      d.log(`${P} tarefas Diaria-Failover-* armadas: ${armed.length}`);
      for (const t of armed) d.log(`  - ${t.name} (${t.state})`);
    }
  } else {
    d.log(`${P} não é Windows (${d.platform}): tarefas do Task Scheduler não consultadas`);
  }
  if (!kv.ok) {
    d.err(`${P} KV: ${kv.reason}`);
    return 1;
  }
  const lease = await readLease(kv.kv);
  const sig = await readDownSignal(kv.kv);
  d.log(
    `${P} lease ${SCHEDULER_LEASE_KEY}: ` +
      (lease.kind === "ok"
        ? `${lease.lease.host} até ${lease.lease.until} (por ${lease.lease.by ?? "?"})`
        : lease.kind === "absent"
          ? "ausente (o 300 é o dono padrão)"
          : `ilegível: ${lease.error}`),
  );
  d.log(`${P} sinal de queda: ${sig.kind === "present" ? `presente desde ${sig.since}` : sig.kind === "absent" ? "ausente" : `ilegível: ${sig.error}`}`);
  return 0;
}

/** Desfaz um `--arm` que não confirmou: remove as tarefas e, se a releitura
 * mostrou o Neo ou foi inconclusiva, apaga o lease. Tudo logado. */
async function rollbackArm(d: TakeoverDeps, kv: TakeoverKv | null, deleteLease: boolean): Promise<void> {
  const r = d.runPowerShell(buildDisarmScript());
  relayStderr(d, r);
  if (r.ok) d.err(`${P} rollback: tarefas Diaria-Failover-* removidas.`);
  else d.err(`${P} rollback: remoção das tarefas FALHOU (${r.stderr.trim()}); rode --disarm à mão.`);
  if (deleteLease && kv) {
    try {
      await kv.delete(SCHEDULER_LEASE_KEY);
      d.err(`${P} rollback: lease apagado.`);
    } catch (e) {
      d.err(`${P} rollback: apagar o lease FALHOU (${(e as Error).message}); rode --disarm à mão (ou ele expira em até 6 h).`);
    }
  }
}

async function arm(d: TakeoverDeps, force: boolean, dryRun: boolean): Promise<number> {
  const kv = d.openKv();
  const signal: DownSignalRead | { kind: "unavailable"; reason: string } = kv.ok
    ? await readDownSignal(kv.kv)
    : { kind: "unavailable", reason: kv.reason };
  const pre = decideArmPrecondition(signal, force);
  d.log(`${P} pré-condição: ${pre.reason}`);
  if (!pre.ok && !dryRun) return 1;

  const plan = buildArmPlan({ tasks: SCHEDULED_TASKS, nodePath: process.execPath, repoRoot: d.root, localOffsetMin: localOffsetMin() });
  for (const w of plan.warnings) d.err(`${P} AVISO: ${w}`);
  d.log(`${P} ${plan.entries.length} tarefas critical:`);
  for (const e of plan.entries) d.log(`  - ${e.windowsName} <- ${e.registryName}`);

  if (dryRun) {
    if (!pre.ok) d.err(`${P} AVISO: o --arm real pararia na pré-condição acima; exigiria --force.`);
    d.log(`${P} --dry-run: nada registrado, lease não gravado. Script que rodaria:\n${plan.script}`);
    return 0;
  }
  if (d.platform !== "win32") {
    d.err(`${P} --arm só roda no Windows (Neo); aqui é ${d.platform}. Use --dry-run para ver o plano.`);
    return 1;
  }
  if (isAgentWorktreePath(d.root)) {
    d.err(`${P} --arm rodou de um worktree de agente (${d.root}); as tarefas apontariam para ele. Rode do checkout principal.`);
    return 1;
  }
  if (!kv.ok) {
    d.err(`${P} sem KV não há lease, e sem lease as tarefas do Neo não agem (fail-closed): ${kv.reason}`);
    return 1;
  }

  const reg = d.runPowerShell(plan.script);
  if (!reg.ok) {
    d.err(`${P} registro das tarefas falhou: ${reg.stderr.trim()}`);
    await rollbackArm(d, kv.kv, false);
    return 1;
  }

  const lease = makeLease(STANDBY_HOST, d.now(), ARM_LEASE_BY);
  try {
    await kv.kv.put(SCHEDULER_LEASE_KEY, serializeLease(lease));
  } catch (e) {
    // A escrita pode ter chegado ao KV mesmo com erro de rede: apagar é seguro
    // (o 300 regrava o dele na próxima execução).
    d.err(`${P} gravação do lease falhou: ${(e as Error).message}. Desfazendo (rollback).`);
    await rollbackArm(d, kv.kv, true);
    return 1;
  }
  const back = await readLease(kv.kv);
  if (back.kind !== "ok" || back.lease.host !== STANDBY_HOST) {
    const seen = back.kind === "ok" ? `dono ${back.lease.host}` : back.kind;
    d.err(`${P} lease não confirmado (releitura: ${seen}). Desfazendo (rollback).`);
    // Releitura de outro host: o lease é dele, não se apaga. Neo ou inconclusiva: apaga.
    await rollbackArm(d, kv.kv, !(back.kind === "ok" && back.lease.host !== STANDBY_HOST));
    return 1;
  }
  d.log(`${P} armado: ${plan.entries.length} tarefas, lease do Neo até ${lease.until} (renovado pelas próprias tarefas).`);
  return 0;
}

function expiryHint(d: TakeoverDeps): string {
  const last = (() => {
    try {
      return d.lastKnownLease();
    } catch {
      return null;
    }
  })();
  if (last?.kind === "ok" && last.lease.host === STANDBY_HOST) {
    return `o último lease visto nesta máquina era do Neo até ${last.lease.until}; sem liberação, o 300 retoma quando ele expirar`;
  }
  return `sem liberação, um lease do Neo expira em até ${LEASE_TTL_MS / 3_600_000} h após a última renovação`;
}

/** Repassa o stderr de um script que deu certo (o AVISO do Stop-ScheduledTask, #12993). */
function relayStderr(d: TakeoverDeps, r: PsResult): void {
  if (r.ok && r.stderr.trim()) d.err(`${P} ${r.stderr.trim()}`);
}

async function disarm(d: TakeoverDeps, dryRun: boolean, force: boolean): Promise<number> {
  const kv = d.openKv();
  const read = kv.ok ? await readLease(kv.kv) : ({ kind: "error", error: kv.reason } as const);
  const release = planLeaseRelease(read);
  if (dryRun) {
    d.log(`${P} --dry-run: removeria as Diaria-Failover-*; lease: ${release.action} (${release.reason}). Script:\n${buildDisarmScript()}`);
    return 0;
  }
  if (d.platform === "win32") {
    const r = d.runPowerShell(buildDisarmScript());
    relayStderr(d, r);
    if (!r.ok) {
      d.err(`${P} remoção das tarefas falhou: ${r.stderr.trim()}. O lease NÃO foi liberado.`);
      return 1;
    }
    d.log(`${P} tarefas Diaria-Failover-* paradas e removidas.`);
  } else if (!force) {
    // #12993: aqui não há Task Scheduler para desarmar. Liberar o lease com as
    // tarefas do Neo ainda armadas deixaria o 300 e o Neo agindo juntos.
    d.err(
      `${P} --disarm fora do Windows (${d.platform}) não remove as tarefas do Neo; liberar o lease com elas armadas duplicaria o 300. ` +
        `Rode --disarm no Neo, ou use --force se as tarefas já foram removidas lá.`,
    );
    return 1;
  } else {
    d.log(`${P} não é Windows: nenhuma tarefa local a remover; seguindo só com o lease (--force).`);
  }
  if (read.kind === "error" || read.kind === "invalid") {
    d.err(`${P} lease não lido (${read.error}); não foi liberado. ${expiryHint(d)}. Rode --disarm de novo quando o KV responder.`);
    return 1;
  }
  if (release.action === "delete" && kv.ok) {
    try {
      await kv.kv.delete(SCHEDULER_LEASE_KEY);
    } catch (e) {
      d.err(`${P} liberar o lease falhou: ${(e as Error).message}. ${expiryHint(d)}.`);
      return 1;
    }
  }
  d.log(`${P} lease: ${release.action === "delete" ? release.reason : `mantido (${release.reason})`}`);
  return 0;
}

export async function main(argv: string[], deps: Partial<TakeoverDeps> = {}): Promise<number> {
  const d: TakeoverDeps = { ...defaultDeps(), ...deps };
  const parsed = parseMode(argv);
  if (!parsed.ok) {
    d.err(`${P} ${parsed.error}\nUso: neo-takeover.ts --arm [--force] [--dry-run] | --disarm [--force] [--dry-run] | --status`);
    return 2;
  }
  if (parsed.mode === "status") return status(d);
  if (parsed.mode === "arm") return arm(d, parsed.force, parsed.dryRun);
  return disarm(d, parsed.dryRun, parsed.force);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`${P}`, e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
