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
 *   1. registra as `Diaria-Failover-*` (parando e removendo as antigas antes)
 *      e relê o Task Scheduler: o conjunto registrado tem que bater com o
 *      plano (e nenhuma `Disabled`), senão rollback e exit 1 sem gravar o
 *      lease (#12993). Plano vazio é recusado antes de registrar;
 *   2. grava o lease `infra:scheduler-owner` para o Neo e relê.
 *   Ordem de propósito: tarefa sem lease do Neo cede (o Neo é fail-closed),
 *   mas lease sem tarefa pararia o `300` à toa. Se o lease não confirmar, as
 *   tarefas recém-registradas são removidas e o lease é apagado quando a
 *   releitura mostra o Neo ou é inconclusiva (rollback).
 * `--disarm`: desabilita as `Diaria-Failover-*`, espera a execução em curso
 *   terminar (até 10 min; `Stop-ScheduledTask` só como último recurso, com
 *   AVISO, #12993), remove as tarefas e depois libera o lease, só se ele for
 *   do Neo. O `300` retoma na próxima execução das tasks dele. Se a releitura
 *   ainda mostra `Diaria-Failover-*` (ou falha), sai 1: sem o sinal de queda
 *   libera o lease (as restantes cedem); com o sinal presente ou ilegível
 *   retém o lease, porque as restantes assumiriam (#12993). Remoção que
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
  checkArmedSet,
  decideArmPrecondition,
  isAgentWorktreePath,
  parseStatusOutput,
  planLeaseRelease,
  POWERSHELL_TIMEOUT_MS,
  type ArmedTask,
} from "../lib/failover/neo-takeover-plan.ts";
import { runPowerShellFile, type PsResult } from "../lib/failover/powershell-file.ts";
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
import { SCHEDULED_TASKS, type ScheduledTaskDefinition } from "../lib/scheduled-tasks.ts";

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

export type { PsResult };
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
  /** Registro de tasks de onde sai o plano (default: `SCHEDULED_TASKS`). */
  tasks: readonly ScheduledTaskDefinition[];
}

function runPowerShell(script: string): PsResult {
  // `.ps1` temporário + `-File`, nunca `-Command -` com o script no stdin: o
  // PowerShell 5.1 descarta em silêncio o que vem depois do 1º bloco
  // multi-linha e sai 0 (#12993, 1º ensaio de 15/11/2026). Timeout cobre a
  // espera do disarm: até DRAIN_WAIT_SECONDS + STOP_WAIT_SECONDS.
  return runPowerShellFile(script, POWERSHELL_TIMEOUT_MS);
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
    tasks: SCHEDULED_TASKS,
  };
}

function localOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

type ArmedList = { ok: true; armed: ArmedTask[] } | { ok: false; error: string };

/** Lista as `Diaria-Failover-*` do Task Scheduler. Saída ilegível conta como falha. */
function listArmed(d: TakeoverDeps): ArmedList {
  const r = d.runPowerShell(buildStatusScript());
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "PowerShell saiu com erro" };
  try {
    return { ok: true, armed: parseStatusOutput(r.stdout) };
  } catch (e) {
    return { ok: false, error: `saída ilegível (${(e as Error).message})` };
  }
}

async function status(d: TakeoverDeps): Promise<number> {
  const kv = d.openKv();
  if (d.platform === "win32") {
    const l = listArmed(d);
    if (!l.ok) d.err(`${P} não consegui listar as tarefas: ${l.error}`);
    else {
      d.log(`${P} tarefas Diaria-Failover-* armadas: ${l.armed.length}`);
      for (const t of l.armed) d.log(`  - ${t.name} (${t.state})`);
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
  if (!r.ok) d.err(`${P} rollback: remoção das tarefas FALHOU (${r.stderr.trim()}); rode --disarm à mão.`);
  else {
    // #12993: o status 0 do PowerShell não prova a remoção; só a releitura prova.
    const l = listArmed(d);
    if (l.ok && l.armed.length === 0) d.err(`${P} rollback: tarefas Diaria-Failover-* removidas.`);
    else if (l.ok) d.err(`${P} rollback: ainda há ${l.armed.length} Diaria-Failover-* registradas (${l.armed.map((t) => t.name).join(", ")}); rode --disarm à mão.`);
    else d.err(`${P} rollback: remoção não confirmada (${l.error}); confira com --status e rode --disarm à mão se sobrar tarefa.`);
  }
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

  const plan = buildArmPlan({ tasks: d.tasks, nodePath: process.execPath, repoRoot: d.root, localOffsetMin: localOffsetMin() });
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
  if (plan.entries.length === 0) {
    // Lease do Neo sem tarefa nenhuma pararia o 300 e ninguém rodaria nada.
    d.err(`${P} o plano não tem nenhuma tarefa critical para armar; nada registrado, lease NÃO gravado.`);
    return 1;
  }

  const reg = d.runPowerShell(plan.script);
  if (!reg.ok) {
    d.err(`${P} registro das tarefas falhou: ${reg.stderr.trim()}`);
    await rollbackArm(d, kv.kv, false);
    return 1;
  }
  // #12993: o PowerShell 5.1 já saiu 0 sem ter registrado nada (1º ensaio,
  // 15/11/2026). Antes de gravar o lease, a releitura do Task Scheduler tem
  // que mostrar exatamente as tarefas do plano.
  const listed = listArmed(d);
  const check = listed.ok ? checkArmedSet(plan.entries.map((e) => e.windowsName), listed.armed) : null;
  if (!listed.ok || !check || !check.ok) {
    const why = !listed.ok
      ? `não consegui listar as tarefas (${listed.error})`
      : check && !check.ok
        ? `esperadas ${plan.entries.length}, registradas ${listed.armed.length}` +
          (check.missing.length ? `; faltando: ${check.missing.join(", ")}` : "") +
          (check.extra.length ? `; sobrando: ${check.extra.join(", ")}` : "") +
          (check.disabled.length ? `; desabilitadas: ${check.disabled.join(", ")}` : "")
        : "conferência inconclusiva";
    d.err(`${P} registro das tarefas não confirmado: ${why}. Lease NÃO gravado. Desfazendo (rollback).`);
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
  let unverified: string | null = null;
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
    // #12993: o status 0 não prova a remoção. Se sobrou tarefa (ou a listagem
    // falhou), o que fazer com o lease depende do sinal de queda: sem o sinal,
    // tarefa do Neo com lease ausente não age (`decideLease` só deixa o Neo
    // assumir lease ausente com `infra:300:down-since` presente), então liberar
    // devolve o 300 e só se avisa. COM o sinal (ou sinal ilegível), liberar
    // faria as que sobraram assumirem ao lado do 300: o lease é retido e sai 1.
    const l = listArmed(d);
    if (l.ok && l.armed.length === 0) d.log(`${P} tarefas Diaria-Failover-* paradas e removidas.`);
    else {
      unverified =
        l.ok
          ? `ainda há ${l.armed.length} Diaria-Failover-* registradas (${l.armed.map((t) => t.name).join(", ")})`
          : `remoção não confirmada (${l.error})`;
      const sig = kv.ok ? await readDownSignal(kv.kv) : ({ kind: "error", error: kv.reason } as const);
      if (sig.kind !== "absent") {
        const why = sig.kind === "present" ? `o sinal de queda do 300 está presente (desde ${sig.since})` : `o sinal de queda não foi lido (${sig.error})`;
        d.err(
          `${P} AVISO: ${unverified}, e ${why}: sem o lease do Neo as tarefas restantes RETOMARIAM ao lado do 300. ` +
            `Lease NÃO liberado. Remova as que sobraram no Agendador de Tarefas (e apague infra:300:down-since se o 300 voltou) e rode --disarm de novo.`,
        );
        return 1;
      }
      d.err(`${P} AVISO: ${unverified}. Sem o sinal de queda, o lease do Neo é liberado (as restantes cedem ao 300); remova-as no Agendador de Tarefas.`);
    }
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
  if (unverified) {
    d.err(`${P} --disarm incompleto: ${unverified}.`);
    return 1;
  }
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
