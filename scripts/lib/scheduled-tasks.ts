/**
 * scripts/lib/scheduled-tasks.ts (#4805 Fase 1, épica #4798)
 *
 * Registro DECLARATIVO das tasks agendadas locais do repo — fonte única de
 * verdade que `scripts/lib/task-runner.ts` (Fase 2) executa e
 * `scripts/setup-systemd-timers.ts` (Fase 3) usa pra gerar units systemd.
 *
 * **Por que este arquivo existe:** até aqui, a lista de tasks vivia
 * implicitamente espalhada em 14 pares `scripts/run-*.ps1` +
 * `scripts/setup-*-schedule.ps1`, cada um repetindo o mesmo molde (script(s)
 * `npx tsx`, log path, cadência, guard opcional) em PowerShell — só
 * descoberto de fora por `scripts/lib/pending-scheduled-tasks.ts` (#4708) via
 * regex sobre o `.ps1` de setup. Este registro inverte isso: os dados vivem
 * aqui, tipados, uma vez; `pending-scheduled-tasks.ts` agora lê daqui como
 * fonte PRIMÁRIA (com fallback pro scanner legado pra tasks ainda não
 * migradas, ex: `Diaria-Overnight-Watchdog`/`Diaria-Edicao-Diaria`, cujos
 * runners não seguem o padrão `npx tsx <script>.ts` que este registro
 * modela — ver docstring de `listExpectedScheduledTasks`).
 *
 * **Escopo — 14 tasks (13 na abertura da #4805, +1 com o `#4755` mergeado
 * antes desta unidade):** todas as tasks cujo wrapper `.ps1` roda um ou mais
 * scripts `.ts` via `npx tsx` e loga em `data/`. Fora do escopo (não
 * migradas, não modeladas aqui): `Diaria-Overnight-Watchdog` (invoca
 * `overnight-watchdog.ts` direto do Task Scheduler, sem `run-*.ps1`
 * intermediário) e `Diaria-Edicao-Diaria` (invoca `claude -p` via
 * `run-scheduled-edicao.ps1` — um processo completamente diferente de
 * `npx tsx`; além disso desregistrada por decisão do editor desde 260711,
 * #3259).
 *
 * **Este arquivo NÃO executa nada** — é dado puro. Execução é
 * `scripts/lib/task-runner.ts` (`runScheduledTask`); geração de units
 * systemd é `scripts/lib/systemd-units.ts` + `scripts/setup-systemd-timers.ts`.
 *
 * **NÃO remover os `.ps1` existentes** (`scripts/run-*.ps1`,
 * `scripts/setup-*-schedule.ps1`) ao consumir este registro em outro lugar —
 * eles seguem sendo a via de execução real no Windows até uma decisão
 * explícita de cutover (fora do escopo da #4805, que só entrega o registro +
 * o runner TS + a geração de units, sem armar nada — ver #4807).
 *
 * @see scripts/lib/task-runner.ts (Fase 2 — executor)
 * @see scripts/run-task.ts (Fase 2 — entrypoint CLI)
 * @see scripts/lib/systemd-units.ts + scripts/setup-systemd-timers.ts (Fase 3)
 * @see scripts/lib/pending-scheduled-tasks.ts (#4708 — consumidor, refatorado
 *      nesta mesma unidade pra ler daqui como fonte primária)
 */

/** Dias da semana aceitos por um schedule `weekly` — mesmo vocabulário do
 * `-DaysOfWeek` do PowerShell (`New-ScheduledTaskTrigger -Weekly`). */
export type WeekDay = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";

/**
 * Cadência declarativa de uma task. Espelha os 3 padrões realmente usados
 * pelos `setup-*-schedule.ps1` do repo:
 *   - `daily`   → `New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour H -Minute M)`
 *   - `weekly`  → `New-ScheduledTaskTrigger -Weekly -DaysOfWeek D -At (Get-Date -Hour H -Minute M)`
 *   - `interval`→ `New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours N)`
 *     (começa agora, repete indefinidamente a cada N horas — ver #4155 pro
 *     porquê de `-Once -At` em vez de `-Once <data>` posicional, e pro porquê
 *     de nunca passar `-RepetitionDuration`).
 */
export type ScheduledTaskSchedule =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; dayOfWeek: WeekDay; hour: number; minute: number }
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
   * seguintes — mesmo comportamento dos `run-*.ps1` multi-passo originais:
   * `run-clarice-sync-daily.ps1` sempre roda os 3 passos, mesmo se o passo 1
   * falhar). */
  steps: ScheduledTaskStep[];
  /** Path do log final, relativo a `data/` (POSIX) — ex:
   * `"apoia-se/.diff-alarm.log"` → `data/apoia-se/.diff-alarm.log`. */
  logPath: string;
  schedule: ScheduledTaskSchedule;
  guard?: ScheduledTaskGuard;
  /** Path (relativo à raiz do repo, POSIX) do `setup-*-schedule.ps1` legado
   * que esta entrada espelha — usado só por
   * `scripts/lib/pending-scheduled-tasks.ts` pra checar existência/parity,
   * NUNCA lido em runtime pelo executor. **Opcional desde #5005**: o cutover
   * pra systemd (épica #4798) fechou antes desta task ser registrada —
   * `Diaria-Beehiiv-Home-Meta-Check` é a 1ª entrada sem `.ps1` legado de
   * propósito (não criar um novo `.ps1` só pra preencher este campo); a via
   * de execução real em Linux é exclusivamente o par `.service`/`.timer`
   * gerado por `scripts/setup-systemd-timers.ts` a partir do registro. Uma
   * entrada sem este campo fica de fora de `listExpectedScheduledTasks`
   * (`pending-scheduled-tasks.ts`) — o check de "task esperada ausente do
   * Task Scheduler" não se aplica a task sem contraparte Windows. */
  legacySetupScript?: string;
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
    legacySetupScript: "scripts/setup-apoios-diff-alarm-schedule.ps1",
    issue: "#4485 item 2",
  },
  {
    name: "Diaria-Beehiiv-Home-Meta-Check",
    description: "smoke-test dos 3 eixos de drift da home Beehiiv (og:title, self-links http, rotulos EN)",
    steps: [{ key: "check", script: "scripts/beehiiv-home-meta-check.ts" }],
    logPath: "beehiiv-home-meta-check/.meta-check.log",
    // Mesma cadência dos outros drift-checks de superfície pública
    // (Diaria-Hub-Drift-Check #4750, Diaria-Robots-Txt-Drift-Check #4910) —
    // mesma classe de smoke-test (config publicada divergindo do que o
    // código/o painel pretende), 6h é folga suficiente sem atrasar demais a
    // detecção de uma regressão que ninguém nota olhando a home todo dia.
    schedule: { kind: "interval", hours: 6 },
    // Sem `legacySetupScript` de propósito — ver docstring do campo acima
    // (#5005: 1ª task registrada depois do cutover systemd da épica #4798,
    // sem contraparte Windows/.ps1).
    issue: "#4557, #5005",
  },
  {
    name: "Diaria-Brevo-Diaria-Guardrail",
    description: "circuit breaker de campanha do canal brevo_diaria",
    steps: [{ key: "check", script: "scripts/check-brevo-diaria-guardrail.ts" }],
    logPath: "brevo-diaria/.guardrail-check.log",
    schedule: { kind: "interval", hours: 4 },
    legacySetupScript: "scripts/setup-check-brevo-diaria-guardrail-schedule.ps1",
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
    // Sem `legacySetupScript` de proposito -- mesmo padrao de
    // Diaria-Beehiiv-Home-Meta-Check (#5005): task registrada depois do
    // cutover systemd (epica #4798), sem contraparte Windows/.ps1 (o antigo
    // `DiariaCohortsCrawl` do Windows nunca foi migrado pra este registro --
    // era via `docs/cohorts-schedule.md` diretamente, apontando pro v1, e
    // segue existindo so como doc historico, nao como entrada aqui).
    issue: "#4451",
  },
  {
    name: "Diaria-Clarice-Guardrail-Alarm",
    description: "alarme de guardrail furado do ramp Clarice",
    steps: [{ key: "alarm", script: "scripts/clarice-guardrail-alarm.ts" }],
    logPath: "clarice-subscribers/.guardrail-alarm.log",
    schedule: { kind: "interval", hours: 4 },
    legacySetupScript: "scripts/setup-clarice-guardrail-alarm-schedule.ps1",
    issue: "#4064, #4131 finding 1",
  },
  {
    name: "Diaria-Clarice-Opens-Catchup-Alarm",
    description: "alarme de falha sustentada do catch-up de opens da Clarice",
    steps: [{ key: "alarm", script: "scripts/clarice-opens-catchup-alarm.ts" }],
    logPath: "clarice-subscribers/.opens-catchup-alarm.log",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    legacySetupScript: "scripts/setup-clarice-opens-catchup-alarm-schedule.ps1",
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
    legacySetupScript: "scripts/setup-clarice-sync-schedule.ps1",
    issue: "#2932, #2928, #4047, #4740",
  },
  {
    name: "Diaria-Cursos-Error-Alarm",
    description: "alarme de erro do worker cursos",
    steps: [{ key: "alarm", script: "scripts/cursos-error-alarm.ts" }],
    logPath: "cursos-subscribers/.error-alarm.log",
    schedule: { kind: "interval", hours: 2 },
    legacySetupScript: "scripts/setup-cursos-error-alarm-schedule.ps1",
    issue: "#4320, #4382",
  },
  {
    name: "Diaria-Cursos-Kv-Sync",
    description: "sync diario do KV CURSOS_SUBSCRIBERS",
    steps: [{ key: "sync", script: "scripts/sync-cursos-subscribers-kv.ts" }],
    logPath: "cursos-subscribers/.kv-sync.log",
    schedule: { kind: "daily", hour: 9, minute: 15 },
    legacySetupScript: "scripts/setup-cursos-kv-sync-schedule.ps1",
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
    legacySetupScript: "scripts/setup-evaluate-brevo-diaria-schedule.ps1",
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
    legacySetupScript: "scripts/setup-geo-citation-monitor-schedule.ps1",
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
    legacySetupScript: "scripts/setup-geo-citation-staleness-alarm-schedule.ps1",
    issue: "#4755",
  },
  {
    name: "Diaria-Hub-Drift-Check",
    description: "smoke-test de drift entre HUB_META e o Worker arquivo publicado",
    steps: [{ key: "check", script: "scripts/hub-drift-check.ts" }],
    logPath: "hub-drift-check/.drift-check.log",
    schedule: { kind: "interval", hours: 6 },
    legacySetupScript: "scripts/setup-hub-drift-check-schedule.ps1",
    issue: "#4750",
  },
  {
    name: "Diaria-Robots-Txt-Drift-Check",
    description: "smoke-test do robots.txt SERVIDO pelos Workers de curadoria (bloco gerenciado da Cloudflare + bots fora do esperado)",
    steps: [{ key: "check", script: "scripts/robots-txt-drift-check.ts" }],
    logPath: "robots-txt-drift-check/.drift-check.log",
    // Mesma cadência de Diaria-Hub-Drift-Check (#4750) — mesma classe de
    // smoke-test (config publicada divergindo do que o código pretende),
    // aplicada ao robots.txt em vez dos hubs temáticos.
    schedule: { kind: "interval", hours: 6 },
    legacySetupScript: "scripts/setup-robots-txt-drift-check-schedule.ps1",
    issue: "#4910",
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
    // Sem `legacySetupScript` de propósito — mesmo caso de
    // Diaria-Beehiiv-Home-Meta-Check/Diaria-Clarice-Envio-Alarm (#5005/#5058):
    // 1ª execução registrada depois do cutover systemd (épica #4798), sem
    // contraparte Windows/.ps1.
    issue: "#5123, #4924",
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
    // 11:00 BRT (decisão do editor 260812, #5140 — sucede as 17:00 do #4941).
    // Dois motivos independentes, ambos medidos:
    //
    //   1. JANELA DE DECISÃO. O e-mail tem dois objetivos de conversão
    //      (assinar a Diária, usar o cupom da Clarice) e nenhum dos dois
    //      acontece na leitura: a mediana do clique é 7,6h e o p75 é 37,9h.
    //      Quando acontecem, é em horário comercial — a curva de compra da
    //      Stripe (1.118 assinaturas/180d, independente de envio de e-mail)
    //      põe 41-46% das compras entre 12h e 17h e só 6% de madrugada. Um
    //      envio às 17:00 empurrava quem age rápido pra 18h-21h, o bloco de
    //      menor propensão do dia. Índice de propensão da janela de ação
    //      (100 = hora média): 17h = 120, 11h = 170.
    //   2. FOLGA DO GUARD. `Diaria-Clarice-Envio` (19:00) monta a onda do dia
    //      seguinte a partir de `ramp-warm`, e `novos` é subconjunto ESTRITO
    //      dele (`isNovos` = `isRampWarm` + corte por `created`). Quem já
    //      recebeu do `novos` só sai da onda pelo guard `queued ∪ sent`
    //      (`fetchCommittedCampaignListIds`), que NÃO cobre `in_process` — o
    //      status observado nas rodadas de 09 e 11/08. Com 17:00 a campanha
    //      tinha 2h pra assentar em `sent` antes das 19:00; com 11:00 tem 8h.
    //      Sem essa folga, uma campanha presa em `in_process` faz o mesmo
    //      contato receber duas vezes em 13h.
    //
    // Segue sem colisão com outra task armada (a mais próxima é o ciclo de 4h
    // do Diaria-Clarice-Guardrail-Alarm) e depois do Diaria-Clarice-Sync
    // (08:30), então o store está fresco. Supera a decisão D5 do #4347
    // ("~4×/semana, invocação manual") — a skill manual continua existindo,
    // delegando pro mesmo orquestrador (ver .claude/skills/diaria-clarice-novos).
    schedule: { kind: "daily", hour: 11, minute: 0 },
    guard: {
      requiredFile: "clarice-subscribers/clarice-users.db",
      abortMessage:
        "clarice-users.db nao encontrado (data/clarice-subscribers/clarice-users.db) -- provavel junction " +
        "data/ nao montada ainda; abortando por seguranca, sem tocar Stripe/MV/Brevo.",
    },
    legacySetupScript: "scripts/setup-clarice-novos-schedule.ps1",
    issue: "#4347, #4941",
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
    // amanhã 06:00 BRT (09:00 UTC). Roda depois do Diaria-Clarice-Novos
    // (11:00 desde o #5140, antes 17:00) de propósito — os cadastros novos do
    // dia já entraram no store antes do planejamento da onda, e a campanha do
    // `novos` já teve tempo de assentar em `sent` pro guard `queued ∪ sent`
    // excluí-los desta onda (o mesmo contato está nos DOIS universos:
    // `isNovos` é subconjunto estrito de `isRampWarm`).
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
    legacySetupScript: "scripts/setup-clarice-envio-schedule.ps1",
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
    legacySetupScript: "scripts/setup-clarice-envio-schedule.ps1",
    issue: "#5025, #5026, #5027 (decisões do editor 260811)",
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
    // Sem `.ps1` legado de proposito -- mesmo padrao de
    // Diaria-Beehiiv-Home-Meta-Check (#5005, 1a task registrada depois do
    // cutover systemd/epica #4798): nao criar um novo `.ps1` so pra
    // preencher este campo opcional. Via de execucao real: par
    // `.service`/`.timer` gerado por scripts/setup-systemd-timers.ts.
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
    legacySetupScript: "scripts/setup-postmaster-spam-sync-schedule.ps1",
    issue: "#4154",
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
    legacySetupScript: "scripts/setup-seo-schedule.ps1",
    issue: "#4105, #1896, #1989, #4909",
  },
  {
    name: "Diaria-Worker-Drift-Check",
    description: "alarme de drift entre o codigo publicado e o master de cada Worker",
    steps: [{ key: "check", script: "scripts/worker-drift-check.ts" }],
    logPath: "worker-drift-check/.drift-check.log",
    schedule: { kind: "interval", hours: 6 },
    legacySetupScript: "scripts/setup-worker-drift-check-schedule.ps1",
    issue: "#4723",
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
