/**
 * workers/artigos/src/apoio-gate.ts (#7030)
 *
 * Verificação de nível de apoio + rate-limit da rota `POST /gate/verify`.
 * Adapter fino sobre `scripts/lib/shared/apoio-level-verify.ts` +
 * `rate-limit.ts` (genéricos) — mesmo padrão de `workers/cursos/src/gate.ts`
 * (#4052), adaptado pra "nível ≥ limiar" em vez de "assinante ativo".
 */
import type { Env } from "./index";
import { verifyApoioLevelViaKv, meetsApoioThreshold } from "../../../scripts/lib/shared/apoio-level-verify.ts";
import { checkKvRateLimit, type RateLimitResult } from "../../../scripts/lib/shared/rate-limit.ts";
import { ARTIGOS_ESPECIAIS_APOIO_THRESHOLD } from "./apoio-gate-config.ts";

/** Mesmo limite de `workers/cursos` (#4052) — 8 tentativas/IP/hora. */
export const GATE_RATE_LIMIT = 8;
export const GATE_RATE_WINDOW_SEC = 3600;

export function checkGateRateLimit(kv: KVNamespace, ip: string): Promise<RateLimitResult> {
  const key = `rl:artigos-gate:${ip}`;
  return checkKvRateLimit(kv, key, GATE_RATE_LIMIT, GATE_RATE_WINDOW_SEC);
}

export type ApoioGateResult = "meets_threshold" | "not_eligible";

/**
 * #4321 (mesma distinção herdada de `workers/cursos`): por que
 * `checkApoioGate` devolveu `"not_eligible"` — só populado nesse caso.
 *   - `"confirmed_negative"` — o KV TEM uma entrada pra este e-mail (nível
 *     conhecido) e o nível não atinge o limiar. Sinal forte.
 *   - `"unknown"` — o KV NÃO TEM entrada pra este e-mail (nunca apoiou, OU
 *     apoia mas o sync ainda não rodou/não sincronizou este e-mail ainda).
 *     Distinto de "confirmado negativo" — mesmo anti-probing do #4052/#7030:
 *     a resposta HTTP ao visitante é IDÊNTICA nos dois casos (teaser,
 *     sempre); só o CALLER (log/alarme, se algum dia existir um) usaria
 *     `reason` pra diferenciar.
 */
export type ApoioGateReason = "confirmed_negative" | "unknown";

export interface ApoioGateOutcome {
  status: ApoioGateResult;
  reason?: ApoioGateReason;
}

export async function checkApoioGate(env: Env, email: string): Promise<ApoioGateOutcome> {
  const lookup = await verifyApoioLevelViaKv(env.ARTIGOS_APOIO_NIVEL, email);
  if (lookup.state === "unknown") return { status: "not_eligible", reason: "unknown" };
  if (meetsApoioThreshold(lookup.level, ARTIGOS_ESPECIAIS_APOIO_THRESHOLD)) return { status: "meets_threshold" };
  return { status: "not_eligible", reason: "confirmed_negative" };
}
