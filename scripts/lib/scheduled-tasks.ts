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
 * Guard opcional rodado ANTES de qualquer step — hoje só
 * `Diaria-Brevo-Diaria-Evaluate` tem um (achado HIGH do review #4552): abortar
 * sem rodar nada quando um arquivo esperado (tipicamente um store que o
 * junction `data/` do OneDrive ainda não sincronizou) está ausente, pra não
 * gravar um estado vazio por cima de dado real.
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
   * NUNCA lido em runtime pelo executor. */
  legacySetupScript: string;
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
    name: "Diaria-Brevo-Diaria-Guardrail",
    description: "circuit breaker de campanha do canal brevo_diaria",
    steps: [{ key: "check", script: "scripts/check-brevo-diaria-guardrail.ts" }],
    logPath: "brevo-diaria/.guardrail-check.log",
    schedule: { kind: "interval", hours: 4 },
    legacySetupScript: "scripts/setup-check-brevo-diaria-guardrail-schedule.ps1",
    issue: "#4476 item 9",
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
    steps: [{ key: "monitor", script: "scripts/geo-citation-monitor.ts", args: ["--strict"] }],
    logPath: "geo-citations/.monitor.log",
    schedule: { kind: "weekly", dayOfWeek: "Monday", hour: 10, minute: 30 },
    legacySetupScript: "scripts/setup-geo-citation-monitor-schedule.ps1",
    issue: "#4558 Parte C, #4754",
  },
  {
    name: "Diaria-Geo-Citation-Staleness-Alarm",
    description: "alarme de staleness do monitor de citacao GEO",
    steps: [{ key: "alarm", script: "scripts/geo-citation-staleness-alarm.ts" }],
    logPath: "geo-citations/.staleness-alarm.log",
    schedule: { kind: "weekly", dayOfWeek: "Monday", hour: 14, minute: 0 },
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
    name: "Diaria-Postmaster-Spam-Sync",
    description: "sync automatico do spamRate do Google Postmaster Tools",
    steps: [{ key: "sync", script: "scripts/postmaster-spam-sync.ts" }],
    logPath: "clarice-subscribers/.postmaster-spam-sync.log",
    schedule: { kind: "interval", hours: 12 },
    legacySetupScript: "scripts/setup-postmaster-spam-sync-schedule.ps1",
    issue: "#4154",
  },
  {
    name: "Diaria-SEO-Weekly",
    description: "loop de SEO semanal (cobertura de indexacao + Search Analytics)",
    steps: [
      { key: "index", script: "scripts/seo-index-check.ts", args: ["--only-posts", "--limit", "250"] },
      { key: "pull", script: "scripts/seo-pull.ts", args: ["--days", "28"] },
    ],
    logPath: "seo/.seo-weekly.log",
    schedule: { kind: "weekly", dayOfWeek: "Monday", hour: 4, minute: 10 },
    legacySetupScript: "scripts/setup-seo-schedule.ps1",
    issue: "#4105, #1896, #1989",
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
