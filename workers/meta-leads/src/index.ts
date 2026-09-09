/**
 * workers/meta-leads/src/index.ts (#7769)
 *
 * Ponte Meta Lead Ads → Kit. Recebe o webhook `leadgen` da Meta, busca o
 * lead na Graph API e cria o subscriber no Kit — pra que habilitar o local
 * de conversão "Site e formulário instantâneo" (#7768) não deixe leads
 * presos no Leads Center.
 *
 * Rationale completo (por que existe, por que falha alto) no topo de
 * `leadgen.ts`.
 *
 * ## Fluxo
 *
 *   GET  /webhook  → handshake de verificação (hub.challenge)
 *   POST /webhook  → assinatura → leadgen_id → Graph API → Kit
 *
 * ## Por que NÃO usa ctx.waitUntil
 *
 * O padrão do repo pra chamada externa best-effort é `ctx.waitUntil` (ver o
 * disparo CAPI em `workers/poll/src/subscribe.ts`) — responde na hora e
 * processa depois. Aqui seria errado: quem chama é a Meta, não um humano
 * esperando a página, e o status HTTP é o ÚNICO canal de retry que existe.
 * Respondendo 200 antes de saber se o lead entrou no Kit, uma falha vira
 * perda definitiva e silenciosa. Então processa síncrono e responde o que
 * de fato aconteceu; a Meta reentrega quem não voltou 200.
 *
 * O custo é latência: a Meta espera resposta em poucos segundos. Por isso os
 * timeouts abaixo são curtos (3s cada, contra os 8s do fluxo de cadastro
 * on-page) — no pior caso Graph + Kit somam ~6s, ainda dentro da janela, e
 * um timeout vira retry em vez de lead perdido.
 */
import {
  META_INSTANT_FORM_UTM,
  extractLeadFields,
  isEmailLike,
  parseLeadgenPayload,
  resolveVerification,
  verifySignature,
  type LeadgenNotification,
} from "./leadgen.ts";
import { applyKitSignupOriginField } from "../../../scripts/lib/shared/kit-signup-origin.ts";

export interface Env {
  /** App Secret do app Meta — valida `X-Hub-Signature-256`. Secret. */
  META_APP_SECRET?: string;
  /** Token escolhido por nós, batendo com o do painel do app. Secret. */
  META_WEBHOOK_VERIFY_TOKEN?: string;
  /** Page access token com `leads_retrieval` — busca o lead. Secret. */
  META_LEADS_PAGE_ACCESS_TOKEN?: string;
  /** Chave da conta Kit. Secret. */
  KIT_API_KEY?: string;

  /** Override de base da Graph (teste). Var. */
  META_GRAPH_API_URL?: string;
  /** Override de base do Kit (teste). Var. */
  KIT_API_URL?: string;

  /** Nomes de custom field no Kit — vars, não secrets (ver SECRETS.md). */
  KIT_NAME_FIELD?: string;
  KIT_UTM_SOURCE_FIELD?: string;
  KIT_UTM_MEDIUM_FIELD?: string;
  KIT_UTM_CAMPAIGN_FIELD?: string;
  KIT_REFERRING_SITE_FIELD?: string;
  KIT_ORIGEM_CADASTRO_FIELD?: string;
}

/** Ver "Por que NÃO usa ctx.waitUntil" no topo — metade do timeout do
 *  cadastro on-page, porque aqui há uma janela de resposta a respeitar. */
export const LEAD_FETCH_TIMEOUT_MS = 3000;

export interface Deps {
  fetchImpl?: typeof fetch;
}

export type LeadProcessResult =
  | { ok: true; skipped?: "no_email" }
  | { ok: false; reason: "not_configured" | "graph_error" | "kit_error" };

/**
 * Busca os dados de um lead pelo `leadgen_id`.
 *
 * A Meta guarda lead por 90 dias — um erro aqui precisa virar retry, nunca
 * 200 silencioso. Devolve `undefined` em qualquer falha e deixa o caller
 * traduzir pra status.
 */
export async function fetchLead(
  env: Env,
  leadgenId: string,
  fetchImpl: typeof fetch,
): Promise<unknown | undefined> {
  const token = env.META_LEADS_PAGE_ACCESS_TOKEN;
  if (!token) return undefined;
  const base = env.META_GRAPH_API_URL ?? "https://graph.facebook.com/v25.0";
  const url = `${base}/${encodeURIComponent(leadgenId)}?fields=field_data,created_time,ad_id,form_id`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(LEAD_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      console.error(`[meta-leads] Graph respondeu ${res.status} para lead ${leadgenId}: ${body.slice(0, 300)}`);
      return undefined;
    }
    return await res.json();
  } catch (err) {
    console.error(`[meta-leads] exception ao buscar lead ${leadgenId}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Cria o subscriber no Kit.
 *
 * Espelha `subscribeToKit` (`workers/poll/src/subscribe.ts`) — mesmo
 * endpoint, mesmo header `X-Kit-Api-Key` (não Bearer), mesma idempotência
 * por e-mail (201 na criação, 200 no reenvio do mesmo e-mail).
 *
 * `state: "active"` e NÃO `"inactive"`: quem preencheu o formulário
 * instantâneo já deu consentimento explícito dentro do Meta, com o texto de
 * privacidade que o próprio formulário exige — é a mesma base legal da
 * caixinha marcada no funil on-page (#5095). Mandar pro double opt-in aqui
 * pediria uma 2ª confirmação por e-mail a quem já confirmou num fluxo
 * auditável, e o `state: "inactive"` sem form de confirmação prende o
 * subscriber pra sempre (#6565/#7723).
 */
export async function subscribeLeadToKit(
  env: Env,
  input: { email: string; name: string },
  fetchImpl: typeof fetch,
): Promise<LeadProcessResult> {
  const apiKey = env.KIT_API_KEY;
  if (!apiKey) return { ok: false, reason: "not_configured" };

  const base = env.KIT_API_URL ?? "https://api.kit.com/v4";
  const fields: Record<string, string> = {};
  if (input.name && env.KIT_NAME_FIELD) fields[env.KIT_NAME_FIELD] = input.name;
  if (env.KIT_UTM_SOURCE_FIELD) fields[env.KIT_UTM_SOURCE_FIELD] = META_INSTANT_FORM_UTM.source;
  if (env.KIT_UTM_MEDIUM_FIELD) fields[env.KIT_UTM_MEDIUM_FIELD] = META_INSTANT_FORM_UTM.medium;
  if (env.KIT_UTM_CAMPAIGN_FIELD) fields[env.KIT_UTM_CAMPAIGN_FIELD] = META_INSTANT_FORM_UTM.campaign;
  if (env.KIT_REFERRING_SITE_FIELD) fields[env.KIT_REFERRING_SITE_FIELD] = META_INSTANT_FORM_UTM.referringSite;
  applyKitSignupOriginField(fields, env);

  const body: Record<string, unknown> = { email_address: input.email, state: "active" };
  if (Object.keys(fields).length > 0) body.fields = fields;

  try {
    const res = await fetchImpl(`${base}/subscribers`, {
      method: "POST",
      headers: { "X-Kit-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LEAD_FETCH_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "<unreadable>");
    console.error(`[meta-leads] Kit respondeu ${res.status}: ${text.slice(0, 300)}`);
    return { ok: false, reason: "kit_error" };
  } catch (err) {
    console.error(`[meta-leads] exception ao criar subscriber no Kit: ${String(err)}`);
    return { ok: false, reason: "kit_error" };
  }
}

/**
 * Processa uma notificação: Graph → normaliza → Kit.
 *
 * Lead sem e-mail utilizável é `skipped`, não erro: retry da Meta traria o
 * mesmo lead sem e-mail pra sempre. Loga alto porque é sintoma de
 * formulário mal montado (campo de e-mail não obrigatório) — não some.
 */
export async function processLead(
  env: Env,
  note: LeadgenNotification,
  fetchImpl: typeof fetch,
): Promise<LeadProcessResult> {
  const payload = await fetchLead(env, note.leadgenId, fetchImpl);
  if (payload === undefined) return { ok: false, reason: "graph_error" };

  const { email, name } = extractLeadFields(payload);
  if (!isEmailLike(email)) {
    console.error(
      `[meta-leads] lead ${note.leadgenId} (form ${note.formId}) sem e-mail utilizável — nada a criar no Kit. Conferir se o campo de e-mail é obrigatório no formulário.`,
    );
    return { ok: true, skipped: "no_email" };
  }
  return subscribeLeadToKit(env, { email, name }, fetchImpl);
}

/**
 * `POST /webhook`. Assinatura → parse → processa cada lead.
 *
 * O corpo é lido UMA vez como texto e a mesma string vai pra validação de
 * assinatura e pro parse — reserializar invalidaria o HMAC (ver
 * `verifySignature`).
 *
 * Um POST pode trazer vários leads. Basta um falhar pra resposta ser 500:
 * a Meta reentrega o lote inteiro, e como a criação no Kit é idempotente
 * por e-mail, reprocessar os que já entraram não duplica ninguém.
 */
export async function handleWebhookPost(
  request: Request,
  env: Env,
  deps: Deps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rawBody = await request.text();

  const signed = await verifySignature(rawBody, request.headers.get("X-Hub-Signature-256"), env.META_APP_SECRET);
  if (!signed) {
    console.error("[meta-leads] assinatura inválida ou App Secret ausente — payload recusado.");
    return new Response("invalid signature", { status: 403 });
  }

  const notes = parseLeadgenPayload(rawBody);
  if (notes.length === 0) return new Response("ok", { status: 200 });

  let failed = 0;
  for (const note of notes) {
    const result = await processLead(env, note, fetchImpl);
    if (!result.ok) {
      failed++;
      console.error(`[meta-leads] falha ao processar lead ${note.leadgenId}: ${result.reason}`);
    }
  }

  if (failed > 0) {
    // 500 de propósito: é o pedido de reentrega. Ver o bloco sobre
    // ctx.waitUntil no topo do arquivo.
    return new Response(`failed: ${failed}/${notes.length}`, { status: 500 });
  }
  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }
    if (request.method === "GET") {
      const v = resolveVerification(url.searchParams, env.META_WEBHOOK_VERIFY_TOKEN);
      return v.ok
        ? new Response(v.challenge, { status: 200, headers: { "Content-Type": "text/plain" } })
        : new Response(v.error, { status: v.status });
    }
    if (request.method === "POST") {
      return handleWebhookPost(request, env);
    }
    return new Response("method not allowed", { status: 405 });
  },
};
