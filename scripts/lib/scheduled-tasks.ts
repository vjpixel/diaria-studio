/**
 * scripts/lib/scheduled-tasks.ts (#4805 Fase 1, épica #4798)
 *
 * Registro DECLARATIVO das tasks agendadas locais do repo — fonte única de
 * verdade que `scripts/lib/task-runner.ts` (Fase 2) executa e
 * `scripts/setup-systemd-timers.ts` (Fase 3) usa pra gerar units systemd.
 *
 * **Por que este arquivo existe:** até o #4805, a lista de tasks vivia
 * implicitamente espalhada em 14 pares `scripts/run-*.ps1` +
 * `scripts/setup-*-schedule.ps1`, cada um repetindo o mesmo molde (script(s)
 * `npx tsx`, log path, cadência, guard opcional) em PowerShell. Este registro
 * inverte isso: os dados vivem aqui, tipados, uma vez.
 *
 * **Escopo — 14 tasks (13 na abertura da #4805, +1 com o `#4755` mergeado
 * antes desta unidade):** todas as tasks cujo wrapper `.ps1` (removido no
 * #5115, cutover final — ver abaixo) rodava um ou mais scripts `.ts` via
 * `npx tsx` e logava em `data/`. Fora do escopo (não migradas, não modeladas
 * aqui): `Diaria-Overnight-Watchdog` (invoca `overnight-watchdog.ts` direto
 * do agendador, sem wrapper intermediário) e `Diaria-Edicao-Diaria` (invoca
 * `claude -p`, um processo completamente diferente de `npx tsx`; além disso
 * desregistrada por decisão do editor desde 260711, #3259).
 *
 * **`Diaria-Node-Modules-Health-Check` (#6030) também fica de fora, por
 * desenho, não por esquecimento (#6774/#6658):** o unit
 * (`scripts/systemd/diaria-node-modules-health-check.{service,timer}`,
 * `scripts/systemd/node-modules-health-check.sh`) é SHELL PURO de propósito
 * — sua razão de existir é detectar quando `node_modules`/`tsx` deste
 * checkout está quebrado, e um `ScheduledTaskStep` deste registro só sabe
 * invocar `.ts` via `node --import tsx` (`task-runner.ts`). Colocar este
 * script no registro faria seu próprio executor depender exatamente do
 * componente que ele existe pra vigiar — se `node_modules` quebrar, o check
 * quebraria junto, o modo de falha oposto ao que o #6030 corrigiu. Cadência
 * de 15 minutos também não cabe em `ScheduledTaskSchedule.interval`, que só
 * expressa múltiplos de HORA inteira (ver `scheduleToOnCalendar` em
 * `systemd-units.ts`). Mesma dupla exclusão-por-schema de
 * `Diaria-Overnight-Watchdog` acima — ambas ficam de fora do registro E na
 * allowlist `KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES`
 * (`scripts/lib/task-never-armed-alarm.ts`), pra `Diaria-Task-Never-Armed-Alarm`
 * não alarmar "timer órfão" sobre uma exclusão documentada e intencional.
 *
 * **`diaria-gdrive-bisync` (#12356) e `diaria-gdrive-data-bisync` (#12478)
 * também ficam de fora pelo mesmo motivo de schema:** shell puro que chama o
 * `rclone bisync` (`scripts/systemd/gdrive-bisync.sh`, e o wrapper
 * `gdrive-data-bisync.sh` do bisync dedicado de `data/`), com cadência de
 * 1-2 min (`OnUnitInactiveSec`) que `ScheduledTaskSchedule` não expressa. As
 * units vivem em `scripts/systemd/` e o registro operacional em
 * `docs/scheduled-tasks-registry.md` (estado de instalação do
 * `diaria-gdrive-data-bisync`: ver o registro). O alarme dos dois é a task
 * `Diaria-GDrive-Sync-Alarm` abaixo.
 *
 * **`diaria-infra-300-heartbeat` (#12981, #13974) também fica de fora:**
 * cadência de 5 min que `ScheduledTaskSchedule` não expressa e, de propósito,
 * sem auto-arme (precisa das credenciais do KV `diaria-ops-state`). Templates
 * em `infra/infra-300-heartbeat/`, instalados à mão no 300; está na
 * allowlist `KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES` pelo mesmo motivo das demais.
 *
 * **A tabela `SCHEDULED_TASKS` mora em `scripts/lib/scheduled-tasks-table.ts`
 * desde o #14121** (só dados; este arquivo guarda os tipos, os helpers e o
 * CLI, e re-exporta a tabela). Adicionar ou mudar uma task é lá.
 *
 * **Este arquivo NÃO executa nenhuma task** — é o schema (tipos), os helpers
 * de consulta e o CLI `--list`/`--json`/`--desktop`; os dados são a tabela
 * acima. Execução é
 * `scripts/lib/task-runner.ts` (`runScheduledTask`); geração de units
 * systemd é `scripts/lib/systemd-units.ts` + `scripts/setup-systemd-timers.ts`.
 *
 * **Cutover final (#5115, 260812):** os 40 `.ps1` (`scripts/run-*.ps1`,
 * `scripts/setup-*-schedule.ps1`) foram removidos do repo — decisão explícita
 * do editor confirmando que nenhuma máquina Windows roda mais tasks
 * `Diaria-*` (política de 260811, #5074) e que todas já têm contraparte
 * systemd equivalente. A via de execução real é exclusivamente o par
 * `.service`/`.timer` gerado por `scripts/setup-systemd-timers.ts` a partir
 * deste registro.
 *
 * @see scripts/lib/scheduled-tasks-table.ts (a tabela SCHEDULED_TASKS, #14121)
 * @see scripts/lib/task-runner.ts (Fase 2 — executor)
 * @see scripts/run-task.ts (Fase 2 — entrypoint CLI)
 * @see scripts/lib/systemd-units.ts + scripts/setup-systemd-timers.ts (Fase 3)
 * @see docs/scheduled-tasks-registry.md (prosa operacional) — `--list`/`--json`
 *   abaixo (#5408) são a enumeração PROGRAMÁTICA, fonte pra quem precisa da
 *   lista completa sem depender de grep truncável.
 */

import { isMainModule, parseArgs } from "./cli-args.ts";
import { SCHEDULED_TASKS } from "./scheduled-tasks-table.ts";

/** Dias da semana aceitos por um schedule `weekly` — mesmo vocabulário do
 * `-DaysOfWeek` do PowerShell (`New-ScheduledTaskTrigger -Weekly`). */
export type WeekDay = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";

/**
 * Cadência declarativa de uma task. Espelha os 3 padrões usados pelos
 * `setup-*-schedule.ps1` legados do repo (removidos no #5115), mais `monthly`
 * (#5128/#5130 — 1ª task deste registro sem contraparte Windows de
 * propósito, mesmo caso de `Diaria-Home-Meta-Check` #5005: nasceu
 * depois do cutover systemd, então não precisou de tradução PowerShell):
 *   - `daily`   → `OnCalendar=*-*-* HH:MM:00` (systemd)
 *   - `weekly`  → `OnCalendar=D *-*-* HH:MM:00` (systemd)
 *   - `monthly` → `OnCalendar=*-*-DD HH:MM:00` (systemd). `day` fica
 *     restrito a 1-28 (validado em `scheduled-tasks.test.ts`) — todo mês do
 *     calendário tem um dia 1-28, então a cadência nunca pula um mês por
 *     falta de dia 29/30/31 (fevereiro).
 *   - `interval`→ `OnCalendar=*-*-* 0/N:00:00` (systemd — múltiplos de N
 *     horas a partir da meia-noite, ver `scheduleToOnCalendar` pro porquê
 *     dessa aproximação em vez de "a partir de quando foi armado").
 */
export type ScheduledTaskSchedule =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; dayOfWeek: WeekDay; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "interval"; hours: number };

/**
 * Guard opcional rodado ANTES de qualquer step (achado HIGH do review #4552,
 * `Diaria-Brevo-Diaria-Evaluate` foi a 1ª): abortar sem rodar nada quando um
 * arquivo esperado (tipicamente um store que o junction `data/` do OneDrive
 * ainda não sincronizou) está ausente, pra não gravar um estado vazio por
 * cima de dado real. Várias tasks já usam este guard (Clarice-Novos,
 * Clarice-Envio, entre outras) — checar `guard?` em cada entrada, não contar
 * com uma lista fixa aqui.
 */
export interface ScheduledTaskGuard {
  /** Path relativo a `data/` (POSIX), checado com `existsSync` — MESMA
   * convenção de `ScheduledTaskDefinition.logPath` (implicitamente
   * `data/`-relative, nunca inclua o prefixo `data/` aqui). Resolvido pelo
   * runner como `join(rootDir, "data", ...requiredFile.split("/"))`. */
  requiredFile: string;
  /** Mensagem logada (prefixo "AVISO: ") quando o guard aborta a run. */
  abortMessage: string;
}

export interface ScheduledTaskStep {
  /** Chave curta do passo — aparece no rodapé do log (`key=<exitcode>`) e
   * identifica o passo em `ScheduledTaskRunResult.steps`. */
  key: string;
  /** Path do script `.ts` relativo à raiz do repo (POSIX), invocado via
   * `node --import tsx` (ver docstring de task-runner.ts pro porquê de não
   * ser `npx tsx`). */
  script: string;
  /** Argumentos CLI estáticos. O token literal `"{tempLogPath}"` é
   * substituído pelo runner com o path absoluto do log temporário DESTA run
   * — usado por `extract-opens-catchup-status.ts` pra ler só a saída dos
   * passos anteriores desta mesma execução (#4740), não o log final
   * acumulado de runs passadas. */
  args?: string[];
  /** Passo best-effort: um exit ≠ 0 não reprova o exit code final da task
   * (ex: `extract-opens-catchup-status.ts`, que já sai sempre 0 por design,
   * mas é marcado aqui como defesa em profundidade). Default `false`. */
  bestEffort?: boolean;
}

export interface ScheduledTaskDefinition {
  /** Nome exato da task no Task Scheduler (Windows) — também o valor de
   * `--task` em `run-task.ts` e a base do nome do unit systemd gerado. */
  name: string;
  /** Descrição de 1 linha — vira o cabeçalho do log (`===== <ts> - <descr> =====`)
   * e o `Description=` dos units systemd gerados. */
  description: string;
  /** Passos executados em sequência, sempre (nenhum passo cancela os
   * seguintes — mesmo comportamento dos `run-*.ps1` legados multi-passo
   * (removidos no #5115): o antigo `run-clarice-sync-daily.ps1` sempre rodava
   * os 3 passos, mesmo se o passo 1 falhasse). */
  steps: ScheduledTaskStep[];
  /** Path do log final, relativo a `data/` (POSIX) — ex:
   * `"apoia-se/.diff-alarm.log"` → `data/apoia-se/.diff-alarm.log`. */
  logPath: string;
  schedule: ScheduledTaskSchedule;
  guard?: ScheduledTaskGuard;
  /** Exit codes ALÉM de 0 que representam sucesso (ou "resultado ambíguo
   * normal", não uma falha) desta task — viram `SuccessExitStatus=` no
   * unit `.service` gerado (`scripts/lib/systemd-units.ts`), pra
   * `systemctl --user list-units --state=failed` (consumido por
   * `scripts/systemd-failed-units-alarm.ts`) não marcar a unit como
   * `failed` nesses casos. **#5743 (atual):** `Diaria-Clarice-Novos`/`-Tarde`
   * usam `[3]` — `clarice-novos-run.ts` sai com exit 3 quando o POST
   * `sendNow` é ACEITO pela Brevo mas o GET-verify pós-disparo não confirma
   * status terminal dentro da janela de retry (lag assíncrono normal, não
   * indício de falha — `NOVOS_SENDNOW_UNCERTAIN_EXIT_CODE`). **Histórico
   * (#5615/#5592, removido no #5660):** o valor 3 já foi usado antes com
   * outro significado (abort do semáforo D4, guard hoje removido) — os dois
   * usos nunca coexistiram. Default (campo ausente): só 0 é sucesso. */
  successExitCodes?: number[];
  /** #13017 — re-executa a unit quando a rodada falhou SÓ por rede (DNS,
   * conexão, `fetch failed`, `gh` sem rede). O runner sai com
   * `TRANSIENT_NETWORK_EXIT_CODE` nesse caso e o `.service` gerado leva
   * `RestartForceExitStatus=` + `RestartSec=15min` + teto de partidas (~4h
   * de tentativas, ver `scripts/lib/transient-network-failure.ts`). Qualquer
   * outra falha segue sem retry. Só para task diária/semanal/mensal cujos
   * passos possam rodar de novo sem efeito duplicado (leitura, sync, alarme):
   * task `interval` já tenta de novo na própria cadência, e o gerador
   * recusa a combinação. Task que ENVIA (e-mail, conversão) só entra com a
   * idempotência comprovada no próprio script, registrada num comentário na
   * entrada (decisão do editor 15/11/2026): hoje só `Diaria-Clarice-Novos`
   * e `-Tarde`. `Diaria-Onboarding-Welcome-Run` e
   * `Diaria-Google-Ads-Confirmations-Upload` ficam fora: resposta perdida
   * num POST que saiu pode reenviar (motivo em
   * `test/transient-network-retry-13017.test.ts`). Default (ausente): sem
   * retry.
   *
   * `true`: o runner classifica pela saída de cada passo que falhou.
   * `"step-declares"` (#13098): o script sai ele mesmo com
   * `TRANSIENT_NETWORK_EXIT_CODE` quando a falha foi só de rede, e o runner
   * nunca reclassifica a saída (`resolveStepDeclaredExitCode`). É o modo de
   * task que envia: só o script sabe se a falha veio antes ou depois de o
   * envio começar. */
  retryOnTransientNetwork?: boolean | "step-declares";
  /** Issue(s) de origem, só pra rastreabilidade em docs/erros. */
  issue: string;
  /** #5639 — enable/disable da task sem remover do registro.
   *  Default (campo ausente): `true` — task roda normalmente.
   *  Quando `false`, o runner pula a execução (exit 0, loga "SKIP: task disabled")
   *  e o gerador de units systemd NÃO cria `.service`/`.timer` para ela. */
  enabled?: boolean;
  /** #12982 — tier de contingência quando o `300` cai (ver `FailoverTier`).
   * Opcional no tipo base só para fixtures de teste; no registro
   * (`SCHEDULED_TASKS`, tipado como `RegisteredScheduledTaskDefinition`) é
   * obrigatório, e `test/scheduled-tasks-failover-tier-12982.test.ts` trava
   * isso também em runtime. Ausente = `skip` (`resolveFailoverTier`). */
  failover?: FailoverTier;
}

/**
 * #12982 — o que acontece com a task enquanto o `300` está fora do ar.
 *
 * Exceção TEMPORÁRIA e explícita à política do #5074 (nenhuma task
 * `Diaria-*` roda no Windows): durante a queda, o Neo assume só o tier
 * `critical`, por `scripts/failover/neo-takeover.ts --arm`, e devolve no
 * `--disarm`. Runbook: `docs/failover-neo.md`.
 *
 *   - `critical`: horário público ou envio a terceiros, perda visível ao
 *     leitor e irreversível (publicação de Short, envio Clarice/Stack/boas-vindas).
 *     Roda no Neo durante a queda, sob o lease anti-duplicação
 *     (`scripts/lib/failover/scheduler-lease.ts`).
 *   - `catchup`: sync, snapshot, ingest ou upload que recupera o atraso
 *     sozinho quando o `300` volta. Não roda no Neo.
 *   - `skip`: alarme, drift, staleness, higiene. Fica parado durante a queda;
 *     nada a recuperar. Default de task nova.
 */
export type FailoverTier = "critical" | "catchup" | "skip";

export const FAILOVER_TIERS: readonly FailoverTier[] = ["critical", "catchup", "skip"];

/** Task como ela entra no registro: `failover` obrigatório (#12982). */
export type RegisteredScheduledTaskDefinition = ScheduledTaskDefinition & { failover: FailoverTier };

/** Tier efetivo de uma definição (`skip` quando ausente — só fixtures). */
export function resolveFailoverTier(def: Pick<ScheduledTaskDefinition, "failover">): FailoverTier {
  return def.failover ?? "skip";
}

// #14121: a tabela e as constantes que ela usa moram em
// `scheduled-tasks-table.ts` (arquivo só de dados). Re-exportadas aqui para
// todo consumidor seguir importando deste módulo.
export {
  SCHEDULED_TASKS,
  GSC_URL_INSPECTION_DAILY_QUOTA,
  GOOGLE_ADS_CONFIRMATION_ACTION_ID,
  GOOGLE_ADS_CONFIRMATION_CUSTOMER_ID,
} from "./scheduled-tasks-table.ts";

/**
 * Nomes de tasks deliberadamente REMOVIDAS deste registro, mas cujo unit
 * systemd (`.service`/`.timer`) ainda pode estar ativo numa máquina até a
 * limpeza manual do editor acontecer (#5733) — a remoção do registro em si
 * não desarma o timer instalado. `run-task.ts` consulta este set para tratar
 * uma invocação com um desses nomes como no-op explícito (exit 0, log
 * informativo) em vez de "task desconhecida" (exit 1) — que é o tratamento
 * certo só para typo/nome que nunca existiu.
 *
 * - `"Diaria-Clarice-Novos-Abort-Alarm"` — removida no #5660 (o guard D4 que
 *   produzia `semaphore-red` foi retirado do caminho `clarice-novos`, então
 *   o alarme não tem mais estado pra ler). `scripts/clarice-novos-abort-alarm.ts`
 *   já é dormente por si só; o problema fechado aqui (#5733) é anterior a
 *   isso — `run-task.ts` nem chegava a invocar esse script, porque a
 *   resolução do NOME já falhava em `getScheduledTaskByName`. A limpeza do
 *   unit systemd em si (`~/.config/systemd/user/diaria-clarice-novos-abort-alarm.{service,timer}`
 *   + mirror `.systemd-units/`) continua pendente como ação manual do
 *   editor — isto só faz o exit code parar de falhar todas as noites.
 * - `"Diaria-Microsoft-Ads-Editorial-Reasons"` — removida no #10148 (decisão
 *   do editor no briefing overnight 261014): o timer já estava parado à mão
 *   na `300` (`ActiveState=inactive`) e a task não fazia mais sentido. O CLI
 *   e o núcleo SOAP ficaram no repo para uso manual até o #10755, que
 *   encerrou o canal Microsoft Ads e removeu os dois. A limpeza do unit
 *   `diaria-microsoft-ads-editorial-reasons.{service,timer}` na `300` é ação
 *   manual do editor; até lá, um disparo acidental vira no-op aqui.
 * - `"Diaria-Microsoft-Ads-Spend-Ingest"` — removida no #10755 (decisão do
 *   editor, 21/10/2026: o canal Microsoft Ads foi encerrado depois do teste
 *   2608; ver `docs/microsoft-ads-encerramento.md`). O script de ingestão
 *   saiu do repo junto. O gasto já gravado em `data/aquisicao/spend.csv`
 *   continua sendo lido pelo relatório de CAC e pela apuração do teste.
 *   Desarmar `diaria-microsoft-ads-spend-ingest.{service,timer}` na `300` é
 *   ação manual do editor; até lá, o disparo diário vira no-op aqui.
 * - `"Diaria-Kit-Subscriber-Sync"` — removida no #11225 (decisão do editor,
 *   28/10/2026: a Beehiiv é só arquivo histórico). Rodava
 *   `sync-beehiiv-subscribers-kit.ts --push` (ponte Beehiiv -> Kit, #6093),
 *   removido junto; a auto-confirmação de `evaluate-brevo-diaria.ts`, último
 *   caminho que dependia dele, passou a escrever direto no Kit. Desarmar
 *   `diaria-kit-subscriber-sync.{service,timer}` na `300` é ação manual;
 *   até lá, o disparo diário vira no-op aqui.
 * - `"Diaria-Video-Bruto-Archive"` — removida no #14292 (decisão do editor,
 *   27/11/2026: com o plano novo do Google Drive, o arquivamento diário dos
 *   brutos e finais de vídeo do Drive para o HD do `300` deixou de ser
 *   necessário). Rodava `scripts/archive-video-brutos.ts --apply` todo dia às
 *   03:00 BRT (#12548, #13631); o script fica no repo para rodar à mão, e o
 *   que já foi arquivado em `/mnt/hd-sata/arquivo-video` fica lá. Desarmar
 *   `diaria-video-bruto-archive.{service,timer}` na `300` é ação manual pós-
 *   merge; até lá, o disparo diário vira no-op aqui.
 */
export const RETIRED_TASK_NAMES: ReadonlySet<string> = new Set([
  "Diaria-Clarice-Novos-Abort-Alarm",
  "Diaria-Microsoft-Ads-Editorial-Reasons",
  "Diaria-Microsoft-Ads-Spend-Ingest",
  "Diaria-Kit-Subscriber-Sync",
  "Diaria-Video-Bruto-Archive",
]);

/** `true` quando `name` é uma task retirada conhecida (ver `RETIRED_TASK_NAMES`). */
export function isRetiredTaskName(name: string): boolean {
  return RETIRED_TASK_NAMES.has(name);
}

/** Busca uma task pelo nome exato (`ScheduledTaskDefinition.name`). */
export function getScheduledTaskByName(name: string): ScheduledTaskDefinition | undefined {
  return SCHEDULED_TASKS.find((t) => t.name === name);
}

/** Lista os nomes de todas as tasks do registro, na ordem declarada. */
export function listScheduledTaskNames(): string[] {
  return SCHEDULED_TASKS.map((t) => t.name);
}

/**
 * Nomes das tasks marcadas `enabled: false` — desarmadas de propósito por
 * decisão do editor (ex: `Diaria-Sunset-Weekly`, #5807), não "esquecidas".
 * `Diaria-Task-Never-Armed-Alarm` (#6773) usa isto pra excluir estas tasks
 * da checagem "nunca armada": `setup-systemd-timers.ts` já pula de propósito
 * a geração de `.service`/`.timer` pra elas (ver docstring de
 * `ScheduledTaskDefinition.enabled` acima), então nenhum timer armado pra
 * uma task aqui listada é o comportamento CORRETO, não um drift a alarmar.
 * Reaproveita o campo `enabled` já existente (consumido pelo runner e pelo
 * gerador de units) em vez de introduzir um 2º campo redundante só pro
 * alarme — mesmo sinal, dois consumidores.
 */
export function listDisabledScheduledTaskNames(): string[] {
  return SCHEDULED_TASKS.filter((t) => t.enabled === false).map((t) => t.name);
}

// ---------------------------------------------------------------------------
// Tasks LOCAIS do app Claude desktop (#10811)
//
// Fora de `SCHEDULED_TASKS` de propósito: não são `.ts` rodados pelo
// `task-runner.ts` nem viram unit systemd — são sessões do Claude criadas pelo
// MCP `scheduled-tasks` do app desktop numa máquina específica (hoje só o Neo,
// onde está o Chrome logado). Colocá-las em `SCHEDULED_TASKS` faria o
// `setup-systemd-timers.ts` gerar unit pro `300` e o
// `Diaria-Task-Never-Armed-Alarm` alarmar "nunca armada". O registro aqui é a
// definição versionada (nome, cron, prompt) que o coordenador usa pra criar ou
// recriar a task; o prompt é um PONTEIRO pro roteiro no repo, nunca a cópia
// (padrão do `relatorio-diario-teste-2608`, #8246). Desde #11779 (todo
// agendamento no `300`, decisão do editor de 01/11/2026) cada entrada carrega
// `serverException`: o motivo de não rodar no `300` e quando foi reconferido.
// ---------------------------------------------------------------------------

export interface DesktopScheduledTaskDefinition {
  /** `taskId` do MCP scheduled-tasks (diretório em `~/.claude/scheduled-tasks/`). */
  readonly taskId: string;
  /** Nome exibido na lista de tasks do app. */
  readonly title: string;
  readonly description: string;
  /** Máquina onde a task existe — o app só roda tasks com ele aberto. */
  readonly machine: "neo";
  /** Cron de 5 campos no fuso LOCAL da máquina (Neo = BRT). */
  readonly cronExpression: string;
  /** Roteiro canônico no repo (path POSIX relativo à raiz). */
  readonly playbook: string;
  /**
   * Prompt passado ao `create_scheduled_task`. Cada execução começa sem
   * memória, então ele se sustenta sozinho no que importa (checkout, regras
   * duras), mas os PASSOS ficam no `playbook` — o prompt aponta, não copia.
   */
  readonly prompt: string;
  readonly issue: string;
  /**
   * Por que esta task NÃO roda no `300` (#11779). Desde 01/11/2026 todo
   * agendamento acontece no `300`, decisão do editor; task local do app só
   * existe como exceção justificada, com a decisão que a manteve e a data da
   * última vez que alguém conferiu se o motivo ainda vale.
   */
  readonly serverException: {
    /** O que o `300` não tem (ex.: Chrome logado) e por que não há caminho sem ele. */
    readonly reason: string;
    /** Issue onde o editor decidiu manter a exceção. */
    readonly decidedIn: string;
    /** Data (AAAA-MM-DD) da última reconferência do motivo. */
    readonly reviewedOn: string;
  };
}

export const DESKTOP_SCHEDULED_TASKS: readonly DesktopScheduledTaskDefinition[] = [
  {
    taskId: "diaria-short-video-relacionado",
    title: "diar.ia.br: vídeo relacionado do Short",
    description: "Vincula o horizontal da edição como vídeo relacionado do Short no YouTube Studio (#10811)",
    machine: "neo",
    // Dias úteis (só há edição de segunda a sexta), 06:05 BRT: logo depois de
    // o horizontal publicar (06:00) e antes do slot mais cedo do Short (06:30,
    // `publishing.shorts.schedule.rotation_times`). O `wait` do plano cobre o
    // atraso do YouTube e os minutos que o app soma ao cron.
    cronExpression: "5 6 * * 1-5",
    playbook: ".claude/skills/diaria-publica-video/short-related-task.md",
    prompt: [
      "Task diária da diar.ia.br (#10811): vincular o vídeo horizontal da edição de hoje como \"vídeo relacionado\" do Short no YouTube Studio do canal @diariabr.",
      "",
      "Trabalhe no checkout C:\\Users\\vjpix\\Projects\\diaria-studio (todos os comandos a partir dele). Leia o arquivo .claude/skills/diaria-publica-video/short-related-task.md inteiro e siga-o à risca: ele é a fonte canônica dos passos (plano determinístico com scripts/youtube-short-related-plan.ts, Claude in Chrome no Studio aberto pela lista de Shorts do canal, registro do resultado e alerta ao editor por e-mail).",
      "",
      "Regras: a edição é a de hoje em BRT (o script calcula sozinho, não passe data); rode o script do plano pela ferramenta Bash com timeout de 600000 ms; só clique no Studio quando o plano disser action=link; nunca altere outro campo do vídeo nem digite senha; nunca pergunte nada (ninguém está olhando): na dúvida, registre failed e alerte. Termine com um resumo de uma linha: edição, ação final e IDs.",
    ].join("\n"),
    issue: "#10811",
    serverException: {
      reason:
        "O vínculo do vídeo relacionado só existe no YouTube Studio: a YouTube Data API v3 não tem campo nem endpoint de escrita para ele (reconferido em 02/11/2026, docs/youtube-short-related-video.md). Sem API, o clique é do Claude in Chrome logado no @diariabr, que o 300 não tem.",
      decidedIn: "#11779",
      reviewedOn: "2026-11-02",
    },
  },
];

/** Linhas da listagem `--desktop` (uma por task, separadas por tab). */
export function renderDesktopScheduledTasksTable(tasks: readonly DesktopScheduledTaskDefinition[] = DESKTOP_SCHEDULED_TASKS): string {
  return tasks
    .map((t) =>
      [
        t.taskId,
        t.machine,
        t.cronExpression,
        t.playbook,
        t.issue,
        `exceção ao 300: ${t.serverException.decidedIn}, revisada em ${t.serverException.reviewedOn}`,
      ].join("\t"),
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Enumeração programática (#5408) — mesmo idioma CLI de exec-mode.ts /
// clarice-envio-enabled.ts: função pura testável + guard `isMainModule` fino.
//
// Motivação: antes desta unidade não existia forma programática de
// enumerar SCHEDULED_TASKS — só leitura de prosa (docs/scheduled-tasks-registry.md)
// ou `grep` no `.ts`, que pode truncar silenciosamente (ex: `grep | head`)
// sem se anunciar como truncado. `--list`/`--json` abaixo são a fonte
// canônica; ver também test/scheduled-tasks-drift.test.ts (doc↔código).
// ---------------------------------------------------------------------------

/** Linha tabular derivada de uma `ScheduledTaskDefinition` — shape estável
 * consumido tanto pelo modo `--list` (tabela) quanto `--json` (array). */
export interface ScheduledTaskRow {
  name: string;
  schedule: string;
  scripts: string;
  logPath: string;
  killSwitch: string;
  issue: string;
  /** `false` quando a task tem `enabled: false` no registro (#8537). Task
   *  desarmada NUNCA vira unit systemd (`setup-systemd-timers.ts` filtra
   *  por `enabled !== false`), então não aparece em `systemctl list-timers`,
   *  não gera log e não dispara alarme. Antes desta coluna ela aparecia em
   *  `--list`/`--json` idêntica a uma armada, e foi assim que a
   *  `Diaria-Social-Followers-Collect` ficou dormente por 3 dias sem sinal
   *  nenhum — o painel `/ads` só mostrava `followers: null`. */
  armed: boolean;
}

/** Formata `ScheduledTaskSchedule` como string humana curta (não é o
 * `OnCalendar` do systemd — ver `scheduleToOnCalendar` em systemd-units.ts
 * pra isso; aqui é só leitura rápida em tabela/JSON). */
export function formatScheduleHuman(schedule: ScheduledTaskSchedule): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (schedule.kind) {
    case "daily":
      return `daily ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "weekly":
      return `weekly ${schedule.dayOfWeek} ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "monthly":
      return `monthly day ${schedule.day} ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "interval":
      return `interval ${schedule.hours}h`;
  }
}

/** Deriva as linhas tabulares de TODO `tasks` (default `SCHEDULED_TASKS`),
 * na ordem declarada — nunca truncado, sempre `tasks.length` linhas.
 * `tasks` é injetável só pra teste (demonstrar "adicionar uma task faz ela
 * aparecer sem tocar a função", #5408) — em runtime, omitir sempre usa o
 * registro real. `killSwitch` só cobre o que está MODELADO no registro
 * (`guard.requiredFile`, arquivo cuja ausência aborta a run) — a maioria
 * das tasks não tem guard estruturado (kill switches como
 * `data/clarice-novos-enabled.json` vivem em código de runtime dos
 * scripts, fora do schema de `ScheduledTaskDefinition`), então `"-"` aqui
 * significa "sem guard MODELADO neste registro", não "sem kill switch
 * nenhum" — ver `docs/scheduled-tasks-registry.md` pra kill switches
 * documentados em prosa (ex: Diaria-Clarice-Novos). */
export function listScheduledTaskRows(tasks: ScheduledTaskDefinition[] = SCHEDULED_TASKS): ScheduledTaskRow[] {
  return tasks.map((t) => ({
    name: t.name,
    schedule: formatScheduleHuman(t.schedule),
    scripts: t.steps.map((s) => s.script).join(", "),
    logPath: t.logPath,
    killSwitch: t.guard ? t.guard.requiredFile : "-",
    issue: t.issue,
    armed: t.enabled !== false,
  }));
}

/** Renderiza a tabela `--list` — 1 linha por task, colunas separadas por
 * tab (`\t`), sem header — mantém a garantia "exatamente
 * `SCHEDULED_TASKS.length` linhas" (#5408) simples de verificar em teste. */
export function renderScheduledTasksTable(rows: ScheduledTaskRow[] = listScheduledTaskRows()): string {
  return rows
    .map((r) => [r.name, r.schedule, r.scripts, r.logPath, r.killSwitch, r.issue, r.armed ? "armada" : "DESARMADA"].join("\t"))
    .join("\n");
}

// CLI guard: só executa como main module, importável sem efeito colateral
// (mesmo padrão de exec-mode.ts/clarice-envio-enabled.ts).
if (isMainModule(import.meta.url)) {
  const { flags } = parseArgs(process.argv.slice(2));
  const rows = listScheduledTaskRows();
  if (flags.has("desktop")) {
    // #10811: tasks locais do app Claude desktop (fora do systemd).
    console.log(flags.has("json") ? JSON.stringify(DESKTOP_SCHEDULED_TASKS, null, 2) : renderDesktopScheduledTasksTable());
  } else if (flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (flags.has("list")) {
    console.log(renderScheduledTasksTable(rows));
    // stderr: o stdout do `--list` é exatamente 1 linha por task systemd (#5408).
    console.error(`(+ ${DESKTOP_SCHEDULED_TASKS.length} task(s) local(is) do app Claude desktop fora desta tabela: --desktop)`);
  } else {
    console.log("Uso: npx tsx scripts/lib/scheduled-tasks.ts --list [--json] | --desktop [--json]");
    const desarmadas = rows.filter((r) => !r.armed).length;
    console.log(
      `(${rows.length} tasks no registro — nome, schedule, scripts, logPath, killSwitch, issue, armada/DESARMADA` +
        `${desarmadas > 0 ? `; ${desarmadas} ${desarmadas === 1 ? "DESARMADA" : "DESARMADAS"} — não viram unit systemd` : ""})`,
    );
    console.log(`(+ ${DESKTOP_SCHEDULED_TASKS.length} task(s) local(is) do app Claude desktop, fora do systemd: --desktop)`);
  }
}
