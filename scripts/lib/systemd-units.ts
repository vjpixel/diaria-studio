/**
 * scripts/lib/systemd-units.ts (#4805 Fase 3, épica #4798)
 *
 * Funções puras que traduzem uma `ScheduledTaskDefinition` (registro
 * declarativo, `scripts/lib/scheduled-tasks.ts`) num par de units systemd
 * (`.service` + `.timer`, "user units") — espelha o papel dos
 * `scripts/setup-*-schedule.ps1` do Windows, mas só GERA o texto/arquivo.
 * ARMAR (`systemctl --user enable --now`) é a issue filha #4807, fora deste
 * escopo — nenhuma função aqui chama `systemctl` nem qualquer outro
 * subprocess (ver `scripts/setup-systemd-timers.ts`, que só escreve arquivo
 * em disco).
 *
 * @see scripts/setup-systemd-timers.ts (CLI que consome este módulo)
 * @see scripts/lib/scheduled-tasks.ts (fonte dos dados traduzidos aqui)
 */

import type { ScheduledTaskDefinition, ScheduledTaskSchedule, WeekDay } from "./scheduled-tasks.ts";

const WEEKDAY_ABBR: Record<WeekDay, string> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

/** Deriva o nome-base kebab-case do unit systemd a partir do `TaskName`
 * (ex: `"Diaria-Apoios-Diff-Alarm"` → `"diaria-apoios-diff-alarm"`). */
export function unitBaseName(taskName: string): string {
  return taskName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Converte um `ScheduledTaskSchedule` declarativo pro valor de `OnCalendar=`
 * do systemd (sintaxe `systemd.time(7)`).
 *
 * `interval` (ex: "a cada 4h") não tem equivalente literal de "começa AGORA,
 * repete a cada Nh indefinidamente" (o que `-Once -At (Get-Date)
 * -RepetitionInterval` faz no Windows) — `OnCalendar=` é baseado em
 * calendário, não em "a partir de quando foi armado". A aproximação
 * declarativa usada aqui (`0/N:00:00`, múltiplos de N horas a partir da
 * meia-noite) preserva a MESMA cadência operacional (execução a cada N
 * horas, todo dia) — só a FASE inicial pode diferir em até N horas da hora
 * exata do primeiro `systemctl enable --now` (irrelevante pra tasks
 * idempotentes/best-effort como as 14 deste registro).
 */
export function scheduleToOnCalendar(schedule: ScheduledTaskSchedule): string {
  switch (schedule.kind) {
    case "daily":
      return `*-*-* ${pad2(schedule.hour)}:${pad2(schedule.minute)}:00`;
    case "weekly":
      return `${WEEKDAY_ABBR[schedule.dayOfWeek]} *-*-* ${pad2(schedule.hour)}:${pad2(schedule.minute)}:00`;
    case "interval":
      return `*-*-* 0/${schedule.hours}:00:00`;
    default: {
      const exhaustive: never = schedule;
      throw new Error(`schedule.kind desconhecido: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface SystemdUnitFiles {
  unitName: string;
  serviceFileName: string;
  timerFileName: string;
  serviceContent: string;
  timerContent: string;
}

/**
 * Gera o CONTEÚDO (texto) dos dois arquivos de unit pra uma task — não
 * escreve nada em disco (ver `scripts/setup-systemd-timers.ts` pro CLI que
 * escreve). `repoRootAbs` precisa ser um path ABSOLUTO — o
 * `WorkingDirectory=`/`ExecStart=` do systemd não resolve paths relativos ao
 * arquivo de unit.
 */
export function buildSystemdUnitFiles(task: ScheduledTaskDefinition, repoRootAbs: string): SystemdUnitFiles {
  const unitName = unitBaseName(task.name);
  const onCalendar = scheduleToOnCalendar(task.schedule);
  // Mesmo padrão de invocação de scripts/lib/task-runner.ts (execTsxStep):
  // node --import tsx, nunca `npx` bare resolvido via PATH (#4343) — mas
  // aqui o comando roda run-task.ts (que resolve e roda o próprio passo),
  // não o script do passo diretamente.
  const execStart = `${process.execPath} --import tsx ${repoRootAbs}/scripts/run-task.ts --task ${task.name}`;

  const serviceContent = [
    "[Unit]",
    `Description=diar.ia.br: ${task.description}`,
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${repoRootAbs}`,
    `ExecStart=${execStart}`,
    "",
  ].join("\n");

  const timerContent = [
    "[Unit]",
    `Description=diar.ia.br: ${task.description} (timer)`,
    "",
    "[Timer]",
    `OnCalendar=${onCalendar}`,
    // Equivalente ao StartWhenAvailable do Windows: se a máquina estava
    // desligada/dormindo no horário do disparo, roda assim que possível no
    // próximo boot/wake em vez de pular a execução perdida.
    "Persistent=true",
    `Unit=${unitName}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");

  return {
    unitName,
    serviceFileName: `${unitName}.service`,
    timerFileName: `${unitName}.timer`,
    serviceContent,
    timerContent,
  };
}
