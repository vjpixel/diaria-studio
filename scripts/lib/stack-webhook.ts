/**
 * stack-webhook.ts (#10904)
 *
 * Cliente do webhook n8n que a Stack montou para receber os posts semanais
 * da diar.ia.br no espaço "Radar de Notícias Stack" (Circle). Substitui o
 * acesso direto à Admin API do Circle: o n8n da Stack cria o post com autor
 * e capa padrão definidos do lado deles.
 *
 * Contrato (combinado com a Stack em 22/10/2026):
 *   - POST {webhook_url}, `Content-Type: application/json`,
 *     header `X-Webhook-Key: <segredo>`.
 *   - Corpo `{ "titulo": string, "corpo": string }`; `corpo` em Markdown
 *     (negrito, itálico, links, #/##/###, listas "- " e "1. ", linha em
 *     branco = parágrafo, emojis). HTML é removido do lado deles; imagens
 *     no texto não são aceitas.
 *   - 200 com `{"ok": true}` = publicado. 502 = o Circle recusou/falhou.
 *   - O post sai PUBLICADO na hora — não há rascunho.
 *   - #13104: 200 com a resposta da Admin API v2 do Circle repassada sem mexer
 *     (`{ message: "Post created.", post: { id, slug, url, ... } }`) também
 *     conta como publicado — `post.id` numérico é a prova.
 */

export const STACK_WEBHOOK_KEY_ENV = "STACK_WEBHOOK_KEY";
/** URL fora do repo (público): mesmo tratamento do segredo, via Doppler/.env. */
export const STACK_WEBHOOK_URL_ENV = "STACK_WEBHOOK_URL";

declare const stackPostPayloadBrand: unique symbol;

/**
 * Corpo do POST. Marcado (#10977): só `buildStackPostPayload` produz um valor
 * deste tipo, então nada chega a `sendStackPost` sem passar pela validação e
 * pelo escape de `<`.
 */
export type StackPostPayload = {
  readonly titulo: string;
  readonly corpo: string;
} & { readonly [stackPostPayloadBrand]: true };

/**
 * Pure (#10977): neutraliza `<` solto no Markdown. O webhook da Stack remove
 * HTML, então `<tag>` vindo do texto de uma edição sumiria (ou levaria texto
 * junto). Antes isso lançava erro e derrubava a prévia da semana inteira.
 *   - autolink `<https://…>` vira a URL nua (o conversor linka URL solta);
 *   - qualquer outro `<` vira `\<` (escape do Markdown, aparece como `<`).
 * `<` já escapado (`\<`) fica como está.
 */
export function escapeLooseAngleBrackets(md: string): string {
  return md
    .replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, "$1")
    .replace(/(?<!\\)</g, "\\<");
}

/**
 * Pure: valida e monta o corpo do POST (com `<` solto escapado, #10977).
 *
 * O título recebe o mesmo escape (#11197): desde a #11192 ele repete o
 * título do 1º destaque (texto editorial livre), então "Modelo < 1B supera
 * GPT" pode chegar aqui. Se o webhook também remover HTML do título (o
 * contrato não diz; não dá pra conferir sem publicar), o `<` cru cortaria o
 * texto. O custo do escape, se o título for texto puro do lado deles, é um
 * `\` visível — preferível a perder metade do título.
 */
export function buildStackPostPayload(titulo: string, corpo: string): StackPostPayload {
  if (!titulo.trim()) throw new Error("Título do post vazio");
  if (!corpo.trim()) throw new Error("Corpo do post vazio");
  if (/!\[[^\]]*\]\(/.test(corpo)) throw new Error("Corpo contém imagem Markdown — o webhook da Stack não aceita imagens no texto");
  return { titulo: escapeLooseAngleBrackets(titulo), corpo: escapeLooseAngleBrackets(corpo) } as StackPostPayload;
}

type FetchLike = typeof fetch;

/** Teto de espera pela resposta do webhook (n8n → Circle). Sem ele, um
 * webhook pendurado travava a task/sessão indefinidamente. */
export const STACK_WEBHOOK_TIMEOUT_MS = 30_000;

/**
 * Valida URL e chave ANTES de qualquer envio. Separado de `sendStackPost` para
 * o publisher checar a configuração antes de gravar a tentativa no state de
 * idempotência — erro de config nunca chegou à rede e não pode deixar o ciclo
 * em "unknown".
 */
export function assertStackWebhookConfig(webhookUrl: string, key: string): void {
  if (!webhookUrl) throw new Error(`${STACK_WEBHOOK_URL_ENV} ausente (Doppler/.env)`);
  if (!/^https:\/\//.test(webhookUrl)) throw new Error(`${STACK_WEBHOOK_URL_ENV} precisa ser https`);
  if (!key) throw new Error(`${STACK_WEBHOOK_KEY_ENV} ausente (Doppler/.env)`);
}

/**
 * Envia o post. Só considera sucesso 2xx com prova de publicação
 * (`isStackPostConfirmed`: `{"ok": true}` no topo ou `post.id` numérico do
 * Circle, #13104) — 2xx com outro corpo é tratado como falha, porque o post é
 * publicado direto e um "parece que foi" sem confirmação não pode virar estado
 * de "publicado". Timeout de
 * `timeoutMs` (default `STACK_WEBHOOK_TIMEOUT_MS`) rejeita — o post pode ter
 * saído mesmo assim, por isso o caller trata qualquer rejeição como estado
 * ambíguo, não como "nada enviado".
 */
export async function sendStackPost(
  webhookUrl: string,
  key: string,
  payload: StackPostPayload,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = STACK_WEBHOOK_TIMEOUT_MS,
): Promise<StackPostResult> {
  assertStackWebhookConfig(webhookUrl, key);
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Key": key },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (res.status === 502) throw new Error(`Webhook da Stack: o Circle recusou ou falhou (502). Avisar a Stack. ${text.slice(0, 300)}`);
  if (!res.ok) throw new Error(`Webhook da Stack: HTTP ${res.status} ${text.slice(0, 300)}`);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isStackPostConfirmed(parsed)) {
    throw new Error(`Webhook da Stack respondeu ${res.status} sem {"ok": true} nem post.id do Circle — publicação não confirmada: ${text.slice(0, 300)}`);
  }
  return { postUrl: extractStackPostUrl(parsed), ...extractStackPostIdentity(parsed) };
}

/**
 * Resultado do envio confirmado. `postUrl` = link do post, se o webhook devolveu (#12556);
 * `postId`/`postSlug` = identidade do post no Circle, se a resposta trouxe (#13104).
 */
export interface StackPostResult {
  postUrl: string | null;
  postId: number | null;
  postSlug: string | null;
}

/** `post` da resposta, quando é objeto (formato da Admin API v2 do Circle). */
function responsePost(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  const post = (response as Record<string, unknown>).post;
  return post && typeof post === "object" && !Array.isArray(post) ? (post as Record<string, unknown>) : null;
}

/** `post.id` inteiro positivo (o Circle usa id numérico); string numérica não conta. */
function circlePostId(response: unknown): number | null {
  const id = responsePost(response)?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Pure (#13104): a resposta prova que o post saiu? Dois formatos:
 *   - contrato do n8n da Stack: `{"ok": true}` no topo;
 *   - resposta do Circle repassada sem mexer: `post.id` numérico.
 * `ok: false` explícito vence o `post.id` (o webhook disse que falhou).
 */
export function isStackPostConfirmed(response: unknown): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const ok = (response as { ok?: unknown }).ok;
  if (ok === true) return true;
  if (ok === false) return false;
  return circlePostId(response) !== null;
}

/** Pure (#13104): `post.id`/`post.slug` da resposta do Circle, quando vieram. */
export function extractStackPostIdentity(response: unknown): { postId: number | null; postSlug: string | null } {
  const slug = responsePost(response)?.slug;
  return {
    postId: circlePostId(response),
    postSlug: typeof slug === "string" && slug.trim() ? slug.trim() : null,
  };
}

/** Campos em que o n8n da Stack pode devolver o link do post (#12556; hoje devolve só `{"ok": true}`). */
export const STACK_POST_URL_FIELDS = ["url", "post_url", "postUrl", "link", "permalink"] as const;

/**
 * Pure (#12556): link do post na resposta do webhook. Hoje o contrato devolve
 * só `{"ok": true}` (→ `null`); se a Stack passar a mandar a URL num dos campos
 * de `STACK_POST_URL_FIELDS` (no topo ou em `post`), ela é gravada no state e
 * mostrada ao editor. Só `https://` conta.
 */
export function extractStackPostUrl(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const candidates: unknown[] = [];
  const rec = response as Record<string, unknown>;
  const post = rec.post && typeof rec.post === "object" ? (rec.post as Record<string, unknown>) : null;
  for (const f of STACK_POST_URL_FIELDS) candidates.push(rec[f], post?.[f]);
  for (const c of candidates) {
    if (typeof c === "string" && /^https:\/\/\S+$/.test(c.trim())) return c.trim();
  }
  return null;
}
