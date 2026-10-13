/**
 * scripts/run-continuo-ratelimit-watchdog.ts (#10070)
 *
 * Entrypoint da task `Diaria-Continuo-Ratelimit-Watchdog` (de hora em hora no
 * `300`): roda `hermes/scripts/pause-cron-on-ratelimit.py` fora do Hermes, pra
 * a RETOMADA do contínuo não depender do watch diário.
 *
 * Por que existe: desde o #10064 o watchdog Python pausa o job do contínuo
 * (`5d791ef6fc2c`) em `403 Key limit exceeded` e grava `resume_after` = 00:05
 * UTC do dia seguinte. Mas o único chamador era `watch-continuo-health.sh`
 * (job de watch do Hermes, uma vez por dia às 13:30) — os jobs dedicados do
 * watchdog sumiram do `jobs.json` do `300` e recriá-los é passo manual fora
 * do repo. Resultado: a cota voltava na virada UTC e o contínuo ficava
 * pausado até o watch do dia seguinte, ~13-16h de ticks perdidos por
 * incidente. Com este timer horário, a retomada acontece até ~1h depois de
 * `resume_after`.
 *
 * O registro (`scripts/lib/scheduled-tasks.ts`) só sabe invocar `.ts`, por
 * isso este wrapper. Ele:
 *   - prefixa `~/.local/bin` no PATH (é onde mora o `hermes` no `300`; o PATH
 *     de um unit systemd de usuário não o inclui, e sem isso todo
 *     `hermes cron pause|resume` cairia no FileNotFoundError do script);
 *   - repassa a saída do script pro log da task;
 *   - sai 1 quando o script falha ou imprime aviso de falha (linhas que
 *     começam com o emoji de alerta/sirene que o próprio script usa), pra o
 *     unit sair `failed` e `Diaria-Systemd-Failed-Units-Alarm` enxergar.
 *     Silêncio (o caso comum) e as mensagens de pausa/retomada saem 0;
 *   - enfileira as mensagens de pausa/retomada (#10074) em
 *     `~/.hermes/cron/.ratelimit-watchdog-notes.jsonl`, que o watch diário
 *     do Hermes drena e entrega no Telegram. Sem isso o aviso ficava só no
 *     log da task: quando o watch rodava, o job já estava pausado e o Python
 *     não imprimia mais nada.
 *
 * Não muda a lógica de pausa/retomada: é a mesma função que o watch chama.
 * Máquina sem `~/.hermes` → o script sai calado (exit 0).
 *
 * Uso: `npx tsx scripts/run-continuo-ratelimit-watchdog.ts`
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { logEvent } from "./lib/run-log.ts";
import { appendRatelimitNote, ratelimitNotesPath } from "./lib/continuo-ratelimit-notes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[continuo-ratelimit-watchdog]";

export const PAUSE_CRON_SCRIPT = join(ROOT, "hermes", "scripts", "pause-cron-on-ratelimit.py");

export type WatchdogOutputKind = "silent" | "info" | "failure";

/** Prefixos que o `pause-cron-on-ratelimit.py` usa nas mensagens de falha
 * (não conseguiu rodar `hermes`, não pausou/retomou, não gravou o marcador). */
const FAILURE_PREFIXES = ["⚠", "\u{1F6A8}"]; // alerta (com ou sem VS16), sirene

/** Classifica a saída do script: vazia = nada a fazer; linha começando com
 * alerta/sirene = falha; resto (pausado/retomado) = informativo. */
export function classifyWatchdogOutput(stdout: string): WatchdogOutputKind {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "silent";
  if (lines.some((l) => FAILURE_PREFIXES.some((p) => l.startsWith(p)))) return "failure";
  return "info";
}

/** Env do subprocesso com `{home}/.local/bin` na frente do PATH (sem duplicar). */
export function buildWatchdogEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const localBin = join(home, ".local", "bin");
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const path = parts.includes(localBin) ? parts : [localBin, ...parts];
  return { ...env, HOME: home, PATH: path.join(delimiter) };
}

export interface PythonRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Erro de spawn (ex: `python3` ausente). */
  error?: Error;
}

export interface SpawnPauseWatchdogOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  pythonBin?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

/** Roda o script Python de verdade. Timeout folgado: o script faz até 1
 * `hermes cron` com timeout próprio de 90s. */
export function spawnPauseWatchdog(opts: SpawnPauseWatchdogOptions = {}): PythonRunResult {
  const home = opts.home ?? homedir();
  const r = spawnSync(opts.pythonBin ?? "python3", [opts.scriptPath ?? PAUSE_CRON_SCRIPT], {
    env: buildWatchdogEnv(opts.env ?? process.env, home),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 150_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

export interface WatchdogRunDeps {
  runPython: () => PythonRunResult;
  log: (msg: string) => void;
  recordEvent: (level: "info" | "error", message: string) => void;
  /** #10074: enfileira o aviso de pausa/retomada pro watch diário entregar ao
   * editor. Devolve `null` em sucesso ou a mensagem de erro (nunca lança). */
  queueNote?: (message: string) => string | null;
}

/** Devolve o exit code da task (0 = ok/informativo, 1 = falha). */
export function runContinuoRatelimitWatchdog(deps: WatchdogRunDeps): number {
  const r = deps.runPython();
  if (r.error) {
    const msg = `não consegui rodar pause-cron-on-ratelimit.py: ${r.error.message}`;
    deps.log(`${LOG_PREFIX} ${msg}`);
    deps.recordEvent("error", msg);
    return 1;
  }
  const out = r.stdout.trim();
  if (out) deps.log(out);
  if (r.stderr.trim()) deps.log(`${LOG_PREFIX} stderr: ${r.stderr.trim()}`);
  if (r.status !== 0) {
    const msg = `pause-cron-on-ratelimit.py saiu ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
    deps.recordEvent("error", msg);
    return 1;
  }
  const kind = classifyWatchdogOutput(r.stdout);
  if (kind === "silent") return 0;
  deps.recordEvent(kind === "failure" ? "error" : "info", `pause-cron-on-ratelimit: ${out.slice(0, 500)}`);
  if (kind === "failure") return 1;
  if (deps.queueNote) {
    const err = deps.queueNote(out);
    if (err) {
      // O aviso não vai chegar ao editor pelo watch — falha visível (unit
      // `failed` → Diaria-Systemd-Failed-Units-Alarm), não silêncio.
      const msg = `não consegui enfileirar o aviso pro watch (#10074): ${err}`;
      deps.log(`${LOG_PREFIX} ${msg}`);
      deps.recordEvent("error", msg);
      return 1;
    }
  }
  return 0;
}

function main(): number {
  return runContinuoRatelimitWatchdog({
    runPython: () => spawnPauseWatchdog(),
    queueNote: (message) => appendRatelimitNote(ratelimitNotesPath(homedir()), message),
    log: (m) => console.log(m),
    recordEvent: (level, message) => {
      logEvent(
        { edition: null, stage: null, agent: "continuo-ratelimit-watchdog", level, message },
        ROOT,
      );
    },
  });
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(`${LOG_PREFIX} erro fatal:`, e) });
}
