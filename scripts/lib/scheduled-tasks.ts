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
 * **Este arquivo NÃO executa nada** — é dado puro. Execução é
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
 * @see scripts/lib/task-runner.ts (Fase 2 — executor)
 * @see scripts/run-task.ts (Fase 2 — entrypoint CLI)
 * @see scripts/lib/systemd-units.ts + scripts/setup-systemd-timers.ts (Fase 3)
 * @see docs/scheduled-tasks-registry.md (prosa operacional) — `--list`/`--json`
 *   abaixo (#5408) são a enumeração PROGRAMÁTICA, fonte pra quem precisa da
 *   lista completa sem depender de grep truncável.
 */

import { isMainModule, parseArgs } from "./cli-args.ts";

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
  /** Issue(s) de origem, só pra rastreabilidade em docs/erros. */
  issue: string;
  /** #5639 — enable/disable da task sem remover do registro.
   *  Default (campo ausente): `true` — task roda normalmente.
   *  Quando `false`, o runner pula a execução (exit 0, loga "SKIP: task disabled")
   *  e o gerador de units systemd NÃO cria `.service`/`.timer` para ela. */
  enabled?: boolean;
}

/** Cota diária da URL Inspection API do Google, POR PROPRIEDADE GSC
 * (`sc-domain:diar.ia.br`) — compartilhada pelos passos "index" e
 * "index-arquivo" de `Diaria-SEO-Weekly` (achado do fleet review pré-merge
 * do #5975/#5983: nomear a cota evita que os dois `--limit` divirjam da
 * soma real sem ninguém notar; ver teste em test/scheduled-tasks.test.ts
 * que soma os dois valores contra esta constante). */
export const GSC_URL_INSPECTION_DAILY_QUOTA = 2000;

export const SCHEDULED_TASKS: ScheduledTaskDefinition[] = [
  {
    name: "Diaria-Apoios-Diff-Alarm",
    description: "alarme diario de diff pendente do sync apoio_nivel",
    steps: [{ key: "alarm", script: "scripts/apoios-diff-alarm.ts" }],
    logPath: "apoia-se/.diff-alarm.log",
    schedule: { kind: "daily", hour: 9, minute: 45 },
    issue: "#4485 item 2",
  },
  {
    name: "Diaria-Home-Meta-Check",
    description: "smoke-test dos eixos de drift da home diar.ia.br (og:title, self-links http, rotulos EN, host legado, porta na URL)",
    steps: [{ key: "check", script: "scripts/home-meta-check.ts" }],
    logPath: "home-meta-check/.meta-check.log",
    // Diária 09:35 (#5113, decisão do editor 260812 — mudou de "a cada 6h").
    // O argumento não é custo (4 GETs numa home pública é irrelevante) — é
    // que latência de detecção ABAIXO da latência de resposta é
    // desperdiçada: o conserto destes achados é ação manual do editor no
    // painel Beehiiv/Cloudflare, e ele age de manhã. Detectar drift às 03:00
    // não conserta nada às 03:00 — as 4 rodadas/dia colapsavam num único
    // momento de ação por dia. O que este check vigia muda em escala humana
    // (editor mexe no painel, vendor atualiza tema), não em escala de
    // incidente. O 6h nunca foi escolhido pra este check em particular — foi
    // herdado por pattern-match dos outros dois drift-checks de superfície
    // pública (Diaria-Hub-Drift-Check #4750, Diaria-Robots-Txt-Drift-Check
    // #4910), que tiveram exatamente o mesmo raciocínio aplicado ao mesmo
    // tempo. Precedente: Diaria-Postmaster-Spam-Sync saiu de "a cada 12h"
    // pra diária 12:30 em 10/08 pelo mesmo motivo. Horário 09:35, não 09:30
    // como a issue #5113 propôs originalmente: 09:30 colide com
    // Diaria-Hub-Staleness-Check (#5123, registrada depois da issue ter sido
    // escrita — ver o teste de colisão dedicado dela em
    // test/scheduled-tasks.test.ts); 5min de folga preserva a intenção
    // (banda matinal) sem colidir.
    schedule: { kind: "daily", hour: 9, minute: 35 },
    // 1ª task registrada depois do cutover systemd da épica #4798, sem
    // contraparte Windows/.ps1 (#5005).
    issue: "#4557, #5005, #5113",
  },
  {
    name: "Diaria-Brevo-Diaria-Guardrail",
    description: "circuit breaker de campanha do canal brevo_diaria",
    steps: [{ key: "check", script: "scripts/check-brevo-diaria-guardrail.ts" }],
    logPath: "brevo-diaria/.guardrail-check.log",
    schedule: { kind: "interval", hours: 4 },
    issue: "#4476 item 9",
  },
  {
    name: "Diaria-Clarice-Cohorts-Crawl",
    // #4451 (decisão do editor, 260811): a task Windows legada
    // `DiariaCohortsCrawl` (crawl per-contato via `clarice-engagement-cohorts.ts`,
    // v1 — ver docs/cohorts-schedule.md) NUNCA existiu neste registro nem tem
    // timer systemd nesta máquina (`grep -n "CohortsCrawl\|cohorts"` no
    // registro pré-#4451 e `systemctl --user list-timers` vazios) — não é
    // troca de ponteiro v1→v2 de uma task existente, é registro do ZERO já
    // apontando pro v2 (`clarice-engagement-cohorts-v2.ts`, redesenho #4451
    // Fases 1-2, #4457/#4479, validado empiricamente 260808/260809 ao vivo
    // contra a Brevo, ver issue #4451 comentário 260810/docs/cohorts-schedule.md
    // §"Redesenho v2"). O período de sobreposição v1×v2 do item 6 do plano
    // original da issue foi deliberadamente PULADO por decisão do editor —
    // não falta, não vai acontecer.
    //
    // #5015 (fechado): v2 agora sabe escrever no KV atrás da flag `--push`
    // (`pushCohortsToKV`, porta a MESMA proteção anti-clobber do v1 — nunca
    // sobrescreve `cohorts:engagement` com universe=0). Este step passa
    // `--push` nos args, então esta task ATUALIZA de fato o snapshot
    // "Coortes de engajamento" do dashboard clarice-dashboard a cada
    // disparo (21:00 BRT) — antes do #5015, o step só refrescava o
    // artefato local `--out` e o KV ficava congelado no último sucesso
    // manual do v1 (`clarice-engagement-cohorts.ts`, que não tem task
    // agendada nesta máquina). `--out` continua presente: o artefato local
    // (cohorts + diagnostics) segue útil pra `scripts/compare-cohorts.ts` /
    // inspeção manual, independente do `--push`.
    description: "crawl periodico de coortes de engajamento via v2 (export por campanha) -- grava KV via --push (#5015) e refresca o artefato local --out",
    steps: [
      {
        key: "crawl",
        script: "scripts/clarice-engagement-cohorts-v2.ts",
        args: ["--push", "--out", "data/clarice-subscribers/cohorts/v2-latest.json"],
      },
    ],
    logPath: "clarice-subscribers/.cohorts-v2-crawl.log",
    // Diaria 21:00 BRT -- mesmo horario historico do v1 (docs/cohorts-schedule.md,
    // decisao 2026-06-19), sem colisao com nenhuma outra daily do registro
    // (todas as outras dailies ficam entre 05:30 e 17:00).
    schedule: { kind: "daily", hour: 21, minute: 0 },
    // Mesmo padrao de Diaria-Home-Meta-Check (#5005): task
    // registrada depois do cutover systemd (epica #4798) -- o antigo
    // `DiariaCohortsCrawl` do Windows nunca foi migrado pra este registro --
    // era via `docs/cohorts-schedule.md` diretamente, apontando pro v1, e
    // segue existindo so como doc historico, nao como entrada aqui.
    issue: "#4451",
  },
  {
    name: "Diaria-Clarice-Dashboard-Precompute",
    // #5217: reabastece dash:lastgood:campaigns (fallback de rate-limit do
    // dashboard clarice-dashboard) — nada mais o mantinha quente desde que o
    // Cron Trigger interno do Worker foi removido (#3553/#3639). Bate
    // `GET /` autenticado via Bearer (reusa AUTH_TOKEN, sem secret novo — ver
    // docstring do script) e aciona o MESMO caminho de código de uma visita
    // humana, incluindo o write-through gated por hash do #5216 (só grava
    // quando o conteúdo mudou).
    description: "precompute horario do dashboard clarice-dashboard (dash:lastgood:campaigns) via GET / autenticado",
    steps: [{ key: "precompute", script: "scripts/clarice-dashboard-precompute.ts" }],
    logPath: "clarice-dashboard/.precompute.log",
    // Horária (24x/dia) — decisão do editor 13/08/2026. Custo medido: ~2
    // chamadas Brevo/execução morna, ~44/100 do teto real de 100 req/hora
    // (#5215). Editor checa o painel a partir das 10:00 — a cadência horária
    // já garante dado fresco na 1ª olhada do dia sem precisar de um
    // horário-âncora dedicado.
    schedule: { kind: "interval", hours: 1 },
    issue: "#5217, #5216, #5215",
  },
  {
    name: "Diaria-Clarice-Guardrail-Alarm",
    description: "alarme de guardrail furado do ramp Clarice",
    steps: [{ key: "alarm", script: "scripts/clarice-guardrail-alarm.ts" }],
    logPath: "clarice-subscribers/.guardrail-alarm.log",
    schedule: { kind: "interval", hours: 4 },
    // #6563: 75 = EX_TEMPFAIL (`scripts/clarice-guardrail-alarm.ts`,
    // `shouldSkipForLowQuota`) — skip deliberado (cota Brevo baixa, #6034)
    // é resultado esperado, não falha; sem isto, `Diaria-Systemd-Unit-Rate-
    // Alarm` contava cada skip como falha na taxa (achado ao vivo #6455).
    // **#6695: declarar isto AQUI não basta sozinho.** Só vira
    // `SuccessExitStatus=75` real na unit systemd depois de
    // `npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Guardrail-Alarm`
    // + copiar o `.service` regenerado pra `~/.config/systemd/user/` +
    // `systemctl --user daemon-reload` no `helios` (ação manual do editor,
    // nenhum PR/CI regenera isso sozinho). Até esse passo rodar, o script
    // (`isExitCodeArmedForUnit`, #6695) detecta a unit desatualizada e
    // sai com 0 em vez de 75 — nunca `failed`, mas também sem o sinal fino
    // que este `successExitCodes` pretende habilitar. Ver
    // `docs/clarice-guardrail-alarm-setup.md`.
    successExitCodes: [75],
    issue: "#4064, #4131 finding 1, #6563, #6695",
  },
  {
    name: "Diaria-Clarice-Opens-Catchup-Alarm",
    description: "alarme de falha sustentada do catch-up de opens da Clarice",
    steps: [{ key: "alarm", script: "scripts/clarice-opens-catchup-alarm.ts" }],
    logPath: "clarice-subscribers/.opens-catchup-alarm.log",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    issue: "#4740, #4722 item 4",
  },
  {
    name: "Diaria-Clarice-Sync",
    description: "sync incremental diario do store Clarice",
    steps: [
      { key: "sync", script: "scripts/clarice-sync-brevo.ts", args: ["--incremental"] },
      {
        key: "extract",
        script: "scripts/extract-opens-catchup-status.ts",
        args: ["--log", "{tempLogPath}", "--out", "data/clarice-subscribers/last-opens-catchup-status.json"],
        bestEffort: true,
      },
      { key: "summary", script: "scripts/clarice-db-summary.ts" },
    ],
    logPath: "clarice-subscribers/.brevo-sync-daily.log",
    schedule: { kind: "daily", hour: 8, minute: 30 },
    issue: "#2932, #2928, #4047, #4740",
  },
  {
    name: "Diaria-Cursos-Kv-Sync",
    description: "sync diario do KV CURSOS_SUBSCRIBERS",
    steps: [{ key: "sync", script: "scripts/sync-cursos-subscribers-kv.ts" }],
    logPath: "cursos-subscribers/.kv-sync.log",
    schedule: { kind: "daily", hour: 9, minute: 15 },
    issue: "#4052, #4320",
  },
  {
    // #6093: mantém o Kit convergente com os assinantes ativos da Beehiiv
    // (cria/reativa quem falta) — sem recorrência, o Kit volta a congelar
    // no próximo assinante novo (comportamento observado antes do #6091:
    // Kit travado em 585, todos `created_at: 2026-08-24`). Pré-requisito de
    // QUALQUER switchover real do épico #461. Guard de blast radius (lista
    // do Kit suspeita-vazia) já embutido no próprio script — nenhum guard
    // adicional aqui. Horário 09:25 (issue sugeriu 09:20, mas esse minuto
    // já é ocupado pela Diaria-Sunset-Weekly, domingo 09:20 -- dailies
    // rodam todo dia da semana, então colidiriam nos domingos; 09:25 segue
    // na mesma janela livre entre Diaria-Cursos-Kv-Sync (09:15) e os checks
    // de drift matinais (09:30 em diante), sem colisão).
    name: "Diaria-Kit-Subscriber-Sync",
    description: "sync diario de assinantes ativos Beehiiv -> Kit (--push)",
    steps: [{ key: "sync", script: "scripts/sync-beehiiv-subscribers-kit.ts", args: ["--push"] }],
    logPath: "kit-subscriber-sync/.sync.log",
    schedule: { kind: "daily", hour: 9, minute: 25 },
    issue: "#461, #6091, #6092, #6093",
  },
  {
    name: "Diaria-Brevo-Diaria-Evaluate",
    description: "evaluate diario do canal brevo_diaria (--push)",
    steps: [{ key: "evaluate", script: "scripts/evaluate-brevo-diaria.ts", args: ["--push"] }],
    logPath: "brevo-diaria/.evaluate.log",
    schedule: { kind: "daily", hour: 5, minute: 30 },
    guard: {
      requiredFile: "brevo-diaria/contacts.json",
      abortMessage:
        "contacts.json nao encontrado (data/brevo-diaria/contacts.json) -- provavel junction data/ nao " +
        "montada ainda; abortando por seguranca, NAO rodando --push.",
    },
    enabled: true,
    issue: "#4534, #4552, #5639, #5838",
  },
  {
    name: "Diaria-Sunset-Weekly",
    description: "rodada semanal do sunset de assinantes mortos (fresh snapshot + push pro funil brevo_diaria)",
    // `--push` sozinho já É a rodada completa (#5807 reescopo, ver docstring
    // de `sunset-dead-subscribers.ts`): garante snapshot fresco, avalia
    // todos os ativos maduros, exclui quem já passou pelo store, aplica os
    // guards de blast radius (20%) + folga de fila compartilhada com
    // `sync-pending-to-brevo.ts`, e grava 1 linha em
    // `data/brevo-diaria/sunset-rounds.jsonl` por rodada.
    steps: [{ key: "sunset", script: "scripts/sunset-dead-subscribers.ts", args: ["--push"] }],
    logPath: "brevo-diaria/.sunset-weekly.log",
    // Domingo 09:20 BRT — depois de Diaria-Beehiiv-Backup (03:00, snapshot
    // semanal que este ensureFreshSnapshot() normalmente já encontra fresco)
    // e Diaria-Beehiiv-Backup-Staleness-Alarm (04:00), antes de
    // Diaria-Geo-Citation-Staleness-Alarm (10:30) e Diaria-On-Hold-Vencimento-Alarm
    // (11:00) — sem colisão com nenhuma outra weekly já registrada (checado
    // via `--list` antes de escolher: 03:00, 03:30, 04:00, 04:10, 07:00,
    // 08:05, 10:30, 11:00, 22:00 já ocupados) nem com as dailies das 09:00/09:15
    // (Diaria-Clarice-Novos, Diaria-Clarice-Opens-Catchup-Alarm, Diaria-Cursos-Kv-Sync).
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 9, minute: 20 },
    // Mesmo guard de "junction data/ ainda não montada" de
    // Diaria-Brevo-Diaria-Evaluate (mesmo store) — sem contacts.json não faz
    // sentido tentar avaliar/mover ninguém.
    guard: {
      requiredFile: "brevo-diaria/contacts.json",
      abortMessage:
        "contacts.json nao encontrado (data/brevo-diaria/contacts.json) -- provavel junction data/ nao " +
        "montada ainda; abortando por seguranca, NAO rodando --push.",
    },
    // DESLIGADA DE PROPOSITO (#5807, 21/08/2026). A #5849 achou que
    // receivedMin=20 sozinho nao separava "morto de verdade" de
    // "recem-chegado dentro da janela de medicao do teste pago 2608" (23 dos
    // 88 candidatos de uma rodada real tinham so ~4 semanas de vida, dentro
    // da janela de campanhas em medicao — #5734/#4556). JA RESOLVIDA (sessao
    // /diaria-develop 260821): criterio agora combina receivedMin E
    // subscribedMinDays (ver SunsetThresholds em sunset-dead-subscribers.ts).
    // O MECANISMO esta pronto; o INTERRUPTOR segue desligado porque ligar a
    // execucao automatica e decisao separada, ainda nao tomada — reativar e
    // trocar este campo pra `true` (uma linha) quando o editor decidir.
    enabled: false,
    issue: "#5807, refs #5849 (resolvida — interruptor segue off por decisao separada)",
  },
  {
    name: "Diaria-Geo-Citation-Monitor",
    description: "monitor semanal de citacao por assistente de IA",
    // Dois painéis, dois passos independentes (#4900 item a). O passo `hubs`
    // foi ativado em 10/08/2026: ele estava pronto e desligado esperando o
    // fim do duplo escritor (#4806/#4807, ambas fechadas) e a resolução do
    // arquivo de conflito (item c — investigado, era subconjunto estrito do
    // arquivo bom, removido). Passos separados e não um flag só porque cada
    // painel tem a própria série e o próprio baseline: se um provedor cair
    // no `geral`, o `hubs` daquela semana ainda é registrado.
    //
    // `--max-monthly-usd 8` (#4904, achado do silent-failure-hunter da PR
    // que reativou a Anthropic): antes NENHUM guard de custo rodava na task
    // real — o único freio era o teto de US$10/mês configurado direto na
    // org do Console (console.anthropic.com → Billing → Spend limits),
    // opaco pra este repo (sem log, sem registro em history.jsonl, sem
    // alarme daqui se for atingido). US$8 fica DELIBERADAMENTE abaixo dos
    // US$10 do Console — o guard daqui é um PISO que não conta chamadas da
    // Anthropic que deram timeout mas foram cobradas mesmo assim (ver
    // docstring de `sumMonthToDateCostUsd`), então precisa de folga pra
    // disparar ANTES do teto rígido do Console, com uma mensagem clara em
    // vez de um erro de pagamento cru.
    steps: [
      { key: "monitor", script: "scripts/geo-citation-monitor.ts", args: ["--strict", "--max-monthly-usd", "8"] },
      {
        key: "monitor-hubs",
        script: "scripts/geo-citation-monitor.ts",
        args: ["--panel", "hubs", "--strict", "--max-monthly-usd", "8"],
      },
    ],
    logPath: "geo-citations/.monitor.log",
    // Domingo 07:00 (mudou de segunda 10:30, decisão do editor 260810 —
    // consolidar as semanais na manhã de domingo): ainda depois do
    // Brevo-Diaria-Evaluate diário (05:30) e antes do Clarice-Sync diário
    // (08:30, roda todo dia incl. domingo) — sem colisão de horário.
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 7, minute: 0 },
    issue: "#4558 Parte C, #4754, #4900",
  },
  {
    name: "Diaria-Geo-Citation-Staleness-Alarm",
    description: "alarme de staleness do monitor de citacao GEO",
    steps: [{ key: "alarm", script: "scripts/geo-citation-staleness-alarm.ts" }],
    logPath: "geo-citations/.staleness-alarm.log",
    // Domingo 10:30 (mudou de segunda 14:00, decisão do editor 260810):
    // continua depois do Geo-Citation-Monitor (domingo 07:00) — 3h30 de
    // folga, mesma ordem de grandeza do gap original (10:30 -> 14:00).
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 10, minute: 30 },
    issue: "#4755",
  },
  {
    name: "Diaria-LinkedIn-Weekly-Staleness-Alarm",
    description: "alarme de staleness da newsletter semanal do LinkedIn (ln-{cycle}.json ausente)",
    steps: [{ key: "alarm", script: "scripts/linkedin-weekly-staleness-alarm.ts" }],
    logPath: "weekly/.linkedin-staleness-alarm.log",
    // Domingo 22:00 BRT (#5111): produção normal da skill é domingo (durante
    // o dia, sem horário fixo — gate humano com 3 textos autorais), então
    // 22:00 dá folga ampla pro dia inteiro de domingo já ter passado antes
    // de checar, e ainda sobra a noite inteira + a manhã de segunda (deadline
    // de publicação ~09:30 BRT) pro editor reagir ao e-mail antes do prazo.
    // Evita de propósito os 2 outros timers de domingo já registrados
    // (Diaria-Geo-Citation-Monitor 07:00, Diaria-Geo-Citation-Staleness-Alarm
    // 10:30) — sem colisão de horário com nenhum dos dois.
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 22, minute: 0 },
    // Mesmo caso de `Diaria-Home-Meta-Check`/`Diaria-Clarice-Envio-Alarm`
    // (#5005/#5058): task registrada depois do cutover systemd (épica #4798), sem
    // contraparte Windows/.ps1 — e nenhuma tarefa `Diaria-*` deve rodar no
    // Windows de qualquer forma (decisão do editor 260811, #5074).
    issue: "#5111",
  },
  {
    name: "Diaria-Hub-Drift-Check",
    description: "smoke-test de drift entre HUB_META e o Worker arquivo publicado",
    steps: [{ key: "check", script: "scripts/hub-drift-check.ts" }],
    logPath: "hub-drift-check/.drift-check.log",
    // Diária 10:00 (#5113, decisão do editor 260812 — mudou de "a cada 6h").
    // Mesmo raciocínio de Diaria-Home-Meta-Check acima: o conserto
    // (deploy do Worker/config do hub) é ação manual do editor de manhã —
    // latência de detecção abaixo da latência de resposta é desperdiçada. O
    // 6h nunca foi escolhido pra este check em particular, foi herdado por
    // pattern-match; ver o comentário do home-meta-check pro raciocínio
    // completo (os dois se citam em círculo desde a origem).
    schedule: { kind: "daily", hour: 10, minute: 0 },
    issue: "#4750, #5113",
  },
  {
    name: "Diaria-Robots-Txt-Drift-Check",
    description: "smoke-test do robots.txt SERVIDO pelos Workers de curadoria (bloco gerenciado da Cloudflare + bots fora do esperado)",
    steps: [{ key: "check", script: "scripts/robots-txt-drift-check.ts" }],
    logPath: "robots-txt-drift-check/.drift-check.log",
    // Diária 10:15 (#5113, decisão do editor 260812 — mudou de "a cada 6h",
    // mesmo raciocínio do Diaria-Hub-Drift-Check acima: o conserto é ação
    // manual de dashboard do editor de manhã, detectar de madrugada não
    // adianta nada).
    schedule: { kind: "daily", hour: 10, minute: 15 },
    issue: "#4910, #5113",
  },
  {
    name: "Diaria-Plugin-Review-Drift-Check",
    description:
      "drift-check do system prompt dos 5 agentes do plugin pr-review-toolkit que DEFAULT_EFFORT=max dispara — alarma se a linguagem de filtro de confiança/severidade mudar (arquivo per-máquina, fora deste repo)",
    steps: [{ key: "check", script: "scripts/plugin-review-drift-check.ts" }],
    logPath: "plugin-review-drift-check/.drift-check.log",
    // Diária 10:20 — logo depois de Diaria-Robots-Txt-Drift-Check (10:15,
    // acima), mesmo cluster matinal de drift-checks; sem colisão com
    // nenhuma outra daily já registrada (ver grep de `kind: "daily"` neste
    // arquivo). Plugin ausente (sessão cloud, clone fresco) é skip — o
    // script nunca falha/alarma nesse caso (ver docstring do script).
    schedule: { kind: "daily", hour: 10, minute: 20 },
    issue: "#5311",
  },
  {
    name: "Diaria-Subscribe-Redirect-Drift-Check",
    description:
      "smoke-test do destino do redirect /subscribe (perfil hospedado Kit) + / e /p/{slug} do Worker diaria-site — 200 sozinho não basta, exige os marcadores esperados no corpo (página de erro pode vir 200)",
    steps: [{ key: "check", script: "scripts/subscribe-redirect-drift-check.ts" }],
    logPath: "subscribe-redirect-drift-check/.drift-check.log",
    // Diária 10:30 — logo depois de Diaria-Plugin-Review-Drift-Check (10:20,
    // acima) e Diaria-Dmarc-Drain (10:25, abaixo), fechando o cluster
    // matinal de checks/alarmes; sem colisão com nenhuma outra daily já
    // registrada (ver grep de `kind: "daily"` neste arquivo). Mesmo
    // raciocínio de Diaria-Hub-Drift-Check/Diaria-Robots-Txt-Drift-Check
    // acima: o conserto (atualizar `_redirects`, redeployar o Worker) é
    // ação manual do editor de manhã — latência de detecção abaixo da
    // latência de resposta é desperdiçada.
    schedule: { kind: "daily", hour: 10, minute: 30 },
    issue: "#6365",
  },
  {
    name: "Diaria-Kit-Doi-Orphan-Guard",
    description:
      "detecta assinantes Kit criados inactive (double opt-in do worker poll) que nunca foram vinculados ao form de confirmação — presos para sempre sem o guard, incidente de 28/08/2026",
    steps: [{ key: "check", script: "scripts/kit-doi-orphan-guard.ts" }],
    logPath: "kit-doi-orphan-guard/.guard-check.log",
    // Diária 10:35 — logo depois de Diaria-Subscribe-Redirect-Drift-Check
    // (10:30, acima), fechando o cluster matinal de checks/alarmes de
    // cadastro; sem colisão com nenhuma outra daily já registrada (ver grep
    // de `kind: "daily"` neste arquivo). Mesmo raciocínio dos vizinhos:
    // órfão preso em inactive não piora rodando mais devagar — o conserto
    // (rodar o resgate manual da Ação 1 da issue) é ação do editor, então
    // detectar de madrugada não adianta.
    schedule: { kind: "daily", hour: 10, minute: 35 },
    issue: "#6810",
  },
  {
    name: "Diaria-Codex-Credential-Alarm",
    description:
      "avisa quando resta UMA conta OpenAI Codex viva no pool do Hermes — contas são OAuth (não há endpoint de saldo), então o único sinal é o resultado da última tentativa de uso, que o Hermes persiste em ~/.hermes/auth.json",
    steps: [{ key: "check", script: "scripts/codex-credential-alarm.ts" }],
    logPath: "codex-credential-alarm/.alarm.log",
    // Diária 10:50 — fecha o cluster matinal de alarmes, depois de
    // Diaria-Branch-Cleanup (10:45). 10:40 foi a 1ª escolha e está OCUPADO
    // por Diaria-Npm-Version-Drift-Alarm (#6960) — conferido com
    // `scheduled-tasks.ts --list`, não por leitura deste arquivo, justamente
    // porque a lista ordenada é o que revela colisão.
    //
    // **Por que DIÁRIA e não mais frequente (#7250, registro no #7316).** A
    // cadência aqui não é escolha de gosto — é limitada pelo desenho do
    // sinal, em duas pontas:
    //
    //   1. **A montante, o sinal só existe se houver USO.** Não há endpoint
    //      de saldo; `last_status`/`last_error_reason` só mudam quando algo
    //      de fato TENTA usar a conta e leva 429. Rodar de hora em hora não
    //      produz informação nova — relê o mesmo `auth.json` congelado. O
    //      gerador de uso é o tick do contínuo (`hermes cron list --all`,
    //      job `5d791ef6fc2c`), então a frequência ÚTIL está atrelada a ele,
    //      nunca a um horário bonito. Medido em 03/09/2026: esse job estava
    //      `[paused]` — com ele parado, o pool não muda e nenhuma cadência
    //      de checagem descobre nada.
    //
    //   2. **A jusante, o horizonte de resposta é de SEMANAS.** As duas
    //      contas esgotadas voltam em 29/09 e 02/10 (`resets_at` devolvido
    //      pela própria OpenAI no 429). Latência de detecção abaixo da
    //      latência de resposta é desperdiçada — mesmo raciocínio dos
    //      vizinhos deste cluster, e aqui a margem é de ordens de grandeza:
    //      um dia contra semanas.
    //
    // Não é MENOS que diária (semanal, p.ex.) porque o evento que importa —
    // a última conta esgotar, parando a delegação — é abrupto e silencioso;
    // uma semana de latência aí é grande fração da janela em que dá pra
    // reagir antes que o trabalho pare.
    //
    // Repetição não é preocupação: o script deduplica por fingerprint do
    // estado do pool (`computeCodexPoolFingerprint`) e só envia quando o
    // estado MUDA — diária não vira e-mail diário.
    schedule: { kind: "daily", hour: 10, minute: 50 },
    issue: "#7250",
  },
  {
    name: "Diaria-Hub-Staleness-Check",
    description: "detecta edições publicadas que casam HUB_KEYWORD_PATTERNS mas não estão no dataset commitado do hub (persiste snapshot + alarma se >= 1 dia)",
    steps: [{ key: "check", script: "scripts/hub-staleness-check.ts", args: ["--threshold-days", "1"] }],
    logPath: "hubs/.staleness-check.log",
    // #7147 (02/09/2026): mudou de diária pra SEMANAL — o achado muda na
    // cadência de PUBLICAÇÃO (uma edição/dia pode entrar em `stale`), não na
    // de checagem, então rodar diário virava e-mail + issue quase todo dia
    // pro mesmo tipo de pendência (evidência: #7101/#7102/#7103, 3 issues
    // numa única manhã). `--threshold-days` baixado de 3 pra 1 JUNTO com a
    // troca de cadência — sem isso "3+ dias" na prática viraria "8-13 dias"
    // (a 1ª checagem que vê uma entrada só acontece no domingo seguinte ao
    // dia em que ela ficou stale); com threshold=1, o intervalo semanal já É
    // o amortecedor, e o assunto do e-mail ("N+ dias") continua correto.
    // Horário: domingo 09:33, dentro da janela 09:30-10:20 de checks de
    // drift/hub (#5754) e depois de Diaria-Hub-Pages-Build (domingo 08:05,
    // hoje `enabled: false`) — sem colisão com nenhuma outra weekly do
    // registro (checado contra o grep de `kind: "weekly"` neste arquivo).
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 9, minute: 33 },
    // Mesmo caso de Diaria-Home-Meta-Check/Diaria-Clarice-Envio-Alarm
    // (#5005/#5058): 1ª execução registrada depois do cutover systemd (épica #4798).
    issue: "#5123, #4924, #7147",
  },
  {
    name: "Diaria-Entity-Pages-Regen",
    description:
      "regenera o HTML das páginas de entidade (workers/artigos/public/entidades/) a partir do EntityContent commitado — SÓ a mecânica, sem alarme (ver Diaria-Entity-Pages-Staleness-Alarm pro alarme)",
    steps: [{ key: "regen", script: "scripts/regenerate-entity-pages.ts", args: ["--skip-alarm"] }],
    logPath: "entities/.regen.log",
    // Diária continua (#5125: condição inegociável do editor — "a página
    // nasce com regeneração automática, senão não é publicada"; isso é só a
    // Parte 1, mecânica/determinística, sem I/O de rede — não pode virar
    // semanal). `--skip-alarm` (#7147, 02/09/2026) tira a Parte 2 (detecção
    // + alarme) desta task — ela mudou de cadência pra semanal, ver
    // Diaria-Entity-Pages-Staleness-Alarm logo abaixo; antes deste split as
    // 2 partes tinham a mesma cadência só por acidente de viverem no mesmo
    // `main()`, não por decisão. Horário inalterado: 09:40, entre
    // Diaria-Home-Meta-Check (09:35) e Diaria-Apoios-Diff-Alarm (09:45).
    schedule: { kind: "daily", hour: 9, minute: 40 },
    // #5125: condição inegociável do editor pra publicar a 1ª página de
    // entidade fora da rodada original de 3 (Apple) — "a página nasce com
    // regeneração automática, senão não é publicada". Armada em 17/08/2026
    // na checkout compartilhada (`helios`) — ver
    // docs/entity-pages-regen-setup.md.
    issue: "#5125, #7147",
  },
  {
    name: "Diaria-Entity-Pages-Staleness-Alarm",
    description:
      "alarma quando uma edição nova casa o padrão de uma entidade publicada mas ainda não está no mentions dela (mesmo mecanismo de aging de Diaria-Hub-Staleness-Check, agora sem a regen — essa segue diária em Diaria-Entity-Pages-Regen)",
    steps: [{ key: "alarm", script: "scripts/regenerate-entity-pages.ts", args: ["--alarm-only", "--threshold-days", "1"] }],
    // logPath PRÓPRIO, distinto de Diaria-Entity-Pages-Regen (review da PR
    // #7164) — mesma convenção já testada pro par Diaria-Clarice-Novos/
    // Diaria-Clarice-Novos-Tarde (`test/scheduled-tasks.test.ts`,
    // "logs separados — não misturar as duas rodadas no mesmo arquivo").
    // Cadências e conteúdo diferentes (regen mecânica diária vs. alarme
    // semanal) não deveriam interlaçar no mesmo arquivo.
    logPath: "entities/.staleness-alarm.log",
    // #7147 (02/09/2026): metade nova do split de Diaria-Entity-Pages-Regen
    // — mesmo racional de cadência de Diaria-Hub-Staleness-Check acima
    // (achado muda na cadência de publicação, não de checagem; threshold
    // baixado de 3 pra 1 junto com a troca pra semanal, mesmo motivo).
    // `--alarm-only` pula a regen (já rodou às 09:40 do mesmo dia, na task
    // irmã) e roda só a detecção+alarme. Horário: domingo 09:43, logo depois
    // de Diaria-Hub-Staleness-Check (09:33) — sem colisão com nenhuma outra
    // weekly do registro.
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 9, minute: 43 },
    issue: "#5125, #7147",
  },
  {
    name: "Diaria-Clarice-Novos",
    description: "envio diario aos cadastros novos da Clarice (Stripe -> MV -> campanha)",
    // Kill switch dedicado (#4941 E3): ANTES de qualquer chamada externa,
    // clarice-novos-run.ts checa data/clarice-novos-enabled.json (default
    // `enabled: false` quando ausente — lado seguro, ao contrário do guard
    // abaixo, que é sinal de "data/ ainda não montada"). Os dois convivem:
    // este guard cobre "junction ainda não sincronizou"; o toggle cobre "o
    // editor pausou a automação de propósito".
    steps: [{ key: "run", script: "scripts/clarice-novos-run.ts" }],
    logPath: "clarice-subscribers/.novos-run.log",
    // 09:00 BRT (decisão do editor 16/08/2026, #5447 — sucede as 11:00 do
    // #5140, a partir da análise do #5445). A justificativa não é mais
    // propensão horária de compra (D5 do #4347/#5140) — é o par com a
    // rodada da tarde (`Diaria-Clarice-Novos-Tarde`, hoje 18:00): 09:00+18:00
    // é a curva de chegada de cadastro casada com espaçamento entre as duas
    // rodadas. Números medidos no #5445: latência média cai de 9,2h (par
    // antigo 11:00+15:00) pra 6,7h; % de contatos > 12h de espera cai de 45%
    // pra 16%. O par 11:00+15:00 era só a 210ª melhor combinação de 2
    // horários entre 276 possíveis — 09:00+18:00 venceu por cobrir melhor as
    // duas pontas do dia sem esbarrar na margem de segurança do envio das
    // 19:00 (ver comentário da task -Tarde abaixo).
    //
    // Segue sem colisão com outra task armada (a mais próxima é o ciclo de 4h
    // do Diaria-Clarice-Guardrail-Alarm) e depois do Diaria-Clarice-Sync
    // (08:30), então o store está fresco. Supera a decisão D5 do #4347
    // ("~4×/semana, invocação manual") — a skill manual continua existindo,
    // delegando pro mesmo orquestrador (ver .claude/skills/diaria-clarice-novos).
    schedule: { kind: "daily", hour: 9, minute: 0 },
    guard: {
      requiredFile: "clarice-subscribers/clarice-users.db",
      abortMessage:
        "clarice-users.db nao encontrado (data/clarice-subscribers/clarice-users.db) -- provavel junction " +
        "data/ nao montada ainda; abortando por seguranca, sem tocar Stripe/MV/Brevo.",
    },
    // #5743: exit 3 = disparo INCERTO (POST sendNow aceito, GET-verify
    // pós-disparo não confirmou status terminal — lag assíncrono normal da
    // Brevo, não é falha). Não conta como unit `failed` no systemd — ver
    // docstring de `successExitCodes` e de `NOVOS_SENDNOW_UNCERTAIN_EXIT_CODE`
    // em `clarice-novos-run.ts`.
    successExitCodes: [3],
    issue: "#4347, #4941, #5140, #5445, #5447, #5660, #5743",
  },
  {
    name: "Diaria-Clarice-Novos-Tarde",
    description: "2a captura diaria dos cadastros novos da Clarice (mesmo fluxo do Diaria-Clarice-Novos, 18:00 BRT)",
    // #5185: a issue original propunha `clarice-envio-run.ts` chamar
    // `runNovos()` internamente e alimentar o pool `ramp-warm` direto
    // (opção B, decisão registrada no comentário de 260813 desta issue) —
    // DESCARTADO no briefing ao vivo de 260814 (comentário mais recente da
    // issue). Decisão final do editor: manter os dois fluxos totalmente
    // separados (zero mudança em `clarice-envio-run.ts`/`compareContactRecency`/
    // pool `ramp-warm`) e em vez disso rodar o MESMO `clarice-novos-run.ts`
    // 2x/dia — 11:00 (task existente, inalterada) + esta, às 15:00 — cada
    // rodada com sua própria campanha Brevo imediata, igual ao
    // comportamento de hoje.
    //
    // O QUE ISSO RESOLVE: cadastro feito depois das 11:00 só era pego pelo
    // `novos` do dia SEGUINTE às 11:00 — depois do disparo da rampa
    // `ramp-warm` de amanhã (06:00) já ter acontecido, então nunca competia
    // pela recência real dentro da onda principal (#5169). Uma 2a captura às
    // 15:00 fecha boa parte dessa janela (cadastros de 11:00-15:00 saem no
    // mesmo dia); ainda sobra uma janela menor, 15:00→11:00 do dia seguinte
    // (~20h) — não fechada por esta unidade, decisão explícita do editor de
    // não perseguir cobertura total agora.
    //
    // IDEMPOTÊNCIA (verificada antes de registrar esta entrada, não
    // assumida): `clarice-novos-run.ts`/`clarice-build-segment.ts --group
    // novos` já tem DOIS guards anti-duplo-envio independentes que cobrem
    // rodar o MESMO script 2x no mesmo ciclo Clarice sem código novo —
    // 1. `sent-or-queued.json` (cycle-wide, `clarice-build-segment.ts`):
    //    grava os emails selecionados NO MOMENTO da seleção (antes do envio
    //    de verdade), e a próxima invocação do mesmo ciclo exclui quem já
    //    está lá via `excludeSentOrQueued` — não depende de eventual
    //    consistency da API da Brevo.
    // 2. `guardScope: "committed"` do grupo `novos` (`NAMED_GROUPS`,
    //    clarice-segment.ts): exclui quem já está em lista com campanha
    //    `queued`∪`sent` na Brevo, via `fetchCommittedCampaignListIds`.
    // Os dois juntos cobrem o caso desta task: a rodada das 15:00 não
    // reseleciona ninguém que a das 11:00 já pegou, mesmo que a campanha das
    // 11:00 ainda esteja `in_process` na Brevo (camada 1 não depende do
    // status da Brevo assentar).
    //
    // HORÁRIO — 18:00 BRT (decisão do editor 16/08/2026, #5447, a partir do
    // #5445). O RISCO RESIDUAL descrito no parágrafo acima (guard
    // `queued∪sent` de `Diaria-Clarice-Envio` não cobrir `in_process`) ficou
    // estruturalmente FECHADO pelo #5410 (16/08/2026): `isNovos` deixou de
    // ser subconjunto de `isRampWarm` — os dois predicados hoje PARTICIONAM
    // a fila de 1º envio. `clarice-envio-run.ts` monta a onda via
    // `clarice-build-segment.ts`, que lê `readNovosCutoff()` e passa
    // `cutoffNovosIso` pra `segmentRampWarm`: todo contato com
    // `created >= cutoff` (janela de ~2 dias) fica fora da rampa
    // independente do status da campanha do `novos` na Brevo. O caminho que
    // produzia a duplicata (contato capturado pelo `novos` da tarde ainda
    // `in_process` às 19:00 e entrando TAMBÉM em `ramp-warm`) não existe
    // mais — não é uma questão de folga de horas, é partição por
    // construção.
    //
    // 18:00 (não 18:30, o ótimo marginal medido no #5445) por margem de
    // duração de rodada: mesmo o pior caso medido (31min) termina ~29min
    // antes de `Diaria-Clarice-Envio` (19:00) — o ganho de latência de
    // 18:00→18:30 é de só 0,1h, não vale comer essa margem.
    steps: [{ key: "run", script: "scripts/clarice-novos-run.ts" }],
    // Log próprio (não compartilha arquivo com Diaria-Clarice-Novos) — cada
    // task do registro tem seu logPath dedicado (convenção do arquivo
    // inteiro), e misturar as duas rodadas no mesmo log tornaria a
    // auditoria por horário mais confusa sem ganho nenhum.
    logPath: "clarice-subscribers/.novos-tarde-run.log",
    schedule: { kind: "daily", hour: 18, minute: 0 },
    // Mesmo guard de pré-condição da task das 11:00 — "junction data/ ainda
    // não montada" é uma condição de MÁQUINA, não de horário, então se
    // aplica igual às duas.
    guard: {
      requiredFile: "clarice-subscribers/clarice-users.db",
      abortMessage:
        "clarice-users.db nao encontrado (data/clarice-subscribers/clarice-users.db) -- provavel junction " +
        "data/ nao montada ainda; abortando por seguranca, sem tocar Stripe/MV/Brevo.",
    },
    // Kill switch: `data/clarice-novos-enabled.json` é lido por
    // `runNovos()` (dentro do MESMO script), não por esta entrada do
    // registro — logo já vale automaticamente pras duas tasks sem lógica
    // nova (confirmado lendo `scripts/clarice-novos-run.ts`, sem precisar
    // de um 2o toggle).
    // #5743: mesma distinção de exit code do par das 09:00 — exit 3 =
    // disparo INCERTO (POST sendNow aceito, GET-verify não confirmou status
    // terminal), não conta como unit `failed`.
    successExitCodes: [3],
    issue: "#4347, #4941, #5185, #5410, #5445, #5447, #5660, #5743",
  },
  {
    name: "Diaria-Clarice-Envio",
    description: "planeja e agenda a onda Clarice do dia seguinte (06:00 BRT) - freio por risco de ISP + escalada adaptativa",
    // Kill switch dedicado: ANTES de qualquer chamada Brevo,
    // clarice-envio-run.ts checa data/clarice-envio-enabled.json. **O
    // default deste toggle é o INVERSO do Diaria-Clarice-Novos**: arquivo
    // ausente significa LIGADO (decisão do editor 260811, "ligada desde o
    // início" — a rampa já roda manualmente todo dia, a automação substitui
    // trabalho existente em vez de estrear canal novo). Ver
    // scripts/lib/clarice-envio-enabled.ts pro risco que esse default cobra.
    steps: [{ key: "run", script: "scripts/clarice-envio-run.ts" }],
    logPath: "clarice-subscribers/.envio-run.log",
    // 19:00 BRT (decisão do editor 260811): planeja e AGENDA a onda de
    // amanhã 06:00 BRT (09:00 UTC). Roda depois das DUAS rodadas do
    // Diaria-Clarice-Novos (09:00 e 18:00 desde o #5447, antes 11:00+15:00 do
    // #5140) de propósito — os cadastros novos do dia já entraram no store
    // antes do planejamento da onda. Desde o #5410, `isNovos` e `isRampWarm`
    // PARTICIONAM a fila de 1º envio (`segmentRampWarm` corta por
    // `readNovosCutoff()`) em vez de um ser subconjunto do outro — a
    // exclusão não depende mais da campanha do `novos` ter assentado em
    // `sent` antes das 19:00.
    // #5826 (02/09/2026): minuto movido de :00 pra :10 — `Diaria-Clarice-
    // Dashboard-Precompute` roda em `interval hours:1`, que `scheduleToOnCalendar`
    // traduz SEMPRE pro minuto :00 de cada hora (`OnCalendar=*-*-* 0/N:00:00`,
    // ver o tipo `ScheduledTaskSchedule` no topo deste arquivo) — ou seja,
    // TODA hora cheia, inclusive 19:00, o precompute dispara. Com esta task
    // também em :00, as duas batiam no MESMO minuto TODO dia (confirmado ao
    // vivo: journal mostra as duas arrancando "19:00:08" em 01/09/2026),
    // contribuindo pra estourar o teto de 100 req/hora POR CONTA da Brevo
    // (docs/brevo-rate-limits.md) — 1 dos 3 achados que #6458/#5826/#6945
    // deixaram registrado sobre a MESMA falha intermitente (#6831/#7007).
    // :10 elimina a colisão determinística com QUALQUER task `interval`
    // deste registro (todas caem em :00 por construção) sem precisar
    // remanejar nada mais — nenhuma outra task `daily` ocupa a hora 19 (ver
    // grep de `kind: "daily"` neste arquivo).
    schedule: { kind: "daily", hour: 19, minute: 10 },
    // Mesmo guard do Diaria-Clarice-Novos (#4552/#4941): sem o store, o
    // planejamento leria uma base vazia e derivaria volume/freio de nada —
    // pior que não rodar. Independente do kill switch acima: este cobre
    // "junction data/ ainda não montada", o toggle cobre "o editor pausou".
    guard: {
      requiredFile: "clarice-subscribers/clarice-users.db",
      abortMessage:
        "clarice-users.db nao encontrado (data/clarice-subscribers/clarice-users.db) -- provavel junction " +
        "data/ nao montada ainda; abortando por seguranca, sem planejar nem agendar onda.",
    },
    // #5826: exit 4 = lock de concorrência (scripts/lib/clarice-envio-lock.ts)
    // já estava travado por outra rodada/sessão manual — abort SEGURO, sem
    // tocar Brevo, não uma falha genuína (achado ao vivo: unit das 22:00
    // colidiu com sessão manual do editor às 21:42, `Diaria-Systemd-Failed-
    // Units-Alarm` disparou em cima de exit 1 indistinguível de erro real).
    // Mesmo padrão do exit 3 de `Diaria-Clarice-Novos` acima, código
    // diferente de propósito (ver comentário em clarice-envio-run.ts).
    successExitCodes: [4],
    issue: "#5025, #5026, #5027 (decisões do editor 260811), #5826",
  },
  {
    name: "Diaria-Clarice-Envio-Guard",
    description: "guard matinal da onda Clarice ja agendada - reavalia o freio de risco de ISP antes do disparo das 06:00",
    // Segunda metade do par: a onda é agendada às 19:00 do dia anterior, e a
    // Brevo congela destinatários no AGENDAMENTO, não no envio (memória do
    // projeto: brevo-recipients-snapshot). Entre 19:00 e 06:00 chegam ~11h de
    // bounce/unsub/spam da onda ANTERIOR — este passo reavalia o freio com
    // esse dado fresco e é a última chance de segurar o disparo.
    steps: [{ key: "guard", script: "scripts/clarice-envio-guard.ts" }],
    logPath: "clarice-subscribers/.envio-guard.log",
    // 05:00 BRT (decisão do editor 260811): 1h de folga antes do disparo das
    // 06:00, e 30min antes do Diaria-Brevo-Diaria-Evaluate (05:30) — mesma
    // classe de restrição do #4534 (tem que rodar ANTES do envio, senão a
    // ação não afeta a campanha do dia), com margem maior porque aqui o
    // desfecho possível é cancelar uma campanha, não só desvincular contato.
    schedule: { kind: "daily", hour: 5, minute: 0 },
    // SEM guard de requiredFile de propósito: este passo é a rede de
    // segurança do par, e um guard de pré-condição que aborta a rodada
    // suprimiria justamente a checagem que pode segurar um disparo ruim. Se
    // ele precisar do store, quem implementar clarice-envio-guard.ts decide
    // como tratar a ausência DENTRO do script (onde dá pra distinguir "não
    // consegui checar" de "checado, está tudo bem" — #738).
    //
    // #6221 — exit 3 = ESCALADA DELIBERADA (pré-requisito falhou, freio HOLD
    // com override do editor vigente sobre ele, #6134 — guard não cancela
    // por cima da decisão do editor e escala pro humano em vez disso). Sem
    // isto, a unit ia pra `failed` e disparava o `Diaria-Systemd-Failed-
    // Units-Alarm` (#5942) igual a uma exceção real — já produziu leitura
    // invertida ao vivo (#6215, #6221). Mesmo padrão do exit 4 de
    // `Diaria-Clarice-Envio` acima (lock held ≠ falha genuína) e do exit 3
    // de `Diaria-Clarice-Novos`/`-Tarde` — o alarme correto pra este caso
    // é `Diaria-Clarice-Envio-Guard-Alarm` (#5220, lê o reportId, não o
    // exit code), não o alarme genérico de unit quebrada.
    successExitCodes: [3],
    issue: "#5025, #5026, #5027 (decisões do editor 260811), #6221",
  },
  {
    name: "Diaria-Clarice-Envio-Guard-Alarm",
    description: "alarme proprio do guard das 05:00 - le a familia envio-{aammdd}-guard-* e alarma se o guard falhou ou nao rodou",
    // #5220 (Gap 2 achado na mesma issue do retry): `Diaria-Clarice-Envio-Alarm`
    // (abaixo, 20:30) escolhe o relatorio MAIS RECENTE entre TODOS os
    // `envio-{aammdd}*.md` do dia -- as 20:30 o relatorio do run das 19:00 e
    // sempre ~15h mais novo que o do guard desta MESMA manha e vence, entao
    // um abort do guard ficava invisivel (e, no sentido inverso, um
    // `-guard-ok` normal viraria alarme falso-positivo se o guard fosse o
    // mais recente, ja que os sufixos `-guard-*` nao estao na OK_SUFFIXES
    // daquele alarme). Esta task le SO a familia `-guard-*`, isolada.
    steps: [{ key: "alarm", script: "scripts/clarice-envio-guard-alarm.ts" }],
    logPath: "clarice-subscribers/.envio-guard-alarm.log",
    // 06:15 BRT: depois do guard das 05:00 (orcamento de retry+fallback do
    // #5220 cabe folgado em ~20min no pior caso) e do disparo das 06:00 --
    // roda logo depois pra o editor ainda ter chance de agir manualmente se
    // o guard caiu no fallback e a onda ja disparou por decisao dele.
    schedule: { kind: "daily", hour: 6, minute: 15 },
    // Mesmo guard das outras tasks Clarice-Envio -- sem o store, o guard das
    // 05:00 nunca teria rodado de verdade nesta maquina, entao um alarme
    // "nenhum relatorio encontrado" seria ruido, nao sinal real.
    guard: {
      requiredFile: "clarice-subscribers/clarice-users.db",
      abortMessage:
        "clarice-users.db nao encontrado (data/clarice-subscribers/clarice-users.db) -- provavel junction " +
        "data/ nao montada ainda; sem sentido checar relatorio de um guard que nunca roda nesta maquina.",
    },
    issue: "#5220",
  },
  {
    name: "Diaria-Clarice-Envio-Alarm",
    description: "alarme de rodada falha do Diaria-Clarice-Envio - le o relatorio do dia e alarma se a onda nao foi agendada",
    steps: [{ key: "alarm", script: "scripts/clarice-envio-alarm.ts" }],
    logPath: "clarice-subscribers/.envio-alarm.log",
    // 22:45 BRT (#6831, 02/09/2026 -- era 20:30/#5058): Diaria-Clarice-Envio
    // moveu pra 19:10 (#5826) e seu orcamento de retry subiu de 35min pra
    // 70min por tentativa (TRANSIENT_RETRY_CAP_MS, clarice-envio-run.ts) --
    // pior caso agora e ~2h20 so pro retry do sinal 429/503 do dashboard
    // (2 esperas x 70min), mais a nova retentativa dedicada da consulta de
    // campanhas comprometidas (retryProposalOnCommittedRateLimit, mesmo
    // orcamento, mesmo #6831) que pode somar tempo em cima disso numa
    // rodada genuinamente azarada. 22:45 (19:10 + 3h35) da folga real pro
    // pior caso plausivel antes de alarmar -- sem isso, a checagem antiga
    // (20:30) alarmaria em cima de um retry legitimo ainda em curso quase
    // toda vez que o orcamento maior fosse de fato usado.
    schedule: { kind: "daily", hour: 22, minute: 45 },
    // Mesmo guard das outras 2 tasks Clarice-Envio acima -- sem o store, a
    // rodada das 19:00 nunca teria rodado de verdade nesta maquina, entao um
    // alarme "nenhum relatorio encontrado" seria ruido, nao sinal real.
    guard: {
      requiredFile: "clarice-subscribers/clarice-users.db",
      abortMessage:
        "clarice-users.db nao encontrado (data/clarice-subscribers/clarice-users.db) -- provavel junction " +
        "data/ nao montada ainda; sem sentido checar relatorio de uma rodada que nunca roda nesta maquina.",
    },
    // Mesmo padrao de Diaria-Home-Meta-Check (#5005, 1a task
    // registrada depois do cutover systemd/epica #4798). Via de execucao
    // real: par `.service`/`.timer` gerado por scripts/setup-systemd-timers.ts.
    issue: "#5058",
  },
  {
    name: "Diaria-Clarice-Envio-Engajados",
    description: "estende a orquestracao diaria do ramp-warm ao grupo engajados (retencao) -- teto de volume + kill switch dedicado, #6945",
    // Kill switch dedicado, DIFERENTE do Diaria-Clarice-Envio: nasce
    // DESLIGADO (clarice-envio-engajados-enabled.ts) -- automacao NOVA que
    // dispara e-mail real pra ate ENGAJADOS_MAX_DAILY_VOLUME contatos/dia
    // sem gate humano no caminho normal; o editor liga explicitamente
    // depois de revisar a 1a rodada. Ver docstring do script pro racional
    // completo (mesma inversao de default de clarice-novos-enabled.ts).
    steps: [{ key: "run", script: "scripts/clarice-envio-engajados-run.ts" }],
    logPath: "clarice-subscribers/.envio-engajados-run.log",
    // 20:15 BRT: depois do Diaria-Clarice-Envio das 19:10 (#5826) -- reusa
    // o assunto do dia JA TRAVADO por aquela rodada (mesma edicao, publico
    // diferente) e compartilha o MESMO lock por ciclo
    // (clarice-envio-lock.ts) -- 1h+ de folga cobre o caso comum (ramp-warm
    // termina em minutos); numa rodada rara em que o ramp-warm ainda esta
    // retentando (#6831, ate ~2h20 no pior caso), esta task recebe
    // LockHeldError e sai com exit 4 (nao e falha -- ver successExitCodes
    // abaixo), self-healing no dia seguinte (a escalada de volume nao perde
    // progresso num dia pulado, ver clarice-envio-engajados-state.ts).
    schedule: { kind: "daily", hour: 20, minute: 15 },
    // Mesmo guard das outras tasks Clarice-Envio -- sem o store, o
    // planejamento leria uma base vazia.
    guard: {
      requiredFile: "clarice-subscribers/clarice-users.db",
      abortMessage:
        "clarice-users.db nao encontrado (data/clarice-subscribers/clarice-users.db) -- provavel junction " +
        "data/ nao montada ainda; abortando por seguranca.",
    },
    // exit 4 = lock ja detido por rodada concorrente (ramp-warm no mesmo
    // ciclo, ou outra sessao manual) -- abort SEGURO, nunca falha genuina,
    // mesmo padrao/codigo do Diaria-Clarice-Envio acima (mesmo lock
    // compartilhado por design, ver docstring do script).
    successExitCodes: [4],
    // DECLARADA, NAO ARMADA nesta unidade (mesma disciplina do
    // Diaria-Branch-Cleanup acima) -- armar requer, na helios, apos o
    // merge E o editor confirmar a 1a rodada manual/dry-run e ligar o kill
    // switch:
    //   npx tsx scripts/clarice-envio-engajados-run.ts --dry-run   # revisar
    //   npx tsx scripts/lib/clarice-envio-engajados-enabled.ts --set enabled
    //   npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Envio-Engajados
    //   npx tsx scripts/arm-systemd-timers.ts --task Diaria-Clarice-Envio-Engajados
    issue: "#6945",
  },
  {
    name: "Diaria-Clarice-Envio-Engajados-Alarm",
    description: "alarme de rodada falha do Diaria-Clarice-Envio-Engajados -- le o relatorio do dia e alarma se a onda nao foi agendada",
    steps: [{ key: "alarm", script: "scripts/clarice-envio-engajados-alarm.ts" }],
    logPath: "clarice-subscribers/.envio-engajados-alarm.log",
    // 21:15 BRT -- 1h depois do Diaria-Clarice-Envio-Engajados (20:15).
    // Diferente do ramp-warm, esta task NAO tem retry-com-backoff proprio
    // (ver docstring de clarice-envio-engajados-run.ts) -- 1h e folga ampla
    // pra uma rodada sem retry terminar.
    schedule: { kind: "daily", hour: 21, minute: 15 },
    guard: {
      requiredFile: "clarice-subscribers/clarice-users.db",
      abortMessage:
        "clarice-users.db nao encontrado (data/clarice-subscribers/clarice-users.db) -- provavel junction " +
        "data/ nao montada ainda; sem sentido checar relatorio de uma rodada que nunca roda nesta maquina.",
    },
    // DECLARADA, NAO ARMADA nesta unidade -- mesmo par do zelador acima,
    // armar junto com Diaria-Clarice-Envio-Engajados:
    //   npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Envio-Engajados-Alarm
    //   npx tsx scripts/arm-systemd-timers.ts --task Diaria-Clarice-Envio-Engajados-Alarm
    issue: "#6945",
  },
  {
    name: "Diaria-Postmaster-Spam-Sync",
    description: "sync automatico do spamRate do Google Postmaster Tools",
    steps: [{ key: "sync", script: "scripts/postmaster-spam-sync.ts" }],
    logPath: "clarice-subscribers/.postmaster-spam-sync.log",
    // Diária 12:30 (mudou de "a cada 12h", decisão do editor 260810): a
    // leitura já é uma MÉDIA sobre HEALTH_SAMPLE_DAYS, 1x/dia basta — a
    // cadência de 12h nunca teve razão de ser além de folga extra contra
    // execução perdida, ver docs/postmaster-spam-sync-setup.md.
    schedule: { kind: "daily", hour: 12, minute: 30 },
    issue: "#4154",
  },
  {
    name: "Diaria-Postmaster-Spam-Alarm",
    description: "alarme de sinal de spam do Postmaster cego (staleness geral) + campaignSpam ausente prolongado",
    steps: [{ key: "alarm", script: "scripts/clarice-postmaster-alarm.ts" }],
    logPath: "clarice-subscribers/.postmaster-alarm.log",
    // #5399 registrou o script mas nunca a task (achado #5446: o texto do
    // próprio e-mail já citava "Diaria-Postmaster-Spam-Alarm" como se
    // existisse). 12:45 — 15min depois do Diaria-Postmaster-Spam-Sync
    // (12:30) acima, mesma folga de ordem de grandeza usada entre monitor e
    // alarme semanal do GEO (Diaria-Geo-Citation-Monitor 07:00 →
    // Diaria-Geo-Citation-Staleness-Alarm 10:30): dá tempo do sync gravar no
    // KV antes do alarme ler.
    schedule: { kind: "daily", hour: 12, minute: 45 },
    issue: "#5399, #5446",
  },
  {
    name: "Diaria-SEO-Weekly",
    description: "loop de SEO semanal (cobertura de indexacao + Search Analytics)",
    steps: [
      // --limit 2000 (subiu de 250 no #5118 item 1a): a cota real da URL
      // Inspection API é 2.000/dia contra ~239 URLs/rodada — 250 dava só
      // ~2,8 semanas de headroom antes de truncar, e o corte descartava as
      // URLs MAIS ANTIGAS (sitemap newest-first, ver applyLimit em
      // seo-index-check.ts) sem marca nenhuma no relatório — o KPI de
      // cobertura inflaria sozinho por composição, não por melhora real.
      {
        key: "index",
        script: "scripts/seo-index-check.ts",
        args: ["--only-posts", "--limit", String(GSC_URL_INSPECTION_DAILY_QUOTA)],
      },
      // #4909: /temas/{slug} (host arquivo.diar.ia.br) nunca entrou nesta
      // checagem — a propriedade GSC verificada é sc-domain:diar.ia.br
      // (cobre o subdomínio, sem --site próprio necessário), então SEM
      // --only-posts (o filtro é /\/p\//, que zeraria tudo aqui — ver
      // filterPosts em seo-index-check.ts).
      // --limit 2000 (subiu de 10 no #5975; "7 URLs, a raiz + 6 hubs" do
      // comentário anterior — #5118/#5120 — já estava desatualizado quando
      // escrito: o #5722 (19/08/2026, poucos dias antes desta rodada)
      // trocou o gerador do sitemap deste Worker
      // (`workers/arquivo/src/index.ts`, `buildArquivoSitemapXml`) de "só
      // hub + raiz" pra "hub + raiz + 1 <url> por edição publicada" (mesma
      // fonte que a raiz HTML já consome via `resolveEditions`), pra que o
      // PRÓPRIO sitemap cubra o acervo — o sitemap do host principal, do
      // qual a cobertura de edições dependia antes, é o que nenhum
      // crawler segue (#5692).
      // Medição ao vivo em 23/08/2026 (#5975): ~252 URLs reais. --limit 10
      // mantinha as 10 edições MAIS ANTIGAS e descartava as 242 mais
      // recentes — incluindo raiz + /temas/ + os 6 hubs inteiros, que
      // vinham antes das edições no sitemap (`applyLimit` corta do INÍCIO
      // do array, #5118: sitemap é newest-first, o corte preserva a
      // CAUDA/mais antiga) — ou seja, nenhum hub/raiz era checado desde
      // que o #5722 mudou a composição. Não é silencioso (aviso +
      // `truncated` no relatório desde #5118), só um limite pequeno demais
      // pro tamanho atual. --limit 2000 é o MESMO valor do passo "index"
      // acima (mesmo racional): a cota da URL Inspection API é 2.000/dia
      // POR PROPRIEDADE (sc-domain:diar.ia.br, compartilhada entre os dois
      // passos — GSC_QUOTA_PER_DAY abaixo), e o consumo real de hoje é
      // ~239 (passo "index") + ~252 (este passo) = ~491/dia — bem abaixo
      // da cota mesmo somando os dois `--limit` nominais (verificado por
      // teste, ver test/scheduled-tasks.test.ts). Escolhido acima de um
      // valor mais próximo de 252 de propósito: este sitemap cresce ~1
      // URL/dia (1 edição diária/dia útil) — um teto justo reproduziria o
      // mesmo bug em poucos meses.
      // --out-suffix evita que esta rodada colida no mesmo
      // index-status-{data}.json/.md do passo "index" acima (achado do
      // #4909 — o .md era path fixo, não sobrescrevível por --out).
      {
        key: "index-arquivo",
        script: "scripts/seo-index-check.ts",
        args: [
          "--sitemap",
          "https://arquivo.diar.ia.br/sitemap.xml",
          "--limit",
          String(GSC_URL_INSPECTION_DAILY_QUOTA),
          "--out-suffix",
          "arquivo",
        ],
      },
      { key: "pull", script: "scripts/seo-pull.ts", args: ["--days", "28"] },
    ],
    logPath: "seo/.seo-weekly.log",
    // Domingo 04:10 (mudou de segunda 04:10, decisão do editor 260810 —
    // mesmo horário, só o dia mudou). Continua antes de tudo (nenhuma daily
    // roda antes das 05:30).
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 4, minute: 10 },
    issue: "#4105, #1896, #1989, #4909",
  },
  {
    name: "Diaria-Beehiiv-Backup",
    description: "snapshot semanal da publicacao Beehiiv (assinantes com origem + engajamento, posts, segmentos)",
    steps: [{ key: "backup", script: "scripts/backup-beehiiv.ts" }],
    logPath: "beehiiv-backup/.backup.log",
    // Domingo 03:00 BRT — o primeiro timer do dia, antes do Diaria-Seo-Weekly
    // (04:10, o mais cedo já registrado) e de qualquer daily (a mais cedo é
    // 05:00). Um snapshot pesado (drena a base inteira, ~13 páginas) merece a
    // janela mais vazia da semana.
    //
    // **Por que isto existe (#5229):** o backup NUNCA rodou agendado — os dois
    // únicos snapshots em `data/beehiiv-backup/` são 2026-06-05 e 2026-06-17,
    // ambos manuais. Enquanto isso, `promoteBeehiivSubscription`
    // (`scripts/evaluate-brevo-diaria.ts`) faz DELETE+CREATE todo dia às 05:30
    // e sobrescreve o `utm_source` original de quem é promovido por score —
    // 191 contatos já perderam a origem e 298 estão na fila. O snapshot é o
    // único mecanismo que preserva a versão anterior, e sem agendamento ele
    // não preserva nada.
    //
    // Cadência semanal, e ela NÃO fecha o problema — só reduz. São duas vias
    // de promoção em paralelo (`scripts/evaluate-brevo-diaria.ts` §"Duas vias
    // de promoção em paralelo — clique OU score", #4476 item 2):
    //
    //   - **Score** (`promoteBeehiivSubscription`, 05:30 diário): exige
    //     acumular score por semanas, então o contato quase sempre aparece num
    //     snapshot anterior com a origem intacta. Aqui o semanal cobre bem.
    //   - **Clique** (`workers/reativar/`, tempo real): dispara no instante em
    //     que a pessoa clica no link de reativação da edição diária do
    //     `brevo_diaria`, com o MESMO DELETE+CREATE destrutivo
    //     (`BREVO_DIARIA_REATIVAR_CLIQUE_UTM`). Sem gate de score, sem espera.
    //     Quem entra no pool e clica na mesma semana nunca é snapshotado —
    //     e converter por clique rápido é exatamente o propósito do canal,
    //     então esse caso não é raro (achado do review da PR #5230).
    //
    // Não subimos pra diário porque isso também não fecharia a via de clique
    // (dá pra entrar no pool e clicar no mesmo dia) — pagaria 7× o disco por
    // uma cobertura ainda parcial. O conserto real da via de clique é
    // preservação IN-BAND: os dois call sites já fazem `GET by_email` antes do
    // DELETE, então o `utm_source`/`created` originais estão na mão e bastaria
    // ecoá-los num custom field do CREATE. Está registrado como follow-up na
    // #5229; este snapshot é a rede de proteção enquanto isso não existe.
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 3, minute: 0 },
    // Mesmo caso de `Diaria-Home-Meta-Check` (#5005): task registrada
    // depois do cutover systemd (épica #4798), sem contraparte Windows/.ps1 —
    // e nenhuma tarefa `Diaria-*` deve rodar no Windows (#5074).
    issue: "#5229",
  },
  {
    name: "Diaria-Acquisition-Health-Alarm",
    description: "alarme semanal de saude de aquisicao por canal (sobrevivencia, CTR, canal novo/parado)",
    steps: [{ key: "check", script: "scripts/check-acquisition-health.ts" }],
    logPath: "acquisition-health/.check.log",
    // Domingo 03:30 BRT (#5249, sugestão da própria issue) — 30min depois do
    // Diaria-Beehiiv-Backup (03:00, acima), que gera o snapshot semanal que
    // este alarme lê. Folga suficiente pro backup (drena a base inteira,
    // ~13 páginas) terminar antes deste rodar sobre a data mais recente.
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 3, minute: 30 },
    issue: "#5249",
  },
  {
    name: "Diaria-Beehiiv-Backup-Staleness-Alarm",
    description: "alarme de staleness do snapshot semanal do Diaria-Beehiiv-Backup (ausente/vencido/inutilizavel)",
    steps: [{ key: "alarm", script: "scripts/beehiiv-backup-staleness-alarm.ts" }],
    logPath: "beehiiv-backup/.staleness-alarm.log",
    // Domingo 04:00 BRT (#5494) — depois do Diaria-Beehiiv-Backup (03:00) e
    // do Diaria-Acquisition-Health-Alarm (03:30, acima), pegando também o
    // caso "o alarme de aquisição não avaliou nada porque o backup não
    // gerou snapshot novo" (item 3 da issue #5494 — antes disso, isso ficava
    // indistinguível de "já avaliado nesta semana" no journal).
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 4, minute: 0 },
    issue: "#5494",
  },
  {
    name: "Diaria-Kit-Roster-Ingest",
    description:
      "captura diaria do roster completo do Kit (status=all) no store unificado do #6464 -- popula a dimensao " +
      "subscription (fatia F2 do epico #7172), que nenhuma ingestao tocava ate aqui",
    steps: [{ key: "ingest", script: "scripts/diaria-subscribers-ingest-kit.ts", args: ["--write"] }],
    logPath: "diaria-subscribers/.kit-roster-ingest.log",
    // Daily 04:25 BRT — depois da fronteira do dia (00:00 BRT) e antes do
    // cluster matinal (a 1ª daily é Diaria-Clarice-Envio-Guard, 05:00), fora
    // do bloco de domingo (Diaria-Beehiiv-Backup 03:00, -Acquisition-Health-
    // Alarm 03:30, -Beehiiv-Backup-Staleness-Alarm 04:00, -SEO-Weekly 04:10 —
    // 04:25 evita colidir com essa janela). O horário importa pouco: o Kit
    // retém `created_at` por assinante, então o que ele minimiza é a janela
    // em que alguém cadastra e é deletado do Kit antes de ser visto 1 vez.
    schedule: { kind: "daily", hour: 4, minute: 25 },
    // `--write` grava de verdade (a task agendada é o ÚNICO caller que passa
    // essa flag por padrão — execução manual é dry-run, ver docstring de
    // `diaria-subscribers-ingest-kit.ts`). Guard de escritor único (cópia de
    // conflito do OneDrive em data/metrics/) roda dentro do próprio script,
    // não aqui — mesmo padrão de `requiredFile` abaixo cobrindo só a
    // ausência de `data/`.
    guard: {
      requiredFile: "diaria-subscribers/diaria-subscribers.db",
      abortMessage:
        "store do #6464 ausente (junction data/ do OneDrive caida?) -- captura do roster Kit abortada em vez de sair 0.",
    },
    // DECLARADA, NÃO ARMADA nesta unidade (worktree isolado, mesma
    // disciplina do #5220/#5217/#5311/#5494/#5607/#5704/#5754/#5845 acima) —
    // armar via `scripts/setup-systemd-timers.ts` na checkout compartilhada
    // (`helios`) é ação POSTERIOR do editor/coordenador, fora do alcance de
    // um subagente implementador em worktree isolado.
    issue: "#7174",
  },
  {
    name: "Diaria-Worker-Drift-Check",
    description: "alarme de drift entre o codigo publicado e o master de cada Worker",
    steps: [{ key: "check", script: "scripts/worker-drift-check.ts" }],
    logPath: "worker-drift-check/.drift-check.log",
    schedule: { kind: "interval", hours: 6 },
    issue: "#4723",
  },
  {
    name: "Diaria-Bing-Seo-Monthly-Pull",
    description: "pull mensal de demanda (Bing Keyword Research) + autoridade (Bing backlinks)",
    // Um passo por issue-mãe (#5128 demanda, #5130 autoridade) — mesmo
    // módulo (`scripts/bing-pull.ts`, "mesmo módulo, provavelmente mesmo
    // PR" já era a instrução literal do #5130), cadência idêntica (nenhum
    // dos dois dados muda em granularidade menor que mês: volume de busca
    // de termo e contagem de backlink não têm ritmo semanal), então 1 task
    // com 2 passos em vez de 2 tasks separadas competindo pela mesma janela.
    steps: [
      { key: "keywords", script: "scripts/bing-pull.ts", args: ["--mode", "keywords"] },
      { key: "links", script: "scripts/bing-pull.ts", args: ["--mode", "links"] },
    ],
    logPath: "seo/.bing-monthly-pull.log",
    // Dia 1, 09:00 BRT — depois da janela weekly de SEO (domingo 04:10,
    // Diaria-Seo-Weekly acima) e do Postmaster diário (12:30), sem colidir
    // com nenhuma outra daily/weekly já registrada; dia 1 é o âncora óbvia
    // pra "1x por mês" e cai dentro do intervalo 1-28 válido pra `monthly`
    // (ver docstring de `ScheduledTaskSchedule`).
    schedule: { kind: "monthly", day: 1, hour: 9, minute: 0 },
    // Mesmo caso de `Diaria-Home-Meta-Check` (#5005): task
    // registrada depois do cutover systemd (épica #4798). Não roda no
    // Windows por princípio (nenhuma tarefa `Diaria-*` deve, #5074) — mesmo
    // que rodasse, `data/` (OneDrive) é onde o output
    // (`bing-keywords-*.json`/`bing-links-*.json`) precisa pousar de
    // qualquer forma.
    issue: "#5128, #5130",
  },
  {
    name: "Diaria-On-Hold-Vencimento-Alarm",
    description: "alarme semanal de vencimento das issues on-hold (Vencimento: AAAA-MM-DD no corpo)",
    steps: [{ key: "alarm", script: "scripts/on-hold-vencimento-alarm.ts" }],
    logPath: "on-hold-vencimento-alarm/.alarm.log",
    // Domingo 11:00 BRT — sem colisão com nenhum outro timer de domingo já
    // registrado (03:00 Beehiiv-Backup, 03:30 Acquisition-Health-Alarm, 07:00
    // Geo-Citation-Monitor, 10:30 Geo-Citation-Staleness-Alarm, 22:00
    // LinkedIn-Weekly-Staleness-Alarm). Granularidade dos vencimentos
    // declarados é de semanas — weekly basta (#5317, sugestão da própria
    // issue).
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 11, minute: 0 },
    // Mesmo caso de `Diaria-Home-Meta-Check` (#5005): task registrada
    // depois do cutover systemd (épica #4798), sem contraparte Windows/.ps1 —
    // e nenhuma tarefa `Diaria-*` deve rodar no Windows (#5074).
    issue: "#5317",
  },
  {
    name: "Diaria-OneDrive-Sync-Alarm",
    description: "alarme de sync do OneDrive parado (servico morto ou canario de frescor stale)",
    steps: [{ key: "alarm", script: "scripts/onedrive-sync-alarm.ts" }],
    logPath: "onedrive-sync-alarm/.alarm.log",
    // A cada 4h (#5548) — mesma ordem de grandeza de outros alarmes de
    // cadência curta do repo (`Diaria-Clarice-Guardrail-Alarm`,
    // `Diaria-Worker-Drift-Check`). O incidente de referência (serviço morto
    // 17h sem ninguém perceber) pede detecção em horas, não em dias.
    schedule: { kind: "interval", hours: 4 },
    issue: "#5548",
  },
  {
    name: "Diaria-Systemd-Failed-Units-Alarm",
    description:
      "sweep generico de units systemd --user diaria-*.service em estado failed (cobre as ~34 tasks do registro de graca, #5563)",
    steps: [{ key: "alarm", script: "scripts/systemd-failed-units-alarm.ts" }],
    logPath: "systemd-failed-units-alarm/.alarm.log",
    // A cada 2h — mesma cadencia de Diaria-Cursos-Error-Alarm (custo e
    // detecção em horas, não em dias; `systemctl --user list-units` é
    // instantâneo, sem I/O de rede além do e-mail eventual). Achado de
    // referência (#5563): diaria-edicao-diaria.service falhou 4x em silencio
    // porque `systemctl --user list-timers` continua "saudável" mesmo com o
    // service morto — só `--state=failed` revela.
    schedule: { kind: "interval", hours: 2 },
    issue: "#5563",
  },
  {
    name: "Diaria-Studio-Liveness-Alarm",
    description:
      "GET http://127.0.0.1:4174/ do Studio server — alarma apos 2 falhas consecutivas (ponto cego do sweep --state=failed pra unit zumbi, #5759)",
    steps: [{ key: "alarm", script: "scripts/studio-liveness-alarm.ts" }],
    logPath: "studio-liveness-alarm/.alarm.log",
    // Issue sugere 10min (janela do incidente foi ~15min, precisa ser
    // detectável em <=2 ciclos). `ScheduledTaskSchedule.interval` só suporta
    // granularidade de HORA inteira (`hours: number`, sem `minutes` — ver
    // `scheduleToOnCalendar` em systemd-units.ts, `0/N:00:00`); o precedente
    // mais fino já registrado é 1h (Diaria-Clarice-Dashboard-Precompute).
    // Estender o schema pra granularidade de minuto tocaria
    // `scheduled-task-status.ts` (cálculo de staleness/overdue usado por
    // várias tasks) de forma mais ampla que o escopo desta issue — decisão:
    // usar o interval mais fino JÁ suportado (1h) em vez de expandir o
    // schema. Efeito: 2 falhas consecutivas cobrem até ~2h de indisponibilidade
    // não detectada (mais frouxo que os 10min sugeridos, mas ainda um
    // limite superior conhecido — e uma melhora categórica sobre o estado
    // anterior, "o editor é o monitor"). Se o editor quiser detecção mais
    // apertada, o próximo passo é uma issue própria pra granularidade de
    // minuto no schema, não um workaround ad-hoc aqui.
    schedule: { kind: "interval", hours: 1 },
    issue: "#5759",
  },
  {
    name: "Diaria-Edicao-Diaria-Staleness-Alarm",
    description:
      "alarme de staleness especifico do diaria-edicao-diaria.timer (nunca disparou vs disparou-e-falhou; #5563)",
    steps: [{ key: "alarm", script: "scripts/edicao-diaria-staleness-alarm.ts" }],
    logPath: "edicao-diaria-staleness-alarm/.alarm.log",
    // Diária 18:20 BRT — ~2h20 depois do disparo do diaria-edicao-diaria.timer
    // (dom-qui 16:00 BRT, ver docs/scheduled-edicao-setup.md), dando margem
    // pro pipeline completo (tipicamente 50-90 turnos, --max-turns 120)
    // terminar antes da checagem rodar. Horário livre — sem colisão com
    // nenhuma outra daily já registrada (ver grep de `kind: "daily"` neste
    // arquivo; o slot mais próximo é 18:10, Diaria-Clarice-Novos-Abort-Alarm).
    // O sweep genérico acima (Diaria-Systemd-Failed-Units-Alarm) cobre
    // "disparou e falhou" via `systemctl --state=failed`; este alarme cobre
    // o que o sweep genérico não consegue: "nunca disparou" — não há nada em
    // `failed` pra um service que nunca foi invocado pelo timer.
    schedule: { kind: "daily", hour: 18, minute: 20 },
    issue: "#5563",
  },
  {
    name: "Diaria-Task-Never-Armed-Alarm",
    description:
      "detector de drift entre o registro declarativo e o systemd real: task no registro sem timer armado (e o inverso, mais fraco), #5607",
    steps: [{ key: "alarm", script: "scripts/task-never-armed-alarm.ts" }],
    logPath: "task-never-armed-alarm/.alarm.log",
    // Diária 18:30 BRT — slot livre (ver grep de `kind: "daily"` neste
    // arquivo; o vizinho mais próximo é 18:20, Diaria-Edicao-Diaria-
    // Staleness-Alarm). Drift lento (registro vs. máquina só diverge
    // quando alguém adiciona/remove task e esquece de armar/desarmar) —
    // cadência diária é suficiente, não precisa de intervalo curto como o
    // sweep de units failed. Achado ao vivo que motivou (#5607): 6 tasks
    // no registro (incluindo o próprio Diaria-Systemd-Failed-Units-Alarm)
    // nunca tiveram timer armado na helios, e nenhum alarme existente
    // pegou isso — só foram achadas por acaso.
    // NOTA (mesmo padrão documentado em docs/scheduled-tasks-registry.md
    // pras outras tasks desta unidade): ainda NÃO armada — rodar
    // `scripts/setup-systemd-timers.ts` (ou equivalente) da checkout
    // compartilhada depois do merge. Até lá, esta própria task aparecerá
    // como "nunca armada" na 1ª execução manual — esperado.
    schedule: { kind: "daily", hour: 18, minute: 30 },
    issue: "#5607",
  },
  {
    name: "Diaria-Google-Ads-Spend-Ingest",
    description: "ingestao diaria de gasto do Google Ads (GAQL) para data/aquisicao/spend.csv",
    steps: [{ key: "ingest", script: "scripts/google-ads-ingest-spend.ts" }],
    logPath: "aquisicao/.google-ads-ingest.log",
    // 09:50 BRT — item 4 do #5704 (itens 1-3, credenciais GOOGLE_ADS_*, ja
    // confirmados funcionais ao vivo em 19/08/2026: consulta GAQL real
    // devolveu 200 com dados). O script agrega por MES sobre uma janela de
    // 90 dias (ver docstring de toGaqlDate em google-ads-ingest.ts) -- nao
    // depende do gasto do dia corrente ja ter consolidado, entao "manha
    // cedo" nao e sobre esperar o dado fechar, e sobre rodar depois da
    // virada do dia-calendario no fuso da conta (BRT, UTC-3) ja ter
    // passado havia horas, evitando a borda descrita naquele docstring.
    // Horario dentro do cluster matinal de checks/syncs (09:00-09:45 ja
    // ocupados por Clarice-Novos/Opens-Catchup-Alarm/Hub-Staleness-Check/
    // Home-Meta-Check/Entity-Pages-Regen/Apoios-Diff-Alarm -- ver
    // grep de `kind: "daily"` neste arquivo), sem colidir com nenhum:
    // 09:50 fica livre, e retoma o horario ja proposto (nao armado) pro
    // #5502 Parte C mais acima neste arquivo -- mesma janela, escopo
    // reduzido aqui a so Google Ads (Microsoft Ads segue sem credencial,
    // #5502, fora do escopo do #5704).
    //
    // Fail-soft por design (#5237): sem credencial ou com a API
    // indisponivel, o script sai limpo com exit 0 sem tocar spend.csv --
    // esta task nunca falha "de verdade" por falta de campanha rodando.
    //
    // DECLARADA, NAO ARMADA nesta unidade (worktree isolado, mesma
    // disciplina do #5220/#5217/#5311/#5494/#5607 acima) -- maquina Windows
    // nao roda mais tasks Diaria (#5074); arme real e acao POSTERIOR do
    // editor via `scripts/setup-systemd-timers.ts` na checkout
    // compartilhada (helios).
    schedule: { kind: "daily", hour: 9, minute: 50 },
    issue: "#5704",
  },
  {
    // #5878 — Campaign Management API v13 (SOAP) capta motivos editoriais de
    // assets rejeitados. Diferente da Reporting API (Google Ads Spend Ingest
    // acima, #5704), esta é uma chamada SINCRONA (GetAssetGroupsEditorialReasons
    // não segue submit→poll→download) — devolve o resultado em 1 round-trip.
    // Output: data/microsoft-ads/editorial-reasons-{YYYY-MM-DD}.json.
    //
    // Horário 10:00 BRT — 10min depois do Google Ads Spend Ingest (09:50),
    // dentro do cluster matinal, sem colisão. Fail-soft por design: sem as
    // 6 env vars MICROSOFT_ADS_* → exit 0, nada escrito (mesmo padrão do
    // #5704). DECLARADA — arme via setup-systemd-timers.ts e posterior do
    // editor (helios).
    name: "Diaria-Microsoft-Ads-Editorial-Reasons",
    description: "captura motivos editoriais de assets rejeitados (Campaign Management API v13 SOAP)",
    steps: [{ key: "check", script: "scripts/microsoft-ads-editorial-reasons.ts" }],
    logPath: "microsoft-ads/.editorial-reasons.log",
    schedule: { kind: "daily", hour: 10, minute: 0 },
    issue: "#5878",
  },
  {
    name: "Diaria-Hub-Pages-Build",
    description: "build semanal de todos os hubs tematicos (--all --check-facts)",
    // `--check-facts` (#5060/#5102) roda o gate de fact-check antes de
    // escrever cada `.generated.ts` — `--all` sozinho NÃO aciona esse gate
    // (é opt-in por flag, ver `scripts/build-hub-page.ts`), então esta task
    // passa a flag explicitamente pra nunca contornar a verificação de
    // conteúdo. Sem `--skip-fact-check`: um hub sem relatório fresco de
    // fact-check ABORTA a run inteira (`process.exit(2)`, mesmo comportamento
    // já existente do script pra qualquer invocação `--check-facts`) — decisão
    // deliberada (item 2 do #5754): falhar alto e visível é melhor que
    // publicar conteúdo não verificado numa run desassistida semanal.
    //
    // O script só ESCREVE `{slug}.generated.ts` local — NUNCA commita nem
    // deploya o Worker `arquivo` sozinho (decisão explícita do #5754, opção
    // (a) da issue: "gerar e reportar diff, deploy automático de Worker é
    // blast radius que não foi pedido aqui"). Regenerar sem commitar+deployar
    // não muda nada em produção; cabe ao editor (ou a uma rodada
    // overnight/develop que veja o diff) revisar e deployar manualmente.
    steps: [{ key: "build", script: "scripts/build-hub-page.ts", args: ["--all", "--check-facts"] }],
    // **`enabled: false` DE PROPÓSITO (#6267, decisão do editor 26/08/2026)
    // — não é "ainda não armada".** Mesmo estado deliberado de
    // `Diaria-Sunset-Weekly` acima. Como declarada, esta task NÃO PODE ter
    // sucesso: `--check-facts` sem `--skip-fact-check` exige
    // `data/hub-fact-check/{slug}-report.json`, e esse arquivo NUNCA existiu
    // pra nenhum hub — `.claude/agents/fact-checker.md` §"Modo hub" registra
    // que o dispatch do agente nunca foi ligado ("sem alguém rodar você
    // manualmente sobre o manifesto, `{slug}-report.json` nunca existe").
    // Armada hoje, ela abortaria (`exit 2`) no 1º hub, todo domingo, sem
    // gerar um único `.generated.ts`.
    //
    // Um 2º bloqueador, independente, mata também a variante "só regenerar
    // as fontes": `UPDATED_DATE` é hand-written em cada
    // `scripts/lib/hubs/{slug}.ts` e `validateHubContent` exige
    // `updatedDate >= sourceEditions[0].date` (guard do #5124, correto).
    // Fonte regenerada sempre avança à frente dele — medido em 26/08: com as
    // fontes regeneradas, 5 testes de render quebram —, então um passo
    // desassistido deixaria a checkout compartilhada suja toda semana.
    //
    // Decisão registrada no #6267: o regen fica MANUAL (barato e seguro
    // desde o #6270 — `--all` + `manual: true`), rastreado por issue quando
    // a defasagem acumula (#6274). Religar exige antes resolver os dois
    // bloqueadores; `UPDATED_DATE` derivado só com um campo hand-written
    // NOVO pra data de revisão da prosa, nunca colapsando os dois sentidos.
    enabled: false,
    logPath: "hubs/.build-all.log",
    // Domingo 08:05 BRT (a sugestão original da issue era 08:00 em ponto —
    // 5min de folga porque `minute:0` bateria em toda batida de interval que
    // divide 8, ex: Diaria-Brevo-Diaria-Guardrail/Diaria-Cursos-Error-Alarm
    // (4h/2h) — mesmo raciocínio de #5249, que moveu pra :30 pelo mesmo
    // motivo) — antes da janela 09:30-10:20 dos checks de drift/staleness
    // matinais (Diaria-Hub-Staleness-Check 09:30 diário, Diaria-Hub-Drift-Check
    // 10:00 diário, Diaria-Robots-Txt-Drift-Check 10:15 diário,
    // Diaria-Plugin-Review-Drift-Check 10:20 diário), pra que eles já vejam
    // o resultado do build da semana. Sem colisão com nenhuma outra weekly
    // de domingo já registrada (03:00 Beehiiv-Backup, 07:00
    // Geo-Citation-Monitor, 10:30 Geo-Citation-Staleness-Alarm, 11:00
    // On-Hold-Vencimento-Alarm, 22:00 LinkedIn-Weekly-Staleness-Alarm).
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 8, minute: 5 },
    // DECLARADA, NÃO ARMADA nesta unidade (worktree isolado, mesma
    // disciplina do #5220/#5217/#5311/#5494/#5607/#5704 acima) — arme real
    // via `scripts/setup-systemd-timers.ts` na checkout compartilhada
    // (`helios`) é ação POSTERIOR do editor.
    issue: "#5754",
  },
  {
    name: "Diaria-Ads-Test-Watch",
    description:
      "cobra os marcos do ciclo de vida do teste de 3 canais pagos (D0, reconciliacao diaria, condicoes de " +
      "morte, religamento D+21, apuracao congelada) sem depender da memoria do editor",
    steps: [{ key: "watch", script: "scripts/ads-test-watch.ts" }],
    logPath: "aquisicao/.ads-test-watch.log",
    // 06:30 BRT diário — depois do snapshot semanal Diaria-Beehiiv-Backup
    // (domingo 03:00, acima) ter folga pra terminar antes desta rodar sobre
    // um snapshot novo no dia da apuração, e antes de qualquer horário de
    // trabalho normal do editor (reconciliação diária do §8.3 acontece
    // durante o dia — este check olha pra ONTEM, então roda de manhã).
    schedule: { kind: "daily", hour: 6, minute: 30 },
    guard: {
      requiredFile: "aquisicao/spend.csv",
      abortMessage:
        "spend.csv nao encontrado (data/aquisicao/spend.csv) -- provavel junction data/ nao montada ainda; " +
        "abortando por seguranca, sem checar run-state/clicks-2608.csv.",
    },
    // DECLARADA, NÃO ARMADA nesta unidade (worktree isolado, mesma
    // disciplina do #5220/#5217/#5311/#5494/#5607/#5704/#5754 acima) —
    // armar via `scripts/setup-systemd-timers.ts` na checkout compartilhada
    // (`helios`) é ação POSTERIOR do editor.
    issue: "#5845",
  },
  {
    name: "Diaria-Onboarding-Welcome-Run",
    description:
      "sequencia diaria de boas-vindas via Brevo transacional (e-mail 1 imediato, e-mail 2 D+3, " +
      "e-mail 3 CAMPANHA D+10 condicional a zero aberturas e cliques) para assinantes novos da Beehiiv",
    steps: [{ key: "run", script: "scripts/onboarding-welcome-run.ts", args: ["--send"] }],
    logPath: "onboarding/.welcome-run.log",
    // 09:05 BRT — logo depois de Diaria-Clarice-Novos (09:00, mesmo cluster
    // matinal de detecção/onboarding de gente nova), antes do resto do
    // cluster 09:15-09:50 já ocupado (ver grep de `kind: "daily"` neste
    // arquivo). Corpo dos 3 e-mails exportado da automação Beehiiv
    // 'Onboarding — Boas-vindas' pra data/snippets/onboarding-{1,2,3}.md
    // (guard duro ONBOARDING-CORPO-PENDENTE removido, #5908) e cursor de
    // bootstrap já marcado (`--send` rodado uma vez em 2026-08-23,
    // detected_new: 0 — base existente fica de fora por desenho).
    schedule: { kind: "daily", hour: 9, minute: 5 },
    // Achado do review de fleet do PR #5956: sem este guard, uma junction
    // `data/` que caiu momentaneamente em `helios` faria `readStore` devolver
    // `emptyStore()` silenciosamente (indistinguível de "1ª execução") — e a
    // semântica de bootstrap (`last_detection_cursor: null` → marca cursor em
    // `now`, zero envios) resetaria o tracking de quem já está no meio da
    // sequência (ex: recebeu e-mail 1, aguardando e-mail 2 em D+3) sem
    // nenhum aviso no log. Mesmo perfil de risco (envio externo real + store
    // sequencial por contato) das tasks-irmãs que já usam este guard
    // (Diaria-Clarice-Novos/-Tarde, Diaria-Clarice-Envio,
    // Diaria-Brevo-Diaria-Evaluate, Diaria-Ads-Test-Watch).
    guard: {
      requiredFile: "onboarding/store.json",
      abortMessage:
        "store.json nao encontrado (data/onboarding/store.json) -- provavel junction data/ nao " +
        "montada ainda; abortando por seguranca, sem resetar o cursor de bootstrap.",
    },
    // DECLARADA, NÃO ARMADA nesta unidade (sessão develop rodando no
    // Windows do editor, não na checkout compartilhada `helios`) — armar
    // via `scripts/setup-systemd-timers.ts` em `helios` é ação POSTERIOR
    // do editor, mesma disciplina do #5845/#5754/#5704 acima.
    issue: "#5908",
  },
  {
    name: "Diaria-Session-Registry-Gc",
    description:
      "GC de registros ENCERRADOS de data/sessions/ (arquivo real + backups de conflito do OneDrive) — " +
      "nunca por staleness de heartbeat sozinha, ver decideSessionGc",
    steps: [{ key: "gc", script: "scripts/session-registry-gc.ts" }],
    logPath: "sessions/.gc.log",
    // 09:55 BRT — fim do cluster matinal de checks/alarmes 09:00-10:20 (ver
    // grep de `kind: "daily"` neste arquivo), depois do
    // Diaria-Onboarding-Welcome-Run (09:05) e antes do cluster 10:00-10:20.
    // Sem urgência de horário (limpeza de estado morto, não algo que o
    // editor precise ver de manhã) — só evita colidir com o resto.
    schedule: { kind: "daily", hour: 9, minute: 55 },
    // Sem guard: `garbageCollectSessions`/`planSessionGc` já são fail-soft
    // (data/sessions/ ausente → plano vazio, ver scripts/lib/session-registry.ts)
    // e o wrapper confirma existsSync(DATA_DIR) antes de tentar qualquer coisa.
    // DECLARADA, NÃO ARMADA nesta unidade (worktree isolado, mesma
    // disciplina do #5845/#5908/#5754 acima) — armar via
    // `scripts/setup-systemd-timers.ts` na checkout compartilhada (`helios`)
    // é ação POSTERIOR do editor.
    issue: "#6130",
  },
  {
    name: "Diaria-Backlog-Reconcile",
    description:
      "reconciliação diária do backlog aberto — corrige mecanicamente marcador aguardando-ate: em conflito com " +
      "label de deferimento (padrões 1/2), e alarma (sem corrigir) label de bloqueio herdada de mãe pra filha " +
      "e checkbox aberto em issue fora-de-rodada (padrões 3/4)",
    steps: [{ key: "reconcile", script: "scripts/backlog-reconcile.ts" }],
    logPath: "backlog-reconcile/.reconcile.log",
    // 10:10 BRT — fim do cluster matinal de checks/alarmes 09:00-10:20 (ver
    // grep de `kind: "daily"` neste arquivo) sem colidir com nenhuma outra
    // entrada já registrada. O slot 10:05, que precedia este até o corte
    // de Diaria-Session-Registry-SafeBackup-Alarm (#6798 item 5), está livre.
    schedule: { kind: "daily", hour: 10, minute: 10 },
    // Sem guard — `fetchOpenBacklog` já é fail-soft (falha do `gh` devolve
    // `null`, o CLI aborta com exit 1 sem escrever nada; nunca trata "gh
    // falhou" como "backlog limpo").
    // DECLARADA, NÃO ARMADA nesta unidade — armar via
    // `scripts/setup-systemd-timers.ts` na checkout compartilhada (`helios`)
    // é ação POSTERIOR do editor.
    issue: "#6198",
  },
  {
    name: "Diaria-Dmarc-Drain",
    description: "drena e agrega os relatorios DMARC de news.diar.ia.br, alarma se aparecer volume nao-autenticado",
    steps: [{ key: "drain", script: "scripts/dmarc-drain.ts" }],
    logPath: "dmarc-reports/.drain.log",
    // 10:25 BRT — logo depois de Diaria-Hub-Staleness-Check (10:20), fechando
    // o cluster matinal de checks/alarmes. Nasceu pedindo 10:10, mesmo slot
    // que Diaria-Backlog-Reconcile (#6198) pediu no mesmo dia — as duas
    // unidades foram desenvolvidas em worktrees isolados e escolheram o
    // mesmo buraco livre. Resolvido no merge da rodada overnight 260826.
    schedule: { kind: "daily", hour: 10, minute: 25 },
    // Sem guard: fetchReports() é fail-soft por design (busca vazia = 0
    // relatórios, nunca erro) — a única falha dura é a BUSCA em si (Gmail
    // API indisponível/auth), que o próprio script já reporta com exit != 0.
    // DECLARADA, NÃO ARMADA nesta unidade (worktree isolado, mesma
    // disciplina do #5845/#5908/#5754/#6130 acima) — armar via
    // `scripts/setup-systemd-timers.ts` na checkout compartilhada (`helios`)
    // é ação POSTERIOR do editor.
    issue: "#6189",
  },
  {
    name: "Diaria-Claude-Session-Version-Drift-Alarm",
    description:
      "alarme sem politica: sessao Claude Code de vida longa (--remote-control) com binario em memoria defasado do disco (#6875/#6891)",
    steps: [{ key: "check", script: "scripts/claude-session-version-drift-alarm.ts" }],
    logPath: "claude-session-version-drift-alarm/.alarm.log",
    // A cada 6h — a condição em si só passa a existir depois de threshold
    // (24h) de vida da sessão, então checar com essa cadência dá folga de
    // sobra sem deixar o achado dias sem e-mail. Linux apenas (depende de
    // /proc/<pid>/exe) — o script sai 0 sem checar nada em qualquer outra
    // plataforma.
    schedule: { kind: "interval", hours: 6 },
    issue: "#6927",
  },
  {
    name: "Diaria-Npm-Version-Drift-Alarm",
    description:
      "contrapeso ao updater desligado: defasagem entre a versao do Claude Code em disco e a publicada no npm, ha quantos dias (#6960)",
    steps: [{ key: "check", script: "scripts/npm-version-drift-alarm.ts" }],
    logPath: "npm-version-drift-alarm/.alarm.log",
    // Diario — cadencia de release do Claude Code e quase diaria (medicao
    // citada na #6960: 2.1.251 -> 2.1.257 em 1 dia), entao 1 checagem/dia
    // ja da granularidade suficiente pro limiar (default 7d) sem custo de
    // rodar mais vezes. Diferente do Diaria-Claude-Session-Version-Drift-Alarm
    // (#6927, acima): aquele mede reinstalacao RECENTE (processo != disco)
    // e fica mudo com o updater desligado; este mede DEFASAGEM acumulada
    // (disco != upstream), o sinal que continua existindo mesmo sem
    // reinstalacao nenhuma acontecer.
    schedule: { kind: "daily", hour: 10, minute: 40 },
    // DECLARADA, NAO ARMADA nesta unidade (worktree isolado, mesma
    // disciplina do #5845/#5908/#5754/#6130/#6189 acima) — armar via
    // `scripts/setup-systemd-timers.ts` na checkout compartilhada
    // (`helios`) e acao POSTERIOR do editor.
    issue: "#6960",
  },
  {
    name: "Diaria-Openrouter-Billing-Leak-Alarm",
    description: "alarme diario de modelo pago nao pedido faturado no gateway OpenRouter (#6716 escopo 3)",
    steps: [{ key: "check", script: "scripts/openrouter-billing-leak-check.ts" }],
    logPath: "openrouter-billing-leak/.alarm.log",
    // 21:45 BRT = 00:45 UTC -- depois da meia-noite UTC, que é quando o
    // `/api/v1/activity` fecha o dia UTC anterior (o script é
    // estruturalmente D-1, ver docblock de scripts/lib/openrouter-billing-leak.ts).
    // A doc da OpenRouter recomenda esperar ~30min pós-virada antes de
    // confiar no dia anterior (#6985 item 3); 45min de folga sobre esse
    // mínimo, sem colidir com Diaria-Clarice-Cohorts-Crawl (21:00, único
    // outro daily na faixa 21h-22h do registro).
    schedule: { kind: "daily", hour: 21, minute: 45 },
    // successExitCodes: [3] -- exit 3 ("achou vazamento") já envia o
    // e-mail de alarme por dentro do próprio script (ver
    // buildBillingLeakAlarmEmail); a task TERMINOU O TRABALHO que existe
    // pra fazer, não falhou em fazê-lo, então não deve marcar a unit
    // systemd como `failed` nem contar como falha no
    // Diaria-Systemd-Unit-Rate-Alarm. **Exit 1 (indeterminado/erro) fica
    // DE FORA de propósito** (#6985: "exit 1 significa 'não mediu' e não
    // pode ser silenciado como erro cosmético") -- só ele deve continuar
    // reprovando a unit e contando pra taxa de falha, senão o guard vira
    // inerte de novo pela porta do runner em vez da porta do cron ausente.
    // 3 = LEAK_FOUND_EXIT_CODE (scripts/openrouter-billing-leak-check.ts) --
    // literal, não importado: scripts/lib/ não importa de scripts/ soltos
    // (test/lib-boundary.test.ts não cobre essa direção específica, mas o
    // padrão do resto do registro -- ex: o `[75]` de
    // Diaria-Clarice-Guardrail-Alarm acima -- já é valor literal com
    // comentário apontando a constante de origem, não import cruzado).
    successExitCodes: [3],
    issue: "#6985, #6716 escopo 3, #6983",
  },
  {
    name: "Diaria-Branch-Cleanup",
    description: "GC diario de branches locais + worktrees encerrados (--push)",
    steps: [{ key: "cleanup", script: "scripts/branch-cleanup.ts", args: ["--push"] }],
    logPath: "branch-cleanup/.cleanup.log",
    // Task NOVA e isolada, deliberadamente NÃO pendurada na
    // Diaria-Session-Registry-Gc (decisão do editor, #6802: falha de um GC
    // não pode contaminar o outro). `--push` é necessário aqui -- sem ele
    // o script só imprime relatório e nunca apaga nada (dry-run é o
    // default do script, preservado); worktree/branch em uso já fica em
    // needs-review por conta própria (locked/dirty check + re-checagem
    // imediatamente antes de apagar, ver docstring de branch-cleanup.ts).
    // CORREÇÃO (#7044, P0): a frase anterior aqui ("--push não precisa de
    // nenhuma flag adicional de segurança") estava ERRADA -- o script
    // rodava sem NUNCA consultar session-registry.ts, apesar do irmão
    // cleanup-merged-worktrees.ts já cobrir isso desde o #5156 item 9, e o
    // guard `locked` sozinho não bastava (nenhum call site deste repo
    // chama `git worktree lock`). branch-cleanup.ts agora chama
    // shouldSkipForSharedSession/activeSessionWorktreePaths
    // (scripts/lib/shared-session-guard.ts) ANTES de qualquer remoção --
    // `--push` sozinho já pula a varredura quando há sessão coordenadora
    // ativa (salvo `--confirm-shared`), sem precisar de flag adicional
    // AQUI no registro (o script já vem seguro por padrão).
    // 10:45 BRT: cauda do cluster matinal de checks/alarmes (09:00-10:40),
    // logo após Diaria-Npm-Version-Drift-Alarm (10:40) e antes do próximo
    // ocupado (Diaria-Postmaster-Spam-Sync, 12:30) -- fora das janelas
    // quentes (envio Diaria-Clarice-Envio 19:00, janela do
    // Diaria-Overnight-Watchdog 18:00-09:00, e a extinta edição de
    // madrugada), sem colidir com nenhuma daily/weekly existente.
    schedule: { kind: "daily", hour: 10, minute: 45 },
    issue: "#6802",
  },
  {
    name: "Diaria-Route-Marker-Staleness-Alarm",
    description:
      "alarme semanal de marcador de roteamento desatualizado -- bloqueada sem marcador bloqueio-execucao, " +
      "depends_on ja fechada, condicao externa sem atualizacao ha 30+ dias, agendada cuja razao cita issue " +
      "ja fechada, agendada renovada 3+ vezes (#7270 Parte 2, #7288 Parte B)",
    steps: [{ key: "alarm", script: "scripts/route-marker-staleness-alarm.ts" }],
    logPath: "route-marker-staleness/.alarm.log",
    // Domingo 11:15 BRT -- logo apos Diaria-On-Hold-Vencimento-Alarm (11:00),
    // mesma familia de alarme "revisao semanal de rotulo que ninguem
    // reavalia" (#5317), sem colisao com nenhum outro Sunday ja registrado
    // (3:00, 3:30, 4:00, 4:10, 7:00, 8:05, 9:20, 9:33, 9:43, 10:30, 11:00,
    // 22:00 -- checado via `--list` antes de escolher, #5408).
    schedule: { kind: "weekly", dayOfWeek: "Sunday", hour: 11, minute: 15 },
    // Sem guard -- `listOpenIssuesForStaleness` ja e fail-soft (falha do
    // `gh` devolve `null`, o script aborta com exit 1 sem alarmar; nunca
    // trata "gh falhou" como "nenhum achado").
    // DECLARADA, NAO ARMADA nesta unidade (worktree isolado, mesma
    // disciplina do resto do registro acima) -- armar via
    // `scripts/setup-systemd-timers.ts` na checkout compartilhada
    // (`helios`) e acao POSTERIOR do editor.
    issue: "#7270, #7288",
  },
];

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
 */
export const RETIRED_TASK_NAMES: ReadonlySet<string> = new Set(["Diaria-Clarice-Novos-Abort-Alarm"]);

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
  }));
}

/** Renderiza a tabela `--list` — 1 linha por task, colunas separadas por
 * tab (`\t`), sem header — mantém a garantia "exatamente
 * `SCHEDULED_TASKS.length` linhas" (#5408) simples de verificar em teste. */
export function renderScheduledTasksTable(rows: ScheduledTaskRow[] = listScheduledTaskRows()): string {
  return rows
    .map((r) => [r.name, r.schedule, r.scripts, r.logPath, r.killSwitch, r.issue].join("\t"))
    .join("\n");
}

// CLI guard: só executa como main module, importável sem efeito colateral
// (mesmo padrão de exec-mode.ts/clarice-envio-enabled.ts).
if (isMainModule(import.meta.url)) {
  const { flags } = parseArgs(process.argv.slice(2));
  const rows = listScheduledTaskRows();
  if (flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (flags.has("list")) {
    console.log(renderScheduledTasksTable(rows));
  } else {
    console.log("Uso: npx tsx scripts/lib/scheduled-tasks.ts --list [--json]");
    console.log(`(${rows.length} tasks no registro — nome, schedule, scripts, logPath, killSwitch, issue)`);
  }
}
