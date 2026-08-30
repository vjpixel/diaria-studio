/**
 * scripts/lib/task-never-armed-alarm.ts (#5607)
 *
 * Lógica PURA do detector "task definida no registro declarativo
 * (`scripts/lib/scheduled-tasks.ts`) mas nunca ARMADA no systemd `--user`
 * real" — o buraco que o sweep genérico do #5563
 * (`systemd-failed-units-alarm.ts`) documentou e não cobre: `--state=failed`
 * só revela unit que DISPAROU e falhou; uma unit que nunca chegou a ser
 * disparada pelo timer (nunca armada, `systemctl --user enable --now`
 * nunca rodado) não aparece em `failed` — não há nada pra falhar.
 *
 * Achado ao vivo que motivou esta unidade (17/08/2026): 6 tasks estavam no
 * registro e nunca tinham timer armado na `helios` — incluindo o próprio
 * `Diaria-Systemd-Failed-Units-Alarm`, ou seja, a rede de segurança das
 * outras ~34 tasks estava no chão sem que nada alarmasse. Ver PR #5606
 * (armou as 6 retroativamente) e #5607 (esta unidade, o detector que devia
 * ter pego isso antes).
 *
 * **Comparação, ambas as direções:**
 * - Task no registro SEM timer armado → alarme forte (`neverArmed`,
 *   `family: "estado"`, P1) — é o caso concreto das 6.
 * - Timer `diaria-*` armado SEM task correspondente no registro → alarme
 *   mais fraco (`orphanTimers`, P3) — sinal de unit órfã (task renomeada
 *   ou removida do registro sem desarmar o timer). Duas exceções
 *   conhecidas e documentadas ficam de fora via `KNOWN_SCHEMA_EXCEPTIONS`
 *   abaixo — nunca alarmam como órfãs.
 *
 * I/O (`systemctl --user list-timers --all`, SÓ LEITURA — nunca
 * `enable`/`disable`/`start`/`stop`) fica em `scripts/task-never-armed-alarm.ts`.
 *
 * @see scripts/lib/systemd-failed-units-alarm.ts (sweep irmão — "disparou e
 *   falhou" em vez de "nunca disparou")
 * @see scripts/lib/scheduled-tasks.ts (fonte do registro declarativo)
 * @see scripts/lib/systemd-units.ts (`unitBaseName` — mesma tradução
 *   TaskName → nome-base de unit usada aqui)
 */
import { unitBaseName } from "./systemd-units.ts";

/**
 * Tasks legitimamente FORA do registro declarativo por limitação de schema
 * (documentado em `scheduled-tasks.ts`, cabeçalho — janela cruzando meia-
 * noite / entrypoint não-`npx tsx`), mas que TÊM timer systemd armado de
 * propósito. Sem esta allowlist, `orphanTimers` alarmaria pra sempre nelas —
 * nunca vão entrar no registro por desenho, não por esquecimento.
 * Nomes já em kebab-case de unit (sem sufixo `.timer`/`.service`).
 *
 * `diaria-node-modules-health-check` (#6030, #6774, resolve o achado da
 * #6658): unit SHELL PURO — não invoca `npx tsx`/`node --import tsx` de
 * propósito, porque a razão dela existir é detectar quando `node_modules`/
 * `tsx` deste checkout está quebrado; colocá-la no registro (executado via
 * `task-runner.ts`, que É `node --import tsx`) faria seu próprio executor
 * depender do componente que ela existe pra vigiar. Cadência de 15min
 * também não cabe em `ScheduledTaskSchedule.interval` (só múltiplos de hora
 * inteira). Mesma classe de exclusão de `diaria-overnight-watchdog` — ver
 * cabeçalho de `scheduled-tasks.ts`.
 */
export const KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES: readonly string[] = [
  "diaria-edicao-diaria",
  "diaria-overnight-watchdog",
  "diaria-node-modules-health-check",
];

/** Pure — extrai os nomes-base de unit (sem `.timer`) da saída de
 * `systemctl --user list-timers --all --plain --no-legend`. Formato de
 * cada linha: `NEXT LEFT LAST PASSED UNIT ACTIVATES` (colunas separadas por
 * espaço múltiplo) — só a coluna `UNIT` (token terminando em `.timer`)
 * importa; datas/durações têm espaços internos e não são parseadas.
 * Tolera glyphs residuais e ausência total de `--plain` pegando o primeiro
 * token de cada linha que termina em `.timer`. */
export function parseSystemctlListTimersOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tokens = line.split(/\s+/);
      const timerToken = tokens.find((t) => t.endsWith(".timer"));
      return timerToken ? timerToken.replace(/\.timer$/, "") : "";
    })
    .filter((name) => name.length > 0);
}

export type TaskNeverArmedVerdict = "ok" | "alarm-never-armed" | "alarm-orphan-timers" | "alarm-both";

export interface TaskNeverArmedEvaluation {
  verdict: TaskNeverArmedVerdict;
  /** Nomes de `ScheduledTaskDefinition.name` (TaskName original, não
   * unit base) no registro sem timer armado. Sempre ordenado. */
  neverArmed: string[];
  /** Nomes-base de unit `diaria-*` armados sem task correspondente no
   * registro, excluindo `KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES`. Sempre
   * ordenado. */
  orphanTimers: string[];
}

function verdictFor(neverArmed: string[], orphanTimers: string[]): TaskNeverArmedVerdict {
  if (neverArmed.length > 0 && orphanTimers.length > 0) return "alarm-both";
  if (neverArmed.length > 0) return "alarm-never-armed";
  if (orphanTimers.length > 0) return "alarm-orphan-timers";
  return "ok";
}

/**
 * Pure — cruza a lista de `TaskName`s do registro declarativo contra os
 * nomes-base de unit `.timer` armados no systemd. `armedUnitBaseNames` já
 * vem parseado (I/O feito pelo caller via `parseSystemctlListTimersOutput`).
 *
 * `disabledTaskNames` (#6773, default `[]` — aditivo, não quebra callers
 * existentes): `TaskName`s marcadas `enabled: false` no registro
 * (`listDisabledScheduledTaskNames()` de `scheduled-tasks.ts`) — excluídas
 * da checagem `neverArmed` porque `setup-systemd-timers.ts` já pula de
 * propósito a geração de unit pra elas (ex: `Diaria-Sunset-Weekly`, #5807).
 * Nenhum timer armado pra uma task desarmada por decisão do editor é o
 * comportamento CORRETO — sem esta exclusão, `Diaria-Task-Never-Armed-Alarm`
 * reabre o mesmo falso-positivo pra sempre (achado #6657/#6773). Ainda
 * entram no cálculo de `orphanTimers` (via `registryUnitSet`, abaixo) — se
 * alguém armar manualmente um timer pra uma task desabilitada, isso segue
 * sendo reconhecido como "tem task correspondente", não como órfão.
 */
export function evaluateTaskNeverArmed(
  registryTaskNames: string[],
  armedUnitBaseNames: string[],
  disabledTaskNames: string[] = [],
): TaskNeverArmedEvaluation {
  const armedSet = new Set(armedUnitBaseNames);
  const disabledSet = new Set(disabledTaskNames);
  const neverArmed = registryTaskNames
    .filter((name) => !disabledSet.has(name))
    .filter((name) => !armedSet.has(unitBaseName(name)))
    .sort();

  const registryUnitSet = new Set(registryTaskNames.map(unitBaseName));
  const exceptionSet = new Set(KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES);
  const orphanTimers = armedUnitBaseNames
    .filter((u) => u.startsWith("diaria-"))
    .filter((u) => !registryUnitSet.has(u) && !exceptionSet.has(u))
    .sort();

  return { verdict: verdictFor(neverArmed, orphanTimers), neverArmed, orphanTimers };
}

export function isAlarmingVerdict(verdict: TaskNeverArmedVerdict): boolean {
  return verdict !== "ok";
}

// ---------------------------------------------------------------------------
// Idempotência do e-mail — 1 alarme por CONJUNTO (neverArmed ∪ orphanTimers),
// mesmo padrão de SystemdFailedUnitsAlarmState.
// ---------------------------------------------------------------------------

export interface TaskNeverArmedAlarmState {
  /** `null` = nunca alarmado ainda. Ambas as listas SEMPRE ordenadas. */
  lastAlarmed: { neverArmed: string[]; orphanTimers: string[] } | null;
}

export function emptyTaskNeverArmedAlarmState(): TaskNeverArmedAlarmState {
  return { lastAlarmed: null };
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function shouldSendTaskNeverArmedAlarm(
  evaluation: TaskNeverArmedEvaluation,
  state: TaskNeverArmedAlarmState,
): boolean {
  if (!isAlarmingVerdict(evaluation.verdict)) return false;
  if (state.lastAlarmed === null) return true;
  return (
    !sameStringSet(state.lastAlarmed.neverArmed, evaluation.neverArmed) ||
    !sameStringSet(state.lastAlarmed.orphanTimers, evaluation.orphanTimers)
  );
}

export function markTaskNeverArmedAlarmed(evaluation: TaskNeverArmedEvaluation): TaskNeverArmedAlarmState {
  return { lastAlarmed: { neverArmed: [...evaluation.neverArmed].sort(), orphanTimers: [...evaluation.orphanTimers].sort() } };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

export function buildTaskNeverArmedAlarmEmail(
  evaluation: TaskNeverArmedEvaluation,
  issueLines: string,
): { subject: string; body: string } {
  const parts: string[] = [];
  const subjectParts: string[] = [];

  if (evaluation.neverArmed.length > 0) {
    subjectParts.push(`${evaluation.neverArmed.length} task(s) nunca armada(s)`);
    parts.push(
      `${evaluation.neverArmed.length} task(s) do registro (\`scripts/lib/scheduled-tasks.ts\`) sem timer ` +
        `armado no systemd --user desta máquina:\n\n` +
        evaluation.neverArmed.map((n) => `  - ${n}`).join("\n"),
    );
  }
  if (evaluation.orphanTimers.length > 0) {
    subjectParts.push(`${evaluation.orphanTimers.length} timer(s) órfão(s)`);
    parts.push(
      `${evaluation.orphanTimers.length} timer(s) \`diaria-*\` armado(s) sem task correspondente no registro ` +
        `(possível task renomeada/removida sem desarmar o timer):\n\n` +
        evaluation.orphanTimers.map((n) => `  - ${n}.timer`).join("\n"),
    );
  }

  return {
    subject: `⚠️ ${subjectParts.join(" + ")}`,
    body:
      parts.join("\n\n") +
      "\n\nArmar: seguir `scripts/setup-systemd-timers.ts` (registro → units) ou o doc de setup específico " +
      "da task em `docs/scheduled-tasks-registry.md`. Desarmar timer órfão é ação manual do editor " +
      "(este alarme nunca muta systemd).\n\n" +
      "Achado automático de `Diaria-Task-Never-Armed-Alarm` (`scripts/task-never-armed-alarm.ts`, #5607)." +
      issueLines,
  };
}
