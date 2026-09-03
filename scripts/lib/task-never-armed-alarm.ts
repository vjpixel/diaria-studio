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

/**
 * (#7210) Distingue as duas leituras de "task no registro sem timer
 * armado": `task-never-setup` (unit nunca existiu nesta máquina —
 * `LoadState=not-found`, setup nunca rodou, prescrição mecânica é armar) e
 * `task-stopped-deliberately` (unit EXISTE mas está `ActiveState=inactive`
 * — sinal de `systemctl --user stop` manual, mesmo par LoadState/ActiveState
 * que `arm-systemd-timers.ts` já consulta pro guard `--rearm-stopped`
 * (#4828); prescrição é uma DECISÃO humana — religar ou remover a task de
 * `scheduled-tasks.ts` — nunca sobrescrita em silêncio).
 */
export type NeverArmedStatus = "task-never-setup" | "task-stopped-deliberately";

/** Par mínimo LoadState/ActiveState — mesmo shape de
 * `scripts/lib/systemd-unit-state.ts` (`SystemdUnitState`), redeclarado aqui
 * (sem import) pra manter este módulo livre de I/O e sem depender do módulo
 * que efetivamente chama `systemctl`. */
export interface UnitLoadActiveState {
  loadState: string;
  activeState: string;
}

/**
 * Pure — classifica um TaskName sem timer armado usando o par
 * LoadState/ActiveState (consultado pelo caller via
 * `scripts/lib/systemd-unit-state.ts#queryUnitState`, mesma leitura que
 * `arm-systemd-timers.ts` já faz pro guard `--rearm-stopped`, #4828).
 *
 * `unitState === null` (consulta não feita, ou falhou) cai no lado mais
 * conservador — `task-never-setup` — que é o comportamento anterior ao
 * #7210 (nenhum breaking change pro caller que não passa `unitStates`).
 */
export function classifyNeverArmedStatus(unitState: UnitLoadActiveState | null): NeverArmedStatus {
  if (unitState === null) return "task-never-setup";
  if (unitState.loadState === "not-found") return "task-never-setup";
  return "task-stopped-deliberately";
}

export interface TaskNeverArmedEvaluation {
  verdict: TaskNeverArmedVerdict;
  /** Nomes de `ScheduledTaskDefinition.name` (TaskName original, não
   * unit base) no registro sem timer armado. Sempre ordenado. Superconjunto
   * de `stoppedDeliberately` — mantido assim de propósito (#7210) pra não
   * quebrar o veredito/idempotência existentes, que já rodam sobre o
   * conjunto INTEIRO de "sem timer armado". */
  neverArmed: string[];
  /** Subconjunto de `neverArmed` (#7210): unit EXISTE (`LoadState` !=
   * `not-found`) mas está `ActiveState=inactive` — parado deliberadamente,
   * não "nunca configurado". Sempre ordenado. Vazio quando o caller não
   * fornece `unitStates` (4º arg de `evaluateTaskNeverArmed`) — todo item
   * cai no lado `task-never-setup` por padrão. */
  stoppedDeliberately: string[];
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
  /** (#7210) `LoadState`/`ActiveState` por nome-base de unit, consultado
   * pelo caller via `systemd-unit-state.ts#queryUnitState` SÓ pras tasks que
   * já se sabe não estarem em `armedUnitBaseNames` — não precisa (nem deve)
   * cobrir o registro inteiro. Chave ausente/omitida ⇒ `classifyNeverArmedStatus`
   * trata como `task-never-setup` (comportamento anterior, sem regressão). */
  unitStates: ReadonlyMap<string, UnitLoadActiveState | null> = new Map(),
): TaskNeverArmedEvaluation {
  const armedSet = new Set(armedUnitBaseNames);
  const disabledSet = new Set(disabledTaskNames);
  const neverArmed = registryTaskNames
    .filter((name) => !disabledSet.has(name))
    .filter((name) => !armedSet.has(unitBaseName(name)))
    .sort();

  const stoppedDeliberately = neverArmed
    .filter((name) => classifyNeverArmedStatus(unitStates.get(unitBaseName(name)) ?? null) === "task-stopped-deliberately")
    .sort();

  const registryUnitSet = new Set(registryTaskNames.map(unitBaseName));
  const exceptionSet = new Set(KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES);
  const orphanTimers = armedUnitBaseNames
    .filter((u) => u.startsWith("diaria-"))
    .filter((u) => !registryUnitSet.has(u) && !exceptionSet.has(u))
    .sort();

  return { verdict: verdictFor(neverArmed, orphanTimers), neverArmed, stoppedDeliberately, orphanTimers };
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

  // #7210: neverArmed é superconjunto de stoppedDeliberately — o e-mail
  // separa os dois porque a prescrição é OPOSTA (armar via script vs.
  // decisão humana: religar ou remover do registro).
  const stoppedSet = new Set(evaluation.stoppedDeliberately);
  const neverSetup = evaluation.neverArmed.filter((n) => !stoppedSet.has(n));

  if (neverSetup.length > 0) {
    subjectParts.push(`${neverSetup.length} task(s) nunca armada(s)`);
    parts.push(
      `${neverSetup.length} task(s) do registro (\`scripts/lib/scheduled-tasks.ts\`) sem timer ` +
        `armado no systemd --user desta máquina (setup nunca rodou):\n\n` +
        neverSetup.map((n) => `  - ${n}`).join("\n"),
    );
  }
  if (evaluation.stoppedDeliberately.length > 0) {
    subjectParts.push(`${evaluation.stoppedDeliberately.length} task(s) parada(s) deliberadamente`);
    parts.push(
      `${evaluation.stoppedDeliberately.length} task(s) do registro têm timer que EXISTE nesta máquina mas está ` +
        `\`ActiveState=inactive\` — sinal de \`systemctl --user stop\` manual, não "nunca configurada":\n\n` +
        evaluation.stoppedDeliberately.map((n) => `  - ${n}`).join("\n") +
        "\n\nDecisão pendente do editor: religar (`systemctl --user enable --now <unit>.timer`, ou " +
        "`arm-systemd-timers.ts --rearm-stopped`) ou remover a task de `scheduled-tasks.ts` se ela não faz mais " +
        "sentido. Este alarme NUNCA reverte a decisão de parar sozinho.",
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
