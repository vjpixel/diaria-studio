/**
 * subscriber-verify.ts (#4052)
 *
 * Verificação "é assinante ativo da Diar.ia?" — genérica, extraída pra
 * `lib/shared/` (briefing #4054 do coordenador) pra ser reusada por
 * `workers/cursos` (#4052, primeiro consumidor) e `workers/poll` (#4054,
 * futuro — "É IA? diário: e-mail obrigatório no caminho de fora") sem
 * duplicar a lógica de verificação nem o formato da chave KV.
 *
 * DUAS estratégias, DECISÃO EXPLÍCITA (#4052, ver PR body):
 *
 *   1. `verifySubscriberViaKv` — PRIMÁRIA/DEFAULT. Lê `subscriber:{sha256(email)}`
 *      de um KV populado por um sync agendado (`scripts/sync-cursos-subscribers-kv.ts`)
 *      que pagina `GET /subscriptions?status=active` no estilo de
 *      `scripts/backup-beehiiv.ts` (padrão JÁ comprovado no repo). Hash do
 *      e-mail (não e-mail cru) como chave — reduz PII em repouso no KV
 *      (defesa em profundidade; o KV do Cloudflare não é público, mas
 *      minimizar é grátis). `sha256Hex` usa Web Crypto — roda em Node E no
 *      runtime Workers sem polyfill.
 *
 *   2. `verifySubscriberViaBeehiivByEmail` — SECUNDÁRIA, NÃO VERIFICADA.
 *      Chama `GET /publications/{id}/subscriptions/by_email/{email}`
 *      diretamente na API da Beehiiv. Este endpoint está documentado na
 *      issue original mas **não foi confirmado ao vivo** contra o plano desta
 *      conta neste ambiente (sandbox sem egress de rede / sem key real).
 *      TODO(#4052): confirmar manualmente (`curl` com a key real) antes de
 *      promover este caminho a primário ou usá-lo em produção sem o fallback
 *      KV. Mantido aqui só como caminho DISPONÍVEL, documentado, não-default.
 */

/** SHA-256 hex de `email` normalizado (lowercase + trim) — Web Crypto, sem
 * dependência de Node (`node:crypto`). Usado como chave KV pra não guardar
 * e-mail cru em repouso. */
export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input.trim().toLowerCase()));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Chave KV canônica do sync de assinantes ativos — fonte única (usada tanto
 * pelo script de sync quanto pelo lookup no worker; divergir os dois quebra
 * a verificação silenciosamente). */
export async function subscriberKvKey(email: string): Promise<string> {
  return `subscriber:${await sha256Hex(email)}`;
}

export type SubscriberVerifyState = "active" | "inactive" | "unknown";

/**
 * Verificação PRIMÁRIA (default): consulta o KV populado pelo sync agendado.
 * `"active"` = chave presente (o sync só escreve assinantes com
 * `status: active`). `"unknown"` = chave ausente — pode significar
 * "não é assinante" OU "sync ainda não rodou / e-mail não sincronizado
 * ainda" — o caller decide como tratar (#4052: cursos trata `unknown` como
 * "não verificado", cai no fluxo de cadastro, NUNCA como confirmação
 * negativa forte o bastante pra recusar algo destrutivo).
 */
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

/**
 * Verificação SECUNDÁRIA — chamada direta `GET
 * /publications/{id}/subscriptions/by_email/{email}`.
 *
 * TODO(#4052): endpoint NÃO confirmado ao vivo contra o plano desta conta
 * Beehiiv (sandbox sem egress de rede / sem `BEEHIIV_API_KEY` real). Antes de
 * depender deste caminho como primário ou crítico, o editor precisa validar
 * manualmente (`curl -H "Authorization: Bearer $BEEHIIV_API_KEY"
 * https://api.beehiiv.com/v2/publications/$PUB_ID/subscriptions/by_email/EMAIL`)
 * e reportar aqui/na issue se o shape de resposta bate com o parse abaixo.
 *
 * Trata qualquer erro de rede/parse como `"unknown"` (fail-soft — nunca
 * lança, nunca derruba o request do caller).
 */
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
