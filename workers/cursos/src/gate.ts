/**
 * workers/cursos/src/gate.ts (#4052)
 *
 * Verificação de assinante + rate-limit da rota `POST /gate/verify`. Adapter
 * fino sobre `scripts/lib/shared/subscriber-verify.ts` + `rate-limit.ts`
 * (genéricos, extraídos pra reuso futuro por `workers/poll`, #4054).
 */
import type { Env } from "./index";
import {
  sha256Hex,
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
 * (`"unknown"`), tenta o caminho SECUNDÁRIO (`by_email` direto na Beehiiv,
 * confirmado ao vivo no #4305 — ver `subscriber-verify.ts`) só quando os
 * secrets estão configurados — nunca falha o
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

/**
 * #4387: throttle da promoção `pending`→`confirmed` em `handleIndex` — antes
 * disso, TODO reload de `/` com um cookie `pending` chamava `checkGateSubscriber`
 * direto, sem nenhum rate-limit. `checkGateSubscriber` cai pra uma chamada AO
 * VIVO da API da Beehiiv quando a chave do KV está ausente (sync roda só 1x/dia
 * às 09:15) — um assinante legitimamente pending pode ficar nessa janela por
 * até ~24h, durante as quais cada reload disparava uma chamada Beehiiv sem
 * limite.
 *
 * Cooldown por SESSÃO (não por IP): o problema aqui não é força-bruta de
 * e-mail (mesma ameaça do `checkGateRateLimit`/#4322) — é UMA sessão já
 * autenticada (cookie HMAC válido) recarregando a mesma página repetidas
 * vezes. Throttle por IP correria o risco de bloquear cruzado entre sessões
 * pending distintas atrás do mesmo NAT/wifi compartilhado, ou de o mesmo IP
 * gastar o balde de `/gate/verify` (#4322) e travar a promoção de uma sessão
 * pending sem relação nenhuma com aquele fluxo. Chave é o hash do e-mail da
 * SESSÃO (nunca o e-mail cru em repouso no KV — mesmo cuidado de PII de
 * `subscriberKvKey`), então o cooldown é por pessoa, não por rede.
 *
 * Cooldown simples (não é contador tipo `checkKvRateLimit`): a primeira
 * chamada dentro da janela seta a chave com TTL; qualquer chamada seguinte
 * enquanto a chave ainda existe é recusada. Não conta tentativas — só
 * pergunta "já rechecamos esta sessão recentemente?".
 */
export const PENDING_PROMOTION_COOLDOWN_SEC = 10 * 60; // 10min

/** Exportado pro teste de regressão (#4387) poder inspecionar/expirar a
 * chave de cooldown diretamente no KV — mesmo padrão de `subscriberKvKey`. */
export function pendingPromotionCooldownKey(emailHash: string): string {
  return `cooldown:cursos-pending-promo:${emailHash}`;
}

/**
 * `true` = ainda não rechecamos esta sessão pending na janela de cooldown —
 * o caller pode chamar `checkGateSubscriber` e a chave já fica marcada (seta
 * a chave ANTES do caller decidir o que fazer, pra requests concorrentes na
 * mesma janela não passarem os dois — consistência eventual do KV é aceitável
 * aqui, mesma nota de `checkKvRateLimit`: o pior caso é 1-2 chamadas a mais
 * numa corrida, não uma reintrodução do bug original de "sem limite nenhum").
 * `false` = dentro do cooldown, o caller NÃO deve chamar `checkGateSubscriber`
 * (nem o caminho KV barato, nem o fallback ao vivo da Beehiiv) — degrada pro
 * teaser/sessão pending como está, igual a "ainda não confirmou".
 */
export async function shouldRecheckPendingSession(kv: KVNamespace, email: string): Promise<boolean> {
  const key = pendingPromotionCooldownKey(await sha256Hex(email));
  const existing = await kv.get(key);
  if (existing) return false;
  await kv.put(key, "1", { expirationTtl: PENDING_PROMOTION_COOLDOWN_SEC });
  return true;
}
