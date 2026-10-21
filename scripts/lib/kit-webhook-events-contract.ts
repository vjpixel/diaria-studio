/**
 * kit-webhook-events-contract.ts (#10648)
 *
 * CONTRATO dos eventos por assinante do Kit recebidos por webhook. Decisão do
 * editor (briefing overnight 261021b): Worker + KV, segredo na URL do
 * endpoint, leitura integrada ao `diaria-subscribers-db`. Puro e sem
 * dependência de Node: importado pelo Worker (`workers/kit-events/src/index.ts`)
 * e pela ingestão local (`scripts/diaria-subscribers-ingest-kit-webhooks.ts`),
 * pra os dois lados nunca divergirem sobre formato de chave e de registro.
 *
 * ## Por que existe
 *
 * A API v4 do Kit não tem endpoint de atividade por assinante: só dá pra
 * reconstruir comportamento por edição (`POST /v4/subscribers/filter`) e pelos
 * agregados `last_*` de `/subscribers/{id}/stats`. Nenhum dos dois tem o
 * HORÁRIO de um cancelamento. O webhook é o único canal que entrega o fato no
 * momento em que acontece.
 *
 * ## Duas particularidades do webhook do Kit que moldam o desenho
 *
 * 1. **O corpo não diz qual evento disparou.** O POST traz só
 *    `{ "subscriber": { id, email_address, state, ... } }`. Por isso o TIPO
 *    vem no caminho: cada webhook registrado no Kit aponta pra uma URL
 *    própria, `/webhook/{segredo}/{tipo}` (ver `KIT_WEBHOOK_ROUTES`).
 * 2. **O corpo não traz timestamp.** O horário gravado é o de RECEBIMENTO no
 *    Worker (`received_at`). O Kit dispara o webhook na hora do evento, então
 *    a diferença é de segundos; num retry dele o horário fica o da tentativa
 *    que deu certo. Os campos se chamam `received_at` justamente pra ninguém
 *    ler como horário nativo do Kit.
 *
 * `subscriber.link_click` no Kit exige `initiator_value` = a URL do link
 * (um webhook por link). A URL vai junto no `?url=` do endpoint registrado,
 * já que o corpo também não a repete.
 *
 * ## Endpoints do Worker
 *
 *  - `POST /webhook/{segredo}/{tipo}` — segredo comparado em tempo constante
 *    contra `KIT_WEBHOOK_SECRET`; grava 1 chave no KV por evento.
 *  - `GET  /api/eventos?since={ISO}&subscriber={id Kit}` com
 *    `Authorization: Bearer {EVENTS_READ_TOKEN}` — lista os eventos
 *    (`KitWebhookEventsPayload`), ordenados por `received_at`.
 *
 * ## Chave no KV
 *
 * `ev:{received_at ISO}:{id Kit}:{tipo}:{sufixo aleatório}` — horário
 * primeiro permite listar intervalos por prefixos disjuntos, sem percorrer
 * chaves anteriores ao corte. O assinante é filtrado pelo leitor.
 * Formato adotado antes da ativação do KV; não migra chaves experimentais
 * no formato antigo (assinante primeiro).
 * Sem TTL: o KV é a fonte durável enquanto o store local pode ser
 * reconstruído do zero (`--reset`), e a ingestão é idempotente pela chave.
 */

/** Tipo canônico do evento — o segmento `{tipo}` da URL do webhook. */
export const KIT_WEBHOOK_EVENT_TYPES = ["unsubscribe", "click", "bounce", "complaint", "activate"] as const;
export type KitWebhookEventType = (typeof KIT_WEBHOOK_EVENT_TYPES)[number];

export function isKitWebhookEventType(value: unknown): value is KitWebhookEventType {
  return typeof value === "string" && (KIT_WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Nome do evento no Kit (`POST /v4/webhooks` → `event.name`) para cada tipo.
 * É a tabela que a sessão de registro usa: um webhook por linha, apontando
 * pra `/webhook/{segredo}/{tipo}`.
 */
export const KIT_WEBHOOK_ROUTES: Readonly<Record<KitWebhookEventType, string>> = {
  unsubscribe: "subscriber.subscriber_unsubscribe",
  click: "subscriber.link_click",
  bounce: "subscriber.subscriber_bounce",
  complaint: "subscriber.subscriber_complain",
  activate: "subscriber.subscriber_activate",
};

/** Registro gravado no KV e devolvido por `GET /api/eventos`. */
export interface KitWebhookEventRecord {
  /** Chave KV — id estável do evento, usado como chave natural na ingestão. */
  key: string;
  type: KitWebhookEventType;
  /** `subscriber.id` do Kit, como string. */
  kit_subscriber_id: string;
  /** E-mail normalizado (trim + minúsculas) ou null se o corpo não trouxe. */
  email: string | null;
  /** `subscriber.state` no momento do evento, quando presente. */
  state: string | null;
  /** Só em `click`: URL do link (do `?url=` do endpoint ou do corpo). */
  url: string | null;
  /** ISO 8601 UTC do RECEBIMENTO no Worker (ver docstring do módulo). */
  received_at: string;
}

export interface KitWebhookEventsPayload {
  events: KitWebhookEventRecord[];
}

export const KIT_EVENT_KEY_PREFIX = "ev:";

/**
 * Cobertura lexicográfica de [since, infinito) para timestamps ISO UTC de
 * quatro dígitos de ano. Cada ramo diverge num dígito maior que o corte;
 * o ramo exato inclui o milissegundo do corte. Prefixos não se sobrepõem,
 * e a quantidade de chamadas não depende do tamanho/idade do histórico.
 */
export function kitEventSincePrefixes(since: string | null): string[] {
  if (since === null) return [KIT_EVENT_KEY_PREFIX];
  const prefixes = [KIT_EVENT_KEY_PREFIX + since + ":"];
  for (let i = since.length - 1; i >= 0; i--) {
    if (!/[0-9]/.test(since[i])) continue;
    for (let digit = Number(since[i]) + 1; digit <= 9; digit++) {
      prefixes.push(KIT_EVENT_KEY_PREFIX + since.slice(0, i) + digit);
    }
  }
  return prefixes.sort();
}

export function buildKitEventKey(
  kitSubscriberId: string,
  receivedAt: string,
  type: KitWebhookEventType,
  suffix: string,
): string {
  return `${KIT_EVENT_KEY_PREFIX}${receivedAt}:${kitSubscriberId}:${type}:${suffix}`;
}

/**
 * Lê `received_at` de volta do nome da chave, sem ler o valor. Devolve null
 * se a chave não segue o formato (o leitor pula em vez de quebrar).
 *
 */
export function receivedAtFromKey(key: string): string | null {
  if (!key.startsWith(KIT_EVENT_KEY_PREFIX)) return null;
  const rest = key.slice(KIT_EVENT_KEY_PREFIX.length);
  const ts = rest.slice(0, 24);
  if (rest[24] !== ":") return null;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts) ? ts : null;
}

/** Teto da URL guardada — o Kit não limita, o KV sim (valor e metadata). */
export const KIT_EVENT_MAX_URL_LENGTH = 2000;

export type ParseKitWebhookResult =
  | { ok: true; subscriberId: string; email: string | null; state: string | null; url: string | null }
  | { ok: false; error: string };

/**
 * Valida o corpo do webhook. Exige `subscriber.id` (número ou string
 * numérica): sem ele não há como ligar o evento a ninguém. E-mail e estado
 * são opcionais. A URL do clique vem do `?url=` (registro) e, na falta,
 * de `url`/`link` no corpo, caso o Kit passe a mandar.
 */
export function parseKitWebhookPayload(body: unknown, queryUrl: string | null): ParseKitWebhookResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "malformed_body" };
  }
  const b = body as Record<string, unknown>;
  const sub = b.subscriber;
  if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
    return { ok: false, error: "missing_subscriber" };
  }
  const s = sub as Record<string, unknown>;
  const rawId = s.id;
  const id =
    typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0
      ? String(rawId)
      : typeof rawId === "string" && /^\d+$/.test(rawId.trim())
        ? rawId.trim()
        : null;
  if (!id) return { ok: false, error: "missing_subscriber_id" };

  const rawEmail = typeof s.email_address === "string" ? s.email_address.trim().toLowerCase() : "";
  const email = rawEmail.length > 0 && rawEmail.length <= 254 ? rawEmail : null;
  const state = typeof s.state === "string" && s.state.length <= 40 ? s.state : null;

  const bodyUrl = typeof b.url === "string" ? b.url : typeof b.link === "string" ? b.link : null;
  const urlCandidate = (queryUrl && queryUrl.trim()) || (bodyUrl && bodyUrl.trim()) || null;
  const url = urlCandidate ? urlCandidate.slice(0, KIT_EVENT_MAX_URL_LENGTH) : null;

  return { ok: true, subscriberId: id, email, state, url };
}

/**
 * Comparação de segredo sem vazar posição do 1º byte diferente. O
 * comprimento ainda vaza (retorno antecipado), o que é aceitável aqui: o
 * segredo é gerado com tamanho fixo e longo (ver README do Worker).
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Segredo vazio/curto nunca autoriza: falha FECHADO se a env faltar. */
export const KIT_WEBHOOK_MIN_SECRET_LENGTH = 24;

export function isValidWebhookSecret(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected || expected.length < KIT_WEBHOOK_MIN_SECRET_LENGTH) return false;
  if (!provided) return false;
  return constantTimeEquals(provided, expected);
}

/** `Authorization: Bearer {token}` do endpoint de leitura. */
export function isAuthorizedEventsReadRequest(
  authorization: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected || expected.length < KIT_WEBHOOK_MIN_SECRET_LENGTH) return false;
  const m = /^Bearer\s+(.+)$/i.exec((authorization ?? "").trim());
  if (!m) return false;
  return constantTimeEquals(m[1].trim(), expected);
}

/** Ordena por `received_at` e, no empate, pela chave (estável). @pure */
export function sortKitWebhookEvents(events: KitWebhookEventRecord[]): KitWebhookEventRecord[] {
  return [...events].sort((a, b) =>
    a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}

/** Valida um registro vindo de `GET /api/eventos` (lado da ingestão). */
export function isKitWebhookEventRecord(value: unknown): value is KitWebhookEventRecord {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    v.key.startsWith(KIT_EVENT_KEY_PREFIX) &&
    isKitWebhookEventType(v.type) &&
    typeof v.kit_subscriber_id === "string" &&
    /^\d+$/.test(v.kit_subscriber_id) &&
    (v.email === null || typeof v.email === "string") &&
    (v.state === null || typeof v.state === "string") &&
    (v.url === null || typeof v.url === "string") &&
    typeof v.received_at === "string" &&
    !Number.isNaN(Date.parse(v.received_at))
  );
}
