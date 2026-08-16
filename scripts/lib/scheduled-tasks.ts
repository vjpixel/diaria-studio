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
 * propósito, mesmo caso de `Diaria-Beehiiv-Home-Meta-Check` #5005: nasceu
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
  /** Issue(s) de origem, só pra rastreabilidade em docs/erros. */
  issue: string;
}

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
    name: "Diaria-Beehiiv-Home-Meta-Check",
    description: "smoke-test dos eixos de drift da home Beehiiv (og:title, self-links http, rotulos EN, host legado, porta na URL)",
    steps: [{ key: "check", script: "scripts/beehiiv-home-meta-check.ts" }],
    logPath: "beehiiv-home-meta-check/.meta-check.log",
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
    // Mesmo padrao de Diaria-Beehiiv-Home-Meta-Check (#5005): task
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
    issue: "#4064, #4131 finding 1",
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
    name: "Diaria-Cursos-Error-Alarm",
    description: "alarme de erro do worker cursos",
    steps: [{ key: "alarm", script: "scripts/cursos-error-alarm.ts" }],
    logPath: "cursos-subscribers/.error-alarm.log",
    schedule: { kind: "interval", hours: 2 },
    issue: "#4320, #4382",
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
    issue: "#4534, #4552",
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
    // Mesmo caso de `Diaria-Beehiiv-Home-Meta-Check`/`Diaria-Clarice-Envio-Alarm`
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
    // Mesmo raciocínio de Diaria-Beehiiv-Home-Meta-Check acima: o conserto
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
    name: "Diaria-Hub-Staleness-Check",
    description: "detecta edições publicadas que casam HUB_KEYWORD_PATTERNS mas não estão no dataset commitado do hub (persiste snapshot diário + alarma se >= 3 dias)",
    steps: [{ key: "check", script: "scripts/hub-staleness-check.ts" }],
    logPath: "hubs/.staleness-check.log",
    // Diária basta (#5123) — o custo é só ler dataset local (sem rede pra
    // detectar; só o e-mail de alarme, se houver pendência, faz I/O de
    // rede). Horário: 09:30, entre Diaria-Clarice-Opens-Catchup-Alarm (09:00)
    // e Diaria-Apoios-Diff-Alarm (09:45) — sem colisão com nenhuma outra
    // daily do registro.
    schedule: { kind: "daily", hour: 9, minute: 30 },
    // Mesmo caso de Diaria-Beehiiv-Home-Meta-Check/Diaria-Clarice-Envio-Alarm
    // (#5005/#5058): 1ª execução registrada depois do cutover systemd (épica #4798).
    issue: "#5123, #4924",
  },
  {
    name: "Diaria-Entity-Pages-Regen",
    description:
      "regenera o HTML das páginas de entidade (workers/artigos/public/entidades/) a partir do EntityContent commitado, e alarma quando uma edição nova casa o padrão de uma entidade publicada mas ainda não está no mentions dela (persiste snapshot diário + alarma se >= 3 dias, mesmo mecanismo de aging de Diaria-Hub-Staleness-Check)",
    steps: [{ key: "regen", script: "scripts/regenerate-entity-pages.ts" }],
    logPath: "entities/.regen.log",
    // Diária basta — mesmo racional de Diaria-Hub-Staleness-Check (custo é
    // só ler corpus local + regen determinística; só o e-mail de alarme, se
    // houver pendência vencida, faz I/O de rede). Horário: 09:40, entre
    // Diaria-Beehiiv-Home-Meta-Check (09:35) e Diaria-Apoios-Diff-Alarm
    // (09:45) — sem colisão com nenhuma outra daily do registro.
    schedule: { kind: "daily", hour: 9, minute: 40 },
    // #5125: condição inegociável do editor pra publicar a 1ª página de
    // entidade fora da rodada original de 3 (Apple) — "a página nasce com
    // regeneração automática, senão não é publicada". Não armada nesta
    // unidade (worktree isolado) — ver CLAUDE.md.
    issue: "#5125",
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
    issue: "#4347, #4941, #5140, #5445, #5447",
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
    issue: "#4347, #4941, #5185, #5410, #5445, #5447",
  },
  {
    name: "Diaria-Clarice-Novos-Abort-Alarm",
    description: "alarme de aborts consecutivos por semaforo vermelho (D4) do grupo 'novos' da Clarice",
    steps: [{ key: "alarm", script: "scripts/clarice-novos-abort-alarm.ts" }],
    logPath: "clarice-subscribers/.novos-abort-alarm.log",
    // Diária 18:10 BRT — depois das DUAS rodadas do dia (09:00 e 18:00
    // Diaria-Clarice-Novos-Tarde), lê o status da MAIS RECENTE. Mesmo
    // padrão de "alarme roda depois do que ele observa" de
    // Diaria-Clarice-Opens-Catchup-Alarm (09:00, depois do Diaria-Clarice-
    // Sync das 08:30).
    schedule: { kind: "daily", hour: 18, minute: 10 },
    issue: "#5405, #5447",
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
    // Sem colisão com nenhuma outra task
    // armada (a mais próxima é o ciclo de 4h do Clarice-Guardrail-Alarm).
    schedule: { kind: "daily", hour: 19, minute: 0 },
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
    issue: "#5025, #5026, #5027 (decisões do editor 260811)",
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
    issue: "#5025, #5026, #5027 (decisões do editor 260811)",
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
    // 20:30 BRT (#5058): 1h30 depois do Diaria-Clarice-Envio das 19:00 --
    // folga suficiente pro retry-com-backoff embutido em clarice-envio-run.ts
    // (ate 3 tentativas, cap de 35min cada, ~1h10 no pior caso) esgotar
    // ANTES desta checagem rodar, senao ela alarmaria em cima de um retry
    // ainda em curso que teria sucesso minutos depois.
    schedule: { kind: "daily", hour: 20, minute: 30 },
    // Mesmo guard das outras 2 tasks Clarice-Envio acima -- sem o store, a
    // rodada das 19:00 nunca teria rodado de verdade nesta maquina, entao um
    // alarme "nenhum relatorio encontrado" seria ruido, nao sinal real.
    guard: {
      requiredFile: "clarice-subscribers/clarice-users.db",
      abortMessage:
        "clarice-users.db nao encontrado (data/clarice-subscribers/clarice-users.db) -- provavel junction " +
        "data/ nao montada ainda; sem sentido checar relatorio de uma rodada que nunca roda nesta maquina.",
    },
    // Mesmo padrao de Diaria-Beehiiv-Home-Meta-Check (#5005, 1a task
    // registrada depois do cutover systemd/epica #4798). Via de execucao
    // real: par `.service`/`.timer` gerado por scripts/setup-systemd-timers.ts.
    issue: "#5058",
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
      { key: "index", script: "scripts/seo-index-check.ts", args: ["--only-posts", "--limit", "2000"] },
      // #4909: /temas/{slug} (host arquivo.diar.ia.br) nunca entrou nesta
      // checagem — a propriedade GSC verificada é sc-domain:diar.ia.br
      // (cobre o subdomínio, sem --site próprio necessário), e o sitemap
      // deste host tem hoje 7 URLs (a raiz + 6 hubs — corrigido no #5118/#5120,
      // dizia "~5 URLs, a raiz + 4 hubs" desatualizado; ver também #5120 item 3
      // sobre a leitura "1/5 hubs, com 4 nunca rastreados" da medição de
      // 12/ago, feita ANTES do 6º hub mercado-trabalho entrar), então SEM
      // --only-posts (o filtro é /\/p\//, que zeraria tudo aqui — ver
      // filterPosts em seo-index-check.ts) e com --limit pequeno.
      // --out-suffix evita que esta rodada colida no mesmo
      // index-status-{data}.json/.md do passo "index" acima (achado do
      // #4909 — o .md era path fixo, não sobrescrevível por --out).
      {
        key: "index-arquivo",
        script: "scripts/seo-index-check.ts",
        args: ["--sitemap", "https://arquivo.diar.ia.br/sitemap.xml", "--limit", "10", "--out-suffix", "arquivo"],
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
    // Mesmo caso de `Diaria-Beehiiv-Home-Meta-Check` (#5005): task registrada
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
    // Mesmo caso de `Diaria-Beehiiv-Home-Meta-Check` (#5005): task
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
    // Mesmo caso de `Diaria-Beehiiv-Home-Meta-Check` (#5005): task registrada
    // depois do cutover systemd (épica #4798), sem contraparte Windows/.ps1 —
    // e nenhuma tarefa `Diaria-*` deve rodar no Windows (#5074).
    issue: "#5317",
  },
];

/** Busca uma task pelo nome exato (`ScheduledTaskDefinition.name`). */
export function getScheduledTaskByName(name: string): ScheduledTaskDefinition | undefined {
  return SCHEDULED_TASKS.find((t) => t.name === name);
}

/** Lista os nomes de todas as tasks do registro, na ordem declarada. */
export function listScheduledTaskNames(): string[] {
  return SCHEDULED_TASKS.map((t) => t.name);
}

// ---------------------------------------------------------------------------
// Enumeração programática (#5408) — mesmo idioma CLI de exec-mode.ts /
// studio-chat-enabled.ts: função pura testável + guard `isMainModule` fino.
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
// (mesmo padrão de exec-mode.ts/studio-chat-enabled.ts).
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
