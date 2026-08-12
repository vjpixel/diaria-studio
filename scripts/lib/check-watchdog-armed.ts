/**
 * check-watchdog-armed.ts (#2768, #2814, #2944)
 *
 * #2944 (260703): incidente distinto dos anteriores — a task ESTAVA
 * registrada nesta máquina (`queryWatchdogTaskExitCode` reportava presente)
 * durante um stall de ~10h, e mesmo assim o watchdog não bloqueou a
 * inatividade a tempo. Investigação (`schtasks /query /tn
 * "Diaria-Overnight-Watchdog" /v /fo LIST`, read-only): a task está
 * `Scheduled Task State: Enabled`, `Last Result: 0`, com `Last Run Time`
 * recente — ou seja, presente E aparentemente saudável nesta consulta
 * pontual pós-incidente, o que não descarta que ela tenha ficado
 * desabilitada/quebrada/sem rodar durante a JANELA do stall em si (schtasks
 * não expõe histórico completo, só o último run). O ponto cego real que
 * este módulo endereça: antes deste fix, `checkWatchdogArmed` reportava
 * `armed: true` só pela PRESENÇA da task (#2814), sem checar se ela está
 * habilitada ou se a última execução teve sucesso — dando falsa confiança
 * exatamente no cenário em que a task está presente mas inútil (desabilitada,
 * script quebrado, ou nunca rodou). Fix: `armedStatus` (`WatchdogArmedStatus`)
 * agora distingue `"armed"` de `"armed_but_disabled"` /
 * `"armed_but_stale"` (última execução falhou) / `"armed_but_never_run"` —
 * as 3 primeiras mapeiam para `action: "not_armed_warn"` (mesma resposta
 * fail-soft de uma task ausente), fechando o buraco de "falsa confiança"
 * descrito na issue. Ver `parseWatchdogTaskState` / `classifyWatchdogTaskHealth`
 * / `decideWatchdogArmedStatus` abaixo.
 *
 * Incidente 260630/260701: um subagente ficou ~4h30 sem progresso real e o
 * coordenador aceitou 5 notificações "ainda esperando" sem nunca comparar o
 * tempo decorrido contra o threshold de 60 min do #2379. Causa raiz #1: o
 * watchdog externo (#2688, `scripts/overnight-watchdog.ts`) nunca foi armado
 * nesta máquina — `scripts/overnight/setup-watchdog-schedule.ps1` é setup
 * manual one-time por máquina e ninguém rodou.
 *
 * #2814 (260702): a detecção original parseava o output textual de
 * `schtasks /query /fo LIST` procurando uma linha `TaskName: ...` — mas o
 * `schtasks` em Windows localizado (ex: PT-BR) emite o rótulo traduzido
 * ("Nome da Tarefa:"), então o parser nunca casava e o check reportava
 * `not_armed_warn` mesmo com a task presente e Ready. Fix: a detecção
 * principal agora usa o **exit code** de `schtasks /query /tn "..."`
 * (0 = task existe, != 0 = não existe) — locale-agnóstico, ver
 * `queryWatchdogTaskExitCode` abaixo. `isWatchdogTaskScheduled` (parser
 * textual legado) é mantido só porque `test/check-watchdog-armed.test.ts` o
 * cobre com fixtures — não é mais usado no caminho de detecção real.
 *
 * #4800 (260809): bug distinto dos anteriores — não é sobre a task estar
 * presente/saudável, é sobre em QUE MÁQUINA a checagem roda. `ExecMode`
 * (`'local'` vs `'cloud'`, `scripts/lib/exec-mode.ts`) responde "tenho os
 * recursos locais (`data/`, credenciais)?" — e nada mais. Até aqui, este
 * módulo assumia implicitamente que `mode === 'local'` também significava
 * "esta máquina roda o Task Scheduler do Windows", o que quebrou assim que
 * o editor configurou o OneDrive numa máquina Linux: `data/` passa a
 * existir lá (symlink), `detectExecMode()` responde `'local'` corretamente,
 * mas `queryWatchdogTaskExitCode` tenta rodar `schtasks` (inexistente no
 * Linux), lança, e o `catch` faz `taskPresent = false` — resultando num
 * `armedStatus: "not_armed"` que é um FALSO NEGATIVO: a verdade é "não foi
 * possível verificar", não "não está armado". Os dois estados pedem reações
 * opostas do editor (um é "vá armar"; o outro é "não dá pra saber daqui").
 * Fix: `detectTaskScheduler()` (novo eixo em `exec-mode.ts`, derivado da
 * PLATAFORMA + presença do binário, nunca de `data/`) é consultado antes de
 * escolher `schtasks`; quando o resultado não é
 * `'windows-task-scheduler'`, `checkWatchdogArmed` retorna cedo com
 * `armedStatus: "cannot_verify"` / `action: "cannot_verify_warn"` — um
 * terceiro estado explícito, distinto de `"not_armed"`, cuja mensagem
 * (`buildWatchdogCannotVerifyMessage`) NUNCA sugere um comando de arme
 * específico de plataforma (ver docstring da função). Suporte de fato a
 * verificar via `systemd` é escopo do #4798, ainda não implementado — até
 * lá, `cannot_verify` em Linux só informa que não dá pra confirmar, sem
 * inventar uma instrução que não existe.
 *
 * Este módulo dá ao Passo 1 da Fase 0 de `/diaria-overnight` (e de
 * `/diaria-develop`, que roda por natureza local) uma forma determinística
 * de checar se a task "Diaria-Overnight-Watchdog" está registrada no Task
 * Scheduler — em vez de assumir silenciosamente que está.
 *
 * Decisão de design (documentada aqui por instrução da issue #2768): quando
 * a task NÃO está armada em sessão local, este módulo **loga warning**
 * (run-log + stdout) em vez de disparar automaticamente o setup (o antigo
 * `scripts/overnight/setup-watchdog-schedule.ps1`, removido no #5115 —
 * hoje `scripts/overnight/setup-watchdog-schedule-systemd.ts`). Motivo:
 * registrar/armar uma scheduled task é um side-effect de nível de máquina
 * (fora do repo, fora de qualquer `git revert`) que pode disparar sem
 * contexto suficiente (a checagem pode rodar de dentro de um worktree
 * efêmero do coordenador ou de um subagente) — feature demais pra um guard
 * que deveria ser barato e sempre seguro de rodar. O padrão "log warning
 * explícito, nunca bloqueia" já é o mesmo aplicado a `drive-sync.ts` e ao
 * restante desta suíte (fail-soft).
 *
 * Uso em runtime (skills):
 *   ```bash
 *   npx tsx scripts/lib/check-watchdog-armed.ts
 *   # imprime o diagnóstico; exit 0 sempre (nunca bloqueia a rodada)
 *   ```
 *
 * Uso programático:
 *   ```ts
 *   import { checkWatchdogArmed } from "./lib/check-watchdog-armed.ts";
 *   const result = checkWatchdogArmed();
 *   // result.action: "skip_cloud" | "armed" | "not_armed_warn" | "cannot_verify_warn" (#4800)
 *   ```
 *
 * @see scripts/overnight-watchdog.ts (#2688)
 * @see scripts/overnight/setup-watchdog-schedule-systemd.ts (setup — Windows/.ps1 removido no #5115)
 * @see scripts/lib/exec-mode.ts (#2643)
 * @see .claude/skills/diaria-overnight/SKILL.md § Fase 0 passo 1, § Stall passivo
 *
 * **#4799 (Studio "Tarefas"):** `queryWatchdogTaskExitCode` e
 * `queryWatchdogTaskVerboseOutput` ganharam um 2º parâmetro opcional
 * `taskName` (default `WATCHDOG_TASK_NAME`, preserva 100% do comportamento
 * existente — todo call site antigo continua passando só `exec`) — permite
 * que `scripts/lib/scheduled-task-status.ts` REUSE a mesma consulta
 * `schtasks` locale-agnóstica (#2814) pra QUALQUER task do registro
 * declarativo (`scripts/lib/scheduled-tasks.ts`), não só o watchdog.
 * `parseWatchdogTaskState`/`classifyWatchdogTaskHealth` já eram funções
 * puras genéricas (operam sobre texto/`WatchdogTaskState`, nunca sobre o
 * nome da task) — reusadas sem nenhuma mudança.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { detectExecMode, detectTaskScheduler, type ExecMode, type TaskSchedulerKind } from "./exec-mode.ts";
import { isMainModule } from "./cli-args.ts";
import { unitBaseName } from "./systemd-units.ts";

/** Nome exato da scheduled task (Task Scheduler no Windows; base do unit systemd no Linux). */
export const WATCHDOG_TASK_NAME = "Diaria-Overnight-Watchdog";

// ---------------------------------------------------------------------------
// Parser puro (testável com fixtures de string — nunca chama schtasks real)
// ---------------------------------------------------------------------------

/**
 * Parseia o output de `schtasks /query /tn "Diaria-Overnight-Watchdog" /fo LIST`
 * (ou `/query /fo LIST` sem filtro, output completo) e determina se a task
 * está registrada.
 *
 * Formato real do Windows quando a task existe (via `/fo LIST`):
 *   ```
 *   Folder: \
 *   HostName:                             MEUPC
 *   TaskName:                             \Diaria-Overnight-Watchdog
 *   Next Run Time:                        7/1/2026 6:00:00 PM
 *   Status:                               Ready
 *   ...
 *   ```
 *
 * Quando a task NÃO existe, `schtasks /query /tn "..."` sai com exit code
 * != 0 e imprime (stdout ou stderr, varia por locale):
 *   `ERROR: The system cannot find the file specified.`
 *
 * Contrato: qualquer output que não contenha uma linha `TaskName:` cujo
 * valor (ignorando o `\` prefixo de tasks na raiz e maiúsc/minúsc) bata com
 * `WATCHDOG_TASK_NAME` é tratado como "não armada" — inclui strings vazias,
 * mensagens de erro, e output malformado/truncado.
 */
export function isWatchdogTaskScheduled(schtasksOutput: string): boolean {
  if (!schtasksOutput || !schtasksOutput.trim()) return false;

  const lines = schtasksOutput.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*TaskName:\s*(.+?)\s*$/i);
    if (!m) continue;
    const value = m[1].trim().replace(/^\\+/, "");
    if (value.toLowerCase() === WATCHDOG_TASK_NAME.toLowerCase()) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Decisão pura (dado modo + estado de arming, decide a ação)
// ---------------------------------------------------------------------------

/**
 * `"cannot_verify_warn"` (#4800) é um caso PARALELO a `"not_armed_warn"`,
 * não produzido por `decideWatchdogArmingAction` abaixo (que só conhece
 * `armed: boolean`) — é decidido antes, em `checkWatchdogArmed`, quando
 * `detectTaskScheduler()` não reconhece o agendador desta máquina. Ambos
 * levam ao mesmo tratamento fail-soft de "avisar, nunca bloquear", mas o
 * `action` distinto permite que quem consome o resultado (hoje: só a
 * mensagem impressa por este módulo; potencialmente o coordenador de
 * `/diaria-overnight` no futuro) não trate "não deu pra confirmar" como
 * "confirmei que está desarmado" — são reações diferentes.
 */
export type WatchdogArmingAction = "skip_cloud" | "armed" | "not_armed_warn" | "cannot_verify_warn";

/**
 * Pure: decide a ação dado o modo de execução e se a task está armada.
 * Em modo cloud, o watchdog (Task Scheduler local) não se aplica — nunca é
 * warning, é apenas fora de escopo. Não é chamada quando o agendador desta
 * máquina não pôde ser identificado (`cannot_verify_warn`, #4800) — ver
 * `checkWatchdogArmed`.
 */
export function decideWatchdogArmingAction(
  mode: ExecMode,
  armed: boolean,
): WatchdogArmingAction {
  if (mode === "cloud") return "skip_cloud";
  return armed ? "armed" : "not_armed_warn";
}

export function buildWatchdogWarningMessage(): string {
  return (
    `Watchdog overnight (#2688) NÃO está armado no Task Scheduler desta máquina ` +
    `(task "${WATCHDOG_TASK_NAME}" ausente). Sem ele, um stall silencioso total ` +
    `(nenhum evento chega ao coordenador) só é descoberto manualmente — foi a ` +
    `causa raiz #1 do incidente #2768. O .ps1 de arme foi removido no #5115 (cutover ` +
    `final, 260812) — por política nenhuma tarefa Diaria-* deve rodar no Windows ` +
    `(#5074); a via real é systemd no servidor (ver docs/overnight-watchdog-setup.md).`
  );
}

/**
 * Mensagem para `armedStatus: "cannot_verify"` (#4800) quando esta máquina
 * não roda um agendador de tarefas RECONHECIDO — hoje só o caso
 * `schedulerKind === "none"` (nem `schtasks` nem `systemctl` no PATH desta
 * plataforma). Regra dura, do próprio #4800: esta mensagem NUNCA sugere um
 * comando de arme específico de plataforma. Diz explicitamente "não dá pra
 * verificar daqui", não "não está armado" — os dois pedem reações opostas do
 * editor.
 *
 * **`schedulerKind === "systemd"` não passa mais por aqui desde o #4857** —
 * `checkWatchdogArmed` ganhou um branch systemd de verdade (`queryLinuxTimerArmed`
 * abaixo), então "cannot_verify" em Linux hoje só ocorre quando a consulta ao
 * `systemctl` em si falhou (ver `buildWatchdogLinuxCannotVerifyMessage`, que
 * carrega o motivo específico daquela consulta) — não mais "verificação via
 * systemd não implementada". O branch `"systemd"` é mantido aqui só por
 * retrocompatibilidade do tipo de entrada (`TaskSchedulerKind` continua tendo
 * 3 valores) e testado diretamente (`test/check-watchdog-armed.test.ts`), sem
 * mentir sobre o estado do #4798 (que agora cobre Windows E Linux).
 */
export function buildWatchdogCannotVerifyMessage(schedulerKind: TaskSchedulerKind): string {
  const platformNote =
    schedulerKind === "systemd"
      ? "esta máquina roda systemd, não o Task Scheduler do Windows"
      : "não foi possível detectar um agendador de tarefas suportado nesta máquina";
  const capabilityNote =
    schedulerKind === "systemd"
      ? "esta checagem (`check-watchdog-armed.ts`) sabe consultar tanto o Task Scheduler " +
        "do Windows (`schtasks`) quanto o systemd (`systemctl`, #4857)"
      : "esta checagem (`check-watchdog-armed.ts`) só sabe consultar o Task Scheduler do " +
        "Windows (`schtasks`) e o systemd (`systemctl`, #4857) — nenhum dos dois foi detectado aqui";
  const followUp =
    schedulerKind === "systemd"
      ? "Verificação via systemd é suportada desde o #4857 (parte da épica #4798) — " +
        "esta mensagem genérica só aparece se a consulta específica ao systemctl falhar " +
        "por um motivo não coberto pelo branch dedicado."
      : "Sem agendador de tarefas reconhecido — sem instrução de arme aplicável.";
  return (
    `Watchdog overnight (#2688) NÃO PÔDE SER VERIFICADO nesta máquina — ${platformNote}, ` +
    `e ${capabilityNote}. Isto é diferente de "não armado": o watchdog pode estar ` +
    `corretamente armado, só não dá pra confirmar a partir desta máquina (#4800). ${followUp}`
  );
}

// ---------------------------------------------------------------------------
// I/O: consulta real ao Task Scheduler (impuro — não coberto por teste)
// ---------------------------------------------------------------------------

/**
 * Consulta o Task Scheduler via **exit code** (#2814, locale-agnóstico).
 *
 * `schtasks /query /tn "<task>"` sempre sai com exit code `0` quando a task
 * existe e `!= 0` quando não existe (tipicamente `1`) — esse contrato de
 * exit code não é afetado pelo idioma do Windows, ao contrário das strings
 * impressas em stdout/stderr (que a versão anterior deste módulo parseava
 * via `isWatchdogTaskScheduled`, e que quebravam em locales não-EN — ex.
 * PT-BR "Nome da Tarefa:" em vez de "TaskName:", causando falso-negativo
 * permanente mesmo com a task presente e Ready). Este é o caminho usado por
 * `checkWatchdogArmed` para a detecção real.
 *
 * Retorna:
 *   - `0`      → task existe (armada)
 *   - `número` → task não existe, ou outro erro (ex: permissão negada) —
 *                tratado como "não armada" de forma fail-soft; qualquer
 *                exit code não-zero é conservador o suficiente (preferimos
 *                warning espúrio a falso-positivo de "armada").
 *   - `null`   → comando `schtasks` indisponível (ENOENT — plataforma
 *                não-Windows); distinto apenas para diagnóstico, resulta em
 *                `armed = false` do mesmo jeito.
 *
 * `exec` é injetável (default = `execFileSync` real) especificamente para
 * permitir testar este caminho com um mock em `test/check-watchdog-armed.test.ts`
 * sem chamar `schtasks` de verdade nem depender de module-mocking experimental
 * do Node (`node:test`'s `mock.module` requer `--experimental-test-module-mocks`,
 * flag que não está no `npm test` deste repo).
 *
 * `taskName` (#4799, default `WATCHDOG_TASK_NAME`) — 2º parâmetro opcional
 * que generaliza a consulta pra QUALQUER task do Task Scheduler, não só o
 * watchdog. Todo call site pré-#4799 continua passando só `exec` e recebe o
 * comportamento idêntico de antes.
 */
export function queryWatchdogTaskExitCode(
  exec: typeof execFileSync = execFileSync,
  taskName: string = WATCHDOG_TASK_NAME,
): number | null {
  try {
    exec("schtasks", ["/query", "/tn", taskName], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (e: unknown) {
    const err = e as { status?: number | null; code?: string };
    if (err.code === "ENOENT") return null;
    return typeof err.status === "number" ? err.status : 1;
  }
}

// ---------------------------------------------------------------------------
// Health parsing (#2944) — "armado" ≠ "de fato protegendo"
// ---------------------------------------------------------------------------

/**
 * Incidente 260703 (#2944): o coordenador ficou ~10h parado com o watchdog
 * (task "Diaria-Overnight-Watchdog") REGISTRADA no Task Scheduler desta
 * máquina — `checkWatchdogArmed` reportava `armed: true` só pela presença
 * da task (via `queryWatchdogTaskExitCode`, #2814). Presença ≠ proteção
 * real: a task pode estar presente e mesmo assim inútil se (a) foi
 * desabilitada, (b) a última execução falhou (script quebrado), ou (c)
 * nunca chegou a rodar (trigger mal configurado). Este bloco adiciona a
 * checagem de **saúde** da task — não só a checagem de presença — parseando
 * os campos `Scheduled Task State`, `Last Result` e `Last Run Time` do
 * output verbose (`schtasks /query /tn "..." /v /fo LIST`).
 *
 * Nota de locale (#2814 já documentou o mesmo risco para o parser textual
 * legado `isWatchdogTaskScheduled`): os rótulos destes campos também podem
 * vir traduzidos em Windows não-EN. Diferente da detecção de presença (que
 * usa exit code, 100% locale-agnóstico), aqui não há alternativa
 * locale-agnóstica — `schtasks` não expõe esses detalhes via exit code.
 * Fail-soft deliberado: se um campo não for reconhecido (rótulo localizado
 * não bate o regex EN), ele fica `null`/indeterminado e `classifyWatchdogTaskHealth`
 * NÃO rebaixa o status para um dos casos ruins — evita reintroduzir o
 * mesmo bug do #2814 (falso-negativo permanente por locale). O trade-off
 * consciente: em Windows não-EN, a checagem de saúde pode não detectar uma
 * task desabilitada/quebrada (mesmo comportamento pré-#2944, sem regressão);
 * em Windows EN (caso desta máquina, confirmado na investigação do #2944:
 * output real com "Scheduled Task State", "Last Result", "Last Run Time"
 * em inglês), a checagem de saúde funciona plenamente.
 */
export interface WatchdogTaskState {
  /** `true`/`false` se `Scheduled Task State:` foi reconhecido; `null` se ausente/não reconhecido. */
  enabled: boolean | null;
  /** Valor numérico de `Last Result:`; `null` se ausente/não numérico. */
  lastResult: number | null;
  /** Valor bruto de `Last Run Time:` como impresso pelo `schtasks`; `null` se ausente. */
  lastRunTime: string | null;
  /** `true` se `Last Run Time:` indicar que a task nunca rodou (vazio ou "N/A"). */
  neverRun: boolean;
}

/**
 * Parser puro do output verbose de
 * `schtasks /query /tn "Diaria-Overnight-Watchdog" /v /fo LIST`. Nunca
 * chama `schtasks` — só strings fixture (mesmo padrão de
 * `isWatchdogTaskScheduled`). Case-insensitive nos rótulos dos campos.
 */
export function parseWatchdogTaskState(schtasksOutput: string): WatchdogTaskState {
  const lines = (schtasksOutput ?? "").split(/\r?\n/);
  let enabled: boolean | null = null;
  let lastResult: number | null = null;
  let lastRunTime: string | null = null;
  let neverRun = false;

  for (const line of lines) {
    const stateM = line.match(/^\s*Scheduled Task State:\s*(.+?)\s*$/i);
    if (stateM) {
      const v = stateM[1].trim().toLowerCase();
      if (v === "enabled") enabled = true;
      else if (v === "disabled") enabled = false;
      continue;
    }
    const resultM = line.match(/^\s*Last Result:\s*(.+?)\s*$/i);
    if (resultM) {
      const v = resultM[1].trim();
      const n = Number(v);
      lastResult = v !== "" && Number.isFinite(n) ? n : null;
      continue;
    }
    const runM = line.match(/^\s*Last Run Time:\s*(.+?)\s*$/i);
    if (runM) {
      const v = runM[1].trim();
      lastRunTime = v === "" ? null : v;
      if (v === "" || /^n\/a$/i.test(v)) neverRun = true;
      continue;
    }
  }

  return { enabled, lastResult, lastRunTime, neverRun };
}

/** Diagnóstico de saúde derivado de `WatchdogTaskState` — `"unknown"` quando nenhum campo relevante foi reconhecido (fail-soft, ver docstring acima). */
export type WatchdogTaskHealth = "healthy" | "disabled" | "last_run_failed" | "never_run" | "unknown";

export function classifyWatchdogTaskHealth(state: WatchdogTaskState): WatchdogTaskHealth {
  if (state.enabled === false) return "disabled";
  if (state.neverRun) return "never_run";
  // Finding do review consolidado (260704): 267009 (0x41301 SCHED_S_TASK_RUNNING,
  // "rodando agora") e 267011 (0x41303, "ainda não rodou") são sentinelas de
  // sucesso/info do Task Scheduler, NÃO falha. Sem excluí-los, um health-check que
  // corre DURANTE a própria execução de ~10min do watchdog lê Last Result=267009 e
  // reporta falso "armed_but_stale" (watchdog quebrado) numa task saudável. (267014
  // = 0x41306 TERMINATED continua sendo falha real — foi o valor do stall de 260703.)
  if (
    state.lastResult !== null &&
    state.lastResult !== 0 &&
    state.lastResult !== 267009 &&
    state.lastResult !== 267011
  ) {
    return "last_run_failed";
  }
  if (state.enabled === null && state.lastResult === null && state.lastRunTime === null) {
    return "unknown";
  }
  return "healthy";
}

/**
 * Status rico (#2944) — distingue "presente e efetivamente protegendo" de
 * "presente mas inútil" das três formas descobertas na investigação do
 * incidente 260703. `"armed"` cobre tanto `"healthy"` quanto `"unknown"`
 * (fail-soft — nunca rebaixar por falta de dado, só por evidência positiva
 * de problema).
 *
 * `"cannot_verify"` (#4800) é um estado TERCEIRO, distinto de `"not_armed"`:
 * significa "esta máquina não roda o Task Scheduler do Windows (ou o
 * binário `schtasks` não foi encontrado), então esta checagem não sabe
 * responder" — nunca "confirmei que a task não existe". `not_armed` continua
 * reservado para quando a consulta REALMENTE rodou (via `schtasks`, em
 * Windows) e a task não apareceu.
 */
export type WatchdogArmedStatus =
  | "armed"
  | "armed_but_disabled"
  | "armed_but_stale"
  | "armed_but_never_run"
  | "not_armed"
  | "cannot_verify";

export function decideWatchdogArmedStatus(
  taskPresent: boolean,
  health: WatchdogTaskHealth,
): WatchdogArmedStatus {
  if (!taskPresent) return "not_armed";
  switch (health) {
    case "disabled":
      return "armed_but_disabled";
    case "last_run_failed":
      return "armed_but_stale";
    case "never_run":
      return "armed_but_never_run";
    default:
      return "armed"; // "healthy" ou "unknown"
  }
}

/** Constrói a mensagem específica de cada `WatchdogArmedStatus` != "armed"/"not_armed" (que têm suas próprias mensagens já existentes). */
export function buildWatchdogHealthWarningMessage(
  armedStatus: WatchdogArmedStatus,
  state: WatchdogTaskState,
): string {
  switch (armedStatus) {
    case "armed_but_disabled":
      return (
        `Watchdog overnight (#2688) task "${WATCHDOG_TASK_NAME}" está PRESENTE mas ` +
        `DESABILITADA no Task Scheduler — falsa confiança exatamente como o incidente ` +
        `#2944 (260703): task registrada não protege se estiver desabilitada. ` +
        `Reative com: schtasks /change /tn "${WATCHDOG_TASK_NAME}" /enable`
      );
    case "armed_but_stale":
      return (
        `Watchdog overnight (#2688) task "${WATCHDOG_TASK_NAME}" está presente e habilitada, ` +
        `mas a ÚLTIMA EXECUÇÃO FALHOU (Last Result: ${state.lastResult}, Last Run Time: ` +
        `${state.lastRunTime ?? "desconhecido"}) — o script pode estar quebrado. Verifique ` +
        `manualmente (ex: rode "npx tsx scripts/overnight-watchdog.ts --dry-run") antes de confiar nesta camada.`
      );
    case "armed_but_never_run":
      return (
        `Watchdog overnight (#2688) task "${WATCHDOG_TASK_NAME}" está presente e habilitada, ` +
        `mas NUNCA rodou (Last Run Time: N/A) — verifique o trigger/agendamento no Task ` +
        `Scheduler ou se o horário atual está fora da janela agendada.`
      );
    default:
      return buildWatchdogWarningMessage();
  }
}

/**
 * Consulta o Task Scheduler pelo output **verbose** (`/v /fo LIST`) — usado
 * só para extrair saúde (enabled/last-run/last-result) depois que a
 * presença já foi confirmada via `queryWatchdogTaskExitCode`. Retorna
 * `null` em qualquer falha (schtasks indisponível, erro de execução) —
 * fail-soft: ausência de detalhe de saúde nunca derruba `armed` para
 * `not_armed`, só impede a checagem mais fina (ver `classifyWatchdogTaskHealth`).
 * `exec` injetável pelo mesmo motivo de `queryWatchdogTaskExitCode`.
 *
 * `taskName` (#4799, default `WATCHDOG_TASK_NAME`) — mesma generalização de
 * `queryWatchdogTaskExitCode` acima.
 */
export function queryWatchdogTaskVerboseOutput(
  exec: typeof execFileSync = execFileSync,
  taskName: string = WATCHDOG_TASK_NAME,
): string | null {
  try {
    const out = exec(
      "schtasks",
      ["/query", "/tn", taskName, "/v", "/fo", "LIST"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ) as unknown as string | Buffer;
    return typeof out === "string" ? out : out.toString("utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// I/O: consulta real ao systemd, Linux (#4857 — equivalente do bloco schtasks acima)
// ---------------------------------------------------------------------------

/**
 * Estado "armada?" via `systemctl --user is-enabled` — deliberadamente mais
 * raso que `WatchdogArmedStatus` (o enum rico do bloco schtasks acima, que
 * distingue `armed_but_stale`/`armed_but_never_run` a partir de `Last
 * Result`/`Last Run Time`). `systemctl is-enabled` não expõe essa
 * granularidade (isso viveria em `systemctl --user status`/`journalctl`,
 * fora de escopo desta issue — ver #4857 item 4, gap documentado
 * explicitamente em vez de fingido coberto). `"disabled"` cobre o único caso
 * de "presente mas inútil" que dá pra detectar por este caminho — o mesmo
 * caso central do incidente #2944 (falsa confiança de task registrada e
 * desabilitada).
 */
export type LinuxWatchdogArmedState = "armed" | "disabled" | "not_armed" | "cannot_verify";

export interface LinuxWatchdogArmedResult {
  state: LinuxWatchdogArmedState;
  /** Detalhe textual do motivo de `cannot_verify` — `null` nos demais estados
   * (autoexplicativos). Nunca contém segredo (só nomes de comando/unit). */
  note: string | null;
}

/**
 * Consulta `systemctl --user is-enabled <unit>.timer` — equivalente Linux de
 * `queryWatchdogTaskExitCode`/`queryWatchdogTaskVerboseOutput` acima,
 * generalizado por `taskName` pelo MESMO motivo do #4799 (permitir reuso por
 * qualquer consumidor que precise do arme-status de uma task systemd por
 * nome, não só o watchdog — `unitBaseName` é a mesma tradução nome→unit que
 * `scripts/lib/systemd-units.ts` usa pra gerar os units de verdade).
 *
 * `exec` injetável (default = `execFileSync` real) pelo mesmo motivo de
 * `queryWatchdogTaskExitCode` — testar sem spawnar `systemctl` de verdade
 * (ver `test/check-watchdog-armed.test.ts`).
 *
 * Fail-soft: qualquer erro que não seja "unit ausente"/"disabled" reconhecido
 * vira `cannot_verify` com o `note` carregando o motivo — nunca inventa
 * `"armed"` nem `"not_armed"` a partir de um erro que este módulo não
 * reconhece com certeza suficiente (mesma disciplina do #2944/#4800).
 */
export function queryLinuxTimerArmed(
  taskName: string = WATCHDOG_TASK_NAME,
  exec: typeof execFileSync = execFileSync,
): LinuxWatchdogArmedResult {
  const unit = `${unitBaseName(taskName)}.timer`;
  try {
    const out = exec("systemctl", ["--user", "is-enabled", unit], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    const value = String(out ?? "").trim();
    if (value === "disabled") return { state: "disabled", note: null };
    if (value === "" || value === "not-found") return { state: "not_armed", note: null };
    // "enabled", "enabled-runtime", "static", "alias", etc. — qualquer valor
    // que não seja explicitamente "disabled"/ausente é tratado como armado
    // (fail-soft: preferimos um "armed" espúrio a um "not_armed" espúrio pra
    // um valor de saída do systemctl que este módulo não previu).
    return { state: "armed", note: null };
  } catch (e: unknown) {
    const err = e as { status?: number | null; code?: string; stdout?: string; stderr?: string };
    if (err.code === "ENOENT") {
      return { state: "cannot_verify", note: "systemctl indisponível (ENOENT) nesta consulta." };
    }
    // Achado AO VIVO nesta unidade (#4857, validado contra `systemctl` real
    // — não só fixture): `systemctl --user is-enabled <unit ausente>` sai
    // com exit code != 0 (4, nesta máquina) E stdout "not-found\n" — ou
    // seja, o caso "não armada" É reportado por EXCEÇÃO, não pelo caminho de
    // sucesso acima (que só vê stdout limpo quando o exit code É 0). Sem
    // este branch, uma unit genuinamente ausente caía no "erro não
    // reconhecido" abaixo e virava `cannot_verify` — um falso "não deu pra
    // verificar" pro caso mais comum e mais importante deste código (a
    // pergunta que #4857 existe pra responder: "a unit está aí ou não?").
    const stdoutTrim = String(err.stdout ?? "").trim();
    if (stdoutTrim === "disabled") {
      return { state: "disabled", note: null };
    }
    // Só o literal "not-found" é tratado como ausência confirmada — stdout
    // VAZIO na exceção NÃO é o mesmo sinal (ao contrário do caminho de
    // sucesso acima, onde stdout vazio com exit 0 É "not_armed"): um erro
    // que falhou ANTES de imprimir nada (bus indisponível, permissão negada)
    // também tem stdout vazio, e tratar isso como "ausente" inventaria uma
    // resposta que este módulo não tem certeza suficiente pra dar.
    if (stdoutTrim === "not-found") {
      return { state: "not_armed", note: null };
    }
    const stderrText = String(err.stderr ?? "");
    if (/failed to connect to bus/i.test(stderrText)) {
      return {
        state: "cannot_verify",
        note: "sessão systemd --user indisponível neste processo (sem bus de sessão) — não é a mesma coisa que 'não armada'.",
      };
    }
    // Erro genuinamente não reconhecido (ex: permissão, unit malformada) —
    // honesto é reportar cannot_verify com o stderr (truncado) no note, não
    // inferir "não armada" a partir de um erro que este módulo não entende
    // com certeza suficiente (mesma disciplina do achado #4833 do lado
    // gêmeo deste código, scheduled-task-status.ts).
    return {
      state: "cannot_verify",
      note: `systemctl retornou erro inesperado ao consultar '${unit}' — não foi possível confirmar se está armada (stderr: ${stderrText.trim().slice(0, 200) || "vazio"}).`,
    };
  }
}

/** Nome do unit `.timer` do watchdog nesta máquina — usado nas mensagens
 * abaixo e por quem quiser o nome exato pra rodar `systemctl` na mão. */
export function watchdogTimerUnitName(): string {
  return `${unitBaseName(WATCHDOG_TASK_NAME)}.timer`;
}

/** Mensagem para `armedStatus: "not_armed"` no caminho systemd (#4857) —
 * equivalente Linux de `buildWatchdogWarningMessage` (que é Windows-específica,
 * cita o `.ps1`). Aponta pro gerador de units + os 2 comandos de arme. */
export function buildWatchdogLinuxNotArmedMessage(): string {
  const unit = watchdogTimerUnitName();
  return (
    `Watchdog overnight (#2688) NÃO está armado no systemd desta máquina (unit "${unit}" ` +
    `ausente/não encontrada). Sem ele, um stall silencioso total (nenhum evento chega ao ` +
    `coordenador) só é descoberto manualmente — foi a causa raiz #1 do incidente #2768. ` +
    `Gere os units com: npx tsx scripts/overnight/setup-watchdog-schedule-systemd.ts ` +
    `(escreve em .systemd-units/), depois copie pra ~/.config/systemd/user/ e rode: ` +
    `systemctl --user daemon-reload && systemctl --user enable --now ${unit} (#4857).`
  );
}

/** Mensagem para `armedStatus: "armed_but_disabled"` no caminho systemd
 * (#4857) — equivalente Linux de `buildWatchdogHealthWarningMessage`'s caso
 * `armed_but_disabled` (que usa `schtasks /change /enable`, Windows-específico). */
export function buildWatchdogLinuxDisabledMessage(): string {
  const unit = watchdogTimerUnitName();
  return (
    `Watchdog overnight (#2688) unit "${unit}" está PRESENTE mas DESABILITADA no systemd ` +
    `desta máquina — falsa confiança da MESMA classe do incidente #2944 (task registrada não ` +
    `protege se estiver desabilitada). Reative com: systemctl --user enable --now ${unit}`
  );
}

/** Mensagem para `armedStatus: "cannot_verify"` no caminho systemd (#4857) —
 * quando a PRÓPRIA consulta `systemctl --user is-enabled` falhou por um
 * motivo que `queryLinuxTimerArmed` não conseguiu classificar como
 * armada/desabilitada/ausente. Diferente de `buildWatchdogCannotVerifyMessage`
 * (que cobre "esta máquina não tem NENHUM agendador reconhecido") — aqui o
 * agendador FOI reconhecido (é systemd), só a consulta específica falhou. */
export function buildWatchdogLinuxCannotVerifyMessage(note: string | null): string {
  const detail = note ? ` (${note})` : "";
  return (
    `Watchdog overnight (#2688) NÃO PÔDE SER VERIFICADO via systemd nesta consulta${detail} — ` +
    `isto é diferente de "não armado": o watchdog pode estar corretamente armado, só não deu ` +
    `pra confirmar agora. Tente novamente ou verifique manualmente: ` +
    `systemctl --user list-timers ${watchdogTimerUnitName()} (#4857).`
  );
}

/**
 * `eventMessage` distingue, no run-log, "confirmei que não está armado"
 * (`"watchdog_not_armed"`, o default histórico) de "não deu pra verificar
 * nesta máquina" (`"watchdog_cannot_verify"`, #4800) — mesma distinção que
 * `armedStatus`/`buildWatchdogCannotVerifyMessage` fazem no texto da
 * mensagem; sem isso o run-log ficaria mentindo por rótulo mesmo com a
 * mensagem em si já corrigida.
 */
function emitWarnEvent(message: string, eventMessage: string = "watchdog_not_armed"): void {
  const ROOT = resolve(process.cwd());
  const logScript = resolve(ROOT, "scripts", "log-event.ts");
  if (!existsSync(logScript)) return;
  try {
    execFileSync(
      "npx",
      [
        "tsx",
        logScript,
        "--agent",
        "overnight",
        "--level",
        "warn",
        "--message",
        eventMessage,
        "--details",
        JSON.stringify({ task_name: WATCHDOG_TASK_NAME, message }),
      ],
      { cwd: ROOT, stdio: "pipe" },
    );
  } catch {
    // Fail-soft: log-event indisponível nunca bloqueia o check.
  }
}

// ---------------------------------------------------------------------------
// Orquestração (impura — chama exec-mode + schtasks + log-event)
// ---------------------------------------------------------------------------

export interface CheckWatchdogArmedResult {
  mode: ExecMode;
  armed: boolean;
  action: WatchdogArmingAction;
  message: string;
  /**
   * Status rico (#2944) — além de `armed`/`action` (mantidos por
   * compatibilidade), distingue os 3 modos de "falsa confiança" descobertos
   * no incidente 260703 de uma task de fato saudável. Ver `WatchdogArmedStatus`.
   */
  armedStatus: WatchdogArmedStatus;
  /** Detalhe parseado do output verbose; `null` quando a task não está presente ou o output verbose não pôde ser obtido. */
  taskState: WatchdogTaskState | null;
}

/**
 * Checagem completa: detecta modo de execução, consulta o Task Scheduler
 * (só em modo local), decide a ação e — quando `not_armed_warn` — loga
 * warning no run-log. Nunca lança; fail-soft por design (análogo a
 * `drive-sync.ts`, #738) — este check nunca deve bloquear a Fase 0.
 *
 * #2944: presença da task (`queryWatchdogTaskExitCode`) não é mais
 * suficiente para reportar `armed: true` — a task pode estar desabilitada,
 * ter falhado na última execução, ou nunca ter rodado (os 3 casos
 * investigados no incidente 260703, ver `WatchdogArmedStatus`). Só quando
 * `armedStatus === "armed"` (presente + saudável, ou presença confirmada
 * sem dado de saúde disponível — fail-soft) é que `action` reporta
 * `"armed"`; qualquer um dos 3 casos de falsa-confiança faz `action` cair
 * para `"not_armed_warn"` (mesmo tratamento fail-soft de "não confiar
 * nesta camada" que uma task ausente já recebia).
 *
 * #4800: ANTES de tudo isso, se `detectTaskScheduler()` não reconhecer
 * `'windows-task-scheduler'` nesta máquina (ex: Linux, mesmo com
 * `mode === "local"`), a função retorna cedo com `armedStatus:
 * "cannot_verify"` / `action: "cannot_verify_warn"` — nem chega a tentar
 * `schtasks`. Este é o terceiro estado explícito: "não sei verificar" é
 * diferente de "verifiquei e não está armado".
 *
 * `opts` (#4800) são injeções OPCIONAIS de `detectExecMode`/
 * `detectTaskScheduler`/`emitWarnEvent`, no mesmo espírito do parâmetro
 * `exec` já usado por `queryWatchdogTaskExitCode`/`queryWatchdogTaskVerboseOutput`
 * — permitem testar o roteamento completo (`checkWatchdogArmed({...})`) sem
 * chamar `schtasks`/PowerShell real nem spawnar `npx tsx log-event.ts` de
 * verdade em teste (ver `test/check-watchdog-armed.test.ts`). Em runtime,
 * omitir — usa as funções reais.
 *
 * `queryLinuxTimerArmedFn` (#4857) segue o MESMO espírito, mas — diferente
 * do caminho Windows (que optou por NUNCA injetar `queryWatchdogTaskExitCode`/
 * `queryWatchdogTaskVerboseOutput` dentro de `checkWatchdogArmed`, testando-as
 * só isoladamente — ver nota em `test/check-watchdog-armed.test.ts`) — este
 * parâmetro EXISTE desde o início porque a issue #4857 pede explicitamente
 * cobertura de teste do ROTEAMENTO "timer armado/não-armado/desabilitado"
 * (#633), não só da função de consulta isolada.
 */
export interface CheckWatchdogArmedOptions {
  execModeFn?: () => ExecMode;
  taskSchedulerFn?: () => TaskSchedulerKind;
  emitWarn?: (message: string, eventMessage?: string) => void;
  queryLinuxTimerArmedFn?: (taskName?: string) => LinuxWatchdogArmedResult;
}

/**
 * Roteamento systemd de `checkWatchdogArmed` (#4857) — extraído como função
 * própria só por legibilidade (o corpo de `checkWatchdogArmed` já tinha 2
 * caminhos grandes — Windows e "sem agendador reconhecido" — antes deste
 * 3º). Espelha a estrutura de decisão do bloco Windows (armed / disabled ~
 * armed_but_disabled / ausente ~ not_armed / consulta falhou ~
 * cannot_verify), mas com granularidade menor — `queryLinuxTimerArmed` não
 * distingue `armed_but_stale`/`armed_but_never_run` (ver docstring de
 * `LinuxWatchdogArmedResult`, gap documentado, não escondido).
 */
function checkWatchdogArmedSystemd(
  mode: ExecMode,
  queryLinuxTimerArmedFn: (taskName?: string) => LinuxWatchdogArmedResult,
  emitWarn: (message: string, eventMessage?: string) => void,
): CheckWatchdogArmedResult {
  const result = queryLinuxTimerArmedFn(WATCHDOG_TASK_NAME);

  if (result.state === "armed") {
    return {
      mode,
      armed: true,
      action: "armed",
      message: `Watchdog armado (unit systemd "${watchdogTimerUnitName()}" habilitada).`,
      armedStatus: "armed",
      taskState: null,
    };
  }

  if (result.state === "disabled") {
    const message = buildWatchdogLinuxDisabledMessage();
    emitWarn(message);
    return { mode, armed: false, action: "not_armed_warn", message, armedStatus: "armed_but_disabled", taskState: null };
  }

  if (result.state === "not_armed") {
    const message = buildWatchdogLinuxNotArmedMessage();
    emitWarn(message);
    return { mode, armed: false, action: "not_armed_warn", message, armedStatus: "not_armed", taskState: null };
  }

  // "cannot_verify" — a consulta em si falhou por um motivo não classificado
  // como armada/desabilitada/ausente (ver queryLinuxTimerArmed).
  const message = buildWatchdogLinuxCannotVerifyMessage(result.note);
  emitWarn(message, "watchdog_cannot_verify");
  return { mode, armed: false, action: "cannot_verify_warn", message, armedStatus: "cannot_verify", taskState: null };
}

export function checkWatchdogArmed(opts: CheckWatchdogArmedOptions = {}): CheckWatchdogArmedResult {
  const {
    execModeFn = detectExecMode,
    taskSchedulerFn = detectTaskScheduler,
    emitWarn = emitWarnEvent,
    queryLinuxTimerArmedFn = queryLinuxTimerArmed,
  } = opts;
  const mode = execModeFn();

  if (mode === "cloud") {
    return {
      mode,
      armed: false,
      action: "skip_cloud",
      message: "Sessão cloud — Task Scheduler não se aplica (watchdog é recurso local).",
      armedStatus: "not_armed",
      taskState: null,
    };
  }

  // #4800: consultar o eixo do agendador ANTES de escolher `schtasks` — em
  // vez de assumir que `mode === "local"` implica Windows Task Scheduler.
  const schedulerKind = taskSchedulerFn();

  // #4857: branch systemd de verdade — antes disto, QUALQUER schedulerKind
  // != "windows-task-scheduler" (incluindo "systemd") caía direto no
  // cannot_verify genérico abaixo. Agora só "none" (nenhum agendador
  // reconhecido nesta máquina) cai nesse caminho.
  if (schedulerKind === "systemd") {
    return checkWatchdogArmedSystemd(mode, queryLinuxTimerArmedFn, emitWarn);
  }

  if (schedulerKind !== "windows-task-scheduler") {
    const message = buildWatchdogCannotVerifyMessage(schedulerKind);
    emitWarn(message, "watchdog_cannot_verify");
    return {
      mode,
      armed: false,
      action: "cannot_verify_warn",
      message,
      armedStatus: "cannot_verify",
      taskState: null,
    };
  }

  let taskPresent = false;
  try {
    taskPresent = queryWatchdogTaskExitCode() === 0;
  } catch {
    taskPresent = false;
  }

  let taskState: WatchdogTaskState | null = null;
  let armedStatus: WatchdogArmedStatus = "not_armed";

  if (taskPresent) {
    let verboseOutput: string | null = null;
    try {
      verboseOutput = queryWatchdogTaskVerboseOutput();
    } catch {
      verboseOutput = null;
    }
    if (verboseOutput) {
      taskState = parseWatchdogTaskState(verboseOutput);
      armedStatus = decideWatchdogArmedStatus(true, classifyWatchdogTaskHealth(taskState));
    } else {
      // Fail-soft (#738): presença confirmada, mas não foi possível obter o
      // detalhe de saúde (schtasks indisponível/erro no 2º comando) — nunca
      // rebaixar pra not_armed só por isso.
      armedStatus = "armed";
    }
  }

  const armed = armedStatus === "armed";
  const action = decideWatchdogArmingAction(mode, armed);

  if (action === "armed") {
    return {
      mode,
      armed: true,
      action,
      message: `Watchdog armado (task "${WATCHDOG_TASK_NAME}" presente no Task Scheduler).`,
      armedStatus,
      taskState,
    };
  }

  const message =
    taskPresent && taskState
      ? buildWatchdogHealthWarningMessage(armedStatus, taskState)
      : buildWatchdogWarningMessage();
  emitWarn(message);
  return { mode, armed: false, action, message, armedStatus, taskState };
}

// ---------------------------------------------------------------------------
// CLI guard: só executa como main module, importável sem efeito colateral.
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const result = checkWatchdogArmed();
  if (result.action === "not_armed_warn" || result.action === "cannot_verify_warn") {
    console.warn(`[watchdog-check] AVISO: ${result.message}`);
  } else {
    console.log(`[watchdog-check] ${result.message}`);
  }
}
