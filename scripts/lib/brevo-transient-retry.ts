/**
 * #5653 — retry de erro transitório (5xx) do servidor Brevo em operação
 * IDEMPOTENTE. `brevoPost` só retenta 429; um 500 pontual em
 * `POST /contacts/import` (19/09/2026, `{}` no corpo) abortava o
 * `Diaria-Clarice-Novos` inteiro e deixava a unit systemd em `failed` até o
 * dia seguinte. Só usar onde repetir a chamada é seguro (import com
 * `updateExistingContacts` numa lista recém-criada é upsert) — nunca em envio
 * de campanha.
 */

/** Backoff entre tentativas (ms). 3 tentativas no total. */
export const TRANSIENT_5XX_DELAYS_MS = [5_000, 15_000] as const;

/** `formatBrevoApiError` grava o status como `falhou (NNN)`. */
export function isBrevoTransient5xx(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = /falhou \((\d{3})\)/.exec(e.message);
  return m != null && [500, 502, 503, 504].includes(Number(m[1]));
}

export async function withBrevoTransient5xxRetry<T>(
  fn: () => Promise<T>,
  opts: { sleep?: (ms: number) => Promise<void>; delaysMs?: readonly number[]; warn?: (msg: string) => void } = {},
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const delays = opts.delaysMs ?? TRANSIENT_5XX_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isBrevoTransient5xx(e) || attempt >= delays.length) throw e;
      warn(`[brevo-retry] 5xx transitório (tentativa ${attempt + 1}/${delays.length + 1}), retentando em ${delays[attempt]}ms: ${(e as Error).message.slice(0, 160)}`);
      await sleep(delays[attempt]);
    }
  }
}
