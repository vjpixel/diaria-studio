/**
 * scripts/lib/scheduled-task-status.ts (#4799, épica #4798)
 *
 * Camada de estado das tasks agendadas — a peça que faltava pra "superfície
 * de Tarefas" do Studio (#4799) responder 3 perguntas por task do registro
 * declarativo (`scripts/lib/scheduled-tasks.ts`):
 *
 *   1. **Armada?** — a task existe e está habilitada no agendador desta
 *      máquina (Windows Task Scheduler OU systemd, as duas coexistem entre
 *      as máquinas do editor). `queryTaskArmed`.
 *   2. **Última execução / resultado / trecho de log** — lido de
 *      `data/{logPath}` (formato historicamente compartilhado pelos `.ps1`
 *      wrappers do Windows — diretamente ou via `Invoke-DiariaScheduledWrapper.psm1`,
 *      #4756, ambos removidos no #5115 — e hoje escrito por
 *      `scripts/lib/task-runner.ts`, #4805 Fase 2). `readTaskLastRun`.
 *   3. **Próxima execução prevista / atraso** — computado PURAMENTE a
 *      partir do `ScheduledTaskSchedule` declarado, sem depender do
 *      agendador real estar consultável (funciona mesmo quando (1) retornou
 *      `cannot_verify`). `computeNextRunAtOrAfter` / `isTaskOverdue`.
 *
 * **Generaliza, não reescreve** (instrução explícita da issue):
 *   - (1) reusa `queryWatchdogTaskExitCode`/`queryWatchdogTaskVerboseOutput`
 *     de `check-watchdog-armed.ts` (que ganharam um `taskName` opcional
 *     nesta mesma unidade — 100% retrocompatível, ver docstring de lá) +
 *     `parseWatchdogTaskState`/`classifyWatchdogTaskHealth` (já eram puras
 *     e genéricas — zero mudança) pro caminho Windows; e `unitBaseName` de
 *     `systemd-units.ts` (mesmo helper que gera os `.timer`/.service`
 *     reais, #4805 Fase 3) pro caminho Linux/systemd.
 *   - (2)/(3) são domínio NOVO — `check-watchdog-armed.ts` só sabe
 *     "presente + habilitada + último resultado NUMÉRICO do Task
 *     Scheduler"; nunca leu o CONTEÚDO de um log de task ou calculou
 *     uma data futura a partir de um `ScheduledTaskSchedule` — não havia o
 *     que generalizar.
 *
 * **Separação deliberada de responsabilidade entre (1) e (2):** "armada?"
 * (1) responde só "o agendador do SO tem a task registrada e habilitada?" —
 * nunca tenta inferir sucesso/falha do ÚLTIMO RUN a partir do Task
 * Scheduler (isso é o "last_run_failed"/"never_run" que
 * `classifyWatchdogTaskHealth` já sabe fazer, mas só pro watchdog em
 * Windows). "Resultado do último run" (2) vem inteiramente do LOG (formato
 * escrito por `task-runner.ts` no Linux/systemd, historicamente também
 * pelo `.ps1` no Windows antes do #5115) — essa é a fonte de verdade única
 * sobre sucesso/falha/duração, nunca duplicada por uma segunda leitura via
 * `schtasks`.
 *
 * **Fail-soft honesto em toda função de I/O deste módulo** (mesmo padrão de
 * `check-watchdog-armed.ts`/`exec-mode.ts`): nenhuma lança; ausência de
 * sinal vira um estado `"cannot_verify"`/`null` explícito, nunca um "tudo
 * ok" inventado.
 *
 * @see scripts/lib/check-watchdog-armed.ts (#2814/#2944/#4800 — generalizado aqui)
 * @see scripts/lib/scheduled-tasks.ts (registro declarativo consumido aqui)
 * @see scripts/lib/task-runner.ts (formato do log parseado aqui)
 * @see scripts/studio-ui/studio-tasks.ts (consumidor — camada de leitura da página /tarefas)
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectTaskScheduler, type TaskSchedulerKind } from "./exec-mode.ts";
import {
  WATCHDOG_TASK_NAME,
  queryWatchdogTaskExitCode,
  queryWatchdogTaskVerboseOutput,
  parseWatchdogTaskState,
} from "./check-watchdog-armed.ts";
import { unitBaseName } from "./systemd-units.ts";
import { BRT_TIMEZONE, zonedTimeToUtc } from "./next-edition-date.ts";
import type { ScheduledTaskDefinition, ScheduledTaskSchedule, WeekDay } from "./scheduled-tasks.ts";

// ---------------------------------------------------------------------------
// 1. Armada? — cross-platform, generaliza check-watchdog-armed.ts
// ---------------------------------------------------------------------------

export type SchedulerArmedState = "armed" | "disabled" | "not_armed" | "cannot_verify";

export interface TaskArmedResult {
  scheduler: TaskSchedulerKind;
  state: SchedulerArmedState;
  /** Detalhe textual — motivo do `cannot_verify`, ou `null` quando o estado
   * já é autoexplicativo. Nunca contém segredo (só nomes de comando/unit). */
  note: string | null;
}

export interface QueryTaskArmedOptions {
  execFn?: typeof execFileSync;
  taskSchedulerFn?: () => TaskSchedulerKind;
}

function queryWindowsTaskArmed(taskName: string, execFn: typeof execFileSync): TaskArmedResult {
  const scheduler: TaskSchedulerKind = "windows-task-scheduler";
  const exitCode = queryWatchdogTaskExitCode(execFn, taskName);
  if (exitCode === null) {
    return { scheduler, state: "cannot_verify", note: "schtasks indisponível (ENOENT) nesta consulta." };
  }
  if (exitCode !== 0) {
    return { scheduler, state: "not_armed", note: null };
  }
  const verbose = queryWatchdogTaskVerboseOutput(execFn, taskName);
  if (!verbose) {
    // A consulta simples confirmou que a task EXISTE, mas a consulta verbose
    // (que é a única fonte de "habilitada ou não") falhou — mesmo padrão do
    // incidente #2944: nunca inventar "armed" a partir só da presença.
    // Ninguém sabe se está habilitada ou desabilitada nesta consulta.
    return {
      scheduler,
      state: "cannot_verify",
      note: "presença confirmada, mas a consulta verbose (schtasks /v) falhou — não foi possível confirmar se a task está habilitada ou desabilitada.",
    };
  }
  const parsed = parseWatchdogTaskState(verbose);
  if (parsed.enabled === false) {
    return { scheduler, state: "disabled", note: null };
  }
  return { scheduler, state: "armed", note: null };
}

function queryLinuxTaskArmed(taskName: string, execFn: typeof execFileSync): TaskArmedResult {
  const scheduler: TaskSchedulerKind = "systemd";
  const unit = `${unitBaseName(taskName)}.timer`;
  try {
    const out = execFn("systemctl", ["--user", "is-enabled", unit], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    const value = String(out ?? "").trim();
    if (value === "disabled") return { scheduler, state: "disabled", note: null };
    if (value === "" || value === "not-found") return { scheduler, state: "not_armed", note: null };
    // "enabled", "enabled-runtime", "static", "alias", etc. — qualquer valor
    // que não seja explicitamente "disabled"/ausente é tratado como armado
    // (fail-soft: preferimos um "armed" espúrio a um "not_armed" espúrio
    // pra um valor de saída do systemctl que este módulo não previu).
    return { scheduler, state: "armed", note: null };
  } catch (e: unknown) {
    const err = e as { status?: number | null; code?: string; stdout?: string; stderr?: string };
    if (err.code === "ENOENT") {
      return { scheduler, state: "cannot_verify", note: "systemctl indisponível (ENOENT) nesta consulta." };
    }
    const stdoutTrim = String(err.stdout ?? "").trim();
    if (stdoutTrim === "disabled") {
      return { scheduler, state: "disabled", note: null };
    }
    // Achado AO VIVO (#4857, validado contra `systemctl` real, não só
    // fixture): `systemctl --user is-enabled <unit ausente>` sai com exit
    // code != 0 (4, verificado nesta máquina) E stdout "not-found\n" — o
    // caso "não armada" chega por EXCEÇÃO, não pelo caminho de sucesso
    // acima. Sem este branch, o caso MAIS COMUM (unit simplesmente ausente)
    // caía no "erro não reconhecido" abaixo e virava `cannot_verify` — um
    // falso "não deu pra verificar" bem no caso que esta função existe pra
    // responder. Distinto de stdout VAZIO na exceção (não tratado aqui como
    // not_armed): um erro que falhou antes de imprimir nada (bus
    // indisponível, permissão negada) também zera o stdout, e inferir
    // "ausente" dali inventaria uma resposta sem certeza suficiente.
    if (stdoutTrim === "not-found") {
      return { scheduler, state: "not_armed", note: null };
    }
    const stderrText = String(err.stderr ?? "");
    if (/failed to connect to bus/i.test(stderrText)) {
      return {
        scheduler,
        state: "cannot_verify",
        note: "sessão systemd --user indisponível neste processo (sem bus de sessão) — não é a mesma coisa que 'não armada'.",
      };
    }
    // Qualquer OUTRO erro não reconhecido (stderr sem "not-found" em stdout,
    // sem bus indisponível) NÃO é confirmação positiva de "não armada" — é
    // só um erro do systemctl que este módulo não reconhece com certeza
    // suficiente pra afirmar um estado. Antes da correção do #4833 (achado 2
    // do fleet review pré-merge da PR #4833) um erro genuinamente inesperado
    // (ex: permissão) caía neste mesmo caminho e era mal-relatado como "não
    // armada" — mesma classe do incidente #2944, mas do lado Linux. Honesto
    // é reportar `cannot_verify` e deixar o stderr bruto (truncado) no note.
    return {
      scheduler,
      state: "cannot_verify",
      note: `systemctl retornou erro inesperado ao consultar '${unit}' — não é possível confirmar se está armada (stderr: ${stderrText.trim().slice(0, 200) || "vazio"}).`,
    };
  }
}

/**
 * Consulta cross-platform se `taskName` está armada (registrada + habilitada)
 * no agendador desta máquina. Detecta a plataforma via `detectTaskScheduler`
 * (#4800) — nunca assume Windows a partir de `ExecMode`. Retorna
 * `state: "cannot_verify"` (nunca `"not_armed"`) quando esta máquina não
 * roda um agendador reconhecido, ou quando a consulta em si falhou — as
 * duas coisas pedem reações diferentes do editor (#4800 já documentou essa
 * distinção pro watchdog; aqui vale pra qualquer task).
 */
export function queryTaskArmed(taskName: string, opts: QueryTaskArmedOptions = {}): TaskArmedResult {
  const taskSchedulerFn = opts.taskSchedulerFn ?? detectTaskScheduler;
  const execFn = opts.execFn ?? execFileSync;
  const scheduler = taskSchedulerFn();

  if (scheduler === "windows-task-scheduler") return queryWindowsTaskArmed(taskName, execFn);
  if (scheduler === "systemd") return queryLinuxTaskArmed(taskName, execFn);
  return {
    scheduler,
    state: "cannot_verify",
    note: "nenhum agendador de tarefas reconhecido nesta máquina (nem Task Scheduler nem systemd).",
  };
}

// Re-exportado só por conveniência de quem quiser o nome da task do
// watchdog sem importar de dois módulos — não introduz acoplamento novo
// (check-watchdog-armed.ts já é importado por este arquivo de qualquer jeito).
export { WATCHDOG_TASK_NAME };

// ---------------------------------------------------------------------------
// 2. Log da última execução — parser puro + leitura de arquivo fail-soft
// ---------------------------------------------------------------------------

export interface TaskLogStepResult {
  key: string;
  /** `null` quando o valor não é numérico (ex: marcador `skip-guard` do
   * `.ps1` legado — removido no #5115, formato preservado por `task-runner.ts`). */
  code: number | null;
  /** Valor bruto (string) do lado direito do `key=valor` — usado só pra
   * detecção de guard-abort; não exposto fora deste módulo. */
  raw: string;
}

export interface TaskLogRun {
  /** Valor bruto do header (`now().toISOString()` no runner TS; o `.ps1`
   * legado, removido no #5115, emitia via `Get-Date -Format o` — os dois
   * formatos são ISO 8601, então logs antigos seguem parseáveis). */
  startedAt: string;
  description: string;
  guardAborted: boolean;
  /** Vazio quando `guardAborted` ou trailer `"noop"` (nenhum passo rodou). */
  steps: TaskLogStepResult[];
  /** Bloco inteiro (header→trailer, inclusive) — insumo do excerpt de log. */
  raw: string;
}

const RUN_HEADER_RE = /^===== (\S+) - (.*) =====$/;
const RUN_TRAILER_RE = /^===== fim \((.*)\) =====$/;

/**
 * Parseia TODO o conteúdo de um log de task em blocos de execução — nunca
 * lança (log malformado/truncado no meio de um bloco simplesmente descarta
 * o bloco incompleto, sem afetar os demais). Formato do header/trailer é
 * IDÊNTICO entre `task-runner.ts` (#4805 Fase 2) e o antigo `.ps1` legado
 * (removido no #5115) — ver docstring do módulo. @pure
 */
export function parseTaskLogRuns(content: string): TaskLogRun[] {
  const lines = content.split(/\r?\n/);
  const runs: TaskLogRun[] = [];
  let current: { startedAt: string; description: string; lines: string[] } | null = null;

  for (const line of lines) {
    const headerM = RUN_HEADER_RE.exec(line);
    if (headerM) {
      // Um novo header sem o trailer do bloco anterior ter fechado significa
      // log truncado/corrompido no meio de uma run — descarta o bloco
      // incompleto (nunca reporta um resultado que não foi de fato escrito).
      current = { startedAt: headerM[1], description: headerM[2], lines: [line] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    const trailerM = RUN_TRAILER_RE.exec(line);
    if (trailerM) {
      runs.push(finalizeRun(current, trailerM[1]));
      current = null;
    }
  }
  return runs;
}

function finalizeRun(
  block: { startedAt: string; description: string; lines: string[] },
  trailerValue: string,
): TaskLogRun {
  const raw = block.lines.join("\n");
  if (trailerValue === "guard=skip") {
    // Literal do runner TS (task-runner.ts) quando um `guard` aborta a run.
    return { startedAt: block.startedAt, description: block.description, guardAborted: true, steps: [], raw };
  }
  if (trailerValue === "noop") {
    return { startedAt: block.startedAt, description: block.description, guardAborted: false, steps: [], raw };
  }
  const steps: TaskLogStepResult[] = trailerValue
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const eq = tok.indexOf("=");
      if (eq === -1) return { key: tok, code: null, raw: "" };
      const key = tok.slice(0, eq);
      const rawVal = tok.slice(eq + 1);
      const num = Number(rawVal);
      const code = rawVal !== "" && Number.isFinite(num) ? num : null;
      return { key, code, raw: rawVal };
    });
  // Literal do `.ps1` legado (`Invoke-DiariaScheduledWrapper.psm1`): o
  // guard-abort vira `<ExitCodeKey>=skip-guard` (não um token "guard=skip"
  // dedicado como no runner TS) — detectado pelo VALOR, não pela chave (a
  // chave varia por task: "evaluate", "alarm", "sync", ...).
  const guardAborted = steps.some((s) => s.raw === "skip-guard");
  return { startedAt: block.startedAt, description: block.description, guardAborted, steps, raw };
}

export type TaskRunOutcome = "ok" | "failed" | "guard_skip" | "guard_abort" | "unknown";

/**
 * Classifica o resultado de UM `TaskLogRun` contra a definição da task —
 * precisa da definição pra saber quais `key`s são `bestEffort` (um passo
 * best-effort falhando NUNCA reprova a run, mesmo padrão de
 * `runScheduledTask` em `task-runner.ts`). `key` do log ausente do registro
 * (trailer legado desalinhado do registro atual, ex:
 * `run-clarice-sync-daily.ps1` hoje só emite `sync`/`summary`, sem o
 * `extract` do #4740) é tratado como NÃO best-effort — conservador: melhor
 * reportar falha suspeita do que engolir uma de verdade.
 *
 * **`successExitCodes` (#5592/#5615, generalizado de `systemd-units.ts`
 * neste PR):** um passo NÃO best-effort cujo `code` está em
 * `def.successExitCodes` (ex: exit 3 de `clarice-novos-run.ts` = abort
 * intencional do semáforo D4) nunca é `"failed"` — mas também não é
 * indistinguível de `"ok"`, porque a run de fato abortou por guard, ela só
 * não é um crash. Vira `"guard_abort"`: mesmo espírito distintivo de
 * `"guard_skip"` (guard PRÉ-execução, `def.guard`/`ScheduledTaskGuard`) só
 * que pra guard DENTRO de um passo, detectado pelo exit code do processo em
 * vez de um marcador de trailer dedicado. Sem isto, a página `/tarefas` do
 * Studio mostrava um abort D4 correto como `"failed"` — o mesmo problema de
 * visibilidade que este PR resolveu pro alarme systemd, só que nesta
 * segunda superfície de consumo do mesmo registro. @pure
 */
export function classifyTaskRunResult(run: TaskLogRun, def: ScheduledTaskDefinition): TaskRunOutcome {
  if (run.guardAborted) return "guard_skip";
  if (run.steps.length === 0) return "unknown"; // "noop" sem nenhum passo — não deveria ocorrer numa task real
  const bestEffortByKey = new Map(def.steps.map((s) => [s.key, !!s.bestEffort]));
  const successExitCodes = new Set(def.successExitCodes ?? []);
  let sawGuardAbort = false;
  for (const step of run.steps) {
    const isBestEffort = bestEffortByKey.get(step.key) ?? false;
    if (isBestEffort || step.code === 0) continue;
    if (step.code !== null && successExitCodes.has(step.code)) {
      sawGuardAbort = true;
      continue;
    }
    return "failed";
  }
  return sawGuardAbort ? "guard_abort" : "ok";
}

// ---------------------------------------------------------------------------
// Sanitização de excerpt (#4799 — "Nenhum secret na resposta da API")
// ---------------------------------------------------------------------------

/**
 * Padrões conservadores de redação — nunca perfeitos (impossível provar
 * "nenhum secret" contra um corpo de erro de API de terceiro arbitrário),
 * mas cobrem os casos reais que os scripts deste repo emitem: header
 * Authorization, pares `key=`/`token:` óbvios, e qualquer token opaco
 * longo (32+ chars alfanuméricos contíguos — a forma típica de API key,
 * hash, ou Bearer token; falso-positivo possível contra um ID legítimo
 * longo, aceitável no contexto de um EXCERPT de debug, não um dado
 * estruturado que precisa ser exato).
 */
const SECRET_PATTERNS: RegExp[] = [
  /(Authorization:\s*Bearer\s+)\S+/gi,
  /((?:api[_-]?key|apikey|access[_-]?token|token|secret|password|senha)["']?\s*[:=]\s*["']?)[A-Za-z0-9\-_.]{6,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

/** Redige possíveis secrets e trunca mantendo o TRECHO FINAL (a parte mais
 * recente/relevante de um log de execução). @pure */
export function sanitizeLogExcerpt(raw: string, maxChars: number): string {
  let text = raw;
  for (const re of SECRET_PATTERNS) {
    text = text.replace(re, (_match, prefix?: string) => (prefix ? `${prefix}[REDACTED]` : "[REDACTED]"));
  }
  if (text.length > maxChars) {
    text = `… (truncado)\n${text.slice(text.length - maxChars)}`;
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// I/O: leitura do log final (fail-soft)
// ---------------------------------------------------------------------------

export interface TaskLastRunInfo {
  /** `null` quando o log não existe, está vazio, ou não tem nenhum bloco reconhecível. */
  startedAt: Date | null;
  /** Aproximação de "quando terminou": mtime do arquivo de log — a run
   * inteira é anexada numa ÚNICA escrita ao final (ver docstring do módulo),
   * então o mtime do arquivo == o instante em que a última run terminou.
   * `null` só quando o arquivo não existe. */
  finishedAt: Date | null;
  /** `finishedAt - startedAt`, `null` se qualquer um dos dois for indeterminado. */
  durationMs: number | null;
  outcome: TaskRunOutcome | null;
  steps: TaskLogStepResult[];
  /** Trecho final do bloco da última run, sanitizado — `null` se não há run. */
  excerpt: string | null;
}

/** Cap defensivo de leitura — logs crescem por append indefinidamente; sem
 * isso um log de anos poderia inflar memória/CPU numa página que só
 * precisa do ÚLTIMO bloco. Lê só a CAUDA do arquivo quando maior que o cap
 * (bloco mais antigo eventualmente truncado no meio é descartado por
 * `parseTaskLogRuns`, nunca reportado como run válida). */
const MAX_LOG_READ_BYTES = 2 * 1024 * 1024;

function readTailOfFile(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const start = size - maxBytes;
    readSync(fd, buf, 0, maxBytes, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Lê `data/{def.logPath}` e devolve o estado da ÚLTIMA execução conhecida.
 * Fail-soft total: qualquer falha de I/O (arquivo ausente, permissão, log
 * vazio) devolve um `TaskLastRunInfo` com campos `null`, nunca lança.
 */
export function readTaskLastRun(
  rootDir: string,
  def: ScheduledTaskDefinition,
  opts: { maxExcerptChars?: number } = {},
): TaskLastRunInfo {
  const empty: TaskLastRunInfo = {
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    outcome: null,
    steps: [],
    excerpt: null,
  };
  const logPath = join(rootDir, "data", ...def.logPath.split("/"));
  if (!existsSync(logPath)) return empty;

  let content: string;
  let mtime: Date;
  try {
    mtime = statSync(logPath).mtime;
    content = readTailOfFile(logPath, MAX_LOG_READ_BYTES);
  } catch {
    return empty;
  }

  const runs = parseTaskLogRuns(content);
  const last = runs[runs.length - 1];
  if (!last) return { ...empty, finishedAt: mtime };

  const startedAt = new Date(last.startedAt);
  const validStart = !Number.isNaN(startedAt.getTime());
  const outcome = classifyTaskRunResult(last, def);
  const excerptMax = opts.maxExcerptChars ?? 4000;

  return {
    startedAt: validStart ? startedAt : null,
    finishedAt: mtime,
    durationMs: validStart ? Math.max(0, mtime.getTime() - startedAt.getTime()) : null,
    outcome,
    steps: last.steps,
    excerpt: sanitizeLogExcerpt(last.raw, excerptMax),
  };
}

// ---------------------------------------------------------------------------
// 3. Próxima execução prevista / atraso — puro, independente do agendador
// ---------------------------------------------------------------------------

const WEEKDAY_ORDER: WeekDay[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface BrtWallTime {
  year: number;
  month: number; // 1-based
  day: number;
  hour: number;
  minute: number;
  weekday: WeekDay;
}

/** Componentes de data/hora EM BRT (`America/Sao_Paulo`) de um `Date` UTC —
 * via `Intl`, mesmo padrão de `datePartsInTz` (`next-edition-date.ts`), com
 * hora/minuto/dia-da-semana adicionados. @pure */
function brtWallTimeOf(date: Date): BrtWallTime {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BRT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday") as WeekDay,
  };
}

/**
 * A ocorrência agendada mais recente que é `<= before` — base tanto de
 * `computeNextRunAtOrAfter` quanto de `isTaskOverdue`. Não se aplica a
 * `schedule.kind === "interval"` (sem âncora de calendário fixa — "a cada
 * N horas, a partir de quando foi armado", ver docstring de
 * `ScheduledTaskSchedule` em `scheduled-tasks.ts`) — lança nesse caso;
 * `isTaskOverdue` trata `interval` por um caminho totalmente separado
 * (relativo ao ÚLTIMO RUN, não ao calendário). @pure
 */
export function computeMostRecentScheduledOccurrence(schedule: ScheduledTaskSchedule, before: Date): Date {
  if (schedule.kind === "interval") {
    throw new Error(
      "computeMostRecentScheduledOccurrence não se aplica a schedule.kind 'interval' (sem âncora de calendário) — ver isTaskOverdue.",
    );
  }
  const wall = brtWallTimeOf(before);
  if (schedule.kind === "daily") {
    let candidate = zonedTimeToUtc(wall.year, wall.month, wall.day, schedule.hour, schedule.minute, 0, BRT_TIMEZONE);
    if (candidate.getTime() > before.getTime()) {
      candidate = new Date(candidate.getTime() - 24 * 3600 * 1000);
    }
    return candidate;
  }
  if (schedule.kind === "monthly") {
    // `day` é sempre 1-28 (ver docstring de ScheduledTaskSchedule) — válido
    // em todo mês, sem precisar clampar fim-de-mês. Meses têm comprimento
    // variável, então (diferente de daily/weekly) a ocorrência anterior não
    // é "subtrai um período fixo" — é decrementar o MÊS e reconstruir.
    let { year, month } = wall;
    let candidate = zonedTimeToUtc(year, month, schedule.day, schedule.hour, schedule.minute, 0, BRT_TIMEZONE);
    if (candidate.getTime() > before.getTime()) {
      month -= 1;
      if (month < 1) {
        month = 12;
        year -= 1;
      }
      candidate = zonedTimeToUtc(year, month, schedule.day, schedule.hour, schedule.minute, 0, BRT_TIMEZONE);
    }
    return candidate;
  }
  // weekly
  const todayIdx = WEEKDAY_ORDER.indexOf(wall.weekday);
  const targetIdx = WEEKDAY_ORDER.indexOf(schedule.dayOfWeek);
  const deltaDays = (todayIdx - targetIdx + 7) % 7;
  let candidate = new Date(
    zonedTimeToUtc(wall.year, wall.month, wall.day, schedule.hour, schedule.minute, 0, BRT_TIMEZONE).getTime() -
      deltaDays * 24 * 3600 * 1000,
  );
  if (candidate.getTime() > before.getTime()) {
    candidate = new Date(candidate.getTime() - 7 * 24 * 3600 * 1000);
  }
  return candidate;
}

/**
 * Próxima ocorrência agendada estritamente APÓS `after`, computada só a
 * partir do `ScheduledTaskSchedule` declarado — nunca depende do agendador
 * real estar consultável (funciona mesmo com `queryTaskArmed` retornando
 * `"cannot_verify"`). `null` pra `schedule.kind === "interval"`: sem uma
 * âncora de "quando a task começou a rodar" não há como prever a FASE do
 * próximo tick (a cadência é "a cada N horas, a partir de quando foi
 * armada" — ver `ScheduledTaskSchedule` em `scheduled-tasks.ts`) — mais
 * honesto retornar `null` do que uma previsão que ignora esse detalhe. @pure
 */
export function computeNextRunAtOrAfter(schedule: ScheduledTaskSchedule, after: Date): Date | null {
  if (schedule.kind === "interval") return null;
  const mostRecent = computeMostRecentScheduledOccurrence(schedule, after);
  if (schedule.kind === "monthly") {
    // Mês tem comprimento variável — "soma um período fixo" (o atalho usado
    // por daily/weekly abaixo) não vale aqui. Incrementa o MÊS a partir da
    // ocorrência mais recente e reconstrói.
    const wall = brtWallTimeOf(mostRecent);
    let year = wall.year;
    let month = wall.month + 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    return zonedTimeToUtc(year, month, schedule.day, schedule.hour, schedule.minute, 0, BRT_TIMEZONE);
  }
  const periodMs = schedule.kind === "daily" ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
  // mostRecent <= after por construção; a próxima ocorrência periódica após
  // mostRecent é necessariamente > after (não há ocorrência agendada entre
  // as duas — cadência fixa) — soma única, sem loop.
  return new Date(mostRecent.getTime() + periodMs);
}

/** Grace period default antes de marcar uma task como atrasada — folga
 * contra jitter normal de execução (fila do agendador, máquina em sleep no
 * horário exato, etc.), mesmo espírito da folga de 15h do watchdog
 * (#2688) e da janela de 21 dias do staleness alarm GEO (#4755): melhor
 * um alarme atrasado por uma hora do que um falso-positivo a cada corrida
 * levemente lenta. */
export const DEFAULT_OVERDUE_GRACE_MINUTES = 60;

/**
 * A task deveria ter rodado, pela cadência declarada, e (até onde o log
 * mostra) não rodou — o sinal que a issue #4799 chama de "atraso" e que
 * hoje não existe em lugar nenhum. `lastRunAt` vem de
 * `readTaskLastRun(...).startedAt` (ou `null` se nunca rodou/log ausente).
 *
 * - `daily`/`weekly`/`monthly`: atrasada quando o grace period já passou
 *   desde a ocorrência agendada mais recente E (a task nunca rodou OU o
 *   último run é anterior a essa ocorrência — ou seja, ela rodou mas não na
 *   "vez" certa).
 * - `interval`: sem âncora de calendário (ver `computeNextRunAtOrAfter`) —
 *   atrasada quando nunca rodou, ou quando já se passou mais que
 *   `hours + grace` desde o último run.
 * @pure
 */
export function isTaskOverdue(
  schedule: ScheduledTaskSchedule,
  lastRunAt: Date | null,
  now: Date,
  graceMinutes: number = DEFAULT_OVERDUE_GRACE_MINUTES,
): boolean {
  const graceMs = graceMinutes * 60_000;
  if (schedule.kind === "interval") {
    if (!lastRunAt) return true;
    return now.getTime() - lastRunAt.getTime() > schedule.hours * 3600 * 1000 + graceMs;
  }
  const mostRecent = computeMostRecentScheduledOccurrence(schedule, now);
  const graceElapsed = mostRecent.getTime() + graceMs <= now.getTime();
  if (!lastRunAt) return graceElapsed;
  return graceElapsed && lastRunAt.getTime() < mostRecent.getTime();
}
