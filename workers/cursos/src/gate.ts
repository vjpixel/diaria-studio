/**
 * workers/cursos/src/gate.ts (#4052)
 *
 * Verificação de assinante + rate-limit da rota `POST /gate/verify`. Adapter
 * fino sobre `scripts/lib/shared/subscriber-verify.ts` + `rate-limit.ts`
 * (genéricos, extraídos pra reuso futuro por `workers/poll`, #4054).
 */
import type { Env } from "./index";
import {
  verifySubscriberViaBeehiivByEmail,
  verifySubscriberViaKv,
} from "../../../scripts/lib/shared/subscriber-verify.ts";
import { checkKvRateLimit, type RateLimitResult } from "../../../scripts/lib/shared/rate-limit.ts";

/** Cadastro/verificação: N tentativas por IP por janela — baixo de propósito
 * (mesma filosofia de `workers/poll/src/subscribe.ts` #3580: humano só
 * verifica/assina 1x por sessão; qualquer coisa acima é abuso/força bruta de
 * e-mail). */
export const GATE_RATE_LIMIT = 8;
export const GATE_RATE_WINDOW_SEC = 3600; // 1h

export function checkGateRateLimit(kv: KVNamespace, ip: string): Promise<RateLimitResult> {
  const key = `rl:cursos-gate:${ip}`;
  return checkKvRateLimit(kv, key, GATE_RATE_LIMIT, GATE_RATE_WINDOW_SEC);
}

export type GateCheckResult = "active" | "not_active";

/**
 * Verifica se `email` é assinante ativo. PRIMÁRIO: KV populado pelo sync
 * (`scripts/sync-cursos-subscribers-kv.ts`). Se o KV não tem a chave
 * (`"unknown"`), tenta o caminho SECUNDÁRIO/não-verificado (`by_email` direto
 * na Beehiiv) só quando os secrets estão configurados — nunca falha o
 * request se ausentes, apenas trata como "not_active" (o form de cadastro
 * inline cobre esse caso, ver subscribe.ts).
 */
export async function checkGateSubscriber(env: Env, email: string): Promise<GateCheckResult> {
  const viaKv = await verifySubscriberViaKv(env.CURSOS_SUBSCRIBERS, email);
  if (viaKv === "active") return "active";

  if (env.BEEHIIV_API_KEY && env.BEEHIIV_PUBLICATION_ID) {
    const viaApi = await verifySubscriberViaBeehiivByEmail(env.BEEHIIV_API_KEY, env.BEEHIIV_PUBLICATION_ID, email, {
      baseUrl: env.BEEHIIV_API_URL,
    });
    if (viaApi === "active") return "active";
  }

  return "not_active";
}
