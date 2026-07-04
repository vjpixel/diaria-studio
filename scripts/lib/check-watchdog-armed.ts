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
 * Este módulo dá ao Passo 1 da Fase 0 de `/diaria-overnight` (e de
 * `/diaria-develop`, que roda por natureza local) uma forma determinística
 * de checar se a task "Diaria-Overnight-Watchdog" está registrada no Task
 * Scheduler — em vez de assumir silenciosamente que está.
 *
 * Decisão de design (documentada aqui por instrução da issue #2768): quando
 * a task NÃO está armada em sessão local, este módulo **loga warning**
 * (run-log + stdout) em vez de disparar automaticamente
 * `scripts/overnight/setup-watchdog-schedule.ps1`. Motivo: o próprio script
 * de setup documenta explicitamente "NÃO EXECUTAR durante setup de
 * worktrees temporários" — o path do runner é derivado do diretório do
 * script, e uma execução automática dispararia sem esse contexto (a
 * checagem pode rodar de dentro de um worktree efêmero do coordenador ou de
 * um subagente). Registrar uma scheduled task é um side-effect de nível de
 * máquina (fora do repo, fora de qualquer `git revert`) — feature demais
 * pra um guard que deveria ser barato e sempre seguro de rodar. O padrão
 * "log warning explícito, nunca bloqueia" já é o mesmo aplicado a
 * `drive-sync.ts` e ao restante desta suíte (fail-soft).
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
 *   // result.action: "skip_cloud" | "armed" | "not_armed_warn" | "check_failed"
 *   ```
 *
 * @see scripts/overnight-watchdog.ts (#2688)
 * @see scripts/overnight/setup-watchdog-schedule.ps1
 * @see scripts/lib/exec-mode.ts (#2643)
 * @see .claude/skills/diaria-overnight/SKILL.md § Fase 0 passo 1, § Stall passivo
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { detectExecMode, type ExecMode } from "./exec-mode.ts";

/** Nome exato da scheduled task, conforme `setup-watchdog-schedule.ps1`. */
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

export type WatchdogArmingAction = "skip_cloud" | "armed" | "not_armed_warn";

/**
 * Pure: decide a ação dado o modo de execução e se a task está armada.
 * Em modo cloud, o watchdog (Task Scheduler local) não se aplica — nunca é
 * warning, é apenas fora de escopo.
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
    `causa raiz #1 do incidente #2768. Arme com (prefira pwsh se disponível — ` +
    `evita o encoding gotcha do #2814 em PowerShell 5.1): ` +
    `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\\overnight\\setup-watchdog-schedule.ps1 ` +
    `(ou "powershell" no lugar de "pwsh" se pwsh 7 não estiver instalado)`
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
 */
export function queryWatchdogTaskExitCode(
  exec: typeof execFileSync = execFileSync,
): number | null {
  try {
    exec("schtasks", ["/query", "/tn", WATCHDOG_TASK_NAME], {
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
  if (state.lastResult !== null && state.lastResult !== 0) return "last_run_failed";
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
 */
export type WatchdogArmedStatus =
  | "armed"
  | "armed_but_disabled"
  | "armed_but_stale"
  | "armed_but_never_run"
  | "not_armed";

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
        `mas NUNCA rodou (Last Run Time: N/A) — verifique o trigger/agendamento ` +
        `(scripts/overnight/setup-watchdog-schedule.ps1) ou se o horário atual está fora da janela agendada.`
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
 */
export function queryWatchdogTaskVerboseOutput(
  exec: typeof execFileSync = execFileSync,
): string | null {
  try {
    const out = exec(
      "schtasks",
      ["/query", "/tn", WATCHDOG_TASK_NAME, "/v", "/fo", "LIST"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ) as unknown as string | Buffer;
    return typeof out === "string" ? out : out.toString("utf-8");
  } catch {
    return null;
  }
}

function emitWarnEvent(message: string): void {
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
        "watchdog_not_armed",
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
 */
export function checkWatchdogArmed(): CheckWatchdogArmedResult {
  const mode = detectExecMode();

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
  emitWarnEvent(message);
  return { mode, armed: false, action, message, armedStatus, taskState };
}

// ---------------------------------------------------------------------------
// CLI guard: só executa como main module, importável sem efeito colateral.
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkWatchdogArmed();
  if (result.action === "not_armed_warn") {
    console.warn(`[watchdog-check] AVISO: ${result.message}`);
  } else {
    console.log(`[watchdog-check] ${result.message}`);
  }
}
