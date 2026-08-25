/**
 * subscriber-verify.ts (#4052)
 *
 * Verificação "é assinante ativo da diar.ia.br?" — genérica, extraída pra
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
 *   2. `verifySubscriberViaBeehiivByEmail` — SECUNDÁRIA. Chama `GET
 *      /publications/{id}/subscriptions/by_email/{email}` diretamente na API
 *      da Beehiiv. **Confirmado ao vivo** durante o diagnóstico do #4305
 *      (curl com key real, plano desta conta):
 *      `GET /publications/{id}/subscriptions/by_email/{email}` →
 *      `HTTP 200 {"data":{...,"status":"active",...}}` — o shape bate com o
 *      parse abaixo. Continua SECUNDÁRIA/não-default por decisão separada
 *      (#4052: KV é mais barato, não gasta chamada de API por request) — a
 *      confirmação acima só resolve "o endpoint funciona", não muda qual
 *      caminho é primário (ver a issue do KV defasado, #4322/#4305).
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

/**
 * `"verification_failed"` (#4321): distinto de `"unknown"` — 404 é resposta
 * LEGÍTIMA da Beehiiv ("este e-mail não existe", `"unknown"`); 401/403/429/5xx
 * e exceção de rede/parse são "NÃO CONSEGUIMOS verificar" (key rotacionada,
 * API fora do ar, rate-limit) — o e-mail PODE ser assinante ativo, só não dá
 * pra confirmar agora. Colapsar os dois no mesmo valor (comportamento
 * pré-#4321) torna uma rotação de key não sincronizada indistinguível de
 * "não é assinante" pra qualquer caller a jusante. Callers que só checam
 * `=== "active"` (o único caso positivo) não precisam de nenhuma mudança —
 * este valor é aditivo à união.
 */
export type SubscriberVerifyState = "active" | "inactive" | "unknown" | "verification_failed";

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
 * Endpoint confirmado ao vivo durante o diagnóstico do #4305 (`curl` com a
 * key real, plano desta conta Beehiiv): `HTTP 200
 * {"data":{...,"status":"active",...}}` — o shape de resposta bate com o
 * parse abaixo. Não muda qual caminho é primário (decisão separada, #4052:
 * KV continua o padrão/default) — só resolve a dúvida de "este caminho
 * funciona ao vivo", que ficou em aberto desde a extração original.
 *
 * Trata qualquer erro de rede/parse como `"verification_failed"` (fail-soft —
 * nunca lança, nunca derruba o request do caller). #4321: 404 continua
 * `"unknown"` (resposta legítima — o e-mail não existe na Beehiiv); qualquer
 * outro `!res.ok` (401/403 key rotacionada, 429 rate-limit, 5xx API fora do
 * ar) E exceção de rede/parse viram `"verification_failed"` — distinto de
 * "verificamos e a pessoa não é assinante".
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
}

/**
 * Verificação SECUNDÁRIA equivalente à Beehiiv, mas contra o Kit (#6048,
 * migração Beehiiv → Kit, #461/#463) — `GET /v4/subscribers?email_address=`,
 * auth via header `X-Kit-Api-Key` (não Bearer, diferente da Beehiiv).
 *
 * **Diferença de shape confirmada ao vivo (24/08/2026): "não encontrado" é
 * HTTP 200 com `subscribers: []`, NUNCA 404** — ao contrário do endpoint
 * `by_email` da Beehiiv, que usa 404 legítimo pra "não existe". Testado
 * contra um e-mail real não-cadastrado (`diariaeditor@gmail.com` na conta
 * de produção): `200 {"subscribers":[],"pagination":{...}}`. Por isso o
 * branch de "não encontrado" aqui é `subscribers.length === 0` dentro do
 * `res.ok`, não um `res.status === 404` dedicado como no ramo Beehiiv.
 *
 * `state` do Kit é o enum confirmado no #6047: `active | cancelled | bounced
 * | complained | inactive` — `active` mapeia pra `"active"`, os outros 4 pra
 * `"inactive"` (mesmo agrupamento que a Beehiiv já faz pra
 * `inactive`/`cancelled`). Qualquer não-2xx ou exceção de rede/parse vira
 * `"verification_failed"` — mesma semântica do #4321 (distinto de "não é
 * assinante").
 *
 * **Achado do review (PR #6082): ainda NÃO tem nenhum caller em produção.**
 * `workers/poll/src/web-gate.ts` (`checkWebSubscriber`) segue chamando só
 * `verifySubscriberViaBeehiivByEmail` — diferente de `subscribeToKit`
 * (`workers/poll/src/subscribe.ts`), que já tem um branch real
 * (`env.SUBSCRIBE_BACKEND === "kit"`), esta função existe mas não está
 * wireada em lugar nenhum ainda. Fica pra quando `web-gate.ts` ganhar o
 * mesmo seletor de backend — trabalho futuro do #6048, não coberto aqui.
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
