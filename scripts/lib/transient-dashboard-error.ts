/**
 * scripts/lib/transient-dashboard-error.ts (#5220)
 *
 * Sinal tipado de falha TRANSITÓRIA (429/503 — rate limit da Brevo repassado
 * pelo dashboard `clarice-dashboard`, `rateLimitResponse` em
 * `workers/brevo-dashboard/src/brevo-api.ts` sempre devolve 503 + `Retry-After`,
 * nunca 429 puro, mas 429 é aceito aqui também, defensivo) NÃO é erro de
 * lógica, é "espere e repita".
 *
 * Extraído de `clarice-plan-wave.ts` (#5058, origem — `TRANSIENT_RETRY_*` em
 * `clarice-envio-run.ts`) pra reuso por `clarice-envio-risk.ts` (#5220) — os
 * dois batem no MESMO dashboard (`GET {dashboardUrl}/api/campaigns`) e
 * decidem exatamente a mesma coisa sobre a mesma origem; duplicar a
 * classe/status-set/parsing de header em 2 lugares seria a MESMA lógica
 * divergindo silenciosamente se um dos dois for editado sem o outro.
 *
 * `clarice-plan-wave.ts` reexporta `TransientDashboardError` do path
 * original (`export { TransientDashboardError } from "./lib/..."`) — testes
 * existentes que importam de lá (`test/clarice-plan-wave.test.ts`) continuam
 * funcionando sem alteração, mesma identidade de classe.
 */
export class TransientDashboardError extends Error {
  readonly transient = true as const;
  constructor(
    message: string,
    readonly retryAfterSecs: number | null,
    readonly status: number,
  ) {
    super(message);
    this.name = "TransientDashboardError";
  }
}

export const TRANSIENT_DASHBOARD_STATUSES = new Set([429, 503]);

/** `Retry-After` (RFC 7231, delta em segundos) — `null` = header ausente/inválido, nunca inventa um valor. */
export function parseRetryAfterSecs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw == null) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}
