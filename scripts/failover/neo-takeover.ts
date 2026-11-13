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
 *   npx tsx scripts/failover/neo-takeover.ts --disarm [--dry-run]
 *
 * `--arm`: exige o sinal `infra:300:down-since` (#12981) no KV ou `--force`.
 *   1. registra as `Diaria-Failover-*` (removendo as antigas antes);
 *   2. grava o lease `infra:scheduler-owner` para o Neo e relê.
 *   Ordem de propósito: tarefa sem lease não age (o Neo é fail-closed), mas
 *   lease sem tarefa pararia o `300` à toa. Se o lease falhar, as tarefas
 *   recém-registradas são removidas (rollback).
 * `--disarm`: remove as `Diaria-Failover-*` e depois libera o lease, só se ele
 *   for do Neo. O `300` retoma na próxima execução das tasks dele.
 * `--status`: tarefas armadas, dono do lease e sinal de queda.
 * `--dry-run`: imprime o plano (inclusive o script PowerShell) e só LÊ o KV;
 *   não registra nada nem grava.
 *
 * Exit: 0 ok; 1 falha (KV, PowerShell, pré-condição); 2 uso inválido.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnknownFlags, hasFlag, isMainModule } from "../lib/cli-args.ts";
import { createKvRestOps, type KvOps } from "../lib/cloudflare-kv-rest.ts";
import { resolveOpsStateKvConfig } from "../lib/diaria/short-related-kv.ts";
import { loadProjectEnv } from "../lib/env-loader.ts";
import {
  buildArmPlan,
  buildDisarmScript,
  buildStatusScript,
  decideArmPrecondition,
  isAgentWorktreePath,
  parseStatusOutput,
  planLeaseRelease,
} from "../lib/failover/neo-takeover-plan.ts";
import {
  makeLease,
  readDownSignal,
  readLease,
  SCHEDULER_LEASE_KEY,
  serializeLease,
  STANDBY_HOST,
  type DownSignalRead,
} from "../lib/failover/scheduler-lease.ts";
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
  if (force && modes[0] !== "arm") return { ok: false, error: "--force só vale com --arm" };
  return { ok: true, mode: modes[0], force, dryRun: hasFlag(argv, "dry-run") };
}

function runPowerShell(script: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
    input: script,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.error) return { ok: false, stdout: "", stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function openKv(): { ok: true; kv: KvOps } | { ok: false; reason: string } {
  loadProjectEnv(ROOT);
  let cfgJson: unknown = null;
  try {
    cfgJson = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  } catch (e) {
    return { ok: false, reason: `platform.config.json ilegível (${(e as Error).message})` };
  }
  const cfg = resolveOpsStateKvConfig(cfgJson, process.env);
  if (!cfg.ok) return { ok: false, reason: `configuração do KV ausente: ${cfg.missing.join(", ")}` };
  return { ok: true, kv: createKvRestOps(cfg.config) };
}

function localOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

async function status(): Promise<number> {
  const kv = openKv();
  if (process.platform === "win32") {
    const r = runPowerShell(buildStatusScript());
    if (!r.ok) console.error(`${P} não consegui listar as tarefas: ${r.stderr.trim()}`);
    else {
      const armed = parseStatusOutput(r.stdout);
      console.log(`${P} tarefas Diaria-Failover-* armadas: ${armed.length}`);
      for (const t of armed) console.log(`  - ${t.name} (${t.state})`);
    }
  } else {
    console.log(`${P} não é Windows (${process.platform}): tarefas do Task Scheduler não consultadas`);
  }
  if (!kv.ok) {
    console.error(`${P} KV: ${kv.reason}`);
    return 1;
  }
  const lease = await readLease(kv.kv);
  const sig = await readDownSignal(kv.kv);
  console.log(
    `${P} lease ${SCHEDULER_LEASE_KEY}: ` +
      (lease.kind === "ok" ? `${lease.lease.host} até ${lease.lease.until} (por ${lease.lease.by ?? "?"})` : lease.kind === "absent" ? "ausente (o 300 é o dono padrão)" : `ilegível: ${lease.error}`),
  );
  console.log(`${P} sinal de queda: ${sig.kind === "present" ? `presente desde ${sig.since}` : sig.kind === "absent" ? "ausente" : `ilegível: ${sig.error}`}`);
  return 0;
}

async function arm(force: boolean, dryRun: boolean): Promise<number> {
  const kv = openKv();
  const signal: DownSignalRead | { kind: "unavailable"; reason: string } = kv.ok
    ? await readDownSignal(kv.kv)
    : { kind: "unavailable", reason: kv.reason };
  const pre = decideArmPrecondition(signal, force);
  console.log(`${P} pré-condição: ${pre.reason}`);
  if (!pre.ok) return 1;

  const plan = buildArmPlan({ tasks: SCHEDULED_TASKS, nodePath: process.execPath, repoRoot: ROOT, localOffsetMin: localOffsetMin() });
  for (const w of plan.warnings) console.warn(`${P} AVISO: ${w}`);
  console.log(`${P} ${plan.entries.length} tarefas critical:`);
  for (const e of plan.entries) console.log(`  - ${e.windowsName} <- ${e.registryName}`);

  if (dryRun) {
    console.log(`${P} --dry-run: nada registrado, lease não gravado. Script que rodaria:\n${plan.script}`);
    return 0;
  }
  if (process.platform !== "win32") {
    console.error(`${P} --arm só roda no Windows (Neo); aqui é ${process.platform}. Use --dry-run para ver o plano.`);
    return 1;
  }
  if (isAgentWorktreePath(ROOT)) {
    console.error(`${P} --arm rodou de um worktree de agente (${ROOT}); as tarefas apontariam para ele. Rode do checkout principal.`);
    return 1;
  }
  if (!kv.ok) {
    console.error(`${P} sem KV não há lease, e sem lease as tarefas do Neo não agem (fail-closed): ${kv.reason}`);
    return 1;
  }

  const reg = runPowerShell(plan.script);
  if (!reg.ok) {
    console.error(`${P} registro das tarefas falhou: ${reg.stderr.trim()}`);
    runPowerShell(buildDisarmScript());
    return 1;
  }

  const lease = makeLease(STANDBY_HOST, new Date(), "neo-takeover --arm");
  try {
    await kv.kv.put(SCHEDULER_LEASE_KEY, serializeLease(lease));
    const back = await readLease(kv.kv);
    if (back.kind !== "ok" || back.lease.host !== STANDBY_HOST) {
      throw new Error(`releitura não confirma o lease do Neo (${back.kind === "ok" ? `dono ${back.lease.host}` : back.kind})`);
    }
  } catch (e) {
    console.error(`${P} lease não confirmado: ${(e as Error).message}. Removendo as tarefas recém-registradas (rollback).`);
    runPowerShell(buildDisarmScript());
    return 1;
  }
  console.log(`${P} armado: ${plan.entries.length} tarefas, lease do Neo até ${lease.until} (renovado pelas próprias tarefas).`);
  return 0;
}

async function disarm(dryRun: boolean): Promise<number> {
  const kv = openKv();
  const read = kv.ok ? await readLease(kv.kv) : ({ kind: "error", error: kv.reason } as const);
  const release = planLeaseRelease(read);
  if (dryRun) {
    console.log(`${P} --dry-run: removeria as Diaria-Failover-*; lease: ${release.action} (${release.reason}). Script:\n${buildDisarmScript()}`);
    return 0;
  }
  let code = 0;
  if (process.platform === "win32") {
    const r = runPowerShell(buildDisarmScript());
    if (!r.ok) {
      console.error(`${P} remoção das tarefas falhou: ${r.stderr.trim()}. O lease NÃO foi liberado.`);
      return 1;
    }
    console.log(`${P} tarefas Diaria-Failover-* removidas.`);
  } else {
    console.log(`${P} não é Windows: nenhuma tarefa local a remover; seguindo só com o lease.`);
  }
  if (release.action === "delete" && kv.ok) {
    try {
      await kv.kv.delete(SCHEDULER_LEASE_KEY);
    } catch (e) {
      console.error(`${P} liberar o lease falhou: ${(e as Error).message}. O 300 retoma quando ele expirar.`);
      code = 1;
    }
  }
  console.log(`${P} lease: ${release.action === "delete" && code === 0 ? release.reason : `mantido (${release.reason})`}`);
  return code;
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseMode(argv);
  if (!parsed.ok) {
    console.error(`${P} ${parsed.error}\nUso: neo-takeover.ts --arm [--force] [--dry-run] | --disarm [--dry-run] | --status`);
    return 2;
  }
  if (parsed.mode === "status") return status();
  if (parsed.mode === "arm") return arm(parsed.force, parsed.dryRun);
  return disarm(parsed.dryRun);
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
