/**
 * scripts/lib/edicao-systemd-units.ts (#4998, reativação do #2068/#3259)
 *
 * Gera o par de units systemd (`.service`/`.timer`) da edição diária agendada
 * (`scripts/overnight/run-scheduled-edicao.ts`) — mesmo PAPEL de
 * `scripts/lib/systemd-units.ts` (registry declarativo) e de
 * `scripts/lib/watchdog-systemd-units.ts`, mas deliberadamente FORA do
 * registro (`scripts/lib/scheduled-tasks.ts`) pelo mesmo motivo já
 * documentado ali pro watchdog e pra esta própria task: o runner invoca
 * `claude -p` diretamente, não o padrão `npx tsx <script>.ts` que o registry
 * modela.
 *
 * **Reativação (260811):** a task `Diaria-Edicao-Diaria` tinha sido
 * desregistrada em 260711 (#3259, decisão do editor). Reativada a pedido do
 * editor com dois ajustes: horário 16:00 (era 14:00) e um guard de
 * idempotência — se `data/editions/{AAMMDD}` já existe (edição já iniciada
 * manualmente ou por uma run anterior), o runner pula sem invocar `claude`
 * (ver docstring de `scripts/overnight/run-scheduled-edicao.ts`).
 *
 * @see scripts/overnight/setup-edicao-schedule-systemd.ts (CLI que consome este módulo — par Windows removido no #5115)
 * @see scripts/lib/systemd-units.ts (par genérico do registry — mesmo formato de saída)
 * @see scripts/overnight/run-scheduled-edicao.ts (script que os units invocam)
 * @see docs/scheduled-edicao-setup.md
 */
import { BRT_TIMEZONE } from "./next-edition-date.ts";
import type { SystemdUnitFiles } from "./systemd-units.ts";

/** Nome-base kebab-case do unit — mesmo valor que `unitBaseName("Diaria-Edicao-Diaria")`
 * (`scripts/lib/systemd-units.ts`) produziria, fixado aqui como literal pelo
 * mesmo motivo documentado em `WATCHDOG_UNIT_NAME`: a task não passa pelo
 * registry, então não vale a pena puxar `unitBaseName` só por essa constante.
 * `test/edicao-systemd-units.test.ts` trava a igualdade. */
export const EDICAO_UNIT_NAME = "diaria-edicao-diaria";

/**
 * `OnCalendar=` de domingo a quinta às 16:00 BRT (decisão do editor 260811 —
 * horário mudou de 14:00 pra 16:00 na reativação). Dias parametrizados como
 * lista `systemd.time(7)` (`Sun,Mon,Tue,Wed,Thu`) — ao contrário da janela do
 * watchdog, este calendário não cruza a meia-noite, então não precisa da
 * composição em dois ranges de hora.
 */
export function buildEdicaoOnCalendar(hour: number = 16, minute: number = 0): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `Sun,Mon,Tue,Wed,Thu *-*-* ${pad2(hour)}:${pad2(minute)}:00 ${BRT_TIMEZONE}`;
}

/**
 * Gera o CONTEÚDO (texto) dos dois arquivos de unit — não escreve nada em
 * disco (ver `scripts/overnight/setup-edicao-schedule-systemd.ts` pro CLI que
 * escreve). `repoRootAbs` precisa ser um path ABSOLUTO.
 *
 * `Type=oneshot` + `ExecStart=` chamando `run-scheduled-edicao.ts` DIRETO —
 * o script já é idempotente (skip-guard interno por `data/editions/{AAMMDD}`)
 * e sai rápido quando a edição do dia já foi iniciada, então disparar mesmo
 * quando o editor já rodou manualmente é barato e seguro.
 */
export function buildEdicaoSystemdUnitFiles(repoRootAbs: string): SystemdUnitFiles {
  const execStart = `${process.execPath} --import tsx ${repoRootAbs}/scripts/overnight/run-scheduled-edicao.ts`;
  const onCalendar = buildEdicaoOnCalendar();

  const serviceContent = [
    "[Unit]",
    "Description=diar.ia.br: edicao diaria agendada (#2068, reativada #3259->260811)",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${repoRootAbs}`,
    `ExecStart=${execStart}`,
    // O pipeline completo (Stages 0-4 + pré-render) tipicamente usa 50-90
    // turnos e pode levar horas — mesmo racional do --max-turns 120 do
    // runner (safety net, não expectativa normal). RuntimeMaxSec generoso
    // evita o systemd matar uma run legítima ainda em andamento.
    "TimeoutStartSec=10800",
    "",
  ].join("\n");

  const timerContent = [
    "[Unit]",
    "Description=diar.ia.br: edicao diaria agendada (#2068) (timer) — dom-qui 16:00 BRT",
    "",
    "[Timer]",
    `OnCalendar=${onCalendar}`,
    // Equivalente ao -StartWhenAvailable do Windows (setup-edicao-schedule.ps1):
    // se a máquina estava desligada/dormindo no horário do disparo, roda
    // assim que possível no próximo boot/wake em vez de pular o dia.
    //
    // CUIDADO AO MUDAR O HORÁRIO (#5140): o catch-up também dispara quando o
    // OnCalendar MUDA. Ao iniciar o timer, o systemd roda na hora se alguma
    // ocorrência cai em (carimbo, agora] — carimbo =
    // `~/.local/share/systemd/timers/stamp-<unit>.timer`. `stop` não consome
    // esse carimbo, então adiar o `start` não evita. Aqui isso é mais caro que
    // na média: o ExecStart invoca `claude -p` contra a pipeline de edição de
    // VERDADE. Este gerador fica fora do registry declarativo de propósito
    // (ver docstring do topo), então o aviso de `setup-systemd-timers.ts` não
    // é lido por quem mexe nesta task — daí a duplicação deste comentário.
    // Saída segura: rearmar antes da próxima ocorrência, ou `touch` no carimbo
    // antes do `start`. (A idempotência de `data/editions/{AAMMDD}/` limita o
    // dano, mas não é motivo pra disparar sem querer.)
    "Persistent=true",
    `Unit=${EDICAO_UNIT_NAME}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");

  return {
    unitName: EDICAO_UNIT_NAME,
    serviceFileName: `${EDICAO_UNIT_NAME}.service`,
    timerFileName: `${EDICAO_UNIT_NAME}.timer`,
    serviceContent,
    timerContent,
  };
}
