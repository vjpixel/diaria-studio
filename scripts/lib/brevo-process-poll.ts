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
 * Poll `pollProcess(processId)` até `status` terminal:
 *   - `"completed"`/`"success"` → resolve com o resultado completo (o
 *     chamador decide o que extrair dele — `exportUrl`, ou nada, no caso do
 *     import).
 *   - `"failed"`/`"error"` → lança imediatamente (não espera `maxAttempts`).
 *   - qualquer outro status (`"queued"`, `"in_process"`, etc) → continua
 *     tentando até `maxAttempts`; esgotar sem terminal também lança.
 *
 * Defaults (2s entre tentativas, 30 tentativas — ~1min teto) validados ao
 * vivo em #4451 contra export de campanha real.
 */
export async function pollProcessUntilTerminal<T extends ProcessStatusResult>(
  pollProcess: (processId: number | string) => Promise<T>,
  processId: number | string,
  opts: PollOptions = {},
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = opts.intervalMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 30;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await pollProcess(processId);
    if (res.status === "completed" || res.status === "success") return res;
    if (res.status === "failed" || res.status === "error") {
      throw new Error(`Processo ${processId} falhou (status=${res.status}).`);
    }
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }
  throw new Error(`Processo ${processId} não completou após ${maxAttempts} tentativas de poll.`);
}
