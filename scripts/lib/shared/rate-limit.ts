/**
 * rate-limit.ts (#4052)
 *
 * Rate-limit genérico por chave via KV — janela deslizante simples (mesmo
 * padrão já usado em `workers/poll/src/subscribe.ts` `checkSubscribeRateLimit`,
 * #3580). Extraído pra `lib/shared/` pra ser reusado por `workers/cursos`
 * (#4052) e, no futuro, `workers/poll` (#4054) sem duplicar a lógica.
 *
 * Consistência eventual do KV é aceitável aqui — o pior caso é 1-2 tentativas
 * a mais numa corrida, não um vetor de abuso em massa (mesma nota de #3580).
 */

export interface RateLimitResult {
  allowed: boolean;
  count: number;
}

/**
 * Incrementa o contador de `key` no KV; permite se `count < limit` ANTES do
 * incremento. `expirationTtl: windowSec` reseta a janela a cada tentativa
 * (janela deslizante). Chave vazia → sempre permite (caller decide o que
 * fazer quando não há identificador, ex: IP ausente em ambiente de teste).
 */
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

/** Extrai o IP do cliente dos headers padrão do Cloudflare (`CF-Connecting-IP`,
 * fallback `X-Forwarded-For`). Retorna `""` se ausente (nunca lança). */
export function clientIpFromRequest(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
}
