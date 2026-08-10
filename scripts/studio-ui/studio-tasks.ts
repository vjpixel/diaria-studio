/**
 * studio-tasks.ts (#4799, fatia da EPIC "Studio UI" #3554 / épica das tasks
 * agendadas #4798)
 *
 * Camada de leitura pra `GET /api/tasks`: status de TODAS as tasks
 * agendadas do registro declarativo (`scripts/lib/scheduled-tasks.ts`, 14
 * hoje) num só lugar — armada? última execução (quando/duração/resultado)?
 * próxima execução prevista? atrasada? Arquivo próprio desta fatia (mesma
 * convenção de `studio-integrations.ts` #3848/`studio-skills.ts` #4270,
 * #3555) — `server.ts` só roteia.
 *
 * **Problema que resolve (issue #4799):** hoje o único jeito de saber se
 * `Diaria-Clarice-Sync` rodou hoje, se `Diaria-Worker-Drift-Check` está
 * armada, ou por que `Diaria-Apoios-Diff-Alarm` parou de mandar e-mail é
 * abrir o Task Scheduler/`systemctl --user` NA MÁQUINA e ler o `.log` — o
 * único sinal de saúde existente é negativo e indireto (o editor descobre
 * que algo quebrou quando um ALARME que deveria ter chegado não chega).
 * Esta página é só a fatia de LEITURA — nenhuma ação (rodar agora/habilitar/
 * desabilitar) nesta unidade, por decisão explícita da issue ("segunda
 * fatia, opcional").
 *
 * **Toda a lógica de estado vem de `scripts/lib/scheduled-task-status.ts`**
 * (novo nesta unidade, generaliza `check-watchdog-armed.ts` +
 * `pending-scheduled-tasks.ts` em vez de reescrever) — este arquivo só
 * itera `SCHEDULED_TASKS`, chama essas funções por task, e monta o
 * snapshot. Ver docstring de lá pro detalhe de CADA sinal (armada / última
 * execução / próxima prevista / atraso).
 *
 * **Nunca expõe secret** — `readTaskLastRun` (scheduled-task-status.ts) já
 * sanitiza o excerpt de log antes de chegar aqui (`sanitizeLogExcerpt`); e
 * `TaskArmedResult.note` só carrega texto estático próprio deste módulo
 * (nunca eco de stdout/stderr de comando externo) — ver docstring de
 * `queryTaskArmed`.
 *
 * **Fail-soft por task** — mesmo padrão de `studio-integrations.ts`
 * (`evaluateIntegration`): uma falha inesperada ao avaliar UMA task (bug
 * futuro num probe, exceção não prevista) nunca derruba a página inteira —
 * vira o campo `error` daquela task específica.
 *
 * **Cache + TTL** (2 min default — mais curto que Integrações/5min, porque
 * "última execução" muda várias vezes por dia pras tasks mais frequentes,
 * ex: `Diaria-Brevo-Diaria-Guardrail`/`Diaria-Clarice-Guardrail-Alarm` a
 * cada 4h) — evita bater `schtasks`/`systemctl` + reler todo log a cada
 * carga de página. `forceRefresh` (botão "Atualizar") bypassa.
 */

import { detectExecMode, type ExecMode } from "../lib/exec-mode.ts";
import { SCHEDULED_TASKS, type ScheduledTaskDefinition, type ScheduledTaskSchedule } from "../lib/scheduled-tasks.ts";
import {
  queryTaskArmed,
  readTaskLastRun,
  computeNextRunAtOrAfter,
  isTaskOverdue,
  DEFAULT_OVERDUE_GRACE_MINUTES,
  type TaskArmedResult,
  type TaskLastRunInfo,
  type TaskRunOutcome,
} from "../lib/scheduled-task-status.ts";

// ─── descrição humana do schedule (#4799 — usada tanto pela API quanto testável isoladamente) ──

/** Rótulo curto em pt-BR pra `ScheduledTaskSchedule` — ex: "diária às
 * 08:30", "semanal (segunda) às 10:30", "a cada 4h". @pure */
export function describeSchedule(schedule: ScheduledTaskSchedule): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  if (schedule.kind === "daily") return `diária às ${pad2(schedule.hour)}:${pad2(schedule.minute)}`;
  if (schedule.kind === "weekly") {
    const dayLabel: Record<string, string> = {
      Monday: "segunda",
      Tuesday: "terça",
      Wednesday: "quarta",
      Thursday: "quinta",
      Friday: "sexta",
      Saturday: "sábado",
      Sunday: "domingo",
    };
    return `semanal (${dayLabel[schedule.dayOfWeek] ?? schedule.dayOfWeek}) às ${pad2(schedule.hour)}:${pad2(schedule.minute)}`;
  }
  return `a cada ${schedule.hours}h`;
}

// ─── tipos do snapshot ──────────────────────────────────────────────────

export interface TaskStepStatus {
  key: string;
  code: number | null;
}

export interface TaskLastRunStatus {
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: TaskRunOutcome | null;
  steps: TaskStepStatus[];
  /** Já sanitizado (secrets redigidos) e truncado por `readTaskLastRun`. */
  excerpt: string | null;
}

export interface TaskStatus {
  name: string;
  description: string;
  scheduleLabel: string;
  issue: string;
  logPath: string;
  armed: TaskArmedResult;
  lastRun: TaskLastRunStatus;
  /** ISO — `null` pra tasks `interval` (sem âncora de calendário, ver
   * `computeNextRunAtOrAfter`). */
  nextRunAt: string | null;
  overdue: boolean;
  /** Preenchido só quando algo inesperado quebrou a avaliação DESTA task —
   * as demais tasks do snapshot continuam normais (fail-soft por task). */
  error: string | null;
}

export interface TasksSnapshot {
  execMode: ExecMode;
  generatedAt: string;
  cached: boolean;
  overdueGraceMinutes: number;
  tasks: TaskStatus[];
}

// ─── avaliação por task (fail-soft) ─────────────────────────────────────

/** Converte o `TaskLastRunInfo` (Date-based, domínio de `scheduled-task-status.ts`)
 * pro shape serializável (`TaskLastRunStatus`, ISO strings) exposto no payload
 * de `/api/tasks`. @pure */
function toLastRunStatus(info: TaskLastRunInfo): TaskLastRunStatus {
  return {
    startedAt: info.startedAt ? info.startedAt.toISOString() : null,
    finishedAt: info.finishedAt ? info.finishedAt.toISOString() : null,
    durationMs: info.durationMs,
    outcome: info.outcome,
    steps: info.steps.map((s) => ({ key: s.key, code: s.code })),
    excerpt: info.excerpt,
  };
}

export interface EvaluateTaskOptions {
  now: Date;
  queryArmedFn: (taskName: string) => TaskArmedResult;
  readLastRunFn: (rootDir: string, def: ScheduledTaskDefinition) => TaskLastRunInfo;
  overdueGraceMinutes: number;
}

function evaluateTask(def: ScheduledTaskDefinition, rootDir: string, opts: EvaluateTaskOptions): TaskStatus {
  const base = {
    name: def.name,
    description: def.description,
    scheduleLabel: describeSchedule(def.schedule),
    issue: def.issue,
    logPath: def.logPath,
  };
  try {
    const armed = opts.queryArmedFn(def.name);
    const lastRunInfo = opts.readLastRunFn(rootDir, def);
    const nextRun = computeNextRunAtOrAfter(def.schedule, opts.now);
    const overdue = isTaskOverdue(def.schedule, lastRunInfo.startedAt, opts.now, opts.overdueGraceMinutes);
    return {
      ...base,
      armed,
      lastRun: toLastRunStatus(lastRunInfo),
      nextRunAt: nextRun ? nextRun.toISOString() : null,
      overdue,
      error: null,
    };
  } catch (e) {
    // Rede de segurança final — nenhuma função individual acima deveria
    // lançar (todas são fail-soft por construção em scheduled-task-status.ts),
    // mas uma 2ª camada aqui garante que um bug futuro nunca derruba a página.
    return {
      ...base,
      armed: { scheduler: "none", state: "cannot_verify", note: null },
      lastRun: { startedAt: null, finishedAt: null, durationMs: null, outcome: null, steps: [], excerpt: null },
      nextRunAt: null,
      overdue: false,
      error: (e as Error).message,
    };
  }
}

// ─── cache + entrada pública ────────────────────────────────────────────

interface CacheEntry {
  data: TasksSnapshot;
  expiresAt: number;
}

/** Cache em memória por `rootDir` — mesmo espírito de `studio-integrations.ts`. */
const cacheByRoot = new Map<string, CacheEntry>();

/** Limpa o cache — usado só por testes pra isolar casos entre si. */
export function clearTasksCache(): void {
  cacheByRoot.clear();
}

export interface BuildTasksDataOptions {
  now?: () => Date;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  overdueGraceMinutes?: number;
  /** Injetável pra testes — nunca deve spawnar `schtasks`/`systemctl` reais
   * em teste (mesmo princípio de `studio-integrations.ts`: probes reais só
   * em runtime). Default: `queryTaskArmed` real. */
  queryArmedFn?: (taskName: string) => TaskArmedResult;
  /** Injetável pra testes — default: `readTaskLastRun` real. */
  readLastRunFn?: (rootDir: string, def: ScheduledTaskDefinition) => TaskLastRunInfo;
}

/**
 * Monta o snapshot completo pra `GET /api/tasks`: status de TODAS as
 * `SCHEDULED_TASKS`. Sempre resolve (síncrono, na prática — nada aqui é
 * `async`, mas a assinatura devolve o valor direto, mesmo padrão de
 * `buildSkillsData`) — cada task é avaliada isoladamente por `evaluateTask`
 * (fail-soft por design).
 */
export function buildTasksData(rootDir: string, opts: BuildTasksDataOptions = {}): TasksSnapshot {
  const now = opts.now ?? (() => new Date());
  const nowDate = now();
  const nowMs = nowDate.getTime();
  const cacheTtlMs = opts.cacheTtlMs ?? 2 * 60_000;
  const overdueGraceMinutes = opts.overdueGraceMinutes ?? DEFAULT_OVERDUE_GRACE_MINUTES;

  if (!opts.forceRefresh) {
    const cached = cacheByRoot.get(rootDir);
    if (cached && cached.expiresAt > nowMs) {
      return { ...cached.data, cached: true };
    }
  }

  const queryArmedFn = opts.queryArmedFn ?? ((taskName: string) => queryTaskArmed(taskName));
  const readLastRunFn = opts.readLastRunFn ?? ((r: string, d: ScheduledTaskDefinition) => readTaskLastRun(r, d));
  const execMode = detectExecMode({ projectRoot: rootDir });
  const generatedAt = new Date(nowMs).toISOString();

  const tasks = SCHEDULED_TASKS.map((def) =>
    evaluateTask(def, rootDir, { now: nowDate, queryArmedFn, readLastRunFn, overdueGraceMinutes }),
  );

  const data: TasksSnapshot = { execMode, generatedAt, cached: false, overdueGraceMinutes, tasks };
  cacheByRoot.set(rootDir, { data, expiresAt: nowMs + cacheTtlMs });
  return data;
}
