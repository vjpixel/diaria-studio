/**
 * scripts/lib/watchdog-systemd-units.ts (#4857, épica #4798)
 *
 * Gera o par de units systemd (`.service`/`.timer`) do watchdog overnight
 * (#2688, `scripts/overnight-watchdog.ts`) — mesmo PAPEL de
 * `scripts/lib/systemd-units.ts` (#4805 Fase 3), mas deliberadamente FORA do
 * registro declarativo (`scripts/lib/scheduled-tasks.ts`).
 *
 * **Decisão (#4857 item 2): fica fora do registry — não generaliza o schema.**
 * O watchdog tem duas características que `ScheduledTaskSchedule` (hoje só
 * `daily` / `weekly` / `interval` simples, ver `scheduled-tasks.ts`) não
 * modela:
 *
 *   1. **Cadência com JANELA**: roda a cada 10 min, mas só entre 18:00 e
 *      09:00 do dia seguinte — fora da janela não há trigger nenhum (não é
 *      "roda e sai cedo se não houver rodada ativa", é "não dispara"). Nenhum
 *      dos 3 `kind`s existentes expressa uma janela horária que cruza a
 *      meia-noite; generalizar o schema pra isso mexe nas outras 14 tasks já
 *      modeladas (`buildSystemdUnitFiles`/`scheduleToOnCalendar`,
 *      `test/systemd-units.test.ts` com paridade travada) por um ganho que
 *      serve UMA task — risco desnecessário fora do escopo desta issue.
 *   2. **Invocação direta** de `overnight-watchdog.ts`, sem passar por
 *      `run-task.ts`/o formato de log padronizado de `task-runner.ts` — a
 *      mesma exceção já documentada em `scheduled-tasks.ts` (linhas 20-28)
 *      desde o #4805, nunca revisitada até aqui.
 *
 * A mesma decisão foi tomada AO VIVO no arme manual desta máquina (260810,
 * ver comentário de fechamento da issue #4857): unit/timer avulsos
 * diretamente em `~/.config/systemd/user/`, sem passar pelo registry, com
 * `ExecStart=` chamando o script direto. Este módulo só GERA o texto
 * equivalente de forma reproduzível/testável (mesmo padrão de
 * `buildSystemdUnitFiles`) — não substitui nem reconcilia o que já foi
 * armado manualmente nesta máquina (fora de escopo desta unidade: não tocar
 * o systemd real de `predator`, ver instruções da issue).
 *
 * @see scripts/overnight/setup-watchdog-schedule-systemd.ts (CLI que consome este módulo — par Windows removido no #5115)
 * @see scripts/lib/systemd-units.ts (par genérico do registry — mesmo formato de saída)
 * @see scripts/overnight-watchdog.ts (#2688 — script que os units invocam)
 */
import { BRT_TIMEZONE } from "./next-edition-date.ts";
import type { SystemdUnitFiles } from "./systemd-units.ts";

/** Nome-base kebab-case do unit — mesmo valor que `unitBaseName("Diaria-Overnight-Watchdog")`
 * (`scripts/lib/systemd-units.ts`) produziria, mas fixado aqui como literal
 * porque o watchdog não passa pelo registry (`ScheduledTaskDefinition`) que
 * `unitBaseName` deriva — evita puxar `check-watchdog-armed.ts` (que É a
 * fonte do literal `"Diaria-Overnight-Watchdog"`) só por essa constante e
 * arriscar um import cycle (`check-watchdog-armed.ts` importa deste módulo
 * indiretamente via `systemd-units.ts`/`unitBaseName` — ver #4857 item 3).
 * `test/watchdog-systemd-units.test.ts` trava a igualdade com
 * `unitBaseName(WATCHDOG_TASK_NAME)` para nunca deixar os dois divergirem
 * em silêncio. */
export const WATCHDOG_UNIT_NAME = "diaria-overnight-watchdog";

/**
 * `OnCalendar=` da janela 18:00→09:00 BRT, a cada 10 min por padrão — MESMA
 * expressão validada AO VIVO no arme manual desta máquina (260810,
 * comentário de fechamento do #4857: `systemctl --user enable --now` + run
 * de teste confirmaram exit 0 e log real:
 * `[watchdog] Rodada 260810 ativa, sem stall (1/60 min).`).
 *
 * `windowStartHour`/`windowEndHour`/`intervalMinutes` são parametrizados (não
 * hardcoded na string final) só para permitir testar a COMPOSIÇÃO sem
 * duplicar o literal mágico — os defaults reproduzem exatamente
 * `00..08,18..23:00/10:00`, a mesma janela do #2688 original (18:00 do dia D
 * até 09:00 do dia D+1, ver `setup-watchdog-schedule.ps1`: `-Daily -At 18:00`
 * + repetição de 10 min por 15 h).
 *
 * `systemd.time(7)` não tem sintaxe de "hora de ontem à noite até hoje de
 * manhã" num único intervalo contínuo — a janela que cruza a meia-noite é
 * expressa como DOIS ranges de hora dentro do MESMO dia calendário
 * (`00..(windowEndHour-1)` cobre a madrugada até o fim da janela;
 * `windowStartHour..23` cobre a noite até o início dela) — exatamente como
 * `systemd.time(7)` já resolve isso pra qualquer horário do dia em que o
 * timer estiver "ligado".
 */
export function buildWatchdogOnCalendar(
  windowStartHour: number = 18,
  windowEndHour: number = 9,
  intervalMinutes: number = 10,
): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const morningEndHour = windowEndHour - 1;
  const hours = `${pad2(0)}..${pad2(morningEndHour)},${pad2(windowStartHour)}..23`;
  return `*-*-* ${hours}:00/${pad2(intervalMinutes)}:00 ${BRT_TIMEZONE}`;
}

/**
 * Gera o CONTEÚDO (texto) dos dois arquivos de unit do watchdog — não
 * escreve nada em disco (ver `scripts/overnight/setup-watchdog-schedule-systemd.ts`
 * pro CLI que escreve). `repoRootAbs` precisa ser um path ABSOLUTO — o
 * `WorkingDirectory=`/`ExecStart=` do systemd não resolve paths relativos ao
 * arquivo de unit (mesmo requisito de `buildSystemdUnitFiles`).
 *
 * `Type=oneshot` + `ExecStart=` chamando `overnight-watchdog.ts` DIRETO
 * (nunca via `run-task.ts`, ver decisão no topo do módulo) — o script já é
 * idempotente e sai imediatamente quando não há rodada ativa (ver docstring
 * de `overnight-watchdog.ts`), então rodar a cada 10 min mesmo fora de uma
 * rodada overnight é barato e seguro.
 */
export function buildWatchdogSystemdUnitFiles(repoRootAbs: string): SystemdUnitFiles {
  const execStart = `${process.execPath} --import tsx ${repoRootAbs}/scripts/overnight-watchdog.ts`;
  const onCalendar = buildWatchdogOnCalendar();

  const serviceContent = [
    "[Unit]",
    "Description=diar.ia.br: watchdog de stall overnight (#2688)",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${repoRootAbs}`,
    `ExecStart=${execStart}`,
    "",
  ].join("\n");

  const timerContent = [
    "[Unit]",
    // Sufixo com janela/intervalo é literal (não derivado dos args de
    // buildWatchdogOnCalendar) — reproduz a Description já usada no arme
    // manual desta máquina (260810, reconciliação #4857). Só serve pra
    // `systemctl --user list-timers`/journalctl ficarem auto-descritivos sem
    // abrir a docs; se os defaults de buildWatchdogOnCalendar() mudarem,
    // atualizar este literal junto.
    "Description=diar.ia.br: watchdog de stall overnight (#2688) (timer) — a cada 10 min, 18:00-09:00 BRT",
    "",
    "[Timer]",
    // Fuso já embutido no valor de onCalendar (mesmo achado ao vivo do
    // #4807 pro resto do registry) — não existe uma chave `Timezone=`
    // separada em systemd.timer.
    `OnCalendar=${onCalendar}`,
    // Equivalente ao StartWhenAvailable do Windows (setup-watchdog-schedule.ps1):
    // se a máquina estava desligada/dormindo no horário do disparo, roda
    // assim que possível no próximo boot/wake em vez de pular a execução.
    //
    // CUIDADO AO MUDAR O HORÁRIO/JANELA (#5140): o catch-up também dispara
    // quando o OnCalendar MUDA. Ao iniciar o timer, o systemd roda na hora se
    // alguma ocorrência cai em (carimbo, agora] — carimbo =
    // `~/.local/share/systemd/timers/stamp-<unit>.timer`; `stop` não o
    // consome, então adiar o `start` não evita. Este gerador fica fora do
    // registry declarativo de propósito (a janela cruza a meia-noite, ver
    // docstring do topo), então quem mexe aqui não lê o aviso de
    // `setup-systemd-timers.ts` — daí a duplicação. Menos grave que nas
    // demais (o watchdog só inspeciona estado), mas o mecanismo é o mesmo.
    "Persistent=true",
    `Unit=${WATCHDOG_UNIT_NAME}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");

  return {
    unitName: WATCHDOG_UNIT_NAME,
    serviceFileName: `${WATCHDOG_UNIT_NAME}.service`,
    timerFileName: `${WATCHDOG_UNIT_NAME}.timer`,
    serviceContent,
    timerContent,
  };
}
