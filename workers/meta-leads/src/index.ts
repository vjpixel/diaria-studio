/**
 * workers/meta-leads/src/index.ts (#7769)
 *
 * Worker que recebe o webhook `leadgen` do Meta Lead Ads (formulário
 * instantâneo) e cria o subscriber correspondente no Kit — fecha o gap
 * descrito na #7769: sem este worker, um lead capturado no formulário
 * instantâneo fica preso dentro do Meta Leads Center e nunca entra na
 * newsletter (nenhuma exportação manual de CSV, decisão explícita do
 * editor).
 *
 * ## Rotas
 *
 *   GET  /webhook  — handshake de verificação da Meta (`hub.mode=subscribe`,
 *                     `hub.verify_token` comparado a `META_WEBHOOK_VERIFY_TOKEN`,
 *                     ecoa `hub.challenge` em 200 se bater).
 *   POST /webhook   — evento `leadgen`. Valida `X-Hub-Signature-256`
 *                     (HMAC-SHA256 do corpo CRU com `META_APP_SECRET`,
 *                     comparação constant-time — ver crypto.ts), busca cada
 *                     lead na Graph API e cria o subscriber no Kit.
 *
 * ## Falhar alto, nunca fail-soft (decisão de design da issue)
 *
 * Diferente do resto do projeto (fail-soft por padrão — ver `CLAUDE.md`),
 * este endpoint responde **não-200** sempre que não conseguir processar
 * algum lead do payload: assinatura inválida, corpo malformado, falha ao
 * buscar o lead na Graph API, e-mail ausente/inválido no lead, ou falha ao
 * criar o subscriber no Kit. A Meta guarda o lead só 90 dias e faz retry de
 * webhook em resposta não-2xx — um lead perdido em silêncio é uma pessoa
 * que preencheu o formulário e nunca recebe a newsletter, e o custo de
 * aquisição dela já foi pago. Ver docstring da issue #7769 para o
 * precedente que motivou (Conversions API fail-soft, #5504, ficou no-op
 * silencioso por meses).
 *
 * Um payload pode trazer MÚLTIPLAS mudanças `leadgen` (`entry[].changes[]`)
 * — a Meta não suporta ack parcial de um webhook (não há como confirmar só
 * parte do payload), então qualquer falha em QUALQUER lead do lote faz este
 * worker responder não-200 para o payload INTEIRO, mesmo que outros leads do
 * mesmo payload tenham sido processados com sucesso. Isso é seguro porque a
 * criação de subscriber no Kit é idempotente por e-mail (upsert — reprocessar
 * um lead já criado só faz um 2º upsert, sem duplicar nem falhar).
 */
import { verifyMetaSignature, constantTimeEquals } from "./crypto";
import { fetchMetaLead, resolveLeadContact, DEFAULT_GRAPH_API_VERSION, type MetaLead } from "./graph";
import { createKitSubscriberFromLead, type Env as KitEnv } from "./kit";
import { META_LEADS_UTM } from "./utm";

export interface Env extends KitEnv {
  META_APP_SECRET?: string;
  META_WEBHOOK_VERIFY_TOKEN?: string;
  META_LEADS_PAGE_ACCESS_TOKEN?: string;
  META_GRAPH_API_VERSION?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `GET /webhook` — handshake de verificação da Meta. Exige `hub.mode`,
 * `hub.verify_token` (comparado constant-time contra `META_WEBHOOK_VERIFY_TOKEN`)
 * e `hub.challenge` presentes e corretos; qualquer desvio responde 403 sem
 * ecoar nada (nunca vazar o challenge/token esperado num caminho inválido).
 */
export function handleVerify(url: URL, env: Env): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = env.META_WEBHOOK_VERIFY_TOKEN ?? "";
  if (mode === "subscribe" && expected && token && challenge && constantTimeEquals(token, expected)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

interface MetaWebhookEntry {
  id?: string;
  changes?: Array<{ field?: string; value?: { leadgen_id?: string } }>;
}

interface MetaWebhookPayload {
  object?: string;
  entry?: MetaWebhookEntry[];
}

/** Extrai todos os `leadgen_id` de um payload de webhook já parseado —
 * ignora `changes` cujo `field` não seja `"leadgen"` (a Meta pode mandar
 * outros campos de página no mesmo endpoint, dependendo da subscrição do
 * app) e ids ausentes/vazios. @pure */
export function extractLeadgenIds(payload: MetaWebhookPayload): string[] {
  const ids: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const id = change.value?.leadgen_id;
      if (typeof id === "string" && id.trim() !== "") ids.push(id.trim());
    }
  }
  return ids;
}

export interface LeadProcessOutcome {
  leadgenId: string;
  ok: boolean;
  reason?: string;
}

/**
 * Processa um único `leadgen_id`: busca o lead na Graph API, resolve
 * e-mail/nome, cria o subscriber no Kit. Nunca lança — toda falha vira
 * `{ ok: false, reason }` estruturado; é o caller (`handleWebhookPost`) que
 * decide o status HTTP agregado.
 */
export async function processLead(
  leadgenId: string,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<LeadProcessOutcome> {
  const leadResult = await fetchMetaLead(
    leadgenId,
    env.META_LEADS_PAGE_ACCESS_TOKEN ?? "",
    fetchImpl,
    env.META_GRAPH_API_VERSION ?? DEFAULT_GRAPH_API_VERSION,
  );
  if (!leadResult.ok) {
    console.error(`[meta-leads] fetchMetaLead(${leadgenId}) falhou: ${leadResult.reason}`);
    return { leadgenId, ok: false, reason: leadResult.reason };
  }

  const contact = resolveLeadContact(leadResult.lead as MetaLead);
  if (!isPlausibleEmail(contact.email)) {
    console.error(`[meta-leads] lead ${leadgenId} sem e-mail válido em field_data — não é possível criar o subscriber.`);
    return { leadgenId, ok: false, reason: "missing_or_invalid_email" };
  }

  const kitResult = await createKitSubscriberFromLead(
    env,
    contact,
    META_LEADS_UTM,
    fetchImpl,
  );
  if (!kitResult.ok) {
    console.error(`[meta-leads] createKitSubscriberFromLead(${leadgenId}) falhou: ${kitResult.reason}`);
    return { leadgenId, ok: false, reason: kitResult.reason };
  }
  return { leadgenId, ok: true };
}

/** Validação de formato leve — mesmo racional de `isValidVoteEmailFormat`
 * (workers/poll/src/lib.ts), sem depender daquele arquivo (cada worker
 * mantém sua própria cópia mínima, mesma convenção de `crypto.ts`). */
export function isPlausibleEmail(email: string): boolean {
  if (!email) return false;
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * `POST /webhook` — corpo CRU lido ANTES de qualquer parse (a assinatura é
 * sobre os bytes exatos recebidos, ver `verifyMetaSignature`). Assinatura
 * inválida ou corpo malformado nunca chegam a tentar processar lead nenhum.
 */
export async function handleWebhookPost(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("X-Hub-Signature-256");
  const validSignature = await verifyMetaSignature(env.META_APP_SECRET ?? "", rawBody, signatureHeader);
  if (!validSignature) {
    console.error("[meta-leads] X-Hub-Signature-256 ausente ou inválida — payload rejeitado.");
    return json({ ok: false, error: "invalid_signature" }, 403);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = undefined;
  }
  // #7769 self-review: `JSON.parse` NÃO lança para JSON válido porém
  // não-objeto (`"null"`, `"true"`, `"42"`, `'"str"'`) — sem este guard,
  // `payload.object` abaixo lançaria um TypeError não-tratado (500 opaco,
  // sem o corpo estruturado de erro) pra um corpo assim, mesmo com
  // assinatura correta. Mesmo tratamento do `catch` acima: não-2xx, nunca
  // 500 sem corpo.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Corpo malformado/inesperado apesar de assinatura válida (não deveria
    // acontecer vindo da Meta) — não-2xx de qualquer forma: retry não vai
    // "consertar" o parse, mas o status não-200 mantém visível no error rate
    // do app no Meta for Developers em vez de sumir num 200 silencioso.
    console.error("[meta-leads] corpo do webhook não é um objeto JSON válido apesar de assinatura correta.");
    return json({ ok: false, error: "malformed_body" }, 400);
  }
  const payload = parsed as MetaWebhookPayload;

  if (payload.object !== "page") {
    // Evento de um objeto que não é página (fora do escopo deste worker) —
    // não é falha, é "nada a fazer".
    return json({ ok: true, processed: 0 });
  }

  const leadgenIds = extractLeadgenIds(payload);
  if (leadgenIds.length === 0) {
    // Payload de página sem nenhuma mudança `leadgen` (a subscrição do app
    // pode cobrir outros campos) — não é falha.
    return json({ ok: true, processed: 0 });
  }

  const outcomes = await Promise.all(leadgenIds.map((id) => processLead(id, env, fetchImpl)));
  const failures = outcomes.filter((o) => !o.ok);
  if (failures.length > 0) {
    return json({ ok: false, processed: outcomes.length, failed: failures }, 502);
  }
  return json({ ok: true, processed: outcomes.length });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "GET") {
      return handleVerify(url, env);
    }
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhookPost(request, env);
    }
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("meta-leads worker ok", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  },
};
