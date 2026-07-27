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

export type SubscriberVerifyState = "active" | "inactive" | "unknown";

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
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (res.status === 404) return "unknown";
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { data?: { status?: string } };
    const status = body?.data?.status;
    if (status === "active") return "active";
    if (status === "inactive" || status === "cancelled") return "inactive";
    return "unknown";
  } catch {
    return "unknown";
  }
}
