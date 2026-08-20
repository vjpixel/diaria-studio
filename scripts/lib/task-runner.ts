/**
 * scripts/lib/task-runner.ts (#4805 Fase 2, épica #4798)
 *
 * Executor TS único das tasks declaradas em `scripts/lib/scheduled-tasks.ts`
 * — sucessor dos antigos wrappers `scripts/run-*.ps1` do Task Scheduler
 * (removidos no #5115, cutover final — nenhuma máquina Windows roda mais
 * tasks `Diaria-*`).
 *
 * Preserva os 5 comportamentos que os `.ps1` acumularam por incidente, um a
 * um:
 *
 *   1. **Guard de spawn "falso exit 0" (#4343).** Os wrappers `.ps1`
 *      pré-inicializavam `$LASTEXITCODE = $null` porque `npx` resolvido via
 *      PATH podia falhar a SPAWNAR sob o contexto de serviço do Task
 *      Scheduler (PATH não herdado corretamente), e sob `Set-StrictMode`
 *      isso silenciava pra exit 0 sem o guard. Este runner invoca cada passo
 *      via `process.execPath` (o path ABSOLUTO do binário Node atual) com
 *      `--import tsx`, nunca um `npx`/`node` bare resolvido via PATH — isso
 *      elimina ESTRUTURALMENTE a classe de falha que motivou o #4343
 *      originalmente. O guard genérico (`result.error` / `result.status ===
 *      null`) continua como defesa em profundidade contra qualquer OUTRA
 *      falha de spawn (cwd inválido, ulimit, etc.) — nunca retorna exit 0
 *      quando o processo do passo não chegou a rodar.
 *
 *   2. **Log fora de `data/`, anexado com retry 3× (#4047).** Cada passo
 *      escreve no log TEMPORÁRIO primeiro (fora de `data/`, via
 *      `os.tmpdir()`) — só no final o conteúdo acumulado é anexado ao log
 *      final dentro de `data/` (que no cliente Windows é um *directory
 *      junction* pro OneDrive, sujeito a lock intermitente), com retry
 *      curto (3×, backoff 300ms×tentativa). **Herdado do comportamento do
 *      cliente Windows — ainda NÃO medido se o mesmo lock transitório se
 *      aplica ao cliente Linux/rclone/onedriver do `data/` (ver
 *      CLAUDE.md #2b); o mecanismo é mantido por precaução até essa
 *      medição acontecer, não porque o Linux tenha o mesmo bug confirmado.**
 *
 *   3. **Exit code honesto.** Falha ao persistir o log final reprova a run
 *      (`code = 1`) mesmo que todo passo tenha ido bem — sem isso, o Task
 *      Scheduler/watchdog não teria como saber que nenhum log da run foi
 *      persistido.
 *
 *   4. **Sequenciamento multi-passo.** Passos rodam SEMPRE em sequência —
 *      nenhum passo cancela os seguintes, mesmo que falhe (mesmo
 *      comportamento de `run-clarice-sync-daily.ps1`: o passo 2
 *      `extract-opens-catchup-status.ts` lê o log acumulado do passo 1 ANTES
 *      do passo 3 `clarice-db-summary.ts` escrever mais linhas — por isso o
 *      token `"{tempLogPath}"` nos `args` de um step é substituído pelo path
 *      do log temporário **desta run**, não o log final histórico). O exit
 *      code final é o do primeiro passo NÃO best-effort que falhar (não um
 *      "1" genérico) — `run-seo-weekly.ps1` era o único wrapper SEM o guard
 *      #4343 entre os 14 originais; este runner fecha esse gap por
 *      construção, uniformemente, pra TODA task migrada.
 *
 *   5. **Guard de pré-condição (`Diaria-Brevo-Diaria-Evaluate`, achado do
 *      review #4552).** Quando `ScheduledTaskDefinition.guard` está
 *      presente, checado ANTES de qualquer passo — se o arquivo requerido
 *      não existe (ex: `data/brevo-diaria/contacts.json`, sinal de que o
 *      junction `data/` do OneDrive ainda não montou), a run aborta sem
 *      invocar nenhum script, loga um "AVISO: " com a mensagem do guard, e
 *      sai com exit 1 — evita que `--push` sobrescreva um store real com um
 *      resultado vazio.
 *
 * @see scripts/lib/scheduled-tasks.ts (registro declarativo consumido aqui)
 * @see scripts/run-task.ts (entrypoint CLI)
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ScheduledTaskDefinition } from "./scheduled-tasks.ts";
import { unitBaseName } from "./systemd-units.ts";

/** Resultado de rodar um único passo (`execStep`). */
export interface StepExecResult {
  code: number;
  /** stdout + stderr combinados, na ordem em que chegaram do processo. */
  output: string;
}

/** Assinatura injetável do executor de passo — default `execTsxStep`. Testes
 * injetam uma versão fake pra simular sucesso/falha/falha-de-spawn sem
 * credenciais reais, rede, ou o junction `data/`. */
export type ExecStepFn = (scriptAbsPath: string, args: string[], cwd: string) => StepExecResult;

/**
 * Roda `node --import tsx <script> <args...>` (mesmo padrão de invocação de
 * `scripts/lib/run-tsx.ts`, usado por outros scripts do repo pra spawnar
 * `.ts` a partir de `.ts`). `process.execPath` é um path ABSOLUTO — nunca
 * resolvido via PATH — ver ponto 1 da docstring do módulo pro porquê disso
 * eliminar a classe de falha do #4343 por construção.
 */
export function execTsxStep(scriptAbsPath: string, args: string[], cwd: string): StepExecResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptAbsPath, ...args], {
    cwd,
    encoding: "utf8",
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");

  // Guard genérico de spawn (defesa em profundidade — ver ponto 1 acima):
  // nunca deixar `code` indefinido/null virar um exit 0 implícito em quem lê
  // este resultado.
  if (result.error || result.status === null) {
    return {
      code: 1,
      output:
        output +
        `\nERRO: o passo nao executou (falha de spawn antes do processo iniciar): ` +
        `${result.error?.message ?? "status null"}\n`,
    };
  }
  return { code: result.status, output };
}

/** Resultado de um passo individual dentro de uma run. */
export interface StepRunResult {
  key: string;
  code: number;
  bestEffort: boolean;
}

export interface ScheduledTaskRunResult {
  /** Exit code final — 0 só quando todo passo não-best-effort saiu 0 E o log
   * final foi persistido com sucesso. */
  code: number;
  /** Resultado por passo, na ordem de execução. Vazio quando um guard
   * abortou a run antes de qualquer passo rodar. */
  steps: StepRunResult[];
  /** `true` quando um `guard` presente na definição abortou a run. */
  guardAborted: boolean;
  /** `true` quando o log final foi anexado com sucesso (após até 3
   * tentativas). */
  logAppendOk: boolean;
  /** Path absoluto do log final. */
  logPath: string;
  /** Path absoluto do log temporário (só permanece em disco quando o anexo
   * final falhou — apagado em caso de sucesso). */
  tempLogPath: string;
}

export interface RunScheduledTaskOptions {
  /** Raiz do repo — cwd de cada passo e base pra resolver `guard.requiredFile`
   * e o log final. Default: `process.cwd()`. */
  rootDir?: string;
  /** Injeção de relógio pro cabeçalho do log. Default: `() => new Date()`. */
  now?: () => Date;
  /** Override do path do log final (testes). Default:
   * `join(rootDir, "data", ...def.logPath.split("/"))`. */
  logPathOverride?: string;
  /** Override do path do log temporário (testes). Default: um path único
   * sob `os.tmpdir()`. */
  tempLogPathOverride?: string;
  /** Injeção do executor de passo (testes). Default: `execTsxStep`. */
  execStep?: ExecStepFn;
  /** Injeção de UMA tentativa de anexar o log final (testes) — lança pra
   * simular falha transitória (ex: lock do OneDrive) sem depender de
   * condição de corrida em cima do FS real. Default: `defaultAppendLog`
   * (`mkdirSync` + `appendFileSync` reais). O retry 3× (ponto 2 da docstring
   * do módulo) sempre chama esta função — sucesso na 1ª tentativa nunca
   * distingue "sempre funcionou" de "não precisou retry". */
  appendLog?: AppendLogFn;
}

/** Assinatura injetável de UMA tentativa de anexar `content` a `logPath` —
 * default `defaultAppendLog`. Lança em caso de falha (o chamador decide
 * retry). */
export type AppendLogFn = (logPath: string, content: string) => void;

function defaultAppendLog(logPath: string, content: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, content, "utf8");
}

/** Sleep síncrono — usado só pro backoff do retry de log (300ms×tentativa),
 * mesma cadência do `.ps1` original. `Atomics.wait` é o único jeito
 * padrão-Node de bloquear sincronamente sem child process/setTimeout
 * assíncrono (que exigiria tornar `runScheduledTask` async — mudança maior
 * de superfície não justificada pelo ganho). */
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Roda uma `ScheduledTaskDefinition` de ponta a ponta: guard opcional →
 * passos em sequência → log resiliente → exit code honesto. Nunca lança —
 * qualquer falha inesperada de um passo (exceção síncrona de `execStep`,
 * não só um exit code ≠ 0) é capturada e tratada como falha desse passo,
 * nunca propagada pra fora (a run inteira tem que terminar e reportar,
 * mesmo quando um passo individual quebra de um jeito imprevisto).
 */
export function runScheduledTask(
  def: ScheduledTaskDefinition,
  opts: RunScheduledTaskOptions = {},
): ScheduledTaskRunResult {
  const rootDir = resolve(opts.rootDir ?? process.cwd());
  const now = opts.now ?? (() => new Date());
  const execStep = opts.execStep ?? execTsxStep;
  const appendLog = opts.appendLog ?? defaultAppendLog;

  const logPath = opts.logPathOverride ?? join(rootDir, "data", ...def.logPath.split("/"));
  const tempLogPath =
    opts.tempLogPathOverride ?? join(tmpdir(), `diaria-${unitBaseName(def.name)}-${process.pid}-${Date.now()}.log`);

  const appendTemp = (text: string): void => {
    appendFileSync(tempLogPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  };

  // #5639 — task desabilitada via `enabled: false` no registro.
  if (def.enabled === false) {
    appendTemp(`===== ${now().toISOString()} - ${def.description} =====`);
    appendTemp("SKIP: task disabled (enabled: false)");
    appendTemp("===== fim (skip:disabled) =====");
    // Anexa o log temporário ao final (mesmo fluxo de sucesso)
    let logAppendOk = false;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const tempContent = readFileSync(tempLogPath, "utf8");
        appendLog(logPath, tempContent);
        logAppendOk = true;
        break;
      } catch (e) {
        lastError = e;
        if (attempt < 3) sleepSync(300 * attempt);
      }
    }
    if (logAppendOk) {
      try { rmSync(tempLogPath, { force: true }); } catch {}
    }
    return { code: 0, steps: [], guardAborted: false, logAppendOk, logPath, tempLogPath: logAppendOk ? "" : tempLogPath };
  }

  appendTemp("");
  appendTemp(`===== ${now().toISOString()} - ${def.description} =====`);

  const steps: StepRunResult[] = [];
  let guardAborted = false;
  let failingCode = 0;

  if (def.guard) {
    // `requiredFile` é implicitamente `data/`-relative — MESMA convenção de
    // `def.logPath` logo acima (ver docstring de `ScheduledTaskGuard`).
    const guardPath = join(rootDir, "data", ...def.guard.requiredFile.split("/"));
    if (!existsSync(guardPath)) {
      appendTemp(`AVISO: ${def.guard.abortMessage}`);
      guardAborted = true;
      failingCode = 1;
    }
  }

  if (!guardAborted) {
    for (const step of def.steps) {
      appendTemp(`----- ${step.key} -----`);
      const args = (step.args ?? []).map((a) => (a === "{tempLogPath}" ? tempLogPath : a));
      const scriptAbs = join(rootDir, ...step.script.split("/"));

      let result: StepExecResult;
      try {
        result = execStep(scriptAbs, args, rootDir);
      } catch (e) {
        result = {
          code: 1,
          output: `AVISO: passo '${step.key}' lançou uma exceção inesperada ao rodar: ${(e as Error).message}`,
        };
      }

      appendTemp(result.output);
      steps.push({ key: step.key, code: result.code, bestEffort: !!step.bestEffort });

      if (!step.bestEffort && result.code !== 0 && failingCode === 0) {
        failingCode = result.code;
      }
    }
  }

  const trailer = guardAborted
    ? "guard=skip"
    : steps.length > 0
      ? steps.map((s) => `${s.key}=${s.code}`).join(" ")
      : "noop";
  appendTemp(`===== fim (${trailer}) =====`);

  // Anexa o log temporário (fora de data/) ao log final — ponto 2 da
  // docstring do módulo.
  let logAppendOk = false;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tempContent = readFileSync(tempLogPath, "utf8");
      appendLog(logPath, tempContent);
      logAppendOk = true;
      break;
    } catch (e) {
      lastError = e;
      if (attempt < 3) sleepSync(300 * attempt);
    }
  }

  if (logAppendOk) {
    try {
      rmSync(tempLogPath, { force: true });
    } catch {
      // best-effort — falha ao limpar o temp não muda o resultado da run.
    }
  } else {
    console.warn(
      `AVISO: falha ao gravar o log final em ${logPath} após 3 tentativas ` +
        `(${(lastError as Error)?.message ?? String(lastError)}). Log temporário preservado em ${tempLogPath}.`,
    );
  }

  // Exit code honesto — ponto 3 da docstring do módulo.
  const code = failingCode !== 0 ? failingCode : logAppendOk ? 0 : 1;

  return { code, steps, guardAborted, logAppendOk, logPath, tempLogPath };
}
