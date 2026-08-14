/**
 * scripts/lib/transient-step-retry.ts (#5220)
 *
 * Retry genérico com backoff pra falha TRANSITÓRIA (exit code configurável,
 * default 3 — ver `TransientDashboardError` em `clarice-plan-wave.ts`) de um
 * passo do tipo "spawna outro script TS via ExecFn e olha o exit code".
 *
 * Extraído de `clarice-envio-run.ts` (#5058, retry da task das 19:00) pra
 * reuso pelo guard das 05:00 (`clarice-envio-guard.ts`, #5220) — mesmo
 * mecanismo, orçamento de espera DIFERENTE: `clarice-envio-run.ts` tem ~11h
 * de folga antes do disparo das 06:00 do dia SEGUINTE, então tolera esperas
 * de até 35min por tentativa; o guard roda dentro da janela 05:00→06:00 do
 * MESMO dia — orçamento total precisa caber com folga antes do disparo, ver
 * `GUARD_TRANSIENT_RETRY_BUDGET` em `clarice-envio-guard.ts`.
 *
 * A função em si não decide o orçamento — recebe via `TransientRetryBudget`,
 * cada chamador define o que cabe na própria janela.
 */

export interface StepResultLike {
  code: number;
  stdout: string;
  stderr: string;
}

export type StepExecFn = (scriptRelPath: string, args: string[]) => StepResultLike;

export interface TransientStepSignal {
  transient?: boolean;
  retryAfterSecs?: number | null;
  status?: number;
  reason?: string;
}

export interface TransientRetryBudget {
  /** Exit code que sinaliza falha transitória — default 3. */
  transientExitCode?: number;
  /** Tentativas totais (incluindo a 1ª). */
  maxAttempts: number;
  /** Espera quando o sinal não trouxe `retryAfterSecs`. */
  fallbackMs: number;
  /** Teto de espera por tentativa — nunca honra um `retryAfterSecs` absurdo sem limite. */
  capMs: number;
}

export interface TransientRetryParams<T> {
  exec: StepExecFn;
  sleep: (ms: number) => Promise<void>;
  note: (line: string) => void;
  /** Mesma forma de `parseStepJson` (genérica por chamada) — cada chamador injeta a própria instância. */
  parseJson: <U = unknown>(stdout: string) => U | undefined;
  label: string;
  scriptRelPath: string;
  args: string[];
  okCodes?: number[];
  budget: TransientRetryBudget;
  /** Constrói o erro a lançar (falha transitória esgotada, ou falha dura não-transitória) — cada chamador usa a própria classe de Abort. */
  makeAbort: (message: string) => Error;
}

/**
 * Variante de "roda um passo e aborta se falhar" que reconhece o exit code
 * transitório (default 3) e retenta com backoff em vez de abortar na 1ª
 * falha. Qualquer outro código fora de `okCodes` continua abortando
 * imediatamente — mesma disciplina de um `step()` simples, só o ramo
 * transitório é diferente.
 */
export async function stepWithTransientRetry<T = unknown>(
  params: TransientRetryParams<T>,
): Promise<{ result: StepResultLike; json: T | undefined }> {
  const { exec, sleep, note, parseJson, label, scriptRelPath, args, makeAbort } = params;
  const okCodes = params.okCodes ?? [0];
  const transientExitCode = params.budget.transientExitCode ?? 3;
  const { maxAttempts, fallbackMs, capMs } = params.budget;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    note(attempt === 1 ? `▶ ${label}` : `▶ ${label} (retry ${attempt}/${maxAttempts})`);
    const result = exec(scriptRelPath, args);
    if (result.stderr.trim()) console.error(result.stderr.trim());
    if (okCodes.includes(result.code)) {
      return { result, json: parseJson<T>(result.stdout) };
    }
    if (result.code === transientExitCode) {
      const signal = parseJson<TransientStepSignal>(result.stdout);
      if (attempt < maxAttempts) {
        const waitMs = Math.min(
          signal?.retryAfterSecs != null && signal.retryAfterSecs >= 0 ? signal.retryAfterSecs * 1000 : fallbackMs,
          capMs,
        );
        note(
          `⚠️  ${label}: falha TRANSITÓRIA (${signal?.reason ?? "rate limit do dashboard"}) — ` +
            `aguardando ${Math.round(waitMs / 1000)}s antes de tentar de novo (tentativa ${attempt}/${maxAttempts}).`,
        );
        await sleep(waitMs);
        continue;
      }
      throw makeAbort(
        `❌ ${label}: falha TRANSITÓRIA persistiu após ${maxAttempts} tentativas ` +
          `(${signal?.reason ?? "rate limit do dashboard"}) — desistindo nesta rodada.`,
      );
    }
    const detail = result.stderr.trim().split("\n").slice(-6).join(" | ") || "(sem stderr)";
    throw makeAbort(`❌ ${label} falhou (exit ${result.code}): ${detail}`);
  }
  // Inalcançável — o loop acima sempre retorna ou lança.
  throw makeAbort(`❌ ${label}: loop de retry encerrado sem resultado (bug).`);
}
