#!/usr/bin/env node
/**
 * scripts/arm-systemd-timers.ts (#4828, épica #4798)
 *
 * Passo de ARMAR os units systemd das tasks do registro declarativo
 * (`scripts/lib/scheduled-tasks.ts`) — copia os arquivos `.service`/`.timer`
 * já gerados por `scripts/setup-systemd-timers.ts` (`.systemd-units/` por
 * padrão) pra `~/.config/systemd/user/`, roda `systemctl --user
 * daemon-reload` e então `systemctl --user enable --now <unit>.timer` pra
 * cada um.
 *
 * **Separação deliberada de responsabilidade (#4805 Fase 3 / #4807):** os
 * GERADORES de unit (`scripts/setup-systemd-timers.ts`,
 * `scripts/overnight/setup-watchdog-schedule-systemd.ts`) continuam só
 * escrevendo arquivo em disco — nunca chamam `systemctl`, garantia travada
 * estruturalmente por `test/systemd-units.test.ts`/`test/watchdog-systemd-units.test.ts`
 * (ausência de `node:child_process` nesses módulos). Este script É o lugar
 * que efetivamente chama `systemctl` — um PASSO SEPARADO, rodado depois do
 * gerador, nunca dentro dele. Fluxo completo pra uma task:
 *
 *   1. npx tsx scripts/setup-systemd-timers.ts [--task <Nome>]   (gera arquivo)
 *   2. npx tsx scripts/arm-systemd-timers.ts [--task <Nome>]     (arma de verdade)
 *
 * **Guard `--rearm-stopped` (#4828):** decisão do editor (comentário
 * 260810 da issue) — um `systemctl --user stop <unit>` manual é sempre um
 * sinal de intenção humana (credencial vazada, task em loop, envio
 * duplicado), e uma regeneração/re-arme subsequente NÃO deve reverter isso
 * em silêncio. Por padrão, `armSystemdTimers` detecta um timer que JÁ
 * EXISTE (`LoadState=loaded`, não `not-found`) e está `ActiveState=inactive`
 * e **pula** — imprime aviso alto com o nome do unit + o comando manual pra
 * religar deliberadamente, nunca chama `enable --now` nele. Só com
 * `--rearm-stopped` esse timer específico volta a ser religado
 * normalmente. Um timer que NUNCA existiu (`LoadState=not-found` — 1ª vez
 * armando) é sempre armado, independente da flag: o guard protege contra
 * RELIGAR algo parado deliberadamente, não contra armar pela primeira vez.
 *
 * **`--verify` (#7032):** modo SÓ-LEITURA, separado do fluxo de armar acima
 * — cruza o registro declarativo inteiro (`scripts/lib/scheduled-tasks.ts`)
 * contra `systemctl --user list-timers --all` nas DUAS direções e sai com
 * `exit 1` se qualquer uma tiver achado, `exit 0` se estiver tudo em
 * sincronia. Não arma, não desarma, nunca chama `enable`/`disable`/`stop`.
 * Existe pra fechar o buraco descrito na issue: task declarada sem timer
 * armado nunca dispara (silêncio perfeito — não gera `failed`, não gera
 * alarme de nada até alguém notar por fora) e timer armado sem task no
 * registro dispara e falha alto (`run-task.ts` sai com "Task desconhecida").
 * Reusa a mesma lógica PURA (`evaluateTaskNeverArmed`,
 * `parseSystemctlListTimersOutput`) e a mesma leitura de `list-timers`
 * (`readArmedTimerUnitBaseNames`) já usadas por `Diaria-Task-Never-Armed-Alarm`
 * (`scripts/task-never-armed-alarm.ts`, #5607/#6773) — de propósito: ter DUAS
 * implementações independentes da mesma comparação seria o mesmo tipo de
 * drift silencioso que esta issue existe pra fechar. A diferença é só a
 * CASCA: aquele script envia e-mail + abre issue com dedup/estado próprio
 * (pensado pra rodar como task agendada, cadência diária); `--verify` aqui é
 * síncrono, sem estado, sem side-effect — pensado pra chamada ad-hoc (ex:
 * fim de PR que mexeu no registro) ou, no futuro, um passo `exit 1` dentro de
 * outra automação. **Nenhuma task agendada nova foi criada por este PR** —
 * decisão deliberadamente fora de escopo, ver #6798.
 *
 * Timer parado deliberadamente (`systemctl --user stop` manual, sem
 * `disable`) continua aparecendo em `list-timers --all` (`LoadState=loaded`,
 * só `ActiveState=inactive`) — `--verify` não o trata como drift, mesma
 * decisão do guard `--rearm-stopped` acima.
 *
 * Uso:
 *   npx tsx scripts/arm-systemd-timers.ts [--task <Nome>] [--rearm-stopped]
 *     [--units-dir <dir>] [--target-dir <dir>]
 *   npx tsx scripts/arm-systemd-timers.ts --verify
 *
 * **`--verify` é sempre GLOBAL e recusa combinar com as flags do fluxo de
 * armar** (`--task`, `--rearm-stopped`, `--units-dir`, `--target-dir`) —
 * `exit 2` com mensagem explicando o motivo (#7037, achado de self-review
 * do #7032). Escopar o verify por `--task` não tem leitura semântica clara
 * (o valor do modo é justamente ver os DOIS conjuntos INTEIROS de uma vez —
 * um timer órfão, por definição, não tem task declarada pra passar em
 * `--task`), então aceitar e ignorar a flag silenciosamente seria pior que
 * recusar alto.
 *
 * --task:        arma só a task nomeada (default: todas as SCHEDULED_TASKS).
 * --rearm-stopped: religa mesmo os timers já existentes e `inactive`
 *                 (comportamento antigo, restaurado explicitamente).
 * --units-dir:   onde ler os `.service`/`.timer` já gerados, relativo à raiz
 *                do repo (default: ".systemd-units/", mesmo default de
 *                `setup-systemd-timers.ts`).
 * --target-dir:  onde instalar os units (default: `~/.config/systemd/user/`
 *                — só use outro valor em teste/dry-run manual, nunca em uso
 *                real).
 *
 * **NÃO cobre o watchdog overnight** (`scripts/overnight/setup-watchdog-schedule-systemd.ts`)
 * — aquele unit fica deliberadamente fora do registro declarativo
 * (`scripts/lib/watchdog-systemd-units.ts` documenta o porquê) e continua
 * armado manualmente por enquanto; nada impede reusar a mesma lógica de
 * guard aqui no futuro se isso incomodar.
 *
 * @see scripts/lib/scheduled-tasks.ts (registro declarativo)
 * @see scripts/setup-systemd-timers.ts (gerador — só escreve arquivo)
 * @see docs/overnight-watchdog-setup.md (par Linux do watchdog, mesmo padrão manual)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  getScheduledTaskByName,
  listDisabledScheduledTaskNames,
  listScheduledTaskNames,
  SCHEDULED_TASKS,
  type ScheduledTaskDefinition,
} from "./lib/scheduled-tasks.ts";
import { unitBaseName } from "./lib/systemd-units.ts";
import { evaluateTaskNeverArmed, isAlarmingVerdict, type TaskNeverArmedEvaluation } from "./lib/task-never-armed-alarm.ts";
import { readArmedTimerUnitBaseNames } from "./task-never-armed-alarm.ts";

const DEFAULT_UNITS_DIR = ".systemd-units";

/** `~/.config/systemd/user/` — mesmo diretório usado por todo o resto do
 * repo pra "user units" (ver `scripts/studio/setup-studio-service-linux.sh`,
 * `docs/overnight-watchdog-setup.md`). Função (não constante) pra permitir
 * mockar `homedir()` implicitamente via override de `--target-dir` em teste. */
export function defaultSystemdUserDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

// ---------------------------------------------------------------------------
// Estado do unit (LoadState + ActiveState) — parse puro + I/O injetável
// ---------------------------------------------------------------------------

export interface SystemdUnitState {
  loadState: string;
  activeState: string;
}

/**
 * Parseia a saída de `systemctl --user show <unit> --property=LoadState,ActiveState`
 * — 2 linhas `Chave=Valor` (ordem não garantida). Chave ausente/output
 * malformado vira string vazia, nunca lança. @pure
 */
export function parseUnitStateOutput(output: string): SystemdUnitState {
  const lines = output.split(/\r?\n/);
  let loadState = "";
  let activeState = "";
  for (const line of lines) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "LoadState") loadState = m[2].trim();
    if (m[1] === "ActiveState") activeState = m[2].trim();
  }
  return { loadState, activeState };
}

export interface QueryUnitStateResult {
  state: SystemdUnitState | null;
  /** Motivo de `state === null` — `null` no caminho de sucesso. `systemctl
   * show` NÃO lança pra unit ausente (devolve `LoadState=not-found`,
   * `ActiveState=inactive`, exit 0) — só chega aqui em falha real de
   * infraestrutura (systemctl ausente, bus indisponível, erro inesperado). */
  error: string | null;
}

/**
 * Consulta `systemctl --user show <unit> --property=LoadState,ActiveState`.
 * Ao contrário de `is-enabled`/`is-active` (usados em
 * `check-watchdog-armed.ts`/`scheduled-task-status.ts`, que exigem tratar
 * "exceção com stdout 'not-found'" como caminho de sucesso disfarçado),
 * `show` sempre sai com exit 0 e reporta o estado via as duas propriedades —
 * dá, numa única chamada, tanto "existe?" (`loadState`) quanto "está rodando
 * agora?" (`activeState`). É essa distinção que o guard do #4828 precisa:
 * só `is-active` sozinho não diferencia "nunca existiu" de "parada
 * deliberadamente" (as duas retornam `inactive`).
 *
 * `exec` injetável (default = `execFileSync` real) — nunca spawna
 * `systemctl` de verdade em teste (ver `test/arm-systemd-timers.test.ts`).
 */
export function queryUnitState(unit: string, exec: typeof execFileSync = execFileSync): QueryUnitStateResult {
  try {
    const out = exec("systemctl", ["--user", "show", unit, "--property=LoadState,ActiveState"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    return { state: parseUnitStateOutput(String(out ?? "")), error: null };
  } catch (e: unknown) {
    const err = e as { code?: string; stderr?: string };
    if (err.code === "ENOENT") {
      return { state: null, error: "systemctl indisponível (ENOENT) nesta consulta." };
    }
    const stderrText = String(err.stderr ?? "").trim();
    return {
      state: null,
      error:
        `systemctl show falhou ao consultar '${unit}' — não foi possível confirmar o estado atual` +
        (stderrText ? ` (stderr: ${stderrText.slice(0, 200)})` : "") +
        ".",
    };
  }
}

// ---------------------------------------------------------------------------
// Guard determinístico (#4828) — decide arm vs skip, nunca I/O
// ---------------------------------------------------------------------------

export type ArmAction = "arm" | "skip" | "unknown";

export type ArmReason =
  | "new-unit"
  | "rearm-stopped-flag"
  | "already-active-or-other"
  | "stopped-deliberately"
  | "cannot-verify-state";

export interface ArmDecision {
  action: ArmAction;
  reason: ArmReason;
}

/**
 * Guard central da #4828: decide se `enable --now` deve rodar pra um unit,
 * dado o estado atual consultado (`queryUnitState`) e a flag `--rearm-stopped`.
 *
 * - `state === null` (a consulta em si falhou) → `"unknown"`. NUNCA arma
 *   nem pula silenciosamente — mesma disciplina fail-soft de
 *   `check-watchdog-armed.ts`/`scheduled-task-status.ts`: não inventar um
 *   estado a partir de uma consulta que não respondeu.
 * - `loadState === "not-found"` (unit nunca existiu nesta máquina) →
 *   `"arm"`/`"new-unit"`, SEMPRE, independente da flag — o guard protege
 *   contra RELIGAR algo que foi parado deliberadamente, não contra armar
 *   pela 1ª vez.
 * - `activeState === "inactive"` num unit que já existe, sem
 *   `--rearm-stopped` → `"skip"`/`"stopped-deliberately"` (o core da issue
 *   #4828 — decisão do editor, comentário 260810).
 * - mesmo caso, COM `--rearm-stopped` → `"arm"`/`"rearm-stopped-flag"`
 *   (comportamento antigo, restaurado explicitamente).
 * - qualquer outro `activeState` (`active`, `activating`, `failed`, ...) →
 *   `"arm"`/`"already-active-or-other"` — `enable --now` num unit já ativo é
 *   idempotente; só o caso `inactive` é o alvo deste guard.
 * @pure
 */
export function decideArmAction(state: SystemdUnitState | null, rearmStopped: boolean): ArmDecision {
  if (state === null) return { action: "unknown", reason: "cannot-verify-state" };
  if (state.loadState === "not-found") return { action: "arm", reason: "new-unit" };
  if (state.activeState === "inactive") {
    return rearmStopped
      ? { action: "arm", reason: "rearm-stopped-flag" }
      : { action: "skip", reason: "stopped-deliberately" };
  }
  return { action: "arm", reason: "already-active-or-other" };
}

// ---------------------------------------------------------------------------
// Orquestração — copia units + daemon-reload (1×) + enable --now por task
// ---------------------------------------------------------------------------

export interface ArmUnitResult {
  taskName: string;
  unit: string;
  decision: ArmDecision;
  copied: boolean;
  armed: boolean;
  /** Detalhe de erro (consulta, cópia, daemon-reload ou enable --now) —
   * `null` no caminho de sucesso ou quando `decision.action === "skip"`. */
  error: string | null;
}

export interface ArmSystemdTimersOptions {
  unitsDirAbs: string;
  targetDirAbs: string;
  rearmStopped: boolean;
  exec?: typeof execFileSync;
  copyFile?: typeof copyFileSync;
  mkdir?: typeof mkdirSync;
  exists?: typeof existsSync;
}

/**
 * Arma uma lista de tasks: consulta o estado atual de cada `.timer`, decide
 * via `decideArmAction`, copia os units já gerados (`opts.unitsDirAbs`) pra
 * `opts.targetDirAbs` só pras que vão ser armadas, roda `daemon-reload` UMA
 * vez (não por unit) se algo foi copiado com sucesso, e então `enable --now`
 * em cada unit copiado. Todas as funções de I/O são injetáveis — nunca
 * chama `systemctl`/toca disco de verdade em teste
 * (`test/arm-systemd-timers.test.ts`).
 */
export function armSystemdTimers(
  tasks: ScheduledTaskDefinition[],
  opts: ArmSystemdTimersOptions,
): ArmUnitResult[] {
  const exec = opts.exec ?? execFileSync;
  const copyFile = opts.copyFile ?? copyFileSync;
  const mkdir = opts.mkdir ?? mkdirSync;
  const exists = opts.exists ?? existsSync;

  mkdir(opts.targetDirAbs, { recursive: true });

  const planned = tasks.map((task) => {
    const base = unitBaseName(task.name);
    const timerUnit = `${base}.timer`;
    const serviceUnit = `${base}.service`;
    const queried = queryUnitState(timerUnit, exec);
    const decision = decideArmAction(queried.state, opts.rearmStopped);
    return { task, timerUnit, serviceUnit, decision, queryError: queried.error };
  });

  const toArm = planned.filter((p) => p.decision.action === "arm");

  // Cópia — só pras que vão ser armadas. Unit fonte ausente (gerador nunca
  // rodou pra esta task) é erro explícito, não um skip silencioso.
  const copyOutcome = new Map<string, { copied: boolean; error: string | null }>();
  for (const p of toArm) {
    const srcService = join(opts.unitsDirAbs, p.serviceUnit);
    const srcTimer = join(opts.unitsDirAbs, p.timerUnit);
    if (!exists(srcService) || !exists(srcTimer)) {
      copyOutcome.set(p.timerUnit, {
        copied: false,
        error:
          `units não encontrados em ${opts.unitsDirAbs} — rode ` +
          `"npx tsx scripts/setup-systemd-timers.ts --task ${p.task.name}" primeiro.`,
      });
      continue;
    }
    try {
      copyFile(srcService, join(opts.targetDirAbs, p.serviceUnit));
      copyFile(srcTimer, join(opts.targetDirAbs, p.timerUnit));
      copyOutcome.set(p.timerUnit, { copied: true, error: null });
    } catch (e) {
      copyOutcome.set(p.timerUnit, {
        copied: false,
        error: `falha ao copiar units pra ${opts.targetDirAbs}: ${(e as Error).message}`,
      });
    }
  }

  const successfullyCopied = toArm.filter((p) => copyOutcome.get(p.timerUnit)?.copied);

  // daemon-reload UMA vez, não por unit — só se algo foi de fato copiado.
  let daemonReloadError: string | null = null;
  if (successfullyCopied.length > 0) {
    try {
      exec("systemctl", ["--user", "daemon-reload"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: unknown) {
      const err = e as { stderr?: string };
      daemonReloadError = `systemctl daemon-reload falhou: ${String(err.stderr ?? (e as Error).message).trim().slice(0, 200)}`;
    }
  }

  const results: ArmUnitResult[] = [];
  for (const p of planned) {
    if (p.decision.action !== "arm") {
      results.push({
        taskName: p.task.name,
        unit: p.timerUnit,
        decision: p.decision,
        copied: false,
        armed: false,
        error: p.queryError,
      });
      continue;
    }
    const copyResult = copyOutcome.get(p.timerUnit)!;
    if (!copyResult.copied) {
      results.push({
        taskName: p.task.name,
        unit: p.timerUnit,
        decision: p.decision,
        copied: false,
        armed: false,
        error: copyResult.error,
      });
      continue;
    }
    if (daemonReloadError) {
      results.push({
        taskName: p.task.name,
        unit: p.timerUnit,
        decision: p.decision,
        copied: true,
        armed: false,
        error: daemonReloadError,
      });
      continue;
    }
    let armed = false;
    let error: string | null = null;
    try {
      exec("systemctl", ["--user", "enable", "--now", p.timerUnit], { stdio: ["ignore", "pipe", "pipe"] });
      armed = true;
    } catch (e: unknown) {
      const err = e as { stderr?: string };
      error = `systemctl enable --now falhou pra '${p.timerUnit}': ${String(err.stderr ?? (e as Error).message).trim().slice(0, 200)}`;
    }
    results.push({ taskName: p.task.name, unit: p.timerUnit, decision: p.decision, copied: true, armed, error });
  }
  return results;
}

// ---------------------------------------------------------------------------
// --verify (#7032) — comparação declarado × armado, nas duas direções
// ---------------------------------------------------------------------------

export type VerifyOutcome =
  /** `systemctl` indisponível nesta consulta (ENOENT/erro sem stdout) —
   * mesmo fail-soft de `task-never-armed-alarm.ts`: "nada detectável",
   * nunca um drift. Windows (sem `systemctl` nenhum) sempre cai aqui. */
  | { kind: "unavailable" }
  | { kind: "evaluated"; evaluation: TaskNeverArmedEvaluation };

/**
 * Runner de `--verify` — só orquestra I/O (`readArmedTimerUnitBaseNames`,
 * injetável) + o registro declarativo; a comparação em si é
 * `evaluateTaskNeverArmed` (`./lib/task-never-armed-alarm.ts`, #5607), pura
 * e já coberta por `test/task-never-armed-alarm.test.ts` — não reimplementa
 * a lógica, só reusa. @see test/arm-systemd-timers.test.ts (cobertura desta
 * fronteira: injeta `exec` fake, nunca spawna `systemctl` de verdade).
 */
export function runVerify(exec: typeof execFileSync = execFileSync): VerifyOutcome {
  const armed = readArmedTimerUnitBaseNames(exec);
  if (armed === null) return { kind: "unavailable" };
  const evaluation = evaluateTaskNeverArmed(listScheduledTaskNames(), armed, listDisabledScheduledTaskNames());
  return { kind: "evaluated", evaluation };
}

/** Imprime o relatório de `runVerify` e devolve o exit code — `1` se
 * qualquer direção tiver achado, `0` no caso limpo OU quando `systemctl`
 * está indisponível (fail-soft, não é drift). @pure quanto ao exit code;
 * `console.*` é o único efeito colateral. */
export function reportVerifyOutcome(outcome: VerifyOutcome): number {
  if (outcome.kind === "unavailable") {
    console.log("[verify] systemctl --user indisponível nesta máquina (ex: Windows) — nada a comparar aqui.");
    return 0;
  }
  const { evaluation } = outcome;
  if (!isAlarmingVerdict(evaluation.verdict)) {
    console.log("[verify] OK — registro declarativo e timers armados em sincronia.");
    return 0;
  }
  if (evaluation.neverArmed.length > 0) {
    console.error(
      `[verify] DECLARADA MAS NÃO ARMADA (${evaluation.neverArmed.length}) — nunca vai disparar até alguém armar:`,
    );
    for (const name of evaluation.neverArmed) console.error(`  - ${name}`);
  }
  if (evaluation.orphanTimers.length > 0) {
    console.error(
      `[verify] ARMADA MAS NÃO DECLARADA (${evaluation.orphanTimers.length}) — vai disparar e falhar com "Task desconhecida":`,
    );
    for (const unit of evaluation.orphanTimers) console.error(`  - ${unit}.timer`);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Flags do fluxo de ARMAR que `--verify` não aceita combinar (#7037,
 * achado de self-review do #7032) — `--verify` é sempre global e só-leitura;
 * misturado com qualquer uma delas pareceria um verify ESCOPADO
 * (`--verify --task X` lendo como "verifica só a task X") quando na
 * verdade a flag adicional seria silenciosamente ignorada e o verify
 * global rodaria do mesmo jeito. Recusar alto é mais honesto que aceitar
 * e ignorar — mesma disciplina do resto do arquivo (nunca engolir flag
 * incompatível em silêncio). */
const VERIFY_INCOMPATIBLE_FLAGS = ["task", "rearm-stopped", "units-dir", "target-dir"] as const;

export function main(argv: string[], repoRootAbs: string): number {
  if (hasFlag(argv, "verify")) {
    const conflicting = VERIFY_INCOMPATIBLE_FLAGS.filter((f) => argv.some((a) => a === `--${f}` || a.startsWith(`--${f}=`)));
    if (conflicting.length > 0) {
      console.error(
        `--verify não aceita ${conflicting.map((f) => `--${f}`).join(", ")} — o verify é sempre global ` +
          `(compara o registro declarativo INTEIRO contra os timers armados, nas duas direções). ` +
          `Rode "--verify" sozinho, sem outras flags.`,
      );
      return 2;
    }
    return reportVerifyOutcome(runVerify());
  }

  let taskName: string | undefined;
  let unitsDirArg: string | undefined;
  let targetDirArg: string | undefined;
  try {
    taskName = getStringArg(argv, "task", { example: "Diaria-Apoios-Diff-Alarm" });
    unitsDirArg = getStringArg(argv, "units-dir", { example: DEFAULT_UNITS_DIR });
    targetDirArg = getStringArg(argv, "target-dir", { example: defaultSystemdUserDir() });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const rearmStopped = hasFlag(argv, "rearm-stopped");

  let tasks = SCHEDULED_TASKS;
  if (taskName) {
    const found = getScheduledTaskByName(taskName);
    if (!found) {
      console.error(`Task desconhecida: "${taskName}".`);
      return 1;
    }
    tasks = [found];
  }

  const unitsDirAbs = resolve(repoRootAbs, unitsDirArg ?? DEFAULT_UNITS_DIR);
  const targetDirAbs = targetDirArg ? resolve(targetDirArg) : defaultSystemdUserDir();

  const results = armSystemdTimers(tasks, { unitsDirAbs, targetDirAbs, rearmStopped });

  let exitCode = 0;
  for (const r of results) {
    if (r.decision.action === "skip") {
      console.warn(
        `[pulado] ${r.unit} está parado deliberadamente, não religado ` +
          `(use --rearm-stopped pra religar). Religar manualmente: systemctl --user enable --now ${r.unit}`,
      );
      continue;
    }
    if (r.decision.action === "unknown") {
      console.warn(
        `[?] ${r.unit}: não foi possível confirmar o estado atual (${r.error ?? "motivo desconhecido"}) — pulado por segurança.`,
      );
      exitCode = 1;
      continue;
    }
    if (r.armed) {
      console.log(`[armado] ${r.unit} (${r.decision.reason})`);
    } else {
      console.error(`[erro] ${r.unit}: ${r.error ?? "falha desconhecida ao armar"}`);
      exitCode = 1;
    }
  }

  return exitCode;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(main(process.argv.slice(2), repoRootAbs));
}
