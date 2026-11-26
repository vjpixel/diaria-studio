/**
 * runner-step-timings.ts (#14032) — duração por passo dos runners de etapa.
 *
 * Os runners (`stage-0-run.ts`, `stage-1-run.ts`, `stage-2-run.ts`) só
 * registravam label e exit code de cada sub-script; o Stage 1 gravava a
 * duração do stage inteiro. A alta de ~1,8 min do Stage 0 em novembro ficou
 * sem dono: não dava para dizer se veio do refresh-dedup, do lote 0e-0h, dos
 * healthchecks ou do 0k.
 *
 * Aqui: um recorder que embrulha o `exec`/`execAsync` injetável do runner,
 * mede o relógio em volta de cada chamada e acumula `{label, ms, code}`. No
 * fim da fase o runner grava UM evento `step_timings` no run-log
 * (`scripts/log-event.ts`, o mesmo caminho dos outros eventos do runner) —
 * nunca no stdout, que é o JSON que o top-level lê.
 *
 * Fail-soft: falha ao gravar o evento vira aviso no stderr e nunca muda o
 * exit code nem o JSON do runner.
 *
 * O relógio é injetável (`clockMs`, default `Date.now`): teste determinístico.
 */

/** Uma chamada de sub-script medida. `async` marca as do lote paralelo (ms se sobrepõem). */
export interface StepTiming {
  label: string;
  ms: number;
  /** Exit code do sub-script; `-1` quando o `exec` lançou em vez de devolver. */
  code: number;
  async?: true;
}

/** `details` do evento `step_timings`. `started_at` + `total_ms` permitem medir o intervalo entre fases (tempo de agente). */
export interface StepTimingsSummary {
  phase: string;
  started_at: string;
  total_ms: number;
  steps: StepTiming[];
}

type SyncExec<R extends { code: number }> = (scriptRelPath: string, args: string[], label?: string) => R;
type AsyncExec<R extends { code: number }> = (scriptRelPath: string, args: string[], label?: string) => Promise<R>;

const MAX_LABEL = 120;
const MAX_ARG = 24;

/**
 * Label derivado quando a chamada não traz um (`deps.exec` direto, fora de
 * `step()`): nome do script sem `scripts/` e `.ts`, mais os argumentos curtos.
 * Path, texto com espaço e valor longo viram `…` — o label diferencia
 * `clarice-healthcheck --real-chunk` de `clarice-healthcheck --mcp` sem levar
 * o diretório da edição nem a mensagem de um log-event.
 */
export function stepTimingLabel(scriptRelPath: string, args: readonly string[]): string {
  const name = scriptRelPath.replace(/^scripts\//, "").replace(/\.ts$/, "");
  if (name === "log-event") return name;
  const parts = [name, ...args.map((a) => (a.length > MAX_ARG || /[\\/\s]/.test(a) ? "…" : a))];
  const label = parts.join(" ");
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

export class StepTimingRecorder {
  readonly steps: StepTiming[] = [];
  readonly startedAtMs: number;

  constructor(private readonly clockMs: () => number = Date.now) {
    this.startedAtMs = clockMs();
  }

  private record(label: string, start: number, code: number, async: boolean): void {
    const entry: StepTiming = { label, ms: Math.max(0, this.clockMs() - start), code };
    if (async) entry.async = true;
    this.steps.push(entry);
  }

  wrapExec<R extends { code: number }>(exec: SyncExec<R>): SyncExec<R> {
    return (scriptRelPath, args, label) => {
      const name = label ?? stepTimingLabel(scriptRelPath, args);
      const start = this.clockMs();
      let result: R;
      try {
        result = exec(scriptRelPath, args, label);
      } catch (err) {
        this.record(name, start, -1, false);
        throw err;
      }
      this.record(name, start, result.code, false);
      return result;
    };
  }

  wrapExecAsync<R extends { code: number }>(exec: AsyncExec<R>): AsyncExec<R> {
    return async (scriptRelPath, args, label) => {
      const name = label ?? stepTimingLabel(scriptRelPath, args);
      const start = this.clockMs();
      let result: R;
      try {
        result = await exec(scriptRelPath, args, label);
      } catch (err) {
        this.record(name, start, -1, true);
        throw err;
      }
      this.record(name, start, result.code, true);
      return result;
    };
  }

  summary(phase: string): StepTimingsSummary {
    return {
      phase,
      started_at: new Date(this.startedAtMs).toISOString(),
      total_ms: Math.max(0, this.clockMs() - this.startedAtMs),
      steps: [...this.steps],
    };
  }
}

/**
 * Grava o evento `step_timings` via `scripts/log-event.ts` com o `exec` CRU do
 * runner (sem o wrapper: o próprio registro não entra na conta). Nunca lança:
 * exit != 0 ou exceção viram uma linha de aviso no stderr.
 */
export function emitStepTimings(
  exec: (scriptRelPath: string, args: string[]) => { code: number },
  target: { edition: string; stage: string; agent: string },
  summary: StepTimingsSummary,
): void {
  const args = [
    "--edition",
    target.edition,
    "--stage",
    target.stage,
    "--agent",
    target.agent,
    "--level",
    "info",
    "--message",
    "step_timings",
    "--details",
    JSON.stringify(summary),
  ];
  try {
    const r = exec("scripts/log-event.ts", args);
    if (r.code !== 0) console.error(`⚠️  step_timings (#14032): log-event.ts saiu ${r.code} — duração por passo da fase ${summary.phase} não registrada.`);
  } catch (err) {
    console.error(`⚠️  step_timings (#14032): falha ao registrar a duração por passo da fase ${summary.phase}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
