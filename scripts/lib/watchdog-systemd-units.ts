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
 *   1. **Cadência própria fora do schema**: roda a cada 10 min, o dia
 *      inteiro (desde o #10565 — antes era só entre 18:00 e 09:00, janela
 *      que cruzava a meia-noite e por isso não cabia no schema). Hoje a
 *      expressão até caberia num `interval` simples, mas migrar pro
 *      registry mexe nas outras tasks já modeladas
 *      (`buildSystemdUnitFiles`/`scheduleToOnCalendar`,
 *      `test/systemd-units.test.ts` com paridade travada) e no item 2 abaixo,
 *      que continua valendo — fora de escopo do #10565.
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
 * o systemd real de `300`, ver instruções da issue).
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
 * arriscar um import cycle (`check-watchdog-armed.ts` importa DESTE módulo —
 * `buildWatchdogOnCalendar`, #10571 — então este nunca pode importar aquele;
 * ver #4857 item 3).
 * `test/watchdog-systemd-units.test.ts` trava a igualdade com
 * `unitBaseName(WATCHDOG_TASK_NAME)` para nunca deixar os dois divergirem
 * em silêncio. */
export const WATCHDOG_UNIT_NAME = "diaria-overnight-watchdog";

/**
 * `OnCalendar=` do watchdog: a cada 10 min (padrão), **24h por dia** (#10565).
 *
 * Até o #10565 a expressão era `00..08,18..23:00/10:00` — janela 18:00→09:00
 * BRT herdada do #2688, da época em que o overnight só existia como rodada
 * aberta à mão no fim do dia. A cadeia noturna agendada (#10552,
 * `docs/overnight-nightly-chain.md`) roda `/diaria-overnight --agendado` sem
 * teto de horário, e uma rodada dessas pode passar das 09:00 (a 260611 durou
 * ~16h): com a janela antiga, um stall depois das 09:00 ficava sem detecção
 * externa até as 18:00.
 *
 * O sinal de "há rodada pra vigiar" nunca foi o relógio: é o próprio
 * `overnight-watchdog.ts` (`findActiveRun` — `plan.json` sem `report.md`,
 * com expiração de rodada abandonada `ABANDONED_RUN_MAX_AGE_MS`). Fora de
 * rodada o disparo é noop e barato, então tirar a janela só remove o ponto
 * cego, sem criar alarme novo.
 *
 * `intervalMinutes` é parametrizado só para testar a composição sem duplicar
 * o literal.
 */
export function buildWatchdogOnCalendar(intervalMinutes: number = 10): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `*-*-* *:00/${pad2(intervalMinutes)}:00 ${BRT_TIMEZONE}`;
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
    // #5114: mesmo racional de systemd-units.ts/edicao-systemd-units.ts --
    // `overnight-watchdog.ts` já se auto-carrega via `loadProjectEnv()`
    // (defense-in-depth pro caso comum: env var faltando é o que o watchdog
    // detecta em OUTRAS tasks, não em si mesmo), mas nenhum unit gerado neste
    // repo passava ambiente algum antes deste fix -- adicionar aqui mantém os
    // 3 geradores consistentes e cobre qualquer script que este watchdog vier
    // a invocar no futuro sem seu próprio loader.
    `EnvironmentFile=-${repoRootAbs}/.env`,
    `ExecStart=${execStart}`,
    "",
  ].join("\n");

  const timerContent = [
    "[Unit]",
    // Sufixo com intervalo/cobertura é literal (não derivado dos args de
    // buildWatchdogOnCalendar). Só serve pra `systemctl --user list-timers`/
    // journalctl ficarem auto-descritivos sem abrir a docs; se os defaults
    // de buildWatchdogOnCalendar() mudarem, atualizar este literal junto.
    // #10565: era "18:00-09:00 BRT" (janela antiga).
    "Description=diar.ia.br: watchdog de stall overnight (#2688) (timer) — a cada 10 min, 24h (#10565)",
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
    // consome, então adiar o `start` não evita; a receita segura é `stop` →
    // `touch` no carimbo → `daemon-reload` → `start` (touch + restart com o
    // timer ativo NÃO evita, #10619). Este gerador fica fora do
    // registry declarativo de propósito (ver docstring do topo), então quem mexe aqui não lê o aviso de
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
