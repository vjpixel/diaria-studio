/**
 * check-watchdog-armed.ts (#2768)
 *
 * Incidente 260630/260701: um subagente ficou ~4h30 sem progresso real e o
 * coordenador aceitou 5 notificações "ainda esperando" sem nunca comparar o
 * tempo decorrido contra o threshold de 60 min do #2379. Causa raiz #1: o
 * watchdog externo (#2688, `scripts/overnight-watchdog.ts`) nunca foi armado
 * nesta máquina — `scripts/overnight/setup-watchdog-schedule.ps1` é setup
 * manual one-time por máquina e ninguém rodou.
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
    `causa raiz #1 do incidente #2768. Arme com: ` +
    `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\overnight\\setup-watchdog-schedule.ps1`
  );
}

// ---------------------------------------------------------------------------
// I/O: consulta real ao Task Scheduler (impuro — não coberto por teste)
// ---------------------------------------------------------------------------

/**
 * Consulta o Task Scheduler real via `schtasks`. Retorna o output combinado
 * (stdout + stderr) — a task ausente sai com exit code != 0, mas ainda
 * imprime a mensagem de erro que o parser precisa ver. `null` = comando
 * indisponível (plataforma não-Windows, `schtasks` não encontrado) —
 * distinto de "task ausente" apenas para logging; ambos resultam em
 * `armed = false` no diagnóstico.
 */
export function queryWatchdogTaskRaw(): string | null {
  try {
    return execFileSync(
      "schtasks",
      ["/query", "/tn", WATCHDOG_TASK_NAME, "/fo", "LIST"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: string };
    if (err.stdout || err.stderr) {
      return `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    // ENOENT (schtasks não existe — ex: não-Windows) ou erro sem output capturado.
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
}

/**
 * Checagem completa: detecta modo de execução, consulta o Task Scheduler
 * (só em modo local), decide a ação e — quando `not_armed_warn` — loga
 * warning no run-log. Nunca lança; fail-soft por design (análogo a
 * `drive-sync.ts`, #738) — este check nunca deve bloquear a Fase 0.
 */
export function checkWatchdogArmed(): CheckWatchdogArmedResult {
  const mode = detectExecMode();

  if (mode === "cloud") {
    return {
      mode,
      armed: false,
      action: "skip_cloud",
      message: "Sessão cloud — Task Scheduler não se aplica (watchdog é recurso local).",
    };
  }

  let armed = false;
  try {
    const raw = queryWatchdogTaskRaw();
    armed = raw !== null && isWatchdogTaskScheduled(raw);
  } catch {
    armed = false;
  }

  const action = decideWatchdogArmingAction(mode, armed);

  if (action === "armed") {
    return {
      mode,
      armed: true,
      action,
      message: `Watchdog armado (task "${WATCHDOG_TASK_NAME}" presente no Task Scheduler).`,
    };
  }

  const message = buildWatchdogWarningMessage();
  emitWarnEvent(message);
  return { mode, armed: false, action, message };
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
