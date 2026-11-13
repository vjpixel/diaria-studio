/**
 * scripts/lib/failover/neo-takeover-plan.ts (#12982)
 *
 * Lógica PURA do `scripts/failover/neo-takeover.ts`: quais tasks o Neo arma,
 * como cada uma vira tarefa do Task Scheduler do Windows (script PowerShell
 * gerado como texto), a pré-condição do `--arm` e o que fazer com o lease no
 * `--disarm`. Nada aqui executa PowerShell nem fala com o KV; o script CLI
 * faz o efeito colateral.
 *
 * Por que PowerShell (`Register-ScheduledTask`) e não `schtasks /Create`:
 * `schtasks` não define o diretório de trabalho da ação, e o `node --import
 * tsx` resolve o `tsx` a partir do cwd (sob o Task Scheduler o cwd é
 * `C:\Windows\System32`). `New-ScheduledTaskAction -WorkingDirectory` resolve
 * isso, e o `/TR` do `schtasks` ainda tem teto de 261 caracteres. Os wrappers
 * `.ps1` antigos do repo (removidos no #5115) usavam o mesmo cmdlet.
 */

import type { ScheduledTaskDefinition, ScheduledTaskSchedule, WeekDay } from "../scheduled-tasks.ts";
import { resolveFailoverTier } from "../scheduled-tasks.ts";
import type { DownSignalRead, LeaseRead } from "./scheduler-lease.ts";
import { STANDBY_HOST } from "./scheduler-lease.ts";

/** Prefixo das tarefas do Neo: nunca se confunde com o regime normal (`Diaria-*` no 300). */
export const FAILOVER_TASK_PREFIX = "Diaria-Failover-";

/** Offset do horário de Brasília em minutos (UTC-3, sem horário de verão desde 2019). */
export const BRT_OFFSET_MIN = -180;

export function failoverTaskName(registryName: string): string {
  return FAILOVER_TASK_PREFIX + registryName.replace(/^Diaria-/, "");
}

export function criticalTasks<T extends Pick<ScheduledTaskDefinition, "failover" | "enabled">>(tasks: readonly T[]): T[] {
  return tasks.filter((t) => resolveFailoverTier(t) === "critical" && t.enabled !== false);
}

const WEEK: WeekDay[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Converte um schedule do registro (horário de Brasília, que é o que o
 * systemd do 300 usa: `OnCalendar=... America/Sao_Paulo`) para o fuso local
 * do Neo, dado o offset local em minutos (ex.: -180 em Brasília, 0 em
 * Lisboa no inverno). O Task Scheduler dispara no horário LOCAL; sem isto,
 * o Neo em viagem publicaria fora do horário.
 */
export function toLocalSchedule(schedule: ScheduledTaskSchedule, localOffsetMin: number): ScheduledTaskSchedule {
  if (schedule.kind === "interval") return schedule;
  const delta = localOffsetMin - BRT_OFFSET_MIN;
  if (delta === 0) return schedule;
  const total = schedule.hour * 60 + schedule.minute + delta;
  const dayShift = Math.floor(total / 1440);
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  if (schedule.kind === "daily") return { kind: "daily", hour, minute };
  if (schedule.kind === "weekly") {
    const idx = (((WEEK.indexOf(schedule.dayOfWeek) + dayShift) % 7) + 7) % 7;
    return { kind: "weekly", dayOfWeek: WEEK[idx], hour, minute };
  }
  // monthly: o Neo não arma (ver buildTriggerPs); devolvido só por completude.
  return { kind: "monthly", day: schedule.day, hour, minute };
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Literal PowerShell entre aspas simples (aspa simples dobra). */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Expressão PowerShell que cria o trigger. Monthly lança: nenhuma task `critical` é mensal. */
export function buildTriggerPs(schedule: ScheduledTaskSchedule): string {
  switch (schedule.kind) {
    case "daily":
      return `New-ScheduledTaskTrigger -Daily -At ${psQuote(hhmm(schedule.hour, schedule.minute))}`;
    case "weekly":
      return `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${schedule.dayOfWeek} -At ${psQuote(hhmm(schedule.hour, schedule.minute))}`;
    case "interval":
      // Alinhado à meia-noite LOCAL do Neo, como o `0/N:00` do systemd (que é
      // em horário de Brasília). Com hours=1 o resultado é o mesmo em qualquer
      // fuso inteiro; com N>1 e o Neo fora de Brasília, as janelas ficam
      // deslocadas pelo offset (nenhuma task critical usa N>1 hoje).
      // Sem -RepetitionDuration: no Windows 10/11 a repetição é indefinida.
      return `New-ScheduledTaskTrigger -Once -At ((Get-Date).Date) -RepetitionInterval (New-TimeSpan -Hours ${schedule.hours})`;
    case "monthly":
      throw new Error("schedule monthly não é suportado no failover do Neo (nenhuma task critical deveria ser mensal)");
  }
}

export interface ArmPlanEntry {
  registryName: string;
  windowsName: string;
  /** Schedule já convertido para o fuso local. */
  localSchedule: ScheduledTaskSchedule;
  triggerPs: string;
}

export interface ArmPlanInput {
  tasks: readonly ScheduledTaskDefinition[];
  nodePath: string;
  /** Raiz do repo no Neo (caminho Windows). */
  repoRoot: string;
  localOffsetMin: number;
}

export interface ArmPlan {
  entries: ArmPlanEntry[];
  /** Script PowerShell completo: remove as `Diaria-Failover-*` antigas e registra as atuais. */
  script: string;
  /** Avisos para o editor (fuso diferente de Brasília etc.). */
  warnings: string[];
}

/**
 * As tarefas apontam para o checkout de onde o `--arm` rodou. Armar de dentro
 * de um worktree de agente (`.claude/worktrees/...`) faria o Task Scheduler
 * rodar código de uma branch que some na limpeza do worktree.
 */
export function isAgentWorktreePath(repoRoot: string): boolean {
  return /[\\/]\.claude[\\/]worktrees[\\/]/.test(repoRoot);
}

export function runTaskArguments(repoRoot: string, registryName: string): string {
  const runTask = `${repoRoot.replace(/[\\/]+$/, "")}\\scripts\\run-task.ts`;
  return `--import tsx "${runTask}" --task ${registryName} --failover-standby`;
}

export function buildArmPlan(input: ArmPlanInput): ArmPlan {
  const warnings: string[] = [];
  if (input.localOffsetMin !== BRT_OFFSET_MIN) {
    warnings.push(
      `fuso local do Neo é UTC${input.localOffsetMin >= 0 ? "+" : "-"}${Math.abs(input.localOffsetMin) / 60}, não Brasília: ` +
        `os horários foram convertidos pelo offset de AGORA; se o fuso local mudar (horário de verão, viagem), rode --arm de novo.`,
    );
  }
  const entries: ArmPlanEntry[] = criticalTasks(input.tasks).map((t) => {
    const localSchedule = toLocalSchedule(t.schedule, input.localOffsetMin);
    return {
      registryName: t.name,
      windowsName: failoverTaskName(t.name),
      localSchedule,
      triggerPs: buildTriggerPs(localSchedule),
    };
  });

  const lines: string[] = [
    "$ErrorActionPreference = 'Stop'",
    ...stopAndUnregisterLines(),
    // StartWhenAvailable: notebook acordando depois do horário ainda dispara
    // (os timers dos Shorts têm a própria janela de validade).
    // IgnoreNew: hourly que ainda está rodando não empilha outra instância.
    "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)",
  ];
  for (const e of entries) {
    lines.push(
      `$action = New-ScheduledTaskAction -Execute ${psQuote(input.nodePath)} -Argument ${psQuote(runTaskArguments(input.repoRoot, e.registryName))} -WorkingDirectory ${psQuote(input.repoRoot)}`,
      `$trigger = ${e.triggerPs}`,
      `Register-ScheduledTask -TaskName ${psQuote(e.windowsName)} -Description ${psQuote(`#12982 failover do 300: ${e.registryName}`)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    );
  }
  return { entries, script: lines.join("\n"), warnings };
}

/**
 * Segundos que o `--disarm`/`--arm` espera uma execução em curso TERMINAR
 * sozinha, depois de desabilitar as tarefas (#12993). Maior que um passo de
 * publicação típico (upload de vídeo incluso), bem menor que o
 * `ExecutionTimeLimit` de 2 h.
 */
export const DRAIN_WAIT_SECONDS = 600;
/** Segundos que se espera o `Stop-ScheduledTask` (último recurso) fazer efeito. */
export const STOP_WAIT_SECONDS = 60;
/** Teto do processo PowerShell que roda o script de remoção: as duas esperas e folga. */
export const POWERSHELL_TIMEOUT_MS = (DRAIN_WAIT_SECONDS + STOP_WAIT_SECONDS + 120) * 1000;

/**
 * Remove as `Diaria-Failover-*` sem cortar um passo de publicação no meio
 * (#12993). Ordem:
 *   1. `Disable-ScheduledTask` em todas: nenhuma execução NOVA começa;
 *   2. espera a execução em curso terminar sozinha, até `DRAIN_WAIT_SECONDS`;
 *   3. só se alguma ainda estiver `Running`: `Stop-ScheduledTask`, como
 *      último recurso, com AVISO em stderr. O Task Scheduler nem sempre mata a
 *      árvore do processo (o passo roda num filho do `spawnSync`): o filho
 *      pode sobreviver e publicar depois de o lease ser liberado, ou morrer
 *      entre o upload e o registro no store e o `300` republicar. O aviso
 *      manda conferir o canal antes de o `300` retomar;
 *   4. se alguma continuar `Running` depois do `Stop`, lança: o script sai
 *      ≠0 e o lease não é liberado;
 *   5. remove as tarefas.
 */
export function stopAndUnregisterLines(): string[] {
  const sel = `Get-ScheduledTask -TaskName ${psQuote(FAILOVER_TASK_PREFIX + "*")} -ErrorAction SilentlyContinue`;
  const running = `@(${sel} | Where-Object { $_.State -eq 'Running' })`;
  const warn =
    `AVISO #12993: Diaria-Failover-* ainda em execução após ${DRAIN_WAIT_SECONDS}s; usando Stop-ScheduledTask como último recurso. ` +
    `O passo interrompido pode ter publicado sem registrar no store (o 300 republicaria) ou seguir vivo como processo filho: ` +
    `confira o canal da task antes de o 300 retomar.`;
  return [
    `@(${sel}) | Disable-ScheduledTask | Out-Null`,
    `$drain = (Get-Date).AddSeconds(${DRAIN_WAIT_SECONDS})`,
    `while (${running}.Count -gt 0 -and (Get-Date) -le $drain) { Start-Sleep -Seconds 5 }`,
    `$still = ${running}`,
    `if ($still.Count -gt 0) {`,
    `  [Console]::Error.WriteLine(${psQuote(warn)})`,
    `  $still | Stop-ScheduledTask`,
    `  $deadline = (Get-Date).AddSeconds(${STOP_WAIT_SECONDS})`,
    `  while (${running}.Count -gt 0) { if ((Get-Date) -gt $deadline) { throw 'Diaria-Failover-* ainda em execução após Stop-ScheduledTask (${STOP_WAIT_SECONDS}s)' }; Start-Sleep -Seconds 2 }`,
    `}`,
    `${sel} | Unregister-ScheduledTask -Confirm:$false`,
  ];
}

export function buildDisarmScript(): string {
  return ["$ErrorActionPreference = 'Stop'", ...stopAndUnregisterLines()].join("\n");
}

export function buildStatusScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$t = @(Get-ScheduledTask -TaskName ${psQuote(FAILOVER_TASK_PREFIX + "*")} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = $_.TaskName; state = [string]$_.State } })`,
    "ConvertTo-Json -InputObject $t -Compress",
  ].join("\n");
}

export interface ArmedTask {
  name: string;
  state: string;
}

/** Parse da saída de `buildStatusScript` (array JSON; vazio, objeto único ou lixo tratados). */
export function parseStatusOutput(stdout: string): ArmedTask[] {
  const text = stdout.trim();
  if (text === "") return [];
  const json = JSON.parse(text) as unknown;
  const arr = Array.isArray(json) ? json : json && typeof json === "object" ? [json] : [];
  return arr
    .filter((x): x is { name: unknown; state: unknown } => !!x && typeof x === "object")
    .map((x) => ({ name: String(x.name), state: String(x.state) }))
    .filter((x) => x.name.startsWith(FAILOVER_TASK_PREFIX));
}

export type ArmPrecondition = { ok: true; reason: string } | { ok: false; reason: string };

/**
 * `--arm` só passa com o sinal de queda da #12981 (`infra:300:down-since`)
 * presente, ou com `--force`. Sinal ilegível ou KV indisponível não conta
 * como queda: exige `--force`.
 */
export function decideArmPrecondition(signal: DownSignalRead | { kind: "unavailable"; reason: string }, force: boolean): ArmPrecondition {
  if (signal.kind === "present") return { ok: true, reason: `sinal de queda do 300 presente (desde ${signal.since})` };
  const why =
    signal.kind === "absent"
      ? "sinal de queda do 300 ausente (infra:300:down-since)"
      : signal.kind === "error"
        ? `sinal de queda ilegível (${signal.error})`
        : `sinal de queda não consultado (${signal.reason})`;
  if (force) return { ok: true, reason: `${why}; seguindo por --force` };
  return { ok: false, reason: `${why}. Confirme a queda e rode de novo com --force.` };
}

export type LeaseRelease = { action: "delete"; reason: string } | { action: "keep"; reason: string };

/** `--disarm`: só libera o lease se ele for do Neo; nunca apaga o lease do 300. */
export function planLeaseRelease(read: LeaseRead): LeaseRelease {
  if (read.kind === "absent") return { action: "keep", reason: "nenhum lease gravado" };
  if (read.kind === "error" || read.kind === "invalid") return { action: "keep", reason: `lease ilegível (${read.error}); conferir à mão` };
  if (read.lease.host !== STANDBY_HOST) return { action: "keep", reason: `lease é do ${read.lease.host}, não do Neo` };
  return { action: "delete", reason: `lease do Neo (até ${read.lease.until}) liberado; o 300 retoma na próxima execução` };
}
