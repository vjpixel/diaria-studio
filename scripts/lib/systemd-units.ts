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

import { BRT_TIMEZONE } from "./next-edition-date.ts";
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
// Achado ao vivo (#4807, 260810): sem fuso explícito, o systemd interpreta
// OnCalendar= no fuso do SISTEMA (Etc/UTC em predator) -- as horas do
// registry são pensadas em BRT (mesma convenção do CLAUDE.md e dos .ps1
// legados no Windows). Sem isso, Diaria-Clarice-Sync (registry: 08:30)
// dispararia às 08:30 UTC = 05:30 BRT -- 30min ANTES do envio canônico das
// 06:00 BRT, reintroduzindo em silêncio a MESMA regressão que motivou mudar
// 03:40->08:30 no #2932. Mesmo problema bloquearia Diaria-Brevo-Diaria-
// Evaluate (precisa rodar ANTES das 06:00 BRT -- a Brevo congela
// destinatários no agendamento). scheduled-task-registration.test.ts não
// pega isso: ele valida o registry (correto), a informação de fuso se perde
// só aqui, na emissão do OnCalendar=.
//
// NÃO existe uma chave `Timezone=` separada em systemd.timer (achado ao
// vivo, primeira tentativa: systemd 259 ignora silenciosamente com um
// warning no journal, "Unknown key 'Timezone' in section [Timer]") -- o
// fuso é um campo OPCIONAL anexado ao final do próprio valor do calendário
// (systemd.time(7)): `OnCalendar=*-*-* HH:MM:00 America/Sao_Paulo`.
// Verificado com `systemd-analyze calendar` antes de fixar. BRT_TIMEZONE
// reusado de next-edition-date.ts -- não duplicar o literal.

export function scheduleToOnCalendar(schedule: ScheduledTaskSchedule): string {
  switch (schedule.kind) {
    case "daily":
      return `*-*-* ${pad2(schedule.hour)}:${pad2(schedule.minute)}:00 ${BRT_TIMEZONE}`;
    case "weekly":
      return `${WEEKDAY_ABBR[schedule.dayOfWeek]} *-*-* ${pad2(schedule.hour)}:${pad2(schedule.minute)}:00 ${BRT_TIMEZONE}`;
    case "monthly":
      // `day` é sempre 1-28 (ver docstring de ScheduledTaskSchedule) —
      // literal direto no calendário, sem aritmética de fim-de-mês.
      return `*-*-${pad2(schedule.day)} ${pad2(schedule.hour)}:${pad2(schedule.minute)}:00 ${BRT_TIMEZONE}`;
    case "interval":
      // Cadência "a cada Nh" (ver docstring da função abaixo) -- fuso não
      // afeta o intervalo em si (Nh depois de meia-noite é Nh depois de
      // meia-noite em qualquer fuso), mas anexar o mesmo BRT_TIMEZONE mantém
      // a âncora de "meia-noite" consistente com BRT, não UTC.
      return `*-*-* 0/${schedule.hours}:00:00 ${BRT_TIMEZONE}`;
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
    // Fuso já embutido no valor de onCalendar (ver scheduleToOnCalendar) --
    // não existe uma chave `Timezone=` separada em systemd.timer.
    `OnCalendar=${onCalendar}`,
    // Equivalente ao StartWhenAvailable do Windows: se a máquina estava
    // desligada/dormindo no horário do disparo, roda assim que possível no
    // próximo boot/wake em vez de pular a execução perdida.
    //
    // EFEITO COLATERAL no RE-ARME (#5140, visto ao vivo em 260812): "execução
    // perdida" inclui o caso em que o HORÁRIO mudou. A regra do systemd é
    // sobre o CARIMBO, não sobre o relógio: existe
    // `~/.local/share/systemd/timers/stamp-<unit>.timer`, cujo mtime é o
    // último disparo REAL, e ao iniciar o timer o systemd dispara na hora se
    // alguma ocorrência do OnCalendar cai no intervalo (carimbo, agora].
    // Confirmado ao vivo: stamp mtime == `LastTriggerUSec`.
    //
    // Duas consequências que não são óbvias e que a primeira versão deste
    // comentário errou (achado do code-review da PR #5145):
    //   - `stop` NÃO consome o carimbo. Adiar o `start` pro dia seguinte não
    //     evita nada — a ocorrência perdida continua devida e dispara na hora
    //     do `start`, seja ele quando for.
    //   - "Rearmar depois do horário novo" é o caso RUIM, não a fuga dele. Foi
    //     literalmente a sequência do incidente (horário novo 11:00, re-arme
    //     às 16:00 → disparou na hora).
    //
    // Pra task que só lê, o catch-up é ruído; pra `Diaria-Clarice-Novos`, que
    // manda e-mail e gasta crédito de MillionVerifier, é disparo REAL. As
    // saídas que funcionam estão na saída de `scripts/setup-systemd-timers.ts`
    // (rearmar antes da próxima ocorrência; usar o kill switch da task; ou
    // `touch` no carimbo antes do start).
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
