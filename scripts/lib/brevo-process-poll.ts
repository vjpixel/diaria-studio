/**
 * brevo-process-poll.ts (#4577 — extraído de clarice-engagement-cohorts-v2.ts)
 *
 * Poller genérico de `GET /processes/{id}` da Brevo até status terminal.
 * Nasceu em `clarice-engagement-cohorts-v2.ts` (#4451) como
 * `pollExportUntilDone`, testado AO VIVO — a campanha de 116 destinatários
 * completou em ~4s — mas atrelado ao caso de uso de EXPORT (só sabia extrair
 * `exportUrl` do resultado terminal). #4577 extrai a parte genérica (poll até
 * status terminal, sem opinar sobre o shape do resultado) pra reusar em
 * `clarice-import-waves.ts`, que precisa do MESMO poll pra confirmar
 * `/contacts/import` — antes desta issue, `clarice-import-waves.ts` disparava
 * o import e declarava sucesso assim que a Brevo aceitava o POST, sem nunca
 * confirmar que o processo assíncrono tinha terminado (nem se tinha terminado
 * com sucesso) — um contato (`a15276@aecampo.pt`) foi perdido em silêncio
 * porque nada checava o processo nem a contagem final da lista.
 *
 * `pollExportUntilDone` em `clarice-engagement-cohorts-v2.ts` agora é um
 * wrapper fino sobre `pollProcessUntilTerminal` que extrai `exportUrl` do
 * resultado — mesmo contrato/testes de antes, sem duplicar o loop de poll.
 */

export interface PollOptions {
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxAttempts?: number;
}

/** Shape mínimo que todo `GET /processes/{id}` da Brevo devolve — `status` é
 *  o único campo que o poll precisa pra decidir continuar/parar; chamadores
 *  específicos (export, import) penduram campos extras (`exportUrl` etc). */
export interface ProcessStatusResult {
  status?: string;
  [key: string]: unknown;
}

/**
 * #5653 — lançada quando o poll ESGOTA `maxAttempts` sem status terminal
 * (nem sucesso, nem falha reportada pela Brevo) — distinta de um `Error`
 * genérico pra que um `catch` possa diferenciar programaticamente "a Brevo
 * respondeu que o processo falhou" (mensagem `Processo N falhou
 * (status=X)`, lançada assim que o status terminal de erro chega, nunca
 * espera `maxAttempts`) de "nosso orçamento de espera acabou, a Brevo nunca
 * confirmou nem sucesso nem falha" (esta classe). As duas eram fáceis de
 * confundir na leitura corrida de um log (mesma forma "Processo N ... não
 * completou/falhou") — a classe dedicada torna a distinção inequívoca sem
 * depender de parsear a string.
 */
export class PollBudgetExhaustedError extends Error {
  constructor(processId: number | string, maxAttempts: number, totalWaitMs: number) {
    super(
      `Processo ${processId}: orçamento de poll ESGOTADO (${maxAttempts} tentativas, ` +
        `~${Math.round(totalWaitMs / 1000)}s) sem a Brevo confirmar status terminal (nem sucesso, nem ` +
        `falha) — a Brevo pode ainda estar processando; NÃO é uma falha reportada por ela. Sob rate ` +
        `limit sustentado (#5653), aumente o orçamento via \`maxAttempts\`/\`intervalMs\` (ou env vars ` +
        `${MAX_ATTEMPTS_ENV_VAR}/${INTERVAL_MS_ENV_VAR}) em vez de reduzir o teto.`,
    );
    this.name = "PollBudgetExhaustedError";
  }
}

const MAX_ATTEMPTS_ENV_VAR = "BREVO_PROCESS_POLL_MAX_ATTEMPTS";
const INTERVAL_MS_ENV_VAR = "BREVO_PROCESS_POLL_INTERVAL_MS";

/** #5653 — lê um inteiro positivo de env var; `null`/vazio/inválido cai no
 * `fallback` (nunca lança — mesma disciplina fail-soft do resto do repo pra
 * leitura de config via env). */
function positiveIntEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * #5653 — default ANTERIOR (30 tentativas × 2s = 60s) foi medido
 * insuficiente ao vivo (24-25/08/2026, #6132): um import de ~29 linhas não
 * completou em 30 tentativas sob rate limit sustentado da conta Brevo (100
 * req/hora — ver docs/brevo-rate-limits.md). O processo assíncrono de
 * import/export não é o que está sendo limitado diretamente (é
 * `/contacts/import`, família diferente de `/emailCampaigns*`), mas RODA na
 * mesma conta sob a mesma pressão de fila quando a conta está saturada —
 * então o teto de espera precisa de folga adicional pro pior caso, não só
 * o caso feliz medido em #4451 (campanha de 116 destinatários, ~4s).
 * Novo default: 90 tentativas × 2s = 180s (3min) — 3× o orçamento anterior,
 * ainda finito (nunca vira loop infinito, mesma disciplina do teto antigo),
 * configurável por chamador (`opts.maxAttempts`/`opts.intervalMs`) ou por
 * env var (`BREVO_PROCESS_POLL_MAX_ATTEMPTS`/`_INTERVAL_MS`) pra quem
 * precisar de um orçamento ainda maior sem editar código (ex: um lote maior
 * rodado manualmente sob rate limit conhecido).
 */
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 90;

/**
 * Poll `pollProcess(processId)` até `status` terminal:
 *   - `"completed"`/`"success"` → resolve com o resultado completo (o
 *     chamador decide o que extrair dele — `exportUrl`, ou nada, no caso do
 *     import).
 *   - `"failed"`/`"error"` → lança `Error` (mensagem `Processo N falhou
 *     (status=X)`) IMEDIATAMENTE, não espera `maxAttempts` — a Brevo já
 *     respondeu, não há nada a ganhar esperando mais.
 *   - qualquer outro status (`"queued"`, `"in_process"`, etc) → continua
 *     tentando até `maxAttempts`; esgotar sem terminal lança
 *     `PollBudgetExhaustedError` (classe distinta — ver docstring acima).
 *
 * Defaults configuráveis por `opts` (por chamada) ou por env var (global,
 * útil pra rodada manual sem editar código) — ver `DEFAULT_MAX_ATTEMPTS`.
 */
export async function pollProcessUntilTerminal<T extends ProcessStatusResult>(
  pollProcess: (processId: number | string) => Promise<T>,
  processId: number | string,
  opts: PollOptions = {},
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = opts.intervalMs ?? positiveIntEnv(INTERVAL_MS_ENV_VAR, DEFAULT_INTERVAL_MS);
  const maxAttempts = opts.maxAttempts ?? positiveIntEnv(MAX_ATTEMPTS_ENV_VAR, DEFAULT_MAX_ATTEMPTS);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await pollProcess(processId);
    if (res.status === "completed" || res.status === "success") return res;
    if (res.status === "failed" || res.status === "error") {
      throw new Error(`Processo ${processId} falhou (status=${res.status}).`);
    }
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }
  throw new PollBudgetExhaustedError(processId, maxAttempts, maxAttempts * intervalMs);
}
