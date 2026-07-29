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
 * #4321: por que `checkGateSubscriber` devolveu `"not_active"` — só populado
 * nesse caso, `undefined` quando `status === "active"`.
 *
 *   - `"confirmed_negative"` — verificamos (KV e/ou Beehiiv responderam) e o
 *     e-mail não é assinante ativo. Sinal forte.
 *   - `"verification_failed"` — NÃO conseguimos verificar (Beehiiv fora do
 *     ar, `BEEHIIV_API_KEY` rotacionada → 401/403, rate-limit → 429, 5xx, ou
 *     exceção de rede) e o KV também não tinha a chave. O e-mail PODE ser
 *     assinante — só não dá pra confirmar agora. Sem essa distinção, uma
 *     rotação de key não sincronizada vira apagão silencioso pra todo
 *     assinante ainda ausente do KV (#4305/#4320).
 *
 * A resposta HTTP ao visitante é IDÊNTICA nos dois casos (teaser, sempre —
 * anti-probing do #4052 intacto): só o CALLER (log/alarme) usa `reason` pra
 * diferenciar. Nunca vaza pro cliente.
 */
export type GateCheckReason = "confirmed_negative" | "verification_failed";

export interface GateCheckOutcome {
  status: GateCheckResult;
  reason?: GateCheckReason;
}

/**
 * Verifica se `email` é assinante ativo. PRIMÁRIO: KV populado pelo sync
 * (`scripts/sync-cursos-subscribers-kv.ts`). Se o KV não tem a chave
 * (`"unknown"`), tenta o caminho SECUNDÁRIO/não-verificado (`by_email` direto
 * na Beehiiv) só quando os secrets estão configurados — nunca falha o
 * request se ausentes, apenas trata como "not_active"/`confirmed_negative`
 * (o form de cadastro inline cobre esse caso, ver subscribe.ts — decisão
 * deliberada de manter esse caminho como está, #4321 não mexe nisso: secrets
 * ausentes por design é indistinguível de "verificou e não achou" hoje,
 * fora de escopo aqui).
 */
export async function checkGateSubscriber(env: Env, email: string): Promise<GateCheckOutcome> {
  const viaKv = await verifySubscriberViaKv(env.CURSOS_SUBSCRIBERS, email);
  if (viaKv === "active") return { status: "active" };

  if (env.BEEHIIV_API_KEY && env.BEEHIIV_PUBLICATION_ID) {
    const viaApi = await verifySubscriberViaBeehiivByEmail(env.BEEHIIV_API_KEY, env.BEEHIIV_PUBLICATION_ID, email, {
      baseUrl: env.BEEHIIV_API_URL,
    });
    if (viaApi === "active") return { status: "active" };
    if (viaApi === "verification_failed") return { status: "not_active", reason: "verification_failed" };
  }

  return { status: "not_active", reason: "confirmed_negative" };
}
