#!/usr/bin/env node
/**
 * scripts/remediate-never-armed-tasks.ts (#7441, #7442, #7443)
 *
 * Fecha o loop que `Diaria-Task-Never-Armed-Alarm` (`scripts/task-never-armed-alarm.ts`,
 * #5607) deixa em aberto: o alarme é DELIBERADAMENTE só-leitura (nunca chama
 * `systemctl enable/disable/start/stop` — ver o guard documentado no topo
 * daquele arquivo) e a remediação até aqui era sempre manual: para CADA task
 * achada em `neverArmed`, alguém rodava à mão
 * `npx tsx scripts/setup-systemd-timers.ts --task <Nome>` seguido de
 * `npx tsx scripts/arm-systemd-timers.ts --task <Nome>` — um par de comandos
 * por task, escolhendo `<Nome>` a partir do texto do achado.
 *
 * Achado ao vivo (#7441/#7442/#7443, 04-05/09/2026): 3 tasks (`Diaria-GA4-
 * Sync`, `Diaria-Metrics-Health-Alarm`, `Diaria-Reconcile-Send-Audiences`)
 * declaradas em PRs anteriores por subagentes em worktrees isolados — que,
 * por desenho (#4807), NUNCA armam timer, só declaram — nunca tiveram o
 * passo de arme rodado na `helios` depois do merge. O alarme pegou a
 * divergência corretamente e abriu as 3 issues; a remediação em si foi feita
 * manualmente (comentário do editor nas issues), sem nenhum rastro em código
 * — exatamente o padrão que este script existe para substituir.
 *
 * Este script NÃO é um guard novo: reusa a MESMA lógica pura de comparação
 * (`evaluateTaskNeverArmed`, `scripts/lib/task-never-armed-alarm.ts`) e os
 * MESMOS geradores/armadores já existentes (`generateSystemdUnits` de
 * `setup-systemd-timers.ts`, `armSystemdTimers` de `arm-systemd-timers.ts`)
 * — só automatiza a ORQUESTRAÇÃO entre eles: descobre sozinho QUAIS tasks
 * estão em `neverArmed` (sem precisar que um humano copie `--task <Nome>`
 * um por vez a partir do texto de N issues) e gera+arma só essas, em lote,
 * numa chamada idempotente.
 *
 * **Escopo deliberadamente restrito a `task-never-setup` (#7210).** Tasks em
 * `stoppedDeliberately` (timer EXISTE mas foi `systemctl --user stop`
 * manualmente) NUNCA são tocadas por este script — religar isso é decisão
 * humana (mesmo racional de `toStoppedDeliberatelyFinding` no alarme), não
 * um caso de "nunca armado". `orphanTimers` (timer armado sem task no
 * registro) também não é acionável aqui — desarmar é decisão manual do
 * editor.
 *
 * **Idempotente por construção**: rodar quando não há `neverArmed`
 * (`task-never-setup`) não faz nenhuma escrita nem chama `systemctl` — só
 * `readArmedTimerUnitBaseNames`/`queryUnitState` (leitura). Rodar de novo
 * depois de armar não re-arma nada (a 2ª chamada não encontra mais
 * candidatos, porque `readArmedTimerUnitBaseNames` já os vê armados).
 *
 * Uso:
 *   npx tsx scripts/remediate-never-armed-tasks.ts [--dry-run]
 *     [--units-dir <dir>] [--target-dir <dir>]
 *
 * --dry-run:    avalia e imprime o plano (quais tasks seriam armadas), sem
 *               gerar arquivo nem chamar `systemctl`.
 * --units-dir:  onde gerar os `.service`/`.timer` (default: ".systemd-units/",
 *               mesmo default de `setup-systemd-timers.ts`). Só pra
 *               teste/dry-run manual — nunca usar valor diferente do
 *               default em uso real.
 * --target-dir: onde instalar os units (default: `~/.config/systemd/user/`
 *               — só use outro valor em teste/dry-run manual, nunca em uso
 *               real, mesmo contrato de `arm-systemd-timers.ts`).
 *
 * Guard de máquina sem systemd `--user` (sessão cloud, clone fresco, ou
 * qualquer máquina sem `systemctl`): mesmo fail-soft honesto do alarme —
 * "nada detectável nesta máquina", nunca erro. Erro transitório do
 * `systemctl` (bus indisponível, timeout, permissão) é "não sei", nunca
 * "nada a armar" — sai com `exit 1`.
 *
 * @see scripts/task-never-armed-alarm.ts (detector só-leitura que abre as issues)
 * @see scripts/setup-systemd-timers.ts (gerador — só escreve arquivo)
 * @see scripts/arm-systemd-timers.ts (armador — chama `systemctl` de verdade)
 * @see scripts/lib/task-never-armed-alarm.ts (comparação pura, reusada aqui)
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  getScheduledTaskByName,
  listDisabledScheduledTaskNames,
  listScheduledTaskNames,
  type ScheduledTaskDefinition,
} from "./lib/scheduled-tasks.ts";
import { unitBaseName } from "./lib/systemd-units.ts";
import { queryUnitState, type SystemdUnitState } from "./lib/systemd-unit-state.ts";
import { evaluateTaskNeverArmed, type UnitLoadActiveState } from "./lib/task-never-armed-alarm.ts";
import { readArmedTimerUnitBaseNames } from "./task-never-armed-alarm.ts";
import { generateSystemdUnits } from "./setup-systemd-timers.ts";
import { armSystemdTimers, defaultSystemdUserDir, type ArmUnitResult } from "./arm-systemd-timers.ts";

const DEFAULT_UNITS_DIR = ".systemd-units";
const LOG_PREFIX = "[remediate-never-armed-tasks]";

export interface RemediationPlan {
  /** TaskName (registro declarativo) a serem geradas+armadas por este
   * script — subconjunto de `neverArmed` que exclui `stoppedDeliberately`. */
  targets: string[];
  /** Reportado, NUNCA tocado — precisa de decisão humana (religar ou
   * remover do registro). */
  stoppedDeliberately: string[];
  /** Reportado, NUNCA tocado — desarmar é ação manual do editor. */
  orphanTimers: string[];
}

/**
 * Pura — decide QUAIS tasks este script deve gerar+armar, a partir da MESMA
 * comparação que `Diaria-Task-Never-Armed-Alarm` já faz
 * (`evaluateTaskNeverArmed`). Sem I/O; testável sem mockar filesystem/exec.
 * @pure
 */
export function planRemediation(
  registryTaskNames: string[],
  armedUnitBaseNames: string[],
  disabledTaskNames: string[],
  unitStates: ReadonlyMap<string, UnitLoadActiveState | null> = new Map(),
): RemediationPlan {
  const evaluation = evaluateTaskNeverArmed(registryTaskNames, armedUnitBaseNames, disabledTaskNames, unitStates);
  const stoppedSet = new Set(evaluation.stoppedDeliberately);
  const targets = evaluation.neverArmed.filter((name) => !stoppedSet.has(name));
  return { targets, stoppedDeliberately: evaluation.stoppedDeliberately, orphanTimers: evaluation.orphanTimers };
}

export interface RemediateOptions {
  repoRootAbs: string;
  isDryRun: boolean;
  exec?: typeof execFileSync;
  unitsDirAbs?: string;
  targetDirAbs?: string;
}

export interface RemediateOutcome {
  /** `"no-systemd" | "check-failed"` espelham `ReadArmedTimerUnitsResult`
   * do alarme; `"nothing-to-do"` e `"remediated"` são específicos deste
   * script. */
  status: "no-systemd" | "check-failed" | "nothing-to-do" | "dry-run" | "remediated";
  plan?: RemediationPlan;
  results?: ArmUnitResult[];
  message?: string;
}

/**
 * Orquestra a remediação de ponta a ponta: lê o estado armado atual,
 * calcula o plano (`planRemediation`), e — salvo `--dry-run` ou plano vazio —
 * gera (`generateSystemdUnits`) e arma (`armSystemdTimers`) só os alvos.
 * Toda função de I/O é injetável (`exec`), mesmo padrão de
 * `arm-systemd-timers.ts`/`task-never-armed-alarm.ts` — nunca chama
 * `systemctl` de verdade em teste.
 */
export function remediate(opts: RemediateOptions): RemediateOutcome {
  const exec = opts.exec ?? execFileSync;
  const armedResult = readArmedTimerUnitBaseNames(exec);
  if (armedResult.status === "no-systemd") return { status: "no-systemd" };
  if (armedResult.status === "check-failed") return { status: "check-failed", message: armedResult.message };

  const registryTaskNames = listScheduledTaskNames();
  const disabledTaskNames = listDisabledScheduledTaskNames();
  const armedSet = new Set(armedResult.unitBaseNames);
  const disabledSet = new Set(disabledTaskNames);
  const candidates = registryTaskNames.filter(
    (name) => !disabledSet.has(name) && !armedSet.has(unitBaseName(name)),
  );

  const unitStates = new Map<string, SystemdUnitState | null>();
  for (const name of candidates) {
    const base = unitBaseName(name);
    const { state } = queryUnitState(`${base}.timer`, exec);
    unitStates.set(base, state);
  }

  const plan = planRemediation(registryTaskNames, armedResult.unitBaseNames, disabledTaskNames, unitStates);
  if (plan.targets.length === 0) return { status: "nothing-to-do", plan };
  if (opts.isDryRun) return { status: "dry-run", plan };

  const tasksToArm = plan.targets
    .map((name) => getScheduledTaskByName(name))
    .filter((t): t is ScheduledTaskDefinition => t !== undefined);

  const unitsDirAbs = opts.unitsDirAbs ?? resolve(opts.repoRootAbs, DEFAULT_UNITS_DIR);
  const targetDirAbs = opts.targetDirAbs ?? defaultSystemdUserDir();
  generateSystemdUnits(tasksToArm, opts.repoRootAbs, unitsDirAbs);
  const results = armSystemdTimers(tasksToArm, { unitsDirAbs, targetDirAbs, rearmStopped: false, exec });
  return { status: "remediated", plan, results };
}

export function main(argv: string[], repoRootAbs: string, exec: typeof execFileSync = execFileSync): number {
  const isDryRun = hasFlag(argv, "dry-run");
  // `--units-dir`/`--target-dir` existem só pra teste/dry-run manual (mesmo
  // contrato de `arm-systemd-timers.ts`) — nunca usar valor diferente do
  // default em uso real, ou o arme acontece num diretório que o systemd
  // `--user` real não lê.
  let unitsDirArg: string | undefined;
  let targetDirArg: string | undefined;
  try {
    unitsDirArg = getStringArg(argv, "units-dir", { example: DEFAULT_UNITS_DIR });
    targetDirArg = getStringArg(argv, "target-dir", { example: defaultSystemdUserDir() });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const unitsDirAbs = unitsDirArg ? resolve(unitsDirArg) : undefined;
  const targetDirAbs = targetDirArg ? resolve(targetDirArg) : undefined;
  const outcome = remediate({ repoRootAbs, isDryRun, exec, unitsDirAbs, targetDirAbs });

  if (outcome.status === "no-systemd") {
    console.log(`${LOG_PREFIX} systemctl indisponível nesta máquina (sessão cloud/sem systemd --user) — nada a fazer.`);
    return 0;
  }
  if (outcome.status === "check-failed") {
    console.error(
      `${LOG_PREFIX} systemctl falhou ao consultar timers (motivo transitório, NÃO "sem systemd"): ${outcome.message} ` +
        "— não foi possível avaliar o plano; nada foi armado.",
    );
    return 1;
  }

  const plan = outcome.plan!;
  if (plan.stoppedDeliberately.length > 0) {
    console.warn(
      `${LOG_PREFIX} ${plan.stoppedDeliberately.length} task(s) parada(s) deliberadamente (ActiveState=inactive) — ` +
        `NÃO tocadas (decisão humana): ${plan.stoppedDeliberately.join(", ")}. Ver \`arm-systemd-timers.ts --rearm-stopped\`.`,
    );
  }
  if (plan.orphanTimers.length > 0) {
    console.warn(
      `${LOG_PREFIX} ${plan.orphanTimers.length} timer(s) armado(s) sem task no registro — NÃO tocados (desarmar é ` +
        `ação manual do editor): ${plan.orphanTimers.map((u) => `${u}.timer`).join(", ")}.`,
    );
  }

  if (outcome.status === "nothing-to-do") {
    console.log(`${LOG_PREFIX} nenhuma task 'nunca armada' — nada a remediar.`);
    return 0;
  }
  if (outcome.status === "dry-run") {
    console.log(
      `${LOG_PREFIX} --dry-run: ${plan.targets.length} task(s) seriam geradas+armadas: ${plan.targets.join(", ")}. ` +
        "Nenhum arquivo escrito, systemctl não chamado.",
    );
    return 0;
  }

  // outcome.status === "remediated"
  let exitCode = 0;
  for (const r of outcome.results ?? []) {
    if (r.armed) {
      console.log(`${LOG_PREFIX} [armado] ${r.taskName} -> ${r.unit} (${r.decision.reason})`);
    } else {
      console.error(`${LOG_PREFIX} [erro] ${r.taskName} -> ${r.unit}: ${r.error ?? "falha desconhecida ao armar"}`);
      exitCode = 1;
    }
  }
  return exitCode;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(main(process.argv.slice(2), repoRootAbs));
}
