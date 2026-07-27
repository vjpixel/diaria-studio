/**
 * workers/poll/src/rate-limit.ts (#4054)
 *
 * **Espelho local** de `scripts/lib/shared/rate-limit.ts` — mesmo
 * motivo/mecanismo de sincronia lint-enforced de `session-cookie.ts` neste
 * diretório (ver header lá). `test/rate-limit-mirror-4054.test.ts` trava a
 * divergência.
 *
 * Não substitui `checkSubscribeRateLimit` (subscribe.ts, #3580) — aquele já
 * está em produção e é intocado por esta issue; este módulo serve as novas
 * rotas de gate (`/jogar/gate/*`).
 */

export interface RateLimitResult {
  allowed: boolean;
  count: number;
}

export async function checkKvRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  if (!key) return { allowed: true, count: 0 };
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return { allowed: false, count };
  await kv.put(key, String(count + 1), { expirationTtl: windowSec });
  return { allowed: true, count: count + 1 };
}

export function clientIpFromRequest(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
}
