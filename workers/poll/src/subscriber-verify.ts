/**
 * workers/poll/src/subscriber-verify.ts (#4054)
 *
 * **Espelho local** de `scripts/lib/shared/subscriber-verify.ts` — mesmo
 * motivo/mecanismo de sincronia lint-enforced de `session-cookie.ts` neste
 * diretório (ver header lá). `test/subscriber-verify-mirror-4054.test.ts`
 * trava a divergência.
 */

export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input.trim().toLowerCase()));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function subscriberKvKey(email: string): Promise<string> {
  return `subscriber:${await sha256Hex(email)}`;
}

// #4321: "verification_failed" — ver docstring do original em
// `scripts/lib/shared/subscriber-verify.ts` pro rationale completo. Espelho
// mantido em sincronia comportamental por `test/poll-shared-mirror-4054.test.ts`.
/**
 * Teto por chamada de verificação (#6208, achado P2 do review).
 *
 * Antes do #6048 a ausência de timeout só mordia quem NÃO estava no KV.
 * Agora as 3 fontes são consultadas sempre, então uma API travada atrasaria
 * TODO gate check — inclusive o de quem já é `active` no KV e antes nem
 * tocava a rede. O blast radius mudou de parcial pra universal, e é isso que
 * torna o timeout necessário aqui e agora.
 *
 * Estouro vira `verification_failed` pelo `catch` que já existe — nunca
 * "não é assinante".
 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 5000;

export type SubscriberVerifyState = "active" | "inactive" | "unknown" | "verification_failed";

export async function verifySubscriberViaKv(
  kv: KVNamespace,
  email: string,
): Promise<SubscriberVerifyState> {
  const key = await subscriberKvKey(email);
  const val = await kv.get(key);
  return val ? "active" : "unknown";
}

export interface BeehiivByEmailDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** #6208 — ver `DEFAULT_VERIFY_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export async function verifySubscriberViaBeehiivByEmail(
  apiKey: string,
  publicationId: string,
  email: string,
  deps: BeehiivByEmailDeps = {},
): Promise<SubscriberVerifyState> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl ?? "https://api.beehiiv.com/v2";
  try {
    const res = await fetchImpl(
      `${base}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS) },
    );
    if (res.status === 404) return "unknown";
    if (!res.ok) return "verification_failed";
    const body = (await res.json()) as { data?: { status?: string } };
    const status = body?.data?.status;
    if (status === "active") return "active";
    if (status === "inactive" || status === "cancelled") return "inactive";
    return "unknown";
  } catch {
    return "verification_failed";
  }
}

export interface KitByEmailDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** #6208 — ver `DEFAULT_VERIFY_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Espelho de `verifySubscriberViaKitByEmail` — ver docstring completa em
 * `scripts/lib/shared/subscriber-verify.ts` (#6048). `test/poll-shared-mirror-4054.test.ts`
 * trava a divergência.
 */
export async function verifySubscriberViaKitByEmail(
  apiKey: string,
  email: string,
  deps: KitByEmailDeps = {},
): Promise<SubscriberVerifyState> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl ?? "https://api.kit.com/v4";
  try {
    const res = await fetchImpl(`${base}/subscribers?email_address=${encodeURIComponent(email)}`, {
      headers: { "X-Kit-Api-Key": apiKey },
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return "verification_failed";
    const body = (await res.json()) as { subscribers?: { state?: string }[] };
    const sub = body?.subscribers?.[0];
    if (!sub) return "unknown";
    if (sub.state === "active") return "active";
    if (sub.state === "cancelled" || sub.state === "bounced" || sub.state === "complained" || sub.state === "inactive") {
      return "inactive";
    }
    return "unknown";
  } catch {
    return "verification_failed";
  }
}
