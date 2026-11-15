/**
 * scripts/lib/transient-network-failure.ts (#13017)
 *
 * Retry no nível da unit systemd para falha TRANSITÓRIA de rede.
 *
 * Achado de 13/11/2026: o `300` teve 3 quedas de WAN no dia (3h15, 24 min e
 * 3h11) e 16 units diárias falharam por `EAI_AGAIN` / `fetch failed` / `gh`
 * sem rede. Timer diário não tenta de novo até o dia seguinte, e o
 * `fetchWithRetry` interno (4 tentativas, ~1 min) não cobre queda de horas.
 *
 * Desenho (opção 2 da issue): o `task-runner` classifica a saída dos passos
 * que falharam e, quando TODA falha da rodada é de rede, sai com o código
 * dedicado `TRANSIENT_NETWORK_EXIT_CODE`. Só esse código reagenda a unit
 * (`RestartForceExitStatus=` no `.service`, gerado por
 * `scripts/lib/systemd-units.ts`); qualquer outro exit != 0 continua falha
 * comum, sem retry. Vale só para task com `retryOnTransientNetwork: true`
 * no registro (`scripts/lib/scheduled-tasks.ts`); as demais saem com o
 * código de sempre.
 *
 * Por que não 75 (`EX_TEMPFAIL`): 75 já é desfecho de SUCESSO declarado
 * (`successExitCodes: [75]` de `Diaria-Clarice-Guardrail-Alarm`, #6563/#6695,
 * e a trava do `gdrive-bisync.sh`). `RestartForceExitStatus=75` faria essa
 * unit reiniciar a cada "skip deliberado". O código dedicado não pode
 * aparecer em `successExitCodes` de task nenhuma (o gerador recusa, e
 * `test/transient-network-retry-13017.test.ts` trava o registro).
 *
 * Funções puras, sem I/O.
 */

/** Exit code que o runner usa para "falha só de rede, tente de novo".
 * Fora de `sysexits.h` (64-78) e de 126-165 (shell/sinal), e não usado por
 * nenhum script do repo. */
export const TRANSIENT_NETWORK_EXIT_CODE = 105;

/** Intervalo entre tentativas (`RestartSec=`), em minutos. */
export const TRANSIENT_NETWORK_RETRY_INTERVAL_MIN = 15;

/** Quantas re-execuções depois da rodada do timer. 16 × 15 min = 4h, o que
 * cobre as duas quedas longas de 13/11 (3h15 e 3h11) com folga. */
export const TRANSIENT_NETWORK_MAX_RETRIES = 16;

/**
 * Assinaturas de falha de rede (DNS, conexão, socket) na saída de um passo.
 *
 * `ECONNREFUSED` fica de fora de propósito: com a WAN fora o DNS falha antes
 * (`EAI_AGAIN`), e conexão recusada costuma ser serviço LOCAL parado (Studio,
 * Worker em dev), que não volta sozinho em 15 min.
 */
const TRANSIENT_NETWORK_PATTERNS: readonly RegExp[] = [
  /\bEAI_AGAIN\b/,
  /\bENOTFOUND\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETDOWN\b/,
  /\bUND_ERR_CONNECT_TIMEOUT\b/,
  /\bUND_ERR_SOCKET\b/,
  // undici (fetch nativo do Node): "TypeError: fetch failed"
  /\bfetch failed\b/i,
  /\bgetaddrinfo\b/,
  /Temporary failure in name resolution/i,
  /Could not resolve host/i,
  // gh CLI sem rede: "error connecting to api.github.com"
  /error connecting to \S+/i,
  /\bserver misbehaving\b/i,
  /network is unreachable/i,
];

/** `true` quando a saída de um passo traz assinatura de falha de rede. */
export function hasTransientNetworkSignature(output: string): boolean {
  return TRANSIENT_NETWORK_PATTERNS.some((re) => re.test(output));
}

/** Passo que terminou, como o runner vê. */
export interface ClassifiableStep {
  code: number;
  bestEffort: boolean;
  output: string;
}

/**
 * `true` quando a rodada falhou SÓ por rede: há pelo menos um passo
 * obrigatório (não best-effort) com exit != 0 fora de `successExitCodes`, e
 * todos esses passos têm assinatura de rede. Um único passo obrigatório que
 * falhou por outro motivo derruba a classificação (falha comum, sem retry).
 */
export function isTransientNetworkRun(steps: readonly ClassifiableStep[], successExitCodes: readonly number[] = []): boolean {
  const ok = new Set([0, ...successExitCodes]);
  const failed = steps.filter((s) => !s.bestEffort && !ok.has(s.code));
  if (failed.length === 0) return false;
  return failed.every((s) => hasTransientNetworkSignature(s.output));
}

/**
 * Código final da rodada para task com `retryOnTransientNetwork`.
 *
 * - Rodada que falhou só por rede → `TRANSIENT_NETWORK_EXIT_CODE`.
 * - Rodada cujo código já é `TRANSIENT_NETWORK_EXIT_CODE` sem ser falha de
 *   rede (um passo saiu 105 por conta própria) → 1, para não reagendar.
 * - O resto → o código que o runner já calculou.
 */
export function resolveTransientNetworkExitCode(
  code: number,
  steps: readonly ClassifiableStep[],
  successExitCodes: readonly number[] = [],
): number {
  if (code === 0) return 0;
  if (isTransientNetworkRun(steps, successExitCodes)) return TRANSIENT_NETWORK_EXIT_CODE;
  return code === TRANSIENT_NETWORK_EXIT_CODE ? 1 : code;
}

/** Janela do limite de partidas (`StartLimitIntervalSec=`), em horas.
 *
 * O rate limit do systemd é de janela FIXA: começa na 1ª partida e zera
 * quando a janela vence. Se as 17 partidas não couberem nela (passo lento,
 * cada rodada levando dezenas de minutos), o contador zera antes do teto e a
 * unit reiniciaria sem fim. 12h dá folga para rodadas de até ~30 min cada e
 * ainda vence antes do próximo disparo de um timer diário (24h).
 */
export const TRANSIENT_NETWORK_START_LIMIT_WINDOW_H = 12;

/** Linhas de `[Unit]` e `[Service]` do retry de rede no `.service` gerado.
 *
 * `StartLimitBurst` conta TODA ativação dentro da janela (a do timer + as
 * re-execuções), por isso é `MAX_RETRIES + 1`. Ao esgotar, a unit fica
 * `failed` (`start-limit-hit`) e o alarme de units falhas pega como antes.
 * Entre as tentativas a unit fica em `activating (auto-restart)`, não
 * `failed`: o alarme só vê a falha que sobrou depois do teto.
 */
export function transientNetworkRetryUnitLines(): { unit: string[]; service: string[] } {
  return {
    unit: [`StartLimitIntervalSec=${TRANSIENT_NETWORK_START_LIMIT_WINDOW_H}h`, `StartLimitBurst=${TRANSIENT_NETWORK_MAX_RETRIES + 1}`],
    service: [
      `RestartForceExitStatus=${TRANSIENT_NETWORK_EXIT_CODE}`,
      `RestartSec=${TRANSIENT_NETWORK_RETRY_INTERVAL_MIN}min`,
    ],
  };
}
