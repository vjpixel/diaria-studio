/**
 * workers/kit-events/src/index.ts (#10648)
 *
 * Recebe os webhooks do Kit (cancelamento, clique, bounce, reclamação,
 * ativação) e grava cada evento no KV com o horário de recebimento. Contrato
 * completo (rotas, formato da chave, por que o tipo vem na URL) em
 * `scripts/lib/kit-webhook-events-contract.ts`. Como registrar os webhooks e
 * criar KV/segredos: `workers/kit-events/README.md`.
 *
 * Falha FECHADO: sem o KV `KIT_EVENTS` declarado toda rota de dados responde
 * 503 `not_configured`; sem `KIT_WEBHOOK_SECRET` (ou com segredo curto) todo
 * POST responde 404, igual a um caminho inexistente — quem não sabe o
 * segredo não descobre que o endpoint existe.
 *
 * Gravação que falha responde 503: o Kit repete webhook com resposta
 * não-2xx, e um cancelamento perdido em silêncio é exatamente a informação
 * que a #10648 quer passar a ter.
 */

import {
  buildKitEventKey,
  isAuthorizedEventsReadRequest,
  isKitWebhookEventType,
  isValidWebhookSecret,
  kitEventSincePrefixes,
  parseKitWebhookPayload,
  receivedAtFromKey,
  sortKitWebhookEvents,
  type KitWebhookEventRecord,
} from "../../../scripts/lib/kit-webhook-events-contract.ts";

/** Subconjunto do `KVNamespace` usado aqui — permite KV falso nos testes. */
export interface EventsKv {
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
  get(key: string): Promise<string | null>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface Env {
  KIT_EVENTS?: EventsKv;
  KIT_WEBHOOK_SECRET?: string;
  EVENTS_READ_TOKEN?: string;
}

export interface Deps {
  now?: () => Date;
  randomSuffix?: () => string;
}

/** Corpo do webhook do Kit é pequeno (um objeto `subscriber`). */
const MAX_BODY_BYTES = 64 * 1024;
/** Metadata do KV aceita até 1024 bytes; acima disso o leitor lê o valor. */
const MAX_METADATA_BYTES = 1000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function defaultSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleWebhook(
  request: Request,
  env: Env,
  secret: string,
  type: string,
  deps: Deps = {},
): Promise<Response> {
  if (!isValidWebhookSecret(secret, env.KIT_WEBHOOK_SECRET)) return new Response("not found", { status: 404 });
  if (!env.KIT_EVENTS) return json({ ok: false, error: "not_configured" }, 503);
  if (!isKitWebhookEventType(type)) return json({ ok: false, error: "unknown_event_type" }, 404);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ ok: false, error: "body_too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  const url = new URL(request.url);
  const parsed = parseKitWebhookPayload(body, type === "click" ? url.searchParams.get("url") : null);
  if (!parsed.ok) {
    // 400 e não 2xx: um corpo que não dá pra ligar a ninguém precisa aparecer
    // no histórico de entregas do Kit, não sumir num "ok".
    console.error(`[kit-events] webhook ${type} rejeitado: ${parsed.error}`);
    return json({ ok: false, error: parsed.error }, 400);
  }

  const receivedAt = (deps.now ?? (() => new Date()))().toISOString();
  const key = buildKitEventKey(parsed.subscriberId, receivedAt, type, (deps.randomSuffix ?? defaultSuffix)());
  const record: KitWebhookEventRecord = {
    key,
    type,
    kit_subscriber_id: parsed.subscriberId,
    email: parsed.email,
    state: parsed.state,
    url: type === "click" ? parsed.url : null,
    received_at: receivedAt,
  };
  const serialized = JSON.stringify(record);
  // Metadata completa evita 1 leitura por evento na listagem; se não couber
  // (URL longa), vai sem metadata e o leitor busca o valor.
  const metadata = new TextEncoder().encode(serialized).length <= MAX_METADATA_BYTES ? record : undefined;
  try {
    await env.KIT_EVENTS.put(key, serialized, metadata ? { metadata } : undefined);
  } catch (e) {
    console.error(`[kit-events] falha ao gravar ${type} no KV: ${(e as Error).message}`);
    return json({ ok: false, error: "storage_failed" }, 503);
  }
  return json({ ok: true });
}

export async function handleListEvents(request: Request, env: Env): Promise<Response> {
  if (!isAuthorizedEventsReadRequest(request.headers.get("authorization"), env.EVENTS_READ_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.KIT_EVENTS) return json({ error: "not_configured" }, 503);
  const url = new URL(request.url);
  const since = url.searchParams.get("since");
  if (since !== null && Number.isNaN(Date.parse(since))) return json({ error: "invalid_since" }, 400);
  const sinceIso = since !== null ? new Date(since).toISOString() : null;
  const subscriber = url.searchParams.get("subscriber");
  if (subscriber !== null && !/^\d+$/.test(subscriber)) return json({ error: "invalid_subscriber" }, 400);
  const prefixes = kitEventSincePrefixes(sinceIso);

  const events: KitWebhookEventRecord[] = [];
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = await env.KIT_EVENTS.list({ prefix, cursor });
      for (const k of page.keys) {
        const ts = receivedAtFromKey(k.name);
        if (ts === null) continue;
        if (subscriber !== null && k.name.slice("ev:".length + ts.length + 1).split(":")[0] !== subscriber) continue;
        if (sinceIso !== null && ts < sinceIso) continue;
        const meta = k.metadata as KitWebhookEventRecord | undefined;
        if (meta && meta.key === k.name) {
          events.push(meta);
          continue;
        }
        const raw = await env.KIT_EVENTS.get(k.name);
        if (!raw) continue;
        try {
          events.push(JSON.parse(raw) as KitWebhookEventRecord);
        } catch {
          console.error(`[kit-events] valor ilegível na chave ${k.name}, pulado.`);
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  return json({ events: sortKitWebhookEvents(events) });
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url);
  const webhook = /^\/webhook\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
  if (webhook && request.method === "POST") {
    let secret: string;
    try {
      secret = decodeURIComponent(webhook[1]);
    } catch {
      return new Response("not found", { status: 404 });
    }
    return handleWebhook(request, env, secret, webhook[2], deps);
  }
  if (url.pathname === "/api/eventos" && request.method === "GET") return handleListEvents(request, env);
  if (url.pathname === "/" && request.method === "GET") return new Response("kit-events worker ok", { status: 200 });
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
