/**
 * #10082: abandono de carrinho da Hotmart (webhook `PURCHASE_OUT_OF_SHOPPING_CART`)
 * registrado SEM dado pessoal. Do checkout só se sabia quem chegou e quem
 * comprou; isto fecha o meio do funil.
 *
 * Contrato de privacidade: `extractAbandon` devolve só data/hora, id do
 * produto, código da oferta e origem (`src`/`sck`). Nome, e-mail e telefone do
 * comprador (`data.buyer.*`) nunca são lidos. Puro (sem I/O) — o Worker
 * (`workers/site`) só orquestra KV e HTTP.
 */

export const HOTMART_ABANDON_EVENT = "PURCHASE_OUT_OF_SHOPPING_CART";
export const HOTMART_HOTTOK_HEADER = "X-HOTMART-HOTTOK";
export const HOTMART_ABANDON_ENDPOINT = "/hotmart/abandono";
export const HOTMART_ABANDON_READ_ENDPOINT = "/hotmart/abandonos";
export const HOTMART_ABANDON_KEY_PREFIX = "hotmart:abandon:";
/** Retenção do registro no KV (90 dias). */
export const HOTMART_ABANDON_TTL_SECONDS = 90 * 24 * 3600;

export interface HotmartAbandon {
  /** ISO 8601 UTC. */
  at: string;
  product_id: string | null;
  offer_code: string | null;
  src: string | null;
  sck: string | null;
}

/** Comparação em tempo ~constante; segredo ausente/vazio nunca confere. */
export function hottokMatches(received: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !received) return false;
  if (received.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= received.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Extrai o registro sem PII de um payload Hotmart v2. `null` se o evento não
 * é de abandono de carrinho. `now` injetável pra teste.
 */
export function extractAbandon(payload: unknown, now: Date = new Date()): HotmartAbandon | null {
  const p = obj(payload);
  if (p.event !== HOTMART_ABANDON_EVENT) return null;
  const data = obj(p.data);
  const origin = obj(obj(data.purchase).origin);
  const flatOrigin = obj(data.origin);
  const created = typeof p.creation_date === "number" ? new Date(p.creation_date) : now;
  const at = Number.isNaN(created.getTime()) ? now : created;
  return {
    at: at.toISOString(),
    product_id: str(obj(data.product).id),
    offer_code: str(obj(data.offer).code) ?? str(obj(data.purchase).offer && obj(obj(data.purchase).offer).code),
    src: str(origin.src) ?? str(flatOrigin.src) ?? str(data.src),
    sck: str(origin.sck) ?? str(flatOrigin.sck) ?? str(data.sck),
  };
}

/** Chave ordenável por dia (`hotmart:abandon:{YYYY-MM-DD}:{ts}:{rand}`). */
export function abandonKey(rec: HotmartAbandon, rand: string): string {
  return `${HOTMART_ABANDON_KEY_PREFIX}${rec.at.slice(0, 10)}:${Date.parse(rec.at)}:${rand}`;
}

export function isValidDay(s: string | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
