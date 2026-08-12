/**
 * exec-mode.ts (#2643)
 *
 * Detecta o modo de execução da sessão: `'local'` (máquina do editor, com
 * todos os recursos locais disponíveis) ou `'cloud'` (container efêmero, clone
 * fresco sem junction `data/` nem ComfyUI nem credenciais locais).
 *
 * Sinal canônico: presença + resolução do junction `data/` como diretório
 * acessível. A junction aponta para
 * `~/OneDrive/Documentos/diaria-studio-data` e só existe localmente — num
 * clone fresco de cloud o path `data/` simplesmente não existe.
 *
 * Por que este sinal?
 * - É o pré-requisito explícito de TODA skill (`data/` é criado 1x por máquina
 *   antes de qualquer skill rodar — CLAUDE.md § Setup).
 * - É binário e determinístico: `statSync('data').isDirectory()` retorna true
 *   (local) ou lança (cloud). Não depende de env vars de runtime, que variam
 *   por provider e são mutable.
 * - Já é o bloqueio real: issues com label `local` tipicamente precisam de
 *   `data/`, ComfyUI, ou credenciais que também dependem de `data/`.
 *
 * O helper é testável com fs mockado (ver `test/exec-mode.test.ts`) —
 * injeta-se a função stat pelas params opcionais.
 *
 * Uso em runtime (skills/orchestrator):
 *   ```ts
 *   import { detectExecMode } from '../scripts/lib/exec-mode.ts';
 *   const mode = detectExecMode();
 *   // 'local' | 'cloud'
 *   ```
 *
 * Uso como CLI (para shell scripts / Fase 0 das skills):
 *   ```bash
 *   npx tsx scripts/lib/exec-mode.ts
 *   # → imprime "local" ou "cloud" em stdout (exit 0 sempre)
 *   ```
 *
 * @see .claude/skills/diaria-overnight/SKILL.md § Fase 0 passo 4
 * @see .claude/skills/diaria-develop/SKILL.md § Fase 0
 * @see CLAUDE.md § Label `local` — critério e comportamento das skills
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { isMainModule } from "./cli-args.ts";

export type ExecMode = "local" | "cloud";

/**
 * Opções de injeção para tornar a função testável sem depender do fs real.
 * Em runtime, omitir — usa `statSync` de `node:fs` e o cwd real.
 */
export interface ExecModeOptions {
  /** Substituto de `fs.statSync` para testes (mock). */
  statFn?: (path: string) => { isDirectory(): boolean };
  /** Diretório raiz do projeto (default: cwd). */
  projectRoot?: string;
}

/**
 * Detecta se a sessão é local (editor na máquina) ou cloud (container efêmero).
 *
 * Retorna `'local'` se o junction `data/` existe e resolve como diretório;
 * retorna `'cloud'` caso contrário (path inexistente, ENOENT, ou não-diretório).
 */
export function detectExecMode(opts: ExecModeOptions = {}): ExecMode {
  const { statFn = statSync, projectRoot = process.cwd() } = opts;
  const dataPath = join(projectRoot, "data");
  try {
    return statFn(dataPath).isDirectory() ? "local" : "cloud";
  } catch {
    // ENOENT (clone fresco), EACCES, junction quebrada → cloud
    return "cloud";
  }
}

// ---------------------------------------------------------------------------
// Eixo do agendador de tarefas (#4800)
// ---------------------------------------------------------------------------

/**
 * Qual agendador de tarefas do sistema operacional está disponível nesta
 * máquina. **Eixo separado de `ExecMode`** — não confundir os dois:
 *
 *   - `ExecMode` (`detectExecMode` acima) responde "tenho os recursos locais
 *     (junction `data/`, credenciais, ComfyUI)?" — sinal correto, usado por
 *     várias skills, **não alterado por este bloco**.
 *   - `TaskSchedulerKind` responde uma pergunta DIFERENTE: "qual agendador de
 *     sistema esta máquina roda?" — derivado da PLATAFORMA
 *     (`process.platform`) e da presença do binário correspondente no PATH,
 *     nunca de `data/`.
 *
 * A confusão dos dois eixos era a causa raiz do #4800: numa máquina Linux
 * com `data/` presente (OneDrive via symlink), `detectExecMode()` responde
 * `'local'` corretamente, mas `check-watchdog-armed.ts` inferia dali "então
 * é Windows" e tentava `schtasks`, que não existe lá — dando um falso
 * negativo ("watchdog não armado") quando a verdade era "não foi possível
 * verificar nesta plataforma". `pending-scheduled-tasks.ts` (`Get-ScheduledTask`,
 * módulo removido no #5115, junto com os `.ps1` que consumia)
 * **não** tinha esse bug de falso-negativo — seu fail-soft já distinguia
 * "consulta falhou" (`pending: null`) de "0 pendências" (`pending: []`, #738)
 * antes deste eixo existir. Ele não usa `detectTaskScheduler()` pelo mesmo
 * motivo que nunca precisou dele: ganho é só de paridade de MENSAGEM (dizer
 * "esta máquina roda systemd" em vez de um genérico "PowerShell
 * indisponível"), não correção de um bug de correção que não existia lá.
 */
export type TaskSchedulerKind = "windows-task-scheduler" | "systemd" | "none";

/** Opções de injeção para tornar `detectTaskScheduler` testável sem depender
 * da plataforma real nem de spawnar processos. Em runtime, omitir. */
export interface TaskSchedulerOptions {
  /** Substituto de `process.platform` para testes (mock). */
  platform?: NodeJS.Platform;
  /** Substituto da checagem "o comando `cmd` existe no PATH?" para testes (mock). */
  hasCommand?: (cmd: string) => boolean;
}

/** Argumento de sondagem "sem efeito colateral" por comando — só serve para
 * confirmar que o binário existe e responde; o exit code em si é ignorado
 * (só `ENOENT` importa, ver `commandExistsSync`). */
const COMMAND_PROBE_ARGS: Record<string, string[]> = {
  schtasks: ["/?"],
  systemctl: ["--version"],
};

/** Substituto injetável de `execFileSync` para testar `commandExistsSync`
 * sem spawnar processos reais. Em runtime, omitir (usa `execFileSync` real). */
export type ExecFileSyncFn = (cmd: string, args: string[], opts: { stdio: "ignore" }) => unknown;

/**
 * Checa se `cmd` existe no PATH tentando executá-lo com um argumento de
 * sondagem inofensivo. `ENOENT` (comando não encontrado) → `false`; qualquer
 * outro resultado (sucesso, ou erro de exit code != 0 por argumento
 * inesperado) → `true`, porque nesse caso o binário FOI encontrado e
 * executado — só a sondagem em si não necessariamente retornou 0.
 *
 * `execFn`/`warnFn` são injetáveis só para teste (ver `test/exec-mode.test.ts`
 * — cobre o branch não-ENOENT, #4811); em runtime, omitir ambos.
 */
export function commandExistsSync(
  cmd: string,
  execFn: ExecFileSyncFn = execFileSync as unknown as ExecFileSyncFn,
  warnFn: (message: string) => void = console.warn,
): boolean {
  try {
    execFn(cmd, COMMAND_PROBE_ARGS[cmd] ?? [], { stdio: "ignore" });
    return true;
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === "ENOENT") return false;
    // Encontrado no PATH mas a sondagem falhou por outro motivo (EACCES,
    // EPERM de política de execução restrita, binário corrompido, exit code
    // != 0 inesperado). Ainda conta como "comando existe" — só não deixar o
    // erro passar em silêncio, porque um probe assim pode mascarar um
    // agendador reportado incorretamente como disponível (ver #4800).
    warnFn(
      `[exec-mode] sondagem de '${cmd}' falhou por motivo não-ENOENT (${err.code ?? "desconhecido"}) — tratando como "comando existe" (encontrado, mas não invocável de forma limpa).`,
    );
    return true;
  }
}

/**
 * Detecta qual agendador de tarefas está disponível nesta máquina, derivado
 * da plataforma + presença do binário correspondente — nunca de `data/`.
 *
 * - `win32` + `schtasks` no PATH → `'windows-task-scheduler'`.
 * - `linux` + `systemctl` no PATH → `'systemd'`.
 * - Qualquer outra combinação (plataforma sem suporte, ou binário ausente
 *   mesmo na plataforma certa — ex: Windows Server Core sem `schtasks`
 *   habilitado) → `'none'`, tratado por quem consome como "não sei
 *   verificar", nunca como "não armado" (ver #4800).
 */
export function detectTaskScheduler(opts: TaskSchedulerOptions = {}): TaskSchedulerKind {
  const { platform = process.platform, hasCommand = commandExistsSync } = opts;
  if (platform === "win32") {
    return hasCommand("schtasks") ? "windows-task-scheduler" : "none";
  }
  if (platform === "linux") {
    return hasCommand("systemctl") ? "systemd" : "none";
  }
  return "none";
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  console.log(detectExecMode());
}
