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
 */

export const STACK_WEBHOOK_KEY_ENV = "STACK_WEBHOOK_KEY";
/** URL fora do repo (público): mesmo tratamento do segredo, via Doppler/.env. */
export const STACK_WEBHOOK_URL_ENV = "STACK_WEBHOOK_URL";

export interface StackPostPayload {
  titulo: string;
  corpo: string;
}

/** Pure: valida e monta o corpo do POST. */
export function buildStackPostPayload(titulo: string, corpo: string): StackPostPayload {
  if (!titulo.trim()) throw new Error("Título do post vazio");
  if (!corpo.trim()) throw new Error("Corpo do post vazio");
  if (/<\/?[a-z][^>]*>/i.test(corpo)) throw new Error("Corpo contém HTML — o webhook da Stack remove HTML; use Markdown");
  if (/!\[[^\]]*\]\(/.test(corpo)) throw new Error("Corpo contém imagem Markdown — o webhook da Stack não aceita imagens no texto");
  return { titulo, corpo };
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
 * Envia o post. Só considera sucesso 200 com `{"ok": true}` — 2xx com outro
 * corpo é tratado como falha, porque o post é publicado direto e um "parece
 * que foi" sem confirmação não pode virar estado de "publicado". Timeout de
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
): Promise<void> {
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
  let ok = false;
  try {
    ok = (JSON.parse(text) as { ok?: unknown }).ok === true;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`Webhook da Stack respondeu ${res.status} sem {"ok": true} — publicação não confirmada: ${text.slice(0, 300)}`);
}
